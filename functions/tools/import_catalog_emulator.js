'use strict';
/**
 * Import catalog_v1_fixed_promos.json into Firestore Emulator.
 *
 * - Firestore emulator running on 127.0.0.1:8080
 *
 * Usage (from repo root):
 *   node .\functions\tools\import_catalog_emulator.js
 *
 * Optional:
 *   node .\functions\tools\import_catalog_emulator.js .\functions\tools\catalog_v1_fixed_promos.json catalog_products
 */
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const DEFAULT_PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || 'recargaspacuba-7aaa8';

// --- args parsing (flags + positional) ---
const argv = process.argv.slice(2);
const flags = {};
const positionals = [];

for (const a of argv) {
  if (a.startsWith('--')) {
    const [k, v] = a.replace(/^--/, '').split('=');
    flags[k] = (v === undefined ? true : v);
  } else {
    positionals.push(a);
  }
}

// target: emulator (default) | prod
const target = String(flags.target || (flags.prod ? 'prod' : 'emulator')).toLowerCase();
const projectId = String(flags.project || DEFAULT_PROJECT_ID);

// emulator host (only used for emulator target)
const emulatorHost = String(flags.emulatorHost || process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080');
const EMULATOR_HOST = emulatorHost; // backward-compat for old references


// positional compatibility: [jsonPath] [collection]
const jsonArg = positionals[0];
const collectionArg = positionals[1];

const jsonPath = jsonArg ? path.resolve(jsonArg) : path.resolve(__dirname, 'catalog_v1_fixed_promos.json');
const collectionName = collectionArg || 'catalog_products';

// Safety latch for prod
if (target === 'prod') {
  const confirm = String(flags.confirm || '').toUpperCase();
  if (confirm !== 'PROD') {
    die('ERROR: Refusing to write to PRODUCTION. Re-run with --target=prod --confirm=PROD');
  }
  // Ensure we are NOT pointing at emulator
  delete process.env.FIRESTORE_EMULATOR_HOST;
} else {
  // Default: emulator (safe)
  process.env.FIRESTORE_EMULATOR_HOST = emulatorHost;
}

// Init Admin SDK
if (target === 'prod') {
  admin.initializeApp({ projectId, credential: admin.credential.applicationDefault() });
} else {
  admin.initializeApp({ projectId });
}

function die(msg) { console.error(msg); process.exit(1); }

if (!fs.existsSync(jsonPath)) die(`ERROR: JSON not found: ${jsonPath}`);

let payload;
try { payload = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); }
catch (e) { die(`ERROR: Failed to parse JSON: ${e.message}`); }

if (!payload || !Array.isArray(payload.items)) die('ERROR: JSON payload must contain { items: [...] }');

if (!admin.apps.length) {
  if (target === 'prod') {
    admin.initializeApp({ projectId, credential: admin.credential.applicationDefault() });
  } else {
    admin.initializeApp({ projectId });
  }
}
const db = admin.firestore();

async function main() {
  const items = payload.items;
  if (items.length === 0) die('ERROR: No items to import.');

  const now = admin.firestore.FieldValue.serverTimestamp();
  const batch = db.batch();

  const importedInternalIds = [];
  const importedProviderIds = [];

  for (const item of items) {
    const internalId = String(item.internalProductId || '').trim();
    const providerId = String(item.providerProductId || item.providerSku || '').trim();

    if (!internalId) die('ERROR: Found item with empty internalProductId.');
    if (!providerId) die(`ERROR: Found item with empty providerProductId/providerSku (internalProductId=${internalId}).`);

    // Master: internalProductId (tu ID)
    const docRef = db.collection(collectionName).doc(internalId);

    // Force: productId = Ding providerProductId (evita el 20664 repetido del JSON)
    const data = {
      ...item,
      internalProductId: internalId,
      providerProductId: providerId,
      productId: providerId,
      updatedAt: now,
    };

    batch.set(docRef, data, { merge: true });

    importedInternalIds.push(internalId);
    importedProviderIds.push(providerId);
  }

  await batch.commit();

  console.log(JSON.stringify({
    ok: true,
    projectId: DEFAULT_PROJECT_ID,
    emulatorHost: EMULATOR_HOST,
    collection: collectionName,
    imported: items.length,
    internalIds: importedInternalIds,
    providerIds: importedProviderIds,
  }, null, 2));
}

main().catch((e) => { console.error('ERROR:', e); process.exit(1); });
