// schedules-view.js
// ---------------------------------------------------------------------------
// Módulo 9 (UI) — Cronogramas de clase.
// Cualquier usuario logueado puede VER el cronograma del periodo actual;
// solo "dirección" ve el botón "+ Nueva clase" y las acciones de
// editar/eliminar. La lógica de datos vive en schedules.js — este archivo
// solo conecta esa lógica con el DOM (mismo patrón que courses.js).
// ---------------------------------------------------------------------------

import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  getDocs,
  query,
  where,
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  createScheduleSlot,
  updateScheduleSlot,
  deleteScheduleSlot,
  listScheduleByPeriod,
  validateScheduleSlot,
} from "./schedules.js";
import { showToast } from "./toast.js";
import { listAllSubjects, rememberSubject } from "./subjects.js";

const CURRENT_PERIOD = "2026"; // Único periodo activo por ahora; ver nota al final.

let currentUser = null;
let currentUserProfile = null;

async function ensureProfile() {
  if (currentUserProfile || !currentUser) return currentUserProfile;
  const snap = await getDoc(doc(db, "users", currentUser.uid));
  currentUserProfile = snap.exists() ? snap.data() : null;
  return currentUserProfile;
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const listEl = document.getElementById("schedules-list");
const loadingEl = document.getElementById("schedules-loading");
const emptyEl = document.getElementById("schedules-empty");
const newBtn = document.getElementById("schedules-new-btn");

const formModal = document.getElementById("schedule-form-modal");
const form = document.getElementById("schedule-form");
const formTitle = document.getElementById("schedule-form-title");
const formCloseBtn = document.getElementById("schedule-form-close-btn");
const formError = document.getElementById("schedule-form-error");
const deleteBtn = document.getElementById("schedule-delete-btn");
const submitBtn = document.getElementById("schedule-submit-btn");
const courseSelect = document.getElementById("schedule-course");

const idInput = document.getElementById("schedule-id");
const sectionInput = document.getElementById("schedule-section");
const classroomInput = document.getElementById("schedule-classroom");
const subjectInput = document.getElementById("schedule-subject");
const subjectNewWrap = document.getElementById("schedule-subject-new-wrap");
const subjectNewInput = document.getElementById("schedule-subject-new");
const subjectCancelBtn = document.getElementById("schedule-subject-cancel-btn");
const teacherInput = document.getElementById("schedule-teacher");
const dayInput = document.getElementById("schedule-day");
const startInput = document.getElementById("schedule-start");
const endInput = document.getElementById("schedule-end");
const periodInput = document.getElementById("schedule-period");

let coursesCache = []; // [{ id, name }]
let teachersCache = []; // [{ uid, name }]

async function loadSubjectsIntoSelect() {
  const subjects = await listAllSubjects();
  renderSubjectOptions(subjects);
  return subjects;
}

function renderSubjectOptions(subjects) {
  const options = subjects
    .map((s) => `<option value="${s}">${s}</option>`)
    .join("");
  subjectInput.innerHTML = `<option value="">Materia…</option>${options}<option value="__new__">+ Nueva materia…</option>`;
}

// Alterna entre el <select> de materias y el input de texto para crear una
// nueva, sin perder lo que el usuario ya eligió si cancela.
subjectInput.addEventListener("change", () => {
  if (subjectInput.value === "__new__") {
    subjectNewWrap.classList.remove("hidden");
    subjectNewInput.value = "";
    subjectNewInput.focus();
  } else {
    subjectNewWrap.classList.add("hidden");
  }
});
subjectCancelBtn.addEventListener("click", () => {
  subjectNewWrap.classList.add("hidden");
  subjectInput.value = "";
});

function showFormError(message) {
  formError.textContent = message;
  formError.classList.remove("hidden");
}

async function loadCoursesIntoSelect() {
  if (coursesCache.length) return coursesCache;
  const snap = await getDocs(collection(db, "courses"));
  coursesCache = snap.docs.map((d) => ({ id: d.id, name: d.data().name || "(sin nombre)" }));
  courseSelect.innerHTML = coursesCache
    .map((c) => `<option value="${c.id}">${c.name}</option>`)
    .join("");
  return coursesCache;
}

async function loadTeachersIntoSelect() {
  if (teachersCache.length) return teachersCache;
  const q = query(collection(db, "users"), where("role", "==", "docente"));
  const snap = await getDocs(q);
  teachersCache = snap.docs.map((d) => ({ uid: d.id, name: d.data().displayName || d.data().email }));
  teacherInput.innerHTML = teachersCache
    .map((t) => `<option value="${t.uid}">${t.name}</option>`)
    .join("");
  return teachersCache;
}

function resetForm() {
  form.reset();
  idInput.value = "";
  periodInput.value = CURRENT_PERIOD;
  deleteBtn.classList.add("hidden");
  subjectNewWrap.classList.add("hidden");
  clearConflictState();
}

// ---------------------------------------------------------------------------
// Validación de conflictos (docente / aula) — se corre en vivo mientras se
// completa el formulario y otra vez, por las dudas, justo antes de guardar.
// ---------------------------------------------------------------------------
const CONFLICT_FIELDS = [teacherInput, dayInput, startInput, endInput, classroomInput];
let conflictCheckToken = 0; // evita que una respuesta vieja pise a una más nueva

function clearConflictState() {
  formError.classList.add("hidden");
  formError.textContent = "";
  CONFLICT_FIELDS.forEach((el) => el.classList.remove("field-error"));
  submitBtn.disabled = false;
}

function markConflictFields({ teacherConflict, classroomConflict }) {
  CONFLICT_FIELDS.forEach((el) => el.classList.remove("field-error"));
  if (teacherConflict) {
    teacherInput.classList.add("field-error");
    dayInput.classList.add("field-error");
    startInput.classList.add("field-error");
    endInput.classList.add("field-error");
  }
  if (classroomConflict) {
    classroomInput.classList.add("field-error");
    dayInput.classList.add("field-error");
    startInput.classList.add("field-error");
    endInput.classList.add("field-error");
  }
}

function currentFormData() {
  const selectedTeacher = teachersCache.find((t) => t.uid === teacherInput.value);
  return {
    teacherId: teacherInput.value,
    teacherName: selectedTeacher?.name || "",
    classroom: classroomInput.value.trim(),
    day: dayInput.value,
    startTime: startInput.value,
    endTime: endInput.value,
    period: periodInput.value.trim() || CURRENT_PERIOD,
    excludeId: idInput.value || undefined,
  };
}

// Corre la validación y actualiza toda la UI (borde rojo, banner, botón
// Guardar). Devuelve `true` si hay conflicto (para que el submit lo use).
async function runConflictCheck({ announce = false } = {}) {
  const data = currentFormData();
  const { day, startTime, endTime } = data;

  // Sin día u horario todavía no hay nada que validar.
  if (!day || !startTime || !endTime || endTime <= startTime) {
    clearConflictState();
    return false;
  }

  const token = ++conflictCheckToken;
  let result;
  try {
    result = await validateScheduleSlot(data);
  } catch (error) {
    console.error("No se pudo validar el horario:", error);
    return false; // no bloqueamos el guardado por un error de red en la validación
  }
  if (token !== conflictCheckToken) return false; // llegó una respuesta más nueva, descartar esta

  if (result.hasConflict) {
    markConflictFields(result);
    formError.textContent = result.message;
    formError.classList.remove("hidden");
    submitBtn.disabled = true;
    if (announce) {
      showToast(result.message, { type: "error" });
    }
    return true;
  }

  clearConflictState();
  return false;
}

let conflictDebounceTimer = null;
function scheduleConflictCheck() {
  clearTimeout(conflictDebounceTimer);
  conflictDebounceTimer = setTimeout(() => runConflictCheck({ announce: false }), 350);
}
CONFLICT_FIELDS.forEach((el) => el.addEventListener("change", scheduleConflictCheck));
CONFLICT_FIELDS.forEach((el) => el.addEventListener("input", scheduleConflictCheck));

function openCreateModal() {
  resetForm();
  formTitle.textContent = "Nueva clase";
  loadCoursesIntoSelect();
  loadTeachersIntoSelect();
  loadSubjectsIntoSelect();
  formModal.classList.remove("hidden");
}

function openEditModal(slot) {
  resetForm();
  formTitle.textContent = "Editar clase";
  loadCoursesIntoSelect().then(() => {
    courseSelect.value = slot.courseId;
  });
  loadTeachersIntoSelect().then(() => {
    teacherInput.value = slot.teacherId;
  });
  loadSubjectsIntoSelect().then((subjects) => {
    // Si la materia de esta franja no está todavía en la lista (ej. quedó
    // guardada antes de este cambio, o la borraron de otras franjas), la
    // agregamos igual para no perderla ni forzar a recrearla.
    if (slot.subject && !subjects.includes(slot.subject)) {
      renderSubjectOptions([...subjects, slot.subject].sort((a, b) => a.localeCompare(b, "es")));
    }
    subjectInput.value = slot.subject || "";
    subjectNewWrap.classList.add("hidden");
  });
  idInput.value = slot.id;
  sectionInput.value = slot.section;
  classroomInput.value = slot.classroom;
  subjectInput.value = slot.subject;
  dayInput.value = slot.day;
  startInput.value = slot.startTime;
  endInput.value = slot.endTime;
  periodInput.value = slot.period;
  form.querySelector(`input[name="schedule-type"][value="${slot.type}"]`).checked = true;
  deleteBtn.classList.remove("hidden");
  deleteBtn.dataset.id = slot.id;
  formModal.classList.remove("hidden");
}

function closeModal() {
  formModal.classList.add("hidden");
  conflictCheckToken++; // descarta cualquier validación en vuelo del modal que se cierra
}

newBtn?.addEventListener("click", openCreateModal);
formCloseBtn?.addEventListener("click", closeModal);
formModal?.addEventListener("click", (e) => {
  if (e.target === formModal) closeModal();
});

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  formError.classList.add("hidden");

  const selectedCourse = coursesCache.find((c) => c.id === courseSelect.value);
  const selectedTeacher = teachersCache.find((t) => t.uid === teacherInput.value);

  const subject =
    subjectInput.value === "__new__"
      ? subjectNewInput.value.trim()
      : subjectInput.value.trim();

  if (!subject) {
    showFormError(
      subjectInput.value === "__new__"
        ? "Escribe el nombre de la nueva materia."
        : "Selecciona una materia."
    );
    return;
  }

  const data = {
    courseId: courseSelect.value,
    courseName: selectedCourse?.name || "",
    section: sectionInput.value.trim(),
    classroom: classroomInput.value.trim(),
    subject,
    teacherId: teacherInput.value,
    teacherName: selectedTeacher?.name || "",
    day: dayInput.value,
    startTime: startInput.value,
    endTime: endInput.value,
    type: form.querySelector('input[name="schedule-type"]:checked').value,
    period: periodInput.value.trim(),
  };

  if (data.endTime <= data.startTime) {
    showFormError("La hora de fin debe ser posterior a la de inicio.");
    return;
  }

  // Última validación de conflictos justo antes de guardar (por si el
  // usuario nunca disparó los eventos "change"/"input", ej. autocompletado).
  submitBtn.disabled = true;
  const hasConflict = await runConflictCheck({ announce: true });
  if (hasConflict) {
    submitBtn.disabled = true;
    return;
  }
  submitBtn.disabled = false;

  try {
    if (idInput.value) {
      await updateScheduleSlot(idInput.value, data);
    } else {
      await createScheduleSlot(data);
    }
    rememberSubject(subject);
    closeModal();
    showToast("Clase guardada en el cronograma.", { type: "success", duration: 3000 });
    await renderSchedules();
  } catch (error) {
    console.error("No se pudo guardar la clase:", error);
    showFormError("No se pudo guardar. Intenta de nuevo.");
  }
});

deleteBtn?.addEventListener("click", async () => {
  const id = deleteBtn.dataset.id;
  if (!id || !confirm("¿Eliminar esta clase del cronograma?")) return;
  try {
    await deleteScheduleSlot(id);
    closeModal();
    showToast("Clase eliminada del cronograma.", { type: "info", duration: 3000 });
    await renderSchedules();
  } catch (error) {
    console.error("No se pudo eliminar la clase:", error);
    showFormError("No se pudo eliminar. Intenta de nuevo.");
  }
});

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function slotCard(slot, isDireccion) {
  const li = document.createElement("li");
  li.className = "bg-paper-100 border border-ink/10 rounded-xl p-3 flex items-center justify-between gap-3";
  li.innerHTML = `
    <div class="min-w-0">
      <p class="text-sm font-medium text-ink truncate">${slot.subject} · ${slot.courseName} (${slot.section})</p>
      <p class="text-xs text-ink/50">
        ${slot.day} ${slot.startTime}–${slot.endTime} · Aula ${slot.classroom} ·
        ${slot.type === "practico" ? "Práctico" : "Teórico"} · ${slot.teacherName}
      </p>
    </div>
    ${isDireccion ? `<button class="edit-schedule-btn shrink-0 text-xs font-medium text-teal-700 hover:text-teal-600 border border-teal/30 hover:bg-teal/10 rounded-lg px-2.5 py-1.5 transition">Editar</button>` : ""}
  `;
  if (isDireccion) {
    li.querySelector(".edit-schedule-btn").addEventListener("click", () => openEditModal(slot));
  }
  return li;
}

async function renderSchedules() {
  loadingEl.classList.remove("hidden");
  listEl.classList.add("hidden");
  emptyEl.classList.add("hidden");

  await ensureProfile();
  const isDireccion = currentUserProfile?.role === "direccion";
  newBtn.classList.toggle("hidden", !isDireccion);

  try {
    let slots = await listScheduleByPeriod(CURRENT_PERIOD);

    // Docentes ven solo sus propias clases; alumnos, las de los cursos en
    // los que están inscritos, ya filtradas al vuelo (evita otra consulta
    // por franja, la lista completa del periodo suele ser chica).
    if (currentUserProfile?.role === "docente") {
      slots = slots.filter((s) => s.teacherId === currentUser.uid);
    }

    loadingEl.classList.add("hidden");
    if (!slots.length) {
      emptyEl.classList.remove("hidden");
      emptyEl.classList.add("flex");
      return;
    }

    listEl.innerHTML = "";
    slots.forEach((slot) => listEl.appendChild(slotCard(slot, isDireccion)));
    listEl.classList.remove("hidden");
  } catch (error) {
    console.error("No se pudo cargar el cronograma:", error);
    loadingEl.textContent = "No se pudo cargar el cronograma.";
  }
}

// ---------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------
onAuthStateChanged(auth, (user) => {
  currentUser = user;
  currentUserProfile = null;
});

window.addEventListener("view:change", (event) => {
  if (event.detail?.view === "schedules") renderSchedules();
});

// NOTA: CURRENT_PERIOD está fijo en "2026". Si necesitas manejar varios
// periodos a la vez (ej. mientras arranca uno nuevo), lo más simple es
// convertir esa constante en un <select> más en el header de la vista —
// no lo agregué todavía para no adivinar cómo querés que se vea.
