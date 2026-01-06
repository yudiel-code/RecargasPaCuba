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

  const MAX_SALDO = 100;

  function getSaldo() {
    const raw = localStorage.getItem(KEYS.SALDO);
    const valor = parseFloat(raw);
    const num = isNaN(valor) ? 0 : valor;

    // Normaliza valores fuera de rango (incluye saldo viejo inflado)
    const capped = Math.min(MAX_SALDO, Math.max(0, num));
    if (capped !== num) {
      localStorage.setItem(KEYS.SALDO, capped.toFixed(2));
    }
    return capped;
  }

  function setSaldo(nuevoSaldo) {
    const num = Number(nuevoSaldo);
    const safeNum = isNaN(num) ? 0 : num;
    const capped = Math.min(MAX_SALDO, Math.max(0, safeNum));
    localStorage.setItem(KEYS.SALDO, capped.toFixed(2));
    return capped;
  }

  function addSaldo(importe, metodo) {
    const valor = Number(importe) || 0;
    const saldoActual = getSaldo();

    // Telemetría simple para que la UI pueda decidir qué toast mostrar (sin romper compatibilidad)
    function setLast(ok, reason, requested, applied, saldo) {
      global.__rpc_last_add_saldo = {
        ok: !!ok,
        reason: String(reason || ""),
        requested: +Number(requested || 0).toFixed(2),
        applied: +Number(applied || 0).toFixed(2),
        saldo: +Number(saldo || 0).toFixed(2),
        at: new Date().toISOString()
      };
    }

    if (valor < 10) {
      setLast(false, "MIN_AMOUNT", valor, 0, saldoActual);
      return saldoActual;
    }

    const headroom = +(MAX_SALDO - saldoActual).toFixed(2);

    // Si ya está al máximo, no hacer nada
    if (headroom <= 0) {
      setLast(false, "MAX_REACHED", valor, 0, saldoActual);
      return saldoActual;
    }

    // Solo aplicar lo que realmente cabe
    const aplicado = +Math.min(headroom, valor).toFixed(2);

    if (aplicado <= 0) {
      setLast(false, "NO_APPLIED", valor, 0, saldoActual);
      return saldoActual;
    }

    // IMPORTANTE: registrar movimiento ANTES de setSaldo para que no se anule al llegar a 100
    addMovimientoSaldo(aplicado, metodo || "manual");

    const nuevoSaldo = setSaldo(saldoActual + aplicado);

    // Actualizar monedas en base al historial
    recalcularMonedas();

    setLast(true, aplicado < valor ? "CAPPED" : "OK", valor, aplicado, nuevoSaldo);
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
    const imp = Number(importe) || 0;
    if (imp <= 0) return null;

    // Guardrail: nunca registrar "saldo añadido" si no cabe en el saldo actual
    const saldoActual = getSaldo();
    const headroom = +(MAX_SALDO - saldoActual).toFixed(2);
    const aplicado = +Math.min(imp, Math.max(0, headroom)).toFixed(2);

    if (aplicado <= 0) return null;

    return addMovimiento({
      tipo: "saldo",
      importe: aplicado,
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
