// js/firebase.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  sendEmailVerification,
  signOut,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  updateProfile,
  GoogleAuthProvider,
  signInWithPopup
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-functions.js";
import {
  initializeAppCheck,
  ReCaptchaV3Provider,
  getToken as getAppCheckToken
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-app-check.js";

// Configuracion unica de Firebase para toda la app
const firebaseConfig = {
  apiKey: "AIzaSyALcmOgNzahL1bjGAXW-WakTpJRzUC8NVg",
  authDomain: "recargaspacuba-7aaa8.firebaseapp.com",
  projectId: "recargaspacuba-7aaa8",
  storageBucket: "recargaspacuba-7aaa8.firebasestorage.app",
  messagingSenderId: "863997764350",
  appId: "1:863997764350:web:107ec17e826fe67acd3baf"
};

// Inicializar app y auth una sola vez
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const functions = getFunctions(app);
const callFunction = (name, data) => httpsCallable(functions, name)(data);

// App Check (reCAPTCHA v3 invisible)
// Pega aquí tu SITE KEY (pública), NO la secret.
const appCheck = initializeAppCheck(app, {
  provider: new ReCaptchaV3Provider("PASTE_YOUR_RECAPTCHA_V3_SITE_KEY_HERE"),
  isTokenAutoRefreshEnabled: true
});

// Adjuntar App Check token a tus Functions HTTP (cloudfunctions.net/createOrder y /mark* si aplica)
const _fetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  try {
    const url = typeof input === "string" ? input : input?.url;

    const isTarget =
  typeof url === "string" &&
  (
    // Cloud Functions HTTP classic
    (url.includes("cloudfunctions.net") && (url.includes("/createOrder") || url.includes("/mark"))) ||
    // Cloud Run (a.run.app) – tu caso actual
    (url.includes(".a.run.app") && (url.includes("createorder-") || url.includes("mark")))
  );


    if (!isTarget) return _fetch(input, init);

    const { token } = await getAppCheckToken(appCheck, false);

    const headers = new Headers(init.headers || {});
    headers.set("X-Firebase-AppCheck", token);

    return _fetch(input, { ...init, headers });
  } catch (e) {
    // fail-open para no romper PROD mientras aún no has aplicado verificación en backend
    return _fetch(input, init);
  }
};

// Exponer en window para scripts NO modulo
window.firebaseApp = app;
window.firebaseAuth = auth;
window.firebaseFunctions = functions;
window.firebaseHttpsCallable = httpsCallable;
window.firebaseCallFunction = callFunction;
window.firebaseAppCheck = appCheck;

window.firebaseSignIn = signInWithEmailAndPassword;
window.firebaseSendPasswordResetEmail = sendPasswordResetEmail;
window.firebaseSendEmailVerification = sendEmailVerification;
window.firebaseSignOut = signOut;
window.firebaseOnAuthStateChanged = onAuthStateChanged;

window.firebaseGoogleSignIn = async (authInstance) => {
  const a = authInstance || window.firebaseAuth;
  if (!a) throw new Error("firebase-auth-no-disponible");
  const provider = new GoogleAuthProvider();
  return await signInWithPopup(a, provider);
};
// Nuevas funciones para registro
window.firebaseCreateUser = createUserWithEmailAndPassword;
window.firebaseUpdateProfile = updateProfile;

// Exportar por si en el futuro queremos usar imports directos
export {
  app,
  auth,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  sendEmailVerification,
  signOut,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  updateProfile,
  functions,
  httpsCallable,
  callFunction,
  appCheck
};
