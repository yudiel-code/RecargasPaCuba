'use strict';

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const DEFAULT_PROJECT_ID =
  process.env.GCLOUD_PROJECT ||
  process.env.FIREBASE_PROJECT_ID ||
  'recargaspacuba-7aaa8';

const argv = process.argv.slice(2);
const flags = {};
for (const a of argv) {
  if (a.startsWith('--')) {
    const [k, v] = a.replace(/^--/, '').split('=');
    flags[k] = (v === undefined ? true : v);
  }
}

const target = String(flags.target || (flags.prod ? 'prod' : 'emulator')).toLowerCase();
const projectId = String(flags.project || DEFAULT_PROJECT_ID);
const emulatorHost = String(
  flags.emulatorHost || process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080'
);

const productsPath = path.resolve(__dirname, '..', '..', 'migration', 'ding', 'catalog_products_ding_seed.json');
const privatePath = path.resolve(__dirname, '..', '..', 'migration', 'ding', 'catalog_private_ding_seed.json');

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (target === 'prod') {
  const confirm = String(flags.confirm || '').toUpperCase();
  if (confirm !== 'PROD') {
    die('ERROR: Refusing to write to PRODUCTION. Re-run with --target=prod --confirm=PROD');
  }
  delete process.env.FIRESTORE_EMULATOR_HOST;
} else {
  process.env.FIRESTORE_EMULATOR_HOST = emulatorHost;
}

if (target === 'prod') {
  admin.initializeApp({
    projectId,
    credential: admin.credential.applicationDefault(),
  });
} else {
  admin.initializeApp({ projectId });
}

const db = admin.firestore();

function loadJsonArray(filePath, label) {
  if (!fs.existsSync(filePath)) die(`ERROR: ${label} not found: ${filePath}`);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    die(`ERROR: Failed to parse ${label}: ${e.message}`);
  }
  if (!Array.isArray(data)) {
    die(`ERROR: ${label} must be a JSON array`);
  }
  return data;
}

async function importCollection(collectionName, items) {
  if (!items.length) {
    return { collection: collectionName, imported: 0, ids: [] };
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const ids = [];

  for (let i = 0; i < items.length; i += 400) {
    const chunk = items.slice(i, i + 400);
    const batch = db.batch();

    for (const item of chunk) {
      const docId = String(item.id || item.internalProductId || '').trim();
      if (!docId) die(`ERROR: Found item without id/internalProductId in ${collectionName}`);

      const ref = db.collection(collectionName).doc(docId);
      batch.set(ref, { ...item, updatedAt: now }, { merge: true });
      ids.push(docId);
    }

    await batch.commit();
  }

  return { collection: collectionName, imported: items.length, ids };
}

async function main() {
  const products = loadJsonArray(productsPath, 'catalog_products_ding_seed.json');
  const privates = loadJsonArray(privatePath, 'catalog_private_ding_seed.json');

  const resultProducts = await importCollection('catalog_products_ding', products);
  const resultPrivate = await importCollection('catalog_private_ding', privates);

  console.log(JSON.stringify({
    ok: true,
    target,
    projectId,
    emulatorHost: target === 'prod' ? null : emulatorHost,
    results: [resultProducts, resultPrivate],
  }, null, 2));
}

main().catch((e) => {
  console.error('ERROR:', e);
  process.exit(1);
});