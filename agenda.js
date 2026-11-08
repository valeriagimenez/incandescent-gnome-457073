// agenda.js
// ---------------------------------------------------------------------------
// Módulo 6 — Recordatorio de Tareas y Exámenes.
//
// CRUD completo sobre Firestore: agenda/{uid}/items/{itemId}. Funciona por
// completo sin backend (a diferencia de las notificaciones push, que sí
// necesitan el Netlify Scheduled Function de push.js/send-reminders.js).
//
// La lista se mantiene sincronizada en tiempo real con onSnapshot: si se
// crea/edita/borra un recordatorio (desde esta pestaña u otro dispositivo),
// la UI se actualiza sola.
// ---------------------------------------------------------------------------

import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  onSnapshot,
  Timestamp,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---------------------------------------------------------------------------
// Referencias al DOM
// ---------------------------------------------------------------------------
const loadingEl = document.getElementById("agenda-loading");
const emptyEl = document.getElementById("agenda-empty");
const listEl = document.getElementById("agenda-list");
const newBtn = document.getElementById("agenda-new-btn");

const modal = document.getElementById("agenda-modal");
const modalTitle = document.getElementById("agenda-modal-title");
const form = document.getElementById("agenda-form");
const itemIdInput = document.getElementById("agenda-item-id");
const titleInput = document.getElementById("agenda-title-input");
const typeInput = document.getElementById("agenda-type-input");
const courseInput = document.getElementById("agenda-course-input");
const dateInput = document.getElementById("agenda-date-input");
const timeInput = document.getElementById("agenda-time-input");
const notesInput = document.getElementById("agenda-notes-input");
const formError = document.getElementById("agenda-form-error");
const submitBtn = document.getElementById("agenda-submit-btn");
const deleteBtn = document.getElementById("agenda-delete-btn");

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
let currentUser = null;
let currentUserProfile = null;
let unsubscribeItems = null;
let cachedCourses = []; // [{id, name}] para el <select> del modal

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function clearElement(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function formatDueLabel(dueDate) {
  const now = new Date();
  const isSameDay = dueDate.toDateString() === now.toDateString();
  const isPast = dueDate.getTime() < now.getTime();

  const time = dueDate.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
  const dayLabel = isSameDay
    ? "Hoy"
    : dueDate.toLocaleDateString("es", { day: "numeric", month: "short" });

  return { text: `${dayLabel} · ${time}`, isPast, isSameDay };
}

async function loadCoursesForSelect() {
  if (!currentUser) return;
  clearElement(courseInput);
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "Sin curso";
  courseInput.appendChild(noneOpt);

  try {
    const role = currentUserProfile?.role;
    if (role === "docente") {
      const q = query(collection(db, "courses"), where("teacherId", "==", currentUser.uid));
      const snapshot = await getDocs(q);
      cachedCourses = snapshot.docs.map((d) => ({ id: d.id, name: d.data().name }));
    } else {
      const q = query(collection(db, "enrollments"), where("uid", "==", currentUser.uid));
      const snapshot = await getDocs(q);
      cachedCourses = snapshot.docs.map((d) => ({ id: d.data().courseId, name: d.data().courseName }));
    }
    cachedCourses.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.name;
      courseInput.appendChild(opt);
    });
  } catch (error) {
    console.error("No se pudieron cargar los cursos para el selector:", error);
  }
}

// ---------------------------------------------------------------------------
// Render de la lista
// ---------------------------------------------------------------------------
function renderItem(item) {
  const dueDate = item.dueAt?.toDate ? item.dueAt.toDate() : new Date(item.dueAt);
  const { text, isPast, isSameDay } = formatDueLabel(dueDate);

  const li = document.createElement("li");
  li.className = [
    "flex items-start gap-3 rounded-xl border px-4 py-3 transition",
    item.completed
      ? "border-ink/10 bg-paper-100 opacity-50"
      : isPast
      ? "border-coral/30 bg-coral/5"
      : isSameDay
      ? "border-marigold/40 bg-marigold/5"
      : "border-ink/10 bg-paper-100",
  ].join(" ");

  const checkbox = document.createElement("button");
  checkbox.type = "button";
  checkbox.className = [
    "mt-0.5 h-5 w-5 shrink-0 rounded-full border-2 flex items-center justify-center text-[10px] transition",
    item.completed ? "bg-teal border-teal text-void" : "border-ink/25 text-transparent hover:border-teal",
  ].join(" ");
  checkbox.textContent = "✓";
  checkbox.title = item.completed ? "Marcar como pendiente" : "Marcar como completado";
  checkbox.addEventListener("click", () => toggleComplete(item.id, !item.completed));

  const body = document.createElement("button");
  body.type = "button";
  body.className = "flex-1 text-left";
  body.addEventListener("click", () => openEditModal(item));

  const titleRow = document.createElement("p");
  titleRow.className = `text-sm font-medium ${item.completed ? "line-through text-ink/40" : "text-ink"}`;
  titleRow.textContent = `${item.type === "examen" ? "📝" : "📘"} ${item.title}`;

  const metaRow = document.createElement("p");
  metaRow.className = `text-[11px] mt-0.5 font-mono ${
    isPast && !item.completed ? "text-coral" : "text-ink/40"
  }`;
  metaRow.textContent = [text, item.courseName].filter(Boolean).join(" · ");

  body.appendChild(titleRow);
  body.appendChild(metaRow);

  li.appendChild(checkbox);
  li.appendChild(body);
  return li;
}

function renderList(items) {
  loadingEl.classList.add("hidden");
  clearElement(listEl);

  if (items.length === 0) {
    emptyEl.classList.remove("hidden");
    emptyEl.classList.add("flex");
    listEl.classList.add("hidden");
    return;
  }

  emptyEl.classList.add("hidden");
  emptyEl.classList.remove("flex");
  listEl.classList.remove("hidden");
  items.forEach((item) => listEl.appendChild(renderItem(item)));
}

// ---------------------------------------------------------------------------
// Suscripción en tiempo real
// ---------------------------------------------------------------------------
function subscribeToItems() {
  if (!currentUser) return;
  unsubscribeItems?.();

  loadingEl.classList.remove("hidden");
  const itemsRef = collection(db, "agenda", currentUser.uid, "items");
  const q = query(itemsRef, orderBy("dueAt", "asc"));

  unsubscribeItems = onSnapshot(
    q,
    (snapshot) => {
      const items = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderList(items);
    },
    (error) => {
      console.error("Error al escuchar la agenda:", error);
      loadingEl.textContent = "No se pudo cargar la agenda.";
    }
  );
}

async function toggleComplete(itemId, completed) {
  if (!currentUser) return;
  try {
    await updateDoc(doc(db, "agenda", currentUser.uid, "items", itemId), { completed });
  } catch (error) {
    console.error("No se pudo actualizar el recordatorio:", error);
  }
}

// ---------------------------------------------------------------------------
// Modal: crear / editar
// ---------------------------------------------------------------------------
function resetForm() {
  form.reset();
  itemIdInput.value = "";
  timeInput.value = "08:00";
  formError.classList.add("hidden");
  deleteBtn.classList.add("hidden");
}

async function openCreateModal() {
  resetForm();
  modalTitle.textContent = "Nuevo recordatorio";
  await loadCoursesForSelect();

  const today = new Date();
  dateInput.value = today.toISOString().slice(0, 10);

  modal.classList.remove("hidden");
  titleInput.focus();
}

async function openEditModal(item) {
  resetForm();
  modalTitle.textContent = "Editar recordatorio";
  await loadCoursesForSelect();

  itemIdInput.value = item.id;
  titleInput.value = item.title;
  typeInput.value = item.type || "tarea";
  courseInput.value = item.courseId || "";
  notesInput.value = item.notes || "";

  const dueDate = item.dueAt?.toDate ? item.dueAt.toDate() : new Date(item.dueAt);
  dateInput.value = dueDate.toISOString().slice(0, 10);
  timeInput.value = dueDate.toTimeString().slice(0, 5);

  deleteBtn.classList.remove("hidden");
  modal.classList.remove("hidden");
}

newBtn?.addEventListener("click", openCreateModal);

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  formError.classList.add("hidden");

  const title = titleInput.value.trim();
  if (!title) return;

  const dueAtDate = new Date(`${dateInput.value}T${timeInput.value}:00`);
  if (Number.isNaN(dueAtDate.getTime())) {
    formError.textContent = "Fecha u hora inválida.";
    formError.classList.remove("hidden");
    return;
  }

  const selectedCourse = cachedCourses.find((c) => c.id === courseInput.value);

  const payload = {
    title,
    type: typeInput.value,
    courseId: courseInput.value || null,
    courseName: selectedCourse?.name || null,
    notes: notesInput.value.trim(),
    dueAt: Timestamp.fromDate(dueAtDate),
  };

  submitBtn.disabled = true;
  submitBtn.textContent = "Guardando…";

  try {
    const existingId = itemIdInput.value;
    if (existingId) {
      await updateDoc(doc(db, "agenda", currentUser.uid, "items", existingId), payload);
    } else {
      await addDoc(collection(db, "agenda", currentUser.uid, "items"), {
        ...payload,
        completed: false,
        notifiedAt: null,
        createdAt: serverTimestamp(),
      });
    }
    modal.classList.add("hidden");
  } catch (error) {
    console.error("No se pudo guardar el recordatorio:", error);
    formError.textContent = "No se pudo guardar. Intenta de nuevo.";
    formError.classList.remove("hidden");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Guardar";
  }
});

deleteBtn?.addEventListener("click", async () => {
  const existingId = itemIdInput.value;
  if (!existingId || !currentUser) return;

  deleteBtn.disabled = true;
  try {
    await deleteDoc(doc(db, "agenda", currentUser.uid, "items", existingId));
    modal.classList.add("hidden");
  } catch (error) {
    console.error("No se pudo eliminar el recordatorio:", error);
    formError.textContent = "No se pudo eliminar. Intenta de nuevo.";
    formError.classList.remove("hidden");
  } finally {
    deleteBtn.disabled = false;
  }
});

// Cierre del modal (botón "×" y click fuera) — reutiliza la convención
// .modal-close-btn / data-modal usada en courses.js.
document.querySelectorAll('.modal-close-btn[data-modal="agenda-modal"]').forEach((btn) => {
  btn.addEventListener("click", () => modal.classList.add("hidden"));
});
modal?.addEventListener("click", (event) => {
  if (event.target === modal) modal.classList.add("hidden");
});

// ---------------------------------------------------------------------------
// Inicialización ligada a la sesión de Firebase Auth
// ---------------------------------------------------------------------------
async function ensureProfile() {
  if (currentUserProfile || !currentUser) return;
  try {
    const snap = await getDoc(doc(db, "users", currentUser.uid));
    currentUserProfile = snap.exists() ? snap.data() : null;
  } catch (error) {
    console.error("No se pudo cargar el perfil del usuario:", error);
  }
}

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  currentUserProfile = null;
  unsubscribeItems?.();

  if (user) {
    await ensureProfile();
    subscribeToItems();
  }
});
