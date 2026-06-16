const puppeteer = require('puppeteer');
const { httpGet } = require('../api/resolve');
const { upsertMany, updateWhere, getMissingField } = require('../db/firestore');

const BASE  = 'https://www.poseidonhd2.co';
const PREFS = ['streamwish', 'filemoon', 'vidhide', 'voesx'];

// ── Build ID ──────────────────────────────────────────────────────────────────
let _buildId = null, _buildTs = 0;
async function getBuildId() {
  if (_buildId && Date.now() - _buildTs < 3_600_000) return _buildId;
  const html = await httpGet(`${BASE}/es/peliculas`, BASE);
  const m = html?.match(/"buildId"\s*:\s*"([^"]+)"/);
  _buildId = m?.[1] || null;
  _buildTs = Date.now();
  return _buildId;
}

function extractNextData(html) {
  if (!html) return null;
  try {
    const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    return m ? JSON.parse(m[1]) : null;
  } catch { return null; }
}

// ── Extraer URL del embed desde el objeto videos ───────────────────────────────
function extractEmbedUrl(videos) {
  if (!videos) return null;
  for (const lang of ['latino', 'spanish', 'english']) {
    const arr = videos[lang];
    if (!arr?.length) continue;
    // Primero intentar servidores preferidos
    for (const pref of PREFS) {
      const e = arr.find(x => x.cyberlocker === pref && x.result?.startsWith('http'));
      if (e) return e.result;
    }
    // Cualquier servidor disponible
    const first = arr.find(x => x.result?.startsWith('http'));
    if (first) return first.result;
  }
  return null;
}

// ── Scraper de películas ──────────────────────────────────────────────────────
async function scrapePoseidonMovies(page = 1) {
  const buildId = await getBuildId();
  if (!buildId) throw new Error('No buildId');

  const raw = await httpGet(`${BASE}/_next/data/${buildId}/es/peliculas.json?page=${page}`, BASE);
  if (!raw) return 0;

  let data;
  try { data = JSON.parse(raw); } catch { return 0; }

  const movies = data?.pageProps?.movies || [];
  if (!movies.length) return 0;

  const results = [];
  for (const m of movies) {
    const sp = m.url?.slug?.split('/') || [];
    const id = sp[1] || m.TMDbId || '';
    const sl = sp[2] || '';
    if (!id) continue;

    const pageUrl  = `${BASE}/pelicula/${id}/${sl}`;
    const html     = await httpGet(pageUrl, BASE);
    const nd       = extractNextData(html);
    const movie    = nd?.props?.pageProps?.thisMovie;
    if (!movie) continue;

    // Extraer embed URL directamente durante el scraping
    const embedUrl = extractEmbedUrl(movie.videos);
    if (!embedUrl) continue; // Solo guardar si tiene stream disponible

    const year = (movie.releaseDate || m.releaseDate || '').substring(0, 4);
    results.push({
      titulo:           movie.titles?.name || m.titles?.name || '',
      anio:             year,
      genero:           (movie.genres || []).map(g => g.name).join(', '),
      sinopsis:         movie.overview || '',
      poster_url:       movie.images?.poster || '',
      link:             pageUrl,
      link_reproduccion: embedUrl,  // ← URL del embed directo
      plataforma:       'PoseidonHD',
    });
  }

  return results.length ? await upsertMany('peliculas', results) : 0;
}

// ── Scraper de series ─────────────────────────────────────────────────────────
async function scrapePoseidonSeries(page = 1) {
  const buildId = await getBuildId();
  if (!buildId) throw new Error('No buildId');

  const raw = await httpGet(`${BASE}/_next/data/${buildId}/es/series.json?page=${page}`, BASE);
  if (!raw) return 0;

  let data;
  try { data = JSON.parse(raw); } catch { return 0; }

  const series = data?.pageProps?.tvshows || [];
  if (!series.length) return 0;

  const results = [];
  for (const s of series) {
    const sp = s.url?.slug?.split('/') || [];
    const id = sp[1] || s.TMDbId || '';
    const sl = sp[2] || '';
    if (!id) continue;

    const pageUrl = `${BASE}/serie/${id}/${sl}`;
    const html    = await httpGet(pageUrl, BASE);
    const nd      = extractNextData(html);
    const tvshow  = nd?.props?.pageProps?.thisTvshow;
    if (!tvshow) continue;

    // Para series: extraer embed del primer episodio disponible
    const embedUrl = extractEmbedUrl(tvshow.videos) || '';

    const year = (tvshow.releaseDate || s.releaseDate || '').substring(0, 4);

    // Extraer episodios si hay info de temporadas
    const episodios = {};
    let maxTemp = 0, maxEp = 0;
    if (tvshow.seasons && Array.isArray(tvshow.seasons)) {
      for (const season of tvshow.seasons) {
        const t   = season.season_number || season.number || 1;
        const cnt = season.episode_count || season.episodesCount || 0;
        if (!t || !cnt) continue;
        episodios[t] = [];
        for (let ep = 1; ep <= cnt; ep++) {
          episodios[t].push({
            ep,
            titulo: `Episodio ${ep}`,
            link: `${pageUrl}/${t}x${String(ep).padStart(2,'0')}`,
          });
          maxEp = Math.max(maxEp, ep);
        }
        maxTemp = Math.max(maxTemp, t);
      }
    }
    // Si no hay seasons, al menos T1E1
    if (!maxTemp) {
      episodios[1] = [{ ep: 1, titulo: 'Episodio 1', link: `${pageUrl}/1x01` }];
      maxTemp = 1; maxEp = 1;
    }

    results.push({
      titulo:           tvshow.titles?.name || s.titles?.name || '',
      anio:             year,
      genero:           (tvshow.genres || []).map(g => g.name).join(', '),
      sinopsis:         tvshow.overview || '',
      poster_url:       tvshow.images?.poster || '',
      link:             pageUrl,
      link_reproduccion: embedUrl,
      plataforma:       'PoseidonHD',
      episodios,
      temporadas:       maxTemp,
      ultimo_episodio:  maxEp,
    });
  }

  return results.length ? await upsertMany('series', results) : 0;
}

// ── Poblar episodios con Puppeteer (para series ya guardadas sin episodios) ───
async function populatePoseidonEpisodes(limit = 3) {
  const docs = await getMissingField('series', 'ultimo_episodio', 'PoseidonHD', limit * 2);
  const pending = docs.filter(d => !d.ultimo_episodio || d.ultimo_episodio <= 0).slice(0, limit);
  if (!pending.length) return 0;

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  let count = 0;
  try {
    for (const serie of pending) {
      if (!serie.link) { await updateWhere('series', 'titulo', serie.titulo, { ultimo_episodio: -1 }); continue; }
      const page = await browser.newPage();
      try {
        await page.goto(serie.link, { waitUntil: 'networkidle2', timeout: 30000 });
        const rawLinks = await page.evaluate((base) =>
          Array.from(document.querySelectorAll('a[href]'))
            .map(a => a.href)
            .filter(h => h.includes(base) && /\/\d+x\d+/.test(h))
        , BASE);

        const episodios = {};
        let maxTemp = 0, maxEp = 0;
        const seen = new Set();
        for (const url of rawLinks) {
          const m = url.match(/\/(\d+)x(\d+)/);
          if (!m) continue;
          const t = parseInt(m[1]), ep = parseInt(m[2]);
          const key = `${t}x${ep}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (!episodios[t]) episodios[t] = [];
          episodios[t].push({ ep, titulo: `Episodio ${ep}`, link: url });
          maxTemp = Math.max(maxTemp, t);
          maxEp   = Math.max(maxEp, ep);
        }
        if (!maxTemp) {
          episodios[1] = [{ ep: 1, titulo: 'Episodio 1', link: `${serie.link}/1x01` }];
          maxTemp = 1; maxEp = 1;
        }
        Object.keys(episodios).forEach(t => { episodios[t].sort((a, b) => a.ep - b.ep); });
        await updateWhere('series', 'titulo', serie.titulo, { episodios, temporadas: maxTemp, ultimo_episodio: maxEp });
        count++;
      } catch (e) {
        await updateWhere('series', 'titulo', serie.titulo, { ultimo_episodio: -1 });
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return count;
}

module.exports = { scrapePoseidonMovies, scrapePoseidonSeries, populatePoseidonEpisodes };
