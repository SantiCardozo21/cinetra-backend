const puppeteer = require('puppeteer');
const { httpGet } = require('../api/resolve');
const { upsertMany, updateWhere, getMissingField } = require('../db/firestore');

const BASE = 'https://www.poseidonhd2.co';
const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

// ── Build ID ──────────────────────────────────────────────────────────────────
let _buildId = null;
let _buildTs = 0;
async function getBuildId() {
  if (_buildId && Date.now() - _buildTs < 3_600_000) return _buildId;
  const html = await httpGet(`${BASE}/es/peliculas`, BASE);
  if (!html) return null;
  const m = html.match(/"buildId"\s*:\s*"([^"]+)"/);
  _buildId = m?.[1] || null;
  _buildTs = Date.now();
  return _buildId;
}

// ── Extraer __NEXT_DATA__ ─────────────────────────────────────────────────────
function extractNextData(html) {
  if (!html) return null;
  try {
    const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    return m ? JSON.parse(m[1]) : null;
  } catch { return null; }
}

// ── ¿Tiene stream HD? ─────────────────────────────────────────────────────────
function isHD(videos) {
  return Object.values(videos || {}).some(arr =>
    Array.isArray(arr) && arr.some(e => e.result?.startsWith('http'))
  );
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

    const html    = await httpGet(`${BASE}/pelicula/${id}/${sl}`, BASE);
    const nd      = extractNextData(html);
    const movie   = nd?.props?.pageProps?.thisMovie;
    if (!movie || !isHD(movie.videos)) continue;

    const year = (movie.releaseDate || m.releaseDate || '').substring(0, 4);
    results.push({
      titulo:     movie.titles?.name || m.titles?.name || '',
      anio:       year,
      genero:     (movie.genres || m.genres || []).map(g => g.name).join(', '),
      sinopsis:   movie.overview || m.overview || '',
      poster_url: movie.images?.poster || m.images?.poster || '',
      link:       `${BASE}/pelicula/${id}/${sl}`,
      plataforma: 'PoseidonHD',
    });
  }

  return results.length ? await upsertMany('peliculas', results) : 0;
}

// ── Scraper de series (páginas del listado) ───────────────────────────────────
async function scrapePoseidonSeries(page = 1) {
  const buildId = await getBuildId();
  if (!buildId) throw new Error('No buildId');

  const raw = await httpGet(`${BASE}/_next/data/${buildId}/es/series.json?page=${page}`, BASE);
  if (!raw) return 0;

  let data;
  try { data = JSON.parse(raw); } catch { return 0; }

  const series = data?.pageProps?.tvshows || data?.pageProps?.series || [];
  if (!series.length) return 0;

  const results = [];
  for (const s of series) {
    const sp = s.url?.slug?.split('/') || [];
    const id = sp[1] || s.TMDbId || '';
    const sl = sp[2] || '';
    if (!id) continue;

    const html  = await httpGet(`${BASE}/serie/${id}/${sl}`, BASE);
    const nd    = extractNextData(html);
    const tvsh  = nd?.props?.pageProps?.thisTvshow;
    if (!tvsh || !isHD(tvsh.videos)) continue;

    const year = (tvsh.releaseDate || s.releaseDate || '').substring(0, 4);
    results.push({
      titulo:          tvsh.titles?.name || s.titles?.name || '',
      anio:            year,
      genero:          (tvsh.genres || s.genres || []).map(g => g.name).join(', '),
      sinopsis:        tvsh.overview || s.overview || '',
      poster_url:      tvsh.images?.poster || s.images?.poster || '',
      link:            `${BASE}/serie/${id}/${sl}`,
      plataforma:      'PoseidonHD',
      episodios:       {},
      temporadas:      0,
      ultimo_episodio: 0,
    });
  }

  return results.length ? await upsertMany('series', results) : 0;
}

// ── Poblar episodios de una serie con Puppeteer ───────────────────────────────
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
        await page.setUserAgent(UA);
        await page.goto(serie.link, { waitUntil: 'networkidle2', timeout: 30000 });

        // Extraer links de episodios del DOM
        const rawLinks = await page.evaluate((base) => {
          return Array.from(document.querySelectorAll('a[href]'))
            .map(a => a.href)
            .filter(h => h.includes(base) && /\/\d+x\d+/.test(h));
        }, BASE);

        const episodios = {};
        let maxTemp = 0, maxEp = 0;
        const seen = new Set();
        for (const url of rawLinks) {
          const m = url.match(/\/(\d+)x(\d+)/);
          if (!m) continue;
          const [, t, ep] = [, parseInt(m[1]), parseInt(m[2])];
          const key = `${t}x${ep}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (!episodios[t]) episodios[t] = [];
          episodios[t].push({ ep, titulo: `Episodio ${ep}`, link: url });
          maxTemp = Math.max(maxTemp, t);
          maxEp   = Math.max(maxEp, ep);
        }

        // Fallback: usar __NEXT_DATA__ para seasons si no hay links
        if (!maxTemp) {
          const nd = await page.evaluate(() => {
            try {
              const sc = document.getElementById('__NEXT_DATA__');
              return sc ? JSON.parse(sc.textContent) : null;
            } catch { return null; }
          });
          const tvsh = nd?.props?.pageProps?.thisTvshow;
          if (tvsh?.seasons) {
            for (const s of tvsh.seasons) {
              const t = s.season_number || s.number || 1;
              const cnt = s.episode_count || s.episodesCount || 0;
              if (!cnt) continue;
              episodios[t] = [];
              for (let e = 1; e <= cnt; e++) {
                episodios[t].push({
                  ep: e,
                  titulo: `Episodio ${e}`,
                  link: `${serie.link}/${t}x${String(e).padStart(2,'0')}`,
                });
                maxEp = Math.max(maxEp, e);
              }
              maxTemp = Math.max(maxTemp, t);
            }
          }
        }

        if (!maxTemp) {
          // Mínimo: T1E1
          episodios[1] = [{ ep: 1, titulo: 'Episodio 1', link: `${serie.link}/1x01` }];
          maxTemp = 1; maxEp = 1;
        }

        // Ordenar episodios
        Object.keys(episodios).forEach(t => { episodios[t].sort((a, b) => a.ep - b.ep); });

        await updateWhere('series', 'titulo', serie.titulo, {
          episodios, temporadas: maxTemp, ultimo_episodio: maxEp,
        });
        count++;
      } catch (e) {
        console.error(`[Poseidon episodes] Error en ${serie.titulo}: ${e.message}`);
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
