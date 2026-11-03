import { describe, expect, it } from "vitest";
import { databaseIdentity, remoteTargetProblem } from "./integration/node/database-target.mjs";
import { isLoopbackConnectionString, localNeonFetch } from "./integration/node/neon-local-fetch.mjs";

/** Salvaguardas del arnés de integración: nunca contra la base de la app. */
describe("integration database target", () => {
  const app = "postgresql://owner:pw@ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require";

  it("identifies a database by host, port and name, ignoring credentials and the pooler suffix", () => {
    expect(databaseIdentity(app)).toBe(databaseIdentity("postgres://other:x@ep-cool-name-123456.eu-central-1.aws.neon.tech:5432/neondb"));
    expect(databaseIdentity(app)).not.toBe(databaseIdentity("postgresql://owner:pw@ep-cool-name-123456.eu-central-1.aws.neon.tech/neondb_test"));
  });

  it("refuses DATABASE_URL_TEST when it points at the application database", () => {
    expect(remoteTargetProblem(app.replace("owner:pw", "tester:other"), [undefined, app])).toMatch(/application DATABASE_URL/);
  });

  it("accepts a different database and rejects unparsable strings", () => {
    expect(remoteTargetProblem("postgresql://t:p@ep-test-branch.neon.tech/neondb", [app])).toBeNull();
    expect(remoteTargetProblem("not a url", [app])).toMatch(/not a valid connection string/);
  });

  it("the local Neon bridge only talks to loopback hosts", async () => {
    expect(isLoopbackConnectionString("postgresql://u:p@127.0.0.1:5555/db")).toBe(true);
    expect(isLoopbackConnectionString("postgresql://u:p@localhost/db")).toBe(true);
    expect(isLoopbackConnectionString(app)).toBe(false);
    await expect(localNeonFetch("https://example.invalid/sql", {
      headers: { "Neon-Connection-String": app },
      body: JSON.stringify({ query: "SELECT 1", params: [] }),
    })).rejects.toThrow(/loopback/);
  });
});
