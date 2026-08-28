import { createMiddleware } from "hono/factory";
import { errorResponse } from "../lib/http";
import type { AuthVariables } from "./auth";
import {
  createSpaceAccessService,
  findActiveSpaceMembership,
  type ActiveSpaceMembership,
} from "../services/space-access";
import type { Bindings } from "../types/env";

export type SpaceAccessVariables = {
  activeSpaceMembership: ActiveSpaceMembership;
};

type SpaceAccessDependencies = {
  createDb: typeof createSpaceAccessService;
  findActiveSpaceMembership: typeof findActiveSpaceMembership;
};

const defaultDependencies: SpaceAccessDependencies = {
  createDb: createSpaceAccessService,
  findActiveSpaceMembership,
};

export function createRequireActiveSpaceMember(
  dependencies: SpaceAccessDependencies = defaultDependencies,
) {
  return createMiddleware<{
    Bindings: Bindings;
    Variables: AuthVariables & SpaceAccessVariables;
  }>(async (c, next) => {
    const spaceId = c.req.param("spaceId");

    if (!spaceId) {
      return errorResponse(c, 404, "SPACE_NOT_FOUND", "Space not found.");
    }

    try {
      const membership = await dependencies.findActiveSpaceMembership(
        dependencies.createDb(c.env.DATABASE_URL),
        c.get("currentUserId"),
        spaceId,
      );

      if (!membership) {
        return errorResponse(c, 404, "SPACE_NOT_FOUND", "Space not found.");
      }

      c.set("activeSpaceMembership", membership);
      await next();
    } catch {
      return errorResponse(c, 500, "INTERNAL_ERROR", "Internal error.");
    }
  });
}

export const requireActiveSpaceMember = createRequireActiveSpaceMember();
