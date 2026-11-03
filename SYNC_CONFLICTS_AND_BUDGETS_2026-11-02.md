# Conflictos de sync, presupuestos con periodicidad y despliegue (2026-11-02)

Encargo: `BACKEND.md`. Nada de esto se ha desplegado ni migrado en producción.
Producción **no** se ha consultado: todo lo que sigue sobre su estado es un
procedimiento para comprobarlo, no un hallazgo.

## 1. Qué fallaba y cómo se demostró

Reproducido con PostgreSQL 17 real (local y efímero, ver README) y datos
ficticios en `test/integration/sync-conflicts.test.ts`. Antes del arreglo
fallaban 10 de 15 pruebas, entre ellas:

| Escenario | Antes | Después |
| --- | --- | --- |
| Cuenta T2 saldo 200, llega T1 saldo 100 | padre T2, saldo **100** | padre T2, saldo 200, `conflicts` |
| Categoría T2 con presupuestos EUR(custom)+USD, llega T1 solo EUR | solo EUR 100 | intactos |
| Cliente legacy `budgetMinor` con T1 | cambiaba el importe | intacto |
| Movimiento VE T2, llega T1 con otro importe | tasas sustituidas; respuesta con valores T1 | tasas e importe T2; respuesta `applied:false` con valores canónicos |
| Dos pushes concurrentes viejo/nuevo (12 rondas) | saldo/presupuesto del viejo con padre del nuevo | siempre el nuevo |
| Pushes VE concurrentes | importe 202 con tasas de 101 | coherentes |
| Versión vieja tras un cursor posterior | el emisor nunca recibía la canónica | vuelve a llegar por `/changes` |

Una prueba adicional intercala de forma determinista otra escritura entre la
lectura previa y el batch (`refreezes rates when another device changes the
amount...`); falla si se desactiva la guarda monetaria y pasa con ella.

## 2. Diseño del arreglo (`src/services/space-sync.ts`)

- El upsert de cada padre lleva `RETURNING id`: devuelve fila solo si aplicó
  la versión. Esa es la decisión, tomada dentro de la transacción del batch.
- `ON CONFLICT DO UPDATE` bloquea la fila aunque su `WHERE` la descarte; las
  sentencias de hijos que vienen después en el mismo batch se condicionan con
  `versionIsCurrent` (`EXISTS` padre con ese `id`, ese `space_id` y ese
  `updated_at`). No dependen de ninguna lectura previa.
- Hijos: `DELETE ... WHERE ... AND <vigente>` e `INSERT ... SELECT ... FROM
  (VALUES ...) WHERE <vigente>` (`insertWhen`, con tipos de columna del esquema).
- Movimientos que conservan tasas: su upsert exige además que importe, moneda
  y fecha guardados sigan iguales; si otra petición los cambió, se reintenta
  solo ese movimiento (máx. 3 intentos, luego `409 SYNC_CONCURRENT_UPDATE`).
- Versión descartada: `conflicts[]` + toque de `server_updated_at` (sin tocar
  `updated_at`) para republicar la canónica.
- Sin cambios: validación de espacio previa (`ENTITY_BELONGS_TO_ANOTHER_SPACE`),
  idempotencia por `(espacio, instalación, id local)` y alias.

Contrato completo: README, sección «Conflictos en `POST /v1/spaces/:spaceId/sync`».

## 3. Presupuestos y migraciones 0033/0034

- `0033_category_budget_periods`: añade `period` (default `month`),
  `interval_days`, `anchor_on`, `overrides` (default `[]`) y el CHECK
  `category_budgets_period_valid`. `0034_category_budget_history`: `history`
  (default `[]`). Todo aditivo: las filas existentes quedan `month` sin
  excepciones y cumplen el CHECK.
- Journal verificado: 35 entradas, `idx` consecutivos, `when` crecientes
  (0032 < 0033 < 0034), sin SQL huérfano. Las 35 se aplican en orden con el
  migrador de producción (`drizzle-orm/neon-http/migrator`) en cada ejecución
  de la integración local.
- Escritura, snapshot y delta preservan los cinco campos (pruebas unitarias y
  `restores the accepted budget on another device through snapshot and changes`).
- Compatibilidad: entradas sin campos de periodicidad y `budgetMinor` solo
  cambian el importe (antes, un cliente intermedio restablecía la
  periodicidad a mensual).

## 4. Comparar producción con el contrato (solo lectura, por quien tenga acceso)

1. Versión del Worker desplegada: `npx wrangler deployments list` y comparar el
   commit con `origin/main`.
2. Migraciones aplicadas:
   ```sql
   SELECT count(*), max(created_at) FROM drizzle.__drizzle_migrations;  -- se esperan 35 tras desplegar
   SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'category_budgets'
    ORDER BY ordinal_position;                                           -- period … history
   ```
3. `GET /health/db` → `schema_outdated` si falta `category_budgets.history`.

Con el `origin/main` revisado (`b67e68e`), la API ignora `period`,
`intervalDays`, `anchorOn`, `overrides` e `history` (no los rechaza ni los
guarda) y su snapshot no los devuelve.

## 5. Orden de despliegue

1. Revisión y merge de estas unidades.
2. Punto de recuperación: crear una rama Neon de la base de producción
   (instantánea) justo antes de migrar.
3. `npm run deploy:production` (aplica 0033 → 0034 y después publica el
   Worker; nunca `wrangler deploy` solo). `ADD COLUMN` con default constante
   es solo de metadatos; el `ADD CONSTRAINT CHECK` recorre `category_budgets`
   con un bloqueo breve.
4. Verificar `/health/db`, un `POST /sync` de prueba con una cuenta ficticia y
   `GET /v1/sync/changes`.

Ventanas de compatibilidad:

| Combinación | Resultado |
| --- | --- |
| Worker viejo + esquema nuevo (entre pasos 3a y 3b) | funciona; el Worker viejo reescribe presupuestos con defaults mensuales si recibe uno |
| Worker nuevo + esquema viejo | snapshot/changes/sync responden `503 DATABASE_SCHEMA_OUTDATED`; por eso migrar primero |
| App antigua + Worker nuevo | sin cambios de significado: campos nuevos aditivos, `budgetMinor` y `budgets` sin periodicidad conservan la periodicidad |
| App nueva + Worker viejo | la periodicidad se pierde en el servidor y vuelve como mensual por snapshot/changes: no publicar la app con presupuestos por periodo antes que este Worker |

## 6. Recuperación sin borrar datos

- Worker: `npx wrangler rollback` al despliegue anterior. Las columnas nuevas
  quedan sin usar; no se pierden datos salvo la periodicidad de presupuestos
  que el Worker viejo reescriba mientras esté activo.
- Esquema: **no** revertir 0033/0034 con `DROP COLUMN`; son aditivas y
  compatibles con el Worker anterior. Si hiciera falta, desactivar el CHECK
  (`ALTER TABLE category_budgets DROP CONSTRAINT category_budgets_period_valid`)
  es reversible y no borra datos.
- Datos: la rama Neon del paso 2 permite comparar o restaurar filas concretas.

## 7. Logs

`src/routes/sync.ts` ya no imprime `message`, `detail`, `hint` ni `where`;
`/health/db` no registra el error de conexión. `logFailure` sustituye a los
`console.error(..., error)` de todas las rutas y servicios. Pruebas con errores
ficticios que contienen credenciales, tokens, cookies, correo e importes
(`test/log.test.ts`) comprueban logs y respuestas. Retención y acceso a logs
de Cloudflare no se revisaron (requiere el panel de la cuenta).

## 8. Segunda ronda (2026-11-03): interbloqueos y rutas REST

Cada punto se reprodujo primero con una prueba que fallaba contra el código
anterior (PostgreSQL 17 local, datos ficticios).

| Problema | Antes | Después |
| --- | --- | --- |
| Dos pushes del mismo espacio con las mismas filas en orden inverso | `40P01 deadlock detected` en 25 de 25 rondas → 500 | bloqueo consultivo por espacio al inicio del batch: 0 de 25 |
| Interbloqueo o fallo de serialización residual (`40P01`/`40001`) | 500 | el servicio repite el batch una vez (no se confirmó nada); si persiste, `409 SYNC_CONCURRENT_UPDATE` |
| `PUT/DELETE .../categories/:id/budgets/:currency` | no salía por `/changes`; un push posterior con la versión anterior lo pisaba | avanza la versión de la categoría en el mismo batch |
| `PUT/DELETE .../money-accounts/:id/balances/:currency` | igual que presupuestos | igual: avanza la versión de la cuenta |
| `POST .../transactions` en VE si fallan las tasas | movimiento con equivalencia USD y sin tasas | movimiento y tasas en un batch: o todo o nada |
| `PATCH .../transactions/:id` con cambio de importe si fallan las tasas | importe nuevo, tasas viejas borradas | intacto |
| `PATCH` con importe cambiado por otro entre la lectura y la escritura | tasas de un importe que ya no es el vigente | el UPDATE exige el importe/moneda leídos; si no, relee (3 intentos) y luego `409 SYNC_CONCURRENT_UPDATE` |

Diseño: `src/db/versioned-writes.ts` reúne lo que comparten sync y REST
(`spaceWriteLock`/`spaceWriteLockOf`, `versionIsCurrent`, `insertWhen`,
`bumpVersion`). Toda escritura de padre+hijos toma primero el bloqueo del
espacio, así que sync y REST del mismo espacio se serializan y no pueden
cruzarse. La clave se normaliza en SQL (`uuid::text`) para que coincida venga
del id del espacio o de la fila del padre. Es un bloqueo de transacción: vale
con el pooler de Neon en modo transacción y se libera en commit/rollback.

Pruebas nuevas: `sync-conflicts` (orden inverso), `category-budgets-rest`,
`balances-rest`, `transactions-rest` (fallo inyectado con un trigger temporal
que rechaza las tasas) y unitarias del reintento y del 409.

## 9. Tercera ronda (2026-11-03): recurrencias, importación, miembros y cuentas

Mismo método: prueba que falla con el código anterior, arreglo, prueba en verde.

| Problema | Antes | Después |
| --- | --- | --- |
| El motor encuentra ya el movimiento de esa fecha (la app lo materializó y subió, o un push rebobinó el contador) | choque con `transactions_series_occurred_on_idx`; la serie fallaba en cada ejecución y no avanzaba nunca | avanza y, si es personalizada, enlaza la ocurrencia con ese movimiento (`existingTransactions`) |
| Movimientos generados por el motor en Venezuela | sin `accounting_amount_minor_usd` ni tasas: fuera de los totales USD | equivalencia y tasas congeladas en la misma transacción; sin tasas, la serie se aplaza (`deferredSeries`) en vez de crear un movimiento incompleto |
| Motor frente a sync/REST del mismo espacio | sin coordinación | cada reclamación toma el bloqueo del espacio |
| Añadir/editar una ocurrencia personalizada mientras corre el motor | la ruta leía la siguiente fecha y la escribía después: la serie quedaba apuntando a una ocurrencia ya generada, atascada para siempre | ocurrencia y fecha (calculada en SQL) en un batch con el bloqueo del espacio |
| Series ya atascadas por lo anterior | el motor no las movía | el motor las recoloca en su siguiente pendiente (`repairedSeries`) |
| Cambio de voto de comercio del último votante de una clave | el agregado de la clave vieja conservaba un usuario fantasma | se borra en la misma transacción |
| Votos simultáneos al mismo comercio | 6 votos → agregado de 1 | bloqueo por comercio: 6 → 6 |
| Lote de importación con un id que ya es de otro usuario | el lote se descartaba en silencio pero sus items se colgaban del lote ajeno | `400 INVALID_REQUEST`, nada escrito |
| Dos propietarios salen o se degradan a la vez | espacio con 0 propietarios | bloqueo de la fila del espacio: queda 1 |
| Salir del espacio mientras otro propietario cambia de país | no esperaba al bloqueo del cambio de país | espera la misma fila (`FOR NO KEY UPDATE`, que no frena los INSERT por FK) |
| El único propietario borra su cuenta o sus datos | la pareja quedaba como `member` de un espacio sin propietario | la propiedad pasa al siguiente (admin, luego el más antiguo), como en el cambio de país |

Notas:

- Los movimientos VE que el motor genera para fechas pasadas (puesta al día)
  usan las tasas vigentes al generarlos, igual que `POST /transactions` con
  una fecha pasada. El cron horario genera el mismo día, así que en uso normal
  coinciden.
- El resumen del cron añade `existingTransactions`, `repairedSeries` y
  `deferredSeries`. Un `deferredSeries` sostenido indica que faltan tasas VE.

## 10. Cuarta ronda (2026-11-03): tasas personalizadas, barrido de invitaciones

| Problema | Antes | Después |
| --- | --- | --- |
| Marcar como predeterminada una tasa CUSTOM inexistente o ajena | se desmarcaba la actual y la persona quedaba sin predeterminada | la actual solo se desmarca si la promovida existe y es suya |
| Crear varias tasas predeterminadas a la vez | dos predeterminadas | bloqueo por persona: siempre una |
| Barrido horario de invitaciones caducadas | borraba cualquier espacio de pareja no activado sin invitación pendiente, incluido uno recién creado cuyo segundo paso (invitar) aún no había llegado | solo borra los espacios cuyas invitaciones caducan en ese barrido, en la misma sentencia |
| `DELETE` de un saldo inexistente | avanzaba la versión de la cuenta y la republicaba sin cambios | solo la avanza si se borró algo (misma sentencia) |

Revisado sin cambios: aceptar/revocar/rechazar invitaciones a la vez (ya
serializan por la fila de la invitación), tokens push (el token es del
dispositivo y se reasigna), avatares (cualquier fallo a medias se recupera
reintentando) y el cursor de `/changes` (los nuevos bloqueos esperan mucho
menos que su ventana de 60 s).

## 11. Riesgos y pendientes

- No se ejecutó contra Neon remoto: la integración usó PostgreSQL 17 local con
  el mismo driver y semántica de batch transaccional. Repetirla con
  `DATABASE_URL_TEST` contra una rama Neon marcada antes de publicar.
- Las escrituras de un mismo espacio esperan turno (sync, REST, motor). Con
  lotes cortos no debería notarse; no se midió en Neon.
- "Una predeterminada por persona" depende del bloqueo, no de un índice único.
  Un índice parcial lo garantizaría en la base, pero antes habría que limpiar
  duplicados que la carrera anterior pudo dejar en producción: requiere mirar
  los datos y no se ha hecho.
- La comprobación de lote ajeno en importación es previa al batch: un lote
  ajeno creado justo entre la comprobación y el batch con el mismo UUID es
  teóricamente posible, pero exige adivinar un UUID aleatorio.
- Las rutas REST `PATCH` de categoría, cuenta, serie y movimiento fijan
  `updatedAt` con el reloj del Worker; si un cliente con el reloj adelantado
  dejó una versión "futura", la edición REST queda por detrás. La app no usa
  esas rutas.
- Los alias de instalación se escriben aunque la fila se descarte (identidad,
  no versión); un id de otro espacio sigue bloqueado por la validación previa.
- App: debe leer `applied`/`conflicts` para no marcar como sincronizadas las
  filas descartadas (ver `Juntos Rebirth/patch/APP.md`, nota del agente API).
