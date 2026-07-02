const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const axios = require('axios');

const ENERGA_EMAIL = process.env.ENERGA_EMAIL;
const ENERGA_PASSWORD = process.env.ENERGA_PASSWORD;
const GOOGLE_SHEETS_WEBHOOK = process.env.GOOGLE_SHEETS_WEBHOOK;
const TWO_CAPTCHA_API_KEY = process.env.TWO_CAPTCHA_API_KEY;
const PROXY_URL = process.env.PROXY_URL;

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
    const up = await axios.post('http://2captcha.com/in.php',
      { method: 'userrecaptcha', googlekey: sitekey, pageurl: pageUrl, json: 1 },
      { params: { apikey: TWO_CAPTCHA_API_KEY } });
    if (up.data.status !== 0) throw new Error(`Blad wysylania: ${up.data.error}`);
    const id = up.data.captcha;
    console.log(`CAPTCHA wyslana (ID: ${id})`);
    let sol = null, att = 0;
    while (!sol && att < 60) {
      await new Promise(r => setTimeout(r, 1000)); att++;
      const res = await axios.get('http://2captcha.com/res.php',
        { params: { apikey: TWO_CAPTCHA_API_KEY, action: 'get', id, json: 1 } });
      if (res.data.status === 1) { sol = res.data.request; console.log('CAPTCHA rozwiazana!'); }
      else if (res.data.status === 0) process.stdout.write('.');
      else throw new Error(`Blad: ${res.data.error}`);
    }
    if (!sol) throw new Error('Timeout CAPTCHA');
    return sol;
  } catch (e) { console.error('Blad 2Captcha:', e.message); throw e; }
}

async function dumpPage(page, label) {
  try {
    const title = await page.title();
    const url = page.url();
    const bodyText = await page.evaluate(() => document.body ? document.body.innerText.substring(0, 500) : '(brak body)');
    const htmlLen = await page.evaluate(() => document.documentElement.outerHTML.length);
    console.log(`--- DIAGNOSTYKA [${label}] ---`);
    console.log('  URL: ' + url);
    console.log('  Title: ' + title);
    console.log('  Dlugosc HTML: ' + htmlLen);
    console.log('  Tekst body (500 znakow): ' + JSON.stringify(bodyText));
    console.log('--- KONIEC DIAGNOSTYKI ---');
  } catch (e) {
    console.log('Nie mozna zdiagnozowac strony: ' + e.message);
  }
}

async function getRefreshToken() {
  console.log('Rozpoczynanie logowania do Energi...');

  const proxy = parseProxy(PROXY_URL);
  if (proxy) console.log(`Uzywam proxy: ${proxy.host}:${proxy.port}`);
  else console.log('BRAK PROXY - laczenie bezposrednie');

  let browser;
  let refreshToken = null;

  try {
    const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
    if (proxy) launchArgs.push(`--proxy-server=${proxy.server}`);

    browser = await puppeteer.launch({ headless: 'new', args: launchArgs });
    const page = await browser.newPage();

    if (proxy && proxy.username) {
      await page.authenticate({ username: proxy.username, password: proxy.password });
    }

    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8' });

    page.on('response', async (response) => {
      try {
        const url = response.url();
        if (url.includes('/token') || url.includes('/protocol/openid-connect/token')) {
          console.log(`[NET] token endpoint: status=${response.status()}`);
          try {
            const data = await response.json();
            console.log('[NET] klucze odpowiedzi: ' + Object.keys(data).join(', '));
            if (data.refresh_token) {
              refreshToken = data.refresh_token;
              console.log('>>> Znaleziono refresh_token w response! <<<');
            }
          } catch (e) { console.log('[NET] odpowiedz nie jest JSON'); }
        }
      } catch (e) {}
    });

    if (proxy) {
      try {
        await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 25000 });
        console.log('IP wychodzace: ' + (await page.evaluate(() => document.body.innerText)));
      } catch (e) { console.log('Nie mozna sprawdzic IP: ' + e.message); }
    }

    console.log('Otwieranie 24.energa.pl...');
    try {
      await page.goto('https://24.energa.pl/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      console.log('goto zakonczone (domcontentloaded)');
    } catch (e) {
      console.log('Blad goto: ' + e.message);
      await dumpPage(page, 'po bledzie goto');
      throw new Error('Nie mozna otworzyc strony');
    }

    // Czekaj na pole username - dluzszy timeout dla wolnego proxy
    console.log('Czekanie na pole username (max 45 sekund)...');
    let formLoaded = false;
    try {
      await page.waitForSelector('#username', { timeout: 45000 });
      formLoaded = true;
      console.log('Pole username znalezione!');
    } catch (e) {
      console.log('Nie znaleziono #username w 45s');
    }

    // Zawsze zrzuc diagnostyke zeby zobaczyc co sie zaladowalo
    await dumpPage(page, formLoaded ? 'formularz OK' : 'formularz NIE zaladowany');

    if (!formLoaded) {
      throw new Error('Formularz sie nie zaladowal');
    }

    console.log('Wpisywanie emaila...');
    await (await page.$('#username')).type(ENERGA_EMAIL, { delay: 100 });

    console.log('Klikanie przycisku Energa24...');
    try {
      await page.waitForSelector('#kc-switch-button', { timeout: 8000 });
      await page.click('#kc-switch-button');
      await new Promise(r => setTimeout(r, 2500));
    } catch (e) { console.error('Blad z przyciskiem Energa24:', e.message); }

    console.log('Czekanie na pole hasla...');
    await page.waitForSelector('#password', { timeout: 15000 });

    console.log('Wpisywanie hasla...');
    await (await page.$('#password')).type(ENERGA_PASSWORD, { delay: 100 });

    const hasCaptcha = await page.$('iframe[src*="recaptcha"]') !== null;
    if (hasCaptcha) {
      console.log('Znaleziono reCAPTCHA');
      const sitekey = await page.evaluate(() => {
        const s = Array.from(document.scripts).find(s => s.textContent.includes('grecaptcha.render'));
        if (s) { const m = s.textContent.match(/sitekey['":\s]+['"]([^'"]+)['"]/); return m ? m[1] : null; }
        return null;
      });
      if (sitekey) {
        const sol = await solveCaptchaWith2Captcha(sitekey, 'https://24.energa.pl/');
        await page.evaluate((token) => {
          document.getElementById('g-recaptcha-response').innerHTML = token;
          if (window.___grecaptcha_cfg) {
            Object.entries(window.___grecaptcha_cfg.clients).forEach(([k, c]) => { if (c.callback) c.callback(token); });
          }
        }, sol);
        console.log('CAPTCHA wkleta');
      }
    } else { console.log('Brak reCAPTCHA'); }

    console.log('Wysylanie formularza (Enter)...');
    await Promise.all([
      page.keyboard.press('Enter'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 40000 }).catch(() => {})
    ]);

    console.log('Czekanie po zalogowaniu...');
    await new Promise(r => setTimeout(r, 5000));
    console.log('URL po zalogowaniu: ' + page.url());
    await dumpPage(page, 'po zalogowaniu');

    if (!refreshToken) {
      console.log('Przeladowanie strony (wymuszenie token refresh)...');
      try { await page.reload({ waitUntil: 'networkidle2', timeout: 60000 }); }
      catch (e) { console.log('Reload timeout, kontynuuje...'); }
      await new Promise(r => setTimeout(r, 4000));
    }

    if (!refreshToken) {
      console.log('Sprawdzanie localStorage...');
      try {
        const lsToken = await page.evaluate(() => {
          const found = {};
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            const val = localStorage.getItem(key);
            found[key] = (val || '').substring(0, 60);
            try {
              const p = JSON.parse(val);
              if (p && p.refresh_token) return p.refresh_token;
              if (p && p.refreshToken) return p.refreshToken;
            } catch (e) {}
          }
          console.log('LS keys: ' + JSON.stringify(found));
          return null;
        });
        if (lsToken) { refreshToken = lsToken; console.log('Znaleziono refresh_token w localStorage!'); }
      } catch (e) { console.log('localStorage niedostepny: ' + e.message); }
    }

    if (!refreshToken) {
      console.log('Czekanie na refresh_token z network (max 20 sekund)...');
      let waited = 0;
      while (!refreshToken && waited < 20000) {
        await new Promise(r => setTimeout(r, 1000)); waited += 1000;
        process.stdout.write('.');
      }
      console.log('');
    }

    if (!refreshToken) throw new Error('Nie udalo sie pobrac refresh_token');

    console.log('Token pobrany pomyslnie!');
    console.log('Token (pierwsze 50 znakow): ' + refreshToken.substring(0, 50) + '...');

    if (GOOGLE_SHEETS_WEBHOOK) await sendToGoogleSheets(refreshToken);
    return refreshToken;

  } catch (error) {
    console.error('Blad:', error.message);
    throw error;
  } finally {
    if (browser) { await browser.close(); console.log('Przegladarka zamknieta'); }
  }
}

async function sendToGoogleSheets(refreshToken) {
  try {
    console.log('Wysylanie tokenu do Google Sheets...');
    await axios.post(GOOGLE_SHEETS_WEBHOOK, {
      entry_1: refreshToken, entry_2: new Date().toISOString()
    }, { timeout: 10000 });
    console.log('Token wyslany do Google Sheets!');
  } catch (e) { console.error('Blad wysylania:', e.message); throw e; }
}

getRefreshToken()
  .then(() => { console.log('Sukces!'); process.exit(0); })
  .catch(e => { console.error('Blad:', e.message); process.exit(1); });
