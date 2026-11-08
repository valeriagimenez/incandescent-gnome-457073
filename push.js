// push.js
// ---------------------------------------------------------------------------
// Módulo 6 — Web Push (lado navegador).
//
// Este archivo SOLO se encarga de: pedir permiso de notificaciones,
// suscribir el navegador via el Service Worker (sw.js ya tiene los
// listeners de "push" y "notificationclick" desde la Fase 1), y guardar
// esa suscripción en Firestore: push_subscriptions/{uid}.
//
// El envío real de notificaciones (el cron que revisa la agenda y dispara
// los pushes) vive en netlify/functions/send-reminders.js — es un
// componente de servidor aparte que necesita credenciales propias.
//
// ⚠️ Reemplaza VAPID_PUBLIC_KEY por la tuya (ver instrucciones en
// netlify/functions/send-reminders.js / README de este módulo). Es una
// clave pública: no pasa nada si queda visible en el código del cliente.
// ---------------------------------------------------------------------------

import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc,
  setDoc,
  deleteDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// TODO: reemplaza con tu clave pública VAPID (ver instrucciones en send-reminders.js).
const VAPID_PUBLIC_KEY = "REEMPLAZA_TU_VAPID_PUBLIC_KEY";

const toggleBtn = document.getElementById("push-toggle-btn");
const toggleLabelEl = document.getElementById("push-toggle-label");

let currentUser = null;

// ---------------------------------------------------------------------------
// Helper: convierte la clave VAPID base64url a Uint8Array (formato que
// pide la Push API del navegador).
// ---------------------------------------------------------------------------
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

function isPushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function setButtonState(subscribed) {
  if (!toggleBtn) return;
  if (toggleLabelEl) {
    toggleLabelEl.textContent = subscribed ? " Notificaciones activas ✓" : " Notificaciones";
  }
  toggleBtn.classList.toggle("border-teal/40", subscribed);
  toggleBtn.classList.toggle("text-teal-700", subscribed);
}

// ---------------------------------------------------------------------------
// Estado inicial: ¿ya está suscrito este navegador?
// ---------------------------------------------------------------------------
async function refreshButtonFromExistingSubscription() {
  if (!isPushSupported()) {
    if (toggleBtn) {
      toggleBtn.textContent = "🔔 No disponible en este navegador";
      toggleBtn.disabled = true;
    }
    return;
  }
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    setButtonState(!!subscription);
  } catch (error) {
    console.warn("No se pudo verificar la suscripción push existente:", error);
  }
}

// ---------------------------------------------------------------------------
// Activar / desactivar
// ---------------------------------------------------------------------------
async function subscribeToPush() {
  if (VAPID_PUBLIC_KEY.startsWith("REEMPLAZA")) {
    alert(
      "Las notificaciones push aún no están configuradas en este proyecto (falta la clave VAPID). " +
        "Revisa netlify/functions/send-reminders.js para las instrucciones."
    );
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    alert("No se concedió permiso para enviar notificaciones.");
    return;
  }

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });

  const subJson = subscription.toJSON();
  await setDoc(doc(db, "push_subscriptions", currentUser.uid), {
    endpoint: subJson.endpoint,
    keys: subJson.keys,
    updatedAt: serverTimestamp(),
  });

  setButtonState(true);
}

async function unsubscribeFromPush() {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    await subscription.unsubscribe();
  }
  if (currentUser) {
    await deleteDoc(doc(db, "push_subscriptions", currentUser.uid)).catch(() => {});
  }
  setButtonState(false);
}

toggleBtn?.addEventListener("click", async () => {
  if (!currentUser) return;
  toggleBtn.disabled = true;
  try {
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    if (existing) {
      await unsubscribeFromPush();
    } else {
      await subscribeToPush();
    }
  } catch (error) {
    console.error("Error al cambiar el estado de las notificaciones:", error);
    alert("No se pudo activar/desactivar las notificaciones. Intenta de nuevo.");
  } finally {
    toggleBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Inicialización ligada a la sesión de Firebase Auth
// ---------------------------------------------------------------------------
onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (user) refreshButtonFromExistingSubscription();
});
