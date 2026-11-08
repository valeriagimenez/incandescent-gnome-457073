// summary.js
// ---------------------------------------------------------------------------
// Módulo 5 — Generador de Resúmenes de Texto (Fase 4).
//
// Flujo:
//   1. El usuario pega un texto largo y pulsa "Generar resumen".
//   2. Se envía a /.netlify/functions/groq-summary (openai/gpt-oss-120b),
//      que devuelve un JSON estructurado { summary, keyPoints[], terms[] }.
//   3. Se renderiza de forma estructurada y se guarda en Firestore:
//      chat_history/{uid}/sessions/{sessionId} con type: "summary".
// ---------------------------------------------------------------------------

import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc,
  setDoc,
  serverTimestamp,
  collection,
  query,
  orderBy,
  limit,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const SUMMARY_FUNCTION_URL = "/.netlify/functions/groq-summary";
const MAX_CHARS = 12000;

// Referencias al DOM
const inputEl = document.getElementById("summary-input");
const charCountEl = document.getElementById("summary-char-count");
const generateBtn = document.getElementById("summary-generate-btn");
const errorEl = document.getElementById("summary-error");
const loadingEl = document.getElementById("summary-loading");

const resultEl = document.getElementById("summary-result");
const resultTextEl = document.getElementById("summary-result-text");
const resultPointsEl = document.getElementById("summary-result-points");
const termsWrapperEl = document.getElementById("summary-result-terms-wrapper");
const termsEl = document.getElementById("summary-result-terms");
const savedIndicatorEl = document.getElementById("summary-saved-indicator");
const copyBtn = document.getElementById("summary-copy-btn");

const historyBtn = document.getElementById("summary-history-btn");
const historyPanel = document.getElementById("summary-history-panel");
const historyList = document.getElementById("summary-history-list");
const historyEmpty = document.getElementById("summary-history-empty");
const historyLoading = document.getElementById("summary-history-loading");
const newBtn = document.getElementById("summary-new-btn");

let currentUser = null;
let isGenerating = false;
let lastSummaryPlainText = "";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function showError(message) {
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
}

function clearError() {
  errorEl.classList.add("hidden");
  errorEl.textContent = "";
}

function updateCharCount() {
  const len = inputEl.value.length;
  charCountEl.textContent = `${len} / ${MAX_CHARS}`;
  charCountEl.classList.toggle("text-coral", len >= MAX_CHARS);
}

function clearElement(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

// ---------------------------------------------------------------------------
// Render del resultado estructurado
// ---------------------------------------------------------------------------
function renderResult(result, rawFallback) {
  resultEl.classList.remove("hidden");
  savedIndicatorEl.classList.add("hidden");

  if (!result) {
    // El modelo no devolvió JSON válido: mostramos el texto crudo como respaldo.
    resultTextEl.textContent = rawFallback || "No se pudo estructurar el resumen.";
    clearElement(resultPointsEl);
    termsWrapperEl.classList.add("hidden");
    lastSummaryPlainText = rawFallback || "";
    return;
  }

  resultTextEl.textContent = result.summary;

  clearElement(resultPointsEl);
  result.keyPoints.forEach((point) => {
    const li = document.createElement("li");
    li.className = "flex gap-2";
    const bullet = document.createElement("span");
    bullet.className = "text-teal shrink-0";
    bullet.textContent = "●";
    const text = document.createElement("span");
    text.textContent = point;
    li.appendChild(bullet);
    li.appendChild(text);
    resultPointsEl.appendChild(li);
  });

  clearElement(termsEl);
  if (result.terms.length > 0) {
    termsWrapperEl.classList.remove("hidden");
    result.terms.forEach(({ term, definition }) => {
      const dt = document.createElement("dt");
      dt.className = "font-semibold text-ink";
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.className = "text-ink/60 mb-1.5";
      dd.textContent = definition || "";
      termsEl.appendChild(dt);
      termsEl.appendChild(dd);
    });
  } else {
    termsWrapperEl.classList.add("hidden");
  }

  // Texto plano para el botón "Copiar".
  const pointsText = result.keyPoints.map((p) => `• ${p}`).join("\n");
  const termsText = result.terms.map((t) => `- ${t.term}: ${t.definition}`).join("\n");
  lastSummaryPlainText = [
    result.summary,
    "",
    "Puntos clave:",
    pointsText,
    ...(result.terms.length ? ["", "Términos importantes:", termsText] : []),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Persistencia en Firestore
// ---------------------------------------------------------------------------
async function persistSummary(sourceText, result, raw) {
  if (!currentUser) return null;

  const sessionId = `summary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    await setDoc(doc(db, "chat_history", currentUser.uid, "sessions", sessionId), {
      type: "summary",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      sourceText, // texto completo (ya truncado a MAX_CHARS antes de llegar aquí)
      sourceTextLength: sourceText.length,
      result: result || null,
      raw: result ? null : raw,
    });
    savedIndicatorEl.classList.remove("hidden");
    return sessionId;
  } catch (error) {
    console.error("No se pudo guardar el resumen en el historial:", error);
    // No bloqueamos la experiencia si falla el guardado.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Generar resumen
// ---------------------------------------------------------------------------
async function generateSummary() {
  const text = inputEl.value.trim();

  if (!currentUser) {
    showError("Debes iniciar sesión para usar esta herramienta.");
    return;
  }
  if (text.length < 40) {
    showError("Pega un texto un poco más largo para poder resumirlo (mínimo ~40 caracteres).");
    return;
  }
  if (isGenerating) return;

  clearError();
  isGenerating = true;
  generateBtn.disabled = true;
  loadingEl.classList.remove("hidden");
  loadingEl.classList.add("flex");
  resultEl.classList.add("hidden");

  try {
    const response = await fetch(SUMMARY_FUNCTION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid: currentUser.uid, text }),
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      throw new Error(errBody.error || `Error del servidor (${response.status})`);
    }

    const data = await response.json();
    renderResult(data.result, data.raw);
    await persistSummary(text, data.result, data.raw);
  } catch (error) {
    console.error("Error al generar el resumen:", error);
    showError("No se pudo generar el resumen. Verifica tu conexión e intenta de nuevo.");
  } finally {
    isGenerating = false;
    generateBtn.disabled = false;
    loadingEl.classList.add("hidden");
    loadingEl.classList.remove("flex");
  }
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------
inputEl?.addEventListener("input", updateCharCount);
generateBtn?.addEventListener("click", generateSummary);

copyBtn?.addEventListener("click", async () => {
  if (!lastSummaryPlainText) return;
  try {
    await navigator.clipboard.writeText(lastSummaryPlainText);
    const original = copyBtn.textContent;
    copyBtn.textContent = "¡Copiado!";
    setTimeout(() => (copyBtn.textContent = original), 1500);
  } catch (error) {
    console.error("No se pudo copiar al portapapeles:", error);
  }
});

// ---------------------------------------------------------------------------
// Historial de resúmenes
// Reutiliza chat_history/{uid}/sessions (mismo patrón que el chat), filtrando
// por type === "summary". Se consultan las últimas 30 sesiones (mezclando
// chats y resúmenes) y se filtra en el cliente para no requerir un índice
// compuesto de Firestore; a esta escala es más que suficiente.
// ---------------------------------------------------------------------------
function relativeDate(date) {
  if (!date) return "";
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "Justo ahora";
  if (diffMin < 60) return `Hace ${diffMin} min`;
  const diffHrs = Math.round(diffMin / 60);
  if (diffHrs < 24) return `Hace ${diffHrs} h`;
  const diffDays = Math.round(diffHrs / 24);
  if (diffDays === 1) return "Ayer";
  if (diffDays < 7) return `Hace ${diffDays} días`;
  return date.toLocaleDateString("es", { day: "numeric", month: "short" });
}

function historyPreviewLabel(data) {
  const label = data.result?.summary || data.sourceText || "Resumen";
  return label.length > 70 ? `${label.slice(0, 70)}…` : label;
}

function renderHistoryList(sessions) {
  historyList.querySelectorAll(".history-item").forEach((el) => el.remove());
  historyLoading.classList.add("hidden");

  if (sessions.length === 0) {
    historyEmpty.classList.remove("hidden");
    return;
  }
  historyEmpty.classList.add("hidden");

  sessions.forEach(({ id, data }) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className =
      "history-item w-full text-left px-4 py-3 hover:bg-teal/5 transition flex flex-col gap-0.5";

    const title = document.createElement("p");
    title.className = "text-xs font-medium text-ink truncate";
    title.textContent = historyPreviewLabel(data);

    const metaEl = document.createElement("p");
    metaEl.className = "text-[11px] text-ink/40 font-mono";
    const updatedAt = data.updatedAt?.toDate ? data.updatedAt.toDate() : null;
    metaEl.textContent = relativeDate(updatedAt);

    item.appendChild(title);
    item.appendChild(metaEl);
    item.addEventListener("click", () => loadHistoryItem(data));
    historyList.appendChild(item);
  });
}

async function loadSummaryHistoryList() {
  if (!currentUser) return;

  historyEmpty.classList.add("hidden");
  historyLoading.classList.remove("hidden");
  historyList.querySelectorAll(".history-item").forEach((el) => el.remove());

  try {
    const sessionsRef = collection(db, "chat_history", currentUser.uid, "sessions");
    const q = query(sessionsRef, orderBy("updatedAt", "desc"), limit(30));
    const snapshot = await getDocs(q);

    const sessions = snapshot.docs
      .map((d) => ({ id: d.id, data: d.data() }))
      .filter((s) => s.data.type === "summary");

    renderHistoryList(sessions);
  } catch (error) {
    console.error("No se pudo cargar el historial de resúmenes:", error);
    historyLoading.classList.add("hidden");
    historyEmpty.textContent = "No se pudo cargar el historial.";
    historyEmpty.classList.remove("hidden");
  }
}

function loadHistoryItem(data) {
  inputEl.value = data.sourceText || "";
  updateCharCount();
  clearError();
  renderResult(data.result, data.raw);
  savedIndicatorEl.classList.remove("hidden"); // ya estaba guardado
  historyPanel.classList.add("hidden");
}

function toggleHistoryPanel() {
  const isHidden = historyPanel.classList.contains("hidden");
  if (isHidden) {
    historyPanel.classList.remove("hidden");
    loadSummaryHistoryList();
  } else {
    historyPanel.classList.add("hidden");
  }
}

historyBtn?.addEventListener("click", toggleHistoryPanel);

document.addEventListener("click", (event) => {
  if (
    !historyPanel.classList.contains("hidden") &&
    !historyPanel.contains(event.target) &&
    event.target !== historyBtn
  ) {
    historyPanel.classList.add("hidden");
  }
});

// ---------------------------------------------------------------------------
// "+ Nuevo": limpia el input y el resultado para empezar un resumen nuevo.
// ---------------------------------------------------------------------------
newBtn?.addEventListener("click", () => {
  inputEl.value = "";
  updateCharCount();
  clearError();
  resultEl.classList.add("hidden");
  savedIndicatorEl.classList.add("hidden");
  lastSummaryPlainText = "";
  inputEl.focus();
});

onAuthStateChanged(auth, (user) => {
  currentUser = user;
});

updateCharCount();
