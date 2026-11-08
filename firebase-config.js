// firebase-config.js
// ---------------------------------------------------------------------------
// Inicialización centralizada de Firebase (Auth + Firestore).
// Todos los demás módulos (auth.js, chat.js, scanner.js, etc.) importan
// las instancias `auth` y `db` desde este archivo — nunca deben llamar a
// initializeApp() por su cuenta.
//
// ⚠️  Reemplaza los valores de `firebaseConfig` por los de TU proyecto de
//     Firebase (Configuración del proyecto → Tus apps → SDK config).
//     Estas claves son públicas por diseño (se usan del lado del cliente);
//     la seguridad real se controla con las Reglas de Seguridad de
//     Firestore/Auth, no ocultando este objeto.
// ---------------------------------------------------------------------------

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  connectFirestoreEmulator,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDMo41h0R1z36BhHoXE7ZBnlOeyszntcvI",
  authDomain: "sumajuan-933dd.firebaseapp.com",
  projectId: "sumajuan-933dd",
  storageBucket: "sumajuan-933dd.firebasestorage.app",
  messagingSenderId: "240388398933",
  appId: "1:240388398933:web:de652055879812d20859dc",
  measurementId: "G-C37M5MR7E1",
};

const app = initializeApp(firebaseConfig);

const auth = getAuth(app);
const db = getFirestore(app);

// Persistir sesión en el navegador (localStorage) para que el usuario
// no tenga que volver a iniciar sesión al recargar o reabrir la PWA.
setPersistence(auth, browserLocalPersistence).catch((err) => {
  console.error("No se pudo configurar la persistencia de sesión:", err);
});

// Descomenta estas líneas SOLO si estás corriendo los emuladores locales
// de Firebase durante el desarrollo (firebase emulators:start).
//
// if (location.hostname === "localhost") {
//   connectFirestoreEmulator(db, "localhost", 8080);
// }

export { app, auth, db };
