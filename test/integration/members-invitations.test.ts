import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { bootstrapAccount, findCurrentUser, getAccountState, updateProfile } from "../../src/services/account";
import { cancelPendingCoupleSpace, createSpaceWithOwner, listActiveSpaces } from "../../src/services/spaces";
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
import { cleanupTestUsers, createTestUser, registerTestUser, testDb, TEST_USER_PREFIX } from "./harness";

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

describe("invitations against PostgreSQL", () => {
  it("does not consume an invitation or create a membership when countries differ", async () => {
    const owner = await person("inv-country-owner");
    const partner = await person("inv-country-partner");
    await updateProfile(db, owner.userId, { countryCode: "ES" });
    await updateProfile(db, partner.userId, { countryCode: "VE" });
    const ownerState = await getAccountState(db, owner.userId);
    const [personal] = await db.select({ countryCode: spaces.countryCode }).from(spaces)
      .where(eq(spaces.id, ownerState.personalSpaceId!));
    expect(personal?.countryCode).toBe("ES");
    const space = await coupleSpace(owner.userId);

    // Una persona ya conocida se rechaza al invitar.
    await expect(createInvitation(db, {
      spaceId: space.id, invitedBy: owner.userId, email: partner.email, role: "member",
    })).rejects.toThrow("SPACE_COUNTRY_MISMATCH");

    // La misma protección vive en la aceptación para invitaciones creadas
    // antes de que la persona tuviera perfil/país.
    const pending = await createInvitation(db, {
      spaceId: space.id,
      invitedBy: owner.userId,
      email: `itest-country-later-${Date.now()}@integration.test`,
      role: "member",
    });
    const [later] = await db.insert(user).values({
      id: `${TEST_USER_PREFIX}country-later-${Date.now()}`,
      name: "Luego", email: pending.invitation.email, emailVerified: true,
    }).returning({ id: user.id });
    registerTestUser(later!.id);
    const current = await findCurrentUser(db, later!.id);
    await bootstrapAccount(db, current!, "Europe/Madrid");
    await updateProfile(db, later!.id, { countryCode: "VE" });

    expect(await acceptInvitation(db, later!.id, pending.token)).toBeUndefined();
    const [stored] = await db.select({ status: spaceInvitations.status }).from(spaceInvitations).where(eq(spaceInvitations.id, pending.invitation.id));
    expect(stored?.status).toBe("pending");
    expect((await listMembers(db, space.id)).map((member) => member.userId)).not.toContain(later!.id);
  });

  it("leaves the shared space when the profile changes country", async () => {
    const owner = await person("country-change-owner");
    const partner = await person("country-change-partner");
    await updateProfile(db, owner.userId, { countryCode: "ES" });
    await updateProfile(db, partner.userId, { countryCode: "ES" });
    const space = await coupleSpace(owner.userId);
    const invite = await createInvitation(db, { spaceId: space.id, invitedBy: owner.userId, email: partner.email, role: "member" });
    await acceptInvitation(db, partner.userId, invite.token);

    const updated = await updateProfile(db, partner.userId, { countryCode: "VE" });
    expect(updated?.leftSharedSpaceIds).toEqual([space.id]);
    expect((await getAccountState(db, partner.userId)).profile?.countryCode).toBe("VE");
    expect((await listMembers(db, space.id)).map((member) => member.userId)).not.toContain(partner.userId);
  });

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
    registerTestUser(newcomer!.id);
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

  it("rejects a revoked invitation and reports it as revoked in an active space", async () => {
    const { owner, space } = await spaceWithPartner("inv-revoke");
    const thirdParty = await person("inv-revoke-third");

    const created = await createInvitation(db, {
      spaceId: space.id,
      invitedBy: owner.userId,
      email: thirdParty.email,
      role: "member",
    });
    expect(await revokeInvitation(db, space.id, created.invitation.id)).toBe(true);

    await expect(acceptInvitation(db, thirdParty.userId, created.token)).resolves.toBeUndefined();
    expect((await previewInvitation(db, created.token)).status).toBe("revoked");
    // Revocar dos veces no vuelve a cambiar nada.
    expect(await revokeInvitation(db, space.id, created.invitation.id)).toBe(false);
  });

  it("revoking an invitation on an unactivated couple space deletes the space", async () => {
    const owner = await person("inv-revoke-couple-owner");
    const partner = await person("inv-revoke-couple-partner");
    const space = await coupleSpace(owner.userId);

    const created = await createInvitation(db, {
      spaceId: space.id,
      invitedBy: owner.userId,
      email: partner.email,
      role: "member",
    });

    expect(await revokeInvitation(db, space.id, created.invitation.id)).toBe(true);

    // El espacio y membresías quedaron eliminados de la base de datos
    const remaining = await db.select().from(spaces).where(eq(spaces.id, space.id));
    expect(remaining).toHaveLength(0);

    const activeSpaces = await listActiveSpaces(db, owner.userId);
    expect(activeSpaces.some((s) => s.id === space.id)).toBe(false);

    // Puede crear otro espacio de pareja sin conflicto de unicidad
    await expect(coupleSpace(owner.userId)).resolves.toBeDefined();
  });

  it("excludes unactivated couple spaces from listActiveSpaces if they have no pending invitation", async () => {
    const owner = await person("no-inv-couple-owner");
    const space = await coupleSpace(owner.userId);

    // Sin invitación enviada, no se lista en espacios activos
    const activeSpaces = await listActiveSpaces(db, owner.userId);
    expect(activeSpaces.some((s) => s.id === space.id)).toBe(false);
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

describe("cancelling pending couple space against PostgreSQL", () => {
  it("cancels pending couple space, deletes the space from database, and frees the creator to create a new couple space", async () => {
    const owner = await person("cancel-owner");
    const partner = await person("cancel-partner");
    const space = await coupleSpace(owner.userId);
    expect(space.activatedAt).toBeNull();

    const created = await createInvitation(db, {
      spaceId: space.id,
      invitedBy: owner.userId,
      email: partner.email,
      role: "member",
    });

    const activeBefore = await listActiveSpaces(db, owner.userId);
    expect(activeBefore.some((s) => s.id === space.id)).toBe(true);

    const result = await cancelPendingCoupleSpace(db, {
      spaceId: space.id,
      userId: owner.userId,
    });
    expect(result).toEqual({ success: true });

    // El espacio ya no existe en la base
    const storedSpaces = await db.select().from(spaces).where(eq(spaces.id, space.id));
    expect(storedSpaces).toHaveLength(0);

    // Tampoco existe en el listado de espacios activos
    const activeAfter = await listActiveSpaces(db, owner.userId);
    expect(activeAfter.some((s) => s.id === space.id)).toBe(false);

    // Sus membresías se eliminaron
    const storedMembers = await db.select().from(spaceMembers).where(eq(spaceMembers.spaceId, space.id));
    expect(storedMembers).toHaveLength(0);

    // La invitación ya no se puede aceptar
    const accepted = await acceptInvitation(db, partner.userId, created.token);
    expect(accepted).toBeUndefined();

    // El creador puede volver a crear otro espacio de pareja inmediatamente (liberó el índice único)
    const newSpace = await coupleSpace(owner.userId);
    expect(newSpace.id).toBeDefined();
    expect(newSpace.id).not.toBe(space.id);
  });

  it("refuses cancellation if user is not the owner", async () => {
    const owner = await person("cancel-stranger-owner");
    const stranger = await person("cancel-stranger");
    const space = await coupleSpace(owner.userId);

    const result = await cancelPendingCoupleSpace(db, {
      spaceId: space.id,
      userId: stranger.userId,
    });
    expect(result).toEqual({ success: false, code: "FORBIDDEN" });

    // El espacio sigue existiendo
    const storedSpaces = await db.select().from(spaces).where(eq(spaces.id, space.id));
    expect(storedSpaces).toHaveLength(1);
  });

  it("refuses cancellation if the space was already activated by partner acceptance", async () => {
    const { owner, space } = await spaceWithPartner("cancel-active");
    const [stored] = await db.select({ activatedAt: spaces.activatedAt }).from(spaces).where(eq(spaces.id, space.id));
    expect(stored?.activatedAt).not.toBeNull();

    const result = await cancelPendingCoupleSpace(db, {
      spaceId: space.id,
      userId: owner.userId,
    });
    expect(result).toEqual({ success: false, code: "INVALID_REQUEST" });

    // El espacio sigue existiendo
    const storedSpaces = await db.select().from(spaces).where(eq(spaces.id, space.id));
    expect(storedSpaces).toHaveLength(1);
  });

  it("refuses cancellation on a personal space", async () => {
    const owner = await person("cancel-personal");
    const state = await getAccountState(db, owner.userId);
    const personalSpaceId = state.personalSpaceId!;

    const result = await cancelPendingCoupleSpace(db, {
      spaceId: personalSpaceId,
      userId: owner.userId,
    });
    expect(result).toEqual({ success: false, code: "INVALID_REQUEST" });
  });
});
