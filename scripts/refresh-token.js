const puppeteer = require('puppeteer');
const axios = require('axios');

const ENERGA_EMAIL = process.env.ENERGA_EMAIL;
const ENERGA_PASSWORD = process.env.ENERGA_PASSWORD;
const GOOGLE_SHEETS_WEBHOOK = process.env.GOOGLE_SHEETS_WEBHOOK;
const TWO_CAPTCHA_API_KEY = process.env.TWO_CAPTCHA_API_KEY;

async function getRefreshToken() {
  console.log('🚀 Rozpoczynanie logowania do Energi...');
  
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    
    // Ustaw viewport
    await page.setViewport({ width: 1280, height: 720 });
    
    // Przejdź na Energa
    console.log('📍 Otwieranie 24.energa.pl...');
    await page.goto('https://24.energa.pl/', { waitUntil: 'networkidle2' });
    
    // Czekaj na element logowania
    await page.waitForSelector('input[type="email"], input[name="username"]', { timeout: 10000 });
    
    // Wpisz email
    console.log('📝 Wpisywanie emaila...');
    await page.type('input[type="email"], input[name="username"]', ENERGA_EMAIL);
    
    // Poczekaj na password field
    await page.waitForSelector('input[type="password"], input[name="password"]', { timeout: 5000 });
    
    // Wpisz hasło
    console.log('📝 Wpisywanie hasła...');
    await page.type('input[type="password"], input[name="password"]', ENERGA_PASSWORD);
    
    // Kliknij login
    console.log('🔐 Klikanie przycisku logowania...');
    await Promise.all([
      page.click('button[type="submit"], button:contains("Zaloguj")'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
    ]).catch(() => {
      // Może być redirect bez change, ignoruj błąd
    });
    
    // Czekaj aż będzie zalogowany (szukaj dashboard'u)
    console.log('⏳ Czekanie na zalogowanie...');
    await page.waitForSelector('[class*="dashboard"], [class*="account"], body', { timeout: 15000 });
    
    // Przechwyć request /token aby pobrać refresh_token
    console.log('🔍 Szukanie tokenu...');
    
    let refreshToken = null;
    
    // Słuchaj network requests
    page.on('response', async (response) => {
      if (response.url().includes('/token') && response.status() === 200) {
        try {
          const data = await response.json();
          if (data.refresh_token) {
            refreshToken = data.refresh_token;
            console.log('✅ Znaleziono refresh_token!');
          }
        } catch (e) {
          // Ignore
        }
      }
    });
    
    // Jeśli token się nie pojawił automatycznie, trigger Keycloak refresh
    console.log('🔄 Triggering token refresh...');
    await page.goto('https://24.energa.pl/api/dashboard', { waitUntil: 'networkidle2' }).catch(() => {});
    
    // Czekaj trochę na token
    await page.waitForTimeout(3000);
    
    if (!refreshToken) {
      console.log('⚠️ Nie znaleziono tokenu w network requests');
      console.log('💡 Spróbuję pobrać z localStorage...');
      
      // Alternatywa: spróbuj localStorage
      refreshToken = await page.evaluate(() => {
        return localStorage.getItem('refresh_token') || 
               sessionStorage.getItem('refresh_token') ||
               null;
      });
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
    }
  }
}

async function sendToGoogleSheets(refreshToken) {
  try {
    console.log('📨 Wysyłanie tokenu do Google Sheets...');
    
    const response = await axios.post(GOOGLE_SHEETS_WEBHOOK, {
      token: refreshToken,
      timestamp: new Date().toISOString()
    });
    
    console.log('✅ Token wysłany do Google Sheets!');
    return response.data;
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
    console.error('💥 Błąd:', error);
    process.exit(1);
  });
