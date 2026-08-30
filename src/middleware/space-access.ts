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
      return errorResponse(c, "SPACE_NOT_FOUND", "Space not found.");
    }

    try {
      const membership = await dependencies.findActiveSpaceMembership(
        dependencies.createDb(c.env.DATABASE_URL),
        c.get("currentUserId"),
        spaceId,
      );

      if (!membership) {
        return errorResponse(c, "SPACE_NOT_FOUND", "Space not found.");
      }

      c.set("activeSpaceMembership", membership);
      await next();
    } catch (error) {
      console.error("requireActiveSpaceMember failed:", error);
      return errorResponse(c, "INTERNAL_ERROR", "Internal error.");
    }
  });
}

export const requireActiveSpaceMember = createRequireActiveSpaceMember();

const ROLE_RANK: Record<ActiveSpaceMembership["role"], number> = {
  owner: 3,
  admin: 2,
  member: 1,
};

export function hasSpaceRole(
  role: ActiveSpaceMembership["role"],
  minimum: ActiveSpaceMembership["role"],
): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/**
 * Exige un rol mínimo sobre el espacio ya resuelto por
 * `requireActiveSpaceMember`, que debe ejecutarse antes.
 *
 * Solo se aplica a operaciones estructurales del espacio (editarlo,
 * archivarlo, gestionar miembros). El ledger — categorías, cuentas y
 * movimientos — queda abierto a cualquier miembro activo: en un espacio de
 * pareja el invitado entra siempre como `member` y debe poder gestionar el
 * dinero compartido igual que quien creó el espacio.
 */
export function requireSpaceRole(minimum: ActiveSpaceMembership["role"]) {
  return createMiddleware<{
    Bindings: Bindings;
    Variables: AuthVariables & SpaceAccessVariables;
  }>(async (c, next) => {
    if (!hasSpaceRole(c.get("activeSpaceMembership").role, minimum)) {
      return errorResponse(c, "FORBIDDEN", "Insufficient role.");
    }

    await next();
  });
}
