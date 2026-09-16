import { afterAll, describe, expect, it } from "vitest";
import { bootstrapAccount, findCurrentUser, getAccountState, updateProfile } from "../../src/services/account";
import { createSpaceWithOwner } from "../../src/services/spaces";
import { acceptInvitation, createInvitation } from "../../src/services/invitations";
import { deleteAvatar, saveAvatar, sharesActiveSpace } from "../../src/services/avatars";
import { createCategory } from "../../src/services/categories";
import { listMembers } from "../../src/services/members";
import { createTransaction } from "../../src/services/transactions";
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

  it("propagates the current name and every avatar version through the shared member census", async () => {
    const { owner: ana, partner: beto, space } = await coupleWithPartner("profile-contract");
    const stranger = await person("profile-contract-stranger");
    const objects = new Map<string, ArrayBuffer>();
    const bucket = {
      put: async (key: string, value: ArrayBuffer) => { objects.set(key, value); },
      delete: async (key: string) => { objects.delete(key); },
      get: async (key: string) => objects.has(key) ? { body: objects.get(key) } : null,
    } as unknown as R2Bucket;

    await updateProfile(db, ana.userId, { displayName: "Ana nueva" });
    const renamedMembers = await listMembers(db, space.id);
    expect(renamedMembers.find((member) => member.userId === ana.userId))
      .toMatchObject({ displayName: "Ana nueva", avatarPath: null, avatarUpdatedAt: null });

    const category = await createCategory(db, {
      spaceId: space.id,
      userId: ana.userId,
      name: "Compartida",
      icon: null,
      colorToken: null,
    });
    const movement = await createTransaction(db, {
      spaceId: space.id,
      userId: ana.userId,
      type: "expense",
      amountMinor: 1_000n,
      currency: "EUR",
      title: "Cena",
      occurredOn: "2026-09-16",
      categoryId: category.id,
      moneyAccountId: null,
      creatorCountryCode: null,
    });
    expect(movement.transaction?.createdBy).toBe(ana.userId);
    expect(renamedMembers.find((member) => member.userId === movement.transaction?.createdBy)?.displayName)
      .toBe("Ana nueva");

    const first = await saveAvatar(db, bucket, ana.userId, new Uint8Array([1]).buffer);
    expect(first.avatarPath).toBe(`${ana.userId}/avatar.jpg`);
    expect((await getAccountState(db, ana.userId)).profile).toMatchObject({
      avatarPath: first.avatarPath,
      avatarUpdatedAt: first.avatarUpdatedAt,
    });
    expect((await listMembers(db, space.id)).find((member) => member.userId === ana.userId))
      .toMatchObject({ avatarPath: first.avatarPath, avatarUpdatedAt: first.avatarUpdatedAt });
    await expect(sharesActiveSpace(db, beto.userId, ana.userId)).resolves.toBe(true);
    await expect(sharesActiveSpace(db, stranger.userId, ana.userId)).resolves.toBe(false);

    const second = await saveAvatar(db, bucket, ana.userId, new Uint8Array([2]).buffer);
    expect(second.avatarPath).toBe(first.avatarPath);
    expect(second.avatarUpdatedAt.getTime()).toBeGreaterThan(first.avatarUpdatedAt.getTime());

    await deleteAvatar(db, bucket, ana.userId);
    expect((await listMembers(db, space.id)).find((member) => member.userId === ana.userId))
      .toMatchObject({ avatarPath: null, avatarUpdatedAt: null });
    expect(objects.has(first.avatarPath)).toBe(false);
  });
});
