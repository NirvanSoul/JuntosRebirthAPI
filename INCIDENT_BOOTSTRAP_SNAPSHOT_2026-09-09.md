# Incidente bootstrap y snapshot — 9 de septiembre de 2026

Corregido y verificado en producción a las 00:46:56 Europe/Madrid (2026-09-08 22:46:56 UTC). No se modificó el frontend ni su contrato.

## Causas comprobadas

1. `bootstrapAccount` leía `country_code` y `default_currency` desde el CTE `new_space`, cuyo `RETURNING` solo incluía `id`. Esto producía PostgreSQL `42703` aun con el esquema migrado. Se devuelven `id, country_code, currency` y se usa esa moneda al crear el contexto.
2. El contexto activo de un perfil nuevo se intentaba asignar mediante una segunda actualización de la misma fila dentro de otra CTE. Ahora el espacio y su contexto se asignan juntos; la recuperación del puntero activo queda limitada a perfiles con espacio previo.
3. `buildSnapshot` seleccionaba y filtraba columnas de `user_profiles` sin unir esa tabla. Drizzle rechazaba la consulta antes de enviarla a PostgreSQL, causando el `500`. Se añadió el `LEFT JOIN` por usuario de la membresía.

Un `503 DATABASE_SCHEMA_OUTDATED` no prueba por sí solo que falten migraciones: también puede proceder de una columna omitida en una consulta. Un `500` de snapshot tampoco prueba una revisión antigua: el error de construcción de consulta no contiene un SQLSTATE de esquema. `/health/db` comprueba conectividad y objetos de esquema, pero no ejecuta bootstrap ni snapshot.

## Neon y migraciones

Se consultó `drizzle.__drizzle_migrations`: 25 registros, correspondientes a `0000`–`0024`. No había migraciones pendientes y no se añadieron migraciones para corregir errores de consulta.

| Migración | Registro | Hash |
| --- | --- | --- |
| `0019_add_country_code` | 20 | Coincide con SQL actual |
| `0020_venezuela_exchange_rates` | 21 | Coincide con SQL actual |
| `0021_space_country_code` | 22 | Coincide con SQL original anterior a `fbc951d` |
| `0022_venezuela_accounting_usd` | 23 | Coincide con SQL original anterior a `fbc951d` |
| `0023_financial_contexts` | 24 | Coincide con SQL actual |
| `0024_repair_user_profile_country_code` | 25 | Coincide con SQL actual |

Los hashes de `0000`–`0020`, `0023` y `0024` coinciden con los archivos actuales. En `0021` y `0022`, el commit `fbc951d751a3956fd9df636ab3b7b4c8898b9c68` añadió posteriormente `IF NOT EXISTS`; se verificaron los hashes originales con Git, sin alterar el registro de migraciones.

Se verificó la existencia de `user_profiles.country_code`, `user_profiles.active_financial_context_id`, `spaces.country_code`, `transactions.accounting_amount_minor_usd`, `transaction_reference_rates.custom_rate_id` y las columnas de `financial_contexts` y `custom_exchange_rates`.

## Flujo ejecutado y versión

```text
npm ci
npm run db:migrate:production
Database migrations are current.

npm run deploy:production
  npm run db:migrate:production
  Database migrations are current.
  npm run deploy:worker
Deployed juntosapi triggers (5.66 sec)
  api.aoraestudio.com (custom domain)
  schedule: 0 * * * *
Current Version ID: cb32737e-5059-48e4-be5e-fe2477877578
```

La publicación se hizo mediante el script oficial, que aplica las migraciones antes de invocar Wrangler. Código base: `4f5a67a02d637be71b956178b1d27620dea7f3f8`, con las correcciones locales de `src/services/account.ts` y `src/services/sync-snapshot.ts`. Los cambios quedan disponibles en el workspace, sin commit nuevo.

## Verificaciones finales reales

Se creó una fixture temporal con `email_verified=true`, se inició sesión mediante `/api/auth/sign-in/email` y se comprobó `/api/auth/get-session`. Se utilizaron las cookies emitidas por producción. Esta prueba valida sesión y rutas de datos; no valida entrega de OTP. Al terminar se eliminaron exclusivamente el usuario, sus credenciales, sesión y espacios de prueba.

| Petición | HTTP | CF-Ray |
| --- | --- | --- |
| `POST /api/auth/sign-in/email` | 200 | `a3817df06b0d03c7-MAD` |
| `GET /api/auth/get-session` | 200 | `a3817df40b7a03c7-MAD` |
| `POST /v1/bootstrap` | 200 | `a3817df4ad1103c7-MAD` |
| Repetición de `POST /v1/bootstrap` | 200 | `a3817df6fb3b03c7-MAD` |
| `GET /v1/sync/snapshot` | 200 | `a3817df9c9a503c7-MAD` |
| `GET /health/db` | 200 | `a3817dfc4af4ec91-MAD` |

Cuerpo enviado a bootstrap, sin cambios de contrato:

```json
{"timezone":"Europe/Madrid"}
```

La primera respuesta indicó `created: {"profile":true,"personalSpace":true}`; la segunda, `created: {"profile":false,"personalSpace":false}`. Ambas devolvieron el mismo espacio y contexto activo, con moneda `EUR` y zona `Europe/Madrid`. Snapshot devolvió ese contexto, un espacio, un miembro y 18 categorías.

Salida de salud (cabeceras relevantes):

```text
HTTP/2 200
date: Tue, 08 Sep 2026 22:46:56 GMT
content-type: application/json
cf-ray: a3817dfc4af4ec91-MAD

{"status":"ok","database":"connected"}
```

## Logs y tests

Antes de corregir el código, se reprodujo el fallo con una sesión de prueba en producción (`CF-Ray: a3817a29ced3756e-MAD`). Cloudflare registró:

```json
{"operation":"account.bootstrap","errorName":"Error","databaseCodes":["42703"],"databaseIdentifiers":["country_code"],"schemaOutdated":true}
```

La prueba de integración también reprodujo el error de Drizzle de snapshot: `user_profiles` no formaba parte de la consulta. Después de la corrección, el tail de Cloudflare filtrado a las peticiones de prueba mostró las dos peticiones de bootstrap y snapshot como `Ok`, sin logs de error; los clientes confirmaron HTTP 200.

Los mensajes históricos del dispositivo aportados por el usuario no incluyen requestId ni fecha del incidente. No se atribuyen estos logs nuevos a aquellas peticiones ni se afirma haber recuperado logs históricos de Neon. La reproducción actual y las pruebas contra PostgreSQL identificaron los dos errores funcionales.

```text
npm run typecheck
tsc --noEmit — exit 0

npm test
Test Files  32 passed (32)
Tests       254 passed (254)

npm run test:integration -- test/integration/bootstrap-schema.test.ts
Test Files  1 passed (1)
Tests       2 passed (2)
```

La suite unitaria incluye health, account y sync. La nueva integración usa Neon real y cubre país inicial nulo y ES, contexto activo en el primer bootstrap, idempotencia, snapshot y recuperación del puntero activo. Su limpieza se limita a las fixtures creadas por ese archivo. No se ejecutó toda la suite de integración.

`src/routes/sync.ts` conserva `databaseErrorResponse(c, error)`. Se añadieron regresiones de ruta para errores `42P01` y `42703` envueltos por Drizzle: HTTP 503, `DATABASE_SCHEMA_OUTDATED` y `Retry-After: 60`; los errores no relacionados conservan HTTP 500 sin filtrar detalles privados.
