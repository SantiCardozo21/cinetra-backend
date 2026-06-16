const { upsertMany } = require('../db/firestore');
const fetch = require('node-fetch');

const JJFUTBOL_BASE = 'https://jjfutbol2.lat';
// Token estático de jjfutbol2.lat (hardcodeado en su JS del sitio)
const JJTOKEN = process.env.JJFUTBOL_TOKEN || 'TU_TOKEN_SECRETO_AQUI_32_CHARS__';

// ── Partidos del día (JJFutbol) ───────────────────────────────────────────────
async function scrapeFutbol() {
  const res = await fetch(`${JJFUTBOL_BASE}/agenda.php`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin':   JJFUTBOL_BASE,
      'Referer':  `${JJFUTBOL_BASE}/index.php`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
    },
    body: 'token=' + encodeURIComponent(JJTOKEN),
  });

  if (!res.ok) { console.error('[Futbol] HTTP', res.status); return 0; }

  const data = await res.json().catch(() => null);
  if (!Array.isArray(data)) { console.error('[Futbol] Respuesta inválida'); return 0; }

  // Calcular hora Argentina (UTC-3)
  const nowMs = Date.now();
  const nowAR = new Date(nowMs - 3 * 3600000);
  const [arY, arM, arD] = [nowAR.getUTCFullYear(), nowAR.getUTCMonth(), nowAR.getUTCDate()];

  const partidos = [];
  const seen = new Set();

  for (const item of data) {
    const titulo = (item.titulo || '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    // Extraer equipos: "Categoria: Local vs Visitante"
    const vsMatch = titulo.match(/^(?:.+?[:\-–]\s*)?(.+?)\s+vs\s+(.+)$/i);
    if (!vsMatch) continue;
    const local = vsMatch[1].trim(), visit = vsMatch[2].trim();
    if (local.length < 2 || visit.length < 2) continue;
    const key = local.toLowerCase() + '-' + visit.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    // Convertir hora Argentina a UTC
    const [mH, mMin] = (item.hora || '00:00').split(':').map(Number);
    let matchUTC = new Date(Date.UTC(arY, arM, arD, mH + 3, mMin));
    // Si el partido ya pasó hace más de 4 horas → es de mañana
    if (nowMs - matchUTC.getTime() > 4 * 3600000) {
      matchUTC = new Date(matchUTC.getTime() + 24 * 3600000);
    }

    const tituloClean = titulo.replace(/\s+/g, ' ').trim();
    const canales = (item.canales || []).map(c => ({
      nombre: c.canal,
      link: `${JJFUTBOL_BASE}/evento.php?id=${encodeURIComponent(c.canal_id)}&t=${encodeURIComponent(tituloClean)}&c=${encodeURIComponent(c.canal)}`
    }));

    partidos.push({
      id:           `${local}-${visit}-${matchUTC.toISOString().slice(0,10)}`.toLowerCase().replace(/\s+/g, '-'),
      equipo_local: local,
      equipo_visit: visit,
      sigla_local:  local.substring(0, 3).toUpperCase(),
      sigla_visit:  visit.substring(0, 3).toUpperCase(),
      color_local:  '#1565c0',
      color_visit:  '#c62828',
      fecha:        matchUTC.toISOString(),
      en_vivo:      false,
      liga:         item.categoria || '',
      canales,
      proveedores:  canales.map(c => c.nombre),
      link_tyc:     canales[0]?.link || '',
    });
  }

  if (!partidos.length) return 0;

  // Usar el id como key para upsert
  const db = require('../firebase/admin').getDb();
  let saved = 0;
  const chunks = [];
  for (let i = 0; i < partidos.length; i += 400) chunks.push(partidos.slice(i, i + 400));
  for (const chunk of chunks) {
    const batch = db.batch();
    for (const p of chunk) {
      const ref = db.collection('partidos').doc(p.id);
      batch.set(ref, { ...p, updatedAt: new Date().toISOString() }, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }
  return saved;
}

// ── Canales de TV en vivo (M3U) ───────────────────────────────────────────────
async function scrapeCanales() {
  const canalesUrl = process.env.CANALES_URL || '';
  if (!canalesUrl) { console.warn('[Canales] No CANALES_URL'); return 0; }

  const res = await fetch(canalesUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' }
  });
  if (!res.ok) return 0;
  const raw = await res.text();
  if (!raw.startsWith('#EXTM3U')) return 0;

  const canales = [];
  const lines = raw.split('\n');
  let current = {};

  for (const line of lines) {
    const l = line.trim();
    if (l.startsWith('#EXTINF')) {
      current = {};
      const nameMatch  = l.match(/,(.+)$/);
      const logoMatch  = l.match(/tvg-logo="([^"]+)"/);
      const groupMatch = l.match(/group-title="([^"]+)"/);
      current.nombre    = nameMatch?.[1]?.trim() || '';
      current.logo      = logoMatch?.[1] || '';
      current.categoria = groupMatch?.[1] || 'General';
    } else if (l.startsWith('http') && current.nombre) {
      current.link = l;
      canales.push({ ...current });
      current = {};
    }
  }

  return canales.length ? await upsertMany('canales', canales, 'nombre') : 0;
}

module.exports = { scrapeFutbol, scrapeCanales };
