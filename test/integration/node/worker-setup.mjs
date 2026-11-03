import { inject } from "vitest";
import { installLocalNeonFetch } from "./neon-local-fetch.mjs";

// Cada worker tiene su propio `neonConfig`: en modo local hay que volver a
// enganchar el puente antes de que el código de la API haga su primera consulta.
if (inject("integrationDatabaseMode") === "local") installLocalNeonFetch();
