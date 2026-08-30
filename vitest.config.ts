import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Las pruebas unitarias no tocan red ni base de datos. Las de integración
    // viven en `test/integration/` y necesitan `DATABASE_URL_TEST`, por eso se
    // excluyen de `npm test` y se ejecutan con `npm run test:integration`.
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration/**", "node_modules/**"],
  },
});
