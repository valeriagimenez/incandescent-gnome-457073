// netlify/functions/groq-summary.js
// ---------------------------------------------------------------------------
// Proxy serverless para el Módulo 5 — Generador de Resúmenes.
//
// Pide al modelo una respuesta en JSON estricto (resumen + puntos clave +
// términos importantes) para poder renderizarla de forma estructurada en
// el frontend, sin depender de parsear markdown libre.
//
// Contrato:
//   POST /.netlify/functions/groq-summary
//   body: { uid: string, text: string }
//   -> 200 { result: { summary, keyPoints[], terms[{term,definition}] } | null, raw: string }
//   -> 4xx/5xx { error: string }
// ---------------------------------------------------------------------------

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// NOTA: llama-3.3-70b-versatile fue anunciado como deprecado por Groq
// (shutdown 16/08/2026 — ver https://console.groq.com/docs/deprecations).
// openai/gpt-oss-120b es el reemplazo recomendado para cargas de texto.
const MODEL = "openai/gpt-oss-120b";

const MAX_INPUT_CHARS = 12000;

const SYSTEM_PROMPT = `Eres un asistente educativo que resume contenido de estudio de forma clara \
y estructurada. Responde ÚNICAMENTE con un objeto JSON válido (sin texto antes o después, sin \
bloques de código markdown), con exactamente esta forma:

{
  "summary": "un resumen de 2 a 4 frases en español",
  "keyPoints": ["punto clave 1", "punto clave 2", "..."],
  "terms": [{"term": "término importante", "definition": "definición breve en una frase"}]
}

Reglas:
- "keyPoints" debe tener entre 3 y 8 elementos, cada uno una idea concreta (no frases genéricas).
- "terms" debe tener entre 0 y 6 elementos: solo términos técnicos o específicos del texto que \
valga la pena destacar. Si no hay términos relevantes, usa un arreglo vacío.
- Todo el contenido debe estar en español, sin importar el idioma del texto original.
- No inventes información que no esté en el texto proporcionado.`;

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

  const text = (payload.text || "").trim();
  if (!text) {
    return respond(400, { error: "Se requiere `text` con el contenido a resumir." });
  }
  if (text.length < 40) {
    return respond(400, { error: "El texto es muy corto para generar un resumen útil." });
  }

  const truncated = text.slice(0, MAX_INPUT_CHARS);

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
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: truncated },
        ],
        temperature: 0.3,
        max_tokens: 900,
        response_format: { type: "json_object" },
      }),
    });

    if (!groqResponse.ok) {
      const errText = await groqResponse.text();
      console.error("Error de Groq API (summary):", groqResponse.status, errText);
      return respond(502, { error: "No se pudo generar el resumen en este momento." });
    }

    const data = await groqResponse.json();
    const raw = data.choices?.[0]?.message?.content || "";

    let result = null;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.summary === "string" && Array.isArray(parsed.keyPoints)) {
        result = {
          summary: parsed.summary,
          keyPoints: parsed.keyPoints.filter((p) => typeof p === "string"),
          terms: Array.isArray(parsed.terms)
            ? parsed.terms.filter((t) => t && typeof t.term === "string")
            : [],
        };
      }
    } catch {
      // El modelo no devolvió JSON válido; el frontend usará `raw` como respaldo.
      result = null;
    }

    return respond(200, { result, raw });
  } catch (error) {
    console.error("Error inesperado llamando a Groq (summary):", error);
    return respond(500, { error: "Error interno al generar el resumen." });
  }
};

function respond(statusCode, bodyObj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj),
  };
}
