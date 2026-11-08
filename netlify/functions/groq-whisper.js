// netlify/functions/groq-whisper.js
// ---------------------------------------------------------------------------
// Proxy serverless para el Módulo 8 — Reconocimiento de Voz (Groq Whisper).
//
// El frontend graba audio con MediaRecorder, lo convierte a Base64 y lo
// envía aquí como JSON (evitar multipart/form-data desde el cliente nos
// simplifica mucho el manejo de CORS y de body-parsing en Netlify).
// Esta función decodifica el audio, arma el multipart/form-data que la API
// de Groq sí espera (usando FormData/Blob nativos de Node 18+) y reenvía.
//
// Contrato:
//   POST /.netlify/functions/groq-whisper
//   body: { uid: string, audioBase64: string /* data URL */, mimeType?: string }
//   -> 200 { transcript: string }
//   -> 4xx/5xx { error: string }
// ---------------------------------------------------------------------------

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const MODEL = "whisper-large-v3";

// Los payloads síncronos de Netlify Functions tienen un límite ~6MB; dejamos
// margen para el overhead de Base64 (~33% más grande que el binario).
const MAX_BASE64_LENGTH = 6_000_000;

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

  const { audioBase64 } = payload;

  if (typeof audioBase64 !== "string" || !audioBase64.startsWith("data:")) {
    return respond(400, {
      error: "Se requiere `audioBase64` como data URL (ej. data:audio/webm;base64,...).",
    });
  }

  if (audioBase64.length > MAX_BASE64_LENGTH) {
    return respond(413, { error: "El audio es demasiado largo. Intenta con una grabación más corta." });
  }

  try {
    const [meta, base64Data] = audioBase64.split(",");
    const mimeMatch = meta.match(/data:(.*);base64/);
    const mimeType = mimeMatch?.[1] || "audio/webm";
    const buffer = Buffer.from(base64Data, "base64");

    const extension = mimeType.includes("mp4") ? "mp4" : mimeType.includes("wav") ? "wav" : "webm";

    const form = new FormData();
    form.append("model", MODEL);
    form.append("language", "es");
    form.append("response_format", "json");
    form.append("file", new Blob([buffer], { type: mimeType }), `audio.${extension}`);

    const groqResponse = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` }, // NO seteamos Content-Type: fetch arma el boundary del multipart
      body: form,
    });

    if (!groqResponse.ok) {
      const errText = await groqResponse.text();
      console.error("Error de Groq Whisper API:", groqResponse.status, errText);
      return respond(502, { error: "No se pudo transcribir el audio en este momento." });
    }

    const data = await groqResponse.json();
    const transcript = data.text?.trim();

    if (!transcript) {
      return respond(502, { error: "La transcripción volvió vacía. Intenta hablar más cerca del micrófono." });
    }

    return respond(200, { transcript });
  } catch (error) {
    console.error("Error inesperado llamando a Groq Whisper:", error);
    return respond(500, { error: "Error interno al transcribir el audio." });
  }
};

function respond(statusCode, bodyObj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj),
  };
}
