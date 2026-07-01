const axios = require('axios');

const ENERGA_EMAIL = process.env.ENERGA_EMAIL;
const ENERGA_PASSWORD = process.env.ENERGA_PASSWORD;
const GOOGLE_SHEETS_WEBHOOK = process.env.GOOGLE_SHEETS_WEBHOOK;

async function getRefreshToken() {
  console.log('🚀 Pobieranie refresh_token z Keycloak...');
  
  try {
    // Krok 1: Pobierz authorization code
    console.log('📍 Krok 1: Pobieranie authorization code...');
    
    const authResponse = await axios.post(
      'https://24.energa.pl/auth/realms/Energa-Selfcare/protocol/openid-connect/token',
      new URLSearchParams({
        grant_type: 'password',
        client_id: 'energa-selfcare',
        username: ENERGA_EMAIL,
        password: ENERGA_PASSWORD,
        scope: 'openid'
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 10000
      }
    );
    
    const tokens = authResponse.data;
    
    if (!tokens.refresh_token) {
      throw new Error('❌ Brak refresh_token w response');
    }
    
    console.log('✅ Znaleziono refresh_token!');
    console.log(`🔑 Token (pierwsze 50 znaków): ${tokens.refresh_token.substring(0, 50)}...`);
    
    // Wyślij do Google Sheets jeśli webhook istnieje
    if (GOOGLE_SHEETS_WEBHOOK) {
      await sendToGoogleSheets(tokens.refresh_token);
    } else {
      console.log('💡 GOOGLE_SHEETS_WEBHOOK nie ustawiony');
      console.log(`✅ Refresh Token:\n${tokens.refresh_token}`);
    }
    
    return tokens.refresh_token;
    
  } catch (error) {
    if (error.response?.status === 401) {
      console.error('❌ Email lub hasło nieprawidłowe (401)');
      console.error('Sprawdź ENERGA_EMAIL i ENERGA_PASSWORD w GitHub Secrets');
    } else if (error.response?.data?.error) {
      console.error('❌ Błąd Keycloak:', error.response.data.error);
      console.error('Szczegóły:', error.response.data.error_description);
    } else {
      console.error('❌ Błąd:', error.message);
    }
    throw error;
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
