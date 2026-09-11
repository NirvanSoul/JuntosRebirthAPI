import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { bootstrapAccount, findCurrentUser, updateProfile } from "../../src/services/account";
import { createSpaceWithOwner, listActiveSpaces } from "../../src/services/spaces";
import { findActiveSpaceMembership } from "../../src/services/space-access";
import { buildSnapshot } from "../../src/services/sync-snapshot";
import { listMembers } from "../../src/services/members";
import { acceptInvitation, createInvitation } from "../../src/services/invitations";
import { spaceMembers, spaces, user, userProfiles } from "../../src/db/schema";
import { createTestUser, testDb } from "./harness";

const db = testDb();
const users: string[] = [];
const sharedSpaces: string[] = [];

afterAll(async () => {
  if (sharedSpaces.length) await db.delete(spaces).where(inArray(spaces.id, sharedSpaces));
  if (users.length) {
    await db.delete(spaces).where(inArray(spaces.createdBy, users));
    await db.delete(user).where(inArray(user.id, users));
  }
});

async function person(countryCode: string | null) {
  const id = await createTestUser(db, "country-membership");
  users.push(id);
  const current = (await findCurrentUser(db, id))!;
  await bootstrapAccount(db, current, "Europe/Madrid");
  if (countryCode) await updateProfile(db, id, { countryCode });
  return current;
}

async function shared(owner: string, type: "couple" | "other" = "couple") {
  const space = await createSpaceWithOwner(db, owner, { name: "Country test", type, currency: "EUR", timezone: "Europe/Madrid" });
  sharedSpaces.push(space.id);
  return space;
}

async function join(spaceId: string, owner: string, member: { id: string; email: string }) {
  const invite = await createInvitation(db, { spaceId, invitedBy: owner, email: member.email, role: "member" });
  expect(await acceptInvitation(db, member.id, invite.token)).toBe(spaceId);
}

describe("country change membership enforcement", () => {
  it.each(["couple", "other"] as const)("removes a departing member from %s access, lists and snapshot permanently", async (type) => {
    const owner = await person("ES"), member = await person("ES");
    const space = await shared(owner.id, type);
    await join(space.id, owner.id, member);
    expect((await updateProfile(db, member.id, { countryCode: "ES" }))?.leftSharedSpaceIds).toEqual([]);
    expect(await findActiveSpaceMembership(db, member.id, space.id)).not.toBeNull();

    const updated = await updateProfile(db, member.id, { countryCode: "VE" });
    expect(updated?.leftSharedSpaceIds).toEqual([space.id]);
    expect(await findActiveSpaceMembership(db, member.id, space.id)).toBeNull();
    expect((await listActiveSpaces(db, member.id)).map(s => s.id)).not.toContain(space.id);
    expect((await buildSnapshot(db, member.id)).spaces.map(s => s.id)).not.toContain(space.id);
    expect((await listMembers(db, space.id)).map(m => m.userId)).toEqual([owner.id]);
    const membership = (await db.select().from(spaceMembers).where(eq(spaceMembers.userId, member.id))).find(m => m.spaceId === space.id)!;
    expect(membership.status).toBe("left");
    expect(membership.leftAt).not.toBeNull();

    await updateProfile(db, member.id, { countryCode: "ES" });
    expect(await findActiveSpaceMembership(db, member.id, space.id)).toBeNull();
    await join(space.id, owner.id, member);
    expect(await findActiveSpaceMembership(db, member.id, space.id)).not.toBeNull();
  });

  it("transfers ownership, keeps the remaining member's history and frees the departing creator", async () => {
    const owner = await person("ES"), member = await person("ES");
    const space = await shared(owner.id);
    await join(space.id, owner.id, member);
    expect((await updateProfile(db, owner.id, { countryCode: "VE" }))?.leftSharedSpaceIds).toEqual([space.id]);
    expect(await findActiveSpaceMembership(db, owner.id, space.id)).toBeNull();
    expect(await findActiveSpaceMembership(db, member.id, space.id)).toMatchObject({ role: "owner" });
    const [stored] = await db.select().from(spaces).where(eq(spaces.id, space.id));
    expect(stored.archivedAt).toBeNull();
    expect(stored.createdBy).toBeNull();
    expect((await shared(owner.id)).countryCode).toBe("VE");
  });

  it("archives an empty shared space while preserving personal contexts", async () => {
    const owner = await person("ES");
    const space = await shared(owner.id);
    const previousPersonal = (await listActiveSpaces(db, owner.id)).find(s => s.type === "personal")!;
    await updateProfile(db, owner.id, { countryCode: "VE" });
    expect((await db.select().from(spaces).where(eq(spaces.id, space.id)))[0].archivedAt).not.toBeNull();
    await updateProfile(db, owner.id, { countryCode: "ES" });
    expect(await findActiveSpaceMembership(db, owner.id, space.id)).toBeNull();
    expect(await findActiveSpaceMembership(db, owner.id, previousPersonal.id)).not.toBeNull();
  });

  it("treats an undefined country as distinct from Venezuela and enforces direct profile updates", async () => {
    const owner = await person(null), member = await person(null);
    const space = await shared(owner.id);
    await join(space.id, owner.id, member);
    await db.update(userProfiles).set({ countryCode: "VE" }).where(eq(userProfiles.userId, member.id));
    expect(await findActiveSpaceMembership(db, member.id, space.id)).toBeNull();
    expect((await listMembers(db, space.id)).map(m => m.userId)).toEqual([owner.id]);
    // Una escritura tardía no puede reactivar la membresía incompatible.
    await expect(db.update(spaceMembers).set({ status: "active" }).where(eq(spaceMembers.userId, member.id)))
      .rejects.toThrow();
    expect(await findActiveSpaceMembership(db, member.id, space.id)).toBeNull();
  });
});
