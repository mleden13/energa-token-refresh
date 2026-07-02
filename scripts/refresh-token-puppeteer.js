const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const axios = require('axios');

const ENERGA_EMAIL = process.env.ENERGA_EMAIL;
const ENERGA_PASSWORD = process.env.ENERGA_PASSWORD;
const GOOGLE_SHEETS_WEBHOOK = process.env.GOOGLE_SHEETS_WEBHOOK;
const TWO_CAPTCHA_API_KEY = process.env.TWO_CAPTCHA_API_KEY;
const PROXY_URL = process.env.PROXY_URL;

const MAX_PROBY = 1;

function parseProxy(proxyUrl) {
  if (!proxyUrl) return null;
  try {
    const url = new URL(proxyUrl);
    return {
      server: `${url.protocol}//${url.hostname}:${url.port}`,
      host: url.hostname, port: url.port,
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password)
    };
  } catch (e) { console.error('Blad parsowania PROXY_URL:', e.message); return null; }
}

async function acceptCookies(page) {
  const selectors = [
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    '#CybotCookiebotDialogBodyButtonAccept',
    '#onetrust-accept-btn-handler'
  ];
  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn) { await btn.click(); console.log('Cookies OK: ' + sel); await new Promise(r => setTimeout(r, 800)); return; }
    } catch (e) {}
  }
  try {
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a'));
      const t = btns.find(b => /zezw[oó]l na wszystkie|akceptuj|^zgoda$/i.test((b.innerText || '').trim()));
      if (t) { t.click(); return t.innerText; }
      return null;
    });
    if (clicked) { console.log('Cookies OK (tekst): ' + clicked.trim()); await new Promise(r => setTimeout(r, 800)); }
  } catch (e) {}
}

async function solveCaptcha(sitekey, pageUrl) {
  console.log('Rozwiazywanie CAPTCHA...');
  const up = await axios.post('http://2captcha.com/in.php',
    { method: 'userrecaptcha', googlekey: sitekey, pageurl: pageUrl, json: 1 },
    { params: { apikey: TWO_CAPTCHA_API_KEY } });
  if (up.data.status !== 0) throw new Error(`2captcha: ${up.data.error}`);
  const id = up.data.captcha;
  let sol = null, att = 0;
  while (!sol && att < 60) {
    await new Promise(r => setTimeout(r, 1000)); att++;
    const res = await axios.get('http://2captcha.com/res.php',
      { params: { apikey: TWO_CAPTCHA_API_KEY, action: 'get', id, json: 1 } });
    if (res.data.status === 1) sol = res.data.request;
    else if (res.data.status === 0) process.stdout.write('.');
    else throw new Error(`2captcha: ${res.data.error}`);
  }
  if (!sol) throw new Error('Timeout CAPTCHA');
  console.log('CAPTCHA rozwiazana!');
  return sol;
}

async function dumpButtons(page) {
  try {
    const btns = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('button, input[type=submit], input[type=button], a[role=button], a.button'));
      return els.map(e => ({
        tag: e.tagName,
        type: e.type || '',
        id: e.id || '',
        name: e.name || '',
        cls: (e.className || '').toString().substring(0, 50),
        text: (e.innerText || e.value || '').trim().substring(0, 40),
        vis: !!(e.offsetWidth || e.offsetHeight)
      }));
    });
    console.log('--- PRZYCISKI ---');
    btns.forEach(b => console.log('  ' + JSON.stringify(b)));
    console.log('--- KONIEC PRZYCISKOW ---');
  } catch (e) { console.log('dumpButtons blad: ' + e.message); }
}

async function clickSubmit(page) {
  // 1. Standardowy Keycloak submit (input type=submit)
  try {
    const kc = await page.$('#kc-login');
    if (kc) { await kc.click(); console.log('Submit: #kc-login'); return; }
  } catch (e) {}
  // 2. input[type=submit] / button[type=submit] (prawdziwe przyciski, nie naglowki)
  for (const sel of ['input[type="submit"]', 'button[type="submit"]']) {
    try {
      const b = await page.$(sel);
      if (b) { await b.click(); console.log('Submit: ' + sel); return; }
    } catch (e) {}
  }
  // 3. Enter w polu hasla - natywny submit formularza (to dzialalo wczesniej)
  try {
    await page.focus('#password');
    await page.keyboard.press('Enter');
    console.log('Submit: Enter w #password');
    return;
  } catch (e) {}
  // 4. Ostatecznosc
  await page.keyboard.press('Enter');
  console.log('Submit: Enter (fallback)');
}

// Jedna proba logowania. Zwraca refresh_token lub null.
async function jednaProba(proxy, numer) {
  console.log(`\n===== PROBA ${numer}/${MAX_PROBY} =====`);
  let browser = null;
  let refreshToken = null;

  try {
    const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
    if (proxy) args.push(`--proxy-server=${proxy.server}`);

    browser = await puppeteer.launch({ headless: 'new', args });
    const page = await browser.newPage();
    if (proxy && proxy.username) await page.authenticate({ username: proxy.username, password: proxy.password });

    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8' });

    // Nasluch tokenu (parsujemy przez text() - bezpieczniej)
    page.on('response', async (response) => {
      try {
        const url = response.url();
        if (url.includes('/token')) {
          const status = response.status();
          const txt = await response.text();
          try {
            const data = JSON.parse(txt);
            console.log(`[NET] token status=${status} klucze: ${Object.keys(data).join(', ')}`);
            if (data.refresh_token) {
              refreshToken = data.refresh_token;
              console.log('>>> Znaleziono refresh_token! <<<');
              if (data.refresh_expires_in) console.log('    refresh_expires_in: ' + data.refresh_expires_in + 's');
            }
          } catch (e) { /* nie JSON */ }
        }
      } catch (e) {}
    });

    if (proxy) {
      try {
        await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 25000 });
        console.log('IP wychodzace: ' + (await page.evaluate(() => document.body.innerText)));
      } catch (e) { console.log('IP check blad: ' + e.message); }
    }

    console.log('Otwieranie 24.energa.pl...');
    await page.goto('https://24.energa.pl/', { waitUntil: 'domcontentloaded', timeout: 60000 });

    console.log('Czekanie na #username...');
    await page.waitForSelector('#username', { timeout: 45000 });
    console.log('Formularz OK');

    await acceptCookies(page);

    console.log('Wpisywanie emaila...');
    await (await page.$('#username')).type(ENERGA_EMAIL, { delay: 80 });

    console.log('Klik Energa24...');
    await page.waitForSelector('#kc-switch-button', { timeout: 8000 });
    await page.click('#kc-switch-button');
    await new Promise(r => setTimeout(r, 2500));

    console.log('Czekanie na #password...');
    await page.waitForSelector('#password', { timeout: 15000 });

    await acceptCookies(page);

    console.log('Wpisywanie hasla...');
    await (await page.$('#password')).type(ENERGA_PASSWORD, { delay: 80 });

    // Zaznacz "zapamietaj mnie" - moze wydluzyc zycie tokenu
    try {
      const remember = await page.$('#rememberMe');
      if (remember) {
        const checked = await page.evaluate(el => el.checked, remember);
        if (!checked) { await remember.click(); console.log('Zaznaczono rememberMe'); }
      }
    } catch (e) {}

    // reCAPTCHA
    if (await page.$('iframe[src*="recaptcha"]') !== null) {
      console.log('reCAPTCHA wykryta');
      const sitekey = await page.evaluate(() => {
        const s = Array.from(document.scripts).find(s => s.textContent.includes('grecaptcha.render'));
        if (s) { const m = s.textContent.match(/sitekey['":\s]+['"]([^'"]+)['"]/); return m ? m[1] : null; }
        return null;
      });
      if (sitekey) {
        const sol = await solveCaptcha(sitekey, 'https://24.energa.pl/');
        await page.evaluate((token) => {
          document.getElementById('g-recaptcha-response').innerHTML = token;
          if (window.___grecaptcha_cfg) {
            Object.entries(window.___grecaptcha_cfg.clients).forEach(([k, c]) => { if (c.callback) c.callback(token); });
          }
        }, sol);
        console.log('CAPTCHA wkleta');
      }
    } else { console.log('Brak reCAPTCHA'); }

    console.log('Wysylanie formularza...');
    await dumpButtons(page);
    await clickSubmit(page);

    // Potwierdzenie: URL wychodzi z /auth/realms/
    console.log('Czekanie na potwierdzenie logowania...');
    let loggedIn = false;
    try {
      await page.waitForFunction(() => !window.location.href.includes('/auth/realms/'), { timeout: 15000 });
      loggedIn = true;
      console.log('LOGOWANIE POTWIERDZONE: ' + page.url());
    } catch (e) {
      // Druga proba - Enter w polu hasla
      console.log('Pierwszy submit nie zadzialal, probuje Enter w #password...');
      try {
        await page.focus('#password');
        await page.keyboard.press('Enter');
      } catch (e2) {}
      try {
        await page.waitForFunction(() => !window.location.href.includes('/auth/realms/'), { timeout: 15000 });
        loggedIn = true;
        console.log('LOGOWANIE POTWIERDZONE (2 proba): ' + page.url());
      } catch (e3) {
        console.log('URL nadal /auth/ - logowanie nieudane w tej probie');
        const bodyText = await page.evaluate(() => document.body ? document.body.innerText.substring(0, 300) : '');
        console.log('Tekst strony: ' + JSON.stringify(bodyText));
        return null;
      }
    }

    // Token pojawia sie tuz po zalogowaniu - czekamy na niego
    console.log('Czekanie na refresh_token z /token (max 25s)...');
    let waited = 0;
    while (!refreshToken && waited < 25000) {
      await new Promise(r => setTimeout(r, 1000)); waited += 1000;
      process.stdout.write('.');
    }
    console.log('');

    return refreshToken;

  } catch (error) {
    console.log('Proba nieudana: ' + error.message);
    return null;
  } finally {
    if (browser) { await browser.close(); console.log('Przegladarka zamknieta'); }
  }
}

async function main() {
  console.log('Start - pobieranie refresh_token z Energi');
  const proxy = parseProxy(PROXY_URL);
  if (proxy) console.log(`Proxy: ${proxy.host}:${proxy.port}`);
  else console.log('BRAK PROXY - laczenie bezposrednie');

  let refreshToken = null;

  for (let i = 1; i <= MAX_PROBY && !refreshToken; i++) {
    refreshToken = await jednaProba(proxy, i);
    if (!refreshToken && i < MAX_PROBY) {
      console.log('Czekam 5s przed kolejna proba (nowe IP)...');
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  if (!refreshToken) {
    console.error('Blad: Nie udalo sie pobrac refresh_token po ' + MAX_PROBY + ' probach');
    process.exit(1);
  }

  console.log('\n=== SUKCES ===');
  console.log('refresh_token (50 znakow): ' + refreshToken.substring(0, 50) + '...');

  if (GOOGLE_SHEETS_WEBHOOK) {
    try {
      console.log('Wysylanie do Google Sheets...');
      await axios.post(GOOGLE_SHEETS_WEBHOOK, {
        entry_1: refreshToken, entry_2: new Date().toISOString()
      }, { timeout: 10000 });
      console.log('Token wyslany do Google Sheets!');
    } catch (e) {
      console.error('Blad wysylania do Sheets: ' + e.message);
      process.exit(1);
    }
  } else {
    console.log('BRAK GOOGLE_SHEETS_WEBHOOK - token nie wyslany');
    console.log('PELNY TOKEN: ' + refreshToken);
  }

  console.log('Gotowe!');
  process.exit(0);
}

main();
