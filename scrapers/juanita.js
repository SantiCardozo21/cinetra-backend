const cheerio = require('cheerio');
const fetch   = require('node-fetch');
const { httpGet } = require('../api/resolve');
const { upsertMany, updateWhere, getMissingField } = require('../db/firestore');

const BASE = 'https://pelisjuanita.com';
const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

// ── Extraer embed URL de movieInfo.php ────────────────────────────────────────
async function getEmbedUrl(slug, referer) {
  const html = await httpGet(
    `${BASE}/movies/movieInfo.php?title=${encodeURIComponent(slug)}`,
    referer || BASE
  );
  if (!html) return null;
  const re = /data-url=['"]?(https?:\/\/[^'">\s]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const u = m[1];
    if (!u.includes('youtube') && !u.includes('1fichier') && u.startsWith('http')) return u;
  }
  return null;
}

// ── Películas — la API devuelve JSON ─────────────────────────────────────────
async function scrapeJuanitaMovies(page = 1) {
  const url = page === 1
    ? `${BASE}/movies/apiPeliculas.php`
    : `${BASE}/movies/apiPeliculas.php?page=${page}`;

  let data;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': BASE }, timeout: 15000 });
    if (!res.ok) return 0;
    data = await res.json();
  } catch { return 0; }

  if (!Array.isArray(data) || !data.length) return 0;

  const results = [];
  for (const item of data) {
    const titulo = item.titulo || item.title || item.nombre || '';
    const slug   = item.slug || item.url || (item.link || '').split('/').pop() || '';
    if (!titulo || !slug) continue;

    const link   = `${BASE}/movies/pelicula/${slug}`;
    const poster = item.poster || item.imagen || item.image || '';

    // Obtener embed URL directamente durante el scraping
    const embedUrl = await getEmbedUrl(slug, link);
    if (!embedUrl) continue;

    results.push({
      titulo,
      anio:              String(item.anio || item.year || ''),
      poster_url:        poster.startsWith('http') ? poster : poster ? BASE + poster : '',
      genero:            item.genero || item.genre || '',
      sinopsis:          item.sinopsis || item.descripcion || '',
      link,
      link_reproduccion: embedUrl,
      plataforma:        'PelisJuanita',
    });

    await new Promise(r => setTimeout(r, 250));
  }

  return results.length ? await upsertMany('peliculas', results) : 0;
}

// ── Series — la API también devuelve JSON ─────────────────────────────────────
async function scrapeJuanitaSeries(page = 1) {
  const url = page === 1
    ? `${BASE}/series/apiSeries.php`
    : `${BASE}/series/apiSeries.php?page=${page}`;

  let data;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': BASE }, timeout: 15000 });
    if (!res.ok) return 0;
    const text = await res.text();
    // La API puede devolver JSON o HTML dependiendo del endpoint
    data = JSON.parse(text);
  } catch {
    // Fallback HTML
    return scrapeJuanitaSeriesHTML(url);
  }

  if (!Array.isArray(data) || !data.length) return 0;

  const results = data.map(item => ({
    titulo:          item.titulo || item.title || item.nombre || '',
    anio:            String(item.anio || item.year || ''),
    poster_url:      item.poster || item.imagen || '',
    genero:          item.genero || item.genre || '',
    sinopsis:        item.sinopsis || '',
    link:            `${BASE}/series/serie/${item.slug || item.url || ''}`,
    plataforma:      'PelisJuanita',
    episodios:       {},
    temporadas:      0,
    ultimo_episodio: 0,
  })).filter(s => s.titulo);

  return results.length ? await upsertMany('series', results) : 0;
}

// ── Fallback HTML para series ─────────────────────────────────────────────────
async function scrapeJuanitaSeriesHTML(url) {
  const html = await httpGet(url, BASE);
  if (!html) return 0;
  const $ = cheerio.load(html);
  const results = [];

  // Buscar cualquier card/link con imagen y título
  $('a[href*="/serie"]').each((_, el) => {
    const href  = $(el).attr('href') || '';
    const title = $(el).find('h2, h3, .title, .nombre').first().text().trim()
                || $(el).attr('title') || '';
    if (!title) return;
    const poster = $(el).find('img').attr('src') || $(el).find('img').attr('data-src') || '';
    const link   = href.startsWith('http') ? href : BASE + href;
    results.push({ titulo: title, poster_url: poster, link, plataforma: 'PelisJuanita', genero: '', sinopsis: '', episodios: {}, temporadas: 0, ultimo_episodio: 0 });
  });

  return results.length ? await upsertMany('series', results) : 0;
}

// ── Enriquecer series Juanita (sinopsis + géneros + episodios) ─────────────────
async function enrichJuanitaSerie(titulo) {
  const html = await httpGet(`${BASE}/series/serieInfo.php?nombreSerie=${encodeURIComponent(titulo)}`, BASE);
  if (!html) return null;
  const $ = cheerio.load(html);

  const sinopsis = $('[class*="sinopsis"]').first().text().trim()
                || $('meta[name="description"]').attr('content') || '';
  const generos = [];
  $('[id="sGenero"] .badge, .badge-etiqueta, .genre, .genero').each((_, el) => {
    const g = $(el).text().trim();
    if (g && g.length > 1 && g.length < 40) generos.push(g);
  });
  const poster = $('img.poster, img.serie-poster, .cover img').first().attr('src') || '';

  const episodios = {};
  let maxTemp = 0, maxEp = 0;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m    = href.match(/temporada[_\-]?(\d+).*?capitulo[_\-]?(\d+)|(\d+)x(\d+)/i);
    if (!m) return;
    const t = parseInt(m[1] || m[3]), ep = parseInt(m[2] || m[4]);
    if (!t || !ep) return;
    if (!episodios[t]) episodios[t] = [];
    const link = href.startsWith('http') ? href : BASE + href;
    if (!episodios[t].find(e => e.ep === ep)) {
      episodios[t].push({ ep, titulo: $(el).text().trim() || `Episodio ${ep}`, link });
      maxTemp = Math.max(maxTemp, t);
      maxEp   = Math.max(maxEp, ep);
    }
  });
  Object.keys(episodios).forEach(t => episodios[t].sort((a, b) => a.ep - b.ep));

  return {
    sinopsis,
    genero:          generos.join(', '),
    poster_url:      poster || undefined,
    episodios:       Object.keys(episodios).length ? episodios : undefined,
    temporadas:      maxTemp || undefined,
    ultimo_episodio: maxEp || undefined,
  };
}

async function enrichJuanitaSeries(limit = 5) {
  const db   = require('../firebase/admin').getDb();
  const snap = await db.collection('series').where('plataforma','==','PelisJuanita').where('ultimo_episodio','==',0).limit(limit).get();
  const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  let count  = 0;
  for (const doc of docs) {
    const data = await enrichJuanitaSerie(doc.titulo);
    if (!data) { await updateWhere('series','titulo',doc.titulo,{ultimo_episodio:-1}); continue; }
    await updateWhere('series','titulo',doc.titulo,data);
    count++;
    await new Promise(r => setTimeout(r, 400));
  }
  return count;
}

module.exports = { scrapeJuanitaMovies, scrapeJuanitaSeries, enrichJuanitaSeries };
