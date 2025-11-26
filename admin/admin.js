// admin/admin.js - lógica común admin
(function(){
  // comprobación auth
  const logged = localStorage.getItem("adminLogged");
  if (logged !== "true") {
    // si la página actual es login, no redirigir
    if (!/login\.html$/i.test(window.location.pathname)) {
      window.location.href = "login.html";
    }
  }

  // aplicar logout si existe el botón
  const logout = document.querySelector('#logout');
  if (logout) {
    logout.addEventListener('click', () => {
      localStorage.removeItem('adminLogged');
      window.location.href = 'login.html';
    });
  }

  // helper para render de cards (opcional)
  window.AdminHelpers = {
    formatCurrency(v){ return typeof v === 'number' ? v.toFixed(2) + ' €' : v },
    emptyTable(tbody, message){
      tbody.innerHTML = `<tr><td colspan="100%" style="text-align:center;padding:18px">${message}</td></tr>`;
    }
  };
})();
