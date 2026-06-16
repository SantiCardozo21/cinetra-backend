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

  const { limit = '50', plataforma, search, search_genero } = req.query;
  const db = getDb();
  let q = db.collection(collection).limit(Math.min(parseInt(limit) || 150, 500));

  if (plataforma) q = q.where('plataforma', '==', plataforma);

  const snap = await q.get();
  let docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Filtros client-side (Firestore no soporta substring search)
  if (search) {
    const s = search.toLowerCase();
    docs = docs.filter(d =>
      (d.titulo || '').toLowerCase().includes(s) ||
      String(d.id || '').toLowerCase().includes(s)
    );
  }
  if (search_genero) {
    const g = search_genero.toLowerCase();
    docs = docs.filter(d => (d.genero || '').toLowerCase().includes(g));
  }

  res.json({ data: docs, count: docs.length });
});

// ── /api/scrape — disparar scrapers manualmente ───────────────────────────────
router.post('/scrape', auth, async (req, res) => {
  const { source, page = 1, batch = 5 } = req.body;

  const { enrichAnime } = require('../scrapers/anime');
  const map = {
    'poseidon-movies':    () => scrapePoseidonMovies(page),
    'poseidon-series':    () => scrapePoseidonSeries(page),
    'poseidon-episodes':  () => populatePoseidonEpisodes(batch),
    'juanita-movies':     () => scrapeJuanitaMovies(page),
    'juanita-series':     () => scrapeJuanitaSeries(page),
    'enrich-juanita':     () => enrichJuanitaSeries(batch),
    'animeflv':           () => scrapeAnimeFLV(page),
    'jkanime':            () => scrapeJKAnime(page),
    'enrich-anime':       () => enrichAnime(batch),
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

// ── GET /api/migrate — página HTML para disparar migración ───────────────────
router.get('/migrate', (req, res) => {
  if (req.query.key !== process.env.API_SECRET) {
    return res.status(401).send('Unauthorized');
  }
  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Cinetra Migration</title>
<style>
  body{font-family:monospace;background:#0a0a0a;color:#fff;padding:40px;}
  button{background:#E53935;color:#fff;border:none;padding:14px 28px;font-size:16px;cursor:pointer;border-radius:8px;}
  button:disabled{background:#555;cursor:not-allowed;}
  #log{margin-top:24px;background:#1a1a1a;padding:20px;border-radius:8px;white-space:pre-wrap;min-height:100px;font-size:13px;line-height:1.6;}
  .ok{color:#4CAF50;}.err{color:#E53935;}
</style></head><body>
<h2>🎬 Cinetra — Migración Supabase → Firebase</h2>
<button id="btn" onclick="migrate()">▶ Iniciar Migración</button>
<div id="log">Esperando...</div>
<script>
async function migrate(){
  const btn=document.getElementById('btn');
  const log=document.getElementById('log');
  btn.disabled=true; btn.textContent='⏳ Migrando... (puede tardar 5 min)';
  log.innerHTML='Iniciando...\n';
  try{
    const r=await fetch('/api/migrate',{method:'POST',headers:{'x-api-key':'${process.env.API_SECRET}','Content-Type':'application/json'}});
    const d=await r.json();
    if(d.ok){
      log.innerHTML='<span class="ok">✓ Completado!\n\n  Películas: '+d.migrated.peliculas+'\n  Series: '+d.migrated.series+'\n  Anime: '+d.migrated.anime+'\n  Canales: '+d.migrated.canales+'</span>';
      btn.textContent='✓ Listo';
    }else{
      log.innerHTML='<span class="err">✗ Error: '+d.error+'</span>';
      btn.disabled=false; btn.textContent='▶ Reintentar';
    }
  }catch(e){
    log.innerHTML='<span class="err">✗ '+e.message+'</span>';
    btn.disabled=false; btn.textContent='▶ Reintentar';
  }
}
</script></body></html>`);
});


// ── /api/embed — extraer URL del player embed (sin Puppeteer) ────────────────
// Railway solo extrae la URL del embed; el WebView del Android resuelve el m3u8
router.get('/embed', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Falta ?url=' });

  try {
    const fetch = require('node-fetch');
    const UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

    // ── PoseidonHD → leer __NEXT_DATA__ y devolver URL del player ───────────
    if (url.includes('poseidonhd2.co')) {
      const html = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://www.poseidonhd2.co' }, timeout: 12000 }).then(r => r.text()).catch(() => null);
      if (!html) return res.json({ ok: false, error: 'No se pudo cargar la página' });

      const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
      if (!m) return res.json({ ok: false, error: 'No se encontró __NEXT_DATA__' });

      const data   = JSON.parse(m[1]);
      const props  = data?.props?.pageProps;
      const videos = props?.thisMovie?.videos || props?.thisTvshow?.videos || props?.thisEpisode?.videos;
      if (!videos) return res.json({ ok: false, error: 'No hay videos en __NEXT_DATA__' });

      const PREFS = ['streamwish', 'filemoon', 'vidhide', 'voesx'];
      let embedUrl = null;
      for (const lang of ['latino', 'spanish', 'english']) {
        const arr = videos[lang];
        if (!arr?.length) continue;
        for (const pref of PREFS) {
          const e = arr.find(x => x.cyberlocker === pref && x.result?.startsWith('http'));
          if (e) { embedUrl = e.result; break; }
        }
        if (!embedUrl) {
          const first = arr.find(x => x.result?.startsWith('http'));
          if (first) embedUrl = first.result;
        }
        if (embedUrl) break;
      }

      if (embedUrl) return res.json({ ok: true, embedUrl });
      return res.json({ ok: false, error: 'No se encontró embed en videos' });
    }

    // ── PelisJuanita → movieInfo.php para obtener URL del servidor ───────────
    if (url.includes('pelisjuanita.com')) {
      const slug = url.replace(/\/$/, '').split('/').pop();
      const infoUrl = `https://pelisjuanita.com/movies/movieInfo.php?title=${encodeURIComponent(slug)}`;
      const html = await fetch(infoUrl, { headers: { 'User-Agent': UA, 'Referer': url }, timeout: 10000 }).then(r => r.text()).catch(() => null);
      if (!html) return res.json({ ok: false, error: 'movieInfo.php no respondió' });

      const servers = [];
      const re = /data-url=['"]?(https?:\/\/[^'">\s]+)/g;
      let em;
      while ((em = re.exec(html)) !== null) {
        const u = em[1];
        if (!u.includes('youtube') && !u.includes('1fichier')) servers.push(u);
      }

      if (servers.length) return res.json({ ok: true, embedUrl: servers[0] });
      return res.json({ ok: false, error: 'No se encontraron servidores en movieInfo.php' });
    }

    // ── URL genérica → devolver la misma URL (el WebView la maneja) ──────────
    res.json({ ok: true, embedUrl: url });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── /api/delete-collection — borrar colección completa ───────────────────────
router.delete('/collection/:name', auth, async (req, res) => {
  const { name } = req.params;
  const allowed = ['peliculas', 'series', 'anime', 'canales', 'partidos'];
  if (!allowed.includes(name)) return res.status(400).json({ error: 'Colección no válida' });
  
  const db = getDb();
  let deleted = 0;
  while (true) {
    const snap = await db.collection(name).limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    deleted += snap.size;
  }
  res.json({ ok: true, collection: name, deleted });
});

module.exports = router;
