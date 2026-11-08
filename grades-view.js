// grades-view.js
// ---------------------------------------------------------------------------
// Módulo 8 (UI, modo docente) + Módulo 10 (dashboard estadístico).
//
// Flujo: el docente crea una "evaluación" (curso, sección, materia,
// periodo-etapa, tipo, puntaje total, fecha) y después carga el puntaje de
// cada alumno del curso sobre esa evaluación puntual. Se aprueba con 70%.
//
// Toda la lógica de cálculo/CRUD vive en grades.js — este archivo conecta
// eso con el DOM, y agrega los gráficos con Chart.js.
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
  PASSING_PERCENT,
  createEvaluation,
  updateEvaluation,
  deleteEvaluation,
  listEvaluationsByCourse,
  listUsedEvaluationTypes,
  listUsedEtapas,
  saveEvaluationScore,
  listScoresByEvaluation,
  listScoresByCourse,
  buildGradesDashboard,
} from "./grades.js";
import { listAllSubjects, listCourseSubjectNames, rememberSubject } from "./subjects.js";
import { showToast } from "./toast.js";

let currentUser = null;
let currentUserProfile = null;

async function ensureProfile() {
  if (currentUserProfile || !currentUser) return currentUserProfile;
  const snap = await getDoc(doc(db, "users", currentUser.uid));
  currentUserProfile = snap.exists() ? snap.data() : null;
  return currentUserProfile;
}

function waitForGlobal(name, timeoutMs = 6000, intervalMs = 100) {
  return new Promise((resolve, reject) => {
    if (window[name]) return resolve(window[name]);
    const start = Date.now();
    const timer = setInterval(() => {
      if (window[name]) {
        clearInterval(timer);
        resolve(window[name]);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`No se pudo cargar la librería requerida (${name}).`));
      }
    }, intervalMs);
  });
}

// Cursos visibles para el usuario actual: el docente ve los suyos,
// dirección ve todos.
async function loadMyCourses() {
  await ensureProfile();
  const role = currentUserProfile?.role;
  if (role === "direccion") {
    const snap = await getDocs(collection(db, "courses"));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }
  const q = query(collection(db, "courses"), where("teacherId", "==", currentUser.uid));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function loadCourseRoster(courseId) {
  const q = query(collection(db, "enrollments"), where("courseId", "==", courseId));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data()); // { uid, studentName, ... }
}

// ---------------------------------------------------------------------------
// Helper genérico: selects "elegí o creá uno nuevo" (materia / etapa / tipo)
// ---------------------------------------------------------------------------
function renderComboOptions(select, values, placeholder) {
  const opts = values.map((v) => `<option value="${v}">${v}</option>`).join("");
  select.innerHTML = `<option value="">${placeholder}</option>${opts}<option value="__new__">+ Nueva…</option>`;
}

function wireCombo({ select, newWrap, newInput, cancelBtn }) {
  select.addEventListener("change", () => {
    if (select.value === "__new__") {
      newWrap.classList.remove("hidden");
      newInput.value = "";
      newInput.focus();
    } else {
      newWrap.classList.add("hidden");
    }
  });
  cancelBtn.addEventListener("click", () => {
    newWrap.classList.add("hidden");
    select.value = "";
  });
}

function resolveCombo({ select, newInput }) {
  return select.value === "__new__" ? newInput.value.trim() : select.value.trim();
}

// =============================================================================
// PARTE 1 — Evaluaciones: crear, listar, cargar puntajes por alumno
// =============================================================================
const gradesCourseSelect = document.getElementById("grades-course-select");
const newEvalBtn = document.getElementById("grades-new-eval-btn");
const evalsEmptyEl = document.getElementById("grades-evaluations-empty");
const evalsListEl = document.getElementById("grades-evaluations-list");

const scoresPanel = document.getElementById("grades-scores-panel");
const scoresHeading = document.getElementById("grades-scores-heading");
const scoresSubheading = document.getElementById("grades-scores-subheading");
const scoresCloseBtn = document.getElementById("grades-scores-close-btn");
const scoresLoadingEl = document.getElementById("grades-scores-loading");
const scoresTableEl = document.getElementById("grades-scores-table");
const scoresTableBody = document.getElementById("grades-scores-table-body");
const scoresSaveStatus = document.getElementById("grades-scores-save-status");

const evalModal = document.getElementById("eval-form-modal");
const evalForm = document.getElementById("eval-form");
const evalFormTitle = document.getElementById("eval-form-title");
const evalFormCloseBtn = document.getElementById("eval-form-close-btn");
const evalFormError = document.getElementById("eval-form-error");
const evalIdInput = document.getElementById("eval-id");
const evalCourseSelect = document.getElementById("eval-course-select");
const evalSectionInput = document.getElementById("eval-section-input");
const evalPeriodInput = document.getElementById("eval-period-input");
const evalSubjectSelect = document.getElementById("eval-subject-select");
const evalSubjectNewWrap = document.getElementById("eval-subject-new-wrap");
const evalSubjectNewInput = document.getElementById("eval-subject-new");
const evalSubjectCancelBtn = document.getElementById("eval-subject-cancel-btn");
const evalEtapaSelect = document.getElementById("eval-etapa-select");
const evalEtapaNewWrap = document.getElementById("eval-etapa-new-wrap");
const evalEtapaNewInput = document.getElementById("eval-etapa-new");
const evalEtapaCancelBtn = document.getElementById("eval-etapa-cancel-btn");
const evalTypeSelect = document.getElementById("eval-type-select");
const evalTypeNewWrap = document.getElementById("eval-type-new-wrap");
const evalTypeNewInput = document.getElementById("eval-type-new");
const evalTypeCancelBtn = document.getElementById("eval-type-cancel-btn");
const evalTitleInput = document.getElementById("eval-title-input");
const evalMaxScoreInput = document.getElementById("eval-maxscore-input");
const evalDateInput = document.getElementById("eval-date-input");
const evalSubmitBtn = document.getElementById("eval-submit-btn");
const evalDeleteBtn = document.getElementById("eval-delete-btn");

wireCombo({ select: evalSubjectSelect, newWrap: evalSubjectNewWrap, newInput: evalSubjectNewInput, cancelBtn: evalSubjectCancelBtn });
wireCombo({ select: evalEtapaSelect, newWrap: evalEtapaNewWrap, newInput: evalEtapaNewInput, cancelBtn: evalEtapaCancelBtn });
wireCombo({ select: evalTypeSelect, newWrap: evalTypeNewWrap, newInput: evalTypeNewInput, cancelBtn: evalTypeCancelBtn });

let gradesCoursesCache = [];
let currentEvaluationId = null; // evaluación cuya planilla de puntajes está abierta

async function populateGradesCourseSelect() {
  gradesCoursesCache = await loadMyCourses();
  const options =
    `<option value="">Curso…</option>` +
    gradesCoursesCache.map((c) => `<option value="${c.id}">${c.name}</option>`).join("");
  gradesCourseSelect.innerHTML = options;
  evalCourseSelect.innerHTML = options;
}

function showFormError(message) {
  evalFormError.textContent = message;
  evalFormError.classList.remove("hidden");
}

function resetEvalForm() {
  evalForm.reset();
  evalIdInput.value = "";
  evalPeriodInput.value = "2026";
  evalSubjectNewWrap.classList.add("hidden");
  evalEtapaNewWrap.classList.add("hidden");
  evalTypeNewWrap.classList.add("hidden");
  evalFormError.classList.add("hidden");
  evalDeleteBtn.classList.add("hidden");
}

// Prioriza las materias creadas dentro del curso elegido (courses.js); si
// ese curso todavía no tiene ninguna, cae a la lista global de materias
// (Horarios/Notas de otros cursos) para no dejar el select vacío.
async function subjectsForCourse(courseId) {
  if (!courseId) return listAllSubjects();
  const courseSubjects = await listCourseSubjectNames(courseId);
  return courseSubjects.length ? courseSubjects : listAllSubjects();
}

async function openCreateEvalModal() {
  resetEvalForm();
  evalFormTitle.textContent = "Nueva evaluación";
  if (gradesCourseSelect.value) evalCourseSelect.value = gradesCourseSelect.value;
  const [subjects, etapas, types] = await Promise.all([
    subjectsForCourse(evalCourseSelect.value),
    listUsedEtapas(),
    listUsedEvaluationTypes(),
  ]);
  renderComboOptions(evalSubjectSelect, subjects, "Materia…");
  renderComboOptions(evalEtapaSelect, etapas, "Etapa…");
  renderComboOptions(evalTypeSelect, types, "Tipo de evaluación…");
  evalModal.classList.remove("hidden");
}

async function openEditEvalModal(evaluation) {
  resetEvalForm();
  evalFormTitle.textContent = "Editar evaluación";
  evalDeleteBtn.classList.remove("hidden");
  evalDeleteBtn.dataset.id = evaluation.id;

  evalIdInput.value = evaluation.id;
  evalCourseSelect.value = evaluation.courseId;
  evalSectionInput.value = evaluation.section || "";
  evalPeriodInput.value = evaluation.period || "2026";
  evalTitleInput.value = evaluation.title || "";
  evalMaxScoreInput.value = evaluation.maxScore;
  evalDateInput.value = evaluation.date || "";

  const [subjects, etapas, types] = await Promise.all([
    subjectsForCourse(evaluation.courseId),
    listUsedEtapas(),
    listUsedEvaluationTypes(),
  ]);
  renderComboOptions(evalSubjectSelect, subjects, "Materia…");
  renderComboOptions(evalEtapaSelect, etapas, "Etapa…");
  renderComboOptions(evalTypeSelect, types, "Tipo de evaluación…");
  evalSubjectSelect.value = evaluation.subject || "";
  evalEtapaSelect.value = evaluation.etapa || "";
  evalTypeSelect.value = evaluation.type || "";

  evalModal.classList.remove("hidden");
}

// Si el docente cambia de curso dentro del modal, refrescamos la lista de
// materias para que muestre las de ESE curso (no las del curso anterior).
evalCourseSelect?.addEventListener("change", async () => {
  const subjects = await subjectsForCourse(evalCourseSelect.value);
  const previous = evalSubjectSelect.value;
  renderComboOptions(evalSubjectSelect, subjects, "Materia…");
  if (subjects.includes(previous)) evalSubjectSelect.value = previous;
});

function closeEvalModal() {
  evalModal.classList.add("hidden");
}

newEvalBtn?.addEventListener("click", openCreateEvalModal);
evalFormCloseBtn?.addEventListener("click", closeEvalModal);
evalModal?.addEventListener("click", (e) => {
  if (e.target === evalModal) closeEvalModal();
});

evalForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  evalFormError.classList.add("hidden");

  const course = gradesCoursesCache.find((c) => c.id === evalCourseSelect.value);
  const subject = resolveCombo({ select: evalSubjectSelect, newInput: evalSubjectNewInput });
  const etapa = resolveCombo({ select: evalEtapaSelect, newInput: evalEtapaNewInput });
  const type = resolveCombo({ select: evalTypeSelect, newInput: evalTypeNewInput });

  if (!evalCourseSelect.value) return showFormError("Elegí un curso.");
  if (!subject) return showFormError("Elegí o escribí una materia.");
  if (!etapa) return showFormError("Elegí o escribí una etapa.");
  if (!type) return showFormError("Elegí o escribí un tipo de evaluación.");
  const maxScore = Number(evalMaxScoreInput.value);
  if (!maxScore || maxScore <= 0) return showFormError("El puntaje total debe ser mayor a 0.");
  if (!evalDateInput.value) return showFormError("Elegí una fecha.");

  await ensureProfile();
  const data = {
    courseId: evalCourseSelect.value,
    courseName: course?.name || "",
    section: evalSectionInput.value.trim(),
    subject,
    teacherId: currentUser.uid,
    teacherName: currentUserProfile?.name || currentUser.email || "",
    period: evalPeriodInput.value.trim() || "2026",
    etapa,
    type,
    title: evalTitleInput.value.trim(),
    maxScore,
    date: evalDateInput.value,
  };

  try {
    if (evalIdInput.value) {
      await updateEvaluation(evalIdInput.value, data);
    } else {
      await createEvaluation(data);
    }
    rememberSubject(subject);
    closeEvalModal();
    showToast("Evaluación guardada.", { type: "success", duration: 3000 });
    await renderEvaluationsList();
  } catch (error) {
    console.error("No se pudo guardar la evaluación:", error);
    showFormError("No se pudo guardar. Intenta de nuevo.");
  }
});

evalDeleteBtn?.addEventListener("click", async () => {
  const id = evalDeleteBtn.dataset.id;
  if (!id || !confirm("¿Eliminar esta evaluación y todos sus puntajes cargados?")) return;
  try {
    await deleteEvaluation(id);
    closeEvalModal();
    showToast("Evaluación eliminada.", { type: "info", duration: 3000 });
    if (currentEvaluationId === id) closeScoresPanel();
    await renderEvaluationsList();
  } catch (error) {
    console.error("No se pudo eliminar la evaluación:", error);
    showFormError("No se pudo eliminar. Intenta de nuevo.");
  }
});

// ---------------------------------------------------------------------------
// Lista de evaluaciones del curso elegido
// ---------------------------------------------------------------------------
function statusBadge(percentage, passed) {
  if (percentage == null) {
    return `<span class="text-[11px] text-ink/40">Sin cargar</span>`;
  }
  return passed
    ? `<span class="text-[11px] font-medium text-marigold">✓ Aprobado</span>`
    : `<span class="text-[11px] font-medium text-coral">✗ Reprobado</span>`;
}

function renderEvaluationCard(evaluation) {
  const li = document.createElement("li");
  li.className =
    "bg-paper-100 border border-ink/10 rounded-xl px-3.5 py-3 flex items-center justify-between gap-2 cursor-pointer hover:border-teal/40 transition";
  const metaParts = [evaluation.subject, evaluation.type];
  if (evaluation.section) metaParts.push(`Sec. ${evaluation.section}`);
  metaParts.push(evaluation.etapa);
  li.innerHTML = `
    <div class="min-w-0">
      <p class="text-sm font-medium text-ink truncate">${evaluation.title || evaluation.type}</p>
      <p class="text-xs text-ink/40 truncate">${metaParts.filter(Boolean).join(" · ")}</p>
    </div>
    <div class="shrink-0 text-right">
      <p class="text-xs font-mono text-ink/60">${evaluation.date || "—"}</p>
      <p class="text-[10px] text-ink/40">sobre ${evaluation.maxScore} pts</p>
    </div>
  `;
  li.addEventListener("click", () => openScoresPanel(evaluation));
  return li;
}

async function renderEvaluationsList() {
  const courseId = gradesCourseSelect.value;
  evalsListEl.classList.add("hidden");
  closeScoresPanel();

  if (!courseId) {
    evalsEmptyEl.textContent = "Elegí un curso para ver sus evaluaciones…";
    evalsEmptyEl.classList.remove("hidden");
    return;
  }

  evalsEmptyEl.textContent = "Cargando…";
  evalsEmptyEl.classList.remove("hidden");

  const evaluations = await listEvaluationsByCourse(courseId);

  if (!evaluations.length) {
    evalsEmptyEl.textContent = "Todavía no hay evaluaciones cargadas para este curso.";
    evalsEmptyEl.classList.remove("hidden");
    return;
  }

  evalsEmptyEl.classList.add("hidden");
  evalsListEl.innerHTML = "";
  evaluations.forEach((ev) => evalsListEl.appendChild(renderEvaluationCard(ev)));
  evalsListEl.classList.remove("hidden");
}

gradesCourseSelect?.addEventListener("change", renderEvaluationsList);

// ---------------------------------------------------------------------------
// Planilla de puntajes: alumno por alumno, para la evaluación seleccionada
// ---------------------------------------------------------------------------
function numberCell(value, maxScore) {
  return `<input type="number" min="0" max="${maxScore}" step="0.1" value="${value ?? ""}"
    class="grade-score w-20 rounded-lg border border-ink/15 bg-paper-200 px-2 py-1.5 text-sm text-center" />`;
}

function flashSaved() {
  scoresSaveStatus.classList.remove("hidden");
  setTimeout(() => scoresSaveStatus.classList.add("hidden"), 1500);
}

function closeScoresPanel() {
  currentEvaluationId = null;
  scoresPanel.classList.add("hidden");
}

async function openScoresPanel(evaluation) {
  currentEvaluationId = evaluation.id;
  scoresPanel.dataset.evaluation = JSON.stringify(evaluation);
  scoresHeading.textContent = evaluation.title || evaluation.type;
  const metaParts = [evaluation.subject, evaluation.type, evaluation.etapa, evaluation.date];
  if (evaluation.section) metaParts.splice(1, 0, `Sección ${evaluation.section}`);
  scoresSubheading.textContent = `${metaParts.filter(Boolean).join(" · ")} — sobre ${evaluation.maxScore} pts (≥${PASSING_PERCENT}% para aprobar)`;

  scoresTableEl.classList.add("hidden");
  scoresLoadingEl.textContent = "Cargando…";
  scoresLoadingEl.classList.remove("hidden");
  scoresPanel.classList.remove("hidden");
  scoresPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });

  const [roster, existingScores] = await Promise.all([
    loadCourseRoster(evaluation.courseId),
    listScoresByEvaluation(evaluation.id),
  ]);

  scoresLoadingEl.classList.add("hidden");
  if (!roster.length) {
    scoresLoadingEl.textContent = "Este curso todavía no tiene alumnos inscritos.";
    scoresLoadingEl.classList.remove("hidden");
    return;
  }

  const scoreByStudent = new Map(existingScores.map((s) => [s.studentUid, s]));

  scoresTableBody.innerHTML = "";
  roster.forEach((student) => {
    const existing = scoreByStudent.get(student.uid);
    const tr = document.createElement("tr");
    tr.className = "bg-paper-100";
    tr.dataset.studentUid = student.uid;
    tr.dataset.studentName = student.studentName;
    tr.innerHTML = `
      <td class="px-2 py-2 rounded-l-lg text-sm text-ink truncate max-w-[9rem]">${student.studentName}</td>
      <td class="px-2 py-2">${numberCell(existing?.score, evaluation.maxScore)}</td>
      <td class="px-2 py-2 text-center text-sm font-mono grade-percentage">${existing?.percentage != null ? existing.percentage + "%" : "—"}</td>
      <td class="px-2 py-2 rounded-r-lg grade-status">${statusBadge(existing?.percentage, existing?.passed)}</td>
    `;
    scoresTableBody.appendChild(tr);
  });
  scoresTableEl.classList.remove("hidden");
}

scoresCloseBtn?.addEventListener("click", closeScoresPanel);

// Guarda apenas el docente sale del campo de puntaje de una fila.
scoresTableBody?.addEventListener(
  "blur",
  async (event) => {
    const input = event.target;
    if (!input.matches(".grade-score")) return;
    if (input.value === "") return;

    const tr = input.closest("tr");
    const evaluation = JSON.parse(scoresPanel.dataset.evaluation || "{}");
    if (!evaluation.id) return;

    try {
      const { percentage, passed } = await saveEvaluationScore(
        evaluation,
        tr.dataset.studentUid,
        tr.dataset.studentName,
        input.value
      );
      tr.querySelector(".grade-percentage").textContent = percentage != null ? `${percentage}%` : "—";
      tr.querySelector(".grade-status").innerHTML = statusBadge(percentage, passed);
      flashSaved();
    } catch (error) {
      console.error("No se pudo guardar el puntaje:", error);
    }
  },
  true // captura, porque "blur" no burbujea
);

// =============================================================================
// PARTE 2 — Dashboard estadístico (Chart.js)
// =============================================================================
const dashCourseSelect = document.getElementById("dashboard-course-select");
const dashLoadingEl = document.getElementById("dashboard-loading");
const dashContentEl = document.getElementById("dashboard-content");
const dashOverallAvgEl = document.getElementById("dashboard-overall-average");
const dashPassedEl = document.getElementById("dashboard-passed-count");
const dashFailedEl = document.getElementById("dashboard-failed-count");
const dashTop5El = document.getElementById("dashboard-top5-list");
const dashSupportEl = document.getElementById("dashboard-support-list");

let subjectChart = null;
let passChart = null;

async function populateDashboardCourseSelect() {
  const courses = await loadMyCourses();
  dashCourseSelect.innerHTML =
    `<option value="">Curso…</option>` +
    courses.map((c) => `<option value="${c.id}">${c.name}</option>`).join("");
}

// Paleta tomada de tailwind.config.js (teal/marigold/coral) para que los
// charts encajen con el resto de la UI en vez de traer los colores default
// de Chart.js.
const CHART_COLORS = {
  teal: "#7c6cff",
  marigold: "#38e8c7",
  coral: "#ff6b81",
  grid: "rgba(240, 242, 248, 0.08)",
  text: "rgba(240, 242, 248, 0.6)",
};

async function renderDashboard() {
  const courseId = dashCourseSelect.value;
  dashContentEl.classList.add("hidden");
  dashContentEl.classList.remove("flex");

  if (!courseId) {
    dashLoadingEl.textContent = "Elegí un curso…";
    dashLoadingEl.classList.remove("hidden");
    return;
  }

  dashLoadingEl.textContent = "Cargando…";
  dashLoadingEl.classList.remove("hidden");

  let ChartLib;
  try {
    ChartLib = await waitForGlobal("Chart");
  } catch (error) {
    console.error(error);
    dashLoadingEl.textContent = "No se pudo cargar la librería de gráficos. Recarga la página.";
    return;
  }

  const scores = await listScoresByCourse(courseId);
  const stats = buildGradesDashboard(scores);

  dashLoadingEl.classList.add("hidden");
  dashContentEl.classList.remove("hidden");
  dashContentEl.classList.add("flex");

  dashOverallAvgEl.textContent = stats.overallAverage != null ? `${stats.overallAverage}%` : "—";
  dashPassedEl.textContent = stats.passedCount;
  dashFailedEl.textContent = stats.failedCount;

  // --- Gráfico de barras: promedio por materia ---
  subjectChart?.destroy();
  subjectChart = new ChartLib(document.getElementById("dashboard-subject-chart"), {
    type: "bar",
    data: {
      labels: stats.averageBySubject.map((s) => s.subject),
      datasets: [
        {
          label: "Promedio (%)",
          data: stats.averageBySubject.map((s) => s.average),
          backgroundColor: CHART_COLORS.teal,
          borderRadius: 6,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        y: {
          min: 0,
          max: 100,
          grid: { color: CHART_COLORS.grid },
          ticks: { color: CHART_COLORS.text },
        },
        x: { grid: { display: false }, ticks: { color: CHART_COLORS.text } },
      },
    },
  });

  // --- Gráfico de dona: aprobados vs. reprobados ---
  passChart?.destroy();
  passChart = new ChartLib(document.getElementById("dashboard-pass-chart"), {
    type: "doughnut",
    data: {
      labels: ["Aprobados", "Reprobados"],
      datasets: [
        {
          data: [stats.passedCount, stats.failedCount],
          backgroundColor: [CHART_COLORS.marigold, CHART_COLORS.coral],
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { position: "bottom", labels: { color: CHART_COLORS.text } } },
    },
  });

  // --- Top 5 ---
  dashTop5El.innerHTML = stats.top5.length
    ? stats.top5
        .map(
          (s, i) => `
        <li class="flex items-center justify-between py-2 text-sm">
          <span class="text-ink">${i + 1}. ${s.studentName}</span>
          <span class="font-mono text-marigold">${s.average}%</span>
        </li>`
        )
        .join("")
    : `<li class="py-2 text-xs text-ink/40">Sin datos suficientes todavía.</li>`;

  // --- Refuerzo ---
  dashSupportEl.innerHTML = stats.needsSupport.length
    ? stats.needsSupport
        .map(
          (s) => `
        <li class="flex items-center justify-between py-2 text-sm">
          <span class="text-ink">${s.studentName}</span>
          <span class="font-mono text-coral">${s.average}% <span class="text-[10px] text-ink/40">(&lt; ${PASSING_PERCENT}%)</span></span>
        </li>`
        )
        .join("")
    : `<li class="py-2 text-xs text-ink/40">Nadie por debajo del umbral de aprobación. 🎉</li>`;
}

dashCourseSelect?.addEventListener("change", renderDashboard);

// ---------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------
onAuthStateChanged(auth, (user) => {
  currentUser = user;
  currentUserProfile = null;
});

window.addEventListener("view:change", (event) => {
  if (event.detail?.view === "grades") {
    evalsListEl.classList.add("hidden");
    closeScoresPanel();
    populateGradesCourseSelect();
  }
  if (event.detail?.view === "grades-dashboard") {
    dashContentEl.classList.add("hidden");
    populateDashboardCourseSelect();
  }
});
