const { httpGet } = require('../api/resolve');
const { upsertMany, updateWhere } = require('../db/firestore');

const BASE = 'https://pelisjuanita.com';

// ── Películas ─────────────────────────────────────────────────────────────────
async function scrapeJuanitaMovies(page = 1) {
  const html = await httpGet(
    `${BASE}/movies/movies.php?populares=1&page=${page}`, BASE
  );
  if (!html) return 0;

  const seen = new Set();
  const results = [];

  for (const m of html.matchAll(/href=['"]\s*\/movies\/pelicula\/([^'"\/\s]+)\s*['"]/g)) {
    const slug = m[1].trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);

    const pos   = html.indexOf(m[0]);
    const block = html.substring(pos, pos + 600);
    const poster = (block.match(/src=['"]\s*(https:\/\/image\.tmdb\.org[^'"]+)\s*['"]/) || [])[1] || '';
    const titulo = ((block.match(/alt=['"]([^'"]+)['"]/) || [])[1]
                 || (block.match(/<h2[^>]*>([^<]+)<\/h2>/) || [])[1]
                 || slug.replace(/-/g, ' ')).trim();
    const anio   = ((block.match(/class=['"][\s]*right[\s]*['"]>\s*(\d{4})/) || [])[1]) || '';

    if (!titulo || titulo.length < 2) continue;
    results.push({
      titulo,
      anio,
      poster_url:       poster.trim(),
      genero:           '',
      sinopsis:         '',
      link:             `${BASE}/movies/pelicula/${slug}`,
      link_reproduccion: '',     // ← se resuelve on-demand en Railway
      plataforma:       'PelisJuanita',
    });
  }

  return results.length ? await upsertMany('peliculas', results) : 0;
}

// ── Series ────────────────────────────────────────────────────────────────────
async function scrapeJuanitaSeries(page = 1) {
  const url  = page === 1
    ? `${BASE}/series/apiSeries.php`
    : `${BASE}/series/apiSeries.php?page=${page}`;
  const html = await httpGet(url, BASE);
  if (!html) return 0;

  const seen = new Set();
  const results = [];

  for (const m of html.matchAll(/href=['"]\s*ver-serie\/([^'"\/\s\-][^'"\/\s]*)\s*['"]/g)) {
    const slug = m[1].trim();
    if (!slug || /^\d+$/.test(slug) || seen.has(slug)) continue;
    seen.add(slug);

    const pos   = html.indexOf(m[0]);
    const block = html.substring(pos, pos + 600);
    const poster = (block.match(/src=['"]\s*(https:\/\/image\.tmdb\.org[^'"]+)\s*['"]/) || [])[1] || '';
    const titulo = ((block.match(/alt=['"]([^'"]+)['"]/) || [])[1]
                 || (block.match(/<h2[^>]*>([^<]+)<\/h2>/) || [])[1]
                 || slug.replace(/-/g, ' ')).trim();
    const anio   = ((block.match(/class=['"][\s]*right[\s]*['"]>\s*(\d{4})/) || [])[1]) || '';

    if (!titulo || titulo.length < 2) continue;
    results.push({
      titulo,
      anio,
      poster_url:      poster.trim(),
      genero:          '',
      sinopsis:        '',
      link:            `${BASE}/series/ver-serie/${slug}`,
      plataforma:      'PelisJuanita',
      episodios:       { 1: [{ ep: 1, titulo: 'Episodio 1', link: `${BASE}/series/ver-serie/${slug}/01x01` }] },
      temporadas:      1,
      ultimo_episodio: 1,
    });
  }

  return results.length ? await upsertMany('series', results) : 0;
}

// ── Enriquecer series (episodios reales) ──────────────────────────────────────
async function enrichJuanitaSeries(limit = 5) {
  const db   = require('../firebase/admin').getDb();
  const snap = await db.collection('series')
    .where('plataforma', '==', 'PelisJuanita')
    .where('ultimo_episodio', '==', 1)
    .limit(limit).get();

  let count = 0;
  for (const doc of snap.docs) {
    const titulo = doc.data().titulo;
    const html   = await httpGet(
      `${BASE}/series/serieInfo.php?nombreSerie=${encodeURIComponent(titulo)}`, BASE
    );
    if (!html) { await updateWhere('series', 'titulo', titulo, { ultimo_episodio: -1 }); continue; }

    const episodios = {};
    let maxTemp = 1, maxEp = 1;

    for (const m of html.matchAll(/href=['"]\/series\/ver-serie\/([^'"]+)\/(\d+)x(\d+)['"]/g)) {
      const t = parseInt(m[2]), ep = parseInt(m[3]);
      if (!episodios[t]) episodios[t] = [];
      const link = `${BASE}/series/ver-serie/${m[1]}/${m[2]}x${m[3]}`;
      if (!episodios[t].find(e => e.ep === ep)) {
        episodios[t].push({ ep, titulo: `Episodio ${ep}`, link });
        maxTemp = Math.max(maxTemp, t);
        maxEp   = Math.max(maxEp, ep);
      }
    }

    if (!Object.keys(episodios).length) {
      await updateWhere('series', 'titulo', titulo, { ultimo_episodio: -1 });
      continue;
    }

    Object.keys(episodios).forEach(t => episodios[t].sort((a, b) => a.ep - b.ep));
    const poster = (html.match(/src=['"]\s*(https:\/\/image\.tmdb\.org[^'"]+)\s*['"]/) || [])[1] || '';
    const anio   = (html.match(/\b(19|20)\d{2}\b/) || [])[0] || '';

    await updateWhere('series', 'titulo', titulo, {
      episodios, temporadas: maxTemp, ultimo_episodio: maxEp,
      ...(poster ? { poster_url: poster } : {}),
      ...(anio ? { anio } : {}),
    });
    count++;
    await new Promise(r => setTimeout(r, 300));
  }
  return count;
}

module.exports = { scrapeJuanitaMovies, scrapeJuanitaSeries, enrichJuanitaSeries };
