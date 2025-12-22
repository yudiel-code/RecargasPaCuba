// js/firebase.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  updateProfile,
  GoogleAuthProvider,
  signInWithPopup
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-functions.js";

// Configuración única de Firebase para toda la app
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

// Exponer en window para scripts NO módulo
window.firebaseApp = app;
window.firebaseAuth = auth;
window.firebaseFunctions = functions;
window.firebaseHttpsCallable = httpsCallable;
window.firebaseCallFunction = callFunction;
window.firebaseSignIn = signInWithEmailAndPassword;
window.firebaseSendPasswordResetEmail = sendPasswordResetEmail;
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
  signOut,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  updateProfile,
  functions,
  httpsCallable,
  callFunction
};
