# Fase C — auditoría de paridad local/remota

Revisado contra el SQLite de `Juntos Rebirth` y los contratos actuales de Juntoss API. Esta fase es una auditoría: no modifica el esquema financiero.

| Campo/local | Remoto actual | ¿Compatible? | Acción requerida |
| --- | --- | --- | --- |
| `id`, `spaceId`, `categoryId`, `createdBy` | `id`, `spaceId`, `categoryId`, `createdBy` | Sí | Ninguna. |
| `type`, `amountMinor`, `currency`, `title`, `occurredOn` | Mismos campos | Sí | Ninguna. Los importes se serializan como string para no perder precisión. |
| `moneyAccountId` opcional | `moneyAccountId` opcional | Sí | La API valida que cuenta, categoría y moneda pertenezcan al espacio. |
| `recurrence` (`once`, semanal, etc.) | `recurrenceSeriesId` + recurso `recurring_transaction_series` | Parcial | El adaptador del frontend debe reconstruir el tipo a partir de la serie; una transacción aislada equivale a `once`. |
| `recurrenceSeriesId` | `recurrenceSeriesId` | Sí | Ninguna. |
| `recurrenceGroupId` (agrupación de ocurrencias personalizadas) | No existe | No | Definir si las fechas custom deben persistirse como serie/ocurrencias remotas o añadir un identificador de grupo. No añadir columna aún. |
| `note` | No existe | No | Es el único campo de detalle de movimiento local que se perdería. Decidir contrato (`note` o `memo`) antes de migración/restauración. |
| `sourceTransactionId` | No existe | No para guest/copia entre espacios | Resolver dentro del diseño de Fase F mediante `guest_entity_links`; no es necesario como campo de ledger remoto si el enlace satisface la trazabilidad. |
| Metadatos de comercio | Están en importación, no en el `Transaction` local principal | Sí para ledger | Mantenerlos en el módulo de importación de Fase J; no añadirlos a transacciones ahora. |
| Adjuntos | No aparecen en el modelo local actual | Sí | Sin acción. Si se habilitan, diseñar R2/metadata en una fase posterior. |
| Saldo inicial local | `money_account_balances.opening_balance_minor` | Sí | Mantener el modelo actual: no convertirlo automáticamente en una transacción. |
| Categoría `budgetMinor` local | `category_budgets` por moneda | Parcial | El frontend debe adaptar el presupuesto singular histórico a la colección de presupuestos por moneda. |

## Conclusión

Las rutas existentes permiten restaurar espacios, categorías, cuentas, balances, movimientos y recurrencias. Antes de prometer paridad completa con SQLite o diseñar guest migration deben cerrarse `note` y la semántica de recurrencias custom/`recurrenceGroupId`. No se detectó un requisito de adjuntos o merchant metadata dentro del ledger actual.
