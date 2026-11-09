import { auth } from "./firebase-config.js";

const form = document.getElementById("materials-form");
const list = document.getElementById("materials-list");
const status = document.getElementById("materials-status");
const errorEl = document.getElementById("materials-error");
const count = document.getElementById("materials-count");
let active = null;

function showError(message, state) {
  if (active !== state) return;
  errorEl.textContent = message;
  errorEl.classList.toggle("hidden", !message);
}

function endpoint(courseId, extra = {}) {
  return `/.netlify/functions/course-materials?${new URLSearchParams({ courseId, ...extra })}`;
}

async function request(state, extra = {}, options = {}) {
  if (state.controller.signal.aborted || auth.currentUser?.uid !== state.uid) throw new DOMException("Aborted", "AbortError");
  const token = await auth.currentUser.getIdToken();
  const response = await fetch(endpoint(state.course.id, extra), {
    ...options, signal: state.controller.signal,
    headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "No se pudo completar la operación.");
  }
  return response;
}

async function openFile(material, download, state, button) {
  // Reserve a tab during the user gesture to avoid popup blocking after fetch.
  const tab = download ? null : window.open("about:blank", "_blank");
  if (tab) tab.opener = null;
  button.disabled = true;
  try {
    const response = await request(state, { id: material.id, ...(download ? { download: "1" } : {}) });
    const blob = await response.blob();
    if (active !== state) { tab?.close(); return; }
    const url = URL.createObjectURL(blob);
    state.urls.add(url);
    if (download || !tab) {
      const link = document.createElement("a");
      link.href = url;
      link.download = material.fileName;
      link.click();
    } else tab.location.replace(url);
    setTimeout(() => { URL.revokeObjectURL(url); state.urls.delete(url); }, 60000);
    showError("", state);
  } catch (error) {
    tab?.close();
    if (error.name !== "AbortError") showError(error.message, state);
  } finally { button.disabled = false; }
}

function render(rows, state) {
  if (active !== state) return;
  list.replaceChildren();
  count.textContent = String(rows.length);
  status.textContent = rows.length ? "Actualizado en vivo" : "Todavía no hay materiales publicados.";
  for (const material of rows) {
    const item = document.createElement("li");
    item.className = "border border-ink/10 rounded-lg p-3 bg-paper-100";
    const title = document.createElement("p");
    title.className = "font-display text-sm font-semibold text-ink break-words";
    title.textContent = material.title;
    const meta = document.createElement("p");
    meta.className = "text-xs text-ink/50 mt-0.5 break-words";
    const date = new Date(material.createdAt).toLocaleDateString("es");
    meta.textContent = `${material.fileName} · ${(material.size / 1024 / 1024).toFixed(2)} MB · ${date}`;
    const actions = document.createElement("div");
    actions.className = "flex flex-wrap gap-3 mt-2";
    const button = (label, action) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "text-xs font-medium text-teal hover:text-teal-600 disabled:opacity-50";
      btn.textContent = label;
      btn.setAttribute("aria-label", `${label}: ${material.title}`);
      btn.addEventListener("click", () => action(btn));
      actions.append(btn);
    };
    button("Abrir", (btn) => openFile(material, false, state, btn));
    button("Descargar", (btn) => openFile(material, true, state, btn));
    if (state.owner) button("Eliminar", async (btn) => {
      if (!confirm(`¿Eliminar «${material.title}» y su archivo?`)) return;
      btn.disabled = true;
      try {
        await request(state, { id: material.id }, { method: "DELETE" });
        await refresh(state);
        showError("", state);
      } catch (error) {
        if (error.name !== "AbortError") showError(error.message, state);
      } finally { btn.disabled = false; }
    });
    item.append(title, meta, actions);
    list.append(item);
  }
}

async function refresh(state) {
  const response = await request(state);
  render(await response.json(), state);
}

async function watch(state) {
  while (active === state && !state.controller.signal.aborted) {
    try {
      const response = await request(state, { watch: "1" });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n")) !== -1) {
          render(JSON.parse(buffer.slice(0, end)), state);
          buffer = buffer.slice(end + 1);
        }
      }
    } catch (error) {
      if (state.controller.signal.aborted) return;
      if (active === state) status.textContent = "Sin conexión en vivo. Reintentando…";
      showError(error.message, state);
      await new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          state.controller.signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, 5000);
        state.controller.signal.addEventListener("abort", finish, { once: true });
      });
    }
  }
}

export function closeMaterials() {
  if (!active) return;
  active.controller.abort();
  active.urls.forEach((url) => URL.revokeObjectURL(url));
  active = null;
  list.replaceChildren();
  form.reset();
  form.classList.add("hidden");
}

export function openMaterials(course, profile) {
  closeMaterials();
  if (!auth.currentUser) return;
  active = {
    course, uid: auth.currentUser.uid,
    owner: profile?.role === "docente" && course.teacherId === auth.currentUser.uid,
    controller: new AbortController(), urls: new Set(),
  };
  form.classList.toggle("hidden", !active.owner);
  form.querySelectorAll("input, button").forEach((el) => { el.disabled = false; });
  form.querySelector("button").textContent = "Publicar material";
  status.textContent = "Cargando materiales…";
  count.textContent = "";
  showError("", active);
  watch(active);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const state = active;
  if (!state?.owner) return;
  const data = new FormData(form);
  const file = data.get("file");
  if (!file?.size || file.size > 4 * 1024 * 1024) {
    showError("Selecciona un archivo de hasta 4 MB.", state);
    return;
  }
  const controls = form.querySelectorAll("input, button");
  controls.forEach((el) => { el.disabled = true; });
  form.querySelector("button").textContent = "Publicando…";
  showError("", state);
  try {
    await request(state, {}, { method: "POST", body: data });
    if (active === state) { form.reset(); await refresh(state); }
  } catch (error) {
    if (error.name !== "AbortError") showError(error.message, state);
  } finally {
    if (active === state) {
      controls.forEach((el) => { el.disabled = false; });
      form.querySelector("button").textContent = "Publicar material";
    }
  }
});
