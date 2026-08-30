import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import { createRequireAuth, type AuthVariables } from "../src/middleware/auth";
import { createPushTokensRoute } from "../src/routes/push-tokens";
import { isExpoPushToken, sendPush } from "../src/services/push";
import type { Bindings } from "../src/types/env";

const TOKEN = "ExponentPushToken[abc123]";

function appWith(overrides: Record<string, unknown> = {}) {
  const deps = {
    createDb: vi.fn(() => ({}) as Database),
    registerPushToken: vi.fn().mockResolvedValue(undefined),
    unregisterPushToken: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as NonNullable<Parameters<typeof createPushTokensRoute>[0]>;

  const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  app.use("*", createRequireAuth(async () => ({ userId: "user-1" })));
  app.route("/v1/me/push-tokens", createPushTokensRoute(deps));
  return { app, deps, env: { DATABASE_URL: "postgres://x" } as Bindings };
}

function json(method: string, body: unknown) {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

describe("expo push tokens", () => {
  it("accepts both token spellings and rejects anything else", () => {
    expect(isExpoPushToken(TOKEN)).toBe(true);
    expect(isExpoPushToken("ExpoPushToken[xyz]")).toBe(true);
    expect(isExpoPushToken("not-a-token")).toBe(false);
    expect(isExpoPushToken(null)).toBe(false);
  });

  it("registers a token for the session user", async () => {
    const { app, deps, env } = appWith();

    const response = await app.request(
      "/v1/me/push-tokens",
      json("POST", { expoPushToken: TOKEN, platform: "ios" }),
      env,
    );

    expect(response.status).toBe(201);
    expect(deps.registerPushToken).toHaveBeenCalledWith(expect.anything(), "user-1", {
      expoPushToken: TOKEN,
      platform: "ios",
    });
  });

  it("rejects an unknown platform", async () => {
    const { app, deps, env } = appWith();

    const response = await app.request(
      "/v1/me/push-tokens",
      json("POST", { expoPushToken: TOKEN, platform: "web" }),
      env,
    );

    expect(response.status).toBe(400);
    expect(deps.registerPushToken).not.toHaveBeenCalled();
  });

  it("only unregisters a token that belongs to the session user", async () => {
    const { app, deps, env } = appWith();

    const response = await app.request(
      "/v1/me/push-tokens",
      json("DELETE", { expoPushToken: TOKEN }),
      env,
    );

    expect(response.status).toBe(204);
    expect(deps.unregisterPushToken).toHaveBeenCalledWith(expect.anything(), "user-1", TOKEN);
  });
});

describe("sending push notifications", () => {
  function databaseCountingDeletes(counter: { calls: number }) {
    return {
      delete: () => ({
        where: () => {
          counter.calls += 1;
          return Promise.resolve();
        },
      }),
    } as unknown as Database;
  }

  it("does nothing without recipients", async () => {
    const fetcher = vi.fn();

    const result = await sendPush({} as Database, [], { title: "x", body: "y" }, fetcher);

    expect(result).toEqual({ delivered: 0, removed: 0 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("drops tokens that Expo reports as unregistered", async () => {
    const deletes = { calls: 0 };
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ status: "ok" }, { status: "error", details: { error: "DeviceNotRegistered" } }],
        }),
        { status: 200 },
      ),
    );

    const result = await sendPush(
      databaseCountingDeletes(deletes),
      [TOKEN, "ExponentPushToken[stale]"],
      { title: "x", body: "y" },
      fetcher,
    );

    // Reintentar un token muerto en cada invitación no arregla nada.
    expect(result).toEqual({ delivered: 1, removed: 1 });
    expect(deletes.calls).toBe(1);
  });

  it("swallows a transport failure instead of breaking the caller", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("offline"));

    await expect(
      sendPush({} as Database, [TOKEN], { title: "x", body: "y" }, fetcher),
    ).resolves.toEqual({ delivered: 0, removed: 0 });
  });
});
