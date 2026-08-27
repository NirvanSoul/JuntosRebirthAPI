import { describe, it, expect } from "vitest";
import app from "../src/index";
import { createAuth } from "../src/lib/auth";

describe("Better Auth Factory", () => {
  it("throws error when DATABASE_URL is missing", () => {
    expect(() =>
      createAuth({
        DATABASE_URL: "",
        BETTER_AUTH_SECRET: "test-secret-min-32-chars-long-example-12345",
        BETTER_AUTH_URL: "https://example.workers.dev",
      })
    ).toThrow("DATABASE_URL is required to initialize auth");
  });

  it("initializes auth instance with valid bindings", () => {
    const auth = createAuth({
      DATABASE_URL: "postgresql://user:pass@ep-test.neon.tech/neondb",
      BETTER_AUTH_SECRET: "test-secret-min-32-chars-long-example-12345",
      BETTER_AUTH_URL: "https://example.workers.dev",
    });

    expect(auth).toBeDefined();
    expect(auth.handler).toBeTypeOf("function");
  });
});

describe("Better Auth Routes in Hono", () => {
  it("responds to /api/auth/ok endpoint", async () => {
    const res = await app.request(
      "/api/auth/ok",
      { method: "GET" },
      {
        DATABASE_URL: "postgresql://user:pass@ep-test.neon.tech/neondb",
        BETTER_AUTH_SECRET: "test-secret-min-32-chars-long-example-12345",
        BETTER_AUTH_URL: "https://juntosapi.aora-estudio-o.workers.dev",
      }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it("responds to /api/auth/get-session with null when unauthenticated", async () => {
    const res = await app.request(
      "/api/auth/get-session",
      { method: "GET" },
      {
        DATABASE_URL: "postgresql://user:pass@ep-test.neon.tech/neondb",
        BETTER_AUTH_SECRET: "test-secret-min-32-chars-long-example-12345",
        BETTER_AUTH_URL: "https://juntosapi.aora-estudio-o.workers.dev",
      }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeNull();
  });
});
