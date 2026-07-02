const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const axios = require('axios');

const ENERGA_EMAIL = process.env.ENERGA_EMAIL;
const ENERGA_PASSWORD = process.env.ENERGA_PASSWORD;
const GOOGLE_SHEETS_WEBHOOK = process.env.GOOGLE_SHEETS_WEBHOOK;
const TWO_CAPTCHA_API_KEY = process.env.TWO_CAPTCHA_API_KEY;

async function solveCaptchaWith2Captcha(sitekey, pageUrl) {
  console.log('Rozwiazywanie CAPTCHA...');
  
  try {
    const uploadResponse = await axios.post(
      'http://2captcha.com/in.php',
      {
        method: 'userrecaptcha',
        googlekey: sitekey,
        pageurl: pageUrl,
        json: 1
      },
      {
        params: {
          apikey: TWO_CAPTCHA_API_KEY
        }
      }
    );
    
    if (uploadResponse.data.status !== 0) {
      throw new Error(`Blad wysylania: ${uploadResponse.data.error}`);
    }
    
    const captchaId = uploadResponse.data.captcha;
    console.log(`CAPTCHA wyslana (ID: ${captchaId})`);
    
    console.log('Czekanie na rozwiazanie (max 60 sekund)...');
    
    let solution = null;
    let attempts = 0;
    const maxAttempts = 60;
    
    while (!solution && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
      
      const resultResponse = await axios.get(
        'http://2captcha.com/res.php',
        {
          params: {
            apikey: TWO_CAPTCHA_API_KEY,
            action: 'get',
            id: captchaId,
            json: 1
          }
        }
      );
      
      if (resultResponse.data.status === 1) {
        solution = resultResponse.data.request;
        console.log('CAPTCHA rozwiazana!');
      } else if (resultResponse.data.status === 0) {
        process.stdout.write('.');
      } else {
        throw new Error(`Blad: ${resultResponse.data.error}`);
      }
    }
    
    if (!solution) {
      throw new Error('Timeout: CAPTCHA nie zostala rozwiazana w 60 sekund');
    }
    
    return solution;
    
  } catch (error) {
    console.error('Blad 2Captcha:', error.message);
    throw error;
  }
}

async function getRefreshToken() {
  console.log('Rozpoczynanie logowania do Energi...');
  
  let browser;
  let refreshToken = null;
  
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    
    // Monitoruj wszystkie responses
    page.on('response', async (response) => {
      try {
        const url = response.url();
        
        if ((url.includes('/token') || url.includes('openid-connect')) && response.status() === 200) {
          try {
            const data = await response.json();
            console.log('Znaleziono response z tokenami');
            if (data.refresh_token) {
              refreshToken = data.refresh_token;
              console.log('Znaleziono refresh_token w response!');
            }
          } catch (e) {
            // Text response
          }
        }
      } catch (e) {
        // Ignoruj
      }
    });
    
    // Przejdź na Energa
    console.log('Otwieranie 24.energa.pl...');
    await page.goto('https://24.energa.pl/', { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Czekaj na formularz
    console.log('Czekanie na formularz (max 20 sekund)...');
    
    try {
      await page.waitForFunction(() => {
        return document.body.innerText.length > 100;
      }, { timeout: 20000 });
      
      console.log('Strona zaladowana');
      
      // Wydrukuj pola input
      const inputs = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('input')).map(i => ({
          type: i.type,
          name: i.name,
          id: i.id,
          placeholder: i.placeholder
        }));
      });
      
      console.log('Znalezione pola input:');
      console.log(JSON.stringify(inputs, null, 2));
      
    } catch (e) {
      console.error('Timeout czekania na formularz');
      throw new Error('Formularz sie nie zaladowal');
    }
    
    // Znajdź pole username (email)
    const usernameInput = await page.$('#username');
    if (!usernameInput) {
      throw new Error('Nie znaleziono pola username');
    }
    
    // Wpisz email
    console.log('Wpisywanie emaila...');
    await usernameInput.type(ENERGA_EMAIL, { delay: 100 });
    
    // Czekaj na pojawienie się przycisku Energa24
    console.log('Czekanie na przycisk Energa24...');
    try {
      await page.waitForSelector('#kc-switch-button', { timeout: 5000 });
      console.log('Przycisk Energa24 znaleziony');
      
      // Kliknij przycisk
      await page.click('#kc-switch-button');
      await new Promise(resolve => setTimeout(resolve, 2000));
      console.log('Przycisk Energa24 klikniety');
    } catch (e) {
      console.error('Blad z przyciskiem Energa24:', e.message);
      // Spróbuj dalej
    }
    
    // Czekaj na password field
    console.log('Czekanie na pole hasla...');
    try {
      await page.waitForSelector('#password', { timeout: 10000 });
      console.log('Pole hasla znalezione');
    } catch (e) {
      throw new Error('Nie znaleziono pola hasla');
    }
    
    // Wpisz hasło
    console.log('Wpisywanie hasla...');
    const passwordInput = await page.$('#password');
    await passwordInput.type(ENERGA_PASSWORD, { delay: 100 });
    
    // Sprawdź reCAPTCHA
    console.log('Szukanie reCAPTCHA...');
    const hasCaptcha = await page.$('iframe[src*="recaptcha"]') !== null;
    
    if (hasCaptcha) {
      console.log('Znaleziono reCAPTCHA');
      
      const sitekey = await page.evaluate(() => {
        const script = Array.from(document.scripts).find(s => 
          s.textContent.includes('grecaptcha.render')
        );
        if (script) {
          const match = script.textContent.match(/sitekey['":\s]+['"]([^'"]+)['"]/);
          return match ? match[1] : null;
        }
        return null;
      });
      
      if (sitekey) {
        console.log('Rozwiazywanie CAPTCHA...');
        const captchaSolution = await solveCaptchaWith2Captcha(sitekey, 'https://24.energa.pl/');
        
        await page.evaluate((token) => {
          document.getElementById('g-recaptcha-response').innerHTML = token;
          if (window.___grecaptcha_cfg) {
            Object.entries(window.___grecaptcha_cfg.clients).forEach(([key, client]) => {
              if (client.callback) {
                client.callback(token);
              }
            });
          }
        }, captchaSolution);
        
        console.log('CAPTCHA wkleta');
      }
    } else {
      console.log('Brak reCAPTCHA');
    }
    
    // Wyślij formularz - naciśnij Enter
    console.log('Wysylanie formularza (Enter)...');
    
    try {
      await Promise.all([
        page.keyboard.press('Enter'),
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
      ]);
      console.log('Formularz wysylany');
    } catch (e) {
      console.error('Blad wysylania formularza:', e.message);
    }
    
    // Czekaj na dashboard
    console.log('Czekanie na zaladowanie dashboard...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Wydrukuj WSZYSTKIE cookies
    console.log('Sprawdzanie wszystkich cookies...');
    const allCookies = await page.cookies();
    console.log('Wszystkie cookies:');
    allCookies.forEach(c => {
      console.log(`  ${c.name} = ${c.value.substring(0, 80)}...`);
    });
    
    // Szukaj kcToken lub refresh_token w cookies
    const kcToken = allCookies.find(c => c.name === 'kcToken' || c.name === 'kc_token');
    const refreshCookie = allCookies.find(c => c.name.includes('refresh'));
    
    if (kcToken) {
      console.log('Znaleziono kcToken!');
      console.log('kcToken: ' + kcToken.value.substring(0, 100) + '...');
      
      // Jeśli znaleziono refresh token w cookies
      if (refreshCookie) {
        refreshToken = refreshCookie.value;
        console.log('Znaleziono refresh_token w cookies: ' + refreshCookie.name);
      } else {
        // Spróbuj wymienić kcToken na refresh_token via API
        console.log('Wymiana kcToken na refresh_token...');
        try {
          const tokenResponse = await axios.post(
            'https://24.energa.pl/auth/realms/Energa-Selfcare/protocol/openid-connect/token',
            new URLSearchParams({
              grant_type: 'refresh_token',
              client_id: 'energa-selfcare',
              refresh_token: kcToken.value
            }),
            {
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Bearer ' + kcToken.value
              },
              timeout: 10000
            }
          );
          
          if (tokenResponse.data.refresh_token) {
            refreshToken = tokenResponse.data.refresh_token;
            console.log('Wymieniono token! Nowy refresh_token: ' + refreshToken.substring(0, 50) + '...');
          }
        } catch (e) {
          console.log('Nie mozna wymienić token - probuję użyć kcToken bezpośrednio');
          console.log('Błąd: ' + e.message);
          refreshToken = kcToken.value;
          console.log('Uzywam kcToken jako refresh_token');
        }
      }
    }
    
    // Sprawdzanie localStorage
    if (!refreshToken) {
      console.log('Sprawdzanie localStorage...');
      try {
        const storageToken = await page.evaluate(() => {
          const keys = [];
          for (let i = 0; i < localStorage.length; i++) {
            keys.push(localStorage.key(i));
          }
          console.log('Klucze localStorage: ' + keys.join(', '));
          
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            const value = localStorage.getItem(key);
            
            if (key.includes('token') || key.includes('auth') || key.includes('oidc') || key.includes('keycloak')) {
              console.log('Znaleziono klucz: ' + key);
              
              try {
                const parsed = JSON.parse(value);
                if (parsed.refresh_token) {
                  console.log('Znaleziono refresh_token w: ' + key);
                  return parsed.refresh_token;
                }
              } catch (e) {}
            }
          }
          return null;
        });
        
        if (storageToken) {
          refreshToken = storageToken;
          console.log('Znaleziono refresh_token w localStorage!');
        }
      } catch (e) {
        console.log('Nie mozna odczytac localStorage: ' + e.message);
      }
    }
    
    // Ostatnia szansa - czekaj na /token response
    if (!refreshToken) {
      console.log('Czekanie na refresh_token z network response (max 15 sekund)...');
      let waited = 0;
      while (!refreshToken && waited < 15000) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        waited += 1000;
        process.stdout.write('.');
      }
      console.log('');
    }
    
    if (!refreshToken) {
      throw new Error('Nie udalo sie pobrac refresh_token');
    }
    
    console.log('Token pobrany pomyslnie!');
    console.log('Token (pierwsze 50 znakow): ' + refreshToken.substring(0, 50) + '...');
    
    // Wyślij do Google Sheets
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
    }, {
      timeout: 10000
    });
    
    console.log('Token wysylany do Google Sheets!');
  } catch (error) {
    console.error('Blad wysylania:', error.message);
    throw error;
  }
}

// Uruchom
getRefreshToken()
  .then(token => {
    console.log('Sukces!');
    process.exit(0);
  })
  .catch(error => {
    console.error('Blad:', error.message);
    process.exit(1);
  });
