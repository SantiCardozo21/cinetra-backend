const admin = require('firebase-admin');

let _db = null;

function getDb() {
  if (_db) return _db;

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:    process.env.FIREBASE_PROJECT_ID,
        clientEmail:  process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:   (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      }),
    });
  }

  _db = admin.firestore();
  _db.settings({ ignoreUndefinedProperties: true });
  return _db;
}

module.exports = { getDb };
