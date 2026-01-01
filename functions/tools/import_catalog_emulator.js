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
const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.FIRESTORE_EMULATOR_HOST = EMULATOR_HOST;

const jsonArg = process.argv[2];
const collectionArg = process.argv[3];

const jsonPath = jsonArg ? path.resolve(jsonArg) : path.resolve(__dirname, 'catalog_v1_fixed_promos.json');
const collectionName = collectionArg || 'catalog_products';

function die(msg) { console.error(msg); process.exit(1); }

if (!fs.existsSync(jsonPath)) die(`ERROR: JSON not found: ${jsonPath}`);

let payload;
try { payload = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); }
catch (e) { die(`ERROR: Failed to parse JSON: ${e.message}`); }

if (!payload || !Array.isArray(payload.items)) die('ERROR: JSON payload must contain { items: [...] }');

admin.initializeApp({ projectId: DEFAULT_PROJECT_ID });
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
