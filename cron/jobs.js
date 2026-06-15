const cron = require('node-cron');
const { scrapePoseidonMovies, scrapePoseidonSeries, populatePoseidonEpisodes } = require('../scrapers/poseidon');
const { scrapeJuanitaMovies, scrapeJuanitaSeries, enrichJuanitaSeries } = require('../scrapers/juanita');
const { scrapeAnimeFLV, scrapeJKAnime } = require('../scrapers/anime');
const { scrapeFutbol, scrapeCanales } = require('../scrapers/futbol');

function log(tag, msg) { console.log(`[CRON][${tag}] ${new Date().toISOString().slice(11,19)} ${msg}`); }

// ── Refresh diario de contenido (3 AM) ───────────────────────────────────────
cron.schedule('0 3 * * *', async () => {
  log('DAILY', 'Iniciando refresh diario...');

  // PelisJuanita películas (páginas 1-10)
  for (let p = 1; p <= 10; p++) {
    const n = await scrapeJuanitaMovies(p).catch(e => { log('JUANITA-P', e.message); return 0; });
    log('JUANITA-P', `Página ${p}: ${n} guardadas`);
    if (!n) break;
    await sleep(1500);
  }

  // PelisJuanita series (páginas 1-5)
  for (let p = 1; p <= 5; p++) {
    const n = await scrapeJuanitaSeries(p).catch(e => { log('JUANITA-S', e.message); return 0; });
    log('JUANITA-S', `Página ${p}: ${n} guardadas`);
    if (!n) break;
    await sleep(1500);
  }

  // PoseidonHD (páginas 1-3)
  for (let p = 1; p <= 3; p++) {
    const n = await scrapePoseidonMovies(p).catch(e => { log('POSEIDON-P', e.message); return 0; });
    log('POSEIDON-P', `Página ${p}: ${n} guardadas`);
    await sleep(2000);
  }

  for (let p = 1; p <= 3; p++) {
    const n = await scrapePoseidonSeries(p).catch(e => { log('POSEIDON-S', e.message); return 0; });
    log('POSEIDON-S', `Página ${p}: ${n} guardadas`);
    await sleep(2000);
  }

  // Anime (páginas 1-5)
  for (let p = 1; p <= 5; p++) {
    const n = await scrapeAnimeFLV(p).catch(e => { log('ANIMEFLV', e.message); return 0; });
    log('ANIMEFLV', `Página ${p}: ${n} guardadas`);
    if (!n) break;
    await sleep(1500);
  }

  // Canales de TV
  await scrapeCanales().catch(e => log('CANALES', e.message));

  log('DAILY', 'Refresh diario completado');
});

// ── Episodios PoseidonHD con Puppeteer (cada 2 horas) ────────────────────────
cron.schedule('0 */2 * * *', async () => {
  log('EPISODES', 'Poblando episodios PoseidonHD...');
  for (let i = 0; i < 10; i++) {
    const n = await populatePoseidonEpisodes(3).catch(e => { log('EPISODES', e.message); return 0; });
    if (!n) break;
    log('EPISODES', `Batch ${i + 1}: ${n} series actualizadas`);
    await sleep(3000);
  }
});

// ── Enriquecimiento series Juanita (cada hora) ────────────────────────────────
cron.schedule('30 * * * *', async () => {
  log('ENRICH', 'Enriqueciendo series Juanita...');
  const n = await enrichJuanitaSeries(10).catch(e => { log('ENRICH', e.message); return 0; });
  log('ENRICH', `${n} series enriquecidas`);
});

// ── Fútbol en vivo (cada 15 minutos) ─────────────────────────────────────────
cron.schedule('*/15 * * * *', async () => {
  const n = await scrapeFutbol().catch(e => { log('FUTBOL', e.message); return 0; });
  if (n) log('FUTBOL', `${n} partidos actualizados`);
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
log('INIT', 'Cron jobs registrados ✓');
