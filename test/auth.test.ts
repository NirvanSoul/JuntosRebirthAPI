import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { getTableConfig } from "drizzle-orm/pg-core";
import app from "../src/index";
import { createAuth } from "../src/lib/auth";
import { account } from "../src/db/schema";
import { rateLimit } from "../src/db/schema";
import { createRequireAuth, type AuthVariables } from "../src/middleware/auth";
import type { Bindings } from "../src/types/env";
import { normalizeAuthErrorResponse } from "../src/lib/auth-errors";

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
    expect(auth.options.emailVerification?.autoSignInAfterVerification).toBe(true);
    expect(auth.options.rateLimit?.storage).toBe("database");
    const otpPlugin = auth.options.plugins?.find((plugin) => plugin.id === "email-otp") as
      | { options?: { rateLimit?: { max?: number; window?: number } } }
      | undefined;
    expect(otpPlugin?.options?.rateLimit).toEqual({ max: 3, window: 60 * 60 });
    // Comprobar el código no puede compartir el 3/hora de los envíos.
    expect(auth.options.rateLimit?.customRules?.["/email-otp/reset-password"]).toEqual({
      window: 10 * 60,
      max: 10,
    });
    expect(auth.options.advanced?.ipAddress?.ipAddressHeaders?.[0]).toBe("cf-connecting-ip");
    expect(rateLimit.key).toBeDefined();
    expect(rateLimit.lastRequest).toBeDefined();
    expect(auth.options.trustedOrigins).toEqual([
      mockEnv.BETTER_AUTH_URL,
      "https://api.aoraestudio.com",
      "juntoss://",
      "juntoss://*",
      "exp://",
      "exp://**",
    ]);
  });

  it("trusts the exp:// origin that Expo Go sends in production too", () => {
    // Expo Go no puede usar el esquema `juntoss://`: su `expo-origin` es
    // `exp://<host>:<puerto>` y sin él el registro respondía 403.
    const auth = createAuth({
      ...mockEnv,
      ENVIRONMENT: "production",
      BETTER_AUTH_URL: "https://api.aoraestudio.com",
    });

    expect(auth.options.trustedOrigins).toContain("exp://");
    expect(auth.options.trustedOrigins).toContain("exp://**");
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

describe("Private API authorization", () => {
  function protectedApp(emailVerified: boolean) {
    const testApp = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
    testApp.use(
      "/v1/*",
      createRequireAuth(async () => ({ userId: "user-1", emailVerified })),
    );
    testApp.get("/v1/bootstrap", (c) => c.json({ userId: c.get("currentUserId") }));
    return testApp;
  }

  it("rejects a valid provisional session until its email is verified", async () => {
    const response = await protectedApp(false).request("/v1/bootstrap", {}, mockEnv);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "EMAIL_NOT_VERIFIED",
        message: "Verify your email address to continue.",
      },
    });
  });

  it("allows a verified session and derives the user from it", async () => {
    const response = await protectedApp(true).request("/v1/bootstrap", {}, mockEnv);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ userId: "user-1" });
  });
});

describe("Better Auth error contract", () => {
  async function normalize(
    status: number,
    payload: unknown,
    headers?: HeadersInit,
    path = "/auth",
  ) {
    const testApp = new Hono();
    testApp.get(path, (c) =>
      normalizeAuthErrorResponse(
        c,
        new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json", ...headers },
        }),
      ),
    );
    return testApp.request(path);
  }

  const SOCIAL_PATH = "/api/auth/sign-in/social";
  const normalizeSocial = (status: number, payload: unknown) =>
    normalize(status, payload, undefined, SOCIAL_PATH);

  it("normalizes OTP failures to the public error envelope", async () => {
    const response = await normalize(400, { code: "OTP_EXPIRED", message: "provider detail" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "OTP_EXPIRED", message: "Verification code has expired." },
    });
  });

  it("keeps a credential failure distinguishable from a missing session", async () => {
    const response = await normalize(401, {
      code: "INVALID_EMAIL_OR_PASSWORD",
      message: "provider detail",
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_EMAIL_OR_PASSWORD",
        message: "Incorrect email or password.",
      },
    });
  });

  it("normalizes rate limiting and preserves the retry time", async () => {
    const response = await normalize(
      429,
      { message: "Too many requests." },
      { "x-retry-after": "60" },
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    await expect(response.json()).resolves.toEqual({
      error: { code: "TOO_MANY_ATTEMPTS", message: "Too many attempts. Try again later." },
    });
  });

  it("preserves a valid lockout expiry without forwarding provider text", async () => {
    const response = await normalize(429, {
      code: "ACCOUNT_LOCKED",
      message: "provider detail",
      lockedUntil: "2026-09-01T12:00:00.000Z",
    });

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "TOO_MANY_ATTEMPTS",
        message: "Too many attempts. Try again later.",
        lockedUntil: "2026-09-01T12:00:00.000Z",
      },
    });
  });

  describe("Google sign-in", () => {
    it("separates a rejected ID token from a missing session", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const response = await normalizeSocial(401, {
          code: "INVALID_TOKEN",
          message: "Invalid token",
        });

        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toEqual({
          error: { code: "INVALID_SOCIAL_TOKEN", message: "The sign-in token was rejected." },
        });
        expect(JSON.parse(warn.mock.calls[0][0] as string)).toEqual({
          event: "auth_social_sign_in_failed",
          status: 401,
          upstreamCode: "INVALID_TOKEN",
          linkReason: null,
          code: "INVALID_SOCIAL_TOKEN",
        });
      } finally {
        warn.mockRestore();
      }
    });

    it("keeps INVALID_TOKEN generic outside social sign-in", async () => {
      const response = await normalize(400, { code: "INVALID_TOKEN" });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "INVALID_REQUEST" },
      });
    });

    it("reports an unverified local account without linking it", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const response = await normalizeSocial(401, {
          code: "OAUTH_LINK_ERROR",
          message: "account not linked",
        });

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toEqual({
          error: {
            code: "SOCIAL_ACCOUNT_NOT_LINKED",
            message: "Sign in with your email to continue.",
          },
        });
      } finally {
        warn.mockRestore();
      }
    });

    it("hides internal link failures and never logs unknown provider text", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const internal = await normalizeSocial(401, {
          code: "OAUTH_LINK_ERROR",
          message: "unable to create user",
        });
        const unknown = await normalizeSocial(401, {
          code: "OAUTH_LINK_ERROR",
          message: "person@example.com is blocked",
        });

        expect(internal.status).toBe(500);
        await expect(internal.json()).resolves.toEqual({
          error: { code: "SOCIAL_SIGN_IN_FAILED", message: "Sign-in could not be completed." },
        });
        expect(JSON.parse(warn.mock.calls[0][0] as string).linkReason).toBe(
          "unable to create user",
        );
        await expect(unknown.json()).resolves.toMatchObject({
          error: { code: "SOCIAL_SIGN_IN_FAILED" },
        });
        expect(warn.mock.calls[1][0]).not.toContain("example.com");
        expect(JSON.parse(warn.mock.calls[1][0] as string).linkReason).toBe("other");
      } finally {
        warn.mockRestore();
      }
    });

    it("reports a profile without email as unavailable", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const response = await normalizeSocial(401, { code: "USER_EMAIL_NOT_FOUND" });

        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toMatchObject({
          error: { code: "SOCIAL_PROFILE_UNAVAILABLE" },
        });
      } finally {
        warn.mockRestore();
      }
    });

    it("rejects a malformed Google ID token end to end", async () => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("blocked network request"));
      const quiet = (["warn", "error", "log"] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation(() => {}),
      );
      try {
        const res = await app.request(
          "/api/auth/sign-in/social",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ provider: "google", idToken: { token: "not-a-jwt" } }),
          },
          mockEnv,
        );

        expect(res.status).toBe(401);
        await expect(res.json()).resolves.toMatchObject({
          error: { code: "INVALID_SOCIAL_TOKEN" },
        });
        expect(res.headers.get("set-cookie")).toBeNull();
      } finally {
        fetchMock.mockRestore();
        quiet.forEach((spy) => spy.mockRestore());
      }
    });
  });
});
