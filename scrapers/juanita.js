const cheerio = require('cheerio');
const { httpGet } = require('../api/resolve');
const { upsertMany, updateWhere, getMissingField } = require('../db/firestore');

const BASE = 'https://pelisjuanita.com';

// ── Películas ─────────────────────────────────────────────────────────────────
async function scrapeJuanitaMovies(page = 1) {
  const url  = page === 1 ? `${BASE}/movies/apiPeliculas.php`
                           : `${BASE}/movies/apiPeliculas.php?page=${page}`;
  const html = await httpGet(url, BASE);
  if (!html) return 0;

  const $ = cheerio.load(html);
  const results = [];

  $('a.movie-card, article.movie, .movie-item a').each((_, el) => {
    const href  = $(el).attr('href') || '';
    const title = $(el).find('.title, .movie-title, h2, h3').first().text().trim()
                || $(el).attr('title') || '';
    if (!title || !href) return;

    const poster = $(el).find('img').attr('src') || $(el).find('img').attr('data-src') || '';
    const year   = $(el).find('.year, .fecha, .anio').first().text().trim().slice(0, 4) || '';
    const link   = href.startsWith('http') ? href : BASE + href;

    results.push({ titulo: title, anio: year, poster_url: poster, link, plataforma: 'PelisJuanita', genero: '', sinopsis: '' });
  });

  return results.length ? await upsertMany('peliculas', results) : 0;
}

// ── Series ────────────────────────────────────────────────────────────────────
async function scrapeJuanitaSeries(page = 1) {
  const url  = page === 1 ? `${BASE}/series/apiSeries.php`
                           : `${BASE}/series/apiSeries.php?page=${page}`;
  const html = await httpGet(url, BASE);
  if (!html) return 0;

  const $ = cheerio.load(html);
  const results = [];

  $('a.series-card, .serie-item a, article.serie a').each((_, el) => {
    const href  = $(el).attr('href') || '';
    const title = $(el).find('.title, .serie-title, h2, h3').first().text().trim()
                || $(el).attr('title') || '';
    if (!title || !href) return;

    const poster = $(el).find('img').attr('src') || $(el).find('img').attr('data-src') || '';
    const year   = $(el).find('.year, .fecha').first().text().trim().slice(0, 4) || '';
    const link   = href.startsWith('http') ? href : BASE + href;

    results.push({
      titulo: title, anio: year, poster_url: poster, link, plataforma: 'PelisJuanita',
      genero: '', sinopsis: '', episodios: {}, temporadas: 0, ultimo_episodio: 0,
    });
  });

  return results.length ? await upsertMany('series', results) : 0;
}

// ── Enriquecer serie con sinopsis + géneros + episodios ──────────────────────
async function enrichJuanitaSerie(titulo) {
  const html = await httpGet(
    `${BASE}/series/serieInfo.php?nombreSerie=${encodeURIComponent(titulo)}`,
    BASE
  );
  if (!html) return null;

  const $ = cheerio.load(html);

  // Sinopsis
  const sinopsis = $('[class*="sinopsis"]').first().text().trim()
                || $('meta[name="description"]').attr('content') || '';

  // Géneros
  const generos = [];
  $('[id="sGenero"] .badge, .badge-etiqueta, .genre').each((_, el) => {
    const g = $(el).text().trim();
    if (g && g.length > 1 && g.length < 40) generos.push(g);
  });

  // Poster
  const poster = $('img.poster, img.serie-poster').first().attr('src') || '';

  // Episodios
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
      maxTemp = Math.max(maxTemp, t);
      maxEp   = Math.max(maxEp, ep);
    }
  });

  Object.keys(episodios).forEach(t => { episodios[t].sort((a, b) => a.ep - b.ep); });

  return {
    sinopsis,
    genero:          generos.join(', '),
    poster_url:      poster || undefined,
    episodios:       Object.keys(episodios).length ? episodios : undefined,
    temporadas:      maxTemp || undefined,
    ultimo_episodio: maxEp || undefined,
  };
}

// ── Bulk enrichment de series Juanita ────────────────────────────────────────
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

// ── Enriquecer película Juanita ───────────────────────────────────────────────
async function enrichJuanitaMovie(titulo, link) {
  const html = await httpGet(link, BASE);
  if (!html) return null;

  const $ = cheerio.load(html);
  const sinopsis = $('[class*="sinopsis"], .description, .overview').first().text().trim()
                 || $('meta[name="description"]').attr('content') || '';
  const generos  = [];
  $('.genre, .badge, [class*="genero"]').each((_, el) => {
    const g = $(el).text().trim();
    if (g && g.length > 1 && g.length < 40) generos.push(g);
  });
  const poster = $('img.poster, .movie-poster img').first().attr('src') || '';

  return { sinopsis, genero: generos.join(', '), poster_url: poster || undefined };
}

module.exports = { scrapeJuanitaMovies, scrapeJuanitaSeries, enrichJuanitaSeries, enrichJuanitaMovie };
