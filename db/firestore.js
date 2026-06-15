const { getDb } = require('../firebase/admin');

// ── Upsert batch (por titulo como key) ───────────────────────────────────────
async function upsertMany(collection, docs, keyField = 'titulo') {
  if (!docs.length) return 0;
  const db   = getDb();
  const col  = db.collection(collection);
  const batch = db.batch();

  for (const doc of docs) {
    const id  = slugify(doc[keyField] || doc.id || Date.now().toString());
    const ref = col.doc(id);
    batch.set(ref, { ...doc, updatedAt: new Date().toISOString() }, { merge: true });
  }

  await batch.commit();
  return docs.length;
}

// ── Update single doc by field match ─────────────────────────────────────────
async function updateWhere(collection, field, value, data) {
  const db  = getDb();
  const snap = await db.collection(collection).where(field, '==', value).limit(1).get();
  if (snap.empty) return;
  await snap.docs[0].ref.set({ ...data, updatedAt: new Date().toISOString() }, { merge: true });
}

// ── Get docs without a field (for enrichment) ────────────────────────────────
async function getMissingField(collection, field, plataforma, limit = 5) {
  const db = getDb();
  let q = db.collection(collection).where('plataforma', '==', plataforma).limit(limit);
  const snap = await q.get();
  // Filter client-side for missing field (Firestore can't query "field == null" easily cross-platform)
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(d => !d[field] || d[field] === '' || d[field] === 0 || d[field] === -1);
}

// ── Count docs in collection ──────────────────────────────────────────────────
async function countDocs(collection) {
  const db = getDb();
  const snap = await db.collection(collection).count().get();
  return snap.data().count;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function slugify(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

module.exports = { upsertMany, updateWhere, getMissingField, countDocs, slugify };
