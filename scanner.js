// scanner.js
// ---------------------------------------------------------------------------
// Módulo 4 — Escáner de Tareas con Groq Vision (Fase 3).
//
// Flujo:
//   1. El usuario pulsa 📷 en la barra de chat → se abre el modal y se pide
//      acceso a la cámara con getUserMedia().
//   2. Captura una foto sobre un <canvas> y la convierte a Base64 (JPEG).
//   3. Se envía a /.netlify/functions/groq-vision (modelo
//      llama-3.2-11b-vision-preview).
//   4. El resultado se despacha como CustomEvent "scanner:result", que
//      chat.js escucha para insertarlo en la conversación y guardarlo en
//      Firestore junto con el resto del historial.
// ---------------------------------------------------------------------------

const VISION_FUNCTION_URL = "/.netlify/functions/groq-vision";
const QUIZ_FUNCTION_URL = "/.netlify/functions/groq-quiz";

// Redimensionamos toda imagen (cámara o archivo subido) a este lado máximo
// antes de convertirla a Base64. Las fotos de celular a resolución completa
// (4000px+) generan payloads de varios MB que exceden el límite de las
// Netlify Functions síncronas (~6MB) y provocan fallos silenciosos — este
// límite evita eso sin perder legibilidad del texto para el OCR.
const MAX_IMAGE_DIMENSION = 1600;
const JPEG_QUALITY = 0.85;

// Referencias al DOM
const scannerBtn = document.getElementById("scanner-btn");
const modal = document.getElementById("scanner-modal");
const closeBtn = document.getElementById("scanner-close-btn");

const liveView = document.getElementById("scanner-live");
const videoEl = document.getElementById("scanner-video");
const videoHint = document.getElementById("scanner-video-hint");
const captureBtn = document.getElementById("scanner-capture-btn");
const uploadBtn = document.getElementById("scanner-upload-btn");
const fileInput = document.getElementById("scanner-file-input");

const previewView = document.getElementById("scanner-preview");
const previewImg = document.getElementById("scanner-preview-img");
const retakeBtn = document.getElementById("scanner-retake-btn");
const analyzeBtn = document.getElementById("scanner-analyze-btn");

const errorEl = document.getElementById("scanner-error");
const canvasEl = document.getElementById("scanner-canvas");

// Cuestionario de autoevaluación
const quizBtn = document.getElementById("scanner-quiz-btn");
const quizView = document.getElementById("scanner-quiz");
const quizTitleEl = document.getElementById("quiz-title");
const quizProgressEl = document.getElementById("quiz-progress");
const quizQuestionView = document.getElementById("quiz-question-view");
const quizQuestionEl = document.getElementById("quiz-question");
const quizOptionsEl = document.getElementById("quiz-options");
const quizFeedbackEl = document.getElementById("quiz-feedback");
const quizNextBtn = document.getElementById("quiz-next-btn");
const quizResultView = document.getElementById("quiz-result-view");
const quizResultEmoji = document.getElementById("quiz-result-emoji");
const quizResultScore = document.getElementById("quiz-result-score");
const quizResultMsg = document.getElementById("quiz-result-msg");
const quizRetryBtn = document.getElementById("quiz-retry-btn");
const quizBackBtn = document.getElementById("quiz-back-btn");

let mediaStream = null;
let capturedImageBase64 = null;
let isAnalyzing = false;
let isGeneratingQuiz = false;

// ---------------------------------------------------------------------------
// Helpers de UI
// ---------------------------------------------------------------------------
function showScannerError(message) {
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
}

function clearScannerError() {
  errorEl.classList.add("hidden");
  errorEl.textContent = "";
}

function showLiveView() {
  quizView.classList.add("hidden");
  previewView.classList.add("hidden");
  liveView.classList.remove("hidden");
}

function showPreviewView() {
  quizView.classList.add("hidden");
  liveView.classList.add("hidden");
  previewView.classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// Cámara
// ---------------------------------------------------------------------------
async function startCamera() {
  clearScannerError();
  videoHint.textContent = "Activando cámara…";
  videoHint.classList.remove("hidden");

  if (!navigator.mediaDevices?.getUserMedia) {
    showScannerError("Tu navegador no soporta acceso a la cámara.");
    videoHint.classList.add("hidden");
    return;
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" }, // prioriza cámara trasera en móviles
      audio: false,
    });
    videoEl.srcObject = mediaStream;
    videoHint.classList.add("hidden");
  } catch (error) {
    console.error("Error al acceder a la cámara:", error);
    showScannerError(
      "No se pudo acceder a la cámara. Revisa los permisos del navegador e intenta de nuevo."
    );
    videoHint.classList.add("hidden");
  }
}

function stopCamera() {
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  videoEl.srcObject = null;
}

// ---------------------------------------------------------------------------
// Redimensionado compartido: dibuja cualquier fuente (<video> o <img>) sobre
// el <canvas> oculto, respetando el aspect ratio y sin superar
// MAX_IMAGE_DIMENSION en su lado más largo. Devuelve un data URL JPEG.
// ---------------------------------------------------------------------------
function drawResizedToCanvas(source, naturalWidth, naturalHeight) {
  let targetW = naturalWidth;
  let targetH = naturalHeight;

  if (targetW > MAX_IMAGE_DIMENSION || targetH > MAX_IMAGE_DIMENSION) {
    const scale = MAX_IMAGE_DIMENSION / Math.max(targetW, targetH);
    targetW = Math.round(targetW * scale);
    targetH = Math.round(targetH * scale);
  }

  canvasEl.width = targetW;
  canvasEl.height = targetH;

  const ctx = canvasEl.getContext("2d");
  ctx.drawImage(source, 0, 0, targetW, targetH);

  return canvasEl.toDataURL("image/jpeg", JPEG_QUALITY);
}

// ---------------------------------------------------------------------------
// Captura desde la cámara → Base64
// ---------------------------------------------------------------------------
function capturePhoto() {
  if (!mediaStream || !videoEl.videoWidth) {
    showScannerError("La cámara aún no está lista. Espera un momento.");
    return;
  }

  capturedImageBase64 = drawResizedToCanvas(videoEl, videoEl.videoWidth, videoEl.videoHeight);
  previewImg.src = capturedImageBase64;

  stopCamera();
  showPreviewView();
}

// ---------------------------------------------------------------------------
// Subida de archivo → Base64 (alternativa a usar la cámara)
// ---------------------------------------------------------------------------
function handleFileSelected(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    showScannerError("Selecciona un archivo de imagen (JPG, PNG, etc.).");
    return;
  }

  clearScannerError();

  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      capturedImageBase64 = drawResizedToCanvas(img, img.naturalWidth, img.naturalHeight);
      previewImg.src = capturedImageBase64;
      stopCamera();
      showPreviewView();
    };
    img.onerror = () => showScannerError("No se pudo leer la imagen seleccionada.");
    img.src = reader.result;
  };
  reader.onerror = () => showScannerError("No se pudo leer el archivo seleccionado.");
  reader.readAsDataURL(file);
}

function retakePhoto() {
  capturedImageBase64 = null;
  if (fileInput) fileInput.value = "";
  clearScannerError();
  showLiveView();
  startCamera();
}

// ---------------------------------------------------------------------------
// Envío a Groq Vision
// ---------------------------------------------------------------------------
async function analyzePhoto() {
  if (!capturedImageBase64 || isAnalyzing || isGeneratingQuiz) return;

  isAnalyzing = true;
  clearScannerError();
  analyzeBtn.disabled = true;
  analyzeBtn.textContent = "Analizando…";

  try {
    const response = await fetch(VISION_FUNCTION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64: capturedImageBase64 }),
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      throw new Error(errBody.error || `Error del servidor (${response.status})`);
    }

    const data = await response.json();
    const analysis = data.analysis?.trim();

    if (!analysis) throw new Error("El análisis volvió vacío.");

    // Entrega el resultado a chat.js, que lo pinta en la conversación
    // y lo guarda junto con el historial de chat_history/{uid}.
    window.dispatchEvent(new CustomEvent("scanner:result", { detail: { analysis } }));

    closeModal();
  } catch (error) {
    console.error("Error al analizar la tarea:", error);
    const message =
      error instanceof TypeError
        ? "No hay conexión con el servidor. Verifica tu internet e intenta de nuevo."
        : error.message || "No se pudo analizar la imagen. Intenta de nuevo.";
    showScannerError(message);
  } finally {
    isAnalyzing = false;
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = "Analizar con IA";
  }
}

// ---------------------------------------------------------------------------
// Cuestionario de autoevaluación (5 preguntas generadas con IA)
//
// Reutiliza la misma foto que "Analizar con IA": se envía a
// /.netlify/functions/groq-quiz, que devuelve 5 preguntas de opción múltiple
// ya validadas. Aquí se mezclan las opciones (los modelos tienden a poner la
// correcta en la primera posición) y se corrige al instante, pregunta a
// pregunta, mostrando una explicación. Todo el texto se pinta con textContent
// (viene de un modelo de IA, nunca se inserta como HTML).
// ---------------------------------------------------------------------------
let quizData = null; // { title, questions: [{ question, options: [{text, isCorrect}], explanation }] }
let quizIndex = 0;
let quizScore = 0;
let quizAnswered = false;

function shuffled(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function prepareQuiz(raw) {
  return {
    title: raw.title || "Autoevaluación",
    questions: raw.questions.map((q) => ({
      question: q.question,
      explanation: q.explanation,
      options: shuffled(
        q.options.map((text, i) => ({ text, isCorrect: i === q.correctIndex }))
      ),
    })),
  };
}

function showQuizView() {
  liveView.classList.add("hidden");
  previewView.classList.add("hidden");
  quizView.classList.remove("hidden");
}

function renderQuizQuestion() {
  const q = quizData.questions[quizIndex];
  quizAnswered = false;

  quizResultView.classList.add("hidden");
  quizQuestionView.classList.remove("hidden");
  quizFeedbackEl.classList.add("hidden");
  quizNextBtn.classList.add("hidden");

  quizTitleEl.textContent = quizData.title;
  quizProgressEl.textContent = `${quizIndex + 1} / ${quizData.questions.length}`;
  quizQuestionEl.textContent = q.question;

  quizOptionsEl.replaceChildren();
  const letters = ["A", "B", "C", "D"];
  q.options.forEach((opt, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "quiz-option w-full text-left rounded-lg border border-ink/15 px-3 py-2.5 text-sm text-ink " +
      "hover:bg-ink/5 transition flex gap-2";
    const letter = document.createElement("span");
    letter.className = "font-mono text-ink/40 shrink-0";
    letter.textContent = `${letters[i]}.`;
    const label = document.createElement("span");
    label.textContent = opt.text;
    btn.append(letter, label);
    btn.addEventListener("click", () => answerQuizQuestion(btn, opt));
    quizOptionsEl.appendChild(btn);
  });
}

function answerQuizQuestion(clickedBtn, chosen) {
  if (quizAnswered) return; // una sola respuesta por pregunta
  quizAnswered = true;

  const q = quizData.questions[quizIndex];
  if (chosen.isCorrect) quizScore++;

  // Marca la correcta en verde y, si falló, la elegida en rojo.
  const buttons = Array.from(quizOptionsEl.children);
  buttons.forEach((btn, i) => {
    btn.disabled = true;
    // Se quita el borde gris base para que el color de estado siempre gane.
    btn.classList.remove("hover:bg-ink/5", "border-ink/15");
    if (q.options[i].isCorrect) {
      btn.classList.add("border-marigold/60", "bg-marigold/15");
    } else if (btn === clickedBtn) {
      btn.classList.add("border-coral/60", "bg-coral/15");
    } else {
      btn.classList.add("opacity-50");
    }
  });

  quizFeedbackEl.className = [
    "rounded-lg border px-3 py-2 text-xs leading-relaxed",
    chosen.isCorrect
      ? "border-marigold/40 bg-marigold/10 text-ink"
      : "border-coral/30 bg-coral/10 text-ink",
  ].join(" ");
  const verdict = chosen.isCorrect ? "✓ ¡Correcto!" : "✗ Incorrecto.";
  quizFeedbackEl.textContent = q.explanation ? `${verdict} ${q.explanation}` : verdict;
  quizFeedbackEl.classList.remove("hidden");

  const isLast = quizIndex === quizData.questions.length - 1;
  quizNextBtn.textContent = isLast ? "Ver resultado" : "Siguiente";
  quizNextBtn.classList.remove("hidden");
}

function showQuizResult() {
  const total = quizData.questions.length;
  const ratio = quizScore / total;

  quizQuestionView.classList.add("hidden");
  quizResultView.classList.remove("hidden");
  quizProgressEl.textContent = "";

  quizResultScore.textContent = `${quizScore} de ${total} correctas`;
  if (ratio === 1) {
    quizResultEmoji.textContent = "🏆";
    quizResultMsg.textContent = "¡Perfecto! Dominas este tema.";
  } else if (ratio >= 0.7) {
    quizResultEmoji.textContent = "🎉";
    quizResultMsg.textContent = "¡Muy bien! Repasa lo que fallaste y lo tendrás.";
  } else {
    quizResultEmoji.textContent = "📚";
    quizResultMsg.textContent = "Aún te falta repasar. Vuelve a mirar la hoja y reintenta.";
  }
}

function startQuiz() {
  quizIndex = 0;
  quizScore = 0;
  renderQuizQuestion();
}

quizNextBtn?.addEventListener("click", () => {
  if (quizIndex < quizData.questions.length - 1) {
    quizIndex++;
    renderQuizQuestion();
  } else {
    showQuizResult();
  }
});

// Reintentar vuelve a mezclar las opciones, para no memorizar posiciones.
quizRetryBtn?.addEventListener("click", () => {
  quizData = prepareQuiz({
    title: quizData.title,
    questions: quizData.questions.map((q) => ({
      question: q.question,
      explanation: q.explanation,
      options: q.options.map((o) => o.text),
      correctIndex: q.options.findIndex((o) => o.isCorrect),
    })),
  });
  startQuiz();
});

quizBackBtn?.addEventListener("click", () => {
  quizData = null;
  showPreviewView();
});

async function generateQuiz() {
  if (!capturedImageBase64 || isGeneratingQuiz || isAnalyzing) return;

  isGeneratingQuiz = true;
  clearScannerError();
  quizBtn.disabled = true;
  analyzeBtn.disabled = true;
  quizBtn.textContent = "Creando cuestionario…";

  try {
    const response = await fetch(QUIZ_FUNCTION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64: capturedImageBase64 }),
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      throw new Error(errBody.error || `Error del servidor (${response.status})`);
    }

    const data = await response.json();
    if (!Array.isArray(data.questions) || data.questions.length === 0) {
      throw new Error("El cuestionario volvió vacío.");
    }

    // Si el usuario cerró el modal mientras se generaba, no mostramos nada.
    if (modal.classList.contains("hidden")) return;

    quizData = prepareQuiz(data);
    showQuizView();
    startQuiz();
  } catch (error) {
    console.error("Error al generar el cuestionario:", error);
    const message =
      error instanceof TypeError
        ? "No hay conexión con el servidor. Verifica tu internet e intenta de nuevo."
        : error.message || "No se pudo crear el cuestionario. Intenta de nuevo.";
    showScannerError(message);
  } finally {
    isGeneratingQuiz = false;
    quizBtn.disabled = false;
    analyzeBtn.disabled = false;
    quizBtn.textContent = "🧠 Crear cuestionario (5 preguntas)";
  }
}

quizBtn?.addEventListener("click", generateQuiz);

// ---------------------------------------------------------------------------
// Modal open/close
// ---------------------------------------------------------------------------
function openModal() {
  modal.classList.remove("hidden");
  capturedImageBase64 = null;
  if (fileInput) fileInput.value = "";
  clearScannerError();
  showLiveView();
  startCamera();
}

function closeModal() {
  modal.classList.add("hidden");
  stopCamera();
  capturedImageBase64 = null;
  quizData = null;
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------
scannerBtn?.addEventListener("click", openModal);
closeBtn?.addEventListener("click", closeModal);
captureBtn?.addEventListener("click", capturePhoto);
retakeBtn?.addEventListener("click", retakePhoto);
analyzeBtn?.addEventListener("click", analyzePhoto);
uploadBtn?.addEventListener("click", () => fileInput.click());
fileInput?.addEventListener("change", handleFileSelected);

// Permite abrir el escáner también desde el ítem "Escáner de tareas" del
// nav lateral/inferior (app-nav.js), sin duplicar la lógica del modal.
window.addEventListener("scanner:open", openModal);

// Cierre por click fuera del panel (backdrop)
modal?.addEventListener("click", (event) => {
  if (event.target === modal) closeModal();
});

// Detiene la cámara si el usuario cambia de pestaña/app para no dejarla
// encendida de fondo innecesariamente.
document.addEventListener("visibilitychange", () => {
  if (document.hidden && mediaStream) {
    stopCamera();
    if (!modal.classList.contains("hidden")) {
      showScannerError("La cámara se pausó. Vuelve a intentarlo.");
      showLiveView();
    }
  }
});
