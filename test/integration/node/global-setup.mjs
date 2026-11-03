import { resolveIntegrationDatabase } from "./database-target.mjs";

/** Vitest `globalSetup`: prepara la base una vez y la entrega a los workers. */
export default async function setup(project) {
  const target = await resolveIntegrationDatabase();
  project.provide("integrationDatabaseUrl", target.url);
  project.provide("integrationDatabaseMode", target.mode);
  return async () => {
    await target.stop();
  };
}
