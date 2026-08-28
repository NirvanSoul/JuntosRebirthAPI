import { Hono } from "hono";
import { drizzle } from "drizzle-orm/neon-http";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import type { AuthVariables } from "../src/middleware/auth";
import {
  createRequireActiveSpaceMember,
  type SpaceAccessVariables,
} from "../src/middleware/space-access";
import { buildActiveSpaceMembershipQuery } from "../src/services/space-access";
import type { Bindings } from "../src/types/env";

const bindings = { DATABASE_URL: "postgresql://user:pass@ep-test.neon.tech/neondb" } as Bindings;

function protectedApp(lookup: ReturnType<typeof vi.fn>) {
  const testApp = new Hono<{
    Bindings: Bindings;
    Variables: AuthVariables & SpaceAccessVariables;
  }>();
  testApp.use("*", async (c, next) => {
    c.set("currentUserId", "user-1");
    await next();
  });
  testApp.use(
    "/v1/spaces/:spaceId/*",
    createRequireActiveSpaceMember({
      createDb: () => ({} as Database),
      findActiveSpaceMembership: lookup,
    }),
  );
  testApp.get("/v1/spaces/:spaceId/categories", (c) =>
    c.json({ data: { role: c.get("activeSpaceMembership").role } }),
  );
  return testApp;
}

describe("Active space membership", () => {
  it("queries the requested space, authenticated user, active status, and non-archived space", () => {
    const db = drizzle.mock() as unknown as Database;
    const { sql, params } = buildActiveSpaceMembershipQuery(db, "user-1", "space-1").toSQL();

    expect(sql).toContain('"space_members"."space_id" = $1');
    expect(sql).toContain('"space_members"."user_id" = $2');
    expect(sql).toContain('"space_members"."status" = $3');
    expect(sql).toContain('"spaces"."archived_at" is null');
    expect(params).toEqual(["space-1", "user-1", "active", 1]);
  });

  it.each(["no membership", "left membership", "archived space"])(
    "returns 404 for %s without revealing the space",
    async () => {
      const testApp = protectedApp(vi.fn().mockResolvedValue(null));
      const response = await testApp.request(
        "/v1/spaces/space-1/categories",
        {},
        bindings,
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: { code: "SPACE_NOT_FOUND", message: "Space not found." },
      });
    },
  );

  it("makes the active role available to future authorization rules", async () => {
    const testApp = protectedApp(
      vi.fn().mockResolvedValue({ spaceId: "space-1", role: "admin" }),
    );
    const response = await testApp.request(
      "/v1/spaces/space-1/categories",
      {},
      bindings,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { role: "admin" } });
  });
});
