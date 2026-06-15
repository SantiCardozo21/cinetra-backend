const { httpGet } = require('../api/resolve');
const { upsertMany } = require('../db/firestore');

const JJFUTBOL_BASE = 'https://www.jjfutbol.com';
const JJ_TOKEN      = process.env.JJFUTBOL_TOKEN || '';

// ── Partidos en vivo / próximos ───────────────────────────────────────────────
async function scrapeFutbol() {
  if (!JJ_TOKEN) {
    console.warn('[Futbol] No JJFUTBOL_TOKEN definido');
    return 0;
  }

  const url  = `${JJFUTBOL_BASE}/api/events?token=${JJ_TOKEN}`;
  const raw  = await httpGet(url, JJFUTBOL_BASE);
  if (!raw) return 0;

  let data;
  try { data = JSON.parse(raw); } catch { return 0; }

  const matches = (data?.events || data?.matches || []).map(m => ({
    id:          String(m.id || m.matchId || ''),
    home:        m.home?.name || m.homeTeam || '',
    away:        m.away?.name || m.awayTeam || '',
    competition: m.competition?.name || m.league || '',
    time:        m.startTime || m.time || '',
    link:        m.streamUrl || m.link || '',
    live:        Boolean(m.live || m.isLive),
    score:       m.score || '',
  }));

  return matches.length ? await upsertMany('partidos', matches, 'id') : 0;
}

// ── Canales de TV en vivo (desde un m3u o endpoint conocido) ─────────────────
async function scrapeCanales() {
  const raw = await httpGet(process.env.CANALES_URL || '', '');
  if (!raw) return 0;

  const canales = [];

  // Parsear formato M3U
  if (raw.startsWith('#EXTM3U')) {
    const lines = raw.split('\n');
    let current = {};
    for (const line of lines) {
      if (line.startsWith('#EXTINF')) {
        current = {};
        const nameMatch  = line.match(/,(.+)$/);
        const logoMatch  = line.match(/tvg-logo="([^"]+)"/);
        const groupMatch = line.match(/group-title="([^"]+)"/);
        current.nombre   = nameMatch?.[1]?.trim() || '';
        current.logo     = logoMatch?.[1] || '';
        current.categoria = groupMatch?.[1] || 'General';
      } else if (line.startsWith('http') && current.nombre) {
        current.link = line.trim();
        canales.push({ ...current });
        current = {};
      }
    }
  }

  return canales.length ? await upsertMany('canales', canales, 'nombre') : 0;
}

module.exports = { scrapeFutbol, scrapeCanales };
