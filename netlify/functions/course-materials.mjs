import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { getStore } from "@netlify/blobs";
import { eq, desc, and } from "drizzle-orm";
import { getDb } from "../../db/index.ts";
import { courseMaterials as materials } from "../../db/schema.ts";
import { authenticate, requireCourseOwner, validateFile, MAX_FILE_SIZE, fail } from "../lib/materials-security.mjs";

export default async function handler(request) {
  const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
  try {
    const session = await authenticate(request);
    const url = new URL(request.url);
    const courseId = url.searchParams.get("courseId");
    const id = url.searchParams.get("id");
    if (!courseId || !/^[A-Za-z0-9_-]{1,128}$/.test(courseId)) throw fail(400, "Curso inválido.");
    const db = getDb();
    const scope = eq(materials.courseId, courseId);
    const list = () => db.select({
      id: materials.id, courseId: materials.courseId, teacherId: materials.teacherId,
      title: materials.title, fileUrl: materials.fileUrl, fileName: materials.fileName,
      contentType: materials.contentType, size: materials.size, createdAt: materials.createdAt,
    }).from(materials).where(scope).orderBy(desc(materials.createdAt), desc(materials.id));

    if (request.method === "GET" && !id) {
      if (url.searchParams.get("watch") !== "1") return Response.json(await list(), { headers });
      // Short-lived stream reconnects with a fresh Firebase token on the client.
      let stopped = false;
      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          let previous = "";
          const until = Date.now() + 24000;
          try {
            while (!stopped && !request.signal.aborted && Date.now() < until) {
              const snapshot = JSON.stringify(await list());
              if (stopped || request.signal.aborted) break;
              if (snapshot !== previous) {
                controller.enqueue(encoder.encode(snapshot + "\n"));
                previous = snapshot;
              }
              await delay(2000);
            }
            if (!stopped) controller.close();
          } catch {
            if (!stopped) controller.error(new Error("No se pudo sincronizar los materiales."));
          }
        },
        cancel() { stopped = true; },
      });
      return new Response(stream, { headers: { ...headers, "Content-Type": "application/x-ndjson" } });
    }

    const store = getStore({ name: "course-material-files", consistency: "strong" });
    if (request.method === "POST") {
      await requireCourseOwner(session, courseId);
      if (Number(request.headers.get("content-length")) > 4 * 1024 * 1024 + 65536) throw fail(413, "El archivo supera los 4 MB.");
      let form;
      try { form = await request.formData(); } catch { throw fail(400, "Formulario inválido."); }
      const title = String(form.get("title") || "").trim();
      const file = form.get("file");
      if (!title || title.length > 120) throw fail(400, "El título debe tener entre 1 y 120 caracteres.");
      if (!(file instanceof File)) throw fail(400, "Selecciona un archivo.");
      if (file.size < 1 || file.size > MAX_FILE_SIZE) throw fail(400, "Selecciona un archivo de hasta 4 MB.");
      const bytes = await file.arrayBuffer();
      validateFile(file, bytes);
      const materialId = randomUUID();
      const blobKey = `${courseId}/${materialId}`;
      const fileUrl = `/.netlify/functions/course-materials?courseId=${encodeURIComponent(courseId)}&id=${materialId}`;
      await store.set(blobKey, bytes);
      try {
        await db.insert(materials).values({
          id: materialId, courseId, teacherId: session.uid, title, fileUrl,
          fileName: file.name.slice(0, 200), contentType: file.type, size: file.size, blobKey,
        });
      } catch (error) {
        await store.delete(blobKey).catch(() => {});
        throw error;
      }
      return Response.json({ id: materialId }, { status: 201, headers });
    }

    if (!id || !/^[a-f0-9-]{36}$/.test(id)) throw fail(400, "Material inválido.");
    const filter = and(scope, eq(materials.id, id));
    const [material] = await db.select().from(materials).where(filter);
    if (!material) throw fail(404, "Este material ya no está disponible.");
    if (request.method === "GET") {
      const bytes = await store.get(material.blobKey, { type: "arrayBuffer" });
      if (!bytes) throw fail(404, "El archivo ya no está disponible.");
      const disposition = url.searchParams.get("download") === "1" ? "attachment" : "inline";
      return new Response(bytes, { headers: {
        ...headers, "Content-Type": material.contentType,
        "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(material.fileName)}`,
        "Content-Security-Policy": "sandbox; default-src 'none'",
      } });
    }
    if (request.method === "DELETE") {
      await requireCourseOwner(session, courseId);
      // Keep the row on storage errors so the teacher can retry deletion.
      await store.delete(material.blobKey);
      await db.delete(materials).where(filter);
      return new Response(null, { status: 204, headers });
    }
    return Response.json({ error: "Método no permitido." }, { status: 405, headers: { ...headers, Allow: "GET, POST, DELETE" } });
  } catch (error) {
    return Response.json({ error: error.status ? error.message : "No se pudo completar la operación. Intenta de nuevo." }, {
      status: error.status || 500, headers,
    });
  }
}
