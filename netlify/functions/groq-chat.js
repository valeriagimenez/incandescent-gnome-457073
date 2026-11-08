// netlify/functions/groq-chat.js
// ---------------------------------------------------------------------------
// Proxy serverless entre el frontend y Groq API para el Tutor IA (Módulo 3).
//
// Por qué existe esta función:
//   - La API key de Groq NUNCA debe viajar al navegador. Esta función corre
//     en el servidor de Netlify, lee la key desde una variable de entorno
//     (GROQ_API_KEY, configurada en Netlify → Site settings → Environment
//     variables) y es la única que habla directamente con Groq.
//
// Contrato:
//   POST /.netlify/functions/groq-chat
//   body: { uid: string, messages: [{ role: "user"|"assistant", content }] }
//   -> 200 { reply: string }
//   -> 4xx/5xx { error: string }
// ---------------------------------------------------------------------------

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// NOTA: llama-3.3-70b-versatile fue anunciado como deprecado por Groq
// (shutdown 16/08/2026 — ver https://console.groq.com/docs/deprecations).
// openai/gpt-oss-120b es el reemplazo recomendado para cargas de texto.
const MODEL = "openai/gpt-oss-120b";

const SYSTEM_PROMPT = `Eres un tutor educativo socrático. Tu objetivo es que el estudiante \
llegue a la respuesta por sí mismo, no dársela directamente.

Reglas:
- Nunca entregues la solución final de inmediato, ni siquiera si el estudiante insiste.
- Responde con preguntas guía, pistas progresivas y pequeños pasos que el estudiante \
pueda seguir para razonar el problema.
- Si el estudiante está genuinamente atascado después de varios intentos, ofrece una \
pista más directa (pero sigue sin dar la respuesta completa) y explícale el concepto \
que le falta.
- Adapta el nivel de lenguaje a un estudiante de educación básica o media, salvo que \
el contenido de la conversación indique claramente un nivel más avanzado.
- Sé breve y claro: prioriza 2-4 frases o una lista corta sobre párrafos largos.
- Si la pregunta no es de índole académica, responde con amabilidad pero redirige \
la conversación hacia el aprendizaje.
- Responde siempre en español.`;

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

  const { messages } = payload;

  if (!Array.isArray(messages) || messages.length === 0) {
    return respond(400, { error: "Se requiere un arreglo `messages` no vacío." });
  }

  // Saneamos: solo permitimos role/content de tipo esperado, y limitamos
  // el historial enviado al modelo para controlar costo/latencia.
  const MAX_HISTORY = 20;
  const sanitized = messages
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0
    )
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

  if (sanitized.length === 0) {
    return respond(400, { error: "No hay mensajes válidos para procesar." });
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
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...sanitized],
        temperature: 0.6,
        max_tokens: 700,
      }),
    });

    if (!groqResponse.ok) {
      const errText = await groqResponse.text();
      console.error("Error de Groq API:", groqResponse.status, errText);
      return respond(502, { error: "El tutor de IA no pudo responder en este momento." });
    }

    const data = await groqResponse.json();
    const reply = data.choices?.[0]?.message?.content;

    if (!reply) {
      return respond(502, { error: "Respuesta vacía del modelo de IA." });
    }

    return respond(200, { reply });
  } catch (error) {
    console.error("Error inesperado llamando a Groq:", error);
    return respond(500, { error: "Error interno al contactar al tutor de IA." });
  }
};

function respond(statusCode, bodyObj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj),
  };
}
