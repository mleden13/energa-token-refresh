const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const axios = require('axios');

const ENERGA_EMAIL = process.env.ENERGA_EMAIL;
const ENERGA_PASSWORD = process.env.ENERGA_PASSWORD;
const GOOGLE_SHEETS_WEBHOOK = process.env.GOOGLE_SHEETS_WEBHOOK;
const TWO_CAPTCHA_API_KEY = process.env.TWO_CAPTCHA_API_KEY;
const PROXY_URL = process.env.PROXY_URL; // format: http://login:haslo@host:port

// Parsowanie proxy URL
function parseProxy(proxyUrl) {
  if (!proxyUrl) return null;
  try {
    const url = new URL(proxyUrl);
    return {
      server: `${url.protocol}//${url.hostname}:${url.port}`,
      host: url.hostname,
      port: url.port,
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password)
    };
  } catch (e) {
    console.error('Blad parsowania PROXY_URL:', e.message);
    return null;
  }
}

async function solveCaptchaWith2Captcha(sitekey, pageUrl) {
  console.log('Rozwiazywanie CAPTCHA...');
  try {
    const uploadResponse = await axios.post(
      'http://2captcha.com/in.php',
      { method: 'userrecaptcha', googlekey: sitekey, pageurl: pageUrl, json: 1 },
      { params: { apikey: TWO_CAPTCHA_API_KEY } }
    );
    if (uploadResponse.data.status !== 0) {
      throw new Error(`Blad wysylania: ${uploadResponse.data.error}`);
    }
    const captchaId = uploadResponse.data.captcha;
    console.log(`CAPTCHA wyslana (ID: ${captchaId})`);
    console.log('Czekanie na rozwiazanie (max 60 sekund)...');
    let solution = null;
    let attempts = 0;
    while (!solution && attempts < 60) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
      const resultResponse = await axios.get('http://2captcha.com/res.php', {
        params: { apikey: TWO_CAPTCHA_API_KEY, action: 'get', id: captchaId, json: 1 }
      });
      if (resultResponse.data.status === 1) {
        solution = resultResponse.data.request;
        console.log('CAPTCHA rozwiazana!');
      } else if (resultResponse.data.status === 0) {
        process.stdout.write('.');
      } else {
        throw new Error(`Blad: ${resultResponse.data.error}`);
      }
    }
    if (!solution) throw new Error('Timeout CAPTCHA');
    return solution;
  } catch (error) {
    console.error('Blad 2Captcha:', error.message);
    throw error;
  }
}

async function getRefreshToken() {
  console.log('Rozpoczynanie logowania do Energi...');

  const proxy = parseProxy(PROXY_URL);
  if (proxy) {
    console.log(`Uzywam proxy: ${proxy.host}:${proxy.port}`);
  } else {
    console.log('BRAK PROXY - laczenie bezposrednie (moze byc blokowane przez WAF)');
  }

  let browser;
  let refreshToken = null;

  try {
    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ];
    if (proxy) {
      launchArgs.push(`--proxy-server=${proxy.server}`);
    }

    browser = await puppeteer.launch({
      headless: 'new',
      args: launchArgs
    });

    const page = await browser.newPage();

    // Autoryzacja proxy
    if (proxy && proxy.username) {
      await page.authenticate({ username: proxy.username, password: proxy.password });
    }

    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8' });

    // Sprawdz IP przez proxy
    if (proxy) {
      try {
        console.log('Sprawdzanie IP przez proxy...');
        await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 20000 });
        const ipText = await page.evaluate(() => document.body.innerText);
        console.log('IP wychodzace: ' + ipText);
      } catch (e) {
        console.log('Nie mozna sprawdzic IP: ' + e.message);
      }
    }

    // Monitoruj responses
    page.on('response', async (response) => {
      try {
        const url = response.url();
        if ((url.includes('/token') || url.includes('openid-connect')) && response.status() === 200) {
          try {
            const data = await response.json();
            if (data.refresh_token) {
              refreshToken = data.refresh_token;
              console.log('Znaleziono refresh_token w response!');
            }
          } catch (e) {}
        }
      } catch (e) {}
    });

    // Przejdź na Energa
    console.log('Otwieranie 24.energa.pl...');
    await page.goto('https://24.energa.pl/', { waitUntil: 'networkidle2', timeout: 45000 });

    // Czekaj na formularz
    console.log('Czekanie na formularz (max 20 sekund)...');
    try {
      await page.waitForFunction(() => document.body.innerText.length > 100, { timeout: 20000 });
      console.log('Strona zaladowana');
      const inputs = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('input')).map(i => ({
          type: i.type, name: i.name, id: i.id, placeholder: i.placeholder
        }));
      });
      console.log('Znalezione pola input:');
      console.log(JSON.stringify(inputs, null, 2));
    } catch (e) {
      console.error('Timeout czekania na formularz');
      throw new Error('Formularz sie nie zaladowal');
    }

    // Znajdź pole username
    const usernameInput = await page.$('#username');
    if (!usernameInput) throw new Error('Nie znaleziono pola username');

    console.log('Wpisywanie emaila...');
    await usernameInput.type(ENERGA_EMAIL, { delay: 100 });

    // Kliknij przycisk Energa24
    console.log('Czekanie na przycisk Energa24...');
    try {
      await page.waitForSelector('#kc-switch-button', { timeout: 5000 });
      console.log('Przycisk Energa24 znaleziony');
      await page.click('#kc-switch-button');
      await new Promise(resolve => setTimeout(resolve, 2000));
      console.log('Przycisk Energa24 klikniety');
    } catch (e) {
      console.error('Blad z przyciskiem Energa24:', e.message);
    }

    // Czekaj na pole hasła
    console.log('Czekanie na pole hasla...');
    try {
      await page.waitForSelector('#password', { timeout: 10000 });
      console.log('Pole hasla znalezione');
    } catch (e) {
      throw new Error('Nie znaleziono pola hasla');
    }

    console.log('Wpisywanie hasla...');
    const passwordInput = await page.$('#password');
    await passwordInput.type(ENERGA_PASSWORD, { delay: 100 });

    // Sprawdź reCAPTCHA
    console.log('Szukanie reCAPTCHA...');
    const hasCaptcha = await page.$('iframe[src*="recaptcha"]') !== null;
    if (hasCaptcha) {
      console.log('Znaleziono reCAPTCHA');
      const sitekey = await page.evaluate(() => {
        const script = Array.from(document.scripts).find(s => s.textContent.includes('grecaptcha.render'));
        if (script) {
          const match = script.textContent.match(/sitekey['":\s]+['"]([^'"]+)['"]/);
          return match ? match[1] : null;
        }
        return null;
      });
      if (sitekey) {
        const captchaSolution = await solveCaptchaWith2Captcha(sitekey, 'https://24.energa.pl/');
        await page.evaluate((token) => {
          document.getElementById('g-recaptcha-response').innerHTML = token;
          if (window.___grecaptcha_cfg) {
            Object.entries(window.___grecaptcha_cfg.clients).forEach(([key, client]) => {
              if (client.callback) client.callback(token);
            });
          }
        }, captchaSolution);
        console.log('CAPTCHA wkleta');
      }
    } else {
      console.log('Brak reCAPTCHA');
    }

    // Wyślij formularz
    console.log('Wysylanie formularza (Enter)...');
    try {
      await Promise.all([
        page.keyboard.press('Enter'),
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
      ]);
      console.log('Formularz wyslany');
    } catch (e) {
      console.error('Blad wysylania formularza:', e.message);
    }

    // Czekaj na dashboard
    console.log('Czekanie na zaladowanie dashboard...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Sprawdź cookies (kcToken)
    console.log('Sprawdzanie cookies...');
    const allCookies = await page.cookies();
    allCookies.forEach(c => {
      console.log(`  ${c.name} = ${c.value.substring(0, 60)}...`);
    });

    const kcTokenCookie = allCookies.find(c => c.name === 'kcToken' || c.name === 'kc_token');
    const refreshCookie = allCookies.find(c => c.name.includes('refresh'));

    if (refreshCookie) {
      refreshToken = refreshCookie.value;
      console.log('Znaleziono refresh_token w cookies: ' + refreshCookie.name);
    } else if (kcTokenCookie) {
      console.log('Znaleziono kcToken - probuje wymienic na refresh_token...');
      try {
        const tokenResponse = await axios.post(
          'https://24.energa.pl/auth/realms/Energa-Selfcare/protocol/openid-connect/token',
          new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: 'energa-selfcare',
            refresh_token: kcTokenCookie.value
          }),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
        );
        if (tokenResponse.data.refresh_token) {
          refreshToken = tokenResponse.data.refresh_token;
          console.log('Wymieniono na refresh_token!');
        }
      } catch (e) {
        console.log('Nie mozna wymienic, uzywam kcToken bezposrednio');
        refreshToken = kcTokenCookie.value;
      }
    }

    // Czekaj na token z network
    if (!refreshToken) {
      console.log('Czekanie na refresh_token z network (max 15 sekund)...');
      let waited = 0;
      while (!refreshToken && waited < 15000) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        waited += 1000;
        process.stdout.write('.');
      }
      console.log('');
    }

    if (!refreshToken) throw new Error('Nie udalo sie pobrac refresh_token');

    console.log('Token pobrany pomyslnie!');
    console.log('Token (pierwsze 50 znakow): ' + refreshToken.substring(0, 50) + '...');

    if (GOOGLE_SHEETS_WEBHOOK) {
      await sendToGoogleSheets(refreshToken);
    }

    return refreshToken;

  } catch (error) {
    console.error('Blad:', error.message);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
      console.log('Przegladarka zamknieta');
    }
  }
}

async function sendToGoogleSheets(refreshToken) {
  try {
    console.log('Wysylanie tokenu do Google Sheets...');
    await axios.post(GOOGLE_SHEETS_WEBHOOK, {
      entry_1: refreshToken,
      entry_2: new Date().toISOString()
    }, { timeout: 10000 });
    console.log('Token wyslany do Google Sheets!');
  } catch (error) {
    console.error('Blad wysylania:', error.message);
    throw error;
  }
}

getRefreshToken()
  .then(token => {
    console.log('Sukces!');
    process.exit(0);
  })
  .catch(error => {
    console.error('Blad:', error.message);
    process.exit(1);
  });
