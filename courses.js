// courses.js
// ---------------------------------------------------------------------------
// Módulo 2 — Gestión de Cursos.
//
// Docente: crea cursos (se genera un código de 6 caracteres), ve la lista
// de sus cursos y, al entrar a uno, genera un código QR de sesión y ve en
// vivo qué alumnos ya marcaron presente (delegado a attendance.js).
//
// Estudiante: se une a un curso con el código que le da el docente, ve la
// lista de cursos en los que está inscrito y, al entrar a uno, escanea el
// QR que le muestra su docente para registrar su propia asistencia
// (también delegado a attendance.js).
//
// Modelo de datos (colecciones planas, sin subcolecciones — ver
// firestore.rules):
//   courses/{courseId}            { teacherId, teacherName, name, code, createdAt }
//   enrollments/{courseId}_{uid}  { uid, courseId, courseName, teacherId,
//                                    teacherName, studentName, studentEmail, joinedAt }
//   attendance/{courseId}_{uid}_{YYYY-MM-DD} { uid, courseId, studentName,
//                                    date, recordedBy, timestamp }
// ---------------------------------------------------------------------------

import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  addDoc,
  doc,
  setDoc,
  getDoc,
  getDocs,
  deleteDoc,
  query,
  where,
  onSnapshot,
  limit,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Alfabeto sin caracteres ambiguos (sin 0/O, 1/I/L) para códigos legibles a mano.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

// ---------------------------------------------------------------------------
// Referencias al DOM
// ---------------------------------------------------------------------------
const subtitleEl = document.getElementById("courses-subtitle");
const actionBtn = document.getElementById("courses-action-btn");
const loadingEl = document.getElementById("courses-loading");
const emptyEl = document.getElementById("courses-empty");
const emptyTextEl = document.getElementById("courses-empty-text");
const listEl = document.getElementById("courses-list");

const createModal = document.getElementById("course-create-modal");
const createForm = document.getElementById("course-create-form");
const nameInput = document.getElementById("course-name-input");
const createError = document.getElementById("course-create-error");
const createSubmit = document.getElementById("course-create-submit");

const joinModal = document.getElementById("course-join-modal");
const joinForm = document.getElementById("course-join-form");
const codeInput = document.getElementById("course-code-input");
const joinError = document.getElementById("course-join-error");
const joinSubmit = document.getElementById("course-join-submit");

const detailModal = document.getElementById("course-detail-modal");
const detailNameEl = document.getElementById("course-detail-name");
const detailCodeEl = document.getElementById("course-detail-code");
const detailStudentSection = document.getElementById("course-detail-student");
const detailTeacherSection = document.getElementById("course-detail-teacher");

// Docente: genera el QR de sesión y ve el roster en vivo
const takeAttendanceBtn = document.getElementById("course-take-attendance-btn");
const studentCountEl = document.getElementById("course-student-count");
const presentCountEl = document.getElementById("course-present-count");
const studentsLoadingEl = document.getElementById("course-students-loading");
const studentsEmptyEl = document.getElementById("course-students-empty");
const studentsListEl = document.getElementById("course-students-list");

// Docente: materias dentro del curso (Matemática, Historia, etc.)
const subjectsLoadingEl = document.getElementById("course-subjects-loading");
const subjectsEmptyEl = document.getElementById("course-subjects-empty");
const subjectsListEl = document.getElementById("course-subjects-list");
const subjectForm = document.getElementById("course-subject-form");
const subjectInput = document.getElementById("course-subject-input");

// Estudiante: escanea el QR del docente
const attendanceStatusEl = document.getElementById("course-attendance-status");
let unsubscribeMyAttendance = null; // listener en vivo del propio registro (alumno)

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
let currentUser = null;
let currentUserProfile = null; // { displayName, email, role }
let activeCourse = null; // curso actualmente abierto en el modal de detalle
let unsubscribeRoster = null; // listener en vivo de attendance (docente)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function generateCourseCode() {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

function clearElement(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function openModalEl(modalEl) {
  modalEl.classList.remove("hidden");
}

function closeModalEl(modalEl) {
  modalEl.classList.add("hidden");
}

function closeDetailModal() {
  closeModalEl(detailModal);
  window.dispatchEvent(new CustomEvent("qr:stop"));
  unsubscribeRoster?.();
  unsubscribeRoster = null;
  unsubscribeMyAttendance?.();
  unsubscribeMyAttendance = null;
}

document.querySelectorAll(".modal-close-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.modal === "course-detail-modal") {
      closeDetailModal();
      return;
    }
    const modalEl = document.getElementById(btn.dataset.modal);
    if (modalEl) closeModalEl(modalEl);
  });
});

[createModal, joinModal, detailModal].forEach((modalEl) => {
  modalEl?.addEventListener("click", (event) => {
    if (event.target === modalEl) {
      if (modalEl === detailModal) {
        closeDetailModal();
      } else {
        closeModalEl(modalEl);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Carga de perfil (rol + nombre) — necesario para saber qué UI mostrar
// ---------------------------------------------------------------------------
async function ensureProfile() {
  if (currentUserProfile || !currentUser) return currentUserProfile;
  try {
    const snap = await getDoc(doc(db, "users", currentUser.uid));
    currentUserProfile = snap.exists() ? snap.data() : null;
  } catch (error) {
    console.error("No se pudo cargar el perfil del usuario:", error);
  }
  return currentUserProfile;
}

// ---------------------------------------------------------------------------
// Renderizado de la lista de cursos
// ---------------------------------------------------------------------------
function renderTeacherCourseCard(course) {
  const card = document.createElement("button");
  card.type = "button";
  card.className =
    "text-left border border-ink/10 rounded-xl p-4 bg-paper-100 hover:border-teal/40 transition flex items-center justify-between gap-3";

  const info = document.createElement("div");
  const title = document.createElement("p");
  title.className = "font-display text-sm font-semibold text-ink";
  title.textContent = course.name;
  const meta = document.createElement("p");
  meta.className = "text-[11px] text-ink/40 font-mono mt-0.5";
  meta.textContent = `Código: ${course.code}`;
  info.appendChild(title);
  info.appendChild(meta);

  const arrow = document.createElement("span");
  arrow.className = "text-ink/30 shrink-0";
  arrow.textContent = "→";

  card.appendChild(info);
  card.appendChild(arrow);
  card.addEventListener("click", () => openDetail(course));
  return card;
}

function renderStudentCourseCard(enrollment) {
  const card = document.createElement("button");
  card.type = "button";
  card.className =
    "text-left border border-ink/10 rounded-xl p-4 bg-paper-100 hover:border-teal/40 transition flex items-center justify-between gap-3";

  const info = document.createElement("div");
  const title = document.createElement("p");
  title.className = "font-display text-sm font-semibold text-ink";
  title.textContent = enrollment.courseName;
  const meta = document.createElement("p");
  meta.className = "text-[11px] text-ink/40 mt-0.5";
  meta.textContent = `Docente: ${enrollment.teacherName || "—"}`;
  info.appendChild(title);
  info.appendChild(meta);

  const arrow = document.createElement("span");
  arrow.className = "text-ink/30 shrink-0";
  arrow.textContent = "→";

  card.appendChild(info);
  card.appendChild(arrow);
  card.addEventListener("click", () =>
    openDetail({
      id: enrollment.courseId,
      name: enrollment.courseName,
      teacherName: enrollment.teacherName,
    })
  );
  return card;
}

async function loadCourses() {
  if (!currentUser) return;
  await ensureProfile();
  const role = currentUserProfile?.role;

  loadingEl.classList.remove("hidden");
  emptyEl.classList.add("hidden");
  emptyEl.classList.remove("flex");
  listEl.classList.add("hidden");
  clearElement(listEl);

  if (role === "docente") {
    subtitleEl.textContent = "Cursos que creaste";
    actionBtn.textContent = "+ Crear curso";
    emptyTextEl.textContent = "Aún no has creado ningún curso. Crea el primero para generar su código de inscripción.";
  } else {
    subtitleEl.textContent = "Cursos en los que estás inscrito";
    actionBtn.textContent = "+ Unirme a un curso";
    emptyTextEl.textContent = "Aún no te has unido a ningún curso. Pídele el código a tu docente.";
  }

  try {
    if (role === "docente") {
      const q = query(collection(db, "courses"), where("teacherId", "==", currentUser.uid));
      const snapshot = await getDocs(q);
      const courses = snapshot.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));

      loadingEl.classList.add("hidden");
      if (courses.length === 0) {
        emptyEl.classList.remove("hidden");
        emptyEl.classList.add("flex");
        return;
      }
      listEl.classList.remove("hidden");
      courses.forEach((c) => listEl.appendChild(renderTeacherCourseCard(c)));
    } else {
      const q = query(collection(db, "enrollments"), where("uid", "==", currentUser.uid));
      const snapshot = await getDocs(q);
      const enrollments = snapshot.docs
        .map((d) => d.data())
        .sort((a, b) => (b.joinedAt?.toMillis?.() || 0) - (a.joinedAt?.toMillis?.() || 0));

      loadingEl.classList.add("hidden");
      if (enrollments.length === 0) {
        emptyEl.classList.remove("hidden");
        emptyEl.classList.add("flex");
        return;
      }
      listEl.classList.remove("hidden");
      enrollments.forEach((e) => listEl.appendChild(renderStudentCourseCard(e)));
    }
  } catch (error) {
    console.error("No se pudo cargar la lista de cursos:", error);
    loadingEl.classList.add("hidden");
    emptyTextEl.textContent = "No se pudo cargar tus cursos. Intenta de nuevo.";
    emptyEl.classList.remove("hidden");
    emptyEl.classList.add("flex");
  }
}

// Recarga la lista cada vez que se entra a la vista de Cursos (directo o
// vía el atajo "Asistencia QR" del nav).
document
  .querySelectorAll('.nav-item[data-view="courses"], .nav-item[data-view="attendance"]')
  .forEach((btn) => btn.addEventListener("click", loadCourses));

// ---------------------------------------------------------------------------
// Crear curso (docente)
// ---------------------------------------------------------------------------
async function findCourseByCode(code) {
  const q = query(collection(db, "courses"), where("code", "==", code), limit(1));
  const snapshot = await getDocs(q);
  return snapshot.empty ? null : { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
}

createForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  createError.classList.add("hidden");

  const name = nameInput.value.trim();
  if (!name) return;

  createSubmit.disabled = true;
  createSubmit.textContent = "Creando…";

  try {
    // Reintenta si por mala suerte el código generado ya existe (muy poco probable).
    let code = generateCourseCode();
    for (let attempt = 0; attempt < 3 && (await findCourseByCode(code)); attempt++) {
      code = generateCourseCode();
    }

    const courseRef = await addDoc(collection(db, "courses"), {
      name,
      code,
      teacherId: currentUser.uid,
      teacherName: currentUserProfile?.displayName || currentUser.email,
      createdAt: serverTimestamp(),
    });

    nameInput.value = "";
    closeModalEl(createModal);
    await loadCourses();
    openDetail({ id: courseRef.id, name, code, teacherId: currentUser.uid });
  } catch (error) {
    console.error("No se pudo crear el curso:", error);
    createError.textContent = "No se pudo crear el curso. Intenta de nuevo.";
    createError.classList.remove("hidden");
  } finally {
    createSubmit.disabled = false;
    createSubmit.textContent = "Crear";
  }
});

// ---------------------------------------------------------------------------
// Unirse a un curso (estudiante)
// ---------------------------------------------------------------------------
joinForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  joinError.classList.add("hidden");

  const code = codeInput.value.trim().toUpperCase();
  if (!code) return;

  joinSubmit.disabled = true;
  joinSubmit.textContent = "Uniéndome…";

  try {
    const course = await findCourseByCode(code);
    if (!course) {
      joinError.textContent = "No se encontró un curso con ese código. Verifícalo con tu docente.";
      joinError.classList.remove("hidden");
      return;
    }

    const enrollmentId = `${course.id}_${currentUser.uid}`;
    await setDoc(doc(db, "enrollments", enrollmentId), {
      uid: currentUser.uid,
      courseId: course.id,
      courseName: course.name,
      teacherId: course.teacherId,
      teacherName: course.teacherName || "",
      studentName: currentUserProfile?.displayName || currentUser.email,
      studentEmail: currentUser.email,
      joinedAt: serverTimestamp(),
    });

    codeInput.value = "";
    closeModalEl(joinModal);
    await loadCourses();
  } catch (error) {
    console.error("No se pudo unir al curso:", error);
    joinError.textContent =
      error.code === "permission-denied"
        ? "Ya estás inscrito en este curso."
        : "No se pudo completar la inscripción. Intenta de nuevo.";
    joinError.classList.remove("hidden");
  } finally {
    joinSubmit.disabled = false;
    joinSubmit.textContent = "Unirme";
  }
});

// ---------------------------------------------------------------------------
// Botón principal del header: abre "Crear" o "Unirme" según el rol.
// ---------------------------------------------------------------------------
actionBtn?.addEventListener("click", async () => {
  await ensureProfile();
  if (currentUserProfile?.role === "docente") {
    createError.classList.add("hidden");
    nameInput.value = "";
    openModalEl(createModal);
    nameInput.focus();
  } else {
    joinError.classList.add("hidden");
    codeInput.value = "";
    openModalEl(joinModal);
    codeInput.focus();
  }
});

// ---------------------------------------------------------------------------
// Modal de detalle de curso
// ---------------------------------------------------------------------------
function todayDateString() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function renderStudentListItem(enrollment, isPresent) {
  const li = document.createElement("li");
  li.className = "px-3 py-2.5 flex items-center justify-between gap-3";

  const info = document.createElement("div");
  info.className = "flex flex-col min-w-0";
  const name = document.createElement("span");
  name.className = "text-sm text-ink truncate";
  name.textContent = enrollment.studentName;
  const email = document.createElement("span");
  email.className = "text-[11px] text-ink/40 truncate";
  email.textContent = enrollment.studentEmail || "";
  info.appendChild(name);
  info.appendChild(email);

  const badge = document.createElement("span");
  badge.className = [
    "shrink-0 text-[11px] font-mono px-2 py-0.5 rounded-full",
    isPresent ? "bg-marigold/15 text-marigold" : "bg-ink/5 text-ink/40",
  ].join(" ");
  badge.textContent = isPresent ? "✓ Presente" : "Ausente";

  li.appendChild(info);
  li.appendChild(badge);
  return li;
}

function renderRoster(students, presentUids) {
  studentsLoadingEl.classList.add("hidden");
  clearElement(studentsListEl);

  studentCountEl.textContent = String(students.length);
  presentCountEl.textContent = String(presentUids.size);

  if (students.length === 0) {
    studentsEmptyEl.classList.remove("hidden");
    studentsListEl.classList.add("hidden");
    return;
  }
  studentsEmptyEl.classList.add("hidden");
  studentsListEl.classList.remove("hidden");
  students.forEach((s) => studentsListEl.appendChild(renderStudentListItem(s, presentUids.has(s.uid))));
}

// Carga el roster una vez y luego lo mantiene sincronizado en vivo: a medida
// que los alumnos escanean el QR del docente, sus tarjetas pasan a
// "✓ Presente" sin que el docente tenga que recargar nada.
async function loadCourseStudents(courseId) {
  studentsLoadingEl.classList.remove("hidden");
  studentsEmptyEl.classList.add("hidden");
  studentsListEl.classList.add("hidden");
  clearElement(studentsListEl);

  let students = [];
  try {
    const q = query(collection(db, "enrollments"), where("courseId", "==", courseId));
    const snapshot = await getDocs(q);
    students = snapshot.docs
      .map((d) => d.data())
      .sort((a, b) => (a.studentName || "").localeCompare(b.studentName || ""));
  } catch (error) {
    console.error("No se pudo cargar la lista de alumnos:", error);
    studentsLoadingEl.classList.add("hidden");
    studentsEmptyEl.textContent = "No se pudo cargar la lista de alumnos.";
    studentsEmptyEl.classList.remove("hidden");
    return;
  }

  renderRoster(students, new Set());

  unsubscribeRoster?.();
  const attendanceQuery = query(collection(db, "attendance"), where("courseId", "==", courseId));
  const today = todayDateString();

  unsubscribeRoster = onSnapshot(
    attendanceQuery,
    (snapshot) => {
      const presentUids = new Set(
        snapshot.docs.map((d) => d.data()).filter((a) => a.date === today).map((a) => a.uid)
      );
      renderRoster(students, presentUids);
    },
    (error) => {
      console.error("Error al escuchar la asistencia en vivo:", error);
    }
  );
}

// ---------------------------------------------------------------------------
// Materias dentro del curso — Matemática, Historia, etc. Cada una es la
// unidad real sobre la que después se toma asistencia y se cargan notas
// (Horarios y Notas ya las reconocen vía subjects.js).
// ---------------------------------------------------------------------------
async function createCourseSubject(course, name) {
  await addDoc(collection(db, "courseSubjects"), {
    courseId: course.id,
    courseName: course.name,
    teacherId: course.teacherId,
    teacherName: course.teacherName || "",
    name,
    createdAt: serverTimestamp(),
  });
}

async function listCourseSubjects(courseId) {
  const q = query(collection(db, "courseSubjects"), where("courseId", "==", courseId));
  const snap = await getDocs(q);
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  rows.sort((a, b) => a.name.localeCompare(b.name, "es"));
  return rows;
}

async function deleteCourseSubject(subjectId) {
  await deleteDoc(doc(db, "courseSubjects", subjectId));
}

function renderSubjectChip(subject) {
  const li = document.createElement("li");
  li.className =
    "flex items-center gap-1.5 bg-paper-200 border border-ink/10 rounded-full pl-3 pr-1.5 py-1 text-xs text-ink";
  li.innerHTML = `
    <span>${subject.name}</span>
    <button type="button" class="subject-delete-btn w-4 h-4 flex items-center justify-center rounded-full text-ink/40 hover:text-coral hover:bg-coral/10 leading-none text-sm" title="Eliminar materia">&times;</button>
  `;
  li.querySelector(".subject-delete-btn").addEventListener("click", async () => {
    if (!confirm(`¿Eliminar la materia "${subject.name}"? (Las asistencias y notas ya cargadas no se borran.)`)) return;
    try {
      await deleteCourseSubject(subject.id);
      li.remove();
      if (!subjectsListEl.children.length) {
        subjectsListEl.classList.add("hidden");
        subjectsEmptyEl.classList.remove("hidden");
      }
    } catch (error) {
      console.error("No se pudo eliminar la materia:", error);
    }
  });
  return li;
}

async function loadCourseSubjects(course) {
  subjectsLoadingEl.classList.remove("hidden");
  subjectsEmptyEl.classList.add("hidden");
  subjectsListEl.classList.add("hidden");
  clearElement(subjectsListEl);

  let subjects = [];
  try {
    subjects = await listCourseSubjects(course.id);
  } catch (error) {
    console.error("No se pudo cargar las materias del curso:", error);
  }
  subjectsLoadingEl.classList.add("hidden");

  if (!subjects.length) {
    subjectsEmptyEl.classList.remove("hidden");
    return;
  }
  subjects.forEach((s) => subjectsListEl.appendChild(renderSubjectChip(s)));
  subjectsListEl.classList.remove("hidden");
}

subjectForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = subjectInput.value.trim();
  if (!name || !activeCourse) return;
  const submitBtn = subjectForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    await createCourseSubject(activeCourse, name);
    subjectInput.value = "";
    await loadCourseSubjects(activeCourse);
  } catch (error) {
    console.error("No se pudo crear la materia:", error);
  } finally {
    submitBtn.disabled = false;
  }
});


  activeCourse = course;
  const role = currentUserProfile?.role;

  detailNameEl.textContent = course.name;
  detailCodeEl.textContent =
    role === "docente" ? `Código: ${course.code}` : `Docente: ${course.teacherName || "—"}`;

  const isTeacher = role === "docente";
  detailStudentSection.classList.toggle("hidden", isTeacher);
  detailStudentSection.classList.toggle("flex", !isTeacher);
  detailTeacherSection.classList.toggle("hidden", !isTeacher);
  detailTeacherSection.classList.toggle("flex", isTeacher);

  openModalEl(detailModal);

  if (isTeacher) {
    loadCourseStudents(course.id);
    loadCourseSubjects(course);
  } else {
    attendanceStatusEl.classList.add("hidden");
    // El alumno genera su QR de inmediato al abrir el curso (attendance.js
    // escucha "qr:generate" y lo redibuja cada ~55s mientras el modal esté
    // abierto). Además escuchamos en vivo SU PROPIO registro de asistencia
    // del día para mostrar "✓ Asistencia registrada hoy" apenas el docente
    // lo escanea, sin que el alumno tenga que hacer nada más.
    window.dispatchEvent(
      new CustomEvent("qr:generate", { detail: { courseId: course.id, courseName: course.name } })
    );

    unsubscribeMyAttendance?.();
    const today = new Date().toISOString().slice(0, 10);
    const recordId = `${course.id}_${currentUser.uid}_${today}`;
    unsubscribeMyAttendance = onSnapshot(
      doc(db, "attendance", recordId),
      (snap) => {
        attendanceStatusEl.classList.toggle("hidden", !snap.exists());
      },
      (error) => {
        console.error("Error al escuchar mi asistencia:", error);
      }
    );
  }
}

// Docente: abre la cámara para escanear el QR de sus alumnos.
takeAttendanceBtn?.addEventListener("click", () => {
  if (!activeCourse) return;
  window.dispatchEvent(
    new CustomEvent("attendance:start-scan", {
      detail: { courseId: activeCourse.id, courseName: activeCourse.name },
    })
  );
});

// ---------------------------------------------------------------------------
// Inicialización ligada a la sesión de Firebase Auth
// ---------------------------------------------------------------------------
onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  currentUserProfile = null;
  if (user) {
    await ensureProfile();
  }
});
