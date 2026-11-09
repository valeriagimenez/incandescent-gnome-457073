// netlify/functions/groq-quiz.js
// ---------------------------------------------------------------------------
// Proxy serverless para el Cuestionario de Autoevaluación del Escáner.
//
// Recibe la misma foto que usa groq-vision (data URL), se la envía al modelo
// de visión de Groq y le pide un cuestionario de EXACTAMENTE 5 preguntas de
// opción múltiple basadas SOLO en el contenido visible de la hoja.
//
// Contrato:
//   POST /.netlify/functions/groq-quiz
//   body: { imageBase64: string /* data URL completa */ }
//   -> 200 { title: string, questions: [{ question, options[4], correctIndex, explanation }] }
//   -> 4xx/5xx { error: string }
// ---------------------------------------------------------------------------

const { callGroqVision, groqErrorMessage } = require("../lib/groq-vision");
// El modelo de visión se resuelve en ../lib/groq-vision.js (con respaldo
// automático si Groq lo renombra o lo retira).

const QUESTION_COUNT = 5;
const OPTION_COUNT = 4;
const MAX_BASE64_LENGTH = 8_000_000; // igual que groq-vision.js

const QUIZ_PROMPT = `Observa esta hoja escaneada (apuntes, ejercicio o material de estudio) y \
crea un cuestionario de autoevaluación para un estudiante.

Responde ÚNICAMENTE con un objeto JSON válido (sin texto antes o después y sin bloques de \
código markdown), con exactamente esta forma:

{
  "title": "tema de la hoja en pocas palabras",
  "questions": [
    {
      "question": "enunciado de la pregunta",
      "options": ["opción A", "opción B", "opción C", "opción D"],
      "correctIndex": 0,
      "explanation": "una frase que explica por qué esa es la respuesta correcta"
    }
  ]
}

Reglas:
- Exactamente ${QUESTION_COUNT} preguntas, todas de opción múltiple con exactamente ${OPTION_COUNT} opciones.
- "correctIndex" es el número (0 a ${OPTION_COUNT - 1}) de la opción correcta. Varía su posición entre preguntas.
- Basa las preguntas SOLO en lo que se ve en la hoja; no inventes datos que no aparezcan.
- Mezcla niveles: algunas de comprensión del contenido y otras de aplicación.
- Las opciones incorrectas deben ser plausibles, no absurdas.
- Si la hoja trae ejercicios con resultado, calcula bien la respuesta correcta.
- Si la imagen no tiene contenido de estudio legible, devuelve {"title":"","questions":[]}.
- Todo en español.`;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Método no permitido." });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error("Falta la variable de entorno GROQ_API_KEY en Netlify.");
    return respond(500, { error: "El servicio de IA no está configurado." });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return respond(400, { error: "Cuerpo de la solicitud inválido." });
  }

  const { imageBase64 } = payload;

  if (typeof imageBase64 !== "string" || !imageBase64.startsWith("data:image/")) {
    return respond(400, {
      error: "Se requiere `imageBase64` como data URL (ej. data:image/jpeg;base64,...).",
    });
  }

  if (imageBase64.length > MAX_BASE64_LENGTH) {
    return respond(413, { error: "La imagen es demasiado grande. Intenta con una foto más comprimida." });
  }

  try {
    const groqResponse = await callGroqVision(apiKey, {
      prompt: QUIZ_PROMPT,
      imageBase64,
      temperature: 0.4,
      maxTokens: 2000,
    });

    if (!groqResponse.ok) {
      const errText = await groqResponse.text();
      console.error("Error de Groq (quiz):", groqResponse.status, errText);
      return respond(502, { error: groqErrorMessage(groqResponse.status, "No se pudo generar el cuestionario en este momento.") });
    }

    const data = await groqResponse.json();
    const raw = data.choices?.[0]?.message?.content || "";

    const quiz = parseQuiz(raw);
    if (!quiz) {
      return respond(502, {
        error:
          "No se pudo armar un cuestionario con esta hoja. Prueba con una foto más nítida y con más texto.",
      });
    }

    return respond(200, quiz);
  } catch (error) {
    console.error("Error inesperado generando el cuestionario:", error);
    return respond(500, { error: "Error interno al generar el cuestionario." });
  }
};

// ---------------------------------------------------------------------------
// Parseo y validación estricta de lo que devuelve el modelo.
// Este modelo no garantiza JSON puro (puede venir con ```json o con texto de
// razonamiento), así que extraemos el primer objeto {...} antes de parsear.
// Devuelve null si no hay EXACTAMENTE 5 preguntas válidas.
// ---------------------------------------------------------------------------
function parseQuiz(raw) {
  const cleaned = String(raw).replace(/<think>[\s\S]*?<\/think>/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let parsed;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }

  if (!parsed || !Array.isArray(parsed.questions)) return null;

  const questions = parsed.questions
    .map((q) => {
      if (!q || typeof q.question !== "string" || !q.question.trim()) return null;
      if (!Array.isArray(q.options) || q.options.length !== OPTION_COUNT) return null;
      if (!q.options.every((o) => typeof o === "string" && o.trim())) return null;

      const correctIndex = Number(q.correctIndex);
      if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= OPTION_COUNT) {
        return null;
      }

      return {
        question: q.question.trim(),
        options: q.options.map((o) => o.trim()),
        correctIndex,
        explanation: typeof q.explanation === "string" ? q.explanation.trim() : "",
      };
    })
    .filter(Boolean);

  if (questions.length !== QUESTION_COUNT) return null;

  return {
    title: typeof parsed.title === "string" ? parsed.title.trim() : "",
    questions,
  };
}

function respond(statusCode, bodyObj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj),
  };
}
