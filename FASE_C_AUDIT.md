# Fase C — auditoría de paridad local/remota

Revisado contra el SQLite de `Juntos Rebirth` y los contratos actuales de Juntoss API. Esta fase es una auditoría: no modifica el esquema financiero.

| Campo/local | Remoto actual | ¿Compatible? | Acción requerida |
| --- | --- | --- | --- |
| `id`, `spaceId`, `categoryId`, `createdBy` | `id`, `spaceId`, `categoryId`, `createdBy` | Sí | Ninguna. |
| `type`, `amountMinor`, `currency`, `title`, `occurredOn` | Mismos campos | Sí | Ninguna. Los importes se serializan como string para no perder precisión. |
| `moneyAccountId` opcional | `moneyAccountId` opcional | Sí | La API valida que cuenta, categoría y moneda pertenezcan al espacio. |
| `recurrence` (`once`, semanal, etc.) | `recurrenceSeriesId` + recurso `recurring_transaction_series` | Parcial | El adaptador del frontend debe reconstruir el tipo a partir de la serie; una transacción aislada equivale a `once`. |
| `recurrenceSeriesId` | `recurrenceSeriesId` | Sí | Ninguna. |
| `recurrenceGroupId` (agrupación de ocurrencias personalizadas) | `transactions.recurrence_group_id` | Sí | **Resuelto** (migración `0010`). Las recurrencias personalizadas se guardan como N movimientos que comparten el grupo, igual que en el cliente; no se convierten en serie. |
| `note` | `transactions.note` | Sí | **Resuelto** (migración `0010`). El contrato es `note`. Falta que el cliente lo envíe: hoy el push no lo incluye y el restore lo escribe como `NULL`. |
| `sourceTransactionId` | `transactions.source_local_transaction_id` | Sí | **Resuelto** (migración `0010`), además del enlace en `guest_entity_links`. |
| Metadatos de comercio | Están en importación, no en el `Transaction` local principal | Sí para ledger | Mantenerlos en el módulo de importación de Fase J; no añadirlos a transacciones ahora. |
| Adjuntos | No aparecen en el modelo local actual | Sí | Sin acción. Si se habilitan, diseñar R2/metadata en una fase posterior. |
| Saldo inicial local | `money_account_balances.opening_balance_minor` | Sí | Mantener el modelo actual: no convertirlo automáticamente en una transacción. |
| Categoría `budgetMinor` local | `category_budgets` por moneda | Parcial | El frontend debe adaptar el presupuesto singular histórico a la colección de presupuestos por moneda. |

## Conclusión

**Auditoría cerrada.** Las dos preguntas abiertas — `note` y la semántica de las
recurrencias personalizadas — se resolvieron añadiendo `note`, `recurrence`,
`recurrence_group_id` y `source_local_transaction_id` al ledger remoto en la
migración `0010`. `GET /v1/sync/snapshot` los devuelve y tanto el guest migration
como el push por espacio los propagan.

Queda un único hueco de paridad, y está en el cliente, no en el esquema: el push
no envía `note` ni los `category_budgets` por moneda. Hasta que lo haga, ambos
siguen siendo datos locales que se pierden al cambiar de dispositivo.

No se detectó requisito de adjuntos ni de metadatos de comercio dentro del ledger.
