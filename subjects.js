// subjects.js
// ---------------------------------------------------------------------------
// Lista de "materias" compartida entre Cursos (courses.js — materias creadas
// dentro de un curso), Horarios (schedules.js) y Notas (grades.js): una
// materia creada en cualquiera de los tres módulos aparece disponible en
// los otros, en vez de mantener listas separadas que se desincronizan.
//
// No hay una única fuente de verdad "canónica": se arma leyendo los valores
// distintos de `subject`/`name` ya usados en `schedules`, `evaluations` y
// `courseSubjects`. Esto evita una migración de datos y mantiene todo
// consistente con el patrón "seleccioná o creá una nueva" que ya usan esos
// formularios.
// ---------------------------------------------------------------------------

import { db } from "./firebase-config.js";
import {
  collection,
  getDocs,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let cache = null;

export async function listAllSubjects({ force = false } = {}) {
  if (cache && !force) return cache;

  const [schedulesSnap, evaluationsSnap, courseSubjectsSnap] = await Promise.all([
    getDocs(collection(db, "schedules")),
    getDocs(collection(db, "evaluations")),
    getDocs(collection(db, "courseSubjects")),
  ]);

  const set = new Set();
  schedulesSnap.docs.forEach((d) => {
    const s = (d.data().subject || "").trim();
    if (s) set.add(s);
  });
  evaluationsSnap.docs.forEach((d) => {
    const s = (d.data().subject || "").trim();
    if (s) set.add(s);
  });
  courseSubjectsSnap.docs.forEach((d) => {
    const s = (d.data().name || "").trim();
    if (s) set.add(s);
  });

  cache = Array.from(set).sort((a, b) => a.localeCompare(b, "es"));
  return cache;
}

// Materias creadas específicamente dentro de un curso (courses.js). Se usa
// para priorizar, en el formulario de evaluaciones, las materias reales de
// ESE curso por sobre la lista global — si el curso no tiene ninguna
// todavía, quien llama debe hacer fallback a listAllSubjects().
export async function listCourseSubjectNames(courseId) {
  const q = query(collection(db, "courseSubjects"), where("courseId", "==", courseId));
  const snap = await getDocs(q);
  const names = snap.docs.map((d) => (d.data().name || "").trim()).filter(Boolean);
  return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b, "es"));
}

// Agrega una materia recién creada al cache en memoria, para que quede
// disponible al instante en el resto de la sesión sin tener que releer
// Firestore.
export function rememberSubject(subject) {
  const clean = (subject || "").trim();
  if (!clean) return;
  if (!cache) cache = [];
  if (!cache.includes(clean)) {
    cache.push(clean);
    cache.sort((a, b) => a.localeCompare(b, "es"));
  }
}

