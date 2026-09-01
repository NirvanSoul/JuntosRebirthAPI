import { Hono, type MiddlewareHandler } from "hono";
import { createDb } from "../db/client";
import { errorResponse } from "../lib/http";
import { parseBody } from "../lib/validation";
import type { AuthVariables } from "../middleware/auth";
import {
  requireActiveSpaceMember,
  type SpaceAccessVariables,
} from "../middleware/space-access";
import * as service from "../services/members";
import type { Bindings } from "../types/env";

type Env = { Bindings: Bindings; Variables: AuthVariables & SpaceAccessVariables };
type Deps = typeof service & { createDb: typeof createDb };
const defaults: Deps = { createDb, ...service };

const ROLES = ["owner", "admin", "member"] as const;
type Role = (typeof ROLES)[number];

export function createMembersRoute(
  deps: Deps = defaults,
  access: MiddlewareHandler<Env> = requireActiveSpaceMember,
) {
  const route = new Hono<Env>();
  route.use("*", access);

  route.get("/", async (c) => {
    try {
      const members = await deps.listMembers(
        deps.createDb(c.env.DATABASE_URL),
        c.req.param("spaceId")!,
      );
      return c.json({ data: { members } });
    } catch {
      return errorResponse(c, "INTERNAL_SERVER_ERROR");
    }
  });

  route.patch("/:memberId/role", async (c) => {
    const body = await parseBody(c.req.raw, ["role"]);
    if (!body || !ROLES.includes(body.role as Role)) {
      return errorResponse(c, "INVALID_REQUEST");
    }

    try {
      const updated = await deps.setMemberRole(deps.createDb(c.env.DATABASE_URL), {
        spaceId: c.req.param("spaceId")!,
        actorId: c.get("currentUserId"),
        memberId: c.req.param("memberId")!,
        role: body.role as Role,
      });
      return updated
        ? c.json({ data: { updated: true } })
        : errorResponse(c, "MEMBER_ROLE_CHANGE_REJECTED");
    } catch {
      return errorResponse(c, "INTERNAL_SERVER_ERROR");
    }
  });

  route.delete("/:memberId", async (c) => {
    try {
      const removed = await deps.removeMember(deps.createDb(c.env.DATABASE_URL), {
        spaceId: c.req.param("spaceId")!,
        actorId: c.get("currentUserId"),
        memberId: c.req.param("memberId")!,
      });
      return removed
        ? c.json({ data: { removed: true } })
        : errorResponse(c, "MEMBER_REMOVAL_REJECTED");
    } catch {
      return errorResponse(c, "INTERNAL_SERVER_ERROR");
    }
  });

  route.post("/leave", async (c) => {
    try {
      const left = await deps.leaveSpace(deps.createDb(c.env.DATABASE_URL), {
        spaceId: c.req.param("spaceId")!,
        userId: c.get("currentUserId"),
      });
      return left
        ? c.json({ data: { left: true } })
        : errorResponse(c, "OWNER_MUST_TRANSFER");
    } catch {
      return errorResponse(c, "INTERNAL_SERVER_ERROR");
    }
  });

  return route;
}
