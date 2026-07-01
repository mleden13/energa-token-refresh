const puppeteer = require('puppeteer');
const axios = require('axios');
const Solver = require('2captcha-typescript').Solver;

const ENERGA_EMAIL = process.env.ENERGA_EMAIL;
const ENERGA_PASSWORD = process.env.ENERGA_PASSWORD;
const GOOGLE_SHEETS_WEBHOOK = process.env.GOOGLE_SHEETS_WEBHOOK;
const TWO_CAPTCHA_API_KEY = process.env.TWO_CAPTCHA_API_KEY;

const solver = new Solver(TWO_CAPTCHA_API_KEY);

async function getRefreshToken() {
  console.log('🚀 Rozpoczynanie logowania do Energi...');
  
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
    
    // Intercept responses z tokenu
    page.on('response', async (response) => {
      try {
        const url = response.url();
        if (url.includes('/token') && response.status() === 200) {
          const data = await response.json();
          if (data.refresh_token) {
            refreshToken = data.refresh_token;
            console.log('✅ Znaleziono refresh_token!');
          }
        }
      } catch (e) {
        // Ignoruj
      }
    });
    
    // Przejdź na Energa
    console.log('📍 Otwieranie 24.energa.pl...');
    await page.goto('https://24.energa.pl/', { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Czekaj na formularz
    console.log('⏳ Czekanie na formularz...');
    await page.waitForSelector('input[type="email"]', { timeout: 10000 });
    
    // Wpisz email
    console.log('📝 Wpisywanie emaila...');
    await page.type('input[type="email"]', ENERGA_EMAIL);
    
    // Wpisz hasło
    console.log('📝 Wpisywanie hasła...');
    await page.waitForSelector('input[type="password"]', { timeout: 5000 });
    await page.type('input[type="password"]', ENERGA_PASSWORD);
    
    // Sprawdź reCAPTCHA
    console.log('🔍 Szukanie reCAPTCHA...');
    const recaptchaFrame = await page.$('iframe[src*="recaptcha"]');
    
    if (recaptchaFrame) {
      console.log('🤖 Znaleziono reCAPTCHA - rozwiązuję...');
      
      // Pobierz sitekey
      const sitekey = await page.evaluate(() => {
        const frame = document.querySelector('iframe[src*="recaptcha"]');
        const src = frame.src;
        const match = src.match(/k=([^&]+)/);
        return match ? match[1] : null;
      });
      
      if (sitekey) {
        try {
          console.log('🔐 Wysyłam CAPTCHA do 2captcha...');
          const res = await solver.recaptchaV2(
            sitekey,
            'https://24.energa.pl/'
          );
          
          console.log('✅ CAPTCHA rozwiązana!');
          console.log(`🔑 Token CAPTCHA: ${res.data.substring(0, 30)}...`);
          
          // Wklej token do g-recaptcha-response
          await page.evaluate((token) => {
            document.getElementById('g-recaptcha-response').innerHTML = token;
          }, res.data);
          
          // Trigger callback
          await page.evaluate(() => {
            if (window.___grecaptcha_cfg) {
              Object.entries(window.___grecaptcha_cfg.clients).forEach(([key, client]) => {
                if (client.callback) {
                  client.callback(document.getElementById('g-recaptcha-response').value);
                }
              });
            }
          });
          
        } catch (error) {
          console.error('❌ Błąd 2captcha:', error.message);
          throw error;
        }
      }
    } else {
      console.log('✅ Brak reCAPTCHA - idę dalej');
    }
    
    // Kliknij login
    console.log('🔐 Klikanie przycisku logowania...');
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
    ]);
    
    // Czekaj na token
    console.log('⏳ Czekanie na refresh_token (max 15 sekund)...');
    let waited = 0;
    while (!refreshToken && waited < 15000) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      waited += 1000;
    }
    
    if (!refreshToken) {
      throw new Error('❌ Nie udało się pobrać refresh_token');
    }
    
    console.log('✅ Token pobrany pomyślnie!');
    console.log(`🔑 Token (pierwsze 50 znaków): ${refreshToken.substring(0, 50)}...`);
    
    // Wyślij do Google Sheets
    if (GOOGLE_SHEETS_WEBHOOK) {
      await sendToGoogleSheets(refreshToken);
    }
    
    return refreshToken;
    
  } catch (error) {
    console.error('❌ Błąd:', error.message);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
      console.log('🔒 Przeglądarka zamknięta');
    }
  }
}

async function sendToGoogleSheets(refreshToken) {
  try {
    console.log('📨 Wysyłanie tokenu do Google Sheets...');
    
    await axios.post(GOOGLE_SHEETS_WEBHOOK, {
      entry_1: refreshToken,
      entry_2: new Date().toISOString()
    }, {
      timeout: 10000
    });
    
    console.log('✅ Token wysłany do Google Sheets!');
  } catch (error) {
    console.error('❌ Błąd wysyłania:', error.message);
    throw error;
  }
}

// Uruchom
getRefreshToken()
  .then(token => {
    console.log('🎉 Sukces!');
    process.exit(0);
  })
  .catch(error => {
    console.error('💥 Błąd:', error.message);
    process.exit(1);
  });
