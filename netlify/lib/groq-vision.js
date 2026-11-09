// netlify/lib/groq-vision.js
// ---------------------------------------------------------------------------
// Helper compartido por groq-vision.js y groq-quiz.js (Escáner de Tareas).
//
// Groq renombra/retira sus modelos de visión con frecuencia (p. ej.
// llama-3.2-11b-vision-preview → qwen/qwen3.6-27b → qwen/qwen3.8-27b), y
// cada vez que pasa el escáner deja de funcionar. Para que no vuelva a
// romperse:
//   1. Se usa GROQ_VISION_MODEL si está definida; si no, DEFAULT_MODEL.
//   2. Si Groq responde que el modelo no existe, se consulta la lista de
//      modelos disponibles para esta API key, se elige uno de visión y se
//      reintenta una vez. El modelo descubierto se recuerda mientras la
//      función siga "caliente".
// ---------------------------------------------------------------------------

const GROQ_BASE = "https://api.groq.com/openai/v1";
const DEFAULT_MODEL = "qwen/qwen3.8-27b";

// Prefijos de familias de modelos multimodales conocidas en Groq, en orden
// de preferencia.
const VISION_HINTS = ["qwen/qwen3", "meta-llama/llama-4", "llama-4", "vision"];

let resolvedModel = process.env.GROQ_VISION_MODEL || DEFAULT_MODEL;

async function callGroqVision(apiKey, { prompt, imageBase64, temperature, maxTokens }) {
  let res = await requestCompletion(apiKey, resolvedModel, prompt, imageBase64, temperature, maxTokens);

  if (!res.ok && (res.status === 404 || res.status === 400)) {
    const errText = await res.clone().text();
    if (/model/i.test(errText) && /(not.?found|not exist|decommission|deprecat)/i.test(errText)) {
      const fallback = await discoverVisionModel(apiKey, resolvedModel);
      if (fallback) {
        console.warn(`Modelo de visión "${resolvedModel}" no disponible; usando "${fallback}".`);
        resolvedModel = fallback;
        res = await requestCompletion(apiKey, resolvedModel, prompt, imageBase64, temperature, maxTokens);
      }
    }
  }

  return res;
}

function requestCompletion(apiKey, model, prompt, imageBase64, temperature, maxTokens) {
  return fetch(`${GROQ_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageBase64 } },
          ],
        },
      ],
      temperature,
      max_tokens: maxTokens,
    }),
  });
}

async function discoverVisionModel(apiKey, current) {
  try {
    const res = await fetch(`${GROQ_BASE}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const ids = (data.data || []).map((m) => m.id).filter((id) => id && id !== current);
    for (const hint of VISION_HINTS) {
      const match = ids.filter((id) => id.includes(hint)).sort().reverse()[0];
      if (match) return match;
    }
  } catch (error) {
    console.error("No se pudo consultar la lista de modelos de Groq:", error);
  }
  return null;
}

// Traduce errores de Groq a mensajes útiles para el estudiante.
function groqErrorMessage(status, fallback) {
  if (status === 401) return "La clave de Groq (GROQ_API_KEY) es inválida o fue revocada.";
  if (status === 429) return "Se alcanzó el límite de uso de Groq. Intenta de nuevo en unos segundos.";
  if (status === 413) return "La imagen es demasiado grande. Intenta con una foto más comprimida.";
  return fallback;
}

module.exports = { callGroqVision, groqErrorMessage };
