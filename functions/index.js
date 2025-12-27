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

/**
 * Catálogo server-side (source of truth).
 * Ajusta/Completa con TODOS tus productId reales.
 */
const PRODUCTS = {
  // --- CUBACEL ---
  "cubacel-10": { id: "cubacel-10", kind: "cubacel", amount: 10.42, currency: "EUR" },
  "cubacel-20": { id: "cubacel-20", kind: "cubacel", amount: 20.84, currency: "EUR" },
  "cubacel-25": { id: "cubacel-25", kind: "cubacel", amount: 25.01, currency: "EUR" },
  "cubacel-30": { id: "cubacel-30", kind: "cubacel", amount: 31.26, currency: "EUR" },

  // --- NAUTA (ejemplos; ajusta a tu catálogo real) ---
  "nauta-5": { id: "nauta-5", kind: "nauta", amount: 5.0, currency: "EUR" },
  "nauta-10": { id: "nauta-10", kind: "nauta", amount: 10.0, currency: "EUR" },
};

function sendJson(res, status, payload) {
  res.status(status);
  res.set("Content-Type", "application/json; charset=utf-8");
  res.send(JSON.stringify(payload));
}

function setCors(req, res) {
  const origin = req.get("origin") || "*";
  res.set("Access-Control-Allow-Origin", origin);
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
 * - calcula importe en servidor (PRODUCTS)
 * - crea orden PENDING en /orders
 * - responde { orderId, amount, currency, status }
 */
exports.createOrder = onRequest(async (req, res) => {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }
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

  // Validación UID final (por si en emulador vino vacío)
  if (!uid || uid.length > 128) {
    return sendJson(res, 400, { ok: false, error: "INVALID_UID" });
  }

  if (!productId || productId.length > 64) {
    return sendJson(res, 400, { ok: false, error: "INVALID_PRODUCT_ID" });
  }

  const product = PRODUCTS[productId];
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

// exports.helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", { structuredData: true });
//   response.send("Hello from Firebase!");
// });
