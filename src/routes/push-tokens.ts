import { Hono } from "hono";
import { createDb } from "../db/client";
import { errorResponse } from "../lib/http";
import { parseBody } from "../lib/validation";
import type { AuthVariables } from "../middleware/auth";
import {
  isExpoPushToken,
  registerPushToken,
  unregisterPushToken,
  type PushPlatform,
} from "../services/push";
import type { Bindings } from "../types/env";

type Env = { Bindings: Bindings; Variables: AuthVariables };
type Deps = {
  createDb: typeof createDb;
  registerPushToken: typeof registerPushToken;
  unregisterPushToken: typeof unregisterPushToken;
};

const defaults: Deps = { createDb, registerPushToken, unregisterPushToken };
const PLATFORMS = ["ios", "android"] as const;

export function createPushTokensRoute(deps: Deps = defaults) {
  const route = new Hono<Env>();

  route.post("/", async (c) => {
    const body = await parseBody(c.req.raw, ["expoPushToken", "platform"]);
    if (
      !body ||
      !isExpoPushToken(body.expoPushToken) ||
      !PLATFORMS.includes(body.platform as PushPlatform)
    ) {
      return errorResponse(c, "INVALID_REQUEST");
    }

    try {
      await deps.registerPushToken(deps.createDb(c.env.DATABASE_URL), c.get("currentUserId"), {
        expoPushToken: body.expoPushToken,
        platform: body.platform as PushPlatform,
      });
      return c.json({ data: { registered: true } }, 201);
    } catch (error) {
      console.error("Push token registration failed:", error);
      return errorResponse(c, "INTERNAL_SERVER_ERROR");
    }
  });

  route.delete("/", async (c) => {
    const body = await parseBody(c.req.raw, ["expoPushToken"]);
    if (!body || !isExpoPushToken(body.expoPushToken)) {
      return errorResponse(c, "INVALID_REQUEST");
    }

    try {
      await deps.unregisterPushToken(
        deps.createDb(c.env.DATABASE_URL),
        c.get("currentUserId"),
        body.expoPushToken,
      );
      return c.body(null, 204);
    } catch (error) {
      console.error("Push token removal failed:", error);
      return errorResponse(c, "INTERNAL_SERVER_ERROR");
    }
  });

  return route;
}
