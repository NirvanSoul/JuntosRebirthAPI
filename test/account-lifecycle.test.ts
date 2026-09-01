import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createRequireAuth, type AuthVariables } from "../src/middleware/auth";
import { createAccountRoute } from "../src/routes/account";
import type { Database } from "../src/db/client";
import type { Bindings } from "../src/types/env";

function appWith(overrides: Record<string, unknown>, env: Partial<Bindings> = {}) {
  const deps = {
    createDb: vi.fn(() => ({}) as Database),
    findCurrentUser: vi.fn().mockResolvedValue({ id: "user-1", email: "a@b.c" }),
    bootstrapAccount: vi.fn(),
    getAccountState: vi.fn(),
    updateProfile: vi.fn(),
    recordLegalAcceptance: vi.fn().mockResolvedValue({ id: "acc-1" }),
    exportAccount: vi.fn().mockResolvedValue({ spaces: [] }),
    deleteAccount: vi.fn().mockResolvedValue(undefined),
    deleteAccountData: vi.fn().mockResolvedValue(undefined),
    deleteAvatar: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as NonNullable<Parameters<typeof createAccountRoute>[0]>;

  const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  app.use("*", createRequireAuth(async () => ({ userId: "user-1", emailVerified: true })));
  app.route("/v1", createAccountRoute(deps));
  return { app, deps, env: { DATABASE_URL: "postgres://x", ...env } as Bindings };
}

function post(body: unknown) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function deleteAccount(confirmation?: string) {
  return {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(confirmation ? { confirmation } : {}),
  };
}

function deleteData(confirmation?: string) {
  return {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(confirmation ? { confirmation } : {}),
  };
}

describe("legal acceptances", () => {
  it("records an accepted document", async () => {
    const { app, deps, env } = appWith({});

    const response = await app.request(
      "/v1/me/legal-acceptances",
      post({ documentType: "privacy-policy", documentVersion: "2026-08-01", locale: "es-ES" }),
      env,
    );

    expect(response.status).toBe(201);
    expect(deps.recordLegalAcceptance).toHaveBeenCalledWith(expect.anything(), "user-1", {
      documentType: "privacy-policy",
      documentVersion: "2026-08-01",
      appVersion: null,
      locale: "es-ES",
      source: null,
    });
  });

  it("rejects an unknown document type", async () => {
    const { app, deps, env } = appWith({});

    const response = await app.request(
      "/v1/me/legal-acceptances",
      post({ documentType: "cookie-policy", documentVersion: "1" }),
      env,
    );

    expect(response.status).toBe(400);
    expect(deps.recordLegalAcceptance).not.toHaveBeenCalled();
  });

  it("rejects an invalid type instead of silently storing null", async () => {
    const { app, deps, env } = appWith({});

    // Un registro de consentimiento que pierde en silencio la versión de la
    // app o el locale no prueba qué aceptó la persona ni dónde.
    for (const payload of [
      { documentType: "privacy-policy", documentVersion: "1", appVersion: 42 },
      { documentType: "privacy-policy", documentVersion: "1", locale: { a: 1 } },
    ]) {
      const response = await app.request("/v1/me/legal-acceptances", post(payload), env);
      expect(response.status).toBe(400);
    }
    expect(deps.recordLegalAcceptance).not.toHaveBeenCalled();
  });

  it("treats an omitted optional field as null", async () => {
    const { app, deps, env } = appWith({});

    await app.request(
      "/v1/me/legal-acceptances",
      post({ documentType: "terms-of-service", documentVersion: "3" }),
      env,
    );

    expect(deps.recordLegalAcceptance).toHaveBeenCalledWith(expect.anything(), "user-1", {
      documentType: "terms-of-service",
      documentVersion: "3",
      appVersion: null,
      locale: null,
      source: null,
    });
  });

  it("rejects a userId smuggled in the body", async () => {
    const { app, env } = appWith({});

    const response = await app.request(
      "/v1/me/legal-acceptances",
      post({ documentType: "privacy-policy", documentVersion: "1", userId: "someone-else" }),
      env,
    );

    expect(response.status).toBe(400);
  });
});

describe("account export and deletion", () => {
  it("exports only the signed-in account", async () => {
    const { app, deps, env } = appWith({});

    const response = await app.request("/v1/me/export", {}, env);

    expect(response.status).toBe(200);
    expect(deps.exportAccount).toHaveBeenCalledWith(expect.anything(), "user-1");
  });

  it("removes the avatar from R2 before deleting the account", async () => {
    const order: string[] = [];
    const { app, env } = appWith(
      {
        deleteAvatar: vi.fn(async () => {
          order.push("avatar");
        }),
        deleteAccount: vi.fn(async () => {
          order.push("account");
        }),
      },
      { AVATARS: {} as R2Bucket },
    );

    const response = await app.request("/v1/me", deleteAccount("DELETE_MY_ACCOUNT"), env);

    expect(response.status).toBe(204);
    // El objeto de R2 no lo alcanza el ON DELETE CASCADE de PostgreSQL.
    expect(order).toEqual(["avatar", "account"]);
  });

  it("still deletes the account when avatar storage is not configured", async () => {
    const { app, deps, env } = appWith({});

    const response = await app.request("/v1/me", deleteAccount("DELETE_MY_ACCOUNT"), env);

    expect(response.status).toBe(204);
    expect(deps.deleteAvatar).not.toHaveBeenCalled();
    expect(deps.deleteAccount).toHaveBeenCalledWith(expect.anything(), "user-1");
  });

  it("never deletes an account without an explicit confirmation", async () => {
    const { app, deps, env } = appWith({});

    for (const confirmation of [undefined, "delete", "DELETE_MY_ACCOUNT_NOW"]) {
      const response = await app.request("/v1/me", deleteAccount(confirmation), env);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "DELETE_CONFIRMATION_REQUIRED",
          message: "Confirm account deletion to continue.",
        },
      });
    }
    expect(deps.deleteAvatar).not.toHaveBeenCalled();
    expect(deps.deleteAccount).not.toHaveBeenCalled();
  });

  it("removes account data but keeps the credentials only after confirmation", async () => {
    const order: string[] = [];
    const { app, deps, env } = appWith({
      deleteAvatar: vi.fn(async () => order.push("avatar")),
      deleteAccountData: vi.fn(async () => order.push("data")),
    }, { AVATARS: {} as R2Bucket });

    const rejected = await app.request("/v1/me/data", deleteData(), env);
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toEqual({
      error: {
        code: "DELETE_DATA_CONFIRMATION_REQUIRED",
        message: "Confirm data deletion to continue.",
      },
    });

    const response = await app.request("/v1/me/data", deleteData("DELETE_MY_DATA"), env);
    expect(response.status).toBe(204);
    expect(order).toEqual(["avatar", "data"]);
    expect(deps.deleteAccountData).toHaveBeenCalledWith(expect.anything(), "user-1");
    expect(deps.deleteAccount).not.toHaveBeenCalled();
  });
});
