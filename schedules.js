// schedules.js
// ---------------------------------------------------------------------------
// Módulo 9 — Cronogramas de clase (modo dirección: crea/edita; docentes y
// alumnos: solo consultan).
//
// Un cronograma es una colección de "franjas" (una franja = una clase de una
// materia, un día, un horario). `label` es el nombre del cronograma en sí
// (ej. "Cronograma 1er cuatrimestre 2026"); cada franja individual vive como
// un documento propio en `schedules` con ese `label` repetido, para poder
// filtrar/editar franja por franja sin tocar las demás.
// ---------------------------------------------------------------------------

import { auth, db } from "./firebase-config.js";
import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  query,
  where,
  orderBy,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const CLASS_TYPES = ["teorico", "practico"];
export const WEEKDAYS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

// ---------------------------------------------------------------------------
// CRUD (dirección)
// ---------------------------------------------------------------------------

// `data` = { label, courseId, courseName, section, day, startTime, endTime,
//            subject, teacherId, teacherName, classroom, type, period }
export async function createScheduleSlot(data) {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error("No hay sesión activa.");
  if (!CLASS_TYPES.includes(data.type)) {
    throw new Error(`type debe ser uno de: ${CLASS_TYPES.join(", ")}`);
  }

  const ref = await addDoc(collection(db, "schedules"), {
    ...data,
    active: true,
    createdBy: uid,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function updateScheduleSlot(scheduleId, patch) {
  await updateDoc(doc(db, "schedules", scheduleId), patch);
}

// Baja lógica (no se borra el historial de cronogramas pasados).
export async function deactivateScheduleSlot(scheduleId) {
  await updateDoc(doc(db, "schedules", scheduleId), { active: false });
}

export async function deleteScheduleSlot(scheduleId) {
  await deleteDoc(doc(db, "schedules", scheduleId));
}

// ---------------------------------------------------------------------------
// Consultas (dirección, docentes, alumnos — todos pueden leer)
// ---------------------------------------------------------------------------

export async function listScheduleByPeriod(period, { activeOnly = true } = {}) {
  const clauses = [where("period", "==", period)];
  if (activeOnly) clauses.push(where("active", "==", true));
  const q = query(collection(db, "schedules"), ...clauses, orderBy("day"), orderBy("startTime"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function listScheduleByTeacher(teacherId, period) {
  const q = query(
    collection(db, "schedules"),
    where("teacherId", "==", teacherId),
    where("period", "==", period),
    where("active", "==", true)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function listScheduleByCourse(courseId, period) {
  const q = query(
    collection(db, "schedules"),
    where("courseId", "==", courseId),
    where("period", "==", period),
    where("active", "==", true)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// ---------------------------------------------------------------------------
// Validación de conflictos de horario
// ---------------------------------------------------------------------------
// Dos franjas "se pisan" si comparten al menos un minuto en común el mismo
// día: (inicioA < finB) && (inicioB < finA). Los horarios llegan como
// strings "HH:MM" (input type="time"), que comparan correctamente con <
// y > al ser longitud fija con ceros a la izquierda.
function overlaps(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

/**
 * Busca si el docente ya tiene una clase asignada que se superponga con el
 * horario propuesto, dentro del mismo periodo. `excludeId` se usa al editar
 * una franja existente, para no comparar la franja consigo misma.
 * Devuelve la franja en conflicto (con id) o null si no hay conflicto.
 */
export async function findTeacherConflict({ teacherId, day, startTime, endTime, period, excludeId }) {
  if (!teacherId || !day || !startTime || !endTime) return null;
  const q = query(
    collection(db, "schedules"),
    where("teacherId", "==", teacherId),
    where("day", "==", day),
    where("period", "==", period),
    where("active", "==", true)
  );
  const snap = await getDocs(q);
  for (const docSnap of snap.docs) {
    if (docSnap.id === excludeId) continue;
    const slot = docSnap.data();
    if (overlaps(startTime, endTime, slot.startTime, slot.endTime)) {
      return { id: docSnap.id, ...slot };
    }
  }
  return null;
}

/**
 * Igual que findTeacherConflict, pero para el aula/espacio: dos clases de
 * distintas materias no pueden ocupar la misma aula a la misma hora,
 * aunque el docente sea otro.
 */
export async function findClassroomConflict({ classroom, day, startTime, endTime, period, excludeId }) {
  if (!classroom || !day || !startTime || !endTime) return null;
  const q = query(
    collection(db, "schedules"),
    where("classroom", "==", classroom),
    where("day", "==", day),
    where("period", "==", period),
    where("active", "==", true)
  );
  const snap = await getDocs(q);
  for (const docSnap of snap.docs) {
    if (docSnap.id === excludeId) continue;
    const slot = docSnap.data();
    if (overlaps(startTime, endTime, slot.startTime, slot.endTime)) {
      return { id: docSnap.id, ...slot };
    }
  }
  return null;
}

/**
 * Corre ambas validaciones (docente + aula) y devuelve un resumen listo
 * para pintar en la UI:
 *  { hasConflict, teacherConflict, classroomConflict, message }
 */
export async function validateScheduleSlot(data) {
  const [teacherConflict, classroomConflict] = await Promise.all([
    findTeacherConflict(data),
    findClassroomConflict(data),
  ]);

  let message = null;
  if (teacherConflict) {
    message = `Conflicto detectado: El docente ${teacherConflict.teacherName || "asignado"} ya tiene asignada la clase ${teacherConflict.subject} a las ${teacherConflict.startTime}`;
  } else if (classroomConflict) {
    message = `Conflicto detectado: El aula ${classroomConflict.classroom} ya está ocupada por ${classroomConflict.subject} (${classroomConflict.teacherName || "otro docente"}) a las ${classroomConflict.startTime}`;
  }

  return {
    hasConflict: Boolean(teacherConflict || classroomConflict),
    teacherConflict,
    classroomConflict,
    message,
  };
}
