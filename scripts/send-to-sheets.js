const axios = require('axios');

async function sendTokenToSheets(token) {
  const WEBHOOK_URL = process.env.GOOGLE_SHEETS_WEBHOOK;
  
  if (!WEBHOOK_URL) {
    console.log('⚠️ GOOGLE_SHEETS_WEBHOOK nie ustawiony');
    return;
  }
  
  try {
    const response = await axios.post(WEBHOOK_URL, {
      token: token,
      timestamp: new Date().toISOString(),
      source: 'GitHub Actions'
    });
    
    console.log('✅ Wysłano do Google Sheets');
  } catch (error) {
    console.error('❌ Błąd wysyłania:', error.message);
  }
}

module.exports = { sendTokenToSheets };
