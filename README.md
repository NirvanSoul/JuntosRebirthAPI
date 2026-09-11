# Juntoss API

Backend independiente para **Juntoss** construido sobre **Cloudflare Workers**, **Hono** y **TypeScript**.

## Estado

El backend está desplegado en Cloudflare Workers y usa Neon (PostgreSQL), Better
Auth, Resend y R2. El estado por módulo, contrato de sincronización y trabajo de
coordinación con el frontend están en [JUNTOSS_API_PROGRESS.md](JUNTOSS_API_PROGRESS.md).

Las únicas funciones de backend diferidas son Apple Sign In y realtime para
espacios compartidos. No se deben confundir con las pruebas E2E pendientes de la
app o de un dispositivo físico.

## Estructura del proyecto

```text
juntoss-api/
├── src/
│   ├── index.ts
│   ├── db/
│   ├── middleware/
│   ├── routes/
│   └── services/
├── test/
│   └── health.test.ts
├── wrangler.jsonc
├── package.json
├── tsconfig.json
├── .gitignore
├── .dev.vars.example
└── README.md
```

## Desarrollo local

1. **Instalar dependencias:**
   ```bash
   npm install
   ```

2. **Ejecutar en modo desarrollo:**
   ```bash
   npm run dev
   ```

3. **Verificar endpoint de salud:**
   ```bash
   curl http://localhost:8787/health
   ```
   Respuesta esperada:
   ```json
   {
     "status": "ok",
     "service": "juntoss-api"
   }
   ```

## Verificación de tipos y tests

- **Chequeo de tipos (TypeScript):**
  ```bash
  npm run typecheck
  ```

- **Tests unitarios:**
  ```bash
  npm test
  ```

- **Tests de integración contra PostgreSQL real:**
  ```bash
  npm run test:integration
  ```

  Requiere `DATABASE_URL` en `.dev.vars`; no se ejecuta como parte de la suite
  unitaria para evitar tocar una base remota accidentalmente.

## Despliegue en Cloudflare Workers

Para producción, define `DATABASE_URL` en el entorno de CI o en la terminal y
usa el comando de proyecto. Tanto `deploy` como `deploy:production` aplican
las migraciones antes de publicar el Worker; no ejecutes `wrangler deploy`
directamente, porque omite ese paso:

```bash
npm run deploy:production
```

## Cambio de país y espacios compartidos

`PATCH /v1/me/profile` con `countryCode` cambia el contexto personal y da de
baja las membresías compartidas cuyo país no coincide. La respuesta existente
`data.leftSharedSpaceIds` contiene los IDs abandonados para retirar su caché
local. Lista de espacios, snapshot y acceso por ID exigen el mismo país para
los compartidos; un país sin definir solo coincide con otro sin definir.
El espacio personal se selecciona por `user_profiles.personal_space_id`, para
restaurar únicamente el contexto activo aunque sus metadatos históricos estén
desalineados. La migración `0026` alinea su país y moneda con `financial_contexts`
sin convertir ni modificar movimientos.

Volver al país anterior recupera el contexto personal, pero no readmite al
usuario en espacios compartidos: requiere una nueva invitación. Si sale el
último propietario, se promueve un miembro compatible (administrador primero);
si no queda ninguno, se archiva el espacio. El historial financiero se conserva.

La migración `0025_leave_shared_spaces_on_country_change` aplica la baja dentro
de la misma transacción del cambio de perfil, impide reactivar membresías de
otro país y repara las incompatibilidades históricas. Debe aplicarse mediante
el flujo de despliegue oficial antes de publicar el Worker.

## Sincronización de tasas Venezuela

`POST /v1/exchange/preview` devuelve USD cuando la entrada es VES, y VES cuando
la entrada es USD, tanto para `BCV` como para `EURO`. Cada referencia se aplica
directamente al importe de entrada: se divide para VES → USD y se multiplica
para USD → VES. En este preview, `EURO` identifica la referencia elegida para
valorar USD/VES. `/v1/exchange/rates` conserva `EUR/VES` como origen de esa tasa.

`POST /v1/spaces/:spaceId/sync` admite `customRateId?: string | null` solamente
dentro de cada objeto de `transactions`. El cliente nunca debe incluir una
tasa, importe convertido, fuente ni `exchangeSnapshot`: esos campos se rechazan
porque el servidor calcula y congela la equivalencia.

Para un usuario cuyo `countryCode` sea `VE`, una transacción en `USD` o `VES`
creada por sync guarda referencias `BCV` y `EURO`; añade `CUSTOM` únicamente
si el `customRateId` pertenece a la persona autenticada. Si no hay una tasa
oficial disponible, el batch responde `VENEZUELA_RATES_UNAVAILABLE` (502) y
no aplica el movimiento: no se fabrican ni se persisten importes contables
incompletos. Una tasa personalizada ajena o inexistente devuelve
`CUSTOM_RATE_NOT_FOUND` y tampoco se aplica el batch.

En espacios `VE`, cada `moneyAccounts` del sync debe llevar `currency: "USD"`
y exactamente un balance `USD`; otro formato devuelve
`VE_ACCOUNT_MULTI_CURRENCY_NOT_ALLOWED` (409). Los movimientos nuevos solo
aceptan `USD` o `VES`.

En actualizaciones, solo `amountMinor`, `currency`, `occurredOn` o un
`customRateId` explícito regeneran el snapshot. El resto de cambios conserva la
equivalencia histórica. La respuesta conserva los conteos previos y, cuando se
procesan movimientos, añade:

```json
{
  "transactions": [{
    "localId": "local-transaction-id",
    "remoteId": "uuid",
    "updatedAt": "2026-09-04T12:00:00.000Z",
    "accountingAmountMinorUsd": "20000",
    "exchangeSnapshot": {
      "countryCode": "VE",
      "createdWithCurrency": "VES",
      "rates": {
        "BCV": {
          "baseCurrency": "USD",
          "quoteCurrency": "VES",
          "rate": "50.0000000000",
          "convertedAmountMinor": "20000",
          "convertedCurrency": "USD",
          "observedAt": "2026-09-04T04:00:00.000Z"
        }
      }
    }
  }]
}
```

`GET /v1/sync/snapshot` devuelve la misma forma bajo cada transacción, incluido
`accountingAmountMinorUsd`. Los importes de la transacción y de las tasas se
serializan siempre como strings de unidades menores; `convertedCurrency` indica
la moneda exacta de cada `convertedAmountMinor`. Movimientos legacy sin
referencias devuelven
`exchangeSnapshot: null`.


## Sincronización incremental (`GET /v1/sync/changes`)

`GET /v1/sync/changes?since=<ISO>` devuelve los cambios ocurridos en el servidor desde el timestamp indicado en `since`.

- **Cursor del servidor**: `server_updated_at` es un reloj asignado por la base de datos (mantenido por triggers en Postgres) y nunca lo envía el cliente. Por el contrario, `updated_at` es el reloj local del cliente (usado para resolución Last-Write-Wins en `/v1/spaces/:id/sync`).
- **Regla de solape**: El lector aplica `server_updated_at > since - 60s` para evitar que transacciones concurrentes omitan filas. Las inserciones/actualizaciones en el cliente son idempotentes.
- **Espacios completos**: `spaces` se devuelve siempre completo para que el cliente valide si hubo cambios de membresía, país o contexto financiero.
- **Colecciones delta**: Las 4 colecciones (`categories`, `moneyAccounts`, `recurringSeries`, `transactions`) solo incluyen filas con `server_updated_at` posterior al umbral con solape. Las tablas hijas (`category_budgets`, `money_account_balances`, `transaction_reference_rates`) solo se leen para los padres que cambiaron.
- **Cursor de retorno**: La respuesta incluye `serverTime` (reloj de la base) para ser utilizado en el siguiente ciclo.
