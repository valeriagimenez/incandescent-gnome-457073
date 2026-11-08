// voice.js
// ---------------------------------------------------------------------------
// Módulo 8 — Reconocimiento de Voz (Fase 4).
//
// Flujo:
//   1. El usuario pulsa 🎤 en la barra de chat → pide permiso de micrófono
//      y empieza a grabar con MediaRecorder.
//   2. Pulsa de nuevo (ahora en estado "grabando") para detener.
//   3. El audio grabado se convierte a Base64 y se envía a
//      /.netlify/functions/groq-whisper (modelo whisper-large-v3).
//   4. El texto transcrito se inserta en el input del chat, listo para
//      enviar o editar antes de enviar.
// ---------------------------------------------------------------------------

const WHISPER_FUNCTION_URL = "/.netlify/functions/groq-whisper";
const MAX_RECORDING_MS = 60_000; // corte automático a los 60s para no generar audios enormes

const micBtn = document.getElementById("mic-btn");
const chatInput = document.getElementById("chat-input");
const chatErrorEl = document.getElementById("chat-error");

let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let isTranscribing = false;
let autoStopTimer = null;

// ---------------------------------------------------------------------------
// Helpers de UI
// ---------------------------------------------------------------------------
function showChatError(message) {
  if (!chatErrorEl) return;
  chatErrorEl.textContent = message;
  chatErrorEl.classList.remove("hidden");
}

function clearChatError() {
  chatErrorEl?.classList.add("hidden");
}

function setMicRecordingUI(recording) {
  micBtn.textContent = recording ? "⏹️" : "🎤";
  micBtn.title = recording ? "Detener grabación" : "Dictar por voz";
  micBtn.classList.toggle("border-coral", recording);
  micBtn.classList.toggle("text-coral", recording);
  micBtn.classList.toggle("animate-pulse", recording);
}

function setMicBusyUI(busy) {
  micBtn.disabled = busy;
  micBtn.classList.toggle("opacity-50", busy);
}

// ---------------------------------------------------------------------------
// Conversión Blob -> Base64 (data URL)
// ---------------------------------------------------------------------------
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------------------
// Grabación
// ---------------------------------------------------------------------------
async function startRecording() {
  clearChatError();

  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    showChatError("Tu navegador no soporta grabación de audio.");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];

    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) audioChunks.push(event.data);
    });
    mediaRecorder.addEventListener("stop", () => {
      stream.getTracks().forEach((track) => track.stop());
      handleRecordingStop();
    });

    mediaRecorder.start();
    isRecording = true;
    setMicRecordingUI(true);

    // Corte automático para evitar grabaciones larguísimas por error.
    autoStopTimer = setTimeout(() => {
      if (isRecording) stopRecording();
    }, MAX_RECORDING_MS);
  } catch (error) {
    console.error("Error al acceder al micrófono:", error);
    showChatError("No se pudo acceder al micrófono. Revisa los permisos del navegador.");
  }
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === "inactive") return;
  clearTimeout(autoStopTimer);
  mediaRecorder.stop();
  isRecording = false;
  setMicRecordingUI(false);
}

async function handleRecordingStop() {
  if (audioChunks.length === 0) return;

  const mimeType = mediaRecorder.mimeType || "audio/webm";
  const audioBlob = new Blob(audioChunks, { type: mimeType });
  audioChunks = [];

  if (audioBlob.size < 1000) {
    showChatError("La grabación fue muy corta. Intenta de nuevo.");
    return;
  }

  isTranscribing = true;
  setMicBusyUI(true);

  try {
    const audioBase64 = await blobToBase64(audioBlob);

    const response = await fetch(WHISPER_FUNCTION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioBase64, mimeType }),
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      throw new Error(errBody.error || `Error del servidor (${response.status})`);
    }

    const data = await response.json();
    const transcript = data.transcript?.trim();

    if (!transcript) throw new Error("La transcripción volvió vacía.");

    // Inserta el texto en el input del chat, junto a lo que ya hubiera escrito.
    const existing = chatInput.value.trim();
    chatInput.value = existing ? `${existing} ${transcript}` : transcript;
    chatInput.dispatchEvent(new Event("input")); // dispara el auto-grow del textarea
    chatInput.focus();
  } catch (error) {
    console.error("Error al transcribir el audio:", error);
    showChatError("No se pudo transcribir el audio. Verifica tu conexión e intenta de nuevo.");
  } finally {
    isTranscribing = false;
    setMicBusyUI(false);
  }
}

// ---------------------------------------------------------------------------
// Evento principal del botón
// ---------------------------------------------------------------------------
micBtn?.addEventListener("click", () => {
  if (isTranscribing) return;
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
});

// Si el usuario cambia de pestaña/app mientras graba, detenemos para no
// dejar el micrófono activo de fondo innecesariamente.
document.addEventListener("visibilitychange", () => {
  if (document.hidden && isRecording) {
    stopRecording();
  }
});
