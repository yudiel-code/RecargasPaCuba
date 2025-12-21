(function (global) {
  function normalizeCubacel(num) {
    // Solo dígitos
    let digits = String(num || "").replace(/\D/g, "");

    // Quita el 53 SOLO si es prefijo internacional (hay más de 8 dígitos)
    // Ej: +53 5 3719610 -> "5353719610" (10) -> recorta a "53719610" (8)
    // Ej: 53719610 (8) -> NO recorta (porque es número local válido que empieza por 53)
    while (digits.startsWith("53") && digits.length > 8) {
      digits = digits.slice(2);
    }

    return digits; // esperado: 8 dígitos empezando por 5
  }

  function isCubacelNumber(num) {
    const cleaned = normalizeCubacel(num);
    return /^5\d{7}$/.test(cleaned);
  }

  function isMatchingNumbers(n1, n2) {
    return n1 === n2;
  }

  function isNautaEmail(email) {
    const cleaned = (email || "").trim().toLowerCase();
    // Solo dominios válidos para recarga NAUTA
    return /^[a-z0-9._%+-]+@nauta\.(?:com\.cu|co\.cu)$/.test(cleaned);
  }

  function validarRecargaEntrada({ operador, tipo, numero1, numero2, email1, email2 }) {
    const op = (operador || "").toLowerCase();
    const t = (tipo || "").toLowerCase();
    const n1 = (numero1 || "").replace(/\s+/g, "").trim();
    const n2 = (numero2 || "").replace(/\s+/g, "").trim();
    const e1 = (email1 || "").trim();
    const e2 = (email2 || "").trim();

    const esNauta = (t === "nauta") || op.includes("nauta");

    if (esNauta) {
      const correo = e1 || n1;
      const correoConfirmacion = e2 || n2;

      if (!correo || !correoConfirmacion) {
        return { ok: false, error: "Por favor, escribe el correo NAUTA en ambos campos." };
      }

      if (String(correo).trim() !== String(correoConfirmacion).trim()) {
        return { ok: false, error: "Los correos no coinciden. Revisa el correo NAUTA." };
      }

      if (!isNautaEmail(correo)) {
        return { ok: false, error: "Correo NAUTA inválido. Usa usuario@nauta.com.cu o usuario@nauta.co.cu." };
      }

      const correoFinal = String(correo).trim().toLowerCase();
      return { ok: true, sanitized: { destino: correoFinal, email: correoFinal, numero: correoFinal } };
    }

    // Cubacel: normalizar sin comerse el "53" local cuando el número empieza por 53xxxxxx
    const normalized1 = normalizeCubacel(n1);
    const normalized2 = normalizeCubacel(n2);

    if (!normalized1 || !normalized2) {
      return { ok: false, error: "Por favor, escribe el número en ambos campos." };
    }

    if (!isMatchingNumbers(normalized1, normalized2)) {
      return { ok: false, error: "Los números no coinciden. Revísalos." };
    }

    if (!isCubacelNumber(normalized1)) {
      return { ok: false, error: "El número debe ser un móvil cubano válido (+53 5XXXXXXX)." };
    }

    return { ok: true, sanitized: { numero: "+53" + normalized1 } };
  }

  function isStrongPassword(password) {
    const pass = String(password || "");
    return /^(?=.*[A-Z])(?=.*\d).{8,}$/.test(pass);
  }

  global.Validators = {
    normalizeCubacel,
    isCubacelNumber,
    isMatchingNumbers,
    isNautaEmail,
    validarRecargaEntrada,
    isStrongPassword
  };
})(typeof window !== "undefined" ? window : this);
