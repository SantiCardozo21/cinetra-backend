const express = require('express');
const router  = express.Router();
const { resolveM3u8 } = require('./resolve');
const { scrapePoseidonMovies, scrapePoseidonSeries, populatePoseidonEpisodes } = require('../scrapers/poseidon');
const { scrapeJuanitaMovies, scrapeJuanitaSeries, enrichJuanitaSeries } = require('../scrapers/juanita');
const { scrapeAnimeFLV, scrapeJKAnime } = require('../scrapers/anime');
const { scrapeFutbol, scrapeCanales } = require('../scrapers/futbol');
const { getDb } = require('../firebase/admin');

// ── Auth middleware ───────────────────────────────────────────────────────────
function auth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== process.env.API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── /api/resolve — resolver m3u8 ─────────────────────────────────────────────
router.get('/resolve', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Falta ?url=' });
  try {
    const result = await resolveM3u8(url);
    res.json(result);
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── /api/data — leer colecciones de Firestore ─────────────────────────────────
router.get('/data/:collection', async (req, res) => {
  const { collection } = req.params;
  const allowed = ['peliculas', 'series', 'anime', 'canales', 'partidos'];
  if (!allowed.includes(collection)) return res.status(400).json({ error: 'Colección no válida' });

  const { limit = '50', offset = '0', plataforma, search } = req.query;
  const db = getDb();
  let q = db.collection(collection).limit(parseInt(limit));

  if (plataforma) q = q.where('plataforma', '==', plataforma);

  const snap = await q.get();
  let docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Búsqueda client-side (Firestore no soporta substring)
  if (search) {
    const s = search.toLowerCase();
    docs = docs.filter(d => (d.titulo || '').toLowerCase().includes(s));
  }

  res.json({ data: docs, count: docs.length });
});

// ── /api/scrape — disparar scrapers manualmente ───────────────────────────────
router.post('/scrape', auth, async (req, res) => {
  const { source, page = 1, batch = 5 } = req.body;

  const map = {
    'poseidon-movies':    () => scrapePoseidonMovies(page),
    'poseidon-series':    () => scrapePoseidonSeries(page),
    'poseidon-episodes':  () => populatePoseidonEpisodes(batch),
    'juanita-movies':     () => scrapeJuanitaMovies(page),
    'juanita-series':     () => scrapeJuanitaSeries(page),
    'enrich-juanita':     () => enrichJuanitaSeries(batch),
    'animeflv':           () => scrapeAnimeFLV(page),
    'jkanime':            () => scrapeJKAnime(page),
    'futbol':             () => scrapeFutbol(),
    'canales':            () => scrapeCanales(),
  };

  const fn = map[source];
  if (!fn) return res.status(400).json({ error: `Source desconocida: ${source}` });

  try {
    const count = await fn();
    res.json({ ok: true, source, count });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── /api/stats — estadísticas de la DB ───────────────────────────────────────
router.get('/stats', auth, async (req, res) => {
  const db = getDb();
  const [p, s, a, c, pt] = await Promise.all([
    db.collection('peliculas').count().get().then(r => r.data().count),
    db.collection('series').count().get().then(r => r.data().count),
    db.collection('anime').count().get().then(r => r.data().count),
    db.collection('canales').count().get().then(r => r.data().count),
    db.collection('partidos').count().get().then(r => r.data().count),
  ]);
  res.json({ peliculas: p, series: s, anime: a, canales: c, partidos: pt });
});

// ── /api/migrate — migrar Supabase → Firestore ───────────────────────────────
router.post('/migrate', auth, async (req, res) => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(400).json({ error: 'Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY' });
  }

  const fetch = require('node-fetch');
  const db    = getDb();
  const { slugify } = require('../db/firestore');
  const results = {};

  async function migrateTable(table, collection) {
    let page = 0, total = 0;
    while (true) {
      const url = `${SUPABASE_URL}/rest/v1/${table}?select=*&limit=1000&offset=${page * 1000}`;
      const res2 = await fetch(url, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      const rows = await res2.json();
      if (!Array.isArray(rows) || !rows.length) break;

      const chunks = [];
      for (let i = 0; i < rows.length; i += 400) chunks.push(rows.slice(i, i + 400));
      for (const chunk of chunks) {
        const batch = db.batch();
        for (const row of chunk) {
          const key = row.titulo || row.nombre || row.id || String(Date.now());
          const id  = slugify(String(key)).slice(0, 80) || String(Date.now());
          const ref = db.collection(collection).doc(id);
          const clean = Object.fromEntries(
            Object.entries(row).filter(([_, v]) => v !== null && v !== undefined)
          );
          batch.set(ref, clean, { merge: true });
        }
        await batch.commit();
      }
      total += rows.length;
      page++;
      if (rows.length < 1000) break;
      await new Promise(r => setTimeout(r, 300));
    }
    return total;
  }

  try {
    results.peliculas = await migrateTable('peliculas', 'peliculas');
    results.series    = await migrateTable('series',    'series');
    results.anime     = await migrateTable('anime',     'anime');
    results.canales   = await migrateTable('canales',   'canales');
    res.json({ ok: true, migrated: results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
