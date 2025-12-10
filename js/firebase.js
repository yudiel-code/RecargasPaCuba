// js/firebase.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  updateProfile
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js";

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

// Exponer en window para scripts NO módulo
window.firebaseApp = app;
window.firebaseAuth = auth;
window.firebaseSignIn = signInWithEmailAndPassword;
window.firebaseSendPasswordResetEmail = sendPasswordResetEmail;
window.firebaseSignOut = signOut;
window.firebaseOnAuthStateChanged = onAuthStateChanged;

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
  updateProfile
};
