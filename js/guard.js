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
      const finalDestUrl = new URL(redirectTo, location.href);
      const currentPage = (location.pathname || '').split('/').pop() || '';
      const isOnIndex = currentPage.toLowerCase() === 'index.html';
      const redirectPath = finalDestUrl.pathname || '';
      const redirectLast = (redirectPath.split('/').pop() || '').replace(/^\.\//, '').toLowerCase();
      const isIndexTarget = redirectLast === 'index.html';
      if (isIndexTarget && !isOnIndex) {
        const relativeTarget = `${currentPage}${location.search || ''}${location.hash || ''}`;
        finalDestUrl.searchParams.set('next', relativeTarget);

        const vParam = (new URLSearchParams(location.search || '')).get('v');
        if (vParam && !finalDestUrl.searchParams.has('v')) {
          finalDestUrl.searchParams.set('v', vParam);
        }
      }
      finalDest = finalDestUrl.toString();
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
