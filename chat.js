// chat.js
// ---------------------------------------------------------------------------
// Módulo 3 — IA Tutor & Chat Educativo (Fase 2).
//
// Flujo:
//   1. El usuario escribe un mensaje.
//   2. Se envía TODO el historial de la conversación actual a la Netlify
//      Function `/.netlify/functions/groq-chat`, que llama a Groq con el
//      modelo openai/gpt-oss-120b y un system prompt de tutor socrático.
//      (La API key de Groq vive solo en el servidor, nunca en este archivo.)
//   3. La respuesta se pinta en pantalla y la conversación completa se
//      guarda/actualiza en Firestore: chat_history/{uid}/sessions/{sessionId}
//
// Este módulo se auto-inicializa solo cuando hay un usuario autenticado
// (escucha onAuthStateChanged), para no intentar escribir en Firestore
// antes de tener un uid.
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

const CHAT_FUNCTION_URL = "/.netlify/functions/groq-chat";

// ---------------------------------------------------------------------------
// Referencias al DOM
// ---------------------------------------------------------------------------
const messagesEl = document.getElementById("chat-messages");
const emptyStateEl = document.getElementById("chat-empty-state");
const typingEl = document.getElementById("chat-typing");
const formEl = document.getElementById("chat-form");
const inputEl = document.getElementById("chat-input");
const sendBtn = document.getElementById("chat-send-btn");
const newChatBtn = document.getElementById("chat-new-btn");
const errorEl = document.getElementById("chat-error");
const scannerBtn = document.getElementById("scanner-btn");
const micBtn = document.getElementById("mic-btn");

const historyBtn = document.getElementById("chat-history-btn");
const historyPanel = document.getElementById("chat-history-panel");
const historyList = document.getElementById("chat-history-list");
const historyEmpty = document.getElementById("chat-history-empty");
const historyLoading = document.getElementById("chat-history-loading");

// ---------------------------------------------------------------------------
// Estado local de la conversación
// ---------------------------------------------------------------------------
let currentUser = null;
let sessionId = null;
/** @type {{role: "user"|"assistant", content: string, at: number}[]} */
let conversation = [];
let isSending = false;

function newSessionId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function renderMessage(message) {
  emptyStateEl?.classList.add("hidden");

  const isUser = message.role === "user";
  const wrapper = document.createElement("div");
  wrapper.className = `flex ${isUser ? "justify-end" : "justify-start"}`;

  const col = document.createElement("div");
  col.className = `max-w-[85%] sm:max-w-[70%] flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`;

  const bubble = document.createElement("div");
  bubble.className = [
    "rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap",
    isUser
      ? "bg-teal text-void rounded-br-sm"
      : "bg-paper-200 text-ink-700 border border-ink/10 rounded-bl-sm",
  ].join(" ");
  bubble.textContent = message.content;
  col.appendChild(bubble);

  // Botón de copiar: solo en las respuestas de la IA (incluye los análisis
  // del escáner de tareas, que llegan por este mismo camino).
  if (!isUser) {
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className =
      "text-[11px] font-mono text-ink/30 hover:text-teal-700 transition px-1 flex items-center gap-1";
    copyBtn.innerHTML = "📋 Copiar";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(message.content);
        copyBtn.innerHTML = "✓ Copiado";
        setTimeout(() => (copyBtn.innerHTML = "📋 Copiar"), 1500);
      } catch (error) {
        console.error("No se pudo copiar al portapapeles:", error);
      }
    });
    col.appendChild(copyBtn);
  }

  wrapper.appendChild(col);
  messagesEl.appendChild(wrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function resetConversationUI() {
  messagesEl.querySelectorAll(":scope > div:not(#chat-empty-state)").forEach((el) => el.remove());
  emptyStateEl?.classList.remove("hidden");
}

function showChatError(message) {
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
}

function clearChatError() {
  errorEl.classList.add("hidden");
  errorEl.textContent = "";
}

function autoGrowTextarea() {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 128)}px`;
}

// ---------------------------------------------------------------------------
// Persistencia en Firestore: chat_history/{uid}/sessions/{sessionId}
// Guarda toda la sesión (no mensaje a mensaje) para minimizar escrituras.
// ---------------------------------------------------------------------------
async function persistSession() {
  if (!currentUser || conversation.length === 0) return;

  try {
    await setDoc(
      doc(db, "chat_history", currentUser.uid, "sessions", sessionId),
      {
        type: "chat",
        updatedAt: serverTimestamp(),
        createdAt: conversation[0]?.at ? new Date(conversation[0].at) : serverTimestamp(),
        messageCount: conversation.length,
        messages: conversation,
      },
      { merge: true }
    );
  } catch (error) {
    // No bloqueamos la conversación si falla el guardado; solo lo registramos.
    console.error("No se pudo guardar el historial de chat:", error);
  }
}

// ---------------------------------------------------------------------------
// Envío de mensaje
// ---------------------------------------------------------------------------
async function sendMessage(text) {
  if (!currentUser) {
    showChatError("Debes iniciar sesión para usar el tutor.");
    return;
  }

  clearChatError();

  const userMessage = { role: "user", content: text, at: Date.now() };
  conversation.push(userMessage);
  renderMessage(userMessage);

  inputEl.value = "";
  autoGrowTextarea();

  isSending = true;
  sendBtn.disabled = true;
  typingEl.classList.remove("hidden");
  messagesEl.scrollTop = messagesEl.scrollHeight;

  try {
    const response = await fetch(CHAT_FUNCTION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uid: currentUser.uid,
        messages: conversation.map(({ role, content }) => ({ role, content })),
      }),
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      throw new Error(errBody.error || `Error del servidor (${response.status})`);
    }

    const data = await response.json();
    const reply = data.reply?.trim();

    if (!reply) throw new Error("El tutor no devolvió una respuesta.");

    const assistantMessage = { role: "assistant", content: reply, at: Date.now() };
    conversation.push(assistantMessage);
    renderMessage(assistantMessage);

    await persistSession();
  } catch (error) {
    console.error("Error al hablar con el tutor:", error);
    showChatError(
      "No se pudo contactar al tutor en este momento. Verifica tu conexión e intenta de nuevo."
    );
    // Revertimos el mensaje del usuario del historial en memoria si falló
    // por completo, para que un reintento no duplique contexto roto.
    conversation.pop();
  } finally {
    isSending = false;
    sendBtn.disabled = false;
    typingEl.classList.add("hidden");
  }
}

// ---------------------------------------------------------------------------
// Eventos de UI
// ---------------------------------------------------------------------------
formEl?.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text || isSending) return;
  sendMessage(text);
});

inputEl?.addEventListener("input", autoGrowTextarea);

inputEl?.addEventListener("keydown", (event) => {
  // Enter envía; Shift+Enter hace salto de línea.
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    formEl.requestSubmit();
  }
});

newChatBtn?.addEventListener("click", () => {
  if (isSending) return;
  sessionId = newSessionId();
  conversation = [];
  resetConversationUI();
  clearChatError();
});

// El botón de escáner lo controla scanner.js (abre el modal de cámara) y el
// de micrófono lo controla voice.js (graba y transcribe con Groq Whisper);
// este archivo solo escucha el resultado del escáner vía "scanner:result".

// Cuando scanner.js termina de analizar una foto, inserta el resultado
// como un mensaje del "tutor" dentro de la misma conversación y lo persiste
// junto con el resto del historial de chat_history/{uid}.
window.addEventListener("scanner:result", async (event) => {
  const analysis = event.detail?.analysis?.trim();
  if (!analysis || !currentUser) return;

  const scanMessage = {
    role: "assistant",
    content: analysis,
    at: Date.now(),
    source: "scanner", // marca de origen para diferenciarlo en el historial
  };

  conversation.push(scanMessage);
  renderMessage(scanMessage);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  await persistSession();
});

// ---------------------------------------------------------------------------
// Historial de conversaciones (Módulo 9 — UI)
// Lista las últimas sesiones guardadas en chat_history/{uid}/sessions y
// permite retomar cualquiera de ellas, cargando sus mensajes en pantalla.
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

function sessionPreviewLabel(sessionData) {
  const firstUserMsg = (sessionData.messages || []).find((m) => m.role === "user");
  const label = firstUserMsg?.content || "Conversación";
  return label.length > 60 ? `${label.slice(0, 60)}…` : label;
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
    title.textContent = sessionPreviewLabel(data);

    const metaEl = document.createElement("p");
    metaEl.className = "text-[11px] text-ink/40 font-mono";
    const updatedAt = data.updatedAt?.toDate ? data.updatedAt.toDate() : null;
    metaEl.textContent = `${data.messageCount || (data.messages || []).length} mensajes · ${relativeDate(updatedAt)}`;

    item.appendChild(title);
    item.appendChild(metaEl);

    item.addEventListener("click", () => loadSession(id, data));
    historyList.appendChild(item);
  });
}

async function loadChatHistoryList() {
  if (!currentUser) return;

  historyEmpty.classList.add("hidden");
  historyLoading.classList.remove("hidden");
  historyList.querySelectorAll(".history-item").forEach((el) => el.remove());

  try {
    const sessionsRef = collection(db, "chat_history", currentUser.uid, "sessions");
    const q = query(sessionsRef, orderBy("updatedAt", "desc"), limit(20));
    const snapshot = await getDocs(q);

    const sessions = snapshot.docs
      .map((d) => ({ id: d.id, data: d.data() }))
      .filter((s) => (s.data.messages || []).length > 0);

    renderHistoryList(sessions);
  } catch (error) {
    console.error("No se pudo cargar el historial de chats:", error);
    historyLoading.classList.add("hidden");
    historyEmpty.textContent = "No se pudo cargar el historial.";
    historyEmpty.classList.remove("hidden");
  }
}

function loadSession(id, data) {
  sessionId = id;
  conversation = (data.messages || []).map((m) => ({ ...m }));
  resetConversationUI();
  conversation.forEach(renderMessage);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  clearChatError();
  historyPanel.classList.add("hidden");
}

function toggleHistoryPanel() {
  const isHidden = historyPanel.classList.contains("hidden");
  if (isHidden) {
    historyPanel.classList.remove("hidden");
    loadChatHistoryList();
  } else {
    historyPanel.classList.add("hidden");
  }
}

historyBtn?.addEventListener("click", toggleHistoryPanel);

// Cierra el panel al hacer click fuera de él.
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
// Inicialización ligada a la sesión de Firebase Auth
// ---------------------------------------------------------------------------
onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (user) {
    sessionId = newSessionId();
    conversation = [];
    resetConversationUI();
  }
});
