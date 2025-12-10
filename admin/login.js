// admin/login.js – acceso al panel admin con Firebase

(function () {
  const form = document.getElementById("admin-login");
  if (!form) return; // por si se carga este script en otra página

  const ADMIN_EMAILS = [
    "recargaspacubaapp@gmail.com"
  ];

  form.addEventListener("submit", async function (e) {
    e.preventDefault();

    const email = (document.getElementById("usuario")?.value || "").trim().toLowerCase();
    const pass  = (document.getElementById("clave")?.value || "").trim();

    if (!email || !pass) {
      alert("Introduce correo y contraseña.");
      return;
    }

    if (!window.firebaseAuth || !window.firebaseSignIn) {
      alert("Servicio de login de administrador no disponible. Inténtalo de nuevo en unos minutos.");
      return;
    }

    try {
      // Login contra Firebase
      const cred = await window.firebaseSignIn(window.firebaseAuth, email, pass);
      const user = cred?.user || null;
      const correoUser = (user && user.email ? user.email.toLowerCase() : "");

      const esAdmin = !!user && ADMIN_EMAILS.includes(correoUser);

      if (!esAdmin) {
        // Si se loguea alguien que no es admin, lo sacamos
        if (window.firebaseSignOut) {
          try { await window.firebaseSignOut(window.firebaseAuth); } catch (e) {}
        }
        localStorage.removeItem("adminLogged");
        localStorage.removeItem("adminEmail");
        alert("No tienes permisos de administrador.");
        return;
      }

      // Marcamos sesión admin a nivel local (solo comodidad UI)
      localStorage.setItem("adminLogged", "true");
      localStorage.setItem("adminEmail", correoUser);

      // Redirigimos al dashboard
      window.location.href = "dashboard.html";
    } catch (error) {
      console.error("Error en login admin:", error);

      let mensaje = "No se ha podido iniciar sesión como admin.";
      if (error.code === "auth/user-not-found") {
        mensaje = "No existe una cuenta con ese correo.";
      } else if (error.code === "auth/invalid-credential") {
        mensaje = "Correo o contraseña incorrectos.";
      } else if (error.code === "auth/too-many-requests") {
        mensaje = "Demasiados intentos. Inténtalo de nuevo más tarde.";
      }

      alert(mensaje);
    }
  });
})();
