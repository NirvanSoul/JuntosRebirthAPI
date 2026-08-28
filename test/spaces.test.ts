import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/neon-http";
import app from "../src/index";
import { createRequireAuth, type AuthVariables } from "../src/middleware/auth";
import { createSpacesRoute } from "../src/routes/spaces";
import {
  buildListActiveSpacesQuery,
  createSpaceWithOwner,
  type SpaceSummary,
} from "../src/services/spaces";
import type { Database } from "../src/db/client";
import type { Bindings } from "../src/types/env";

const bindings: Bindings = {
  DATABASE_URL: "postgresql://user:pass@ep-test.neon.tech/neondb",
  BETTER_AUTH_SECRET: "test-secret-min-32-chars-long-example-12345",
  BETTER_AUTH_URL: "https://juntos.test",
  GOOGLE_CLIENT_ID: "mock-google-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "mock-google-client-secret",
};

const space: SpaceSummary = {
  id: "space-1",
  name: "Personal",
  type: "personal",
  currency: "EUR",
  timezone: "Europe/Madrid",
  role: "owner",
  activatedAt: new Date("2026-08-28T10:00:00.000Z"),
  createdAt: new Date("2026-08-28T10:00:00.000Z"),
};

function createTestApp(options: {
  userId?: string;
  listedSpaces?: SpaceSummary[];
  onCreate?: (userId: string, input: unknown) => SpaceSummary;
}) {
  const testApp = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  testApp.use(
    "/v1/*",
    createRequireAuth(async () =>
      options.userId ? { userId: options.userId } : null,
    ),
  );
  testApp.route(
    "/v1/spaces",
    createSpacesRoute({
      createDb: () => ({} as Database),
      listActiveSpaces: vi.fn().mockResolvedValue(options.listedSpaces ?? []),
      createSpaceWithOwner: vi.fn().mockImplementation((_db, userId, input) =>
        Promise.resolve(
          options.onCreate?.(userId, input) ?? {
            ...space,
            ...(input as Partial<SpaceSummary>),
            id: "space-2",
            role: "owner",
          },
        ),
      ),
    }),
  );
  return testApp;
}

describe("Spaces routes", () => {
  it("GET /v1/spaces returns 401 without a session", async () => {
    const response = await app.request("/v1/spaces");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHORIZED", message: "Unauthorized." },
    });
  });

  it("POST /v1/spaces returns 401 without a session", async () => {
    const response = await app.request("/v1/spaces", {
      method: "POST",
      body: JSON.stringify({ name: "Personal", type: "personal", currency: "EUR", timezone: "Europe/Madrid" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHORIZED", message: "Unauthorized." },
    });
  });

  it("POST /v1/spaces rejects an invalid body", async () => {
    const response = await createTestApp({ userId: "user-1" }).request(
      "/v1/spaces",
      {
        method: "POST",
        body: JSON.stringify({ name: "   ", type: "invalid", currency: "euros" }),
      },
      bindings,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_REQUEST", message: "Invalid request." },
    });
  });

  it("POST /v1/spaces trims the name and normalizes currency", async () => {
    let createdBy = "";
    let receivedInput: unknown;
    const response = await createTestApp({
      userId: "user-1",
      onCreate: (userId, input) => {
        createdBy = userId;
        receivedInput = input;
        return { ...space, id: "space-2", ...(input as Partial<SpaceSummary>) };
      },
    }).request(
      "/v1/spaces",
      {
        method: "POST",
        body: JSON.stringify({ name: "  Mi espacio  ", type: "personal", currency: "eur", timezone: "Europe/Madrid" }),
      },
      bindings,
    );

    expect(response.status).toBe(201);
    expect(createdBy).toBe("user-1");
    expect(receivedInput).toEqual({
      name: "Mi espacio",
      type: "personal",
      currency: "EUR",
      timezone: "Europe/Madrid",
    });
    await expect(response.json()).resolves.toMatchObject({
      data: { space: { id: "space-2", name: "Mi espacio", role: "owner" } },
    });
  });

  it("GET /v1/spaces returns only the service-filtered active spaces", async () => {
    const response = await createTestApp({
      userId: "user-1",
      listedSpaces: [space],
    }).request("/v1/spaces", {}, bindings);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        spaces: [
          {
            ...space,
            activatedAt: "2026-08-28T10:00:00.000Z",
            createdAt: "2026-08-28T10:00:00.000Z",
          },
        ],
      },
    });
  });
});

describe("Space timezones", () => {
  it.each(["GMT+2", "not/a-zone", ""])('rejects invalid IANA timezone %j', async (timezone) => {
    const response = await createTestApp({ userId: "user-1" }).request("/v1/spaces", {
      method: "POST", body: JSON.stringify({ name: "Casa", type: "personal", currency: "EUR", timezone }),
    }, bindings);
    expect(response.status).toBe(400);
  });
});

describe("Spaces service", () => {
  it("filters by current user, active membership, and non-archived spaces", () => {
    const db = drizzle.mock() as unknown as Database;
    const { sql, params } = buildListActiveSpacesQuery(db, "user-1").toSQL();

    expect(sql).toContain('"space_members"."user_id" = $1');
    expect(sql).toContain('"space_members"."status" = $2');
    expect(sql).toContain('"spaces"."archived_at" is null');
    expect(params).toEqual(["user-1", "active"]);
  });

  it("creates the space and active owner membership in one Neon batch", async () => {
    const insertedValues: Array<Record<string, unknown>> = [];
    const batch = vi.fn().mockResolvedValue([]);
    const db = {
      insert: vi.fn(() => ({
        values: (values: Record<string, unknown>) => {
          insertedValues.push(values);
          return { values };
        },
      })),
      batch,
    } as unknown as Database;

    const created = await createSpaceWithOwner(db, "user-1", {
      name: "Personal",
      type: "personal",
      currency: "EUR",
      timezone: "Europe/Madrid",
    });

    expect(batch).toHaveBeenCalledOnce();
    expect(batch.mock.calls[0]?.[0]).toHaveLength(2);
    expect(insertedValues[0]).toMatchObject({
      id: created.id,
      createdBy: "user-1",
      name: "Personal",
    });
    expect(insertedValues[1]).toMatchObject({
      spaceId: created.id,
      userId: "user-1",
      role: "owner",
      status: "active",
    });
  });
});
