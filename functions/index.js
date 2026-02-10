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

async function requireAppCheck(req, res) {
  // En emulador, NO exigimos App Check para poder probar por cURL/PowerShell sin tocar prod.
  if (isRunningInEmulator()) return true;

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

  // Resolver producto: preferente catalog_products_innoverit, fallback catalog_products
  let product = null;

  try {
    const collections = ["catalog_products_innoverit", "catalog_products"];
    let snap = null;

    for (const c of collections) {
      const s = await db.collection(c).doc(productId).get();
      if (s.exists) { snap = s; break; }
    }

    if (snap && snap.exists) {
      const p = snap.data() || {};

      // Switch ON/OFF desde Firestore
      if (p.publish === false) {
        return sendJson(res, 400, { ok: false, error: "PRODUCT_NOT_PUBLISHED", productId });
      }

      // Detectar tipo (nauta/cubacel) por docId y/o category
      const cat = (typeof p.category === "string") ? p.category.trim().toLowerCase() : "";
      const kind = (cat === "nauta" || productId.startsWith("nauta-")) ? "nauta" : "cubacel";

      // Importe desde catálogo (EUR): SOLO sellAmountEur (sin fallback, sin +1)
      const sellEur = Number((p.sellAmountEur != null && p.sellAmountEur !== "") ? p.sellAmountEur : p.sendAmountEur);

      if (!Number.isFinite(sellEur) || sellEur <= 0) {
        return sendJson(res, 500, { ok: false, error: "INVALID_SELL_AMOUNT", productId });
      }

      const amt = Math.round((sellEur + Number.EPSILON) * 100) / 100;

      // Currency: al usar importes en EUR, la moneda es EUR
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

    // Coste privado (solo admin): se guarda en /orders_private/{orderId}
    // Fail-open: si no se puede leer el coste, se guarda null y NO se rompe el flujo.
    let costEur = null;
    let costRaw = "";
    let commissionPct = null;

    try {
      const privCols = ["catalog_private_innoverit", "catalog_private"];
      for (const c of privCols) {
        const s = await db.collection(c).doc(product.id).get();
        if (!s.exists) continue;

        const d = s.data() || {};
        const v = Number(d.sendAmountEur);
        costEur = Number.isFinite(v) ? Math.round((v + Number.EPSILON) * 100) / 100 : null;

        costRaw = (typeof d.sendAmountRaw === "string") ? d.sendAmountRaw : "";

        const cp = Number(d.commissionPct);
        commissionPct = Number.isFinite(cp) ? cp : null;

        break;
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
  destination: destinoNormalized,
  status: "PENDING",
  amount,
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
  destination: destinoNormalized,
  amount,
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

exports.migrateCatalogCostsToPrivate = onRequest(async (req, res) => {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });

  // Solo admin (por ID token)
  const token = getBearerToken(req);
  if (!token) return sendJson(res, 401, { ok: false, error: "MISSING_AUTH" });

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(token);
  } catch (e) {
    return sendJson(res, 401, { ok: false, error: "INVALID_ID_TOKEN" });
  }

  const email = String(decoded?.email || "").toLowerCase();
  const verified = !!decoded?.email_verified;
  if (!verified || email !== "recargaspacubaapp@gmail.com") {
    return sendJson(res, 403, { ok: false, error: "NOT_ADMIN" });
  }

  try {
    const snap = await db.collection("catalog_products_innoverit").get();

    let moved = 0;
    let skipped = 0;

    let batch = db.batch();
    let ops = 0;
    let commits = 0;

    for (const d of snap.docs) {
      const p = d.data() || {};
      const hasAny =
        p.sendAmountEur != null ||
        p.sendAmountRaw != null ||
        p.commissionPct != null;

      if (!hasAny) { skipped++; continue; }

      const privRef = db.collection("catalog_private_innoverit").doc(d.id);
      const privPatch = {
        ...(p.sendAmountEur != null ? { sendAmountEur: p.sendAmountEur } : {}),
        ...(p.sendAmountRaw != null ? { sendAmountRaw: p.sendAmountRaw } : {}),
        ...(p.commissionPct != null ? { commissionPct: p.commissionPct } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      };

      batch.set(privRef, privPatch, { merge: true }); ops++;

      batch.update(d.ref, {
        sendAmountEur: FieldValue.delete(),
        sendAmountRaw: FieldValue.delete(),
        commissionPct: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      }); ops++;

      moved++;

      // 500 ops máx por batch; dejamos margen
      if (ops >= 450) {
        await batch.commit();
        commits++;
        batch = db.batch();
        ops = 0;
      }
    }

    if (ops > 0) {
      await batch.commit();
      commits++;
    }

    return sendJson(res, 200, { ok: true, moved, skipped, commits, total: snap.size });
  } catch (e) {
    logger.error("migrateCatalogCostsToPrivate error", e);
    return sendJson(res, 500, { ok: false, error: "INTERNAL_ERROR" });
  }
});

exports.migrateCatalogProviderToPrivate = onRequest(async (req, res) => {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });

  // Solo admin (por ID token)
  const token = getBearerToken(req);
  if (!token) return sendJson(res, 401, { ok: false, error: "MISSING_AUTH" });

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(token);
  } catch (e) {
    return sendJson(res, 401, { ok: false, error: "INVALID_ID_TOKEN" });
  }

  const email = String(decoded?.email || "").toLowerCase();
  const verified = !!decoded?.email_verified;
  if (!verified || email !== "recargaspacubaapp@gmail.com") {
    return sendJson(res, 403, { ok: false, error: "NOT_ADMIN" });
  }

  try {
    const snap = await db.collection("catalog_products_innoverit").get();

    let moved = 0;
    let skipped = 0;

    let batch = db.batch();
    let ops = 0;
    let commits = 0;

    for (const d of snap.docs) {
      const p = d.data() || {};
      const provider = (typeof p.provider === "string") ? p.provider.trim() : "";

      if (!provider) { skipped++; continue; }

      const privRef = db.collection("catalog_private_innoverit").doc(d.id);

      batch.set(privRef, {
        provider,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      ops++;

      batch.update(d.ref, {
        provider: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      ops++;

      moved++;

      if (ops >= 450) {
        await batch.commit();
        commits++;
        batch = db.batch();
        ops = 0;
      }
    }

    if (ops > 0) {
      await batch.commit();
      commits++;
    }

    return sendJson(res, 200, { ok: true, moved, skipped, commits, total: snap.size });
  } catch (e) {
    logger.error("migrateCatalogProviderToPrivate error", e);
    return sendJson(res, 500, { ok: false, error: "INTERNAL_ERROR" });
  }
});


// onCall ya está importado arriba (evitar redeclare)

/**
 * Admin Dashboard Metrics (callable)
 * - No abre lecturas globales en cliente (agrega en backend)
 * - Requiere sesión Firebase (request.auth)
 * - Solo recargaspacubaapp@gmail.com
 */
exports.getAdminDashboardMetrics = onCall(async (request) => {
  const t0 = Date.now();

  try {
    if (!request.auth) {
      logger.warn("admin_metrics_missing_auth");
      return { ok: false, error: "MISSING_AUTH" };
    }

    const email = String(request.auth?.token?.email || "").toLowerCase();
    if (email !== "recargaspacubaapp@gmail.com") {
      logger.warn("admin_metrics_not_admin", { email });
      return { ok: false, error: "NOT_ADMIN" };
    }

    logger.info("admin_metrics_start", { email });

    const nowMs = Date.now();
    const cutoffMs = nowMs - 24 * 60 * 60 * 1000;

    let recargasHoy = 0;
    let ventasHoyEur = 0;
    let ordersScanned = 0;

    try {
      const snap = await db
        .collection("orders")
        .where("createdAtMs", ">=", cutoffMs)
        .select("status", "amount", "currency", "createdAtMs")
        .get();

      ordersScanned = snap.size;

      for (const d of snap.docs) {
        const o = d.data() || {};
        if (String(o.status || "") !== "COMPLETED") continue;

        recargasHoy++;

        const cur = String(o.currency || "EUR").toUpperCase();
        const amt = Number(o.amount);
        if (cur === "EUR" && Number.isFinite(amt)) ventasHoyEur += amt;
      }
    } catch (e) {
      logger.error("admin_metrics_orders_query_error", {
        message: String(e?.message || e),
        stack: String(e?.stack || ""),
      });
    }

    ventasHoyEur = Math.round((ventasHoyEur + Number.EPSILON) * 100) / 100;

    let usuariosTotal = 0;

    try {
      let nextPageToken = undefined;
      let scanned = 0;
      const MAX_USERS_SCAN = 5000;

      do {
        const r = await admin.auth().listUsers(1000, nextPageToken);
        const n = Array.isArray(r.users) ? r.users.length : 0;
        usuariosTotal += n;
        scanned += n;
        nextPageToken = r.pageToken;

        if (scanned >= MAX_USERS_SCAN) {
          logger.warn("admin_metrics_users_cap_reached", { MAX_USERS_SCAN });
          break;
        }
      } while (nextPageToken);
    } catch (e) {
      logger.error("admin_metrics_listUsers_error", {
        message: String(e?.message || e),
        stack: String(e?.stack || ""),
      });
      usuariosTotal = 0; // fail-open
    }

    logger.info("admin_metrics_ok", {
      recargasHoy,
      ventasHoyEur,
      usuariosTotal,
      ordersScanned,
      ms: Date.now() - t0,
    });

    return {
      ok: true,
      windowHours: 24,
      cutoffMs,
      recargasHoy,
      ventasHoyEur,
      usuariosTotal,
    };
  } catch (e) {
    logger.error("admin_metrics_fatal", {
      message: String(e?.message || e),
      stack: String(e?.stack || ""),
    });
    return { ok: false, error: "INTERNAL_ERROR" };
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
 * STATUS_REFRESH (Innoverit): refresca el estado del envío y lo guarda en /orders + /events
 * - Requiere App Check
 * - Requiere auth en prod (token Bearer) y valida ownership (uid de la orden)
 * - NO cambia status de la orden, solo actualiza provider*
 */
exports.refreshInnoveritStatus = onRequest(async (req, res) => {
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

  let { uid, orderId } = payload;

  const uidBody = typeof uid === "string" ? uid.trim() : "";
  orderId = typeof orderId === "string" ? orderId.trim() : "";

  if (!orderId || orderId.length > 128) {
    return sendJson(res, 400, { ok: false, error: "INVALID_ORDER_ID" });
  }

  // UID: token-first (prod), body fallback (emulador)
  const uidRes = await resolveUid(req, uidBody);
  if (!uidRes.ok) {
    return sendJson(res, 401, { ok: false, error: uidRes.error });
  }
  uid = uidRes.uid;

  function pickInnoveritApiKey() {
    let k = String(process.env.INNOVERIT_APIKEY || process.env.INNOVERIT_API_KEY || "").trim();
    if (k) return k;
    try {
      const cfg = require("firebase-functions").config();
      k = String((cfg && cfg.innoverit && cfg.innoverit.apikey) ? cfg.innoverit.apikey : "").trim();
      return k;
    } catch (_) {
      return "";
    }
  }

  async function postForm(url, paramsObj) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(paramsObj || {})) body.set(k, String(v));
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { httpStatus: resp.status, text, json };
  }

  const nowMs = Date.now();
  const orderRef = db.collection("orders").doc(orderId);

  try {
    const snap = await orderRef.get();
    if (!snap.exists) {
      return sendJson(res, 404, { ok: false, error: "ORDER_NOT_FOUND", orderId });
    }

    const order = snap.data() || {};

    // ownership
    const ownerUid = String(order.uid || "");
    if (!ownerUid || ownerUid !== uid) {
      return sendJson(res, 403, { ok: false, error: "FORBIDDEN", orderId });
    }

    // solo innoverit + sandbox (para no tocar prod sin querer)
    if (String(order.provider || "innoverit").toLowerCase() !== "innoverit") {
      return sendJson(res, 400, { ok: false, error: "NOT_INNOVERIT_ORDER", orderId });
    }
    if (String(order.channel || "") !== "sandbox") {
      return sendJson(res, 400, { ok: false, error: "NOT_SANDBOX_ORDER", orderId });
    }

    const apiKey = pickInnoveritApiKey();
    if (!apiKey) {
      await orderRef.update({
        provider: "innoverit",
        providerLastCheckAt: FieldValue.serverTimestamp(),
        providerLastCheckAtMs: nowMs,
        providerCheckResult: "ERROR",
        providerCheckError: "INNOVERIT_APIKEY_MISSING",
      });
      return sendJson(res, 500, { ok: false, error: "INNOVERIT_APIKEY_MISSING" });
    }

    const key = String(order.providerKey || orderId).trim();

    const details = await postForm("https://www.innoverit.com/api/v2/product/get/details", {
      apikey: apiKey,
      key,
    });

    const j = details.json || {};
    const errCode = (j && j.error_code != null) ? Number(j.error_code) : null;
    const ok = (errCode === 0);

    // event
    const evRef = orderRef.collection("events").doc();
    await evRef.set({
      type: ok ? "INNOVERIT_STATUS_REFRESH_OK" : "INNOVERIT_STATUS_REFRESH_ERROR",
      createdAt: FieldValue.serverTimestamp(),
      createdAtMs: nowMs,
      providerHttpStatus: details.httpStatus,
      providerErrorCode: errCode,
      providerStatus: String(j.status || ""),
      providerMessage: String(j.message || ""),
      providerRechargeId: j.recharge_id ?? null,
      providerReferenceCode: j.reference_code ?? null,
      destination: String(j.destination || order.destination || ""),
    });

    // update order (sin tocar status)
    await orderRef.update({
      provider: "innoverit",
      providerKey: key,
      providerHttpStatus: details.httpStatus,
      providerErrorCode: errCode,
      providerStatus: String(j.status || ""),
      providerMessage: String(j.message || ""),
      providerRechargeId: j.recharge_id ?? (order.providerRechargeId ?? null),
      providerReferenceCode: j.reference_code ?? (order.providerReferenceCode ?? null),
      providerBalance: (j.balance != null ? j.balance : (order.providerBalance ?? null)),
      providerRaw: String(details.text || "").slice(0, 10000),
      providerLastCheckAt: FieldValue.serverTimestamp(),
      providerLastCheckAtMs: nowMs,
      providerCheckResult: ok ? "OK" : "ERROR",
    });

    return sendJson(res, 200, {
      ok: true,
      orderId,
      providerHttpStatus: details.httpStatus,
      providerErrorCode: errCode,
      providerStatus: String(j.status || ""),
      providerMessage: String(j.message || ""),
      providerRechargeId: j.recharge_id ?? null,
      providerReferenceCode: j.reference_code ?? null,
    });
  } catch (e) {
    logger.error("refreshInnoveritStatus ERROR", { orderId, message: String(e && e.message ? e.message : e) });
    return sendJson(res, 500, { ok: false, error: "INTERNAL_ERROR" });
  }
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
 * Manual Completion Stub: cuando una order pasa a COMPLETED, registramos evento controlado.
 * - Solo transición EXACTA PAID -> COMPLETED
 * - NO llama a proveedor
 * - Audit event: type "COMPLETED_MANUAL"
 * - Idempotencia: completedProcessedAtMs
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

  const orderId = (event.params && event.params.orderId) ? String(event.params.orderId) : "";
  if (!orderId) return;

  const orderRef = db.collection("orders").doc(orderId);
  const nowMs = Date.now();

  function pickInnoveritApiKey() {
    let k = String(process.env.INNOVERIT_APIKEY || process.env.INNOVERIT_API_KEY || "").trim();
    if (k) return k;
    try {
      const cfg = require("firebase-functions").config();
      k = String((cfg && cfg.innoverit && cfg.innoverit.apikey) ? cfg.innoverit.apikey : "").trim();
      return k;
    } catch (_) {
      return "";
    }
  }

  async function postForm(url, paramsObj) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(paramsObj || {})) body.set(k, String(v));
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { httpStatus: resp.status, text, json };
  }

  try {
    const snap = await orderRef.get();
    if (!snap.exists) return;

    const order = snap.data() || {};
    if (String(order.status || "") !== "COMPLETED") return;

    // Idempotencia: si ya guardamos resultado proveedor, salir
    const sentMs = Number(order.providerSentAtMs);
    if (Number.isFinite(sentMs) && sentMs > 0) return;

    const apiKey = pickInnoveritApiKey();
    if (!apiKey) {
      await orderRef.update({
        provider: "innoverit",
        providerResult: "ERROR",
        providerError: "INNOVERIT_APIKEY_MISSING",
        providerErrorAt: FieldValue.serverTimestamp(),
        providerErrorAtMs: nowMs,
        completedProcessedAt: FieldValue.serverTimestamp(),
        completedProcessedAtMs: nowMs,
        completedResult: "PROVIDER_ERROR",
      });
      return;
    }

    const productId = String(order.productId || "").trim().toLowerCase();
    const destination = String(order.destination || "").trim();
    if (!productId || !destination) {
      await orderRef.update({
        provider: "innoverit",
        providerResult: "ERROR",
        providerError: "MISSING_PRODUCT_OR_DESTINATION",
        providerErrorAt: FieldValue.serverTimestamp(),
        providerErrorAtMs: nowMs,
        completedProcessedAt: FieldValue.serverTimestamp(),
        completedProcessedAtMs: nowMs,
        completedResult: "PROVIDER_ERROR",
      });
      return;
    }

    // Resolver producto (docId = productId interno) para obtener id_product real de Innoverit
    let prodSnap = await db.collection("catalog_products_innoverit").doc(productId).get();
    if (!prodSnap.exists) prodSnap = await db.collection("catalog_products").doc(productId).get();

    if (!prodSnap.exists) {
      await orderRef.update({
        provider: "innoverit",
        providerResult: "ERROR",
        providerError: "CATALOG_PRODUCT_NOT_FOUND",
        providerErrorAt: FieldValue.serverTimestamp(),
        providerErrorAtMs: nowMs,
        completedProcessedAt: FieldValue.serverTimestamp(),
        completedProcessedAtMs: nowMs,
        completedResult: "PROVIDER_ERROR",
      });
      return;
    }

    const p = prodSnap.data() || {};
    const providerName = String(p.provider || "innoverit").trim().toLowerCase();
    if (providerName !== "innoverit") {
      await orderRef.update({
        provider: "innoverit",
        providerResult: "SKIPPED",
        providerError: "NOT_INNOVERIT_PRODUCT",
        completedProcessedAt: FieldValue.serverTimestamp(),
        completedProcessedAtMs: nowMs,
        completedResult: "SKIPPED",
      });
      return;
    }

    const idProduct = String(p.providerProductId || p.providerSku || "").trim();
    if (!idProduct) {
      await orderRef.update({
        provider: "innoverit",
        providerResult: "ERROR",
        providerError: "MISSING_PROVIDER_PRODUCT_ID",
        providerErrorAt: FieldValue.serverTimestamp(),
        providerErrorAtMs: nowMs,
        completedProcessedAt: FieldValue.serverTimestamp(),
        completedProcessedAtMs: nowMs,
        completedResult: "PROVIDER_ERROR",
      });
      return;
    }

    // 1) (Opcional) intentar ver si ya existe por key (evita dobles envíos si hubo retry)
    const details = await postForm("https://www.innoverit.com/api/v2/product/get/details", {
      apikey: apiKey,
      key: orderId,
    });

    if (details.json && Number(details.json.error_code) === 0) {
      const evRef = orderRef.collection("events").doc();
      await evRef.set({
        type: "INNOVERIT_ALREADY_EXISTS",
        statusFrom,
        statusTo,
        createdAt: FieldValue.serverTimestamp(),
        createdAtMs: nowMs,
        providerHttpStatus: details.httpStatus,
        providerErrorCode: Number(details.json.error_code),
        providerStatus: String(details.json.status || ""),
        providerMessage: String(details.json.message || ""),
        providerRechargeId: details.json.recharge_id ?? null,
        providerReferenceCode: details.json.reference_code ?? null,
      });

      await orderRef.update({
        provider: "innoverit",
        providerKey: orderId,
        providerHttpStatus: details.httpStatus,
        providerErrorCode: Number(details.json.error_code),
        providerStatus: String(details.json.status || ""),
        providerMessage: String(details.json.message || ""),
        providerRechargeId: details.json.recharge_id ?? null,
        providerReferenceCode: details.json.reference_code ?? null,
        providerBalance: details.json.balance ?? null,
        providerRaw: String(details.text || "").slice(0, 10000),
        providerSentAt: FieldValue.serverTimestamp(),
        providerSentAtMs: nowMs,
        providerResult: "EXISTS",
        completedProcessedAt: FieldValue.serverTimestamp(),
        completedProcessedAtMs: nowMs,
        completedResult: "PROVIDER_EXISTS",
      });

      return;
    }

    // 2) Enviar recarga
    const send = await postForm("https://www.innoverit.com/api/v2/product/send", {
      apikey: apiKey,
      id_product: idProduct,
      destination,
      key: orderId,
      note: `RPC order ${orderId}`,
    });

    const j = send.json || {};
    const errCode = (j && j.error_code != null) ? Number(j.error_code) : null;
    const ok = (errCode === 0);

    const eventRef = orderRef.collection("events").doc();
    await eventRef.set({
      type: ok ? "INNOVERIT_SEND_OK" : "INNOVERIT_SEND_ERROR",
      statusFrom,
      statusTo,
      createdAt: FieldValue.serverTimestamp(),
      createdAtMs: nowMs,
      providerHttpStatus: send.httpStatus,
      providerErrorCode: errCode,
      providerStatus: String(j.status || ""),
      providerMessage: String(j.message || ""),
      providerRechargeId: j.recharge_id ?? null,
      providerReferenceCode: j.reference_code ?? null,
      destination: String(j.destination || destination),
    });

    await orderRef.update({
      provider: "innoverit",
      providerKey: orderId,
      providerHttpStatus: send.httpStatus,
      providerErrorCode: errCode,
      providerStatus: String(j.status || ""),
      providerMessage: String(j.message || ""),
      providerRechargeId: j.recharge_id ?? null,
      providerReferenceCode: j.reference_code ?? null,
      providerBalance: j.balance ?? null,
      providerRaw: String(send.text || "").slice(0, 10000),
      providerSentAt: FieldValue.serverTimestamp(),
      providerSentAtMs: nowMs,
      providerResult: ok ? "SENT" : "ERROR",
      completedProcessedAt: FieldValue.serverTimestamp(),
      completedProcessedAtMs: nowMs,
      completedResult: ok ? "PROVIDER_SENT" : "PROVIDER_ERROR",
    });

    logger.info("onOrderCompleted Innoverit send DONE", { orderId, ok, httpStatus: send.httpStatus, errCode });
  } catch (e) {
    logger.error("onOrderCompleted Innoverit send ERROR", { orderId, message: String(e && e.message ? e.message : e) });
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

// Notifica COMPLETED a un grupo específico por referrer (valhalla). Dedupe por /events/TELEGRAM_COMPLETED_VALHALLA
exports.onOrderCompletedTelegramValhalla = onDocumentUpdated(
  { document: "orders/{orderId}", secrets: ["TELEGRAM_BOT_TOKEN"] },
  async (event) => {
    const before = event.data?.before?.data?.() || {};
    const after  = event.data?.after?.data?.()  || {};

    const statusFrom = String(before.status || "");
    const statusTo   = String(after.status  || "");

    // Solo transiciones hacia COMPLETED
    if (!(statusTo === "COMPLETED" && statusFrom !== "COMPLETED")) return;

    // Solo referrer=valhalla
    const ref = String(after.referrer || "").trim().toLowerCase();
    if (ref !== "valhalla") return;

    const token = pickTelegramBotToken();
    const chatId = "-5247604664"; // Órdenes COMPLETED • valhalla
    if (!token || !chatId) return;

    const orderId = String(event.params?.orderId || "");
    if (!orderId) return;

    const orderRef = db.collection("orders").doc(orderId);
    const notifyRef = orderRef.collection("events").doc("TELEGRAM_COMPLETED_VALHALLA");
    const nowMs = Date.now();

    let shouldSend = false;

    await db.runTransaction(async (tx) => {
      const n = await tx.get(notifyRef);
      const state = n.exists ? String((n.data() || {}).state || "") : "";
      if (state === "SENT") return;

      tx.set(
        notifyRef,
        {
          type: "TELEGRAM_COMPLETED_VALHALLA",
          state: "PENDING",
          createdAt: FieldValue.serverTimestamp(),
          createdAtMs: nowMs,
        },
        { merge: true }
      );

      shouldSend = true;
    });

    if (!shouldSend) return;

    const dest = String(after.destination || "-");
    const destSafe = dest.length > 4 ? `***${dest.slice(-4)}` : dest;

    const text =
      `✅ COMPLETED (valhalla)\n` +
      `ID: ${orderId}\n` +
      `Producto: ${String(after.productId || "-")}\n` +
      `Destino: ${destSafe}\n` +
      `Importe: ${String(after.amount ?? "-")} ${String(after.currency || "")}\n` +
      `Canal: ${String(after.channel || "-")}`;

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
    return {
      y: Number(m.year),
      mo: Number(m.month),
      d: Number(m.day),
      hh: Number(m.hour),
      mm: Number(m.minute),
      ss: Number(m.second),
    };
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

  const pad2 = (n) => String(n).padStart(2, "0");
  const dayKey = (ms) => {
    const p = tzParts(ms);
    return `${p.y}-${pad2(p.mo)}-${pad2(p.d)}`; // Canarias
  };
  const monthKey = (ms) => {
    const p = tzParts(ms);
    return `${p.y}-${pad2(p.mo)}`; // Canarias
  };

  const todayKey = dayKey(nowMs);
  const thisMonthKey = monthKey(nowMs);

  // Ventana segura para cubrir "mes actual" sin depender de startOfDay
  const RECENT_DAYS = 45;
  const recentFromMs = nowMs - (RECENT_DAYS * 24 * 60 * 60 * 1000);

  const recentSnap = await db.collection("orders")
    .where("createdAtMs", ">=", recentFromMs)
    .orderBy("createdAtMs", "asc")
    .select("status", "amount", "currency", "orderId", "createdAtMs")
    .get();

  const recentCompleted = [];
  for (const doc of recentSnap.docs) {
    const o = doc.data() || {};
    const status = String(o.status || "");
    const currency = String(o.currency || "EUR").toUpperCase();
    const amount = (o.amount != null ? Number(o.amount) : NaN);
    const createdAtMs = Number(o.createdAtMs || 0);

    if (status !== "COMPLETED") continue;
    if (currency !== "EUR") continue;
    if (!Number.isFinite(amount)) continue;
    if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) continue;

    recentCompleted.push({
      docId: doc.id,
      orderId: String(o.orderId || doc.id),
      amount,
      createdAtMs,
      dKey: dayKey(createdAtMs),
      mKey: monthKey(createdAtMs),
    });
  }

  const privRefsRecent = recentCompleted.map((x) => db.collection("orders_private").doc(x.docId));
  const privDocsRecent = await getAllDocs(privRefsRecent);
  const privByIdRecent = new Map(privDocsRecent.map((d) => [d.id, d]));

  let profitToday = 0;
  let profitMonth = 0;
  let missingCostRecent = 0;

  for (const o of recentCompleted) {
    let pdoc = privByIdRecent.get(o.docId) || null;

    // Fallback si orders_private usa orderId (por compatibilidad)
    if ((!pdoc || !pdoc.exists) && o.orderId && o.orderId !== o.docId) {
      const alt = await db.collection("orders_private").doc(o.orderId).get();
      if (alt && alt.exists) pdoc = alt;
    }

    const pdata = (pdoc && pdoc.exists) ? (pdoc.data() || {}) : null;
    const cost = pdata && (pdata.costEur != null) ? Number(pdata.costEur) : NaN;

    if (!Number.isFinite(cost)) {
      missingCostRecent++;
      continue;
    }

    const p = (o.amount - cost);
    if (o.dKey === todayKey) profitToday += p;
    if (o.mKey === thisMonthKey) profitMonth += p;
  }

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

  const today = {
    scanned: recentSnap.size,
    completed: recentCompleted.length,
    missingCost: missingCostRecent,
    profitEur: round2(profitToday),
  };

  const month = {
    scanned: recentSnap.size,
    completed: recentCompleted.length,
    missingCost: missingCostRecent,
    profitEur: round2(profitMonth),
  };
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

// exports.helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", { structuredData: true });
//   response.send("Hello from Firebase!");
// });

