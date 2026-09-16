import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { errorResponse } from "../src/lib/http";
import type { AuthVariables } from "../src/middleware/auth";
import type { SpaceAccessVariables } from "../src/middleware/space-access";
import { createMembersRoute } from "../src/routes/members";
import * as membersService from "../src/services/members";
import type { Bindings } from "../src/types/env";

const bindings = { DATABASE_URL: "postgresql://example.test/db" } as Bindings;
const updatedAt = new Date("2026-09-16T12:30:45.123Z");

function createTestApp(allowed: boolean) {
  const listMembers = vi.fn().mockResolvedValue([
    {
      id: "membership-ana",
      userId: "user-ana",
      role: "owner",
      displayName: "Ana",
      image: "legacy-image",
      avatarPath: "user-ana/avatar.jpg",
      avatarUpdatedAt: updatedAt,
      defaultCurrency: "EUR",
      joinedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    {
      id: "membership-beto",
      userId: "user-beto",
      role: "member",
      displayName: null,
      image: null,
      avatarPath: null,
      avatarUpdatedAt: null,
      defaultCurrency: null,
      joinedAt: new Date("2026-01-02T00:00:00.000Z"),
    },
  ] satisfies membersService.Member[]);
  const route = createMembersRoute(
    { ...membersService, createDb: vi.fn(() => ({} as never)), listMembers },
    async (c, next) => {
      if (!allowed) return errorResponse(c, "SPACE_NOT_FOUND", "Space not found.");
      c.set("activeSpaceMembership", { spaceId: c.req.param("spaceId")!, role: "member" });
      await next();
    },
  );
  const app = new Hono<{
    Bindings: Bindings;
    Variables: AuthVariables & SpaceAccessVariables;
  }>();
  app.use("*", async (c, next) => {
    c.set("currentUserId", "user-beto");
    await next();
  });
  app.route("/v1/spaces/:spaceId/members", route);
  return { app, listMembers };
}

describe("space member profiles", () => {
  it("returns exactly the current profile fields consumed by the app", async () => {
    const { app } = createTestApp(true);

    const response = await app.request("/v1/spaces/space-1/members", {}, bindings);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        members: [
          {
            userId: "user-ana",
            displayName: "Ana",
            avatarPath: "user-ana/avatar.jpg",
            avatarUpdatedAt: "2026-09-16T12:30:45.123Z",
            defaultCurrency: "EUR",
          },
          {
            userId: "user-beto",
            displayName: null,
            avatarPath: null,
            avatarUpdatedAt: null,
            defaultCurrency: null,
          },
        ],
      },
    });
  });

  it("does not expose the census to someone without active access", async () => {
    const { app, listMembers } = createTestApp(false);

    const response = await app.request("/v1/spaces/space-1/members", {}, bindings);

    expect(response.status).toBe(404);
    expect(listMembers).not.toHaveBeenCalled();
  });
});
