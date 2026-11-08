// grades.js
// ---------------------------------------------------------------------------
// Módulo 8 (datos) — Carga de calificaciones, modelo de "evaluaciones".
//
// Cada evaluación es un evento puntual (un Trabajo Práctico, un Parcial, un
// Laboratorio, etc.) sobre un curso/sección/materia en un periodo y etapa
// determinados, con un puntaje total posible y una fecha. El docente carga
// después el puntaje obtenido por cada alumno; se aprueba con 70% o más.
//
// Modelo de datos (colecciones planas):
//   evaluations/{evalId}
//     { courseId, courseName, section, subject, teacherId, teacherName,
//       period, etapa, type, title, maxScore, date, createdAt }
//
//   evaluationScores/{evalId}_{uid}
//     { evaluationId, courseId, courseName, section, subject, period, etapa,
//       type, title, date, maxScore, studentUid, studentName, score,
//       percentage, passed, updatedAt }
//
// (El sistema anterior de 3 notas fijas —parcial/práctico/final— queda
// reemplazado por este esquema flexible.)
// ---------------------------------------------------------------------------

import { db } from "./firebase-config.js";
import {
  collection,
  addDoc,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  query,
  where,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const PASSING_PERCENT = 70;

// Sugerencias iniciales — el docente puede escribir cualquier otro tipo o
// etapa desde el formulario ("+ Nueva…"), igual que con las materias.
export const DEFAULT_EVALUATION_TYPES = [
  "Trabajo Práctico",
  "Parcial",
  "Examen Final",
  "Laboratorio",
  "Quiz",
  "Oral",
];
export const DEFAULT_ETAPAS = ["Bimestre 1", "Bimestre 2", "Bimestre 3", "Bimestre 4"];

function round1(n) {
  return Math.round(n * 10) / 10;
}

export function computeResult(score, maxScore) {
  const s = Number(score);
  const max = Number(maxScore);
  if (!Number.isFinite(s) || !Number.isFinite(max) || max <= 0) {
    return { percentage: null, passed: false };
  }
  const percentage = round1((s / max) * 100);
  return { percentage, passed: percentage >= PASSING_PERCENT };
}

// ---------------------------------------------------------------------------
// Evaluaciones (la "planilla": qué se evalúa, sobre cuánto, y cuándo)
// ---------------------------------------------------------------------------
export async function createEvaluation(data) {
  const ref = await addDoc(collection(db, "evaluations"), {
    ...data,
    maxScore: Number(data.maxScore),
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function updateEvaluation(evaluationId, data) {
  await updateDoc(doc(db, "evaluations", evaluationId), {
    ...data,
    maxScore: Number(data.maxScore),
  });
}

export async function deleteEvaluation(evaluationId) {
  const scores = await listScoresByEvaluation(evaluationId);
  await Promise.all(scores.map((s) => deleteDoc(doc(db, "evaluationScores", s.id))));
  await deleteDoc(doc(db, "evaluations", evaluationId));
}

export async function listEvaluationsByCourse(courseId) {
  const q = query(collection(db, "evaluations"), where("courseId", "==", courseId));
  const snap = await getDocs(q);
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  rows.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return rows;
}

// Tipos y etapas ya usados en algún curso, para poblar los selects además
// de las sugerencias por defecto.
export async function listUsedEvaluationTypes() {
  const snap = await getDocs(collection(db, "evaluations"));
  const set = new Set(DEFAULT_EVALUATION_TYPES);
  snap.docs.forEach((d) => {
    const t = (d.data().type || "").trim();
    if (t) set.add(t);
  });
  return Array.from(set);
}

export async function listUsedEtapas() {
  const snap = await getDocs(collection(db, "evaluations"));
  const set = new Set(DEFAULT_ETAPAS);
  snap.docs.forEach((d) => {
    const e = (d.data().etapa || "").trim();
    if (e) set.add(e);
  });
  return Array.from(set);
}

// ---------------------------------------------------------------------------
// Puntajes por alumno
// ---------------------------------------------------------------------------
export async function saveEvaluationScore(evaluation, studentUid, studentName, score) {
  const { percentage, passed } = computeResult(score, evaluation.maxScore);
  const id = `${evaluation.id}_${studentUid}`;
  await setDoc(
    doc(db, "evaluationScores", id),
    {
      evaluationId: evaluation.id,
      courseId: evaluation.courseId,
      courseName: evaluation.courseName,
      section: evaluation.section || "",
      subject: evaluation.subject,
      period: evaluation.period,
      etapa: evaluation.etapa,
      type: evaluation.type,
      title: evaluation.title || "",
      date: evaluation.date || "",
      maxScore: Number(evaluation.maxScore),
      studentUid,
      studentName,
      score: Number(score),
      percentage,
      passed,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
  return { percentage, passed };
}

export async function listScoresByEvaluation(evaluationId) {
  const q = query(collection(db, "evaluationScores"), where("evaluationId", "==", evaluationId));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function listScoresByCourse(courseId) {
  const q = query(collection(db, "evaluationScores"), where("courseId", "==", courseId));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function listScoresByStudent(studentUid) {
  const q = query(collection(db, "evaluationScores"), where("studentUid", "==", studentUid));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// ---------------------------------------------------------------------------
// Panorama estadístico (Módulo 10) — se arma a partir de todos los puntajes
// de un curso, sin importar de qué evaluación/materia/etapa vengan.
// ---------------------------------------------------------------------------
export function buildGradesDashboard(scores) {
  if (!scores.length) {
    return {
      overallAverage: null,
      passedCount: 0,
      failedCount: 0,
      averageBySubject: [],
      top5: [],
      needsSupport: [],
    };
  }

  const overallAverage = round1(
    scores.reduce((sum, s) => sum + (s.percentage ?? 0), 0) / scores.length
  );
  const passedCount = scores.filter((s) => s.passed).length;
  const failedCount = scores.length - passedCount;

  // Promedio por materia
  const bySubject = new Map();
  scores.forEach((s) => {
    const key = s.subject || "Sin materia";
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key).push(s.percentage ?? 0);
  });
  const averageBySubject = Array.from(bySubject.entries()).map(([subject, vals]) => ({
    subject,
    average: round1(vals.reduce((a, b) => a + b, 0) / vals.length),
  }));

  // Promedio por alumno (para top 5 / refuerzo)
  const byStudent = new Map();
  scores.forEach((s) => {
    if (!byStudent.has(s.studentUid)) {
      byStudent.set(s.studentUid, { studentName: s.studentName, vals: [] });
    }
    byStudent.get(s.studentUid).vals.push(s.percentage ?? 0);
  });
  const studentAverages = Array.from(byStudent.values()).map(({ studentName, vals }) => ({
    studentName,
    average: round1(vals.reduce((a, b) => a + b, 0) / vals.length),
  }));
  studentAverages.sort((a, b) => b.average - a.average);

  const top5 = studentAverages.slice(0, 5);
  const needsSupport = studentAverages.filter((s) => s.average < PASSING_PERCENT);

  return { overallAverage, passedCount, failedCount, averageBySubject, top5, needsSupport };
}
