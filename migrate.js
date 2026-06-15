/**
 * MIGRACIÓN SUPABASE → FIREBASE FIRESTORE
 * 
 * Ejecutar una vez: node migrate.js
 * Requiere: npm install @supabase/supabase-js firebase-admin
 */

require('dotenv').config();
const { createClient }    = require('@supabase/supabase-js');
const admin               = require('firebase-admin');

// ── Supabase ──────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // service_role key (no anon!)
);

// ── Firebase ──────────────────────────────────────────────────────────────────
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  }),
});
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

// ── Migrar colección completa ─────────────────────────────────────────────────
async function migrateTable(supabaseTable, firestoreCollection, keyField = 'titulo') {
  console.log(`\n▶ Migrando ${supabaseTable} → ${firestoreCollection}...`);
  let page = 0;
  const PAGE_SIZE = 1000;
  let total = 0;

  while (true) {
    const { data, error } = await supabase
      .from(supabaseTable)
      .select('*')
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (error) { console.error('Error:', error.message); break; }
    if (!data?.length) break;

    // Escribir en Firestore en batches de 500
    const chunks = [];
    for (let i = 0; i < data.length; i += 500) chunks.push(data.slice(i, i + 500));

    for (const chunk of chunks) {
      const batch = db.batch();
      for (const row of chunk) {
        const docId = slugify(String(row[keyField] || row.id || Date.now()));
        const ref   = db.collection(firestoreCollection).doc(docId);
        // Limpiar undefined/null para Firestore
        const clean = Object.fromEntries(
          Object.entries(row).filter(([_, v]) => v !== null && v !== undefined)
        );
        batch.set(ref, clean, { merge: true });
      }
      await batch.commit();
    }

    total += data.length;
    console.log(`  Página ${page + 1}: ${data.length} docs (total ${total})`);
    page++;

    if (data.length < PAGE_SIZE) break;
    await sleep(500); // Rate limiting
  }

  console.log(`✓ ${supabaseTable}: ${total} documentos migrados`);
}

function slugify(str) {
  return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Ejecutar migración ────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Iniciando migración Supabase → Firebase Firestore\n');

  await migrateTable('peliculas', 'peliculas');
  await migrateTable('series',    'series');
  await migrateTable('anime',     'anime');
  await migrateTable('canales',   'canales');

  console.log('\n✅ Migración completa!');
  process.exit(0);
}

main().catch(e => { console.error('Error fatal:', e); process.exit(1); });
