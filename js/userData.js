// js/userData.js
// Capa única para manejar saldo, historial, monedas y avatar en localStorage

(function (global) {
  const KEYS = {
    SALDO: "rpc_saldo",
    HISTORIAL: "rpc_historial",
    MONEDAS: "rpc_monedas",
    AVATAR: "rpc_avatar"
  };

  // ---------- Helpers básicos ----------

  function safeParse(json, fallback) {
    try {
      const v = JSON.parse(json);
      return v == null ? fallback : v;
    } catch (e) {
      console.error("UserData safeParse error:", e);
      return fallback;
    }
  }

  // ---------- SALDO ----------

  function getSaldo() {
    const raw = localStorage.getItem(KEYS.SALDO);
    const valor = parseFloat(raw);
    return isNaN(valor) ? 0 : valor;
  }

  function setSaldo(nuevoSaldo) {
    const num = Number(nuevoSaldo) || 0;
    localStorage.setItem(KEYS.SALDO, num.toFixed(2));
    return num;
  }

  function addSaldo(importe, metodo) {
    const MAX_SALDO = 100;

    const valor = Number(importe) || 0;
    if (valor < 10) return getSaldo();

    const saldoActual = getSaldo();

    // Si ya está al máximo, no hacer nada
    if (saldoActual >= MAX_SALDO) return saldoActual;

    // Cap: no permitir superar 100 €
    const nuevoSaldo = Math.min(MAX_SALDO, saldoActual + valor);
    const agregadoReal = +(nuevoSaldo - saldoActual).toFixed(2);

    // Si por redondeos no se agrega nada, salir
    if (agregadoReal <= 0) return saldoActual;

    setSaldo(nuevoSaldo);
    addMovimientoSaldo(agregadoReal, metodo || "manual");

    // Actualizar monedas en base al historial
    recalcularMonedas();

    return nuevoSaldo;
  }

  // ---------- HISTORIAL ----------

  function getHistorial() {
    const raw = localStorage.getItem(KEYS.HISTORIAL) || "[]";
    const lista = safeParse(raw, []);
    return Array.isArray(lista) ? lista : [];
  }

  function setHistorial(lista) {
    const safe = Array.isArray(lista) ? lista : [];
    localStorage.setItem(KEYS.HISTORIAL, JSON.stringify(safe));
    return safe;
  }

  function addMovimiento(mov) {
    const lista = getHistorial();
    const ahora = new Date().toISOString();

    const item = {
      fecha: ahora,
      ...mov
    };

    lista.unshift(item);
    setHistorial(lista);

    return item;
  }

  function addMovimientoSaldo(importe, metodo) {
    return addMovimiento({
      tipo: "saldo",
      importe: Number(importe) || 0,
      metodo: metodo || "manual"
    });
  }

  function addMovimientoRecarga({ importe, numero, operador, productoId, descripcion, orderId, status, extra }) {
    return addMovimiento({
      tipo: "recarga",
      importe: Number(importe) || 0,
      numero: numero || "",
      operador: operador || "",
      productoId: productoId || "",
      descripcion: descripcion || "",
      orderId: orderId || null,
      status: status || null,
      ...((extra && typeof extra === "object") ? extra : {})
    });
  }

  function getUltimoMovimiento() {
    const lista = getHistorial();
    return lista.length ? lista[0] : null;
  }

  // ---------- MONEDAS ----------

  function getMonedas() {
    const raw = localStorage.getItem(KEYS.MONEDAS);
    const num = parseInt(raw, 10);
    return isNaN(num) ? 0 : num;
  }

  function setMonedas(total) {
    const n = Math.max(0, parseInt(total, 10) || 0);
    localStorage.setItem(KEYS.MONEDAS, String(n));
    return n;
  }

  function obtenerMonedasCubacel(importe) {
    const packs = [
      { ref: 10, coins: 13 },
      { ref: 20, coins: 27 },
      { ref: 30, coins: 41 },
      { ref: 50, coins: 69 }
    ];

    let elegido = packs[0];
    packs.forEach(function (p) {
      if (Math.abs(importe - p.ref) < Math.abs(importe - elegido.ref)) {
        elegido = p;
      }
    });
    return elegido.coins;
  }

  function calcularMonedasDesdeHistorial(historial) {
    const lista = Array.isArray(historial) ? historial : getHistorial();
    let totalMonedas = 0;

    lista.forEach(function (item) {
      if (item.tipo === "recarga") {
        const imp = Number(item.importe) || 0;
        const operador = item.operador || "";

        if (operador === "Cubacel") {
          totalMonedas += obtenerMonedasCubacel(imp);
        } else if (operador === "Nauta") {
          totalMonedas += 5;
        } else {
          if (imp > 0) {
            totalMonedas += obtenerMonedasCubacel(imp);
          }
        }
      }
    });

    return totalMonedas;
  }

  function recalcularMonedas() {
    const historial = getHistorial();
    const total = calcularMonedasDesdeHistorial(historial);
    setMonedas(total);
    return total;
  }

  // ---------- AVATAR ----------

  function getAvatar() {
    return localStorage.getItem(KEYS.AVATAR) || "";
  }

  function setAvatar(dataUrl) {
    if (!dataUrl) {
      localStorage.removeItem(KEYS.AVATAR);
      return "";
    }
    localStorage.setItem(KEYS.AVATAR, dataUrl);
    return dataUrl;
  }

  // ---------- API pública ----------

  const UserData = {
    // claves (por si los necesitas)
    KEYS,

    // saldo
    getSaldo,
    setSaldo,
    addSaldo,

    // historial
    getHistorial,
    setHistorial,
    addMovimiento,
    addMovimientoSaldo,
    addMovimientoRecarga,
    getUltimoMovimiento,

    // monedas
    getMonedas,
    setMonedas,
    obtenerMonedasCubacel,
    calcularMonedasDesdeHistorial,
    recalcularMonedas,

    // avatar
    getAvatar,
    setAvatar
  };

  global.UserData = UserData;
})(window);
