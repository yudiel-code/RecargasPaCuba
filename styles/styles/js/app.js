// ===== JS COMÚN – RecargasPaCuba =====

// Marcar activo en la barra inferior según la página
(function markActiveNav() {
  const path = window.location.pathname;
  const file = path.split("/").pop() || "index.html";

  const map = {
    "index.html": "nav-home",
    "recargar.html": "nav-recargar",
    "historial.html": "nav-historial",
    "cuenta.html": "nav-cuenta"
  };

  const activeId = map[file];
  if (!activeId) return;

  const el = document.getElementById(activeId);
  if (el) el.classList.add("nav-bottom__item--active");
})();

// Placeholder de toasts (se usará en B6)
export function showToast(message, type = "info") {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;

  if (type === "success") toast.style.background = "rgba(0, 160, 110, 0.9)";
  if (type === "error") toast.style.background = "rgba(190, 28, 52, 0.9)";

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(5px)";
    setTimeout(() => toast.remove(), 200);
  }, 2600);
}
