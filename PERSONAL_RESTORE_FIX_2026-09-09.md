# Restauración al cambiar de sesión

Desplegado el 9 de septiembre de 2026, verificado a las 01:06 Europe/Madrid.
Worker: `260017ab-fb6b-4e6c-8854-6a1c65e019d5`.

El perfil afectado y su contexto activo indicaban VE/USD, pero el espacio
personal asociado conservaba ES/EUR. Tenía 11 movimientos. El filtro de país
aplicado también a espacios personales excluía ese espacio y devolvía una
colección vacía; la app detenía la restauración con “La cuenta remota no tiene
espacios activos”. No se habían perdido los movimientos.

Se centralizó el criterio en `src/services/active-space-scope.ts`, usado por
snapshot, lista de espacios y autorización por ID:

- Personal: membresía activa y espacio seleccionado por el perfil autenticado.
- Compartido: membresía activa y país compatible.
- En ambos casos, el espacio debe estar sin archivar.

La migración `0026_align_personal_space_financial_context` corrigió el país y la
moneda de un espacio personal usando su contexto financiero como fuente. Quedó
registrada con ID 27 y hash coincidente. Antes había una inconsistencia; después,
cero. Se compararon los hashes del contenido completo de movimientos y cuentas
antes/después: no cambiaron (21 movimientos y 4 cuentas en la base).

La lectura de snapshot contra Neon para la cuenta afectada devuelve ahora:

```json
{"profileCountry":"VE","defaultCurrency":"USD","activeContextCountry":"VE","activeContextCurrency":"USD","personalSpaceCurrency":"USD","spaces":1,"transactions":11,"moneyAccounts":1,"hasActivePersonal":true}
```

Verificaciones:

- `npm run typecheck`: correcto.
- `npm test`: 255 tests, 32 archivos aprobados.
- Integración Neon: 8 tests aprobados en `bootstrap-schema.test.ts` y
  `country-membership.test.ts`. Incluyen metadatos personales desalineados,
  repetición de bootstrap, recuperación de movimientos, exclusión de otros
  contextos/cuentas y regresiones de expulsión de compartidos.
- Migración y publicación por los scripts oficiales del repositorio.
- Prueba HTTP con nuevas sesiones autenticadas, alternando fixtures A → B → A:
  A devuelve 1 espacio, 1 movimiento y VE/USD; B devuelve 1 espacio, 0 movimientos
  y moneda EUR; al volver a A se recuperan su movimiento y VE/USD.
  CF-Ray de snapshots: `a3819b327dc71529-MAD`, `a3819b39dcb91529-MAD`,
  `a3819b421dd11529-MAD`. Todas las respuestas fueron 200.
- `/health/db`: 200 `{"status":"ok","database":"connected"}`,
  CF-Ray `a3819b452a550d72-MAD`.
- Membresías compartidas activas incompatibles después de publicar: cero.

La inspección de la cuenta real fue de lectura; no se usaron sus credenciales.
Las sesiones de prueba pertenecían a fixtures temporales eliminadas al terminar.
No se modificó el frontend ni se probó físicamente el teléfono; el siguiente
reintento de restauración debe consumir el snapshot corregido.
