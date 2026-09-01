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
