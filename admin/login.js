// admin/login.js – acceso al panel admin

(function () {
  const form = document.getElementById("admin-login");
  if (!form) return; // por si se carga este script en otra página

  form.addEventListener("submit", function (e) {
    e.preventDefault();

    const user = document.getElementById("usuario")?.value.trim() || "";
    const pass = document.getElementById("clave")?.value.trim() || "";

    // Usuario y contraseña TEMPORALES (cambiar cuando montes backend real)
    const adminUser = "admin";
    const adminPass = "1234";

    if (user === adminUser && pass === adminPass) {
      // Guardamos sesión simple
      localStorage.setItem("adminLogged", "true");

      // Redirigimos al dashboard
      window.location.href = "dashboard.html";
    } else {
      alert("Usuario o contraseña incorrectos");
    }
  });
})();
