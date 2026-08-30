import { describe, it, expect, vi } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import app from "../src/index";
import { createAuth } from "../src/lib/auth";
import { account } from "../src/db/schema";

const mockEnv = {
  DATABASE_URL: "postgresql://user:pass@ep-test.neon.tech/neondb",
  BETTER_AUTH_SECRET: "test-secret-min-32-chars-long-example-12345",
  BETTER_AUTH_URL: "https://juntosapi.aora-estudio-o.workers.dev",
  GOOGLE_CLIENT_ID: "mock-google-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "mock-google-client-secret",
};

describe("Better Auth Factory", () => {
  it("keeps the Better Auth account identity schema current", () => {
    expect(account.issuer).toBeDefined();

    const identityIndex = getTableConfig(account).indexes.find(
      (index) => index.config.name === "account_issuer_accountId_uidx",
    );

    expect(identityIndex?.config.unique).toBe(true);
    expect(
      identityIndex?.config.columns.map(
        (column) => (column as { name?: string }).name,
      ),
    ).toEqual(["issuer", "account_id"]);
  });

  it("throws error when DATABASE_URL is missing", () => {
    expect(() =>
      createAuth({
        ...mockEnv,
        DATABASE_URL: "",
      })
    ).toThrow("DATABASE_URL is required to initialize auth");
  });

  it("fails fast when Google OAuth bindings are missing", () => {
    expect(() =>
      createAuth({
        ...mockEnv,
        GOOGLE_CLIENT_ID: "",
      })
    ).toThrow(
      "Google OAuth is misconfigured: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required"
    );

    expect(() =>
      createAuth({
        ...mockEnv,
        GOOGLE_CLIENT_SECRET: "",
      })
    ).toThrow(
      "Google OAuth is misconfigured: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required"
    );
  });

  it("initializes auth instance with valid bindings and google provider", () => {
    const auth = createAuth(mockEnv);

    expect(auth).toBeDefined();
    expect(auth.handler).toBeTypeOf("function");
    expect(auth.options.socialProviders?.google).toBeDefined();
    expect(auth.options.socialProviders?.google?.clientId).toBe(
      mockEnv.GOOGLE_CLIENT_ID
    );
    expect(auth.options.plugins?.map((plugin) => plugin.id)).toEqual([
      "expo",
      "email-otp",
    ]);
    expect(auth.options.emailAndPassword?.enabled).toBe(true);
    // El registro debe confirmar el correo antes de dejar entrar, igual que
    // hacía la base anterior (`email_not_confirmed`).
    expect(auth.options.emailAndPassword?.requireEmailVerification).toBe(true);
    expect(auth.options.trustedOrigins).toEqual([
      mockEnv.BETTER_AUTH_URL,
      "https://api.aoraestudio.com",
      "juntoss://",
      "juntoss://*",
    ]);
  });

  it("allows Expo development origins only for development Workers", () => {
    const auth = createAuth({
      ...mockEnv,
      ENVIRONMENT: "development",
    });

    expect(auth.options.trustedOrigins).toEqual([
      mockEnv.BETTER_AUTH_URL,
      "https://api.aoraestudio.com",
      "juntoss://",
      "juntoss://*",
      "exp://",
      "exp://**",
    ]);
  });

  it("does not return PROVIDER_NOT_FOUND for Google social sign-in", async () => {
    const auth = createAuth(mockEnv);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("blocked test database request"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const res = await auth.handler(
        new Request(
          "https://juntosapi.aora-estudio-o.workers.dev/api/auth/sign-in/social",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ provider: "google", callbackURL: "juntoss://" }),
          }
        )
      );

      const body = await res.text();
      expect(res.status).not.toBe(404);
      expect(body).not.toContain("PROVIDER_NOT_FOUND");
    } finally {
      fetchMock.mockRestore();
      consoleError.mockRestore();
    }
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
