// guard.js - Protected Page Guard (promise-based, minimal)
// Bloquea la vista hasta validar sesión con Firebase auth; redirige si no hay usuario.

export function guardProtectedPage(options = {}) {
  const redirectTo = options.redirectTo || 'index.html';
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 7000;
  const { auth, onAuthStateChanged, onReady } = options;

  // Oculta hasta resolver la sesión.
  try { document.documentElement.style.visibility = 'hidden'; } catch (_) {}

  const redirect = () => {
    try {
      localStorage.removeItem('usuario');
      localStorage.removeItem('usuarioRegistrado');
    } catch (_) {}
    let finalDest = redirectTo;
    try {
      const currentPage = (location.pathname || '').split('/').pop() || '';
      const isOnIndex = currentPage.toLowerCase() === 'index.html';
      const redirectBase = (redirectTo.split('#')[0] || '').split('?')[0].toLowerCase();
      const isIndexTarget = redirectBase === 'index.html';
      if (isIndexTarget && !isOnIndex) {
        const relativeTarget = `${currentPage}${location.search || ''}${location.hash || ''}`;
        const encodedNext = encodeURIComponent(relativeTarget);
        const hasQuery = redirectTo.includes('?');
        const separator = redirectTo.endsWith('?') || redirectTo.endsWith('&') ? '' : (hasQuery ? '&' : '?');
        finalDest = `${redirectTo}${separator}next=${encodedNext}`;

        const vParam = (new URLSearchParams(location.search || '')).get('v');
        if (vParam && !/[?&]v=/.test(finalDest)) {
          const parts = finalDest.split('#');
          const base = parts[0];
          const hash = parts[1] ? '#' + parts[1] : '';
          const sep = base.includes('?') ? '&' : '?';
          finalDest = `${base}${sep}v=${encodeURIComponent(vParam)}${hash}`;
        }
      }
    } catch (_) {}
    location.replace(finalDest);
  };

  return new Promise((resolve) => {
    if (!auth || typeof onAuthStateChanged !== 'function') {
      redirect();
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      redirect();
    }, timeoutMs);

    const showPage = () => {
      try { document.documentElement.style.visibility = ''; } catch (_) {}
    };

    let unsubscribe = null;
    unsubscribe = onAuthStateChanged(auth, (user) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof unsubscribe === 'function') unsubscribe();

      if (!user) {
        redirect();
        return;
      }

      showPage();
      if (typeof onReady === 'function') {
        try { onReady(user); } catch (_) {}
      }
      resolve(user);
    }, (err) => {
      console.error('[Guard] Error leyendo estado de auth:', err);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      redirect();
    });
  });
}
