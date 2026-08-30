import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { bootstrapAccount, findCurrentUser } from "../../src/services/account";
import { createSpaceWithOwner } from "../../src/services/spaces";
import {
  acceptInvitation,
  createInvitation,
  expireStaleInvitations,
  listInvitations,
  listIncomingInvitations,
  previewInvitation,
  revokeInvitation,
} from "../../src/services/invitations";
import { leaveSpace, listMembers, removeMember, setMemberRole } from "../../src/services/members";
import { spaceInvitations, spaceMembers, spaces, user } from "../../src/db/schema";
import { cleanupTestUsers, createTestUser, testDb, TEST_USER_PREFIX } from "./harness";

const db = testDb();

afterAll(cleanupTestUsers);

async function person(label: string) {
  const userId = await createTestUser(db, label);
  const currentUser = await findCurrentUser(db, userId);
  await bootstrapAccount(db, currentUser!, "Europe/Madrid");
  const [row] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId));
  return { userId, email: row!.email };
}

async function coupleSpace(ownerId: string) {
  return createSpaceWithOwner(db, ownerId, {
    name: "Juntos",
    type: "couple",
    currency: "EUR",
    timezone: "Europe/Madrid",
  });
}

describe("invitations against PostgreSQL", () => {
  it("activates the couple space only when the invitation is accepted", async () => {
    const owner = await person("inv-owner");
    const partner = await person("inv-partner");
    const space = await coupleSpace(owner.userId);
    expect(space.activatedAt).toBeNull();

    const created = await createInvitation(db, {
      spaceId: space.id,
      invitedBy: owner.userId,
      email: partner.email,
      role: "member",
    });
    expect(created.inviteeUserId).toBe(partner.userId);

    // Antes de aceptar sigue inactivo: la app lo pinta como "esperando pareja".
    const [beforeAccept] = await db
      .select({ activatedAt: spaces.activatedAt })
      .from(spaces)
      .where(eq(spaces.id, space.id));
    expect(beforeAccept?.activatedAt).toBeNull();

    const acceptedSpaceId = await acceptInvitation(db, partner.userId, created.token);
    expect(acceptedSpaceId).toBe(space.id);

    const [afterAccept] = await db
      .select({ activatedAt: spaces.activatedAt })
      .from(spaces)
      .where(eq(spaces.id, space.id));
    expect(afterAccept?.activatedAt).not.toBeNull();

    const members = await listMembers(db, space.id);
    expect(members.map((member) => member.userId).sort()).toEqual(
      [owner.userId, partner.userId].sort(),
    );
  });

  it("keeps an invitation to an email without an account pending, and links it on bootstrap", async () => {
    const owner = await person("inv-future");
    const space = await coupleSpace(owner.userId);
    const futureEmail = `itest-future-${Date.now()}@integration.test`;

    // La fuente de verdad es `space_invitations`, no el usuario: se puede
    // invitar a alguien que todavía no se ha registrado.
    const created = await createInvitation(db, {
      spaceId: space.id,
      invitedBy: owner.userId,
      email: futureEmail,
      role: "member",
    });
    expect(created.inviteeUserId).toBeNull();

    // Esa persona se registra después con el mismo correo.
    const [newcomer] = await db
      .insert(user)
      .values({
        id: `${TEST_USER_PREFIX}future-${Date.now()}`,
        name: "Futuro",
        email: futureEmail,
        emailVerified: true,
      })
      .returning({ id: user.id });
    const currentUser = await findCurrentUser(db, newcomer!.id);
    await bootstrapAccount(db, currentUser!, "Europe/Madrid");

    // El bootstrap vincula las invitaciones pendientes de su correo.
    const incoming = await listIncomingInvitations(db, newcomer!.id, futureEmail);
    expect(incoming.map((invitation) => invitation.id)).toContain(created.invitation.id);
  });

  it("allows only one pending invitation per space and email", async () => {
    const owner = await person("inv-same-email");
    const partner = await person("inv-same-email-partner");
    const space = await coupleSpace(owner.userId);
    const input = {
      spaceId: space.id,
      invitedBy: owner.userId,
      email: partner.email,
      role: "member" as const,
    };

    await createInvitation(db, input);
    await expect(createInvitation(db, input)).rejects.toThrow("INVITATION_ALREADY_PENDING");
  });

  it("allows inviting two different people to the same space", async () => {
    const owner = await person("inv-two-people");
    const first = await person("inv-two-people-a");
    const second = await person("inv-two-people-b");
    const space = await createSpaceWithOwner(db, owner.userId, {
      name: "Piso",
      type: "other",
      currency: "EUR",
      timezone: "Europe/Madrid",
    });

    await createInvitation(db, { spaceId: space.id, invitedBy: owner.userId, email: first.email, role: "member" });
    // El límite es por correo, no por espacio: un piso compartido invita a varias personas.
    await expect(
      createInvitation(db, { spaceId: space.id, invitedBy: owner.userId, email: second.email, role: "member" }),
    ).resolves.toMatchObject({ inviteeUserId: second.userId });
  });

  it("stores only the hash of the token and masks the email in the preview", async () => {
    const owner = await person("inv-token-owner");
    const partner = await person("inv-token-partner");
    const space = await coupleSpace(owner.userId);

    const created = await createInvitation(db, {
      spaceId: space.id,
      invitedBy: owner.userId,
      email: partner.email,
      role: "member",
    });

    const [stored] = await db
      .select({ tokenHash: spaceInvitations.tokenHash })
      .from(spaceInvitations)
      .where(eq(spaceInvitations.id, created.invitation.id));
    expect(stored?.tokenHash).not.toBe(created.token);
    expect(stored?.tokenHash).toMatch(/^[a-f0-9]{64}$/);

    const preview = await previewInvitation(db, created.token);
    expect(preview.status).toBe("pending");
    if (preview.status === "pending") {
      expect(preview.spaceName).toBe("Juntos");
      expect(preview.invitedEmailMasked).toContain("***@");
      expect(preview.invitedEmailMasked).not.toBe(partner.email);
    }
  });

  it("rejects a revoked invitation and reports it as revoked", async () => {
    const owner = await person("inv-revoke-owner");
    const partner = await person("inv-revoke-partner");
    const space = await coupleSpace(owner.userId);

    const created = await createInvitation(db, {
      spaceId: space.id,
      invitedBy: owner.userId,
      email: partner.email,
      role: "member",
    });
    expect(await revokeInvitation(db, space.id, created.invitation.id)).toBe(true);

    await expect(acceptInvitation(db, partner.userId, created.token)).resolves.toBeUndefined();
    expect((await previewInvitation(db, created.token)).status).toBe("revoked");
    // Revocar dos veces no vuelve a cambiar nada.
    expect(await revokeInvitation(db, space.id, created.invitation.id)).toBe(false);
  });

  it("sweeps an expired invitation out of the pending lists", async () => {
    const owner = await person("inv-expire-owner");
    const partner = await person("inv-expire-partner");
    const space = await coupleSpace(owner.userId);

    const created = await createInvitation(db, {
      spaceId: space.id,
      invitedBy: owner.userId,
      email: partner.email,
      role: "member",
    });
    await db
      .update(spaceInvitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(spaceInvitations.id, created.invitation.id));

    // Aún sin barrer, la fecha manda sobre el estado guardado.
    expect((await listInvitations(db, space.id))[0]?.status).toBe("expired");
    expect(await listIncomingInvitations(db, partner.userId, partner.email)).toHaveLength(0);
    await expect(acceptInvitation(db, partner.userId, created.token)).resolves.toBeUndefined();

    expect(await expireStaleInvitations(db)).toBeGreaterThanOrEqual(1);
    const [swept] = await db
      .select({ status: spaceInvitations.status })
      .from(spaceInvitations)
      .where(eq(spaceInvitations.id, created.invitation.id));
    expect(swept?.status).toBe("expired");
  });
});

describe("member management CTEs against PostgreSQL", () => {
  async function spaceWithPartner(label: string) {
    const owner = await person(`${label}-owner`);
    const partner = await person(`${label}-partner`);
    const space = await coupleSpace(owner.userId);
    const created = await createInvitation(db, {
      spaceId: space.id,
      invitedBy: owner.userId,
      email: partner.email,
      role: "member",
    });
    await acceptInvitation(db, partner.userId, created.token);

    const members = await listMembers(db, space.id);
    const memberIdOf = (userId: string) =>
      members.find((member) => member.userId === userId)!.id;
    return { owner, partner, space, memberIdOf };
  }

  it("never lets the last owner demote, remove or leave", async () => {
    const { owner, space, memberIdOf } = await spaceWithPartner("last-owner");

    expect(
      await setMemberRole(db, {
        spaceId: space.id,
        actorId: owner.userId,
        memberId: memberIdOf(owner.userId),
        role: "member",
      }),
    ).toBe(false);
    expect(
      await removeMember(db, {
        spaceId: space.id,
        actorId: owner.userId,
        memberId: memberIdOf(owner.userId),
      }),
    ).toBe(false);
    // Sin transferir la propiedad, el espacio se quedaría huérfano.
    expect(await leaveSpace(db, { spaceId: space.id, userId: owner.userId })).toBe(false);
  });

  it("stops a member from promoting themselves or removing the owner", async () => {
    const { owner, partner, space, memberIdOf } = await spaceWithPartner("member-privs");

    expect(
      await setMemberRole(db, {
        spaceId: space.id,
        actorId: partner.userId,
        memberId: memberIdOf(partner.userId),
        role: "owner",
      }),
    ).toBe(false);
    expect(
      await removeMember(db, {
        spaceId: space.id,
        actorId: partner.userId,
        memberId: memberIdOf(owner.userId),
      }),
    ).toBe(false);
  });

  it("lets a member leave, and frees the couple slot for a new space", async () => {
    const { partner, space } = await spaceWithPartner("member-leaves");

    expect(await leaveSpace(db, { spaceId: space.id, userId: partner.userId })).toBe(true);

    const remaining = await db
      .select({ status: spaceMembers.status })
      .from(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.userId, partner.userId)));
    expect(remaining[0]?.status).toBe("left");
    expect(await listMembers(db, space.id)).toHaveLength(1);
  });

  it("lets the owner transfer ownership and then step down", async () => {
    const { owner, partner, space, memberIdOf } = await spaceWithPartner("transfer");

    expect(
      await setMemberRole(db, {
        spaceId: space.id,
        actorId: owner.userId,
        memberId: memberIdOf(partner.userId),
        role: "owner",
      }),
    ).toBe(true);
    // Con dos propietarios activos, el original ya puede salir.
    expect(await leaveSpace(db, { spaceId: space.id, userId: owner.userId })).toBe(true);
  });
});
