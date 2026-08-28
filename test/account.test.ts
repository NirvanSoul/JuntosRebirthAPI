import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { createRequireAuth, type AuthVariables } from "../src/middleware/auth";
import { createAccountRoute } from "../src/routes/account";
import type { Bindings } from "../src/types/env";
import type * as account from "../src/services/account";

const bindings: Bindings = {
  DATABASE_URL: "postgresql://user:pass@ep-test.neon.tech/neondb",
  BETTER_AUTH_SECRET: "test-secret-min-32-chars-long-example-12345",
  BETTER_AUTH_URL: "https://juntos.test",
  GOOGLE_CLIENT_ID: "mock-google-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "mock-google-client-secret",
};

const currentUser = { id: "user-1", name: "Ada", email: "ada@example.com", image: null };
const profile = { displayName: "Ada", locale: "es", defaultCurrency: "EUR", avatarPath: null };
const personalSpace = { id: "space-1", name: "Personal", type: "personal" as const, currency: "EUR", timezone: "Europe/Madrid", role: "owner" as const };

function createTestApp(userId = "user-1") {
  const bootstrapAccount = vi.fn().mockResolvedValue({
    profile,
    personalSpace,
    created: { profile: true, personalSpace: true },
  });
  const deps = {
    createDb: vi.fn(() => ({})),
    findCurrentUser: vi.fn().mockResolvedValue(currentUser),
    bootstrapAccount,
    getAccountState: vi.fn().mockResolvedValue({ profile, personalSpaceId: "space-1" }),
    updateProfile: vi.fn().mockResolvedValue(profile),
  } as unknown as typeof account & { createDb: () => unknown };
  const testApp = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  testApp.use("/v1/*", createRequireAuth(async () => (userId ? { userId } : null)));
  testApp.route("/v1", createAccountRoute(deps as never));
  return { testApp, deps: deps as unknown as { bootstrapAccount: ReturnType<typeof vi.fn>; updateProfile: ReturnType<typeof vi.fn> } };
}

describe("Account routes", () => {
  it("requires a session for bootstrap and me", async () => {
    expect((await app.request("/v1/bootstrap", { method: "POST" })).status).toBe(401);
    expect((await app.request("/v1/me")).status).toBe(401);
  });

  it("bootstraps only the authenticated user and accepts an initial IANA timezone", async () => {
    const { testApp, deps } = createTestApp();
    const response = await testApp.request("/v1/bootstrap", {
      method: "POST",
      body: JSON.stringify({ timezone: "Europe/Madrid" }),
    }, bindings);

    expect(response.status).toBe(200);
    expect(deps.bootstrapAccount).toHaveBeenCalledWith(expect.anything(), currentUser, "Europe/Madrid");
    await expect(response.json()).resolves.toMatchObject({
      data: { user: { id: "user-1" }, personalSpace: { role: "owner" }, created: { personalSpace: true } },
    });
  });

  it.each(["GMT+2", "not/a-zone", ""])('rejects invalid bootstrap timezone %j', async (timezone) => {
    const { testApp, deps } = createTestApp();
    const response = await testApp.request("/v1/bootstrap", { method: "POST", body: JSON.stringify({ timezone }) }, bindings);
    expect(response.status).toBe(400);
    expect(deps.bootstrapAccount).not.toHaveBeenCalled();
  });

  it("rejects client-supplied user IDs", async () => {
    const { testApp, deps } = createTestApp();
    const response = await testApp.request("/v1/bootstrap", { method: "POST", body: JSON.stringify({ userId: "other-user" }) }, bindings);
    expect(response.status).toBe(400);
    expect(deps.bootstrapAccount).not.toHaveBeenCalled();
  });

  it("returns the account state through GET /v1/me", async () => {
    const { testApp } = createTestApp();
    const response = await testApp.request("/v1/me", {}, bindings);
    await expect(response.json()).resolves.toEqual({
      data: { user: currentUser, profile, personalSpaceId: "space-1", bootstrapRequired: false },
    });
  });

  it("only permits product profile fields", async () => {
    const { testApp, deps } = createTestApp();
    const invalid = await testApp.request("/v1/me/profile", { method: "PATCH", body: JSON.stringify({ email: "new@example.com" }) }, bindings);
    expect(invalid.status).toBe(400);
    const valid = await testApp.request("/v1/me/profile", { method: "PATCH", body: JSON.stringify({ displayName: " Ada Lovelace ", defaultCurrency: "usd" }) }, bindings);
    expect(valid.status).toBe(200);
    expect(deps.updateProfile).toHaveBeenCalledWith(expect.anything(), "user-1", { displayName: "Ada Lovelace", defaultCurrency: "USD" });
  });
});
