const cheerio = require('cheerio');
const { httpGet } = require('../api/resolve');
const { upsertMany, updateWhere, getMissingField } = require('../db/firestore');

const ANIMEFLV_BASE = 'https://animeflv.net';
const JKANIME_BASE  = 'https://jkanime.net';

// ── AnimeFLV — scraper de lista ───────────────────────────────────────────────
async function scrapeAnimeFLV(page = 1) {
  const html = await httpGet(`${ANIMEFLV_BASE}/browse?page=${page}`, ANIMEFLV_BASE);
  if (!html) return 0;

  const $ = cheerio.load(html);
  const results = [];

  $('ul.ListAnimes li').each((_, el) => {
    const link   = ANIMEFLV_BASE + ($('a', el).attr('href') || '');
    const titulo = $('h3', el).text().trim() || $('a', el).attr('title') || '';
    const poster = $('img', el).attr('src') || '';
    const slug   = (link.match(/\/anime\/([^/]+)/) || [])[1] || '';
    if (!titulo || !slug) return;
    results.push({
      titulo,
      genero:           '',
      sinopsis:         '',
      poster_url:       poster.startsWith('http') ? poster : ANIMEFLV_BASE + poster,
      link,
      slug,
      plataforma:       'AnimeFLV',
      episodios:        {},
      temporadas:       1,
      ultimo_episodio:  0,
    });
  });

  return results.length ? await upsertMany('anime', results) : 0;
}

// ── AnimeFLV — enriquecer un anime (sinopsis + géneros + episodios) ───────────
async function enrichAnimeFLV(slug) {
  const html = await httpGet(`${ANIMEFLV_BASE}/anime/${slug}`, ANIMEFLV_BASE);
  if (!html) return null;
  const $ = cheerio.load(html);

  const sinopsis = $('div.Description p').first().text().trim()
                || $('meta[name="description"]').attr('content') || '';
  const generos  = [];
  $('nav.Nvgnrs a').each((_, e) => { const g = $(e).text().trim(); if (g) generos.push(g); });

  const poster = $('figure.cover img').attr('src') || '';

  // Episodios desde variable JS: var episodes = [[ep, id], ...];
  const epMatch = html.match(/var episodes\s*=\s*(\[[\s\S]*?\]);/);
  const episodios = { 1: [] };
  let maxEp = 0;
  if (epMatch) {
    try {
      const eps = JSON.parse(epMatch[1]);
      for (const [epNum] of eps) {
        const ep = parseInt(epNum);
        episodios[1].push({
          ep,
          titulo: `Episodio ${ep}`,
          // URL de la página del episodio — VideoScraper intercepta el m3u8
          link: `${ANIMEFLV_BASE}/ver/${slug}-${ep}`,
        });
        maxEp = Math.max(maxEp, ep);
      }
      episodios[1].sort((a, b) => a.ep - b.ep);
    } catch {}
  }

  return {
    sinopsis,
    genero:          generos.join(', '),
    poster_url:      poster.startsWith('http') ? poster : poster ? ANIMEFLV_BASE + poster : undefined,
    episodios:       Object.keys(episodios[1]).length ? episodios : undefined,
    ultimo_episodio: maxEp || undefined,
  };
}

// ── JKAnime — scraper de lista ────────────────────────────────────────────────
async function scrapeJKAnime(page = 1) {
  const html = await httpGet(`${JKANIME_BASE}/directorio/?p=${page}`, JKANIME_BASE);
  if (!html) return 0;
  const $ = cheerio.load(html);
  const results = [];

  // Múltiples selectores posibles para JKAnime
  const cardSels = ['.anime_card', '.card', 'article', '.anime-card', 'li.anime'];
  let found = false;
  for (const sel of cardSels) {
    $(sel).each((_, el) => {
      const a      = $('a[href*="jkanime"], a[href*="/anime/"], h3 a, a', el).first();
      const titulo = a.text().trim() || $('h3, h2, .title', el).first().text().trim();
      const href   = a.attr('href') || '';
      const poster = $('img', el).attr('src') || $('img', el).attr('data-src') || '';
      const slug   = href.replace(/\/$/, '').split('/').filter(Boolean).pop() || '';
      if (!titulo || !slug || titulo.length < 2) return;
      found = true;
      results.push({
        titulo,
        genero:          '',
        sinopsis:        '',
        poster_url:      poster,
        link:            href.startsWith('http') ? href : `${JKANIME_BASE}/${slug}/`,
        slug,
        plataforma:      'JKAnime',
        episodios:       {},
        temporadas:      1,
        ultimo_episodio: 0,
      });
    });
    if (results.length) break;
  }
  // Si aún no hay resultados, buscar cualquier link a anime
  if (!results.length) {
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (!href.includes(JKANIME_BASE) && !href.startsWith('/')) return;
      const titulo = $(el).text().trim() || $(el).attr('title') || '';
      if (!titulo || titulo.length < 3) return;
      const slug = href.replace(/\/$/, '').split('/').filter(Boolean).pop() || '';
      if (!slug || results.find(r => r.slug === slug)) return;
      results.push({ titulo, genero:'', sinopsis:'', poster_url:'', link: href.startsWith('http') ? href : `${JKANIME_BASE}/${slug}/`, slug, plataforma:'JKAnime', episodios:{}, temporadas:1, ultimo_episodio:0 });
    });
  }

  return results.length ? await upsertMany('anime', results) : 0;
}

// ── JKAnime — enriquecer (sinopsis + géneros + episodios) ────────────────────
async function enrichJKAnime(slug) {
  const url  = `${JKANIME_BASE}/${slug}/`;
  const html = await httpGet(url, JKANIME_BASE);
  if (!html) return null;
  const $ = cheerio.load(html);

  const sinopsis = $('.sinopsis p, .description p, [class*="desc"] p').first().text().trim()
                || $('meta[name="description"]').attr('content') || '';
  const generos  = [];
  $('.generos a, .genres a, [class*="genre"] a').each((_, e) => {
    const g = $(e).text().trim();
    if (g && g.length > 1) generos.push(g);
  });
  const poster = $('img.poster, .cover img').first().attr('src') || '';

  // Episodios: buscar links con patrón /slug/episode/
  const episodios = { 1: [] };
  let maxEp = 0;

  // Intentar extraer número total de episodios
  const totalMatch = html.match(/episodios[^0-9]*(\d+)/i)
                  || html.match(/"numEpisodes"\s*:\s*(\d+)/);
  const totalEps = totalMatch ? parseInt(totalMatch[1]) : 0;

  if (totalEps > 0) {
    for (let ep = 1; ep <= totalEps; ep++) {
      episodios[1].push({
        ep,
        titulo: `Episodio ${ep}`,
        link: `${JKANIME_BASE}/${slug}/${ep}/`,
      });
    }
    maxEp = totalEps;
  } else {
    // Extraer desde links en la página
    $('a[href]').each((_, e) => {
      const href = $(e).attr('href') || '';
      const m    = href.match(new RegExp(slug + '/(\\d+)/?$'));
      if (!m) return;
      const ep = parseInt(m[1]);
      if (!episodios[1].find(x => x.ep === ep)) {
        episodios[1].push({ ep, titulo: `Episodio ${ep}`, link: href.startsWith('http') ? href : JKANIME_BASE + href });
        maxEp = Math.max(maxEp, ep);
      }
    });
    episodios[1].sort((a, b) => a.ep - b.ep);
  }

  return {
    sinopsis,
    genero:          generos.join(', '),
    poster_url:      poster || undefined,
    episodios:       maxEp > 0 ? episodios : undefined,
    ultimo_episodio: maxEp || undefined,
  };
}

// ── Enriquecimiento bulk ──────────────────────────────────────────────────────
async function enrichAnime(limit = 5) {
  const db = require('../firebase/admin').getDb();

  // Mezclar AnimeFLV y JKAnime
  const [snapFlv, snapJk] = await Promise.all([
    db.collection('anime').where('plataforma', '==', 'AnimeFLV').where('ultimo_episodio', '==', 0).limit(Math.ceil(limit/2)).get(),
    db.collection('anime').where('plataforma', '==', 'JKAnime').where('ultimo_episodio', '==', 0).limit(Math.ceil(limit/2)).get(),
  ]);

  const docs = [
    ...snapFlv.docs.map(d => ({ id: d.id, ...d.data() })),
    ...snapJk.docs.map(d => ({ id: d.id, ...d.data() })),
  ].slice(0, limit);

  let count = 0;
  for (const doc of docs) {
    try {
      const data = doc.plataforma === 'AnimeFLV'
        ? await enrichAnimeFLV(doc.slug)
        : await enrichJKAnime(doc.slug);
      if (!data) {
        await updateWhere('anime', 'titulo', doc.titulo, { ultimo_episodio: -1 });
        continue;
      }
      await updateWhere('anime', 'titulo', doc.titulo, data);
      count++;
    } catch (e) {
      console.error('[enrichAnime]', doc.titulo, e.message);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return count;
}

module.exports = { scrapeAnimeFLV, scrapeJKAnime, enrichAnimeFLV, enrichJKAnime, enrichAnime };
