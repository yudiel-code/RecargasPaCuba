// admin/admin.js - lógica común admin (protección + helpers)

(function () {
  const ADMIN_EMAIL = "recargaspacubaapp@gmail.com";
  const isLoginPage = /\/admin\/login\.html$/i.test(window.location.pathname) ||
                      /login\.html$/i.test(window.location.pathname);

  // Guardar/hide mientras se confirma la sesión para evitar flash
  let previousVisibility;
  function hideUntilAuth() {
    if (isLoginPage) return;
    const doc = document.documentElement;
    previousVisibility = doc.style.visibility;
    doc.style.visibility = "hidden";
  }
  function showPage() {
    const doc = document.documentElement;
    if (previousVisibility !== undefined) {
      doc.style.visibility = previousVisibility;
    } else {
      doc.style.visibility = "";
    }
  }

  hideUntilAuth();

  function clearAdminFlags() {
    localStorage.removeItem("adminLogged");
    localStorage.removeItem("adminEmail");
  }

  async function forceSignOut() {
    if (window.firebaseSignOut && window.firebaseAuth) {
      try {
        await window.firebaseSignOut(window.firebaseAuth);
      } catch (e) {}
    }
  }

  async function handleUnauthenticated() {
    clearAdminFlags();
    await forceSignOut();
    if (!isLoginPage) {
      window.location.href = "login.html";
    } else {
      showPage();
    }
  }

  const hasFirebase = !!(window.firebaseOnAuthStateChanged && window.firebaseAuth);
  if (!hasFirebase) {
    handleUnauthenticated();
    return;
  }

  window.firebaseOnAuthStateChanged(window.firebaseAuth, async (user) => {
    const email = (user && user.email ? user.email.toLowerCase() : "");
    const esAdmin = !!user && email === ADMIN_EMAIL;

    if (!esAdmin) {
      await handleUnauthenticated();
      return;
    }

    // Admin válido: no se usan flags locales
    clearAdminFlags();
    showPage();
  });

  // Logout si existe el botón #logout en la página
  const logout = document.querySelector("#logout");
  if (logout) {
    logout.addEventListener("click", async () => {
      clearAdminFlags();

      if (window.firebaseSignOut && window.firebaseAuth) {
        try {
          await window.firebaseSignOut(window.firebaseAuth);
        } catch (e) {}
      }

      window.location.href = "login.html";
    });
  }

  // Helpers comunes para otras pantallas admin
  window.AdminHelpers = {
    formatCurrency(v) {
      return typeof v === "number" ? v.toFixed(2) + " €" : v;
    },
    emptyTable(tbody, message) {
      if (!tbody) return;
      tbody.innerHTML =
        `<tr><td colspan="100%" style="text-align:center;padding:18px">${message}</td></tr>`;
    }
  };
})();
