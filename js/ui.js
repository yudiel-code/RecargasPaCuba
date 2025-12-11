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
