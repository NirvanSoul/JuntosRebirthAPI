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
usa el comando que aplica migraciones antes de publicar el Worker:

```bash
npm run deploy:production
```

## Sincronización de tasas Venezuela

`POST /v1/spaces/:spaceId/sync` admite `customRateId?: string | null` solamente
dentro de cada objeto de `transactions`. El cliente nunca debe incluir una
tasa, importe convertido, fuente ni `exchangeSnapshot`: esos campos se rechazan
porque el servidor calcula y congela la equivalencia.

Para un usuario cuyo `countryCode` sea `VE`, una transacción en `USD` o `VES`
creada por sync guarda referencias `BCV` y `EURO`; añade `CUSTOM` únicamente
si el `customRateId` pertenece a la persona autenticada. Si no hay una tasa
oficial disponible, el movimiento se guarda sin snapshot (`null`), sin fabricar
valores. Una tasa personalizada ajena o inexistente devuelve
`CUSTOM_RATE_NOT_FOUND` y no se aplica el batch.

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
    "exchangeSnapshot": {
      "countryCode": "VE",
      "createdWithCurrency": "VES",
      "rates": {
        "BCV": {
          "baseCurrency": "USD",
          "quoteCurrency": "VES",
          "rate": "50.0000000000",
          "convertedAmountMinor": "20000",
          "observedAt": "2026-09-04T04:00:00.000Z"
        }
      }
    }
  }]
}
```

`GET /v1/sync/snapshot` devuelve la misma forma bajo cada transacción. Los
importes de la transacción y de las tasas se serializan siempre como strings de
unidades menores; movimientos legacy sin referencias devuelven
`exchangeSnapshot: null`.
