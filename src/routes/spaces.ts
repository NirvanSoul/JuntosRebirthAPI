import { Hono, type Context } from "hono";
import { normalizeCurrency } from "../lib/currency";
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
      return internalError(c);
    }
  });

  route.post("/", async (c) => {
    const input = await parseCreateSpaceInput(c.req.raw);

    if (!input) {
      return c.json(
        {
          error: {
            code: "INVALID_REQUEST",
            message: "Invalid request.",
          },
        },
        400,
      );
    }

    try {
      const db = dependencies.createDb(c.env.DATABASE_URL);
      const space = await dependencies.createSpaceWithOwner(
        db,
        c.get("currentUserId"),
        input,
      );

      return c.json({ data: { space } }, 201);
    } catch {
      return internalError(c);
    }
  });

  return route;
}

export const spacesRoute = createSpacesRoute();

async function parseCreateSpaceInput(
  request: Request,
): Promise<CreateSpaceInput | null> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return null;
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) return null;

  const { name, type, currency } = body as Record<string, unknown>;
  const normalizedName = typeof name === "string" ? name.trim() : "";
  const normalizedCurrency = normalizeCurrency(currency);

  if (
    normalizedName.length === 0 ||
    normalizedName.length > 80 ||
    (type !== "personal" && type !== "couple" && type !== "other") ||
    !normalizedCurrency
  ) {
    return null;
  }

  return { name: normalizedName, type, currency: normalizedCurrency };
}

function internalError(c: Context<SpacesEnvironment>) {
  return c.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal error.",
      },
    },
    500,
  );
}
