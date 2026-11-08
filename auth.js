// auth.js
// ---------------------------------------------------------------------------
// Registro / inicio de sesión con Firebase Auth (Email + Password) y
// enrutamiento inicial de la SPA según el `role` guardado en
// Firestore: users/{uid}. Fase 1: solo controla qué "vista" (auth vs app)
// se muestra; el contenido real de cada módulo llega en fases posteriores.
// ---------------------------------------------------------------------------

import { auth, db } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc,
  setDoc,
  getDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---------------------------------------------------------------------------
// Referencias al DOM
// ---------------------------------------------------------------------------
const splashScreen = document.getElementById("splash-screen");
const authView = document.getElementById("auth-view");
const appView = document.getElementById("app-view");

const loginForm = document.getElementById("login-form");
const registerForm = document.getElementById("register-form");
const authError = document.getElementById("auth-error");

const loginSubmit = document.getElementById("login-submit");
const registerSubmit = document.getElementById("register-submit");

const logoutBtn = document.getElementById("logout-btn");
const userNameEl = document.getElementById("user-name");
const roleBadgeEl = document.getElementById("role-badge");

// ---------------------------------------------------------------------------
// Helpers de UI
// ---------------------------------------------------------------------------
function showError(message) {
  authError.textContent = message;
  authError.classList.remove("hidden");
}

function clearError() {
  authError.classList.add("hidden");
  authError.textContent = "";
}

function setLoading(button, isLoading, idleLabel) {
  button.disabled = isLoading;
  button.textContent = isLoading ? "Un momento…" : idleLabel;
}

// Traduce los códigos de error de Firebase Auth a mensajes en español,
// sin exponer detalles internos al usuario.
function friendlyAuthError(error) {
  const map = {
    "auth/invalid-email": "El correo ingresado no es válido.",
    "auth/user-disabled": "Esta cuenta ha sido deshabilitada.",
    "auth/user-not-found": "No encontramos una cuenta con ese correo.",
    "auth/wrong-password": "La contraseña es incorrecta.",
    "auth/invalid-credential": "Correo o contraseña incorrectos.",
    "auth/email-already-in-use": "Ya existe una cuenta con ese correo.",
    "auth/weak-password": "La contraseña debe tener al menos 6 caracteres.",
    "auth/too-many-requests": "Demasiados intentos. Intenta de nuevo en unos minutos.",
    "auth/network-request-failed": "Problema de conexión. Revisa tu internet.",
  };
  return map[error.code] || "Ocurrió un error inesperado. Intenta de nuevo.";
}

function showAuthView() {
  splashScreen.classList.add("hidden");
  appView.classList.add("hidden");
  authView.classList.remove("hidden");
}

function showAppView(profile) {
  splashScreen.classList.add("hidden");
  authView.classList.add("hidden");
  appView.classList.remove("hidden");

  userNameEl.textContent = profile.displayName || profile.email || "";
  userNameEl.classList.remove("hidden");

  const roleLabels = { docente: "Docente", estudiante: "Estudiante", direccion: "Dirección" };
  roleBadgeEl.textContent = roleLabels[profile.role] || profile.role || "";
  roleBadgeEl.classList.remove("hidden");

  // Rol del usuario en el DOM: app-nav.js lo usa para mostrar/ocultar
  // ítems del nav restringidos por rol (data-roles="docente,direccion"...).
  document.body.dataset.role = profile.role || "";
  window.dispatchEvent(new CustomEvent("auth:profile-ready", { detail: profile }));
}

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------
const studentFieldsWrapper = document.getElementById("reg-student-fields");
const cursoInput = document.getElementById("reg-curso");
const bachillerInput = document.getElementById("reg-bachiller");

function updateStudentFieldsVisibility() {
  const role = registerForm.querySelector('input[name="role"]:checked')?.value;
  const isStudent = role === "estudiante";
  studentFieldsWrapper.classList.toggle("hidden", !isStudent);
  // Solo son "required" cuando están visibles, si no bloquean el submit
  // aunque el usuario haya elegido "Docente".
  cursoInput.required = isStudent;
  bachillerInput.required = isStudent;
}
registerForm.querySelectorAll('input[name="role"]').forEach((radio) => {
  radio.addEventListener("change", updateStudentFieldsVisibility);
});
updateStudentFieldsVisibility();

// UID de un registro que acabamos de completar nosotros mismos (con su
// perfil ya escrito en Firestore). Sirve para que, si onAuthStateChanged
// llega a dispararse por su cuenta mientras el registro está en curso, no
// vuelva a leer Firestore innecesariamente ni compita con la carrera
// descrita más abajo.
let justRegisteredUid = null;

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();

  const firstName = document.getElementById("reg-firstname").value.trim();
  const lastName = document.getElementById("reg-lastname").value.trim();
  const email = document.getElementById("reg-email").value.trim();
  const password = document.getElementById("reg-password").value;
  const role = registerForm.querySelector('input[name="role"]:checked').value;
  const curso = cursoInput.value.trim();
  const bachiller = bachillerInput.value.trim();

  if (!firstName || !lastName) {
    showError("Ingresa tu nombre y apellido.");
    return;
  }
  if (role === "estudiante" && (!curso || !bachiller)) {
    showError("Ingresa tu curso y bachiller.");
    return;
  }

  const displayName = `${firstName} ${lastName}`;

  setLoading(registerSubmit, true, "Crear cuenta");

  try {
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    const user = credential.user;

    // Nombre visible en Firebase Auth (útil para mostrarlo sin leer Firestore)
    await updateProfile(user, { displayName });

    // Documento de perfil / rol en Firestore: users/{uid}
    const profile = {
      uid: user.uid,
      firstName,
      lastName,
      displayName,
      email: user.email,
      role, // "docente" | "estudiante" | "direccion"
      ...(role === "estudiante" ? { curso, bachiller } : {}),
      createdAt: serverTimestamp(),
    };
    await setDoc(doc(db, "users", user.uid), profile);

    registerForm.reset();
    updateStudentFieldsVisibility();

    // No dependemos de que onAuthStateChanged vuelva a leer Firestore para
    // mostrar la app: ya tenemos el perfil completo en memoria, recién
    // escrito. Si onAuthStateChanged se disparó antes (carrera con
    // createUserWithEmailAndPassword) y encontró el doc inexistente, esto
    // lo corrige mostrando igual la app en vez de dejar al usuario
    // deslogueado.
    justRegisteredUid = user.uid;
    showAppView(profile);
  } catch (error) {
    console.error("Error en registro:", error);
    showError(friendlyAuthError(error));
  } finally {
    setLoading(registerSubmit, false, "Crear cuenta");
  }
});

// ---------------------------------------------------------------------------
// Inicio de sesión
// ---------------------------------------------------------------------------
loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();

  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;

  setLoading(loginSubmit, true, "Entrar");

  try {
    await signInWithEmailAndPassword(auth, email, password);
    loginForm.reset();
    // onAuthStateChanged se encarga de la redirección.
  } catch (error) {
    console.error("Error en login:", error);
    showError(friendlyAuthError(error));
  } finally {
    setLoading(loginSubmit, false, "Entrar");
  }
});

// ---------------------------------------------------------------------------
// Cierre de sesión
// ---------------------------------------------------------------------------
logoutBtn.addEventListener("click", async () => {
  try {
    await signOut(auth);
  } catch (error) {
    console.error("Error al cerrar sesión:", error);
  }
});

// ---------------------------------------------------------------------------
// Observador de estado de autenticación
// Punto único de verdad para decidir qué vista mostrar. Se ejecuta:
//  - al cargar la app (revisa si hay sesión persistida)
//  - después de login / registro exitosos
//  - después de logout
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    justRegisteredUid = null;
    showAuthView();
    return;
  }

  // Ya mostramos la app nosotros mismos justo después de crear la cuenta
  // (ver registerForm submit). Evita una lectura redundante a Firestore.
  if (justRegisteredUid === user.uid) {
    justRegisteredUid = null;
    return;
  }

  try {
    // El doc de perfil (users/{uid}) puede tardar una fracción de segundo
    // en estar disponible justo después de un registro, porque
    // createUserWithEmailAndPassword dispara este listener ANTES de que
    // el setDoc del formulario de registro termine de escribir. Antes de
    // asumir "cuenta sin perfil" y desloguear, reintentamos un par de
    // veces con una espera corta.
    let profileSnap = await getDoc(doc(db, "users", user.uid));
    let attempts = 0;
    while (!profileSnap.exists() && attempts < 3) {
      await sleep(400);
      profileSnap = await getDoc(doc(db, "users", user.uid));
      attempts++;
    }

    if (!profileSnap.exists()) {
      // Caso borde real: usuario autenticado pero sin documento de perfil
      // (p. ej. se creó en Firebase Auth por fuera del flujo normal), ya
      // descartada la carrera de arriba.
      console.warn("Usuario sin perfil en Firestore. Cerrando sesión.");
      showError("Tu cuenta no tiene un perfil configurado. Contacta al administrador.");
      await signOut(auth);
      return;
    }

    showAppView(profileSnap.data());
  } catch (error) {
    console.error("Error al leer el perfil del usuario:", error);
    showError("No se pudo cargar tu perfil. Intenta recargar la página.");
    showAuthView();
  }
});
