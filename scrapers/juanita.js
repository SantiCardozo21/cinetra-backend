const fetch   = require('node-fetch');
const { httpGet } = require('../api/resolve');
const { upsertMany, updateWhere } = require('../db/firestore');

const BASE = 'https://pelisjuanita.com';
const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

// ── Extraer embed URL de movieInfo.php ────────────────────────────────────────
async function getEmbedUrl(slug) {
  const html = await httpGet(`${BASE}/movies/movieInfo.php?title=${encodeURIComponent(slug)}`, `${BASE}/movies/pelicula/${slug}`);
  if (!html) return null;
  const re = /data-url=['"]?(https?:\/\/[^'">\s]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const u = m[1];
    if (!u.includes('youtube') && !u.includes('1fichier') && u.startsWith('http')) return u;
  }
  return null;
}

// ── Películas — endpoint correcto: movies.php?populares=1&page=X ──────────────
async function scrapeJuanitaMovies(page = 1) {
  const url  = `${BASE}/movies/movies.php?populares=1&page=${page}`;
  const html = await httpGet(url, BASE);
  if (!html) return 0;

  const seen    = new Set();
  const results = [];

  // Extraer slugs de links /movies/pelicula/{slug}
  const allLinks = [...html.matchAll(/href=['"]\s*\/movies\/pelicula\/([^'"\/\s]+)\s*['"]/g)];
  for (const linkMatch of allLinks) {
    const slug = linkMatch[1].trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);

    const linkPos = html.indexOf(linkMatch[0]);
    const block   = html.substring(linkPos, Math.min(html.length, linkPos + 600));

    const posterMatch = block.match(/src=['"]\s*(https:\/\/image\.tmdb\.org[^'"]+\.(?:jpg|png|webp))\s*['"]/);
    const altMatch    = block.match(/alt=['"]([^'"]+)['"]/);
    const yearMatch   = block.match(/class=['"][\s]*right[\s]*['"]>\s*(\d{4})/);
    const h2Match     = block.match(/<h2[^>]*>([^<]+)<\/h2>/);
    const titulo      = (altMatch?.[1] || h2Match?.[1] || slug.replace(/-/g, ' ')).trim();
    if (!titulo || titulo.length < 2) continue;

    const link = `${BASE}/movies/pelicula/${slug}`;

    // Obtener embed URL
    const embedUrl = await getEmbedUrl(slug);
    if (!embedUrl) continue; // Solo guardar películas con stream disponible

    results.push({
      titulo,
      anio:              yearMatch?.[1] || '',
      genero:            '',
      sinopsis:          '',
      poster_url:        posterMatch?.[1]?.trim() || '',
      link,
      link_reproduccion: embedUrl,
      plataforma:        'PelisJuanita',
    });

    await new Promise(r => setTimeout(r, 250));
  }

  return results.length ? await upsertMany('peliculas', results) : 0;
}

// ── Series — endpoint: apiSeries.php (devuelve HTML) ─────────────────────────
async function scrapeJuanitaSeries(page = 1) {
  const url  = page === 1 ? `${BASE}/series/apiSeries.php` : `${BASE}/series/apiSeries.php?page=${page}`;
  const html = await httpGet(url, BASE);
  if (!html) return 0;

  const seen    = new Set();
  const results = [];

  // Extraer slugs de links ver-serie/{slug}
  const allLinks = [...html.matchAll(/href=['"]\s*ver-serie\/([^'"\/\s\-][^'"\/\s]*)\s*['"]/g)];
  for (const linkMatch of allLinks) {
    const slug = linkMatch[1].trim();
    if (!slug || slug.startsWith('-') || /^\d+$/.test(slug) || seen.has(slug)) continue;
    seen.add(slug);

    const linkPos = html.indexOf(linkMatch[0]);
    const block   = html.substring(linkPos, Math.min(html.length, linkPos + 600));

    const posterMatch = block.match(/src=['"]\s*(https:\/\/image\.tmdb\.org[^'"]+\.(?:jpg|png|webp))\s*['"]/);
    const altMatch    = block.match(/alt=['"]([^'"]+)['"]/);
    const yearMatch   = block.match(/class=['"][\s]*right[\s]*['"]>\s*(\d{4})/);
    const h2Match     = block.match(/<h2[^>]*>([^<]+)<\/h2>/);
    const titulo      = (altMatch?.[1] || h2Match?.[1] || slug.replace(/-/g, ' ')).trim();
    if (!titulo || titulo.length < 2) continue;

    results.push({
      titulo,
      anio:            yearMatch?.[1] || '',
      genero:          '',
      sinopsis:        '',
      poster_url:      posterMatch?.[1]?.trim() || '',
      link:            `${BASE}/series/ver-serie/${slug}`,
      plataforma:      'PelisJuanita',
      episodios:       { 1: [{ ep: 1, titulo: 'Episodio 1', link: `${BASE}/series/ver-serie/${slug}/01x01` }] },
      temporadas:      1,
      ultimo_episodio: 1,
    });
  }

  return results.length ? await upsertMany('series', results) : 0;
}

// ── Enriquecer series con episodios reales ─────────────────────────────────────
async function enrichJuanitaSeries(limit = 5) {
  const db   = require('../firebase/admin').getDb();
  const snap = await db.collection('series')
    .where('plataforma', '==', 'PelisJuanita')
    .where('ultimo_episodio', '==', 1)
    .limit(limit).get();

  let count = 0;
  for (const doc of snap.docs) {
    const serie = { id: doc.id, ...doc.data() };
    const html  = await httpGet(
      `${BASE}/series/serieInfo.php?nombreSerie=${encodeURIComponent(serie.titulo)}`, BASE
    );
    if (!html) { await updateWhere('series', 'titulo', serie.titulo, { ultimo_episodio: -1 }); continue; }

    const episodios = {};
    let maxTemp = 1, maxEp = 1;
    const epRegex = /href=['"]\/series\/ver-serie\/([^'"]+)\/(\d+)x(\d+)['"]/g;
    let match;
    while ((match = epRegex.exec(html)) !== null) {
      const temp = parseInt(match[2]), ep = parseInt(match[3]);
      if (!episodios[temp]) episodios[temp] = [];
      const epUrl = `${BASE}/series/ver-serie/${match[1]}/${match[2]}x${match[3]}`;
      if (!episodios[temp].find(e => e.ep === ep)) {
        episodios[temp].push({ ep, titulo: `Episodio ${ep}`, link: epUrl });
        maxTemp = Math.max(maxTemp, temp);
        maxEp   = Math.max(maxEp, ep);
      }
    }
    Object.keys(episodios).forEach(t => { episodios[t].sort((a, b) => a.ep - b.ep); });

    if (!Object.keys(episodios).length) {
      await updateWhere('series', 'titulo', serie.titulo, { ultimo_episodio: -1 });
      continue;
    }

    const posterMatch = html.match(/src=['"]\s*(https:\/\/image\.tmdb\.org[^'"]+\.(?:jpg|png|webp))\s*['"]/);
    const yearMatch   = html.match(/\b(19|20)\d{2}\b/);

    await updateWhere('series', 'titulo', serie.titulo, {
      episodios, temporadas: maxTemp, ultimo_episodio: maxEp,
      poster_url: posterMatch?.[1]?.trim() || undefined,
      anio:       yearMatch?.[0] || undefined,
    });
    count++;
    await new Promise(r => setTimeout(r, 400));
  }
  return count;
}

module.exports = { scrapeJuanitaMovies, scrapeJuanitaSeries, enrichJuanitaSeries };
