# Juntoss API

Backend independiente para **Juntoss** construido sobre **Cloudflare Workers**, **Hono** y **TypeScript**.

## Estructura del proyecto

```text
juntoss-api/
├── src/
│   ├── index.ts
│   └── routes/
│       └── health.ts
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

## Despliegue en Cloudflare Workers

```bash
npm run deploy
```
