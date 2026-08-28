import { describe, it, expect } from "vitest";
import app from "../src/index";
import { createAuth } from "../src/lib/auth";

const mockEnv = {
  DATABASE_URL: "postgresql://user:pass@ep-test.neon.tech/neondb",
  BETTER_AUTH_SECRET: "test-secret-min-32-chars-long-example-12345",
  BETTER_AUTH_URL: "https://juntosapi.aora-estudio-o.workers.dev",
  GOOGLE_CLIENT_ID: "mock-google-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "mock-google-client-secret",
};

describe("Better Auth Factory", () => {
  it("throws error when DATABASE_URL is missing", () => {
    expect(() =>
      createAuth({
        ...mockEnv,
        DATABASE_URL: "",
      })
    ).toThrow("DATABASE_URL is required to initialize auth");
  });

  it("initializes auth instance with valid bindings and google provider", () => {
    const auth = createAuth(mockEnv);

    expect(auth).toBeDefined();
    expect(auth.handler).toBeTypeOf("function");
    expect(auth.options.socialProviders?.google).toBeDefined();
    expect(auth.options.socialProviders?.google?.clientId).toBe(
      mockEnv.GOOGLE_CLIENT_ID
    );
    expect(auth.options.plugins).toHaveLength(1);
    expect(auth.options.trustedOrigins).toEqual(["juntoss://", "juntoss://*"]);
  });

  it("allows Expo development origins only for development Workers", () => {
    const auth = createAuth({
      ...mockEnv,
      ENVIRONMENT: "development",
    });

    expect(auth.options.trustedOrigins).toEqual([
      "juntoss://",
      "juntoss://*",
      "exp://",
      "exp://**",
    ]);
  });
});

describe("Better Auth Routes in Hono", () => {
  it("responds to /api/auth/ok endpoint", async () => {
    const res = await app.request(
      "/api/auth/ok",
      { method: "GET" },
      mockEnv
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it("responds to /api/auth/get-session with null when unauthenticated", async () => {
    const res = await app.request(
      "/api/auth/get-session",
      { method: "GET" },
      mockEnv
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeNull();
  });
});
