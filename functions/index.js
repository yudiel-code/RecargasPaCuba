/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

const { setGlobalOptions } = require("firebase-functions");
const { onRequest } = require("firebase-functions/https");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");

const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");

// Mantén tu control de costes
setGlobalOptions({ maxInstances: 10 });

// Init Admin SDK (Firestore)
if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

async function requireAppCheck(req, res) {
  const token = req.get("X-Firebase-AppCheck") || req.get("x-firebase-appcheck") || "";
  if (!token) {
    sendJson(res, 401, { ok: false, error: "APPCHECK_MISSING" });
    return false;
  }
  try {
    await admin.appCheck().verifyToken(token);
    return true;
  } catch (e) {
    logger.warn("appcheck_verify_failed", { message: String(e && e.message ? e.message : e) });
    sendJson(res, 401, { ok: false, error: "APPCHECK_INVALID" });
    return false;
  }
}


// Source of truth del catálogo: Firestore collection "catalog_products".

function sendJson(res, status, payload) {
  res.status(status);
  res.set("Content-Type", "application/json; charset=utf-8");
  res.send(JSON.stringify(payload));
}

function setCors(req, res) {
  const origin = req.get("origin") || "";
  const allowed = new Set([
    "https://recargaspacuba.es",
    "https://www.recargaspacuba.es",
    "https://recargaspacuba.net",
    "https://www.recargaspacuba.net",
    "https://recargaspacuba.eu",
    "https://www.recargaspacuba.eu",
  ]);

  // Evita cachés cruzados entre orígenes
  res.set("Vary", "Origin");

  // CORS estricto: solo permitimos orígenes en allowlist
  if (allowed.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
  }

  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Firebase-AppCheck");
  res.set("Access-Control-Max-Age", "3600");
}

function safeParseBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.trim()) {
    try {
      return JSON.parse(req.body);
    } catch (_) {
      return null;
    }
  }
  return null;
}

function normalizeCubacel(input) {
  let s = String(input || "").trim();
  s = s.replace(/[^\d+]/g, "");
  if (s.startsWith("+53")) s = s.slice(3);
  if (s.startsWith("53") && s.length > 8) s = s.slice(2);
  s = s.replace(/[^\d]/g, "");
  return s;
}

function isValidCubacel(normalized) {
  return /^5\d{7}$/.test(normalized);
}

function isValidNautaEmail(emailRaw) {
  const e = String(emailRaw || "").trim().toLowerCase();
  return /^[^\s@]+@nauta(\.com)?\.cu$/.test(e);
}

function isRunningInEmulator() {
  return process.env.FUNCTIONS_EMULATOR === "true" || !!process.env.FIREBASE_EMULATOR_HUB;
}

function getBearerToken(req) {
  const h = req.get("authorization") || req.get("Authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
  return m ? m[1] : "";
}

/**
 * Resuelve el uid de forma segura:
 * - En producción (no emulador): requiere Authorization: Bearer <ID_TOKEN>
 * - En emulador: permite fallback al uid del body para pruebas (PowerShell, etc.)
 */
async function resolveUid(req, uidFromBody) {
  const requireAuth = !isRunningInEmulator();
  const token = getBearerToken(req);

  if (!token) {
    if (requireAuth) {
      return { ok: false, error: "MISSING_AUTH" };
    }
    return { ok: true, uid: uidFromBody || "", source: "body" };
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const uid = (decoded && decoded.uid) ? String(decoded.uid) : "";
    if (!uid) return { ok: false, error: "INVALID_ID_TOKEN" };
    return { ok: true, uid, source: "token" };
  } catch (e) {
    return { ok: false, error: "INVALID_ID_TOKEN" };
  }
}

/**
 * Fase 2 (sandbox): createOrder (sin pago)
 * - valida server-side
 * - resuelve producto desde Firestore "catalog_products"
 * - calcula importe en servidor: sendAmountEur + 1.00 (EUR) y lo persiste en /orders.amount
 * - crea orden PENDING en /orders
 * - responde { orderId, amount, currency, status }
 */
exports.createOrder = onRequest(async (req, res) => {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }

  if (!(await requireAppCheck(req, res))) return;

  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  const body = safeParseBody(req);
  if (!body) {
    return sendJson(res, 400, { ok: false, error: "INVALID_JSON_BODY" });
  }

  let { uid, productId, destino } = body;

  // Normaliza inputs
  const uidBody = typeof uid === "string" ? uid.trim() : "";
  productId = typeof productId === "string" ? productId.trim().toLowerCase() : "";
  destino = typeof destino === "string" ? destino.trim() : "";

    // UID: token-first (prod), body fallback (emulador)
  const uidRes = await resolveUid(req, uidBody);
  if (!uidRes.ok) {
    return sendJson(res, 401, { ok: false, error: uidRes.error });
  }
  uid = uidRes.uid;

  // ENFORCEMENT (PROD): requiere email verificado
  if (!isRunningInEmulator()) {
    const token = getBearerToken(req);
    if (!token) {
      return sendJson(res, 401, { ok: false, error: "MISSING_AUTH" });
    }
    try {
      const decoded = await admin.auth().verifyIdToken(token);
      const verified = !!(decoded && decoded.email_verified);
      if (!verified) {
        return sendJson(res, 403, { ok: false, error: "EMAIL_NOT_VERIFIED" });
      }
    } catch (e) {
      return sendJson(res, 401, { ok: false, error: "INVALID_ID_TOKEN" });
    }
  }

  // Validacion UID final (por si en emulador vino vaci­o)
  if (!uid || uid.length > 128) {
    return sendJson(res, 400, { ok: false, error: "INVALID_UID" });
  }


  if (!productId || productId.length > 64) {
    return sendJson(res, 400, { ok: false, error: "INVALID_PRODUCT_ID" });
  }

  // Resolver producto: SOLO catalog_products (Firestore) — catalog-only
  let product = null;

  try {
    const snap = await db.collection("catalog_products").doc(productId).get();
    if (snap.exists) {
      const p = snap.data() || {};

      // Switch ON/OFF desde Firestore
      if (p.publish === false) {
        return sendJson(res, 400, { ok: false, error: "PRODUCT_NOT_PUBLISHED", productId });
      }

      // Detectar tipo (nauta/cubacel) por docId y/o category
      const cat = (typeof p.category === "string") ? p.category.trim().toLowerCase() : "";
      const kind = (cat === "nauta" || productId.startsWith("nauta-")) ? "nauta" : "cubacel";

      // Importe desde catálogo (EUR) + margen fijo (+1.00 EUR)
      const baseEur = Number(p.sendAmountEur);
      if (!Number.isFinite(baseEur) || baseEur <= 0) {
        return sendJson(res, 500, { ok: false, error: "INVALID_PRODUCT_AMOUNT", productId });
      }
      const amt = Math.round((baseEur + 1.0 + Number.EPSILON) * 100) / 100;

      // Currency: al usar sendAmountEur, la moneda es EUR
      const cur = "EUR";

      product = { id: productId, kind, amount: amt, currency: cur };
    }
  } catch (e) {
    logger.warn("catalog_products lookup failed", { productId, message: e && e.message ? e.message : String(e) });
  }

  if (!product) {
    return sendJson(res, 400, { ok: false, error: "UNKNOWN_PRODUCT_ID", productId });
  }

  if (!destino || destino.length > 128) {
    return sendJson(res, 400, { ok: false, error: "INVALID_DESTINO" });
  }

  // Validación de destino según tipo
  let destinoNormalized = destino;
  if (product.kind === "cubacel") {
    const n = normalizeCubacel(destino);
    if (!isValidCubacel(n)) {
      return sendJson(res, 400, { ok: false, error: "INVALID_CUBACEL_NUMBER" });
    }
    destinoNormalized = `+53${n}`;
  } else if (product.kind === "nauta") {
    const e = destino.trim().toLowerCase();
    if (!isValidNautaEmail(e)) {
      return sendJson(res, 400, { ok: false, error: "INVALID_NAUTA_EMAIL" });
    }
    destinoNormalized = e;
  }

  const amount = Number(product.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return sendJson(res, 500, { ok: false, error: "INVALID_PRODUCT_AMOUNT" });
  }

  const currency = product.currency || "EUR";

  try {
    const ref = db.collection("orders").doc();
    const orderId = ref.id;
    const nowMs = Date.now();

    await ref.set({
      uid,
      productId: product.id,
      destination: destinoNormalized,
      status: "PENDING",
      amount,
      currency,
      channel: "sandbox",
      authSource: uidRes.source, // "token" | "body"
      createdAt: FieldValue.serverTimestamp(),
      createdAtMs: nowMs,
    });

    logger.info("createOrder OK", { orderId, uid, productId: product.id, authSource: uidRes.source });

    return sendJson(res, 200, {
      ok: true,
      orderId,
      amount,
      currency,
      status: "PENDING",
    });
  } catch (err) {
    logger.error("createOrder error", err);
    return sendJson(res, 500, { ok: false, error: "INTERNAL_ERROR" });
  }
});

/**
 * Fase 3 (sandbox): markOrderPaid
 * - marca una orden PENDING -> PAID (solo sandbox)
 * - auth token-first (prod), body fallback (emulador)
 * - valida ownership (uid debe coincidir con la orden)
 */
exports.markOrderPaid = onRequest(async (req, res) => {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }

  if (!(await requireAppCheck(req, res))) return;

  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  // 🔒 MANUAL-ONLY: el status de /orders se cambia SOLO a mano en Firestore (sin endpoints)
  return sendJson(res, 403, { ok: false, error: "MANUAL_ONLY_MODE" });
});

/**
 * Fase 3 (sandbox): markOrderFailed
 * - marca una orden PENDING -> FAILED (solo sandbox)
 * - auth token-first (prod), body fallback (emulador)
 * - valida ownership (uid debe coincidir con la orden)
 * - idempotente: si ya está FAILED devuelve ok:true; si está PAID/COMPLETED devuelve ok:true con terminalState:true
 */
// BLOQUE BUENO
exports.markOrderFailed = onRequest(async (req, res) => {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }

  if (!(await requireAppCheck(req, res))) return;

  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  // 🔒 MANUAL-ONLY: el status de /orders se cambia SOLO a mano en Firestore (sin endpoints)
  return sendJson(res, 403, { ok: false, error: "MANUAL_ONLY_MODE" });
});


/**
 * Fase 3 (sandbox): markOrderCancelled
 * - marca una orden PENDING -> CANCELLED (solo sandbox)
 * - auth token-first (prod), body fallback (emulador)
 * - valida ownership (uid debe coincidir con la orden)
 * - idempotente: si ya está CANCELLED devuelve ok:true; si está FAILED/PAID/COMPLETED devuelve ok:true con terminalState:true
 * - audit log: crea /orders/{orderId}/events/{autoId}
 */
exports.markOrderCancelled = onRequest(async (req, res) => {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }

  if (!(await requireAppCheck(req, res))) return;

  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  // 🔒 MANUAL-ONLY: el status de /orders se cambia SOLO a mano en Firestore (sin endpoints)
  return sendJson(res, 403, { ok: false, error: "MANUAL_ONLY_MODE" });
});


/**
 * Fase 3 (sandbox): markOrderRefunded
 * - marca una orden PAID/COMPLETED -> REFUNDED (solo sandbox)
 * - auth token-first (prod), body fallback (emulador)
 * - valida ownership (uid debe coincidir con la orden)
 * - idempotente: si ya está REFUNDED devuelve ok:true; si está FAILED/CANCELLED devuelve ok:true con terminalState:true
 * - audit log: crea /orders/{orderId}/events/{autoId}
 */
exports.markOrderRefunded = onRequest(async (req, res) => {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }

  if (!(await requireAppCheck(req, res))) return;

  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  // 🔒 MANUAL-ONLY: el status de /orders se cambia SOLO a mano en Firestore (sin endpoints)
  return sendJson(res, 403, { ok: false, error: "MANUAL_ONLY_MODE" });
});

/**
 * Sandbox Fulfillment: cuando una order pasa a PAID, la completamos automáticamente.
 * - Solo channel: "sandbox"
 * - Solo transición PENDING -> PAID
 * - Crea/actualiza /recargas/{orderId}
 * - Actualiza order a COMPLETED con timestamps
 */
exports.onOrderPaid = onDocumentUpdated("orders/{orderId}", async (event) => {
  // ✅ MANUAL-ONLY (CONTROLLED STUB):
  // Solo corre en la transición EXACTA PENDING -> PAID (cuando tú lo cambias manualmente en Firestore).
  // No llama a proveedor. Deja audit en /orders/{orderId}/events y marca idempotencia en la orden.

  const before = (event.data && event.data.before && event.data.before.data) ? (event.data.before.data() || {}) : {};
  const after  = (event.data && event.data.after  && event.data.after.data)  ? (event.data.after.data()  || {}) : {};

  const statusFrom = String(before.status || "");
  const statusTo   = String(after.status  || "");

  // Gate estricto: SOLO PENDING -> PAID
  if (!(statusFrom === "PENDING" && statusTo === "PAID")) {
    return;
  }

  const orderId = (event.params && event.params.orderId) ? String(event.params.orderId) : "";
  if (!orderId) return;

  const orderRef = db.collection("orders").doc(orderId);
  const nowMs = Date.now();

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(orderRef);
      if (!snap.exists) return;

      const cur = snap.data() || {};
      const curStatus = String(cur.status || "");

      // Si alguien lo movió ya, no hacemos nada.
      if (curStatus !== "PAID") return;

      // Idempotencia: si ya procesamos el stub, no repetir.
      const processedMs = Number(cur.paidStubProcessedAtMs);
      if (Number.isFinite(processedMs) && processedMs > 0) return;

      // Audit event (type + statusFrom/statusTo + timestamps)
      const eventRef = orderRef.collection("events").doc();
      tx.set(eventRef, {
        type: "PAID_STUB",
        statusFrom: "PENDING",
        statusTo: "PAID",
        createdAt: FieldValue.serverTimestamp(),
        createdAtMs: nowMs,
      });

      // Marca de procesamiento (no cambia status, solo deja huella de que el stub corrió)
      tx.update(orderRef, {
        paidStubProcessedAt: FieldValue.serverTimestamp(),
        paidStubProcessedAtMs: nowMs,
        paidStubResult: "NOOP",
      });
    });

    logger.info("onOrderPaid stub OK", { orderId, statusFrom, statusTo });
  } catch (e) {
    logger.error("onOrderPaid stub ERROR", { orderId, message: String(e && e.message ? e.message : e) });
  }
});

// exports.helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", { structuredData: true });
//   response.send("Hello from Firebase!");
// });

