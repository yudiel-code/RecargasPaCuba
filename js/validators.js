(function (global) {
  function normalizeCubacel(num) {
    const cleaned = (num || "").replace(/\s+/g, "");
    if (/^\+53/.test(cleaned)) {
      return cleaned.replace(/^\+53/, "");
    }

    if (/^53/.test(cleaned) && cleaned.replace(/\D/g, "").length > 8) {
      return cleaned.replace(/^53/, "");
    }

    return cleaned;
  }

  function isCubacelNumber(num) {
    const normalized = normalizeCubacel(num);
    return /^5\d{7}$/.test(normalized);
  }

  function isMatchingNumbers(n1, n2) {
    return n1 === n2;
  }

  function isNautaEmail(email) {
    const cleaned = (email || "").trim().toLowerCase();
    return /^[a-z0-9._%+-]+@nauta\.(?:cu|com\.cu)$/.test(cleaned);
  }

  function validarRecargaEntrada({ operador, numero1, numero2, email }) {
    const op = (operador || "").toLowerCase();
    const n1 = (numero1 || "").replace(/\s+/g, "").trim();
    const n2 = (numero2 || "").replace(/\s+/g, "").trim();
    const emailLimpio = (email || "").trim();

    if (op.includes("nauta")) {
      const correo = emailLimpio || n1;
      const correoConfirmacion = emailLimpio || n2;

      if (!correo || !correoConfirmacion) {
        return { ok: false, error: "Por favor, escribe el correo NAUTA en ambos campos." };
      }

      if (!isMatchingNumbers(correo, correoConfirmacion)) {
        return { ok: false, error: "Los correos no coinciden. Revisa el correo NAUTA." };
      }

      if (!isNautaEmail(correo)) {
        return { ok: false, error: "Correo NAUTA inválido. Usa tu correo @nauta.cu o @nauta.com.cu." };
      }

      const correoFinal = correo.toLowerCase();
      return { ok: true, sanitized: { email: correoFinal, numero: correoFinal } };
    }

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
    isCubacelNumber,
    isMatchingNumbers,
    isNautaEmail,
    validarRecargaEntrada,
    isStrongPassword
  };
})(typeof window !== "undefined" ? window : this);
