// toast.js
// ---------------------------------------------------------------------------
// Notificación flotante minimalista, reutilizable en toda la app. Pensada
// primero para los conflictos de horario (rojo tenue), pero soporta otros
// tonos por si se necesita en el futuro (éxito, info).
// ---------------------------------------------------------------------------

let container = null;

function ensureContainer() {
  if (container) return container;
  container = document.createElement("div");
  container.id = "toast-container";
  container.className =
    "fixed z-[100] top-4 right-4 left-4 sm:left-auto sm:w-96 flex flex-col gap-2 pointer-events-none";
  document.body.appendChild(container);
  return container;
}

const VARIANTS = {
  error: {
    wrap: "bg-coral/10 border-coral/30 text-coral",
    icon: "⚠️",
  },
  success: {
    wrap: "bg-teal/10 border-teal/30 text-teal-700",
    icon: "✓",
  },
  info: {
    wrap: "bg-ink/10 border-ink/20 text-ink-700",
    icon: "ℹ️",
  },
};

/**
 * Muestra un toast temporal.
 * @param {string} message
 * @param {{ type?: 'error'|'success'|'info', duration?: number }} [opts]
 */
export function showToast(message, opts = {}) {
  const { type = "error", duration = 5000 } = opts;
  const variant = VARIANTS[type] || VARIANTS.info;

  const root = ensureContainer();

  const el = document.createElement("div");
  el.className = [
    "toast-enter pointer-events-auto rounded-xl border backdrop-blur-sm shadow-card",
    "px-4 py-3 text-xs sm:text-sm font-medium flex items-start gap-2.5",
    variant.wrap,
  ].join(" ");
  el.innerHTML = `
    <span class="shrink-0 text-sm leading-none mt-0.5">${variant.icon}</span>
    <span class="min-w-0 leading-snug">${message}</span>
    <button type="button" class="toast-close ml-auto shrink-0 text-current/60 hover:text-current leading-none text-base">&times;</button>
  `;

  const remove = () => {
    el.classList.add("toast-exit");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  };

  el.querySelector(".toast-close").addEventListener("click", remove);
  root.appendChild(el);

  if (duration > 0) setTimeout(remove, duration);

  return remove;
}
