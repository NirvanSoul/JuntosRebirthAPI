import { and, eq, gt, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { spaceInvitations, spaceMembers, spaces, user, userProfiles } from "../db/schema";

export type Invitation = { id: string; email: string; role: "admin" | "member"; status: "pending" | "accepted" | "revoked" | "expired"; expiresAt: Date; createdAt: Date; spaceId?: string; spaceName?: string; inviterDisplayName?: string | null };

export function mayManageMembers(role: "owner" | "admin" | "member") { return role === "owner" || role === "admin"; }

export async function createInvitation(db: Database, input: { spaceId: string; invitedBy: string; email: string; role: "admin" | "member" }) {
  const token = encodeToken();
  const tokenHash = await hashToken(token);
  const [knownUser] = await db.select({ id: user.id }).from(user).where(eq(user.email, input.email)).limit(1);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const [invitation] = await db.insert(spaceInvitations).values({ spaceId: input.spaceId, invitedBy: input.invitedBy, invitedEmail: input.email, inviteeUserId: knownUser?.id, role: input.role, tokenHash, expiresAt }).returning({ id: spaceInvitations.id, invitedEmail: spaceInvitations.invitedEmail, role: spaceInvitations.role, status: spaceInvitations.status, expiresAt: spaceInvitations.expiresAt, createdAt: spaceInvitations.createdAt });
  return { invitation: serialize(invitation), token };
}

export async function listInvitations(db: Database, spaceId: string): Promise<Invitation[]> {
  const rows = await db.select({ id: spaceInvitations.id, invitedEmail: spaceInvitations.invitedEmail, role: spaceInvitations.role, status: spaceInvitations.status, expiresAt: spaceInvitations.expiresAt, createdAt: spaceInvitations.createdAt }).from(spaceInvitations).where(eq(spaceInvitations.spaceId, spaceId));
  return rows.map(serialize);
}

export async function acceptInvitation(db: Database, userId: string, token: string) {
  const tokenHash = await hashToken(token);
  const result = await db.execute(sql`
    WITH accepted AS (
      UPDATE space_invitations SET status='accepted', accepted_at=now(), invitee_user_id=${userId}, updated_at=now()
      WHERE token_hash=${tokenHash} AND status='pending' AND expires_at > now()
      RETURNING space_id, role
    ), membership AS (
      INSERT INTO space_members (space_id, user_id, role, status, joined_at, created_at, updated_at)
      SELECT space_id, ${userId}, role, 'active', now(), now(), now() FROM accepted
      ON CONFLICT (space_id, user_id) DO UPDATE SET role=EXCLUDED.role, status='active', left_at=NULL, updated_at=now()
      RETURNING space_id
    ) SELECT space_id FROM membership
  `);
  return result.rows[0]?.space_id as string | undefined;
}

/** Accepts an invitation shown inside the authenticated app after bootstrap linked it. */
export async function acceptLinkedInvitation(db: Database, userId: string, invitationId: string) {
  const result = await db.execute(sql`
    WITH accepted AS (
      UPDATE space_invitations SET status='accepted', accepted_at=now(), updated_at=now()
      WHERE id=${invitationId} AND invitee_user_id=${userId} AND status='pending' AND expires_at > now()
      RETURNING space_id, role
    ), membership AS (
      INSERT INTO space_members (space_id, user_id, role, status, joined_at, created_at, updated_at)
      SELECT space_id, ${userId}, role, 'active', now(), now(), now() FROM accepted
      ON CONFLICT (space_id, user_id) DO UPDATE SET role=EXCLUDED.role, status='active', left_at=NULL, updated_at=now()
      RETURNING space_id
    ) SELECT space_id FROM membership
  `);
  return result.rows[0]?.space_id as string | undefined;
}

export async function previewInvitation(db: Database, token: string) {
  const tokenHash = await hashToken(token);
  const [row] = await db.select({ status: spaceInvitations.status, expiresAt: spaceInvitations.expiresAt, spaceName: spaces.name, inviterDisplayName: userProfiles.displayName, invitedEmail: spaceInvitations.invitedEmail }).from(spaceInvitations).innerJoin(spaces, eq(spaceInvitations.spaceId, spaces.id)).leftJoin(userProfiles, eq(spaceInvitations.invitedBy, userProfiles.userId)).where(eq(spaceInvitations.tokenHash, tokenHash));
  if (!row) return { status: "not_found" as const };
  if (row.status !== "pending") return { status: row.status };
  if (row.expiresAt <= new Date()) return { status: "expired" as const };
  const [name, domain] = row.invitedEmail.split("@");
  return { status: "pending" as const, spaceName: row.spaceName, inviterDisplayName: row.inviterDisplayName ?? "Alguien", invitedEmailMasked: `${name?.slice(0, 2) ?? ""}***@${domain ?? ""}` };
}

/** Associates pending invitations with a newly authenticated account. It does not grant access. */
export async function claimEmailInvitations(db: Database, userId: string, email: string) {
  await db.update(spaceInvitations).set({ inviteeUserId: userId, updatedAt: new Date() }).where(and(eq(spaceInvitations.invitedEmail, email.trim().toLowerCase()), eq(spaceInvitations.status, "pending")));
}

export async function listIncomingInvitations(db: Database, userId: string, email: string): Promise<Invitation[]> {
  const rows = await db.select({ id: spaceInvitations.id, invitedEmail: spaceInvitations.invitedEmail, role: spaceInvitations.role, status: spaceInvitations.status, expiresAt: spaceInvitations.expiresAt, createdAt: spaceInvitations.createdAt, spaceId: spaces.id, spaceName: spaces.name, inviterDisplayName: userProfiles.displayName }).from(spaceInvitations).innerJoin(spaces, eq(spaceInvitations.spaceId, spaces.id)).leftJoin(userProfiles, eq(spaceInvitations.invitedBy, userProfiles.userId)).where(and(eq(spaceInvitations.status, "pending"), sql`(${spaceInvitations.inviteeUserId} = ${userId} OR ${spaceInvitations.invitedEmail} = ${email.trim().toLowerCase()})`));
  return rows.map((row) => ({ ...serialize(row), spaceId: row.spaceId, spaceName: row.spaceName, inviterDisplayName: row.inviterDisplayName }));
}

function serialize(row: { id: string; invitedEmail: string; role: "owner" | "admin" | "member"; status: "pending" | "accepted" | "revoked" | "expired"; expiresAt: Date; createdAt: Date }): Invitation {
  return { id: row.id, email: row.invitedEmail, role: row.role === "admin" ? "admin" : "member", status: row.status, expiresAt: row.expiresAt, createdAt: row.createdAt };
}
function encodeToken() { const bytes = crypto.getRandomValues(new Uint8Array(32)); return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join(""); }
async function hashToken(token: string) { const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)); return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join(""); }
