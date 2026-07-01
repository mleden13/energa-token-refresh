const puppeteer = require('puppeteer');
const axios = require('axios');

const ENERGA_EMAIL = process.env.ENERGA_EMAIL;
const ENERGA_PASSWORD = process.env.ENERGA_PASSWORD;
const GOOGLE_SHEETS_WEBHOOK = process.env.GOOGLE_SHEETS_WEBHOOK;

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
    
    // Monitoruj wszystkie response'y
    page.on('response', async (response) => {
      try {
        const url = response.url();
        const status = response.status();
        
        // Szukaj /token endpoint'a
        if (url.includes('/token') && status === 200) {
          console.log(`📡 Znaleziono /token endpoint: ${url}`);
          
          try {
            const data = await response.json();
            if (data.refresh_token) {
              refreshToken = data.refresh_token;
              console.log('✅ Znaleziono refresh_token w response!');
            }
          } catch (e) {
            // Response nie jest JSON, ignoruj
          }
        }
      } catch (e) {
        // Ignoruj błędy
      }
    });
    
    // Przejdź na Energa
    console.log('📍 Otwieranie 24.energa.pl...');
    await page.goto('https://24.energa.pl/', { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Czekaj na formularz logowania
    console.log('⏳ Czekanie na formularz...');
    try {
      await page.waitForSelector('input[type="email"], input[name="username"], input[id*="email"]', { timeout: 10000 });
    } catch (e) {
      console.log('⚠️ Nie znaleziono pola email, próbuję alternatywnie...');
    }
    
    // Wpisz email
    console.log('📝 Wpisywanie emaila...');
    const emailSelectors = ['input[type="email"]', 'input[name="username"]', 'input[id*="email"]'];
    let emailFound = false;
    for (const selector of emailSelectors) {
      try {
        await page.type(selector, ENERGA_EMAIL);
        emailFound = true;
        break;
      } catch (e) {
        // Spróbuj następny selector
      }
    }
    
    if (!emailFound) {
      throw new Error('❌ Nie znaleziono pola email');
    }
    
    // Czekaj na password field
    console.log('⏳ Czekanie na pole hasła...');
    const passwordSelectors = ['input[type="password"]', 'input[name="password"]'];
    let passwordFound = false;
    for (const selector of passwordSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        await page.type(selector, ENERGA_PASSWORD);
        passwordFound = true;
        break;
      } catch (e) {
        // Spróbuj następny selector
      }
    }
    
    if (!passwordFound) {
      throw new Error('❌ Nie znaleziono pola hasła');
    }
    
    // Kliknij login
    console.log('🔐 Klikanie przycisku logowania...');
    const submitSelectors = ['button[type="submit"]', 'button:has-text("Zaloguj")', 'button'];
    let submitted = false;
    for (const selector of submitSelectors) {
      try {
        await Promise.all([
          page.click(selector),
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
        ]);
        submitted = true;
        break;
      } catch (e) {
        // Spróbuj następny selector
      }
    }
    
    if (!submitted) {
      console.log('⚠️ Nie znaleziono przycisku, próbuję czekać na token...');
    }
    
    // Czekaj na token
    console.log('⏳ Czekanie na refresh_token (max 15 sekund)...');
    let waited = 0;
    while (!refreshToken && waited < 15000) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      waited += 1000;
    }
    
    if (!refreshToken) {
      // Spróbuj pobrać z cookies
      console.log('🍪 Próbuję pobrać z cookies...');
      const cookies = await page.cookies();
      const tokenCookie = cookies.find(c => c.name.includes('token') || c.name.includes('refresh'));
      if (tokenCookie) {
        console.log(`🍪 Znaleziono cookie: ${tokenCookie.name}`);
      }
      
      throw new Error('❌ Nie udało się pobrać refresh_token - sprawdź czy email/hasło są prawidłowe');
    }
    
    console.log('✅ Token pobrany pomyślnie!');
    console.log(`🔑 Token (pierwsze 50 znaków): ${refreshToken.substring(0, 50)}...`);
    
    // Wyślij do Google Sheets
    if (GOOGLE_SHEETS_WEBHOOK) {
      await sendToGoogleSheets(refreshToken);
    } else {
      console.log('⚠️ GOOGLE_SHEETS_WEBHOOK nie ustawiony - token nie zostanie wysłany');
      console.log(`✅ Refresh Token: ${refreshToken}`);
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
    
    const response = await axios.post(GOOGLE_SHEETS_WEBHOOK, {
      entry_1: refreshToken,
      entry_2: new Date().toISOString()
    }, {
      timeout: 10000
    });
    
    console.log('✅ Token wysłany do Google Sheets!');
    return response.data;
  } catch (error) {
    console.error('❌ Błąd wysyłania:', error.message);
    console.log('💡 Możliwe że webhook URL jest nieprawidłowy');
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
