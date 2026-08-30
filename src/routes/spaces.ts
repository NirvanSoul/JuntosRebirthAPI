import { Hono } from "hono";
import { errorResponse } from "../lib/http";
import { isUniqueViolation } from "../lib/pg";
import { boundedString, parseBody } from "../lib/validation";
import { normalizeCurrency } from "../lib/currency";
import { normalizeTimeZone } from "../lib/timezone";
import {
  createSpaceWithOwner,
  createSpacesService,
  listActiveSpaces,
  type CreateSpaceInput,
} from "../services/spaces";
import type { AuthVariables } from "../middleware/auth";
import type { Bindings } from "../types/env";

type SpacesEnvironment = {
  Bindings: Bindings;
  Variables: AuthVariables;
};

type SpacesDependencies = {
  createDb: typeof createSpacesService;
  listActiveSpaces: typeof listActiveSpaces;
  createSpaceWithOwner: typeof createSpaceWithOwner;
};

const defaultDependencies: SpacesDependencies = {
  createDb: createSpacesService,
  listActiveSpaces,
  createSpaceWithOwner,
};

export function createSpacesRoute(
  dependencies: SpacesDependencies = defaultDependencies,
) {
  const route = new Hono<SpacesEnvironment>();

  route.get("/", async (c) => {
    try {
      const db = dependencies.createDb(c.env.DATABASE_URL);
      const spaces = await dependencies.listActiveSpaces(
        db,
        c.get("currentUserId"),
      );

      return c.json({ data: { spaces } });
    } catch {
      return errorResponse(c, "INTERNAL_ERROR");
    }
  });

  route.post("/", async (c) => {
    const input = await parseCreateSpaceInput(c.req.raw);

    if (!input) {
      return errorResponse(c, "INVALID_REQUEST");
    }

    try {
      const db = dependencies.createDb(c.env.DATABASE_URL);
      const space = await dependencies.createSpaceWithOwner(
        db,
        c.get("currentUserId"),
        input,
      );

      return c.json({ data: { space } }, 201);
    } catch (error) {
      // Solo se admite un espacio de pareja activo por persona; el índice
      // parcial es quien lo garantiza, así que aquí se traduce su choque.
      if (isUniqueViolation(error, "spaces_one_active_couple_per_creator_idx")) {
        return errorResponse(c, "COUPLE_SPACE_LIMIT");
      }
      return errorResponse(c, "INTERNAL_ERROR");
    }
  });

  return route;
}

export const spacesRoute = createSpacesRoute();

async function parseCreateSpaceInput(
  request: Request,
): Promise<CreateSpaceInput | null> {
  const body = await parseBody(request, ["name", "type", "currency", "timezone"]);
  if (!body) return null;

  const { name, type, currency, timezone } = body;
  const normalizedName = boundedString(name, 80);
  const normalizedCurrency = normalizeCurrency(currency);
  const normalizedTimezone = normalizeTimeZone(timezone);

  if (
    !normalizedName ||
    (type !== "personal" && type !== "couple" && type !== "other") ||
    !normalizedCurrency ||
    !normalizedTimezone
  ) {
    return null;
  }

  return { name: normalizedName, type, currency: normalizedCurrency, timezone: normalizedTimezone };
}
