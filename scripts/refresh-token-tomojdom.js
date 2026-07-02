const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const axios = require('axios');

const TOMOJDOM_LOGIN_1 = process.env.TOMOJDOM_LOGIN_1;
const TOMOJDOM_PASSWORD_1 = process.env.TOMOJDOM_PASSWORD_1;
const TOMOJDOM_LOGIN_2 = process.env.TOMOJDOM_LOGIN_2;
const TOMOJDOM_PASSWORD_2 = process.env.TOMOJDOM_PASSWORD_2;
const GOOGLE_SHEETS_WEBHOOK = process.env.GOOGLE_SHEETS_WEBHOOK;
const TWO_CAPTCHA_API_KEY = process.env.TWO_CAPTCHA_API_KEY;
const PROXY_URL = process.env.PROXY_URL;

const MAX_PROBY = 2;
const JWT_REGEX = /eyJ[\w-]+\.[\w-]+\.[\w-]+/;

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

async function dumpInputs(page) {
  try {
    const inputs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input')).map(i => ({
        type: i.type, name: i.name, id: i.id,
        placeholder: i.placeholder,
        vis: !!(i.offsetWidth || i.offsetHeight)
      }));
    });
    console.log('--- INPUTY ---');
    inputs.forEach(i => console.log('  ' + JSON.stringify(i)));
    console.log('--- KONIEC INPUTOW ---');
    return inputs;
  } catch (e) { console.log('dumpInputs blad: ' + e.message); return []; }
}

async function dumpButtons(page) {
  try {
    const btns = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('button, input[type=submit], a[role=button], a.button'));
      return els.map(e => ({
        tag: e.tagName, type: e.type || '', id: e.id || '',
        cls: (e.className || '').toString().substring(0, 50),
        text: (e.innerText || e.value || '').trim().substring(0, 40),
        vis: !!(e.offsetWidth || e.offsetHeight)
      }));
    });
    console.log('--- PRZYCISKI ---');
    btns.forEach(b => console.log('  ' + JSON.stringify(b)));
    console.log('--- KONIEC PRZYCISKOW ---');
    return btns;
  } catch (e) { console.log('dumpButtons blad: ' + e.message); return []; }
}

async function dumpPage(page, label) {
  try {
    const title = await page.title();
    const url = page.url();
    const bodyText = await page.evaluate(() => document.body ? document.body.innerText.substring(0, 400) : '(brak body)');
    console.log(`--- STRONA [${label}] ---`);
    console.log('  URL: ' + url);
    console.log('  Title: ' + title);
    console.log('  Tekst: ' + JSON.stringify(bodyText));
    console.log('--- KONIEC ---');
  } catch (e) { console.log('dumpPage blad: ' + e.message); }
}

async function findTokenInStorage(page) {
  try {
    return await page.evaluate((regexSrc) => {
      const regex = new RegExp(regexSrc);
      const stores = [localStorage, sessionStorage];
      const found = {};
      for (const store of stores) {
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          const val = store.getItem(key);
          found[key] = (val || '').substring(0, 40);
          if (val && regex.test(val)) {
            const m = val.match(regex);
            if (m) return m[0];
          }
        }
      }
      console.log('Storage keys: ' + JSON.stringify(found));
      return null;
    }, JWT_REGEX.source);
  } catch (e) { console.log('findTokenInStorage blad: ' + e.message); return null; }
}

async function clickButtonByText(page, textRegexSrc, exact) {
  const box = await page.evaluate((src, exact) => {
    const regex = new RegExp(src, 'i');
    const btns = Array.from(document.querySelectorAll('button, input[type=submit]'));
    const btn = btns.find(b => {
      const t = (b.innerText || b.value || '').trim();
      const vis = b.offsetWidth > 0 || b.offsetHeight > 0;
      if (!vis) return false;
      return exact ? regex.test(t) && t.length < 30 : regex.test(t);
    });
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, textRegexSrc, !!exact);

  if (!box) return false;
  await page.mouse.move(box.x - 20, box.y - 10, { steps: 5 });
  await new Promise(r => setTimeout(r, 150 + Math.random() * 150));
  await page.mouse.move(box.x, box.y, { steps: 8 });
  await new Promise(r => setTimeout(r, 150 + Math.random() * 150));
  await page.mouse.click(box.x, box.y);
  return true;
}

async function jednaProba(login, haslo, proxy, numer, opis) {
  console.log(`\n===== TOMOJDOM PROBA ${numer}/${MAX_PROBY} (${opis}) =====`);
  let browser = null;
  let bestToken = null;
  let fallbackToken = null;

  try {
    const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
    if (proxy) args.push(`--proxy-server=${proxy.server}`);

    browser = await puppeteer.launch({ headless: 'new', args });
    const page = await browser.newPage();
    if (proxy && proxy.username) await page.authenticate({ username: proxy.username, password: proxy.password });

    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'pl-PL,pl;q=0.9' });

    // Wymus polski jezyk przegladarki na poziomie JS (navigator.language),
    // zeby strona nie przelaczyla sie na EN mimo poprawnego naglowka Accept-Language
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'language', { get: () => 'pl-PL' });
      Object.defineProperty(navigator, 'languages', { get: () => ['pl-PL', 'pl'] });
    });

    // Nasluch - szukaj JWT w kazdej odpowiedzi z domeny tomojdom
    // Priorytet: rozpoznane nazwy pol tokenu > pierwszy JWT znaleziony regexem
    const KNOWN_TOKEN_KEYS = ['access_token', 'accessToken', 'token', 'jwt', 'authToken', 'auth_token', 'sessionToken', 'id_token'];

    page.on('response', async (response) => {
      try {
        const url = response.url();
        if (!url.includes('tomojdom')) return;
        const txt = await response.text();
        if (!txt) return;

        const isLoginEndpoint = url.includes('/login/') || url.includes('OsLogInPass');
        if (isLoginEndpoint) {
          console.log(`[NET] ODPOWIEDZ LOGOWANIA: ${url}`);
          console.log(`[NET] status=${response.status()}`);
          console.log(`[NET] PELNA TRESC: ${txt.substring(0, 2000)}`);
        }

        // Sprobuj sparsowac jako JSON i znalezc rozpoznane pole tokenu
        try {
          const json = JSON.parse(txt);
          for (const key of KNOWN_TOKEN_KEYS) {
            if (json[key] && typeof json[key] === 'string' && JWT_REGEX.test(json[key])) {
              console.log(`[NET] Znaleziono token w polu '${key}' (${url.substring(0, 60)})`);
              bestToken = json[key];
            }
          }
        } catch (e) {
          // nie JSON - ok, sprobujemy regex ponizej
        }

        if (!bestToken) {
          const m = txt.match(JWT_REGEX);
          if (m) {
            console.log(`[NET] JWT (regex, fallback) znaleziony w: ${url.substring(0, 80)}`);
            fallbackToken = m[0];
          }
        }
      } catch (e) {}
    });

    if (proxy) {
      try {
        await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 25000 });
        console.log('IP wychodzace: ' + (await page.evaluate(() => document.body.innerText)));
      } catch (e) { console.log('IP check blad: ' + e.message); }
    }

    console.log('Otwieranie tomojdom.pl...');
    await page.goto('https://tomojdom.pl/', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Sprawdz czy nie wyladowalismy na wersji EN (inna struktura formularza)
    await new Promise(r => setTimeout(r, 1000));
    if (page.url().includes('/en/')) {
      console.log('Wylandowano na wersji EN (' + page.url() + ') - wymuszam /pl/...');
      try {
        await page.goto('https://tomojdom.pl/pl/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (e) {
        console.log('Przekierowanie na /pl/ nie powiodlo sie: ' + e.message);
      }
    }
    console.log('Aktualny URL: ' + page.url());

    // SPA - czekaj az cokolwiek sie wyrenderuje (input lub tresc)
    console.log('Czekanie na render SPA (max 20s)...');
    try {
      await page.waitForFunction(() => document.querySelectorAll('input').length > 0, { timeout: 20000 });
      console.log('Wykryto inputy na stronie');
    } catch (e) {
      console.log('Brak inputow po 20s - dump strony i przerywam ta probe');
      await dumpPage(page, 'brak inputow');
      return null;
    }

    await new Promise(r => setTimeout(r, 1000));
    await acceptCookies(page);
    await new Promise(r => setTimeout(r, 500));

    await dumpPage(page, 'po zaladowaniu');
    let inputs = await dumpInputs(page);
    await dumpButtons(page);

    // Formularz jest JEDNOETAPOWY - login i haslo sa razem w jednym formularzu.
    // Pole loginu ma czesto list="userHints" (datalist), pole hasla type=password.
    const userField = inputs.find(i => i.type === 'text' || i.type === 'email' || i.type === 'tel');
    const passField = inputs.find(i => i.type === 'password');

    if (!userField || !passField) {
      console.log('NIE ZNALEZIONO pol login/haslo - koniec probki diagnostycznej.');
      console.log('userField: ' + JSON.stringify(userField));
      console.log('passField: ' + JSON.stringify(passField));
      return null;
    }

    const userSelector = userField.id ? '#' + userField.id
      : (userField.name ? `input[name="${userField.name}"]`
      : `input[placeholder="${userField.placeholder}"]`);
    const passSelector = passField.id ? '#' + passField.id
      : (passField.name ? `input[name="${passField.name}"]`
      : 'input[type="password"]');
    console.log('Selektor login: ' + userSelector);
    console.log('Selektor haslo: ' + passSelector);

    console.log('Wpisywanie loginu...');
    await (await page.$(userSelector)).type(login, { delay: 80 });
    await new Promise(r => setTimeout(r, 400));

    console.log('Wpisywanie hasla...');
    await (await page.$(passSelector)).type(haslo, { delay: 80 });
    await new Promise(r => setTimeout(r, 400));

    // reCAPTCHA
    const hasCaptcha = await page.$('iframe[src*="recaptcha"]') !== null;
    if (hasCaptcha) {
      console.log('Wykryto reCAPTCHA');
      const sitekey = await page.evaluate(() => {
        const div = document.querySelector('[data-sitekey]');
        if (div) return div.getAttribute('data-sitekey');
        const s = Array.from(document.scripts).find(s => s.textContent.includes('grecaptcha.render'));
        if (s) { const m = s.textContent.match(/sitekey['":\s]+['"]([^'"]+)['"]/); return m ? m[1] : null; }
        return null;
      });
      if (sitekey) {
        console.log('Sitekey: ' + sitekey.substring(0, 20) + '...');
        const sol = await solveCaptcha(sitekey, 'https://tomojdom.pl/');
        await page.evaluate((token) => {
          let el = document.getElementById('g-recaptcha-response');
          if (!el) {
            el = document.createElement('textarea');
            el.id = 'g-recaptcha-response';
            el.name = 'g-recaptcha-response';
            el.style.display = 'none';
            document.body.appendChild(el);
          }
          el.innerHTML = token;
          el.value = token;
          if (window.___grecaptcha_cfg) {
            Object.entries(window.___grecaptcha_cfg.clients).forEach(([k, c]) => {
              const findCallback = (obj) => {
                for (const key in obj) {
                  if (obj[key] && typeof obj[key] === 'object') {
                    if (obj[key].callback) { obj[key].callback(token); }
                    findCallback(obj[key]);
                  }
                }
              };
              findCallback(c);
            });
          }
        }, sol);
        console.log('CAPTCHA wkleta');
        await new Promise(r => setTimeout(r, 500));
      } else {
        console.log('Nie znaleziono sitekey mimo wykrycia iframe reCAPTCHA');
      }
    } else {
      console.log('Brak reCAPTCHA');
    }

    // Klik przycisku "Zaloguj hasłem" (PL) / "Login" (EN) - obsluz oba warianty
    console.log('Szukanie przycisku Zaloguj hasłem / Login...');
    const loginClicked = await clickButtonByText(page, 'zaloguj has|^login$');
    if (loginClicked) {
      console.log('Przycisk logowania klikniety (mysz)');
    } else {
      console.log('Nie znaleziono przycisku - probuje Enter w polu hasla');
      await page.focus(passSelector);
      await page.keyboard.press('Enter');
    }

    console.log('Czekanie na zalogowanie / token (max 20s)...');
    let waited = 0;
    while (!bestToken && !fallbackToken && waited < 20000) {
      await new Promise(r => setTimeout(r, 1000)); waited += 1000;
      process.stdout.write('.');
    }
    console.log('');

    // dumpPage moze sie nie udac jesli strona wlasnie nawigowala - to nie problem
    try { await dumpPage(page, 'po probie logowania'); } catch (e) {}

    let finalToken = bestToken || fallbackToken;

    if (!finalToken) {
      console.log('Sprawdzanie localStorage/sessionStorage...');
      finalToken = await findTokenInStorage(page);
    }

    if (bestToken) {
      console.log('Uzyto tokenu z rozpoznanego pola (bestToken)');
    } else if (fallbackToken) {
      console.log('UWAGA: uzyto tokenu z regexu-fallback (bestToken nie znaleziony) - to moze byc zly token');
    }

    return finalToken;

  } catch (error) {
    console.log('Proba nieudana: ' + error.message);
    return null;
  } finally {
    if (browser) { await browser.close(); console.log('Przegladarka zamknieta'); }
  }
}

async function wyslijDoAppsScript(jwt, login) {
  if (!GOOGLE_SHEETS_WEBHOOK) {
    console.log('BRAK GOOGLE_SHEETS_WEBHOOK - token nie wyslany');
    console.log('PELNY TOKEN: ' + jwt);
    return;
  }
  try {
    console.log('Wysylanie JWT Tomojdom (' + login + ') do Apps Script...');
    await axios.post(GOOGLE_SHEETS_WEBHOOK,
      { tomojdom_jwt: jwt, login: login },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    console.log('JWT wyslany do Apps Script!');
  } catch (e) {
    console.error('Blad wysylania do Apps Script: ' + e.message);
  }
}

async function zaloguj_i_wyslij(login, haslo, proxy, opis) {
  console.log(`\n########## KONTO: ${opis} (login: ${login}) ##########`);
  let token = null;
  for (let i = 1; i <= MAX_PROBY && !token; i++) {
    token = await jednaProba(login, haslo, proxy, i, opis);
    if (!token && i < MAX_PROBY) {
      console.log('Czekam 5s przed kolejna proba...');
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  if (!token) {
    console.error(`Nie udalo sie znalezc JWT dla konta ${login} po ${MAX_PROBY} probach.`);
    return false;
  }

  console.log(`=== SUKCES: ${opis} ===`);
  console.log('JWT (50 znakow): ' + token.substring(0, 50) + '...');
  await wyslijDoAppsScript(token, login);
  return true;
}

async function main() {
  console.log('Start - logowanie Tomojdom (dwa konta)');
  const proxy = parseProxy(PROXY_URL);
  if (proxy) console.log(`Proxy: ${proxy.host}:${proxy.port}`);
  else console.log('BRAK PROXY - laczenie bezposrednie');

  const konta = [];
  if (TOMOJDOM_LOGIN_1 && TOMOJDOM_PASSWORD_1) {
    konta.push({ login: TOMOJDOM_LOGIN_1, haslo: TOMOJDOM_PASSWORD_1, opis: 'Konto 1' });
  }
  if (TOMOJDOM_LOGIN_2 && TOMOJDOM_PASSWORD_2) {
    konta.push({ login: TOMOJDOM_LOGIN_2, haslo: TOMOJDOM_PASSWORD_2, opis: 'Konto 2' });
  }

  if (konta.length === 0) {
    console.error('Brak skonfigurowanych kont - ustaw TOMOJDOM_LOGIN_1/TOMOJDOM_PASSWORD_1 (i opcjonalnie _2)');
    process.exit(1);
  }

  let sukcesow = 0;
  for (const konto of konta) {
    const ok = await zaloguj_i_wyslij(konto.login, konto.haslo, proxy, konto.opis);
    if (ok) sukcesow++;
    // Krotka przerwa miedzy kontami - nowa przegladarka, nowe IP z proxy
    if (konto !== konta[konta.length - 1]) {
      console.log('Przerwa 5s przed kolejnym kontem...');
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  console.log(`\nGotowe! Zalogowano poprawnie: ${sukcesow}/${konta.length} kont.`);
  process.exit(sukcesow > 0 ? 0 : 1);
}

main();
