// ===== JS COMUNES — RecargasPaCuba =====

// Activa el botón de la barra inferior según el href de la página actual
function markActiveNavByHref() {
  const path = window.location.pathname;
  const file = path.split("/").pop() || "index.html";

  const navLinks = Array.from(document.querySelectorAll(".app-nav .nav-btn"));
  if (!navLinks.length) return;

  navLinks.forEach((link) => link.classList.remove("active"));

  const exact = navLinks.find((link) => (link.getAttribute("href") || "").endsWith(file));
  if (exact) {
    exact.classList.add("active");
    return;
  }

  // Fallback: si no encuentra coincidencia, marca el primero
  navLinks[0].classList.add("active");
}

document.addEventListener("DOMContentLoaded", () => {
  markActiveNavByHref();
});

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
