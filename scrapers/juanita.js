const cheerio = require('cheerio');
const { httpGet } = require('../api/resolve');
const { upsertMany, updateWhere, getMissingField } = require('../db/firestore');

const BASE = 'https://pelisjuanita.com';

// ── Extraer embed URL de movieInfo.php ────────────────────────────────────────
async function getJuanitaEmbedUrl(slug, referer) {
  const html = await httpGet(`${BASE}/movies/movieInfo.php?title=${encodeURIComponent(slug)}`, referer || BASE);
  if (!html) return null;
  const re = /data-url=['"]?(https?:\/\/[^'">\s]+)/g;
  let m;
  const servers = [];
  while ((m = re.exec(html)) !== null) {
    const u = m[1];
    if (!u.includes('youtube') && !u.includes('1fichier') && !u.includes('openload')) servers.push(u);
  }
  return servers[0] || null;
}

// ── Scraper de películas ──────────────────────────────────────────────────────
async function scrapeJuanitaMovies(page = 1) {
  const url  = page === 1 ? `${BASE}/movies/apiPeliculas.php` : `${BASE}/movies/apiPeliculas.php?page=${page}`;
  const html = await httpGet(url, BASE);
  if (!html) return 0;

  const $ = cheerio.load(html);
  const results = [];

  // Recopilar info de cards
  const items = [];
  $('a[href]').each((_, el) => {
    const href  = $(el).attr('href') || '';
    const title = $(el).find('.title, h2, h3').first().text().trim() || $(el).attr('title') || '';
    if (!title || !href.includes('/pelicula/')) return;
    const poster = $(el).find('img').attr('src') || $(el).find('img').attr('data-src') || '';
    const year   = $(el).find('.year, .fecha, .anio').first().text().trim().slice(0, 4) || '';
    const link   = href.startsWith('http') ? href : BASE + href;
    const slug   = link.split('/').pop();
    if (slug) items.push({ titulo: title, anio: year, poster_url: poster, link, slug });
  });

  // Para cada película obtener embed URL
  for (const item of items) {
    const embedUrl = await getJuanitaEmbedUrl(item.slug, item.link);
    if (!embedUrl) continue; // Solo guardar si tiene stream

    results.push({
      titulo:           item.titulo,
      anio:             item.anio,
      poster_url:       item.poster_url,
      link:             item.link,
      link_reproduccion: embedUrl,  // ← URL directa del embed
      plataforma:       'PelisJuanita',
      genero:           '',
      sinopsis:         '',
    });
    await new Promise(r => setTimeout(r, 300)); // Rate limiting
  }

  return results.length ? await upsertMany('peliculas', results) : 0;
}

// ── Scraper de series ─────────────────────────────────────────────────────────
async function scrapeJuanitaSeries(page = 1) {
  const url  = page === 1 ? `${BASE}/series/apiSeries.php` : `${BASE}/series/apiSeries.php?page=${page}`;
  const html = await httpGet(url, BASE);
  if (!html) return 0;

  const $ = cheerio.load(html);
  const results = [];

  $('a[href]').each((_, el) => {
    const href  = $(el).attr('href') || '';
    const title = $(el).find('.title, h2, h3').first().text().trim() || $(el).attr('title') || '';
    if (!title || !href.includes('/serie')) return;
    const poster = $(el).find('img').attr('src') || '';
    const link   = href.startsWith('http') ? href : BASE + href;
    results.push({ titulo: title, poster_url: poster, link, plataforma: 'PelisJuanita', genero: '', sinopsis: '', episodios: {}, temporadas: 0, ultimo_episodio: 0 });
  });

  return results.length ? await upsertMany('series', results) : 0;
}

// ── Enriquecer serie con sinopsis + géneros + episodios ──────────────────────
async function enrichJuanitaSerie(titulo) {
  const html = await httpGet(`${BASE}/series/serieInfo.php?nombreSerie=${encodeURIComponent(titulo)}`, BASE);
  if (!html) return null;

  const $ = cheerio.load(html);
  const sinopsis = $('[class*="sinopsis"]').first().text().trim() || $('meta[name="description"]').attr('content') || '';
  const generos  = [];
  $('[id="sGenero"] .badge, .badge-etiqueta, .genre').each((_, el) => {
    const g = $(el).text().trim();
    if (g && g.length > 1 && g.length < 40) generos.push(g);
  });
  const poster = $('img.poster, img.serie-poster').first().attr('src') || '';

  const episodios = {};
  let maxTemp = 0, maxEp = 0;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m    = href.match(/temporada[_-]?(\d+).*?capitulo[_-]?(\d+)|(\d+)x(\d+)/i);
    if (!m) return;
    const t  = parseInt(m[1] || m[3]);
    const ep = parseInt(m[2] || m[4]);
    if (!t || !ep) return;
    if (!episodios[t]) episodios[t] = [];
    const link = href.startsWith('http') ? href : BASE + href;
    if (!episodios[t].find(e => e.ep === ep)) {
      episodios[t].push({ ep, titulo: $(el).text().trim() || `Episodio ${ep}`, link });
      maxTemp = Math.max(maxTemp, t); maxEp = Math.max(maxEp, ep);
    }
  });
  Object.keys(episodios).forEach(t => { episodios[t].sort((a, b) => a.ep - b.ep); });

  return { sinopsis, genero: generos.join(', '), poster_url: poster || undefined, episodios: Object.keys(episodios).length ? episodios : undefined, temporadas: maxTemp || undefined, ultimo_episodio: maxEp || undefined };
}

async function enrichJuanitaSeries(limit = 5) {
  const docs = await getMissingField('series', 'sinopsis', 'PelisJuanita', limit);
  let count  = 0;
  for (const doc of docs.slice(0, limit)) {
    const data = await enrichJuanitaSerie(doc.titulo);
    if (!data) continue;
    await updateWhere('series', 'titulo', doc.titulo, data);
    count++;
  }
  return count;
}

module.exports = { scrapeJuanitaMovies, scrapeJuanitaSeries, enrichJuanitaSeries };
