# Juntoss API — progreso de migración

Este documento mantiene el estado de ejecución del plan maestro compartido el 29 de agosto de 2026. No sustituye el plan; registra decisiones y entregables verificables.

## Alcance actual

- [x] Preparación: revisar el esquema y los contratos remotos existentes.
- [x] Fase A: bootstrap de cuenta. La migración se aplicó y se verificó en Neon el 29-08-2026.
- [x] Fase B: `/v1/me` y perfil. Verificado mediante typecheck y pruebas de contrato.
- [x] Fase C: auditoría de paridad del ledger remoto — ver `FASE_C_AUDIT.md`.
- [ ] Fase F: migración guest → cuenta — en curso; contrato local identificado en `Juntos Rebirth/src/features/sync/types.ts`.
- [ ] Fases D–L: fuera de alcance hasta cerrar y revisar A–C.

## Decisiones registradas

- El espacio personal inicial se identifica con `user_profiles.personal_space_id`, no mediante `spaces.created_by` y `type`.
- La creación y el *claim* del espacio se harán con un CTE atómico de PostgreSQL, porque el driver Neon HTTP no ofrece transacciones interactivas.
- Las categorías iniciales canónicas se copiaron de la definición existente en el frontend y pasan a ser propiedad del backend.

## Próximo hito

El Worker con bootstrap/perfil está desplegado en producción. Queda probar el bootstrap contra una sesión Google real y decidir el contrato de `note` y de recurrencias custom antes de iniciar Fase D o F.
