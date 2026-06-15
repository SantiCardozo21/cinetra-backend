const cheerio = require('cheerio');
const { httpGet } = require('../api/resolve');
const { upsertMany } = require('../db/firestore');

const ANIMEFLV_BASE = 'https://animeflv.net';
const JKANIME_BASE  = 'https://jkanime.net';

// ── AnimeFLV ──────────────────────────────────────────────────────────────────
async function scrapeAnimeFLV(page = 1) {
  const url  = `${ANIMEFLV_BASE}/browse?page=${page}`;
  const html = await httpGet(url, ANIMEFLV_BASE);
  if (!html) return 0;

  const $       = cheerio.load(html);
  const results = [];

  $('ul.ListAnimes li').each((_, el) => {
    const link    = ANIMEFLV_BASE + ($('a', el).attr('href') || '');
    const titulo  = $('h3', el).text().trim() || $('a', el).attr('title') || '';
    const poster  = $('img', el).attr('src') || '';
    const genero  = $('p.generos', el).text().trim() || '';
    const slug    = (link.match(/\/anime\/([^/]+)/) || [])[1] || '';

    if (!titulo || !slug) return;

    results.push({
      titulo,
      genero,
      sinopsis:        '',
      poster_url:      poster.startsWith('http') ? poster : ANIMEFLV_BASE + poster,
      link,
      slug,
      plataforma:      'AnimeFLV',
      episodios:       {},
      temporadas:      1,
      ultimo_episodio: 0,
    });
  });

  return results.length ? await upsertMany('anime', results) : 0;
}

// ── JKAnime ───────────────────────────────────────────────────────────────────
async function scrapeJKAnime(page = 1) {
  const url  = `${JKANIME_BASE}/directorio/?p=${page}`;
  const html = await httpGet(url, JKANIME_BASE);
  if (!html) return 0;

  const $       = cheerio.load(html);
  const results = [];

  $('.anime_card').each((_, el) => {
    const a      = $('a.title', el);
    const titulo = a.text().trim();
    const link   = a.attr('href') || '';
    const poster = $('img', el).attr('src') || '';
    const slug   = (link.match(/\/([^/]+)\/?$/) || [])[1] || '';

    if (!titulo || !slug) return;

    results.push({
      titulo,
      genero:          '',
      sinopsis:        '',
      poster_url:      poster,
      link:            link.startsWith('http') ? link : JKANIME_BASE + link,
      slug,
      plataforma:      'JKAnime',
      episodios:       {},
      temporadas:      1,
      ultimo_episodio: 0,
    });
  });

  return results.length ? await upsertMany('anime', results) : 0;
}

// ── Enriquecer anime AnimeFLV ────────────────────────────────────────────────
async function enrichAnimeFLV(slug) {
  const html = await httpGet(`${ANIMEFLV_BASE}/anime/${slug}`, ANIMEFLV_BASE);
  if (!html) return null;

  const $ = cheerio.load(html);

  const sinopsis = $('div.Description p').first().text().trim()
                || $('meta[name="description"]').attr('content') || '';
  const generos  = [];
  $('nav.Nvgnrs a').each((_, el) => generos.push($(el).text().trim()));

  // Episodios desde variable JS
  const epMatch = html.match(/var episodes\s*=\s*(\[\[[\s\S]+?\]\])/);
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
          link:   `${ANIMEFLV_BASE}/ver/${slug}-${ep}`,
        });
        maxEp = Math.max(maxEp, ep);
      }
      episodios[1].sort((a, b) => a.ep - b.ep);
    } catch {}
  }

  return { sinopsis, genero: generos.join(', '), episodios, ultimo_episodio: maxEp };
}

module.exports = { scrapeAnimeFLV, scrapeJKAnime, enrichAnimeFLV };
