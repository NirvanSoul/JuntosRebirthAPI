import { afterAll, describe, expect, it } from "vitest";
import { bootstrapAccount, findCurrentUser } from "../../src/services/account";
import { createSpaceWithOwner } from "../../src/services/spaces";
import { acceptInvitation, createInvitation } from "../../src/services/invitations";
import { sharesActiveSpace } from "../../src/services/avatars";
import { buildSnapshot } from "../../src/services/sync-snapshot";
import { user } from "../../src/db/schema";
import { eq } from "drizzle-orm";
import { cleanupTestUsers, createTestUser, testDb } from "./harness";

const db = testDb();

afterAll(cleanupTestUsers);

async function person(label: string) {
  const userId = await createTestUser(db, label);
  const currentUser = await findCurrentUser(db, userId);
  await bootstrapAccount(db, currentUser!, "Europe/Madrid");
  const [row] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId));
  return { userId, email: row!.email };
}

async function coupleWithPartner(label: string) {
  const owner = await person(`${label}-owner`);
  const partner = await person(`${label}-partner`);
  const space = await createSpaceWithOwner(db, owner.userId, {
    name: "Juntos",
    type: "couple",
    currency: "EUR",
    timezone: "Europe/Madrid",
  });
  const created = await createInvitation(db, {
    spaceId: space.id,
    invitedBy: owner.userId,
    email: partner.email,
    role: "member",
  });
  await acceptInvitation(db, partner.userId, created.token);
  return { owner, partner, space };
}

// Reproduce contra Postgres real la regla `sharesActiveSpace`: solo un mock
// la había ejercitado hasta ahora, y es justo la que decide si la pareja
// puede ver la foto de perfil del otro miembro de un espacio compartido.
describe("avatar visibility against PostgreSQL", () => {
  it("lets both members of an active couple space see each other's avatar", async () => {
    const { owner, partner } = await coupleWithPartner("avatar-couple");

    await expect(sharesActiveSpace(db, partner.userId, owner.userId)).resolves.toBe(true);
    await expect(sharesActiveSpace(db, owner.userId, partner.userId)).resolves.toBe(true);
  });

  it("refuses avatar access between users who share no active space", async () => {
    const someone = await person("avatar-stranger-a");
    const other = await person("avatar-stranger-b");

    await expect(sharesActiveSpace(db, someone.userId, other.userId)).resolves.toBe(false);
  });

  it("stops seeing the partner's avatar once they leave the space", async () => {
    const { owner, partner, space } = await coupleWithPartner("avatar-left");

    const { leaveSpace } = await import("../../src/services/members");
    expect(await leaveSpace(db, { spaceId: space.id, userId: partner.userId })).toBe(true);

    await expect(sharesActiveSpace(db, owner.userId, partner.userId)).resolves.toBe(false);
  });

  it("includes both members' avatar fields in the account snapshot for a couple space", async () => {
    const { owner, partner, space } = await coupleWithPartner("avatar-snapshot");

    // El snapshot trae los miembros de TODOS los espacios activos del usuario
    // (también el personal, donde es su único miembro) — se filtra al espacio
    // de pareja para comprobar justo lo que se quiere: que ambos aparezcan ahí.
    const snapshot = await buildSnapshot(db, owner.userId);
    const coupleMemberIds = snapshot.members
      .filter((member) => member.spaceId === space.id)
      .map((member) => member.userId)
      .sort();
    expect(coupleMemberIds).toEqual([owner.userId, partner.userId].sort());
  });
});
