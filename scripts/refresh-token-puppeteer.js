const puppeteer = require('puppeteer');
const axios = require('axios');

const ENERGA_EMAIL = process.env.ENERGA_EMAIL;
const ENERGA_PASSWORD = process.env.ENERGA_PASSWORD;
const GOOGLE_SHEETS_WEBHOOK = process.env.GOOGLE_SHEETS_WEBHOOK;
const TWO_CAPTCHA_API_KEY = process.env.TWO_CAPTCHA_API_KEY;

async function solveCaptchaWith2Captcha(sitekey, pageUrl) {
  console.log('🔐 Wysyłam CAPTCHA do 2Captcha...');
  
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
      throw new Error(`Błąd wysyłania: ${uploadResponse.data.error}`);
    }
    
    const captchaId = uploadResponse.data.captcha;
    console.log(`📤 CAPTCHA wysłana (ID: ${captchaId})`);
    
    console.log('⏳ Czekanie na rozwiązanie (max 60 sekund)...');
    
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
        console.log('✅ CAPTCHA rozwiązana!');
      } else if (resultResponse.data.status === 0) {
        process.stdout.write('.');
      } else {
        throw new Error(`Błąd: ${resultResponse.data.error}`);
      }
    }
    
    if (!solution) {
      throw new Error('Timeout: CAPTCHA nie została rozwiązana w 60 sekund');
    }
    
    return solution;
    
  } catch (error) {
    console.error('❌ Błąd 2Captcha:', error.message);
    throw error;
  }
}

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
    
    // Monitoruj responses
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
    console.log('⏳ Czekanie na formularz (max 20 sekund)...');
    
    try {
      // Czekaj aż coś się załaduje
      await page.waitForFunction(() => {
        return document.body.innerText.length > 100;
      }, { timeout: 20000 });
      
      console.log('📄 Strona załadowana');
      
      // Weź screenshot
      await page.screenshot({ path: '/tmp/debug-form.png' });
      console.log('📸 Screenshot zapisany');
      
      // Wydrukuj wszystkie pola input
      const inputs = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('input')).map(i => ({
          type: i.type,
          name: i.name,
          id: i.id,
          placeholder: i.placeholder
        }));
      });
      
      console.log('📋 Znalezione pola input:');
      console.log(JSON.stringify(inputs, null, 2));
      
    } catch (e) {
      console.error('❌ Timeout czekania na formularz');
      await page.screenshot({ path: '/tmp/debug-timeout.png' });
      throw new Error('Formularz się nie załadował');
    }
    
    // Spróbuj różne selektory
    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[name*="email"]',
      'input[id*="email"]',
      'input[placeholder*="email"]',
      'input[placeholder*="Email"]',
      'input[type="text"]'
    ];
    
    let emailInput = null;
    let emailSelector = null;
    
    for (const selector of emailSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          emailInput = element;
          emailSelector = selector;
          console.log(`✅ Znaleziono email: ${selector}`);
          break;
        }
      } catch (e) {
        // Spróbuj następny
      }
    }
    
    if (!emailInput) {
      throw new Error('❌ Nie znaleziono żadnego pola email');
    }
    
    // Wpisz email
    console.log('📝 Wpisywanie emaila...');
    await emailInput.type(ENERGA_EMAIL, { delay: 100 });
    
    // Czekaj na password field
    console.log('⏳ Czekanie na pole hasła...');
    const passwordSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      'input[name*="password"]'
    ];
    
    let passwordInput = null;
    
    for (const selector of passwordSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          passwordInput = element;
          console.log(`✅ Znaleziono password: ${selector}`);
          break;
        }
      } catch (e) {
        // Spróbuj następny
      }
    }
    
    if (!passwordInput) {
      throw new Error('❌ Nie znaleziono pola hasła');
    }
    
    // Wpisz hasło
    console.log('📝 Wpisywanie hasła...');
    await passwordInput.type(ENERGA_PASSWORD, { delay: 100 });
    
    // Sprawdź reCAPTCHA
    console.log('🔍 Szukanie reCAPTCHA...');
    const hasCaptcha = await page.$('iframe[src*="recaptcha"]') !== null;
    
    if (hasCaptcha) {
      console.log('🤖 Znaleziono reCAPTCHA');
      
      // Pobierz sitekey
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
        console.log(`🔑 Sitekey: ${sitekey.substring(0, 20)}...`);
        
        // Rozwiąż CAPTCHA
        const captchaSolution = await solveCaptchaWith2Captcha(sitekey, 'https://24.energa.pl/');
        
        // Wklej do strony
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
        
        console.log('✅ CAPTCHA wklęta');
      } else {
        console.log('⚠️ Nie znaleziono sitekey');
      }
    } else {
      console.log('✅ Brak reCAPTCHA');
    }
    
    // Kliknij login
    console.log('🔐 Klikanie przycisku logowania...');
    const submitSelectors = [
      'button[type="submit"]',
      'button:contains("Zaloguj")',
      'button'
    ];
    
    let submitted = false;
    for (const selector of submitSelectors) {
      try {
        await Promise.all([
          page.click(selector),
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
        ]);
        submitted = true;
        console.log('✅ Login kliknięty');
        break;
      } catch (e) {
        // Spróbuj następny
      }
    }
    
    if (!submitted) {
      console.log('⚠️ Nie znaleziono przycisku logowania');
    }
    
    // Czekaj na token
    console.log('⏳ Czekanie na refresh_token (max 15 sekund)...');
    let waited = 0;
    while (!refreshToken && waited < 15000) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      waited += 1000;
      process.stdout.write('.');
    }
    console.log('');
    
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
    console.log('🎉
