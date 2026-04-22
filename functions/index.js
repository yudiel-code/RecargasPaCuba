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
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentUpdated, onDocumentCreated } = require("firebase-functions/v2/firestore");
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

function isTrustedAppOrigin(originRaw) {
  const origin = String(originRaw || "").trim().toLowerCase();
  return (
    origin === "http://localhost" ||
    origin === "https://localhost" ||
    origin === "http://localhost:5173" ||
    origin === "https://localhost:5173" ||
    origin === "capacitor://localhost" ||
    origin === "ionic://localhost"
  );
}

async function requireAppCheck(req, res) {
  // En emulador, NO exigimos App Check para poder probar por cURL/PowerShell sin tocar prod.
  if (isRunningInEmulator()) return true;

  const origin = req.get("origin") || "";
  const token = req.get("X-Firebase-AppCheck") || req.get("x-firebase-appcheck") || "";

  // En la app Capacitor permitimos continuar sin App Check web.
  if (!token && isTrustedAppOrigin(origin)) {
    logger.info("appcheck_bypassed_for_trusted_app_origin", { origin });
    return true;
  }

  if (!token) {
    sendJson(res, 401, { ok: false, error: "APPCHECK_MISSING" });
    return false;
  }

  try {
    await admin.appCheck().verifyToken(token);
    return true;
  } catch (e) {
    if (isTrustedAppOrigin(origin)) {
      logger.warn("appcheck_verify_failed_but_bypassed_for_trusted_app_origin", {
        origin,
        message: String(e && e.message ? e.message : e),
      });
      return true;
    }

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
    "https://recargaspacuba-7aaa8--mantenimiento-ox2lbyd9.web.app",
    "http://localhost",
    "https://localhost",
    "http://localhost:5173",
    "https://localhost:5173",
    "capacitor://localhost",
    "ionic://localhost",
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

function pickDingApiKey() {
  return String(process.env.DING_API_KEY || process.env.DING_APIKEY || "").trim();
}

function isDingSendEnabled() {
  const v = String(process.env.DING_SEND_ENABLED || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

async function postJson(url, payload, headers = {}) {
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { httpStatus: resp.status, text, json };
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
 * - calcula importe en servidor desde el catálogo: sellAmountEur (EUR) y lo persiste en /orders.amount
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

  const payload = (body && typeof body === "object" && body.data && typeof body.data === "object")
    ? body.data
    : body;

  let { uid, productId, destino, paymentMethod } = payload;

    // Referrer (first-touch): puede venir en payload o en el body raíz si el cliente envía { data:{...}, referrer:"..." }
  const refRaw = (payload && typeof payload.referrer === "string" ? payload.referrer : "")
    || (body && typeof body.referrer === "string" ? body.referrer : "");
  const refCandidate = String(refRaw || "").trim();
  const referrer = /^[a-zA-Z0-9_-]{1,64}$/.test(refCandidate) ? refCandidate : "";


  // Compat: acepta nombres alternativos (por si el cliente manda legacy)
  if (paymentMethod == null || paymentMethod === "") {
    paymentMethod =
      payload.metodoPago ??
      payload.metodo ??
      payload.payment_method ??
      payload.payment ??
      "";
  }

  // Normaliza inputs
  const uidBody = typeof uid === "string" ? uid.trim() : "";
  productId = typeof productId === "string" ? productId.trim().toLowerCase() : "";
  destino = typeof destino === "string" ? destino.trim() : "";

  const paymentMethodUp = typeof paymentMethod === "string" ? paymentMethod.trim().toUpperCase() : "";
  if (paymentMethodUp && paymentMethodUp !== "PAYPAL" && paymentMethodUp !== "REVOLUT" && paymentMethodUp !== "BIZUM") {
    return sendJson(res, 400, { ok: false, error: "INVALID_PAYMENT_METHOD" });
  }

  // Persistimos el valor canónico para evitar null en /orders
  paymentMethod = paymentMethodUp;

    // UID: token-first (prod), body fallback (emulador)
  const uidRes = await resolveUid(req, uidBody);
  if (!uidRes.ok) {
    return sendJson(res, 401, { ok: false, error: uidRes.error });
  }
  uid = uidRes.uid;

  // ENFORCEMENT (PROD): requiere email verificado SOLO para email/password
  if (!isRunningInEmulator()) {
    const token = getBearerToken(req);
    if (!token) {
      return sendJson(res, 401, { ok: false, error: "MISSING_AUTH" });
    }
    try {
      const decoded = await admin.auth().verifyIdToken(token);

      const providers = Array.isArray(decoded?.firebase?.sign_in_provider)
        ? decoded.firebase.sign_in_provider
        : String(decoded?.firebase?.sign_in_provider || "");

      const signInProvider = String(decoded?.firebase?.sign_in_provider || "");

      // Solo exigir verificación si es email/password (provider "password")
      if (signInProvider === "password") {
        const verified = !!decoded?.email_verified;
        if (!verified) {
          return sendJson(res, 403, { ok: false, error: "EMAIL_NOT_VERIFIED" });
        }
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

  // Resolver producto: público para venta/UI, privado para datos reales de Ding
  let product = null;

  try {
    const pubSnap = await db.collection("catalog_products_ding").doc(productId).get();

    if (pubSnap.exists) {
      const p = pubSnap.data() || {};

      // Switch ON/OFF desde Firestore
      if (p.publish === false) {
        return sendJson(res, 400, { ok: false, error: "PRODUCT_NOT_PUBLISHED", productId });
      }

      // Detectar tipo (nauta/cubacel) por docId y/o category
      const cat = (typeof p.category === "string") ? p.category.trim().toLowerCase() : "";
      const kind = (cat === "nauta" || productId.startsWith("nauta-")) ? "nauta" : "cubacel";

      // Precio final del cliente desde catálogo público
      const finalPriceRaw = (p.finalPriceEur != null && p.finalPriceEur !== "") ? p.finalPriceEur : p.sellAmountEur;
      const finalPriceNum = Number(finalPriceRaw);

      if (!Number.isFinite(finalPriceNum) || finalPriceNum <= 0) {
        return sendJson(res, 500, { ok: false, error: "INVALID_FINAL_PRICE", productId });
      }

      const finalPriceEur = Math.round((finalPriceNum + Number.EPSILON) * 100) / 100;

      // Currency: al usar importes en EUR, la moneda es EUR
      const cur = "EUR";
      const provider = "ding";

      // Datos reales de Ding desde catálogo privado
      const privSnap = await db.collection("catalog_private_ding").doc(productId).get();
      const priv = privSnap.exists ? (privSnap.data() || {}) : {};

      const dingSkuCode = String(priv.dingSkuCode || "").trim();

      const dingReceiveAmount = Number.isFinite(Number(priv.dingReceiveAmount))
        ? Number(priv.dingReceiveAmount)
        : null;

      const providerSendAmountNum = Number(priv.sendAmountEur);
      const providerSendAmountEur = Number.isFinite(providerSendAmountNum)
        ? Math.round((providerSendAmountNum + Number.EPSILON) * 100) / 100
        : null;

      if (!dingSkuCode || !Number.isFinite(dingReceiveAmount) || dingReceiveAmount <= 0 || !Number.isFinite(providerSendAmountEur) || providerSendAmountEur <= 0) {
        return sendJson(res, 500, { ok: false, error: "INVALID_PRIVATE_PRODUCT_DATA", productId });
      }

      product = {
        id: productId,
        kind,
        amount: finalPriceEur,
        finalPriceEur,
        providerSendAmountEur,
        currency: cur,
        provider,
        dingSkuCode,
        dingReceiveAmount,
      };
    }
  } catch (e) {
    logger.warn("catalog_products_ding/catalog_private_ding lookup failed", { productId, message: e && e.message ? e.message : String(e) });
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

    // Coste privado (solo admin): se guarda en /orders_private/{orderId}
    // Fail-open: si no se puede leer el coste, se guarda null y NO se rompe el flujo.
    let costEur = null;
    let costRaw = "";
    let commissionPct = null;

    try {
      const s = await db.collection("catalog_private_ding").doc(product.id).get();
      if (s.exists) {
        const d = s.data() || {};
        const v = Number(d.sendAmountEur);
        costEur = Number.isFinite(v) ? Math.round((v + Number.EPSILON) * 100) / 100 : null;

        costRaw = (typeof d.sendAmountRaw === "string") ? d.sendAmountRaw : "";

        const cp = Number(d.commissionPct);
        commissionPct = Number.isFinite(cp) ? cp : null;
      }
    } catch (_) {}

const batch = db.batch();

// Referrer first-touch por UID (persistente en /users/{uid})
const userRef = db.collection("users").doc(uid);
let userReferrer = "";
try {
  const uSnap = await userRef.get();
  if (uSnap.exists) {
    const u = uSnap.data() || {};
    const uRef = String(u.referrer || "").trim();
    if (/^[a-zA-Z0-9_-]{1,64}$/.test(uRef)) userReferrer = uRef;
  }
} catch (_) {}

let refFinal = "";

// Si viene referrer en el request: se usa y se actualiza el del usuario (last-touch)
if (referrer) {
  refFinal = referrer;

  // Guarda/actualiza el referrer del usuario (sirve para que aplique “para siempre” en otros dispositivos)
  batch.set(userRef, {
    referrer: referrer,
    referrerUpdatedAt: FieldValue.serverTimestamp(),
    referrerSource: "createOrder",
  }, { merge: true });

} else if (userReferrer) {
  // Si no viene referrer, usa el último guardado del usuario
  refFinal = userReferrer;
}

batch.set(ref, {
  uid,
  orderId,
  productId: product.id,
  provider: String(product.provider || "ding"),
  ...(product.provider === "ding" && product.dingSkuCode ? { dingSkuCode: product.dingSkuCode } : {}),
  ...(product.provider === "ding" && Number.isFinite(product.dingReceiveAmount) ? { dingReceiveAmount: product.dingReceiveAmount } : {}),
  destination: destinoNormalized,
  status: "PENDING",
  amount,
  ...(Number.isFinite(product.finalPriceEur) ? { finalPriceEur: product.finalPriceEur } : {}),
  ...(Number.isFinite(product.providerSendAmountEur) ? { providerSendAmountEur: product.providerSendAmountEur } : {}),
  currency,
  paymentMethod: (typeof paymentMethod === "string" ? paymentMethod.trim().toUpperCase() : ""),
  channel: "sandbox",
  authSource: uidRes.source, // "token" | "body"
  ...(refFinal ? { referrer: refFinal } : {}),
  createdAt: FieldValue.serverTimestamp(),
  createdAtMs: nowMs,
});


const refPriv = db.collection("orders_private").doc(orderId);
batch.set(refPriv, {
  uid,
  orderId,
  productId: product.id,
  provider: String(product.provider || "ding"),
  ...(product.provider === "ding" && product.dingSkuCode ? { dingSkuCode: product.dingSkuCode } : {}),
  ...(product.provider === "ding" && Number.isFinite(product.dingReceiveAmount) ? { dingReceiveAmount: product.dingReceiveAmount } : {}),
  destination: destinoNormalized,
  amount,
  ...(Number.isFinite(product.finalPriceEur) ? { finalPriceEur: product.finalPriceEur } : {}),
  ...(Number.isFinite(product.providerSendAmountEur) ? { providerSendAmountEur: product.providerSendAmountEur } : {}),
  currency,
  paymentMethod: (typeof paymentMethod === "string" ? paymentMethod.trim().toUpperCase() : ""),
  channel: "sandbox",
  authSource: uidRes.source,
  ...(refFinal ? { referrer: refFinal } : {}),
  costEur,
  costRaw,
  commissionPct,
  createdAt: FieldValue.serverTimestamp(),
  createdAtMs: nowMs,
});


    await batch.commit();

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

/**
 * Ding fulfillment: cuando una order pasa a COMPLETED, envía a Ding si está habilitado.
 * - Solo sandbox
 * - Solo provider ding
 * - Idempotencia: providerSentAtMs
 */
exports.onOrderCompleted = onDocumentUpdated("orders/{orderId}", async (event) => {
  const before = (event.data && event.data.before && event.data.before.data) ? (event.data.before.data() || {}) : {};
  const after  = (event.data && event.data.after  && event.data.after.data)  ? (event.data.after.data()  || {}) : {};

  const statusFrom = String(before.status || "");
  const statusTo   = String(after.status  || "");

  // Gate: cualquier transición hacia COMPLETED (incluye PENDING->COMPLETED)
  if (!(statusTo === "COMPLETED" && statusFrom !== "COMPLETED")) {
    return;
  }

  // Solo sandbox (tu modo de pruebas)
  const channel = String(after.channel || "");
  if (channel !== "sandbox") return;

  const provider = String(after.provider || "ding").trim().toLowerCase();
  if (provider !== "ding") return;

  const orderId = (event.params && event.params.orderId) ? String(event.params.orderId) : "";
  if (!orderId) return;

  const orderRef = db.collection("orders").doc(orderId);
  const nowMs = Date.now();

  try {
    const snap = await orderRef.get();
    if (!snap.exists) return;

    const order = snap.data() || {};
    if (String(order.status || "") !== "COMPLETED") return;

    // Idempotencia: si ya guardamos resultado proveedor, salir
    const sentMs = Number(order.providerSentAtMs);
    if (Number.isFinite(sentMs) && sentMs > 0) return;

    const dingEnabled = isDingSendEnabled();

    if (!dingEnabled) {
      const eventRef = orderRef.collection("events").doc();
      await eventRef.set({
        type: "DING_COMPLETED_STUB",
        statusFrom,
        statusTo,
        createdAt: FieldValue.serverTimestamp(),
        createdAtMs: nowMs,
      });

      await orderRef.update({
        provider: "ding",
        providerResult: "PENDING_DING_INTEGRATION",
        completedProcessedAt: FieldValue.serverTimestamp(),
        completedProcessedAtMs: nowMs,
        completedResult: "DING_STUB",
      });

      return;
    }

    const dingApiKey = pickDingApiKey();
    const dingSkuCode = String(order.dingSkuCode || "").trim();
    const dingDestinationRaw = String(order.destination || "").trim().toLowerCase();
    const isNautaDing = isValidNautaEmail(dingDestinationRaw);

    const dingDigits = dingDestinationRaw.replace(/[^\d]/g, "");
    const dingAccountNumber = isNautaDing
      ? dingDestinationRaw
      : (
          /^53\d{8}$/.test(dingDigits)
            ? dingDigits
            : (/^5\d{7}$/.test(dingDigits) ? `53${dingDigits}` : dingDigits)
        );

    const dingSendValue = Number(
      (order.providerSendAmountEur != null && order.providerSendAmountEur !== "")
        ? order.providerSendAmountEur
        : order.amount
    );
    const dingReceiveAmount = Number(order.dingReceiveAmount);
    const hasDingReceiveAmount = Number.isFinite(dingReceiveAmount) && dingReceiveAmount > 0;

    if (!dingApiKey) {
      await orderRef.update({
        provider: "ding",
        providerResult: "ERROR",
        providerError: "DING_APIKEY_MISSING",
        providerErrorAt: FieldValue.serverTimestamp(),
        providerErrorAtMs: nowMs,
        completedProcessedAt: FieldValue.serverTimestamp(),
        completedProcessedAtMs: nowMs,
        completedResult: "PROVIDER_ERROR",
      });
      return;
    }

    if (!dingSkuCode || !dingAccountNumber || !Number.isFinite(dingSendValue) || dingSendValue <= 0) {
      await orderRef.update({
        provider: "ding",
        providerResult: "ERROR",
        providerError: "DING_ORDER_DATA_MISSING",
        providerErrorAt: FieldValue.serverTimestamp(),
        providerErrorAtMs: nowMs,
        completedProcessedAt: FieldValue.serverTimestamp(),
        completedProcessedAtMs: nowMs,
        completedResult: "PROVIDER_ERROR",
      });
      return;
    }

    const send = await postJson(
      "https://api.dingconnect.com/api/V1/SendTransfer",
      {
        SkuCode: dingSkuCode,
        SendValue: dingSendValue,
        AccountNumber: dingAccountNumber,
        DistributorRef: orderId,
        ValidateOnly: false,
      },
      {
        "Content-Type": "application/json",
        "api_key": dingApiKey,
      }
    );

    const j = send.json || {};
    const resultCode = Number(j.ResultCode);
    const ok = Number.isFinite(resultCode) && resultCode === 1;

    const transferRecord = (j && typeof j.TransferRecord === "object" && j.TransferRecord) ? j.TransferRecord : {};
    const transferId = (transferRecord && typeof transferRecord.TransferId === "object" && transferRecord.TransferId) ? transferRecord.TransferId : {};
    const processingState = String(transferRecord.ProcessingState || "");
    const transferRef = String(transferId.TransferRef || "");
    const distributorRef = String(transferId.DistributorRef || orderId);

    const errorCodes = Array.isArray(j.ErrorCodes) ? j.ErrorCodes : [];
    const providerMessage = errorCodes
      .map((e) => {
        const code = String(e && e.Code || "").trim();
        const context = String(e && e.Context || "").trim();
        return context ? `${code}:${context}` : code;
      })
      .filter(Boolean)
      .join(" | ");

    const eventRef = orderRef.collection("events").doc();
    await eventRef.set({
      type: ok ? "DING_SEND_OK" : "DING_SEND_ERROR",
      statusFrom,
      statusTo,
      createdAt: FieldValue.serverTimestamp(),
      createdAtMs: nowMs,
      providerHttpStatus: send.httpStatus,
      providerResultCode: Number.isFinite(resultCode) ? resultCode : null,
      providerStatus: processingState,
      providerMessage,
      providerTransferRef: transferRef || null,
      providerDistributorRef: distributorRef || null,
      dingSkuCode,
      ...(hasDingReceiveAmount ? { dingReceiveAmount } : {}),
      destination: dingAccountNumber,
    });

    await orderRef.update({
      provider: "ding",
      providerKey: distributorRef || orderId,
      providerHttpStatus: send.httpStatus,
      providerResultCode: Number.isFinite(resultCode) ? resultCode : null,
      providerStatus: processingState,
      providerMessage,
      providerTransferRef: transferRef || null,
      providerDistributorRef: distributorRef || null,
      providerRaw: String(send.text || "").slice(0, 10000),
      providerSentAt: FieldValue.serverTimestamp(),
      providerSentAtMs: nowMs,
      providerResult: ok ? "SENT" : "ERROR",
      completedProcessedAt: FieldValue.serverTimestamp(),
      completedProcessedAtMs: nowMs,
      completedResult: ok ? "PROVIDER_SENT" : "PROVIDER_ERROR",
    });

    logger.info("onOrderCompleted Ding send DONE", { orderId, ok, httpStatus: send.httpStatus, resultCode });
  } catch (e) {
    logger.error("onOrderCompleted Ding send ERROR", { orderId, message: String(e && e.message ? e.message : e) });
  }
});

function pickTelegramBotToken() {
  return String(
    process.env.TELEGRAM_BOT_TOKEN ||
    process.env.RPC_TELEGRAM_BOT_TOKEN ||
    ""
  ).trim();
}

function pickTelegramChatId() {
  return String(
    process.env.TELEGRAM_CHAT_ID ||
    process.env.RPC_TELEGRAM_CHAT_ID ||
    ""
  ).trim();
}

async function telegramSendMessage(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data || data.ok !== true) {
    const desc = data && data.description ? data.description : `HTTP_${resp.status}`;
    throw new Error(`TELEGRAM_SEND_FAILED:${desc}`);
  }
  return data;
}

// Notifica al crear una orden (dedupe por doc fijo en /orders/{orderId}/events/TELEGRAM_NEW_ORDER)
exports.onOrderCreatedTelegram = onDocumentCreated({ document: "orders/{orderId}", secrets: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] }, async (event) => {
  const snap = event.data;
  if (!snap) return;

  const order = snap.data() || {};
  const orderId = String(event.params?.orderId || "");

  // Ajusta filtros si quieres (por ahora: solo órdenes nuevas PENDING)
  if (String(order.status || "") !== "PENDING") return;

  const token = pickTelegramBotToken();
  const chatId = pickTelegramChatId();
  if (!token || !chatId) {
    logger.warn("telegram_config_missing", { hasToken: !!token, hasChatId: !!chatId });
    return;
  }

  const orderRef = snap.ref;
  const notifyRef = orderRef.collection("events").doc("TELEGRAM_NEW_ORDER");
  const nowMs = Date.now();

  // Estado: PENDING -> SENT (permite retry si quedó en ERROR/PENDING)
  let shouldSend = false;

  await db.runTransaction(async (tx) => {
    const n = await tx.get(notifyRef);
    const state = n.exists ? String((n.data() || {}).state || "") : "";

    if (state === "SENT") return;

    tx.set(notifyRef, {
      type: "TELEGRAM_NEW_ORDER",
      state: "PENDING",
      createdAt: FieldValue.serverTimestamp(),
      createdAtMs: nowMs,
    }, { merge: true });

    shouldSend = true;
  });

  if (!shouldSend) return;

  const text =
    `🆕 Nueva orden\n` +
    `ID: ${orderId}\n` +
    `Producto: ${String(order.productId || "-")}\n` +
    `Destino: ${String(order.destination || "-")}\n` +
    `Importe: ${String(order.amount ?? "-")} ${String(order.currency || "")}\n` +
    `Pago: ${String(order.paymentMethod || "-")}\n` +
    `Canal: ${String(order.channel || "-")}`;

  try {
    await telegramSendMessage(token, chatId, text);

    await notifyRef.set({
      state: "SENT",
      sentAt: FieldValue.serverTimestamp(),
      sentAtMs: nowMs,
    }, { merge: true });
  } catch (e) {
    await notifyRef.set({
      state: "ERROR",
      lastError: String(e && e.message ? e.message : e),
      lastAttemptAt: FieldValue.serverTimestamp(),
      lastAttemptAtMs: nowMs,
    }, { merge: true });

    // fuerza retry del trigger
    throw e;
  }
});



// Notifica cambios de estado relevantes al chat principal (RPC_TELEGRAM_CHAT_ID / TELEGRAM_CHAT_ID)
// Dedupe por /orders/{orderId}/events/TELEGRAM_STATUS_<STATUS>
exports.onOrderStatusTelegramAlerts = onDocumentUpdated(
  { document: "orders/{orderId}", secrets: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] },
  async (event) => {
    const before = event.data?.before?.data?.() || {};
    const after  = event.data?.after?.data?.()  || {};

    const statusFrom = String(before.status || "");
    const statusTo   = String(after.status  || "");

    // Ajusta aquí si quieres incluir más estados
    const interesting = new Set(["COMPLETED", "FAILED"]);
    if (!interesting.has(statusTo) || statusTo === statusFrom) return;

    const token = pickTelegramBotToken();
    const chatId = "-5180440840"; // Orden_Completed/Failed_bot (COMPLETED/FAILED)
    if (!token || !chatId) {
      logger.warn("telegram_config_missing", { hasToken: !!token, hasChatId: !!chatId });
      return;
    }

    const orderId = String(event.params?.orderId || "");
    if (!orderId) return;

    const orderRef = db.collection("orders").doc(orderId);
    const notifyRef = orderRef.collection("events").doc(`TELEGRAM_STATUS_${statusTo}`);
    const nowMs = Date.now();

    let shouldSend = false;

    await db.runTransaction(async (tx) => {
      const n = await tx.get(notifyRef);
      const state = n.exists ? String((n.data() || {}).state || "") : "";
      if (state === "SENT") return;

      tx.set(
        notifyRef,
        {
          type: `TELEGRAM_STATUS_${statusTo}`,
          state: "PENDING",
          createdAt: FieldValue.serverTimestamp(),
          createdAtMs: nowMs,
          statusFrom,
          statusTo,
        },
        { merge: true }
      );

      shouldSend = true;
    });

    if (!shouldSend) return;

    const dest = String(after.destination || "-");
    const destSafe = dest.length > 4 ? `***${dest.slice(-4)}` : dest;

    const base =
      `ID: ${orderId}\n` +
      `Producto: ${String(after.productId || "-")}\n` +
      `Destino: ${destSafe}\n` +
      `Importe: ${String(after.amount ?? "-")} ${String(after.currency || "")}\n` +
      `Pago: ${String(after.paymentMethod || "-")}\n` +
      `Canal: ${String(after.channel || "-")}`;

    const errExtra =
      statusTo === "FAILED"
        ? `\nErrorCode: ${String(after.providerErrorCode ?? "-")}\nMensaje: ${String(after.providerMessage || "-")}`
        : "";

    const header = statusTo === "FAILED" ? "❌ FAILED" : "✅ COMPLETED";
    const text = `${header}\n${base}${errExtra}`;

    try {
      await telegramSendMessage(token, chatId, text);

      await notifyRef.set(
        {
          state: "SENT",
          sentAt: FieldValue.serverTimestamp(),
          sentAtMs: nowMs,
        },
        { merge: true }
      );
    } catch (e) {
      await notifyRef.set(
        {
          state: "ERROR",
          lastError: String(e?.message || e),
          lastAttemptAt: FieldValue.serverTimestamp(),
          lastAttemptAtMs: nowMs,
        },
        { merge: true }
      );
      throw e;
    }
  }
);

exports.getAdminDashboardMetrics = onCall(async (request) => {
  const ADMIN_EMAIL = "recargaspacubaapp@gmail.com";

  // 🔒 Auth obligatorio
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  }

  const email = String(request.auth.token?.email || "").toLowerCase();
  if (email !== ADMIN_EMAIL) {
    throw new HttpsError("permission-denied", "NOT_ADMIN");
  }

  // App Check opcional en admin (Auth + email admin ya protegen)
  if (!isRunningInEmulator() && !request.app) {
    logger.warn("admin_callable_appcheck_missing");
  }

  const nowMs = Date.now();
  const last24hMs = nowMs - (24 * 60 * 60 * 1000);

  // Inicio de “hoy” en horario Canarias (Atlantic/Canary)
  function startOfTodayCanaryMs() {
    const tz = "Atlantic/Canary";
    const now = new Date();

    const ymd = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);

    const y = Number(ymd.find(p => p.type === "year")?.value);
    const m = Number(ymd.find(p => p.type === "month")?.value);
    const d = Number(ymd.find(p => p.type === "day")?.value);

    const utcMidnight = Date.UTC(y, m - 1, d, 0, 0, 0);

    const hms = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(utcMidnight));

    const hh = Number(hms.find(p => p.type === "hour")?.value || "0");
    const mm = Number(hms.find(p => p.type === "minute")?.value || "0");
    const ss = Number(hms.find(p => p.type === "second")?.value || "0");

    const localSec = (hh * 3600) + (mm * 60) + ss; // 0 o 3600 en Canarias
    return utcMidnight - (localSec * 1000);
  }

  const startTodayMs = startOfTodayCanaryMs();

  // Recargas (COMPLETED) últimas 24h (por createdAtMs)
  const snap24h = await db.collection("orders")
    .where("status", "==", "COMPLETED")
    .where("createdAtMs", ">=", last24hMs)
    .get();

  const recargas24h = snap24h.size;

  // Ventas de hoy (COMPLETED desde 00:00 Canarias)
  const snapHoy = await db.collection("orders")
    .where("status", "==", "COMPLETED")
    .where("createdAtMs", ">=", startTodayMs)
    .get();

  let ventasHoyEur = 0;
  for (const doc of snapHoy.docs) {
    const o = doc.data() || {};
    const cur = String(o.currency || "").toUpperCase();
    const amt = Number(o.amount);
    if (cur === "EUR" && Number.isFinite(amt)) ventasHoyEur += amt;
  }
  ventasHoyEur = Math.round((ventasHoyEur + Number.EPSILON) * 100) / 100;

  // Usuarios: proxy = cantidad de docs en /users (usuarios que han tenido actividad)
  const usersSnap = await db.collection("users").get();
  const usuariosTotal = usersSnap.size;

  return {
    ok: true,
    recargas24h,
    ventasHoyEur,
    usuariosTotal,
    tz: "Atlantic/Canary",
  };
});

exports.getAdminSales = onCall(async (request) => {
  const ADMIN_EMAIL = "recargaspacubaapp@gmail.com";

  // 🔒 Auth obligatorio
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  }

  const email = String(request.auth.token?.email || "").toLowerCase();
  if (email !== ADMIN_EMAIL) {
    throw new HttpsError("permission-denied", "NOT_ADMIN");
  }

// App Check opcional en admin: ya hay Auth + email admin
// (no bloquear si falta request.app)


  const rawLimit = request.data?.limit;
  let limit = Number(rawLimit);
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  limit = Math.min(200, Math.floor(limit));

  // No requiere índice compuesto: solo orderBy(createdAtMs)
  const snap = await db.collection("orders")
    .orderBy("createdAtMs", "desc")
    .limit(limit)
    .select("orderId", "productId", "destination", "amount", "currency", "createdAtMs", "status", "paymentMethod", "channel", "referrer")
    .get();

  const items = snap.docs.map((d) => {
    const o = d.data() || {};
    return {
      id: String(o.orderId || d.id),
      destination: String(o.destination || ""),
      productId: String(o.productId || ""),
      amount: (o.amount != null ? Number(o.amount) : null),
      currency: String(o.currency || "EUR"),
      createdAtMs: Number(o.createdAtMs || 0),
      status: String(o.status || ""),
      paymentMethod: String(o.paymentMethod || ""),
      channel: String(o.channel || ""),
      referrer: String(o.referrer || ""),
    };
  });

  return { ok: true, limit, count: items.length, items };
});

exports.getAdminEarnings = onCall(async (request) => {
  const ADMIN_EMAIL = "recargaspacubaapp@gmail.com";
  const ADMIN_TZ = "Atlantic/Canary";

  // 🔒 Auth obligatorio
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  }

  const email = String(request.auth.token?.email || "").toLowerCase();
  if (email !== ADMIN_EMAIL) {
    throw new HttpsError("permission-denied", "NOT_ADMIN");
  }

  // App Check opcional en admin: ya hay Auth + email admin
  // (no bloquear si falta request.app)

  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  const tzParts = (ms) => {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: ADMIN_TZ,
      hour12: false,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts = dtf.formatToParts(new Date(ms));
    const m = {};
    for (const p of parts) if (p.type !== "literal") m[p.type] = p.value;

    let y = Number(m.year);
    let mo = Number(m.month);
    let d = Number(m.day);
    let hh = Number(m.hour);
    const mm = Number(m.minute);
    const ss = Number(m.second);

    // Normaliza el caso raro "24:xx" (medianoche) que rompe el cálculo de offset
    if (hh === 24) {
      const dt = new Date(Date.UTC(y, mo - 1, d, 0, 0, 0));
      dt.setUTCDate(dt.getUTCDate() + 1);
      y = dt.getUTCFullYear();
      mo = dt.getUTCMonth() + 1;
      d = dt.getUTCDate();
      hh = 0;
    }

    return { y, mo, d, hh, mm, ss };
  };

  const tzOffsetMsAt = (ms) => {
    const p = tzParts(ms);
    const asUTC = Date.UTC(p.y, p.mo - 1, p.d, p.hh, p.mm, p.ss);
    return asUTC - ms;
  };

  const tzStartOfDayFromYMD = (y, mo, d) => {
    const baseUTC = Date.UTC(y, mo - 1, d, 0, 0, 0);
    let guess = baseUTC;
    for (let i = 0; i < 2; i++) {
      const off = tzOffsetMsAt(guess);
      guess = baseUTC - off;
    }
    return guess;
  };

  const nowMs = Date.now();
  const nowP = tzParts(nowMs);

  // "Hoy" se calcula por dayKeyCanary (no por rangos start/end).

  const startMonthMs = tzStartOfDayFromYMD(nowP.y, nowP.mo, 1);
  const nextMonthY = (nowP.mo === 12) ? (nowP.y + 1) : nowP.y;
  const nextMonthM = (nowP.mo === 12) ? 1 : (nowP.mo + 1);
  const startNextMonthMs = tzStartOfDayFromYMD(nextMonthY, nextMonthM, 1);

  const getAllDocs = async (refs) => {
    if (!refs.length) return [];
    if (typeof db.getAll === "function") return await db.getAll(...refs);
    return await Promise.all(refs.map((r) => r.get()));
  };

  const sumProfitInRange = async (startMs, endMs) => {
    const snap = await db.collection("orders")
      .where("createdAtMs", ">=", startMs)
      .where("createdAtMs", "<", endMs)
      .orderBy("createdAtMs", "asc")
      .select("status", "amount", "currency", "orderId", "createdAtMs")
      .get();

    const completed = [];
    for (const doc of snap.docs) {
      const o = doc.data() || {};
      const status = String(o.status || "");
      const currency = String(o.currency || "EUR").toUpperCase();
      const amount = (o.amount != null ? Number(o.amount) : NaN);

      if (status !== "COMPLETED") continue;
      if (currency !== "EUR") continue;
      if (!Number.isFinite(amount)) continue;

      completed.push({
        docId: doc.id,
        orderId: String(o.orderId || doc.id),
        amount,
      });
    }

    const privRefs = completed.map((x) => db.collection("orders_private").doc(x.docId));
    const privDocs = await getAllDocs(privRefs);
    const privById = new Map(privDocs.map((d) => [d.id, d]));

    let profit = 0;
    let missingCost = 0;

    for (const o of completed) {
      let pdoc = privById.get(o.docId) || null;

      // Fallback barato (solo para rangos acotados) si el docId no coincide con orderId
      if ((!pdoc || !pdoc.exists) && o.orderId && o.orderId !== o.docId) {
        const alt = await db.collection("orders_private").doc(o.orderId).get();
        if (alt && alt.exists) pdoc = alt;
      }

      const pdata = (pdoc && pdoc.exists) ? (pdoc.data() || {}) : null;
      const cost = pdata && (pdata.costEur != null) ? Number(pdata.costEur) : NaN;

      if (!Number.isFinite(cost)) {
        missingCost++;
        continue;
      }

      profit += (o.amount - cost);
    }

    return {
      scanned: snap.size,
      completed: completed.length,
      missingCost,
      profitEur: round2(profit),
    };
  };

  const sumProfitTotal = async () => {
    const PAGE = 500;
    const MAX_SCAN = 5000; // protección anti-timeout
    let last = null;
    let scanned = 0;
    let profit = 0;
    let completed = 0;
    let missingCost = 0;
    let truncated = false;

    while (true) {
      let q = db.collection("orders")
        .orderBy("createdAtMs", "asc")
        .limit(PAGE)
        .select("status", "amount", "currency", "orderId", "createdAtMs");

      if (last) q = q.startAfter(last);

      const snap = await q.get();
      if (snap.empty) break;

      scanned += snap.size;

      const batchCompleted = [];
      for (const doc of snap.docs) {
        const o = doc.data() || {};
        const status = String(o.status || "");
        const currency = String(o.currency || "EUR").toUpperCase();
        const amount = (o.amount != null ? Number(o.amount) : NaN);

        if (status !== "COMPLETED") continue;
        if (currency !== "EUR") continue;
        if (!Number.isFinite(amount)) continue;

        batchCompleted.push({ docId: doc.id, amount });
      }

      const privRefs = batchCompleted.map((x) => db.collection("orders_private").doc(x.docId));
      const privDocs = await getAllDocs(privRefs);
      const privById = new Map(privDocs.map((d) => [d.id, d]));

      for (const o of batchCompleted) {
        const pdoc = privById.get(o.docId);
        const pdata = (pdoc && pdoc.exists) ? (pdoc.data() || {}) : null;
        const cost = pdata && (pdata.costEur != null) ? Number(pdata.costEur) : NaN;

        if (!Number.isFinite(cost)) {
          missingCost++;
          continue;
        }

        completed++;
        profit += (o.amount - cost);
      }

      last = snap.docs[snap.docs.length - 1];

      if (scanned >= MAX_SCAN) {
        truncated = true;
        break;
      }
    }

    return {
      scanned,
      completed,
      missingCost,
      truncated,
      profitEur: round2(profit),
    };
  };

  const dayKeyCanary = (ms) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: ADMIN_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(ms));
    const m = {};
    for (const p of parts) if (p.type !== "literal") m[p.type] = p.value;
    return `${m.year}-${m.month}-${m.day}`; // YYYY-MM-DD
  };

  const sumProfitTodayCanary = async () => {
    const todayKey = dayKeyCanary(nowMs);
    const fromMs = nowMs - (36 * 60 * 60 * 1000); // ventana segura

    const snap = await db.collection("orders")
      .where("createdAtMs", ">=", fromMs)
      .orderBy("createdAtMs", "asc")
      .select("status", "amount", "currency", "orderId", "createdAtMs")
      .get();

    const completedToday = [];
    for (const doc of snap.docs) {
      const o = doc.data() || {};
      const status = String(o.status || "");
      const currency = String(o.currency || "EUR").toUpperCase();
      const amount = (o.amount != null ? Number(o.amount) : NaN);
      const createdAtMs = Number(o.createdAtMs || 0);

      if (status !== "COMPLETED") continue;
      if (currency !== "EUR") continue;
      if (!Number.isFinite(amount)) continue;
      if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) continue;

      if (dayKeyCanary(createdAtMs) !== todayKey) continue;

      completedToday.push({
        docId: doc.id,
        orderId: String(o.orderId || doc.id),
        amount,
      });
    }

    const privRefs = completedToday.map((x) => db.collection("orders_private").doc(x.docId));
    const privDocs = await getAllDocs(privRefs);
    const privById = new Map(privDocs.map((d) => [d.id, d]));

    let profit = 0;
    let missingCost = 0;

    for (const o of completedToday) {
      let pdoc = privById.get(o.docId) || null;

      // fallback si orders_private usa orderId como docId
      if ((!pdoc || !pdoc.exists) && o.orderId && o.orderId !== o.docId) {
        const alt = await db.collection("orders_private").doc(o.orderId).get();
        if (alt && alt.exists) pdoc = alt;
      }

      const pdata = (pdoc && pdoc.exists) ? (pdoc.data() || {}) : null;
      const cost = pdata && (pdata.costEur != null) ? Number(pdata.costEur) : NaN;

      if (!Number.isFinite(cost)) {
        missingCost++;
        continue;
      }

      profit += (o.amount - cost);
    }

    return {
      scanned: snap.size,
      completed: completedToday.length,
      missingCost,
      profitEur: round2(profit),
    };
  };

  const today = await sumProfitTodayCanary();
  const month = await sumProfitInRange(startMonthMs, startNextMonthMs);
  const total = await sumProfitTotal();

  return {
    ok: true,
    tz: ADMIN_TZ,
    todayEur: today.profitEur,
    monthEur: month.profitEur,
    totalEur: total.profitEur,
    debug: { today, month, total },
  };
});

exports.getAdminStats = onCall(async (request) => {
  const ADMIN_EMAIL = "recargaspacubaapp@gmail.com";
  const ADMIN_TZ = "Atlantic/Canary";

  // 🔒 Auth obligatorio
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  }

  const email = String(request.auth.token?.email || "").toLowerCase();
  if (email !== ADMIN_EMAIL) {
    throw new HttpsError("permission-denied", "NOT_ADMIN");
  }

  // App Check opcional en admin: ya hay Auth + email admin
  if (!isRunningInEmulator() && !request.app) {
    logger.warn("admin_stats_appcheck_missing");
  }

  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  // Helpers TZ (Atlantic/Canary) para presets tipo "today"/"month"
  const tzParts = (ms) => {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: ADMIN_TZ,
      hour12: false,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts = dtf.formatToParts(new Date(ms));
    const m = {};
    for (const p of parts) if (p.type !== "literal") m[p.type] = p.value;

    let y = Number(m.year);
    let mo = Number(m.month);
    let d = Number(m.day);
    let hh = Number(m.hour);
    const mm = Number(m.minute);
    const ss = Number(m.second);

    // Normaliza "24:xx"
    if (hh === 24) {
      const dt = new Date(Date.UTC(y, mo - 1, d, 0, 0, 0));
      dt.setUTCDate(dt.getUTCDate() + 1);
      y = dt.getUTCFullYear();
      mo = dt.getUTCMonth() + 1;
      d = dt.getUTCDate();
      hh = 0;
    }

    return { y, mo, d, hh, mm, ss };
  };

  const tzOffsetMsAt = (ms) => {
    const p = tzParts(ms);
    const asUTC = Date.UTC(p.y, p.mo - 1, p.d, p.hh, p.mm, p.ss);
    return asUTC - ms;
  };

  const tzStartOfDayFromYMD = (y, mo, d) => {
    const baseUTC = Date.UTC(y, mo - 1, d, 0, 0, 0);
    let guess = baseUTC;
    for (let i = 0; i < 2; i++) {
      const off = tzOffsetMsAt(guess);
      guess = baseUTC - off;
    }
    return guess;
  };

  // Validación básica
  const module = String(request.data?.module || "").trim() || "overview";
  if (module !== "overview") {
    throw new HttpsError("invalid-argument", "UNKNOWN_MODULE");
  }

  const nowMs = Date.now();

  // range puede venir como { preset, startMs, endMs } o vacío (default 30d)
  const rangeIn = (request.data && typeof request.data.range === "object" && request.data.range) ? request.data.range : {};
  const presetIn = String(rangeIn.preset || request.data?.preset || "30d").trim().toLowerCase();

  let startMs = Number(rangeIn.startMs);
  let endMs = Number(rangeIn.endMs);

  const preset = (presetIn === "today" || presetIn === "7d" || presetIn === "30d" || presetIn === "month" || presetIn === "custom")
    ? presetIn
    : "30d";

  if (preset === "custom") {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs <= 0 || endMs <= 0 || endMs <= startMs) {
      throw new HttpsError("invalid-argument", "INVALID_RANGE");
    }
  } else if (preset === "today") {
    const p = tzParts(nowMs);
    startMs = tzStartOfDayFromYMD(p.y, p.mo, p.d);
    endMs = startMs + (24 * 60 * 60 * 1000);
  } else if (preset === "month") {
    const p = tzParts(nowMs);
    startMs = tzStartOfDayFromYMD(p.y, p.mo, 1);
    const nextY = (p.mo === 12) ? (p.y + 1) : p.y;
    const nextM = (p.mo === 12) ? 1 : (p.mo + 1);
    endMs = tzStartOfDayFromYMD(nextY, nextM, 1);
  } else if (preset === "7d") {
    endMs = nowMs;
    startMs = nowMs - (7 * 24 * 60 * 60 * 1000);
  } else {
    // 30d default
    endMs = nowMs;
    startMs = nowMs - (30 * 24 * 60 * 60 * 1000);
  }

  // Protección anti-scan
  const MAX_RANGE_DAYS = 400;
  const spanDays = (endMs - startMs) / (24 * 60 * 60 * 1000);
  if (!Number.isFinite(spanDays) || spanDays <= 0 || spanDays > MAX_RANGE_DAYS) {
    throw new HttpsError("invalid-argument", "RANGE_TOO_LARGE");
  }

  const getAllDocs = async (refs) => {
    if (!refs.length) return [];
    if (typeof db.getAll === "function") return await db.getAll(...refs);
    return await Promise.all(refs.map((r) => r.get()));
  };

  // Query principal (solo por createdAtMs para minimizar necesidad de índices)
  const snap = await db.collection("orders")
    .where("createdAtMs", ">=", startMs)
    .where("createdAtMs", "<", endMs)
    .select("status", "amount", "currency", "uid", "orderId", "createdAtMs")
    .get();

  const completed = [];
  let revenue = 0;

  const buyers = new Set();

  for (const doc of snap.docs) {
    const o = doc.data() || {};
    const status = String(o.status || "");
    if (status !== "COMPLETED") continue;

    const cur = String(o.currency || "EUR").toUpperCase();
    if (cur !== "EUR") continue;

    const amt = (o.amount != null) ? Number(o.amount) : NaN;
    if (!Number.isFinite(amt)) continue;

    const uid = String(o.uid || "");
    if (uid) buyers.add(uid);

    revenue += amt;

    completed.push({
      docId: doc.id,
      orderId: String(o.orderId || doc.id),
      amount: amt,
    });
  }

  // Profit (amount - costEur) leyendo orders_private (solo backend)
  const privRefs = completed.map((x) => db.collection("orders_private").doc(x.docId));
  const privDocs = await getAllDocs(privRefs);
  const privById = new Map(privDocs.map((d) => [d.id, d]));

  let profit = 0;
  let missingPriv = 0;
  let missingCost = 0;

  for (const o of completed) {
    let pdoc = privById.get(o.docId) || null;

    // Fallback si orders_private usa orderId como docId (casos legacy)
    if ((!pdoc || !pdoc.exists) && o.orderId && o.orderId !== o.docId) {
      missingPriv++;
      const alt = await db.collection("orders_private").doc(o.orderId).get();
      if (alt && alt.exists) pdoc = alt;
    }

    const pdata = (pdoc && pdoc.exists) ? (pdoc.data() || {}) : null;
    const cost = pdata && (pdata.costEur != null) ? Number(pdata.costEur) : NaN;

    if (!Number.isFinite(cost)) {
      missingCost++;
      continue;
    }

    profit += (o.amount - cost);
  }

  return {
    ok: true,
    module: "overview",
    tz: ADMIN_TZ,
    range: { preset, startMs, endMs },
    summary: {
      completedCount: completed.length,
      revenueEur: round2(revenue),
      profitEur: round2(profit),
      uniqueBuyers: buyers.size,
    },
    debug: {
      scanned: snap.size,
      completed: completed.length,
      missingPriv,
      missingCost,
    },
  };
});

exports.requestAccountDeletion = onCall(async (request) => {
  const nombre = String(request.data?.nombre || "").trim();
  const correo = String(request.data?.correo || "").trim().toLowerCase();
  const uidInput = String(request.data?.uid || "").trim();
  const motivo = String(request.data?.motivo || "").trim();

  if (!nombre || nombre.length > 120) {
    throw new HttpsError("invalid-argument", "INVALID_NAME");
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo) || correo.length > 160) {
    throw new HttpsError("invalid-argument", "INVALID_EMAIL");
  }

  if (uidInput && uidInput.length > 128) {
    throw new HttpsError("invalid-argument", "INVALID_UID");
  }

  if (motivo.length > 1000) {
    throw new HttpsError("invalid-argument", "COMMENT_TOO_LONG");
  }

  const authUid = String(request.auth?.uid || "").trim();
  const authEmail = String(request.auth?.token?.email || "").trim().toLowerCase();
  const authPhone = String(request.auth?.token?.phone_number || "").trim();

  const ref = db.collection("account_deletion_requests").doc();
  const nowMs = Date.now();

  await ref.set({
    requestId: ref.id,
    status: "PENDING",
    source: "public",
    nombre,
    correo,
    uid: uidInput || authUid || "",
    submittedUid: uidInput || "",
    motivo,
    authUid: authUid || "",
    authEmail: authEmail || "",
    authPhone: authPhone || "",
    createdAt: FieldValue.serverTimestamp(),
    createdAtMs: nowMs,
  });

  return {
    ok: true,
    requestId: ref.id,
    status: "PENDING",
  };
});

exports.requestAccountDeletionAuth = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  }

  const nombre = String(request.data?.nombre || "").trim();
  const motivo = String(request.data?.motivo || "").trim();

  if (!nombre || nombre.length > 120) {
    throw new HttpsError("invalid-argument", "INVALID_NAME");
  }

  if (motivo.length > 1000) {
    throw new HttpsError("invalid-argument", "COMMENT_TOO_LONG");
  }

  const authUid = String(request.auth.uid || "").trim();
  const authEmail = String(request.auth.token?.email || "").trim().toLowerCase();
  const authPhone = String(request.auth.token?.phone_number || "").trim();
  const contacto = authEmail || authPhone;

  if (!authUid || authUid.length > 128) {
    throw new HttpsError("failed-precondition", "AUTH_UID_MISSING");
  }

  if (!contacto || contacto.length > 160) {
    throw new HttpsError("failed-precondition", "AUTH_CONTACT_MISSING");
  }

  if (authEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(authEmail)) {
    throw new HttpsError("failed-precondition", "AUTH_EMAIL_INVALID");
  }

  const ref = db.collection("account_deletion_requests").doc();
  const nowMs = Date.now();

  await ref.set({
    requestId: ref.id,
    status: "PENDING",
    source: "authenticated",
    nombre,
    correo: contacto,
    uid: authUid,
    motivo,
    authUid,
    authEmail,
    authPhone,
    createdAt: FieldValue.serverTimestamp(),
    createdAtMs: nowMs,
  });

  return {
    ok: true,
    requestId: ref.id,
    status: "PENDING",
  };
});

// exports.helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", { structuredData: true });
//   response.send("Hello from Firebase!");
// });
