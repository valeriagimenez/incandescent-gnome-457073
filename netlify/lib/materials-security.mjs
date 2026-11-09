import { createRemoteJWKSet, jwtVerify } from "jose";
import { projectId } from "./firebase-project.mjs";

let keySet;
export function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

export async function authenticate(request, keys) {
  const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) throw fail(401, "Inicia sesión para acceder a los materiales.");
  try {
    keySet ??= createRemoteJWKSet(new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"));
    const { payload } = await jwtVerify(token, keys || keySet, {
      algorithms: ["RS256"], audience: projectId,
      issuer: `https://securetoken.google.com/${projectId}`,
      requiredClaims: ["exp", "iat", "sub"],
    });
    if (!payload.sub || payload.sub.length > 128) throw new Error();
    return { uid: payload.sub, token };
  } catch {
    throw fail(401, "Tu sesión ha caducado. Vuelve a iniciar sesión.");
  }
}

// Reads existing courses through the user's Firebase permissions. No Admin key needed.
export async function requireCourseOwner(session, courseId, fetcher = fetch) {
  const root = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const read = async (path) => {
    const response = await fetcher(`${root}/${path}`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    if (response.status === 404) throw fail(404, "No se encontró el curso o el perfil.");
    if (!response.ok) throw fail(response.status === 403 ? 403 : 503, "No se pudo verificar el permiso del docente.");
    return (await response.json()).fields;
  };
  const [course, profile] = await Promise.all([
    read(`courses/${encodeURIComponent(courseId)}`),
    read(`users/${encodeURIComponent(session.uid)}`),
  ]);
  if (course?.teacherId?.stringValue !== session.uid || profile?.role?.stringValue !== "docente") {
    throw fail(403, "Solo el docente dueño del curso puede modificar sus materiales.");
  }
}

export const MAX_FILE_SIZE = 4 * 1024 * 1024;
export function validateFile(file, bytes) {
  if (!file || file.size < 1 || file.size > MAX_FILE_SIZE) throw fail(400, "Selecciona un archivo de hasta 4 MB.");
  const b = new Uint8Array(bytes);
  const starts = (...values) => values.every((v, i) => b[i] === v);
  const valid = {
    "application/pdf": starts(37, 80, 68, 70, 45),
    "image/png": starts(137, 80, 78, 71, 13, 10, 26, 10),
    "image/jpeg": starts(255, 216, 255),
    "image/webp": starts(82, 73, 70, 70) && String.fromCharCode(...b.slice(8, 12)) === "WEBP",
  };
  if (!valid[file.type]) throw fail(400, "El archivo debe ser un PDF o una imagen PNG, JPG o WebP válida.");
}
