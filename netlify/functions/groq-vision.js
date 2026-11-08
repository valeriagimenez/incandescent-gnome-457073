// netlify/functions/groq-vision.js
// ---------------------------------------------------------------------------
// Proxy serverless para el Módulo 4 — Escáner de Tareas (Groq Vision).
//
// El frontend captura una foto con getUserMedia(), la convierte a Base64
// (data URL) y la envía aquí. Esta función reenvía la imagen al modelo
// llama-3.2-11b-vision-preview de Groq junto con el prompt de análisis y
// devuelve el texto resultante.
//
// Contrato:
//   POST /.netlify/functions/groq-vision
//   body: { uid: string, imageBase64: string /* data URL completa */ }
//   -> 200 { analysis: string }
//   -> 4xx/5xx { error: string }
// ---------------------------------------------------------------------------

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// NOTA: llama-3.2-11b-vision-preview fue descontinuado por Groq en abril de
// 2025 (ver https://console.groq.com/docs/deprecations). El modelo de
// visión vigente al momento de escribir esto es qwen/qwen3.6-27b.
// Si Groq vuelve a migrar su línea de modelos multimodales, revisa esa
// página antes de cambiar este valor.
const MODEL = "qwen/qwen3.6-27b";

const VISION_PROMPT =
  "¿Qué ves en esta imagen? Descríbelo de forma clara, directa y ordenada " +
  "(usa una lista si hay varios elementos). Si es una tarea, ejercicio o " +
  "pregunta escolar: identifica el tema en una línea y luego da la " +
  "respuesta o solución directamente, organizada por puntos — sin rodeos " +
  "ni preguntas de vuelta. Responde en español.";

// Límite conservador para evitar payloads gigantes desde el cliente
// (una foto de cámara ya comprimida en JPEG suele estar muy por debajo de esto).
const MAX_BASE64_LENGTH = 8_000_000; // ~8MB en texto Base64

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
    const groqResponse = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: VISION_PROMPT },
              { type: "image_url", image_url: { url: imageBase64 } },
            ],
          },
        ],
        temperature: 0.4,
        max_tokens: 1024,
      }),
    });

    if (!groqResponse.ok) {
      const errText = await groqResponse.text();
      console.error("Error de Groq Vision API:", groqResponse.status, errText);
      return respond(502, { error: "No se pudo analizar la imagen en este momento." });
    }

    const data = await groqResponse.json();
    const analysis = data.choices?.[0]?.message?.content;

    if (!analysis) {
      return respond(502, { error: "El análisis de la imagen volvió vacío." });
    }

    return respond(200, { analysis });
  } catch (error) {
    console.error("Error inesperado llamando a Groq Vision:", error);
    return respond(500, { error: "Error interno al analizar la imagen." });
  }
};

function respond(statusCode, bodyObj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj),
  };
}
