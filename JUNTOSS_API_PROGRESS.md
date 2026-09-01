# Juntoss API — progreso de migración

Estado de ejecución de la sustitución de Supabase por este backend. No sustituye
al plan maestro; registra decisiones y entregables verificables.

## Alcance actual

- [x] Preparación: revisión del esquema y de los contratos remotos existentes.
- [x] Fase A: bootstrap de cuenta. Verificado en Neon el 29-08-2026.
- [x] Fase B: `/v1/me` y perfil.
- [x] Fase C: auditoría de paridad del ledger — ver `FASE_C_AUDIT.md`. **Cerrada**:
      `note`, `recurrence`, `recurrence_group_id` y `source_local_transaction_id`
      forman ya parte del ledger remoto (migración `0010`).
- [x] Cimientos: registro único de códigos de error, validación compartida,
      cacheo por isolate del cliente Neon y de Better Auth, `onError`/`notFound`,
      CORS y `requireSpaceRole`.
- [x] Autenticación completa: email+contraseña, OTP de verificación y de
      restablecimiento, Google, y bloqueo por 9 intentos fallidos (`login_attempts`).
- [x] Sincronización masiva: `GET /v1/sync/snapshot` y
      `POST /v1/spaces/:spaceId/sync`.
- [x] Perfil y avatares en R2.
- [x] Legal, exportación de datos y borrado de cuenta.
- [x] Notificaciones push (tokens de Expo y envío en invitaciones).
- [x] Importación bancaria: lotes, items, reglas de comercio y votos.
- [x] Migraciones `0010`–`0014` aplicadas y verificadas en la rama principal de
      Neon el 30-08-2026 (15 en total registradas en `drizzle.__drizzle_migrations`).
- [x] Suite de integración contra PostgreSQL real (`npm run test:integration`):
      24 pruebas que cubren los CTE de SQL crudo de invitaciones, miembros,
      importaciones y recurrencias.
- [ ] Apple Sign In — diferido: el frontend no tiene botón de Apple.
- [ ] Realtime para espacios compartidos — el cliente ya usa polling y
      restauración al reabrir como respaldo.

## Decisiones registradas

- El espacio personal inicial se identifica con `user_profiles.personal_space_id`,
  no mediante `spaces.created_by` y `type`.
- La creación y el *claim* del espacio se hacen con un CTE atómico de PostgreSQL,
  porque el driver Neon HTTP no ofrece transacciones interactivas.
- Las categorías iniciales canónicas las posee el backend. `POST /v1/spaces`
  también las siembra: sin categorías un espacio no admite ni un movimiento.
- Un espacio `couple` nace con `activated_at = NULL` y solo se activa al aceptar
  la invitación. El cliente deriva de ahí su estado "esperando pareja".
- Las recurrencias personalizadas del cliente son N movimientos que comparten
  `recurrence_group_id`, sin serie. El ledger remoto las conserva tal cual.
- La identidad de sincronización es `(space_id, source_installation_id,
  source_local_id)`, igual que en la base anterior. El espacio personal se
  resuelve por su id local literal `"personal"`, no por esas columnas, para que
  dos instalaciones de la misma cuenta no se pisen.
- Los conflictos de sincronización se resuelven por última escritura, comparando
  `updated_at`.
- El rol solo se exige en operaciones estructurales del espacio. El ledger queda
  abierto a cualquier miembro activo: en un espacio de pareja el invitado entra
  como `member` y debe poder gestionar el dinero compartido.
- El país para la inteligencia de comercios se deriva de la región del locale del
  perfil; el cliente no lo envía.

---

# Estado de despliegue

**DEPLOYED: sí** — https://juntosapi.aora-estudio-o.workers.dev

| | |
| --- | --- |
| Version ID | `48e8b130-7afd-4362-a216-8679396ebc3a` |
| Commit base | `86baaa3` + árbol de trabajo sin commitear |
| Migraciones | 16 aplicadas (`0000`–`0015`), sin pendientes ni drift |
| Cron | `0 * * * *` (recurrencias + barrido de invitaciones) |
| Bindings | vars: `BETTER_AUTH_URL`, `RESEND_FROM`, `APP_URL`, `ENVIRONMENT` · secrets: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `RESEND_API_KEY` |
| R2 | `juntoss-avatars`, binding `AVATARS` activo |

Comprobación en vivo: `GET /health/config?email=1` (requiere sesión) informa de la
presencia de cada clave sin revelar ningún valor.

## Estado por módulo

Leyenda: ✅ hecho · ➖ no aplica · ❌ pendiente

| Módulo | Implementado | Desplegado | Unit | Integración | E2E real |
| --- | --- | --- | --- | --- | --- |
| auth (Google) | ✅ | ✅ | ✅ | ➖ | ✅ URL OAuth generada |
| auth (email+password) | ✅ | ✅ | ✅ | ➖ | ✅ alta y acceso |
| auth (OTP verificación/reset) | ✅ | ✅ | ✅ | ➖ | ❌ el código llega por correo |
| bloqueo por intentos | ✅ | ✅ | ✅ | ➖ | ✅ 9 fallos → 429 |
| bootstrap | ✅ | ✅ | ✅ | ✅ | ✅ idempotente |
| perfil (`/v1/me`) | ✅ | ✅ | ✅ | ✅ | ✅ |
| spaces | ✅ | ✅ | ✅ | ✅ | ✅ |
| members | ✅ | ✅ | ➖ | ✅ | ✅ roster |
| invitations | ✅ | ✅ | ➖ | ✅ | ✅ invitar/aceptar/rechazar/revocar |
| categories | ✅ | ✅ | ✅ | ✅ | ✅ |
| category_budgets | ✅ | ✅ | ✅ | ✅ | ❌ el cliente no los envía |
| money_accounts | ✅ | ✅ | ✅ | ✅ | ✅ |
| balances | ✅ | ✅ | ✅ | ✅ | ✅ 100000→75000→85000 |
| transactions | ✅ | ✅ | ✅ | ✅ | ✅ crear/editar/archivar |
| recurrences | ✅ | ✅ | ✅ | ✅ | ✅ mensual y custom |
| rates | ✅ | ✅ | ✅ | ➖ | ✅ |
| sync (snapshot + push) | ✅ | ✅ | ✅ | ✅ | ✅ snapshot |
| R2 avatars | ✅ | ✅ | ✅ | ➖ | ✅ subida, descarga y borrado |
| email (Resend) | ✅ | ✅ | ➖ | ➖ | ✅ entrega confirmada |
| push | ✅ | ✅ | ✅ | ➖ | ❌ requiere dispositivo |
| imports | ✅ | ✅ | ✅ | ✅ | ❌ requiere la app |
| legal / export / borrado | ✅ | ✅ | ✅ | ➖ | ✅ export y borrado |

## Contrato de sync pendiente en el frontend

El backend ya acepta y devuelve ambos; el cliente todavía no los manda.

**`transactions.note`** — en `POST /v1/spaces/:spaceId/sync`, dentro de cada fila
de `transactions`, junto a los campos que ya se envían:

```jsonc
{ "id": "<id local>", "remoteId": "<id remoto o el local>",
  "note": "texto o null",           // ← añadir a la SELECT de syncCoupleSpaceData
  "recurrence": "once|weekly|biweekly|monthly|custom",
  "recurrenceGroupId": "<id o null>",
  "sourceTransactionId": "<id o null>" }
```

Se devuelve igual en `GET /v1/sync/snapshot`, en camelCase.

**`category_budgets`** — hoy no salen nunca del dispositivo. Dos vías:

- inmediata: cada fila de `categories` admite `budgetMinor` (entero), que se
  guarda en la moneda del espacio;
- completa (recomendada): añadir `budgets: [{ currency, budgetAmountMinor }]` a
  cada categoría, que es lo que devuelve el snapshot y lo que soporta el modelo
  multi-divisa real.

## Auditoría de dependencias

9 vulnerabilidades (4 altas, 5 moderadas), **todas en herramientas de
desarrollo**: `wrangler` (sharp, undici, ws, esbuild) y `drizzle-kit`
(@esbuild-kit). Ninguna aparece en el bundle desplegado, verificado sobre el
artefacto de `wrangler deploy --dry-run`.

Los arreglos disponibles son mayores (`wrangler@4`, `drizzle-kit@0.18`) y se
dejan para una ventana propia. **No se ejecutó `npm audit fix --force` ni se
tocó Better Auth**: subirlo exige regenerar el esquema, comparar drift y revisar
migraciones.


## Pendiente de coordinar con el frontend

1. Sustituir `supabaseAuthGateway` y los servicios de login/registro/OTP/reset por
   `authClient` de Better Auth, y el `signOut()` de `SettingsScreen`.
2. Sustituir `fetchRemoteAccountSnapshot` por `GET /v1/sync/snapshot`. El snapshot
   viaja en camelCase con importes como string; el gateway antiguo leía snake_case
   para series y movimientos.
3. Sustituir `syncCoupleSpaceRemotely` por `POST /v1/spaces/:spaceId/sync`. El
   cuerpo es el mismo que ya construye `syncCoupleSpaceData`, sin `spaceId`.
4. Añadir `category_budgets` al push: hoy los presupuestos por moneda no salen
   nunca del dispositivo.
5. Mapear `ApiError.code` a los códigos que la UI ya distingue. En particular
   `INVITEE_NOT_REGISTERED` (invitar a alguien sin cuenta), `COUPLE_SPACE_LIMIT` y
   `ACCOUNT_LOCKED` (429 con `lockedUntil`, donde la edge function anterior
   devolvía `error: "locked"`).
6. Sustituir los cuatro gateways de importación por `/v1/sync/import-batches`,
   `/v1/sync/merchant-rules`, `/v1/sync/import-reviews` y `/v1/merchant-feedback`,
   que aceptan las mismas filas en snake_case que ya se enviaban a las RPC.
7. Sustituir el bucket `avatars` por `PUT /v1/me/avatar` y `GET /v1/avatars/:userId`.

## Bugs encontrados al desplegar y verificar en producción

Todos corregidos, desplegados y con prueba de regresión.

- **`/v1/rates/venezuela` nunca había funcionado.** Guardar el `fetch` global
  como propiedad de clase y llamarlo con `this.fetchFn(...)` le pasa el `this`
  equivocado y workerd lo rechaza con "Illegal invocation". Las pruebas
  unitarias no lo veían porque inyectan un doble. Mismo patrón corregido en
  `push.ts`.
- **`icon` y `colorToken` de una cuenta, documentados como opcionales,
  devolvían 400 al omitirse.** El helper confundía "ausente" con "tipo
  inválido". Barrido posterior sobre los 18 endpoints con cuerpo: era el único
  caso de esa clase.
- **`POST /v1/me/legal-acceptances` se tragaba los tipos inválidos** y guardaba
  `null`. Un registro de consentimiento que pierde en silencio la versión de la
  app o el locale no prueba qué aceptó la persona ni dónde.
- **`RESEND_API_KEY` estaba desplegado vacío**, porque `.dev.vars` tenía la
  clave duplicada: primero vacía, luego real.
- **El remitente era el sandbox de Resend**, que responde 200 y solo entrega al
  dueño de la cuenta. El dominio verificado es `aoraestudio.com`.
- **`generatedOccurrences` faltaba en `GET .../recurring-transactions`**, pese a
  estar en el snapshot y en el payload que envía el cliente.
- **La subida de avatar aceptaba cualquier secuencia de bytes** con
  `Content-Type: image/jpeg`, una cabecera que elige quien sube. Ahora se
  valida la estructura real del JPEG y sus dimensiones declaradas en el
  marcador SOF.

## Contrato de avatares

El servidor **valida y almacena**; la compresión la hace el cliente. Hacerla en
el Worker exigiría decodificar el JPEG en WASM, que no cabe en los 10 ms de CPU
por petición del plan gratuito, y además obligaría a subir el original completo
por datos móviles para tirarlo después.

### Subir

```http
PUT /v1/me/avatar
Content-Type: image/jpeg
Cookie: <sesión>

<bytes del JPEG>
```

```jsonc
// 200
{ "data": { "avatar": { "avatarPath": "<userId>/avatar.jpg",
                        "avatarUpdatedAt": "2026-08-30T10:14:38.971Z" } } }
```

`avatarUpdatedAt` sirve para invalidar la caché local: la clave en R2 es fija
(`{userId}/avatar.jpg`), así que subir de nuevo sobrescribe y la URL no cambia.

### Reglas que se comprueban

| Regla | Valor | Código si falla |
| --- | --- | --- |
| Es un JPEG de verdad | estructura verificada sobre los bytes, no por `Content-Type` | `AVATAR_INVALID_FORMAT` |
| Tamaño | ≤ 256 KiB | `AVATAR_TOO_LARGE` |
| Lado máximo | ≤ 1024 px | `AVATAR_TOO_LARGE` |
| Lado mínimo | ≥ 64 px | `AVATAR_TOO_SMALL` |

Los tres códigos son distintos a propósito: "recomprime la foto" y "esa no es
una imagen" necesitan copys distintos, y un mensaje de texto no es un contrato
sobre el que ramificar. Todos van con HTTP 400.

### Qué debe enviar el cliente

Comprimir a 512×512 con calidad 0.8 deja el fichero en 40–60 KiB, muy por
debajo del tope, y sube 50 KB en vez de varios megas:

```ts
import * as ImageManipulator from 'expo-image-manipulator';

const compressed = await ImageManipulator.manipulateAsync(
  uri,
  [{ resize: { width: 512, height: 512 } }],
  { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG },
);
```

### Descargar

```http
GET /v1/avatars/:userId
```

Devuelve los bytes con `Content-Type`, `ETag` y `Cache-Control: private, max-age=300`.
Autorizado solo para el propio usuario o para quien comparta con él un espacio
activo; en caso contrario `403`. Si no hay avatar, `404 NOT_FOUND`.

`GET /v1/spaces/:spaceId/members` ya devuelve `avatarPath` y `avatarUpdatedAt`
de cada miembro, que es lo que alimenta la caché `space_member_profiles` del
SQLite local.

### Borrar

`DELETE /v1/me/avatar` devuelve `204` y limpia tanto el objeto de R2 como las
columnas del perfil. El borrado completo de cuenta requiere el body explícito
`{ "confirmation": "DELETE_MY_ACCOUNT" }`; así una llamada accidental no puede
eliminar datos. `DELETE /v1/me` también elimina el objeto: el `ON DELETE CASCADE`
de PostgreSQL no alcanza a R2, así que se borra explícitamente antes de la cuenta.

## Bugs encontrados por la suite de integración

El motor de recurrencias **nunca había generado un solo movimiento**. Dos
defectos independientes, ambos invisibles porque el `catch` genérico los
contaba como `errors` sin registrar nada:

1. `claimRegular` referenciaba la tabla destino del `UPDATE` desde el `ON` de un
   `JOIN` de su `FROM`, que PostgreSQL rechaza (`42P01`). Fallaba siempre, para
   todas las series semanales, quincenales y mensuales.
2. `claimCustom` actualizaba dos veces la misma fila de
   `recurring_transaction_occurrences` dentro de una sola sentencia. Como los CTE
   comparten instantánea, el segundo `UPDATE` no veía al primero y no llegaba a
   aplicarse, así que la serie nunca avanzaba.

El mismo problema de instantánea afectaba al agregado de comercios, que contaba
el voto anterior en vez del recién escrito. Los tres están corregidos y cubiertos.

## Deuda conocida

- `listMoneyAccounts` trae una fila por cuenta × moneda × movimiento y suma en
  JavaScript. Correcto pero no escala; debe pasar a `SUM(...)` agrupado en SQL
  junto con una prueba de integración que verifique la aritmética.
- `exchange_rate_snapshots` y `transaction_reference_rates` siguen sin usarse.
  `/v1/rates/venezuela` vuelve a consultar el BCV en cada petición.
- Faltan `GET`/`PATCH`/`DELETE` de espacio y los `DELETE` de movimiento,
  categoría, cuenta y serie. El cliente no los usa hoy porque trabaja por lotes.
