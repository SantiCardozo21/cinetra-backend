const puppeteer = require('puppeteer');
const fetch     = require('node-fetch');

const POSEIDON_BASE   = 'https://www.poseidonhd2.co';
const JUANITA_BASE    = 'https://pelisjuanita.com';
const SCRAPER_UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PREFERRED_HOSTS = ['streamwish', 'filemoon', 'vidhide', 'voesx'];

// ── Lanzar browser compartido ────────────────────────────────────────────────
let _browser = null;
async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
  _browser = await puppeteer.launch({
    headless: 'new',
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--mute-audio',
      '--no-first-run',
      '--disable-extensions',
    ],
  });
  return _browser;
}

// ── 1. Resolver PoseidonHD via __NEXT_DATA__ (sin Puppeteer, rápido) ─────────
async function resolvePoseidon(pageUrl) {
  const html = await httpGet(pageUrl, POSEIDON_BASE);
  if (!html) return null;

  const match = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;

  try {
    const data   = JSON.parse(match[1]);
    const props  = data?.props?.pageProps;
    const videos = props?.thisMovie?.videos || props?.thisTvshow?.videos
                || props?.thisEpisode?.videos;
    if (!videos) return null;

    for (const lang of ['latino', 'spanish', 'english']) {
      const arr = videos[lang];
      if (!arr?.length) continue;
      for (const pref of PREFERRED_HOSTS) {
        const entry = arr.find(e => e.cyberlocker === pref && e.result?.startsWith('http'));
        if (entry) return entry.result;
      }
      const first = arr.find(e => e.result?.startsWith('http'));
      if (first) return first.result;
    }
  } catch {}
  return null;
}

// ── 2. Resolver PelisJuanita via movieInfo.php ───────────────────────────────
async function resolveJuanita(pageUrl) {
  const slug = pageUrl.trimEnd('/').split('/').pop();
  const html = await httpGet(
    `${JUANITA_BASE}/movies/movieInfo.php?title=${slug}`,
    `${JUANITA_BASE}/movies/pelicula/${slug}`
  );
  if (!html) return null;

  const servers = [];
  const re = /data-url='(https?:\/\/[^']+)'/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (!m[1].includes('youtube') && !m[1].includes('1fichier')) servers.push(m[1]);
  }
  return servers[0] || null;
}

// ── 3. Resolver cualquier player con Puppeteer (fallback universal) ───────────
async function resolveWithPuppeteer(playerUrl, timeoutMs = 25000) {
  const browser = await getBrowser();
  const page    = await browser.newPage();
  let m3u8 = null;

  try {
    await page.setUserAgent(SCRAPER_UA);
    await page.setRequestInterception(true);

    page.on('request', req => {
      const u = req.url();
      if (!m3u8 && u.includes('.m3u8')) m3u8 = u;
      req.continue().catch(() => {});
    });

    await page.goto(playerUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    // Esperar hasta encontrar m3u8 o timeout
    await Promise.race([
      new Promise(resolve => {
        const iv = setInterval(() => { if (m3u8) { clearInterval(iv); resolve(); } }, 200);
        setTimeout(() => { clearInterval(iv); resolve(); }, timeoutMs - 3000);
      }),
      // Intentar click en play
      page.waitForSelector('video', { timeout: 8000 })
        .then(async () => {
          await page.evaluate(() => {
            const v = document.querySelector('video');
            if (v) v.play().catch(() => {});
            const btn = document.querySelector('.jw-icon-playback,.vjs-big-play-button,[class*="play"]');
            if (btn) btn.click();
          });
        }).catch(() => {}),
    ]);

    // Último intento: leer video.src / video.currentSrc
    if (!m3u8) {
      m3u8 = await page.evaluate(() => {
        const v = document.querySelector('video');
        if (!v) return null;
        const src = v.src || v.currentSrc || '';
        return src.includes('.m3u8') ? src : null;
      });
    }
  } finally {
    await page.close().catch(() => {});
  }

  return m3u8;
}

// ── Punto de entrada principal ────────────────────────────────────────────────
async function resolveM3u8(sourceUrl) {
  // PoseidonHD → __NEXT_DATA__ (directo, sin Puppeteer)
  if (sourceUrl.includes('poseidonhd2.co')) {
    const url = await resolvePoseidon(sourceUrl);
    if (url) {
      // url es un player URL (streamwish, etc.) → resolver con Puppeteer
      if (url.includes('.m3u8')) return { ok: true, m3u8: url };
      const m3u8 = await resolveWithPuppeteer(url);
      if (m3u8) return { ok: true, m3u8 };
    }
    return { ok: false, error: 'PoseidonHD: no se encontró stream' };
  }

  // PelisJuanita → movieInfo.php
  if (sourceUrl.includes('pelisjuanita.com')) {
    const playerUrl = await resolveJuanita(sourceUrl);
    if (playerUrl) {
      if (playerUrl.includes('.m3u8')) return { ok: true, m3u8: playerUrl };
      const m3u8 = await resolveWithPuppeteer(playerUrl);
      if (m3u8) return { ok: true, m3u8 };
    }
    return { ok: false, error: 'JuanitaHD: no se encontró stream' };
  }

  // URL genérica → Puppeteer directo
  const m3u8 = await resolveWithPuppeteer(sourceUrl);
  if (m3u8) return { ok: true, m3u8 };

  return { ok: false, error: 'No se pudo resolver el stream' };
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
async function httpGet(url, referer = '') {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': SCRAPER_UA,
        'Referer': referer,
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'es-ES,es;q=0.9',
      },
      timeout: 12000,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

module.exports = { resolveM3u8, resolveWithPuppeteer, httpGet };
