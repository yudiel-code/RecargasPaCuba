# Manual Beta  Control Log

## Objetivo
Preparar una beta manual sin romper la versión API-ready ni tocar producción.

## Reglas de oro
- Trabajar SOLO en la rama: manual-beta
- No deploy a Hosting/Functions desde esta rama (solo cuando se autorice explícitamente)
- Cambios mínimos, 1 objetivo por commit
- No tocar zonas blindadas sin permiso: Auth/Firebase, saldo, monedas, historial, pagos, admin

## Checklist por cambio
- [ ] Scope definido (archivo(s) y objetivo)
- [ ] Probado local (web + emuladores si aplica)
- [ ] `git status` limpio
- [ ] Commit con mensaje claro
- [ ] Push a origin/manual-beta

## Registro
- (Añade aquí entradas por fecha: qué se cambió y por qué)
