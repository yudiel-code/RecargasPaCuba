// admin/dashboard-metrics.js — carga métricas reales (callable: getAdminDashboardMetrics)

(function () {
  const elRecargas = document.getElementById("recargas-hoy");
  const elVentas   = document.getElementById("ventas-hoy");
  const elUsuarios = document.getElementById("usuarios-total");

  function setText(el, v) {
    if (!el) return;
    el.textContent = String(v);
  }

  function formatEur(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "0 €";
    return x.toFixed(2) + " €";
  }

  async function waitFor(condFn, timeoutMs = 8000, stepMs = 50) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (condFn()) return true; } catch (_) {}
      await new Promise(r => setTimeout(r, stepMs));
    }
    return false;
  }

  async function ensureFirebaseReady() {
    return await waitFor(() =>
      !!window.firebaseAuth &&
      !!window.firebaseOnAuthStateChanged &&
      !!window.firebaseCallFunction
    );
  }

  async function ensureAuthReady() {
    // Espera a que haya resolución de auth (user o null) para evitar carreras.
    return await new Promise((resolve) => {
      let done = false;
      const to = setTimeout(() => { if (!done) { done = true; resolve(false); } }, 8000);

      try {
        window.firebaseOnAuthStateChanged(window.firebaseAuth, () => {
          if (done) return;
          clearTimeout(to);
          done = true;
          resolve(true);
        });
      } catch (_) {
        clearTimeout(to);
        resolve(false);
      }
    });
  }

  async function loadMetrics() {
    setText(elRecargas, "—");
    setText(elVentas, "—");
    setText(elUsuarios, "—");

    const okFirebase = await ensureFirebaseReady();
    if (!okFirebase) {
      console.error("[admin] firebase no listo");
      return;
    }

    await ensureAuthReady();

    try {
      const result = await window.firebaseCallFunction("getAdminDashboardMetrics", {});
      const data = (result && typeof result === "object" && "data" in result) ? result.data : result;

      if (!data || data.ok !== true) {
        console.error("[admin] metrics error", data);
        return;
      }

      setText(elRecargas, data.recargasHoy ?? 0);
      setText(elVentas, formatEur(data.ventasHoyEur ?? 0));
      setText(elUsuarios, data.usuariosTotal ?? 0);
    } catch (e) {
      console.error("[admin] metrics exception", e);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", loadMetrics);
  } else {
    loadMetrics();
  }
})();
