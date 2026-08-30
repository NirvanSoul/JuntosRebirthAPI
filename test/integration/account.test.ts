import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootstrapAccount, findCurrentUser } from "../../src/services/account";
import { createSpaceWithOwner, listActiveSpaces } from "../../src/services/spaces";
import { categories, spaces } from "../../src/db/schema";
import { cleanupTestUsers, createTestUser, testDb } from "./harness";

const db = testDb();

afterAll(cleanupTestUsers);

describe("bootstrap against PostgreSQL", () => {
  it("creates profile, personal space and the seeded categories exactly once", async () => {
    const userId = await createTestUser(db, "bootstrap");
    const currentUser = await findCurrentUser(db, userId);
    expect(currentUser).not.toBeNull();

    const first = await bootstrapAccount(db, currentUser!, "Europe/Madrid");
    expect(first.created).toEqual({ profile: true, personalSpace: true });
    expect(first.personalSpace.timezone).toBe("Europe/Madrid");

    const seeded = await db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.spaceId, first.personalSpace.id));
    expect(seeded).toHaveLength(18);

    // El CTE es idempotente: repetirlo no duplica espacio ni categorías.
    const second = await bootstrapAccount(db, currentUser!, "Europe/Madrid");
    expect(second.created).toEqual({ profile: false, personalSpace: false });
    expect(second.personalSpace.id).toBe(first.personalSpace.id);

    const afterReplay = await db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.spaceId, first.personalSpace.id));
    expect(afterReplay).toHaveLength(18);
  });
});

describe("space creation against PostgreSQL", () => {
  it("seeds categories so a brand-new space can record a movement", async () => {
    const userId = await createTestUser(db, "space");
    const space = await createSpaceWithOwner(db, userId, {
      name: "Viaje",
      type: "other",
      currency: "USD",
      timezone: "UTC",
    });

    const seeded = await db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.spaceId, space.id));
    expect(seeded).toHaveLength(18);
  });

  it("leaves a couple space inactive until someone accepts", async () => {
    const userId = await createTestUser(db, "couple");
    const space = await createSpaceWithOwner(db, userId, {
      name: "Juntos",
      type: "couple",
      currency: "EUR",
      timezone: "UTC",
    });

    expect(space.activatedAt).toBeNull();
    const [stored] = await db
      .select({ activatedAt: spaces.activatedAt })
      .from(spaces)
      .where(eq(spaces.id, space.id));
    expect(stored?.activatedAt).toBeNull();

    const listed = await listActiveSpaces(db, userId);
    expect(listed.find((item) => item.id === space.id)?.activatedAt).toBeNull();
  });

  it("refuses a second active couple space", async () => {
    const userId = await createTestUser(db, "couple2");
    await createSpaceWithOwner(db, userId, {
      name: "Juntos",
      type: "couple",
      currency: "EUR",
      timezone: "UTC",
    });

    // Lo garantiza el índice parcial, no la lógica de aplicación.
    await expect(
      createSpaceWithOwner(db, userId, {
        name: "Otro Juntos",
        type: "couple",
        currency: "EUR",
        timezone: "UTC",
      }),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
