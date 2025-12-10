// admin/admin.js - lógica común admin (protección + helpers)

(function () {
  const ADMIN_EMAILS = [
    "recargaspacubaapp@gmail.com"
  ];

  const isLoginPage = /\/admin\/login\.html$/i.test(window.location.pathname) ||
                      /login\.html$/i.test(window.location.pathname);

  // Fallback viejo por si Firebase no está disponible (solo para no romper nada)
  function fallbackLocalCheck() {
    const logged = localStorage.getItem("adminLogged");
    if (logged !== "true" && !isLoginPage) {
      window.location.href = "login.html";
    }
  }

  // Preferimos siempre Firebase
  if (window.firebaseOnAuthStateChanged && window.firebaseAuth) {
    window.firebaseOnAuthStateChanged(window.firebaseAuth, (user) => {
      const email = (user && user.email ? user.email.toLowerCase() : "");
      const esAdmin = !!user && ADMIN_EMAILS.includes(email);

      if (!esAdmin) {
        // Si no es admin:
        localStorage.removeItem("adminLogged");
        localStorage.removeItem("adminEmail");

        if (!isLoginPage) {
          window.location.href = "login.html";
        }
      } else {
        // Admin válido → marcamos flags locales
        localStorage.setItem("adminLogged", "true");
        localStorage.setItem("adminEmail", email);
      }
    });
  } else {
    // Si por cualquier motivo Firebase no se ha cargado,
    // usamos el comportamiento anterior basado en localStorage
    fallbackLocalCheck();
  }

  // Logout si existe el botón #logout en la página
  const logout = document.querySelector("#logout");
  if (logout) {
    logout.addEventListener("click", async () => {
      localStorage.removeItem("adminLogged");
      localStorage.removeItem("adminEmail");

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
