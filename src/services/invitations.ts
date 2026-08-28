import { and, eq, gt, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { spaceInvitations, spaceMembers, user } from "../db/schema";

export type Invitation = { id: string; email: string; role: "admin" | "member"; status: "pending" | "accepted" | "revoked" | "expired"; expiresAt: Date; createdAt: Date };

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

/** Associates pending invitations with a newly authenticated account. It does not grant access. */
export async function claimEmailInvitations(db: Database, userId: string, email: string) {
  await db.update(spaceInvitations).set({ inviteeUserId: userId, updatedAt: new Date() }).where(and(eq(spaceInvitations.invitedEmail, email.trim().toLowerCase()), eq(spaceInvitations.status, "pending")));
}

export async function listIncomingInvitations(db: Database, userId: string, email: string): Promise<Invitation[]> {
  const rows = await db.select({ id: spaceInvitations.id, invitedEmail: spaceInvitations.invitedEmail, role: spaceInvitations.role, status: spaceInvitations.status, expiresAt: spaceInvitations.expiresAt, createdAt: spaceInvitations.createdAt }).from(spaceInvitations).where(and(eq(spaceInvitations.status, "pending"), sql`(${spaceInvitations.inviteeUserId} = ${userId} OR ${spaceInvitations.invitedEmail} = ${email.trim().toLowerCase()})`));
  return rows.map(serialize);
}

function serialize(row: { id: string; invitedEmail: string; role: "owner" | "admin" | "member"; status: "pending" | "accepted" | "revoked" | "expired"; expiresAt: Date; createdAt: Date }): Invitation {
  return { id: row.id, email: row.invitedEmail, role: row.role === "admin" ? "admin" : "member", status: row.status, expiresAt: row.expiresAt, createdAt: row.createdAt };
}
function encodeToken() { const bytes = crypto.getRandomValues(new Uint8Array(32)); return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join(""); }
async function hashToken(token: string) { const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)); return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join(""); }
