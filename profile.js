// profile.js
// ---------------------------------------------------------------------------
// Edición de perfil local: nombre visible y foto de perfil.
// Todo se guarda en localStorage con una clave por usuario (incluye el uid),
// así cada cuenta conserva su propio perfil en este navegador.
// No modifica Firebase Auth ni Firestore: los datos oficiales (rol, correo,
// nombre original) siguen siendo los del registro.
// ---------------------------------------------------------------------------

import { auth } from "./firebase-config.js";

const PHOTO_SIZE = 256; // lado de la foto guardada (px)
const MAX_INPUT_BYTES = 10 * 1024 * 1024; // tamaño máximo del archivo original

// ---------------------------------------------------------------------------
// Referencias al DOM
// ---------------------------------------------------------------------------
const openBtn = document.getElementById("profile-open-btn");
const headerAvatar = document.getElementById("header-avatar");
const userNameEl = document.getElementById("user-name");

const modal = document.getElementById("profile-modal");
const form = document.getElementById("profile-form");
const closeBtn = document.getElementById("profile-close-btn");
const cancelBtn = document.getElementById("profile-cancel-btn");
const avatarPreview = document.getElementById("profile-avatar-preview");
const photoBtn = document.getElementById("profile-photo-btn");
const removePhotoBtn = document.getElementById("profile-remove-photo-btn");
const photoInput = document.getElementById("profile-photo-input");
const firstNameInput = document.getElementById("profile-firstname");
const lastNameInput = document.getElementById("profile-lastname");
const emailEl = document.getElementById("profile-email");
const roleEl = document.getElementById("profile-role");
const errorEl = document.getElementById("profile-error");

const roleLabels = { docente: "Docente", estudiante: "Estudiante", direccion: "Dirección" };

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
let base = null;      // perfil de Firestore (solo lectura desde aquí)
let local = {};       // lo guardado en localStorage para este usuario
let pendingPhoto;     // undefined = sin cambio; null = quitar; string = nueva foto

function currentUid() {
  return auth.currentUser?.uid || base?.uid || null;
}

function storageKey(uid) {
  return `brote:perfil:${uid}`;
}

function loadLocal(uid) {
  try {
    return JSON.parse(localStorage.getItem(storageKey(uid))) || {};
  } catch {
    return {};
  }
}

function saveLocal(uid, data) {
  localStorage.setItem(storageKey(uid), JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Nombre y avatar
// ---------------------------------------------------------------------------
function displayName() {
  if (local.firstName && local.lastName) {
    return `${local.firstName} ${local.lastName}`;
  }
  const full = `${base?.firstName ?? ""} ${base?.lastName ?? ""}`.trim();
  return full || base?.displayName || base?.email || "";
}

function initialsFor(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return parts
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join("");
}

// Pinta la foto si existe; si no, las iniciales. Usa DOM (no innerHTML)
// porque la foto viene de localStorage.
function renderAvatar(el, photo, name) {
  el.replaceChildren();
  if (photo) {
    const img = document.createElement("img");
    img.src = photo;
    img.alt = "Foto de perfil";
    img.className = "h-full w-full object-cover";
    el.appendChild(img);
  } else {
    el.textContent = initialsFor(name);
  }
}

function refreshHeader() {
  if (!base) return;
  const name = displayName();
  renderAvatar(headerAvatar, local.photo || null, name);
  if (userNameEl) userNameEl.textContent = name;
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------
function showError(message) {
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
}

function clearError() {
  errorEl.textContent = "";
  errorEl.classList.add("hidden");
}

function renderPreview() {
  const photo = pendingPhoto !== undefined ? pendingPhoto : local.photo || null;
  const typedName = `${firstNameInput.value} ${lastNameInput.value}`.trim();
  renderAvatar(avatarPreview, photo, typedName || displayName());
  removePhotoBtn.classList.toggle("hidden", !photo);
}

function openModal() {
  firstNameInput.value = local.firstName ?? base?.firstName ?? "";
  lastNameInput.value = local.lastName ?? base?.lastName ?? "";
  emailEl.textContent = base?.email || "";
  roleEl.textContent = roleLabels[base?.role] || base?.role || "";
  pendingPhoto = undefined;
  clearError();
  renderPreview();
  modal.classList.remove("hidden");
  firstNameInput.focus();
}

function closeModal() {
  modal.classList.add("hidden");
  photoInput.value = "";
  pendingPhoto = undefined;
}

// ---------------------------------------------------------------------------
// Procesamiento de la foto: recorte cuadrado centrado + compresión JPEG
// para que quepa cómodamente en localStorage (~5 MB por origen).
// ---------------------------------------------------------------------------
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("imagen inválida"));
    };
    img.src = url;
  });
}

async function fileToPhoto(file) {
  const img = await loadImage(file);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const sx = (img.naturalWidth - side) / 2;
  const sy = (img.naturalHeight - side) / 2;

  const canvas = document.createElement("canvas");
  canvas.width = PHOTO_SIZE;
  canvas.height = PHOTO_SIZE;
  canvas
    .getContext("2d")
    .drawImage(img, sx, sy, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);

  return canvas.toDataURL("image/jpeg", 0.85);
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

// Al iniciar sesión (o al cambiar de cuenta) auth.js avisa con el perfil.
window.addEventListener("auth:profile-ready", (event) => {
  base = event.detail || {};
  const uid = currentUid();
  local = uid ? loadLocal(uid) : {};
  refreshHeader();
});

openBtn?.addEventListener("click", () => {
  if (base) openModal();
});

closeBtn.addEventListener("click", closeModal);
cancelBtn.addEventListener("click", closeModal);

modal.addEventListener("click", (event) => {
  if (event.target === modal) closeModal();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !modal.classList.contains("hidden")) {
    closeModal();
  }
});

photoBtn.addEventListener("click", () => photoInput.click());

photoInput.addEventListener("change", async () => {
  const file = photoInput.files?.[0];
  photoInput.value = "";
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    showError("El archivo debe ser una imagen.");
    return;
  }
  if (file.size > MAX_INPUT_BYTES) {
    showError("La imagen supera los 10 MB. Elige una más pequeña.");
    return;
  }

  try {
    pendingPhoto = await fileToPhoto(file);
    clearError();
    renderPreview();
  } catch (error) {
    console.error("No se pudo procesar la imagen:", error);
    showError("No se pudo procesar la imagen. Prueba con otra.");
  }
});

removePhotoBtn.addEventListener("click", () => {
  pendingPhoto = null;
  renderPreview();
});

firstNameInput.addEventListener("input", renderPreview);
lastNameInput.addEventListener("input", renderPreview);

form.addEventListener("submit", (event) => {
  event.preventDefault();
  clearError();

  const firstName = firstNameInput.value.trim();
  const lastName = lastNameInput.value.trim();
  if (!firstName || !lastName) {
    showError("Ingresa tu nombre y apellido.");
    return;
  }

  const uid = currentUid();
  if (!uid) {
    showError("Tu sesión expiró. Vuelve a iniciar sesión.");
    return;
  }

  const next = { ...local, firstName, lastName };
  if (pendingPhoto !== undefined) {
    if (pendingPhoto) next.photo = pendingPhoto;
    else delete next.photo;
  }

  try {
    saveLocal(uid, next);
  } catch (error) {
    console.error("No se pudo guardar el perfil en localStorage:", error);
    showError(
      "No se pudo guardar en este navegador. Si subiste una foto, prueba con una imagen más pequeña o quítala."
    );
    return;
  }

  local = next;
  refreshHeader();
  closeModal();
});
