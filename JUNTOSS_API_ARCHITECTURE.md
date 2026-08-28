# Juntoss API — Architecture & Build Guide

> Documento estructural para los agentes de IA que trabajarán en el backend de Juntoss.
> Este archivo define **qué construir, por qué, cómo organizarlo y en qué orden**.
> No debe intentarse implementar todo de golpe.

---

## 1. Objetivo

Crear un backend independiente para **Juntoss**, desplegado en **Cloudflare Workers**, que actúe como única capa entre la aplicación móvil y los servicios externos.

La app móvil **no debe conectarse directamente** a PostgreSQL, Resend, Google, Apple ni a ningún proveedor con credenciales privadas.

Arquitectura objetivo:

```text
Juntoss App
React Native / Expo
        |
        | HTTPS
        v
Juntoss API
Cloudflare Workers + Hono + TypeScript
        |
        +------------------+------------------+
        |                  |                  |
        v                  v                  v
 Better Auth          PostgreSQL           Resend
 Google / Apple          Neon              Emails
        |
        v
 Sessions / Accounts
```

El backend debe ser reemplazable y desacoplado de los proveedores.

La aplicación móvil deberá hablar siempre con una URL controlada por Juntoss, por ejemplo:

```text
https://api.juntoss.app
```

---

## 2. Repositorios

Mantener el backend separado del frontend.

```text
GitHub
├── juntoss-app
└── juntoss-api
```

Este documento corresponde a:

```text
juntoss-api
```

---

## 3. Stack elegido

### Runtime
- Cloudflare Workers

### Framework HTTP
- Hono

### Lenguaje
- TypeScript

### Base de datos
- PostgreSQL

### Hosting PostgreSQL
- Neon

### ORM / schema
- Drizzle ORM

### Driver PostgreSQL
- `@neondatabase/serverless`

### Autenticación
- Better Auth

### Proveedores de login
- Google
- Apple

### Email transaccional
- Resend

### Storage futuro
- Cloudflare R2

---

## 4. Principio arquitectónico fundamental

La app móvil nunca debe depender directamente de Neon, Better Auth o Resend.

Incorrecto:

```text
App -> Neon
App -> Resend
App -> secretos privados
```

Correcto:

```text
App -> Juntoss API -> Neon
                  -> Better Auth
                  -> Resend
```

La API es la capa de negocio de Juntoss.

Esto permite sustituir proveedores en el futuro sin reescribir la aplicación móvil.

Ejemplo:

```text
Hoy:
Juntoss API -> Neon

Futuro:
Juntoss API -> AWS PostgreSQL
```

La app continúa usando:

```text
https://api.juntoss.app
```

---

# 5. Primera versión que debe construirse

NO implementar todavía:

- PostgreSQL
- Better Auth
- Google
- Apple
- Resend
- invitaciones
- sincronización
- movimientos
- categorías

La primera versión debe comprobar únicamente que la infraestructura funciona.

## Endpoint inicial

```http
GET /health
```

Respuesta:

```json
{
  "status": "ok",
  "service": "juntoss-api"
}
```

Código HTTP:

```text
200
```

---

# 6. Estructura inicial del proyecto

Usar una estructura preparada para crecer sin sobreingeniería.

```text
juntoss-api/
│
├── src/
│   ├── index.ts
│   │
│   ├── routes/
│   │   └── health.ts
│   │
│   ├── middleware/
│   │
│   ├── db/
│   │   ├── client.ts
│   │   └── schema/
│   │
│   ├── auth/
│   │
│   ├── services/
│   │   └── email/
│   │
│   ├── lib/
│   │
│   ├── types/
│   │
│   └── utils/
│
├── drizzle/
│
├── drizzle.config.ts
├── wrangler.jsonc
├── package.json
├── tsconfig.json
├── .gitignore
├── .dev.vars.example
└── README.md
```

Las carpetas vacías pueden añadirse progresivamente. No es obligatorio crear toda la lógica desde el primer commit.

---

# 7. Código mínimo inicial

## `src/index.ts`

```ts
import { Hono } from "hono";
import { healthRoute } from "./routes/health";

const app = new Hono();

app.route("/", healthRoute);

export default app;
```

## `src/routes/health.ts`

```ts
import { Hono } from "hono";

export const healthRoute = new Hono();

healthRoute.get("/health", (c) => {
  return c.json({
    status: "ok",
    service: "juntoss-api",
  });
});
```

---

# 8. Variables de entorno

Los secretos nunca deben subirse a Git.

Preparar:

```text
.dev.vars
```

para desarrollo local y secretos de Cloudflare para producción.

Crear también:

```text
.dev.vars.example
```

sin valores reales.

Variables previstas:

```env
DATABASE_URL=

BETTER_AUTH_SECRET=
BETTER_AUTH_URL=

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

APPLE_CLIENT_ID=
APPLE_TEAM_ID=
APPLE_KEY_ID=
APPLE_PRIVATE_KEY=

RESEND_API_KEY=

APP_URL=
API_URL=
```

No todas se utilizarán en la primera fase.

---

# 9. Base de datos remota

La nueva base de datos debe crearse desde cero.

NO convertir automáticamente los 23 SQL antiguos de Supabase.

El objetivo es construir un esquema limpio para PostgreSQL.

La base remota será la fuente de verdad para usuarios autenticados.

SQLite continuará existiendo en el dispositivo para:

- modo invitado
- funcionamiento local/offline
- datos pendientes de sincronización
- caché
- instalación local
- migración guest -> usuario
- preferencias estrictamente locales

Arquitectura:

```text
                  +------------------+
                  | React Native App |
                  +--------+---------+
                           |
                 +---------+---------+
                 |                   |
                 v                   v
             SQLite              Juntoss API
              local                  |
                                     v
                               PostgreSQL
                                  Neon
```

No eliminar SQLite del frontend.

---

# 10. Identidad de usuario

Juntoss debe tener IDs propios.

No utilizar como ID principal:

- email
- Google user ID
- Apple user ID

Conceptualmente:

```text
USER
id = uuid propio de Juntoss
email = usuario@email.com
```

Las identidades externas se vinculan al usuario:

```text
ACCOUNT
user_id = USER_ID
provider = google
provider_account_id = GOOGLE_SUB
```

o:

```text
ACCOUNT
user_id = USER_ID
provider = apple
provider_account_id = APPLE_SUB
```

Un mismo usuario puede eventualmente tener:

```text
USER
  |
  +-- Google
  |
  +-- Apple
```

Los datos financieros siempre deben referenciar:

```text
user_id
```

Nunca el correo o el ID del proveedor.

---

# 11. Better Auth

Better Auth será responsable de:

- usuarios de autenticación
- cuentas vinculadas
- sesiones
- verificaciones
- Google OAuth
- Apple Sign In

Las tablas de autenticación deben seguir el esquema esperado por Better Auth.

No recrear manualmente una réplica de `auth.users` de Supabase.

Separar conceptualmente:

```text
AUTH USER
identidad y acceso

USER PROFILE
datos de Juntoss
```

Ejemplo:

```text
users
accounts
sessions
verifications

user_profiles
```

---

# 12. Perfil de Juntoss

El perfil de producto debe estar separado de las tablas internas de autenticación.

Campos previstos:

```text
user_profiles
-------------
user_id
display_name
avatar_path
avatar_updated_at
locale
default_currency
created_at
updated_at
```

Un futuro `username` puede existir, pero debe ser opcional.

No usar `username` como identidad primaria.

---

# 13. Modelo principal de negocio

El núcleo remoto previsto es:

```text
USERS
  |
  +-- USER_PROFILES
  |
  +-- SPACE_MEMBERS -- SPACES
                        |
                        +-- CATEGORIES
                        |
                        +-- MONEY_ACCOUNTS
                        |
                        +-- TRANSACTIONS
                        |
                        +-- RECURRING_TRANSACTION_SERIES
```

Tablas principales previstas:

```text
user_profiles

spaces
space_members

categories
category_budgets

money_accounts
money_account_balances

transactions
recurring_transaction_series
```

---

# 14. Funcionalidades secundarias

No forman parte del primer esquema mínimo de infraestructura, pero deben contemplarse en el diseño.

## Invitaciones

```text
space_invitations
```

Debe soportar usuarios existentes y personas que todavía no tienen cuenta.

Campos conceptuales:

```text
id
space_id

invited_by_user_id

invitee_email
invitee_user_id nullable

token_hash
status
expires_at

accepted_by_user_id nullable

created_at
accepted_at
```

El correo se usa para dirigir la invitación.

La membresía real siempre usa:

```text
space_members.user_id
```

---

## Push

```text
user_push_tokens
transaction_notification_rules
```

---

## Importación bancaria / archivos

```text
import_batches
import_items
user_merchant_rules
```

---

## Merchant intelligence

```text
merchant_feedback_votes
merchant_feedback_aggregates
global_rule_candidates
```

---

## Guest migration / sync

```text
guest_migration_batches
```

El sistema local ya contiene:

```text
remote_entity_links
local_sync_account
local_sync_batches
```

Antes de crear nuevas tablas remotas para mapping local/remoto debe revisarse si realmente son necesarias.

---

## Legal

```text
legal_acceptances
```

---

# 15. Datos legado que NO deben copiarse automáticamente

Revisar y probablemente eliminar del nuevo esquema:

```text
categories.budget_amount_minor
money_accounts.opening_balance_minor
space_members.space_type
money_account_balances.space_id
```

Motivo: parecen duplicar información disponible en otras tablas.

También revisar específicamente:

```text
space_local_sources

transactions.recurrence
transactions.recurrence_group_id
transactions.source_transaction_id

login_attempts
```

No eliminar hasta confirmar su uso actual en el frontend/backend existente.

---

# 16. Dinero

Todos los importes financieros deben seguir almacenándose como enteros en unidades menores.

Ejemplos:

```text
10,50 EUR -> 1050
99,99 EUR -> 9999
```

Preferir:

```text
amount_minor BIGINT
```

en lugar de:

```text
FLOAT
REAL
DOUBLE
```

Nunca utilizar floating point para cantidades financieras.

Mantener la moneda explícita:

```text
currency = "EUR"
currency = "USD"
currency = "VES"
```

Preferiblemente código ISO 4217 cuando aplique.

Al crear una `money_account`, la API debe crear en la misma operación al menos
un `money_account_balances` con `currency` igual a la `primary_currency` de la
cuenta. Las monedas adicionales se añaden posteriormente para cuentas
multidivisa. Esta regla se garantiza en la API, no mediante una constraint de
PostgreSQL entre filas.

---

# 17. IDs

Preferir UUID para entidades principales.

Ejemplo:

```text
users.id
spaces.id
transactions.id
categories.id
money_accounts.id
```

Los IDs deben generarse de forma segura y no depender del proveedor de autenticación.

---

# 18. Timestamps

Estándar recomendado:

```text
created_at
updated_at
archived_at
```

Utilizar timestamps con zona horaria en PostgreSQL cuando corresponda.

`updated_at` se actualiza desde la API en cada `UPDATE`. En Drizzle, todas las
columnas `updatedAt` de las tablas propias deben declarar `$onUpdate(() => new
Date())`; no se usan triggers de PostgreSQL. Las actualizaciones ejecutadas con
SQL directo también deben asignar explícitamente `updated_at = now()`.

No guardar fechas importantes como strings arbitrarios.

Para fechas financieras que representan un día y no una hora:

```text
occurred_on DATE
starts_on DATE
next_occurrence_on DATE
```

---

# 19. Soft delete / archivado

Para entidades financieras que puedan tener historial asociado, priorizar archivado en lugar de borrado físico.

Ejemplo:

```text
categories.is_archived
categories.archived_at

money_accounts.is_archived
money_accounts.archived_at
```

Evitar borrar una categoría si existen movimientos históricos que dependen de ella.

---

# 20. Email con Resend

Resend se conecta al backend.

Nunca directamente al frontend.

```text
Juntoss App
     |
     v
Juntoss API
     |
     v
Resend
     |
     v
Email
```

La API tendrá un servicio abstracto:

```text
src/services/email/
```

Ejemplos futuros:

```ts
sendSpaceInvitation(...)
sendVerificationEmail(...)
sendAccountSecurityAlert(...)
```

La clave:

```text
RESEND_API_KEY
```

solo debe existir en Cloudflare Workers / entorno local seguro.

---

# 21. Invitaciones por correo

Flujo previsto:

```text
Usuario A
   |
   | introduce email
   v
POST /v1/spaces/:spaceId/invitations
   |
   v
Juntoss API
   |
   +--> crea SPACE_INVITATION
   |
   +--> genera token seguro
   |
   +--> guarda hash del token
   |
   +--> Resend
             |
             v
          Email
```

El token original no debe almacenarse en texto plano.

Guardar:

```text
token_hash
```

---

# 22. Google y Apple

Google y Apple son métodos de autenticación, no la identidad central.

Ejemplo:

```text
USER_123
  |
  +-- google / sub=ABC
  |
  +-- apple / sub=XYZ
```

Debe contemplarse Apple Hide My Email.

Nunca asumir que dos cuentas pertenecen a la misma persona solamente porque el email parece relacionado.

La vinculación de cuentas debe realizarse mediante mecanismos seguros de Better Auth.

---

# 23. Seguridad

Reglas obligatorias:

1. Ningún secreto privado en React Native.
2. Ningún secreto privado en Git.
3. La app no conecta directamente a PostgreSQL.
4. La app no contiene `DATABASE_URL`.
5. La app no contiene `RESEND_API_KEY`.
6. La app no contiene `GOOGLE_CLIENT_SECRET`.
7. La app no contiene claves privadas de Apple.
8. Todas las operaciones privadas pasan por HTTPS.
9. Validar inputs en servidor.
10. Validar autorización por recurso.
11. Nunca confiar en `user_id`, `space_id` o roles enviados por el cliente sin comprobarlos.
12. No devolver información sensible innecesaria en errores.
13. No almacenar tokens de invitación en texto plano.

---

# 24. Autorización

Autenticación y autorización son diferentes.

Better Auth responde:

```text
¿Quién eres?
```

Juntoss debe responder:

```text
¿Puedes hacer esto?
```

Ejemplo:

```http
DELETE /v1/spaces/SPACE_123/transactions/TX_456
```

No basta con que el usuario esté autenticado.

La API debe comprobar:

```text
1. Existe sesión válida.
2. El usuario pertenece a SPACE_123.
3. Tiene permiso para modificar TX_456.
4. TX_456 pertenece realmente a SPACE_123.
```

---

# 25. API versionada

Las rutas de negocio deben comenzar en:

```text
/v1
```

Ejemplos futuros:

```http
GET    /health

GET    /v1/me

GET    /v1/spaces
POST   /v1/spaces

GET    /v1/spaces/:spaceId
POST   /v1/spaces/:spaceId/invitations

GET    /v1/spaces/:spaceId/transactions
POST   /v1/spaces/:spaceId/transactions

GET    /v1/spaces/:spaceId/categories
POST   /v1/spaces/:spaceId/categories

GET    /v1/spaces/:spaceId/accounts
POST   /v1/spaces/:spaceId/accounts
```

No implementar estos endpoints todavía salvo cuando llegue su fase.

---

# 26. Formato de respuestas

Mantener JSON consistente.

Ejemplo exitoso:

```json
{
  "data": {
    "id": "..."
  }
}
```

Ejemplo de error:

```json
{
  "error": {
    "code": "SPACE_NOT_FOUND",
    "message": "Space not found"
  }
}
```

Los códigos deben ser estables y utilizables por el frontend.

---

# 27. Logs

No registrar:

- passwords
- session tokens
- access tokens
- refresh tokens
- Apple private keys
- Google client secrets
- Resend API keys
- tokens completos de invitaciones
- datos financieros innecesarios

Los logs deben ser útiles para depuración sin exponer secretos.

---

# 28. CORS

No dejar una configuración permisiva de producción sin necesidad.

Durante desarrollo se podrán permitir orígenes locales controlados.

La configuración definitiva dependerá del flujo real de Expo/React Native y del uso de endpoints web para OAuth.

---

# 29. Migraciones SQL

No volver al modelo de 23 scripts desordenados.

Usar migraciones incrementales claras.

Ejemplo:

```text
drizzle/
├── 0001_initial_schema.sql
├── 0002_add_invitations.sql
├── 0003_add_imports.sql
└── 0004_add_merchant_feedback.sql
```

Cada migración representa una evolución real del modelo.

Nunca editar una migración ya aplicada en producción.

Crear una nueva.

---

# 30. Orden de implementación

## Fase 1 — Infraestructura mínima

Objetivo:

```text
Cloudflare Worker operativo
```

Implementar solamente:

```http
GET /health
```

Checklist:

- [ ] repositorio `juntoss-api`
- [ ] TypeScript
- [ ] Hono
- [ ] Wrangler
- [ ] ejecución local
- [ ] `/health`
- [ ] deploy Cloudflare
- [ ] URL pública responde correctamente

---

## Fase 2 — PostgreSQL

Después de completar Fase 1:

- [ ] crear proyecto Neon
- [ ] configurar `DATABASE_URL`
- [ ] instalar Drizzle
- [ ] crear conexión PostgreSQL
- [ ] comprobar conexión desde Worker
- [ ] definir esquema inicial limpio
- [ ] primera migración

No implementar autenticación antes de comprobar que la conexión DB funciona correctamente.

---

## Fase 3 — Better Auth

- [ ] Better Auth
- [ ] tablas auth
- [ ] sesiones
- [ ] endpoint auth
- [ ] Google
- [ ] Apple
- [ ] `user_profiles`
- [ ] `/v1/me`

---

## Fase 4 — Spaces

- [ ] spaces
- [ ] space_members
- [ ] creación de espacio personal
- [ ] lectura de espacios
- [ ] autorización por membresía

---

## Fase 5 — Core financiero

- [ ] categories
- [ ] category_budgets
- [ ] money_accounts
- [ ] money_account_balances
- [ ] transactions
- [ ] recurring_transaction_series

---

## Fase 6 — Invitaciones

- [ ] space_invitations
- [ ] tokens seguros
- [ ] Resend
- [ ] aceptación
- [ ] usuario existente
- [ ] usuario nuevo
- [ ] Apple Hide My Email

---

## Fase 7 — Sync / guest migration

Solo después de estabilizar el core remoto:

- [ ] analizar SQLite actual
- [ ] mapping local/remoto
- [ ] guest migration
- [ ] idempotencia
- [ ] resolución de duplicados
- [ ] reintentos
- [ ] consistencia

---

## Fase 8 — Funciones avanzadas

- [ ] push
- [ ] import batches
- [ ] merchant rules
- [ ] merchant feedback
- [ ] legal acceptances
- [ ] storage R2

---

# 31. Primera tarea para los agentes

Construir únicamente la Fase 1.

No anticipar las demás fases.

Resultado esperado:

```text
Repositorio:
juntoss-api

Stack:
Cloudflare Workers
Hono
TypeScript

Endpoint:
GET /health

Respuesta:
{
  "status": "ok",
  "service": "juntoss-api"
}
```

Debe funcionar:

1. localmente;
2. desplegado en Cloudflare Workers.

No añadir base de datos hasta confirmar este punto.

---

# 32. Filosofía del proyecto

La prioridad de Juntoss debe ser:

```text
simplicidad
+
portabilidad
+
seguridad
+
mantenibilidad
```

Evitar acoplamiento innecesario con cualquier proveedor.

Cada servicio externo debe tratarse como una implementación reemplazable.

```text
PostgreSQL:
Neon hoy -> otro proveedor mañana

Email:
Resend hoy -> otro proveedor mañana

Storage:
R2 hoy -> otro proveedor mañana

Auth providers:
Google / Apple -> extensibles
```

El dominio y la lógica de negocio pertenecen a Juntoss.

---

# 33. Regla final para los agentes

Antes de implementar una nueva tabla, endpoint o servicio:

1. comprobar si Juntoss realmente lo necesita;
2. identificar quién será su fuente de verdad;
3. evitar duplicar datos;
4. definir autorización;
5. considerar modo local/offline;
6. evitar dependencia innecesaria del proveedor;
7. añadir migración solamente cuando el modelo haya sido aprobado.

**No migrar deuda técnica antigua simplemente porque ya existe.**
