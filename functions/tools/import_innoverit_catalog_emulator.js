"use strict";

/**
 * Importa Innoverit (.xlsx) al Firestore Emulator en la colección:
 *   catalog_products_innoverit
 *
 * NO toca catalog_products (Ding).
 *
 * Requiere:
 * - npm i xlsx (ya lo tienes)
 * - FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 (obligatorio; si no, ABORTA)
 *
 * FX usado para calcular sendAmountEur desde USD:
 * - ECB (16 Jan 2026): 1 EUR = 1.1617 USD  =>  1 USD = 1/1.1617 EUR
 */

const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");

const admin = require("firebase-admin");

function abort(msg) {
  console.error("ABORT:", msg);
  process.exit(1);
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function toStr(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function toNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseValidityDays(internalProductId) {
  // Ej: "...-30d" => 30
  const m = String(internalProductId || "").match(/-(\d+)d$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  // Seguridad: solo emulador
  const emu = process.env.FIRESTORE_EMULATOR_HOST;
  if (!emu) abort("FIRESTORE_EMULATOR_HOST no está definido. Esto evita escribir en producción por error.");
  if (!/^(127\.0\.0\.1|localhost):8080$/.test(emu)) {
    abort(`FIRESTORE_EMULATOR_HOST debe ser 127.0.0.1:8080 o localhost:8080. Valor actual: ${emu}`);
  }

  const projectId = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT || "recargaspacuba-7aaa8";

  // Ruta al XLSX (por defecto en /_imports del root)
  const inputArg = process.argv[2];
  const defaultXlsx = path.resolve(__dirname, "..", "_imports", "innoverit_catalog_unificado.xlsx");
  const xlsxPath = path.resolve(inputArg || defaultXlsx);

  if (!fs.existsSync(xlsxPath)) {
    abort(`No existe el XLSX: ${xlsxPath}\nPon el archivo aquí o pásalo como argumento:\nnode tools/import_innoverit_catalog_emulator.js \"RUTA\\AL\\archivo.xlsx\"`);
  }

  // FX ECB: 1 EUR = 1.1617 USD  =>  USD_TO_EUR = 1/1.1617
  const EUR_TO_USD = 1.1617;
  const USD_TO_EUR = 1 / EUR_TO_USD;

  admin.initializeApp({ projectId });
  const db = admin.firestore();

  const wb = XLSX.readFile(xlsxPath);
  const sheetName = "catalog";
  if (!wb.Sheets[sheetName]) abort(`No existe la hoja "${sheetName}" en el XLSX.`);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });

  if (!Array.isArray(rows) || rows.length === 0) abort("La hoja catalog está vacía.");

  // Validación columnas mínimas
  const required = [
    "internalProductId",
    "innoveritIdProduct",
    "category",
    "type",
    "country",
    "operator",
    "productName",
    "localCurrency",
    "costAmount",
    "costCurrency",
    "provider",
  ];

  const first = rows[0] || {};
  const missing = required.filter((k) => !(k in first));
  if (missing.length) abort("Faltan columnas en el XLSX: " + missing.join(", "));

  const colName = "catalog_products_innoverit";
  const col = db.collection(colName);

  // Preparar docs (y contar internalProductId para evitar overwrites)
  const idCounts = new Map();
  for (const r of rows) {
    const k = toStr(r.internalProductId);
    if (k) idCounts.set(k, (idCounts.get(k) || 0) + 1);
  }

  const docs = [];
  for (const r of rows) {
    const internalProductId = toStr(r.internalProductId);
    const innoveritIdProduct = toStr(r.innoveritIdProduct);

    if (!internalProductId) abort("Fila con internalProductId vacío.");
    if (!innoveritIdProduct) abort(`Fila ${internalProductId} con innoveritIdProduct vacío.`);

    const costAmount = toNum(r.costAmount);
    const costCurrency = toStr(r.costCurrency).toUpperCase();

    if (costAmount === null) abort(`Fila ${internalProductId} con costAmount inválido: "${r.costAmount}"`);
    if (!costCurrency) abort(`Fila ${internalProductId} con costCurrency vacío.`);

    // Formato “tipo Ding” (mismas claves)
    const productId = innoveritIdProduct; // string
    const validityDays = parseValidityDays(internalProductId);
    const validityRaw = validityDays ? `${validityDays} Days` : null;

    // Innoverit viene en USD (según tu XLSX). Calculamos sendAmountEur desde USD usando ECB.
    const sendAmountEur =
      costCurrency === "USD"
        ? round2(costAmount * USD_TO_EUR)
        : null; // si en un futuro entra otra moneda, no inventamos conversión

    const sendAmountRaw = `${costCurrency} ${round2(costAmount)}`;

    // receiveText: no viene “amount local” (solo moneda). Para no inventar, dejamos la moneda.
    const localCurrency = toStr(r.localCurrency).toUpperCase();
    const receiveText = localCurrency ? localCurrency : "";

    const data = {
      category: toStr(r.category),
      commissionPct: 0,
      country: toStr(r.country),
      enabled: true,
      internalProductId,
      isPromo: false,
      operator: toStr(r.operator),
      productId,
      productType: toStr(r.type),
      provider: "innoverit",
      providerProductId: productId,
      providerSku: productId,
      publish: true,
      receiveText,
      sendAmountEur,
      sendAmountRaw,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      validityDays,
      validityRaw,
      variablePromo: false,
    };

    const docId = (idCounts.get(internalProductId) > 1)
      ? `${internalProductId}__${productId}`
      : internalProductId;

    docs.push({ id: docId, data });
  }

  // Batch write
  console.log(`Importando ${docs.length} docs en ${colName} (Emulator: ${emu})...`);
  const batch = db.batch();
  for (const d of docs) {
    batch.set(col.doc(d.id), d.data, { merge: true });
  }
  await batch.commit();

  console.log("OK. Docs importados:", docs.length);
  console.log("Ejemplo docId:", docs[0].id);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
