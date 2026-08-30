import { Hono } from "hono";
import { errorResponse } from "../lib/http";
import { boundedString, nullableString, parseBody } from "../lib/validation";
import { normalizeCurrency } from "../lib/currency";
import { normalizeTimeZone } from "../lib/timezone";
import { createDb } from "../db/client";
import type { AuthVariables } from "../middleware/auth";
import type { Bindings } from "../types/env";
import * as service from "../services/account";
import {
  deleteAccount,
  exportAccount,
  recordLegalAcceptance,
} from "../services/account-lifecycle";
import { deleteAvatar } from "../services/avatars";

type Env = { Bindings: Bindings; Variables: AuthVariables };
type Dependencies = typeof service & {
  createDb: typeof createDb;
  recordLegalAcceptance: typeof recordLegalAcceptance;
  exportAccount: typeof exportAccount;
  deleteAccount: typeof deleteAccount;
  deleteAvatar: typeof deleteAvatar;
};
const defaults: Dependencies = {
  createDb,
  ...service,
  recordLegalAcceptance,
  exportAccount,
  deleteAccount,
  deleteAvatar,
};

const LEGAL_DOCUMENTS = ["privacy-policy", "terms-of-service"] as const;

export function createAccountRoute(deps: Dependencies = defaults) {
  const route = new Hono<Env>();

  route.post("/bootstrap", async (c) => {
    const input = await parseBootstrap(c.req.raw);
    if (!input) return errorResponse(c, "INVALID_REQUEST");
    try {
      const db = deps.createDb(c.env.DATABASE_URL);
      const currentUser = await deps.findCurrentUser(db, c.get("currentUserId"));
      if (!currentUser) return errorResponse(c, "UNAUTHORIZED");
      const result = await deps.bootstrapAccount(db, currentUser, input.timezone);
      return c.json({ data: { user: currentUser, ...result } });
    } catch {
      return errorResponse(c, "INTERNAL_ERROR");
    }
  });

  route.get("/me", async (c) => {
    try {
      const db = deps.createDb(c.env.DATABASE_URL);
      const currentUser = await deps.findCurrentUser(db, c.get("currentUserId"));
      if (!currentUser) return errorResponse(c, "UNAUTHORIZED");
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
      return errorResponse(c, "INTERNAL_ERROR");
    }
  });

  route.patch("/me/profile", async (c) => {
    const input = await parseProfile(c.req.raw);
    if (!input) return errorResponse(c, "INVALID_REQUEST");
    try {
      const profile = await deps.updateProfile(
        deps.createDb(c.env.DATABASE_URL),
        c.get("currentUserId"),
        input,
      );
      if (!profile) return errorResponse(c, "PROFILE_NOT_FOUND");
      return c.json({ data: { profile } });
    } catch {
      return errorResponse(c, "INTERNAL_ERROR");
    }
  });

  route.post("/me/legal-acceptances", async (c) => {
    const input = await parseLegalAcceptance(c.req.raw);
    if (!input) return errorResponse(c, "INVALID_REQUEST");

    try {
      const acceptance = await deps.recordLegalAcceptance(
        deps.createDb(c.env.DATABASE_URL),
        c.get("currentUserId"),
        input,
      );
      return c.json({ data: { acceptance } }, 201);
    } catch {
      return errorResponse(c, "INTERNAL_ERROR");
    }
  });

  route.get("/me/export", async (c) => {
    try {
      const data = await deps.exportAccount(
        deps.createDb(c.env.DATABASE_URL),
        c.get("currentUserId"),
      );
      return c.json({ data });
    } catch (error) {
      console.error("Account export failed:", error);
      return errorResponse(c, "INTERNAL_ERROR");
    }
  });

  route.delete("/me", async (c) => {
    const userId = c.get("currentUserId");
    try {
      // El avatar vive fuera de PostgreSQL, así que no lo alcanza el cascade.
      if (c.env.AVATARS) {
        await deps.deleteAvatar(deps.createDb(c.env.DATABASE_URL), c.env.AVATARS, userId);
      }
      await deps.deleteAccount(deps.createDb(c.env.DATABASE_URL), userId);
      return c.body(null, 204);
    } catch (error) {
      console.error("Account deletion failed:", error);
      return errorResponse(c, "INTERNAL_ERROR");
    }
  });

  return route;
}

export const accountRoute = createAccountRoute();

async function parseLegalAcceptance(request: Request) {
  const body = await parseBody(request, [
    "documentType",
    "documentVersion",
    "appVersion",
    "locale",
    "source",
  ]);
  if (!body) return null;

  const documentType = body.documentType;
  const documentVersion = boundedString(body.documentVersion, 40);
  if (!LEGAL_DOCUMENTS.includes(documentType as (typeof LEGAL_DOCUMENTS)[number])) return null;
  if (!documentVersion) return null;

  // Los campos opcionales se leen con la guardia `in`, igual que en el resto
  // de routers: ausente significa null, pero un tipo inválido invalida la
  // petición. Antes se colaba como null, y un registro de consentimiento que
  // pierde en silencio la versión de la app o el locale no prueba gran cosa.
  const optional = (key: "appVersion" | "locale" | "source", max: number) => {
    if (!(key in body)) return null;
    return nullableString(body[key], max);
  };
  const appVersion = optional("appVersion", 40);
  const locale = optional("locale", 16);
  const source = optional("source", 40);
  if (appVersion === undefined || locale === undefined || source === undefined) return null;

  return {
    documentType: documentType as (typeof LEGAL_DOCUMENTS)[number],
    documentVersion,
    appVersion,
    locale,
    source,
  };
}


async function parseBootstrap(request: Request) {
  const body = await parseBody(request, ["timezone"]);
  if (!body) return null;
  if (body.timezone === undefined) return { timezone: "UTC" };
  const timezone = normalizeTimeZone(body.timezone);
  return timezone ? { timezone } : null;
}

async function parseProfile(request: Request) {
  const body = await parseBody(request, ["displayName", "locale", "defaultCurrency"]);
  if (!body) return null;
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
