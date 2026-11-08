// attendance.js
// ---------------------------------------------------------------------------
// Módulo 7 — Asistencia por Código QR.
//
// Lado ALUMNO: genera un QR que codifica { uid, courseId, exp } en JSON,
// dibujado LOCALMENTE en un <canvas> con la librería qrcode.js (sin llamar a
// ningún servicio externo de imágenes — eso era poco confiable en algunas
// redes). `exp` es un timestamp de expiración a 60s — el QR se regenera solo
// antes de vencer, así que una captura de pantalla vieja deja de servir.
//
// Lado DOCENTE: abre la cámara con html5-qrcode y, por cada QR válido que
// detecta, escribe un registro en attendance/{courseId}_{uid}_{YYYY-MM-DD}
// (ID determinístico por día → reescanear al mismo alumno el mismo día
// actualiza el registro en vez de duplicarlo). Puede escanear a varios
// alumnos seguidos en una misma sesión; la lista de la derecha se va
// llenando en vivo.
//
// Se activa/desactiva mediante CustomEvents disparados desde courses.js:
//   "qr:generate"        { courseId, courseName }  → arranca el QR del alumno
//   "qr:stop"                                       → detiene el refresh del QR
//   "attendance:start-scan" { courseId, courseName } → abre el modal de escaneo (docente)
//   "attendance:recorded"                            → avisa a courses.js que se registró algo
// ---------------------------------------------------------------------------

import { auth, db } from "./firebase-config.js";
import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const QR_TTL_MS = 60_000;
const QR_REFRESH_MS = 55_000; // se renueva un poco antes de vencer

function todayDateString() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// ---------------------------------------------------------------------------
// Espera a que una librería global (window.QRCode / window.Html5Qrcode) esté
// lista. Necesario porque, si el CDN principal falla, index.html reintenta
// con uno de respaldo cambiando el `src` del script — eso pasa de forma
// asíncrona, así que no hay garantía de que ya esté disponible apenas
// arranca este módulo.
// ---------------------------------------------------------------------------
function waitForGlobal(name, timeoutMs = 6000, intervalMs = 100) {
  return new Promise((resolve, reject) => {
    if (window[name]) return resolve(window[name]);
    const start = Date.now();
    const timer = setInterval(() => {
      if (window[name]) {
        clearInterval(timer);
        resolve(window[name]);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`No se pudo cargar la librería requerida (${name}).`));
      }
    }, intervalMs);
  });
}

// ---------------------------------------------------------------------------
// Lado ALUMNO: generación del QR (local, sin red)
// ---------------------------------------------------------------------------
const qrCanvas = document.getElementById("course-qr-canvas");
const qrCountdownEl = document.getElementById("course-qr-countdown");

let qrInterval = null;
let qrCountdownInterval = null;

async function renderQr(courseId) {
  const uid = auth.currentUser?.uid;
  if (!uid || !qrCanvas) return;

  let QRCodeLib;
  try {
    QRCodeLib = await waitForGlobal("QRCode");
  } catch (error) {
    console.error(error);
    if (qrCountdownEl) {
      qrCountdownEl.textContent = "No se pudo cargar el generador de QR. Recarga la página.";
      qrCountdownEl.classList.remove("text-ink/40");
      qrCountdownEl.classList.add("text-coral");
    }
    return;
  }

  const exp = Date.now() + QR_TTL_MS;
  const payload = JSON.stringify({ uid, courseId, exp });

  QRCodeLib.toCanvas(qrCanvas, payload, { width: 200, margin: 1 }, (error) => {
    if (error) {
      console.error("No se pudo generar el código QR:", error);
      if (qrCountdownEl) {
        qrCountdownEl.textContent = "No se pudo generar el código QR.";
        qrCountdownEl.classList.remove("text-ink/40");
        qrCountdownEl.classList.add("text-coral");
      }
    }
  });

  qrCountdownEl?.classList.remove("text-coral");
  qrCountdownEl?.classList.add("text-ink/40");
  clearInterval(qrCountdownInterval);
  qrCountdownInterval = setInterval(() => {
    const secondsLeft = Math.max(0, Math.round((exp - Date.now()) / 1000));
    qrCountdownEl.textContent = `Se renueva en ${secondsLeft}s…`;
  }, 1000);
}

window.addEventListener("qr:generate", (event) => {
  const { courseId } = event.detail || {};
  if (!courseId) return;

  clearInterval(qrInterval);
  renderQr(courseId);
  qrInterval = setInterval(() => renderQr(courseId), QR_REFRESH_MS);
});

window.addEventListener("qr:stop", () => {
  clearInterval(qrInterval);
  clearInterval(qrCountdownInterval);
  qrInterval = null;
  qrCountdownInterval = null;
});

// ---------------------------------------------------------------------------
// Lado DOCENTE: escaneo con cámara (multi-escaneo por sesión)
// ---------------------------------------------------------------------------
const scanModal = document.getElementById("attendance-scan-modal");
const scanCloseBtn = document.getElementById("attendance-scan-close-btn");
const scanHintEl = document.getElementById("attendance-scan-hint");
const scanErrorEl = document.getElementById("attendance-scan-error");
const sessionListEl = document.getElementById("attendance-session-list");
const sessionCountEl = document.getElementById("attendance-session-count");

let html5QrInstance = null;
let currentScanCourse = null;
let sessionMarkedUids = new Set();
let isProcessingScan = false;

function showScanError(message) {
  scanErrorEl.textContent = message;
  scanErrorEl.classList.remove("hidden");
  setTimeout(() => scanErrorEl.classList.add("hidden"), 4000);
}

function addSessionEntry(studentName) {
  const li = document.createElement("li");
  li.className = "px-3 py-2 flex items-center justify-between text-sm";
  const nameSpan = document.createElement("span");
  nameSpan.className = "text-ink";
  nameSpan.textContent = studentName;
  const check = document.createElement("span");
  check.className = "text-marigold text-xs font-mono";
  check.textContent = "✓ presente";
  li.appendChild(nameSpan);
  li.appendChild(check);
  sessionListEl.prepend(li);
  sessionCountEl.textContent = String(sessionMarkedUids.size);
}

// El DOCENTE escribe el registro (uid = el alumno escaneado, recordedBy = el
// docente autenticado). Las reglas de Firestore verifican que quien escribe
// sea el docente dueño del curso.
async function recordAttendance(scannedUid, courseId) {
  const enrollmentSnap = await getDoc(doc(db, "enrollments", `${courseId}_${scannedUid}`));
  if (!enrollmentSnap.exists()) {
    showScanError("Este código no corresponde a un alumno inscrito en este curso.");
    return;
  }
  const studentName = enrollmentSnap.data().studentName || "Alumno";

  const today = todayDateString();
  const recordId = `${courseId}_${scannedUid}_${today}`;

  await setDoc(
    doc(db, "attendance", recordId),
    {
      uid: scannedUid,
      courseId,
      studentName,
      date: today,
      recordedBy: auth.currentUser.uid,
      timestamp: serverTimestamp(),
    },
    { merge: true }
  );

  sessionMarkedUids.add(scannedUid);
  addSessionEntry(studentName);
  window.dispatchEvent(new CustomEvent("attendance:recorded"));
}

async function onScanSuccess(decodedText) {
  if (isProcessingScan || !currentScanCourse) return;

  let payload;
  try {
    payload = JSON.parse(decodedText);
  } catch {
    showScanError("Ese código QR no es válido para esta app.");
    return;
  }

  const { uid: scannedUid, courseId: scannedCourseId, exp } = payload;

  if (!scannedUid || !scannedCourseId) {
    showScanError("Código QR incompleto.");
    return;
  }
  if (scannedCourseId !== currentScanCourse.courseId) {
    showScanError("Este QR es de otro curso.");
    return;
  }
  if (typeof exp === "number" && Date.now() > exp) {
    showScanError("Este código expiró. Pide al alumno que lo vuelva a mostrar.");
    return;
  }
  if (sessionMarkedUids.has(scannedUid)) {
    return; // ya registrado en esta sesión, ignorar silenciosamente
  }

  isProcessingScan = true;
  try {
    await recordAttendance(scannedUid, scannedCourseId);
  } catch (error) {
    console.error("No se pudo registrar la asistencia:", error);
    showScanError("No se pudo registrar la asistencia. Intenta de nuevo.");
  } finally {
    isProcessingScan = false;
  }
}

function onScanFailure() {
  // Se llama continuamente mientras no hay QR en cuadro; no hacemos nada.
}

async function stopCamera() {
  if (!html5QrInstance) return;
  try {
    await html5QrInstance.stop();
    html5QrInstance.clear();
  } catch (error) {
    console.warn("Aviso al detener la cámara del escáner:", error);
  }
  html5QrInstance = null;
}

async function openScanModal() {
  scanModal.classList.remove("hidden");
  scanErrorEl.classList.add("hidden");
  scanHintEl?.classList.remove("hidden");
  sessionMarkedUids = new Set();
  sessionCountEl.textContent = "0";
  while (sessionListEl.firstChild) sessionListEl.removeChild(sessionListEl.firstChild);

  let Html5QrcodeLib;
  try {
    Html5QrcodeLib = await waitForGlobal("Html5Qrcode");
  } catch (error) {
    console.error(error);
    showScanError("No se pudo cargar el lector de QR. Recarga la página e intenta de nuevo.");
    return;
  }

  try {
    html5QrInstance = new Html5QrcodeLib("qr-reader");
    await html5QrInstance.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: 220 },
      onScanSuccess,
      onScanFailure
    );
  } catch (error) {
    console.error("No se pudo iniciar la cámara para escanear:", error);
    showScanError("No se pudo acceder a la cámara. Revisa los permisos del navegador.");
  }
}

async function closeScanModal() {
  scanModal.classList.add("hidden");
  currentScanCourse = null;
  await stopCamera();
}

window.addEventListener("attendance:start-scan", (event) => {
  currentScanCourse = event.detail || null;
  if (!currentScanCourse) return;
  openScanModal();
});

scanCloseBtn?.addEventListener("click", closeScanModal);

scanModal?.addEventListener("click", (event) => {
  if (event.target === scanModal) closeScanModal();
});

// Si el usuario cambia de pestaña/app mientras escanea, cerramos para no
// dejar la cámara encendida de fondo.
document.addEventListener("visibilitychange", () => {
  if (document.hidden && html5QrInstance) {
    closeScanModal();
  }
});
