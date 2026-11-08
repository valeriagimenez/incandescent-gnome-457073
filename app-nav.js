// app-nav.js
// ---------------------------------------------------------------------------
// Enrutamiento simple de la SPA entre las "vistas" del área principal
// (post-login). Antes, los botones del nav solo cambiaban de color activo
// pero el contenido nunca cambiaba — este módulo es el que realmente
// muestra/oculta vistas y mantiene sincronizado el estado visual del nav
// (lateral en desktop + inferior en móvil, que comparten data-view).
// ---------------------------------------------------------------------------

const navButtons = document.querySelectorAll(".nav-item");

// Vistas con markup real ya construido. Cada una vive en #view-{nombre}.
const REAL_VIEWS = ["chat", "summary", "courses", "agenda", "schedules", "grades", "grades-dashboard"];

const viewPlaceholder = document.getElementById("view-placeholder");

const placeholderIcon = document.getElementById("placeholder-icon");
const placeholderTitle = document.getElementById("placeholder-title");
const placeholderDesc = document.getElementById("placeholder-desc");
const placeholderBackBtn = document.getElementById("placeholder-back-btn");

// Contenido de cada módulo que todavía no tiene una vista real construida.
// "scanner" no aparece aquí a propósito: en vez de cambiar de vista, abre
// el modal de cámara (igual que el botón 📷 dentro del chat). "attendance"
// tampoco: redirige a "courses", donde vive todo el flujo de asistencia
// (el docente la abre desde el detalle de cada curso; el alumno genera su
// QR desde ahí mismo).
const PLACEHOLDER_CONTENT = {};

function setActiveNavButton(activeView) {
  navButtons.forEach((btn) => {
    const isActive = btn.dataset.view === activeView;
    btn.classList.toggle("bg-teal", isActive);
    btn.classList.toggle("text-void", isActive);
    btn.classList.toggle("shadow-glow", isActive);
    btn.classList.toggle("text-ink/60", !isActive);
    // Indicador de barra vertical verde (solo visible en la sidebar de
    // escritorio; en el dock móvil el propio fondo ya marca el activo).
    btn.classList.toggle("is-active", isActive);
  });
}

function showView(view) {
  const isRealView = REAL_VIEWS.includes(view);

  REAL_VIEWS.forEach((v) => {
    const el = document.getElementById(`view-${v}`);
    if (!el) return;
    const isActive = v === view;
    el.classList.toggle("hidden", !isActive);
    el.classList.toggle("flex", isActive);
  });

  viewPlaceholder.classList.toggle("hidden", isRealView);
  viewPlaceholder.classList.toggle("flex", !isRealView);

  if (!isRealView) {
    const content = PLACEHOLDER_CONTENT[view];
    if (content) {
      placeholderIcon.textContent = content.icon;
      placeholderTitle.textContent = content.title;
      placeholderDesc.textContent = content.desc;
    }
  }

  setActiveNavButton(view);

  // Los módulos nuevos (cronogramas/calificaciones/dashboard) cargan sus
  // datos bajo demanda, recién cuando el usuario entra a esa vista — así
  // no se pega a Firestore de más en cada login.
  window.dispatchEvent(new CustomEvent("view:change", { detail: { view } }));
}

// Oculta del nav los ítems que no aplican al rol del usuario actual:
//  - data-roles="docente,direccion"  → SOLO visible para esos roles (allow-list)
//  - data-hide-roles="direccion"     → oculto para esos roles puntuales (deny-list),
//    usado para las herramientas de IA que Dirección no necesita (Guía IA,
//    Captura de Apuntes, Síntesis, Recordatorios) — Dirección solo ve lo
//    esencial para supervisar (Materias, Horarios, Notas, Panorama, Asistencia).
// Sin ninguno de los dos atributos = visible siempre.
// Se corre apenas auth.js termina de setear body.dataset.role.
function applyRoleVisibility() {
  const role = document.body.dataset.role;
  navButtons.forEach((btn) => {
    const allowed = btn.dataset.roles;
    const hidden = btn.dataset.hideRoles;
    let visible = true;
    if (allowed) visible = allowed.split(",").includes(role);
    if (hidden && hidden.split(",").includes(role)) visible = false;
    btn.classList.toggle("hidden", !visible);
  });

  // Dirección no tiene "Guía IA" (chat), así que no puede arrancar ahí:
  // la mandamos a "Materias", que sí le queda visible.
  if (role === "direccion") {
    const activeBtn = document.querySelector('.nav-item[data-view="chat"]');
    if (activeBtn?.classList.contains("hidden")) {
      showView("courses");
    }
  }
}
window.addEventListener("auth:profile-ready", applyRoleVisibility);
// Por si este script corre después de que el perfil ya se cargó.
if (document.body.dataset.role) applyRoleVisibility();

navButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const view = btn.dataset.view;

    if (view === "scanner") {
      // El escáner es un modal, no una vista aparte: se abre encima del
      // chat (igual que el botón 📷 de la barra de entrada) y el nav
      // vuelve a marcar "Tutor IA" como activo de fondo.
      window.dispatchEvent(new CustomEvent("scanner:open"));
      showView("chat");
      return;
    }

    if (view === "attendance") {
      // Todo el flujo de asistencia vive dentro de Cursos (generar QR como
      // alumno, o tomar asistencia desde el detalle de un curso como
      // docente), así que este ítem es un atajo hacia esa vista.
      showView("courses");
      return;
    }

    showView(view);
  });
});

placeholderBackBtn?.addEventListener("click", () => showView("chat"));

// Vista inicial al cargar la app.
showView("chat");
