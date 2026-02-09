// admin/login.js – acceso al panel admin con Firebase (password + Google)

(function () {
  const form = document.getElementById("admin-login");
  if (!form) return;

  const ADMIN_EMAILS = ["recargaspacubaapp@gmail.com"];

  function clearAdminFlags() {
    localStorage.removeItem("adminLogged");
    localStorage.removeItem("adminEmail");
  }

  function isAdminEmail(email) {
    const e = String(email || "").trim().toLowerCase();
    return !!e && ADMIN_EMAILS.includes(e);
  }

  function toast(msg) {
    try {
      if (typeof showToastError === "function") return showToastError(msg);
    } catch (e) {}
    alert(msg);
  }

  async function waitForFirebase(timeoutMs = 6000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (window.firebaseAuth && (window.firebaseSignIn || window.firebaseGoogleSignIn)) return true;
      await new Promise(r => setTimeout(r, 50));
    }
    return false;
  }

  async function forceSignOut() {
    if (window.firebaseSignOut && window.firebaseAuth) {
      try { await window.firebaseSignOut(window.firebaseAuth); } catch (e) {}
    }
  }

  function injectGoogleButton() {
    const submitBtn = form.querySelector('button[type="submit"]');
    if (!submitBtn) return;

    const googleBtn = document.createElement("button");
    googleBtn.type = "button";
    googleBtn.className = submitBtn.className || "btn btn-primary btn-lg btn-full";
    googleBtn.textContent = "Entrar con Google";
    googleBtn.style.marginTop = "10px";

    submitBtn.insertAdjacentElement("afterend", googleBtn);

    googleBtn.addEventListener("click", async () => {
      const ok = await waitForFirebase();
      if (!ok) {
        toast("Firebase aún no está listo. Recarga la página e inténtalo de nuevo.");
        return;
      }
      if (!window.firebaseGoogleSignIn) {
        toast("Login con Google no disponible en este entorno.");
        return;
      }

      clearAdminFlags();

      try {
        const cred = await window.firebaseGoogleSignIn(window.firebaseAuth);
        const user = cred?.user || null;
        const correoUser = (user?.email ? String(user.email).toLowerCase() : "");

        if (!user || !isAdminEmail(correoUser)) {
          await forceSignOut();
          toast("No tienes permisos de administrador.");
          return;
        }

        localStorage.setItem("adminLogged", "true");
        localStorage.setItem("adminEmail", correoUser);
        window.location.href = "dashboard.html";
      } catch (error) {
        console.error("Error en login admin (Google):", error);
        toast("No se pudo iniciar sesión con Google.");
      }
    });
  }

  injectGoogleButton();

  form.addEventListener("submit", async function (e) {
    e.preventDefault();

    const email = (document.getElementById("usuario")?.value || "").trim().toLowerCase();
    const pass = (document.getElementById("clave")?.value || "").trim();

    if (!email || !pass) {
      toast("Introduce correo y contraseña.");
      return;
    }

    const ok = await waitForFirebase();
    if (!ok || !window.firebaseSignIn || !window.firebaseAuth) {
      toast("Servicio de login de administrador no disponible. Recarga e inténtalo de nuevo.");
      return;
    }

    try {
      const cred = await window.firebaseSignIn(window.firebaseAuth, email, pass);
      const user = cred?.user || null;
      const correoUser = (user?.email ? String(user.email).toLowerCase() : "");

      if (!user || !isAdminEmail(correoUser)) {
        await forceSignOut();
        clearAdminFlags();
        toast("No tienes permisos de administrador.");
        return;
      }

      localStorage.setItem("adminLogged", "true");
      localStorage.setItem("adminEmail", correoUser);
      window.location.href = "dashboard.html";
    } catch (error) {
      console.error("Error en login admin:", error);

      let mensaje = "No se ha podido iniciar sesión como admin.";
      if (error?.code === "auth/user-not-found") {
        mensaje = "No existe una cuenta con ese correo.";
      } else if (error?.code === "auth/invalid-credential") {
        mensaje = "Correo/contraseña incorrectos o esta cuenta es solo Google (usa “Entrar con Google”).";
      } else if (error?.code === "auth/too-many-requests") {
        mensaje = "Demasiados intentos. Inténtalo de nuevo más tarde.";
      } else if (error?.code === "auth/operation-not-allowed") {
        mensaje = "Email/contraseña está deshabilitado en Firebase Auth.";
      }

      toast(mensaje);
    }
  });
})();
