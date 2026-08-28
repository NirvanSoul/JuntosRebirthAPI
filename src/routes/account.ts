import { Hono, type Context } from "hono";
import { normalizeCurrency } from "../lib/currency";
import { normalizeTimeZone } from "../lib/timezone";
import { createDb } from "../db/client";
import type { AuthVariables } from "../middleware/auth";
import type { Bindings } from "../types/env";
import * as service from "../services/account";

type Env = { Bindings: Bindings; Variables: AuthVariables };
type Dependencies = typeof service & { createDb: typeof createDb };
const defaults: Dependencies = { createDb, ...service };

export function createAccountRoute(deps: Dependencies = defaults) {
  const route = new Hono<Env>();

  route.post("/bootstrap", async (c) => {
    const input = await parseBootstrap(c.req.raw);
    if (!input) return invalid(c);
    try {
      const db = deps.createDb(c.env.DATABASE_URL);
      const currentUser = await deps.findCurrentUser(db, c.get("currentUserId"));
      if (!currentUser) return unauthorized(c);
      const result = await deps.bootstrapAccount(db, currentUser, input.timezone);
      return c.json({ data: { user: currentUser, ...result } });
    } catch {
      return internal(c);
    }
  });

  route.get("/me", async (c) => {
    try {
      const db = deps.createDb(c.env.DATABASE_URL);
      const currentUser = await deps.findCurrentUser(db, c.get("currentUserId"));
      if (!currentUser) return unauthorized(c);
      const state = await deps.getAccountState(db, currentUser.id);
      return c.json({
        data: {
          user: currentUser,
          profile: state.profile,
          personalSpaceId: state.personalSpaceId,
          bootstrapRequired: !state.profile || !state.personalSpaceId,
        },
      });
    } catch {
      return internal(c);
    }
  });

  route.patch("/me/profile", async (c) => {
    const input = await parseProfile(c.req.raw);
    if (!input) return invalid(c);
    try {
      const profile = await deps.updateProfile(
        deps.createDb(c.env.DATABASE_URL),
        c.get("currentUserId"),
        input,
      );
      if (!profile) return c.json({ error: { code: "PROFILE_NOT_FOUND", message: "Run bootstrap first." } }, 409);
      return c.json({ data: { profile } });
    } catch {
      return internal(c);
    }
  });

  return route;
}

export const accountRoute = createAccountRoute();

async function objectBody(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    const body: unknown = JSON.parse(text);
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function permitted(body: Record<string, unknown>, fields: string[]) {
  return Object.keys(body).every((key) => fields.includes(key));
}

async function parseBootstrap(request: Request) {
  const body = await objectBody(request);
  if (!body || !permitted(body, ["timezone"])) return null;
  if (body.timezone === undefined) return { timezone: "UTC" };
  const timezone = normalizeTimeZone(body.timezone);
  return timezone ? { timezone } : null;
}

async function parseProfile(request: Request) {
  const body = await objectBody(request);
  if (!body || !permitted(body, ["displayName", "locale", "defaultCurrency"])) return null;
  const input: Partial<Pick<service.Profile, "displayName" | "locale" | "defaultCurrency">> = {};
  if (body.displayName !== undefined) {
    if (typeof body.displayName !== "string") return null;
    const displayName = body.displayName.trim();
    if (!displayName || displayName.length > 80) return null;
    input.displayName = displayName;
  }
  if (body.locale !== undefined) {
    if (typeof body.locale !== "string" || !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(body.locale)) return null;
    input.locale = body.locale;
  }
  if (body.defaultCurrency !== undefined) {
    const currency = normalizeCurrency(body.defaultCurrency);
    if (!currency) return null;
    input.defaultCurrency = currency;
  }
  return Object.keys(input).length ? input : null;
}

function invalid(c: Context<Env>) {
  return c.json({ error: { code: "INVALID_REQUEST", message: "Invalid request." } }, 400);
}
function unauthorized(c: Context<Env>) {
  return c.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized." } }, 401);
}
function internal(c: Context<Env>) {
  return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal error." } }, 500);
}
