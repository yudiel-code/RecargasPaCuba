// Toast helper for RecargasPaCuba
(function () {
  const TOAST_DURATION = 3500;

  function ensureContainer() {
    let container = document.getElementById("toast-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "toast-container";
      container.className = "toast-container";
      document.body.appendChild(container);
    }
    return container;
  }

  function createToast(message, type) {
    const container = ensureContainer();
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add("show"));

    setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => toast.remove(), 200);
    }, TOAST_DURATION);
  }

  window.showToastSuccess = function (message) {
    createToast(message, "success");
  };

  window.showToastError = function (message) {
    createToast(message, "error");
  };
})();

// Append current ?v cache-busting param to internal *.html links (idempotent).
(function () {
  const applyVersionToLinks = () => {
    const params = new URLSearchParams(window.location.search || "");
    const currentV = params.get("v");
    if (!currentV) return;

    const anchors = document.querySelectorAll("a[href]");
    anchors.forEach((a) => {
      const href = (a.getAttribute("href") || "").trim();
      if (!href) return;
      const lower = href.toLowerCase();
      if (href.startsWith("#")) return;
      if (lower.startsWith("mailto:") || lower.startsWith("tel:") || lower.startsWith("javascript:")) return;
      if (href.includes("://")) return;

      let url;
      try {
        url = new URL(href, window.location.href);
      } catch (_) {
        return;
      }

      if (url.origin !== window.location.origin) return;
      if (!url.pathname.toLowerCase().endsWith(".html")) return;
      if (url.searchParams.has("v")) return;

      url.searchParams.set("v", currentV);
      const search = url.searchParams.toString();
      const newHref = `${url.pathname}${search ? "?" + search : ""}${url.hash || ""}`;
      a.setAttribute("href", newHref);
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyVersionToLinks, { once: true });
  } else {
    applyVersionToLinks();
  }
})();
