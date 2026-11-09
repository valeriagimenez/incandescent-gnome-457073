// sw.js
// ---------------------------------------------------------------------------
// Service Worker mínimo — Fase 1.
// Objetivo de esta fase: que la PWA sea instalable y funcione offline para
// el "app shell" (HTML/CSS/JS estáticos). La estrategia de caché para datos
// dinámicos (chat, historial, tareas escaneadas) se define en fases
// posteriores, junto con Firestore offline persistence.
//
// También deja preparado (pero no activo) el listener de "push" para el
// Módulo 6 (Recordatorios / Web Push Notifications).
// ---------------------------------------------------------------------------

const CACHE_NAME = "brote-shell-v4";

const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/assets/bg.jpg",
];

// ---------------------------------------------------------------------------
// Instalación: precachea el app shell
// ---------------------------------------------------------------------------
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// ---------------------------------------------------------------------------
// Activación: limpia versiones de caché anteriores
// ---------------------------------------------------------------------------
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ---------------------------------------------------------------------------
// Fetch: "cache-first" solo para el app shell estático.
// Todo lo demás (Firebase, Groq API, Netlify Functions) va directo a red:
// nunca queremos servir desde caché una respuesta de IA o de auth.
// ---------------------------------------------------------------------------
self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const isAppShellRequest = APP_SHELL.some((path) => url.pathname === path);

  if (!isAppShellRequest) return; // deja pasar todo lo demás a la red

  event.respondWith(
    caches.match(request).then((cached) => {
      return (
        cached ||
        fetch(request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
      );
    })
  );
});

// ---------------------------------------------------------------------------
// Web Push — esqueleto para el Módulo 6 (Recordatorios de tareas/exámenes).
// Sin backend de push configurado aún; se implementa junto con las
// Netlify Functions y el guardado de subscriptions en Firestore.
// ---------------------------------------------------------------------------
self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "Brote", body: event.data.text() };
  }

  const title = payload.title || "Brote";
  const options = {
    body: payload.body || "Tienes una nueva notificación.",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: payload.data || {},
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/index.html";
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clientsArr) => {
      const existing = clientsArr.find((c) => c.url.includes(targetUrl));
      if (existing) return existing.focus();
      return self.clients.openWindow(targetUrl);
    })
  );
});
