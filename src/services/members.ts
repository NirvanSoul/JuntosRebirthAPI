import { and, eq, sql, type SQL } from "drizzle-orm";
import type { Database } from "../db/client";
import { spaceMembers, user, userProfiles } from "../db/schema";

export type Member = {
  id: string;
  userId: string;
  role: "owner" | "admin" | "member";
  displayName: string | null;
  image: string | null;
  /** Alimenta la caché `space_member_profiles` del SQLite local. */
  avatarPath: string | null;
  avatarUpdatedAt: Date | null;
  defaultCurrency: string | null;
  joinedAt: Date;
};
export type MemberProfile = Pick<
  Member,
  "userId" | "displayName" | "avatarPath" | "avatarUpdatedAt" | "defaultCurrency"
>;

export async function listMembers(db: Database, spaceId: string): Promise<Member[]> {
  return db
    .select({
      id: spaceMembers.id,
      userId: spaceMembers.userId,
      role: spaceMembers.role,
      displayName: userProfiles.displayName,
      image: user.image,
      avatarPath: userProfiles.avatarPath,
      avatarUpdatedAt: userProfiles.avatarUpdatedAt,
      defaultCurrency: userProfiles.defaultCurrency,
      joinedAt: spaceMembers.joinedAt,
    })
    .from(spaceMembers)
    .innerJoin(user, eq(spaceMembers.userId, user.id))
    .leftJoin(userProfiles, eq(userProfiles.userId, user.id))
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.status, "active")));
}

export function memberProfile(member: Member): MemberProfile {
  return {
    userId: member.userId,
    displayName: member.displayName,
    avatarPath: member.avatarPath,
    avatarUpdatedAt: member.avatarUpdatedAt,
    defaultCurrency: member.defaultCurrency,
  };
}
/**
 * "Nunca dejar el espacio sin propietario" se comprueba contando propietarios
 * en la misma sentencia que cambia una fila. Dos cambios simultáneos sobre
 * filas distintas (los dos propietarios salen o se degradan a la vez) veían
 * ambos "2 propietarios" y el espacio se quedaba sin ninguno. Bloquear antes
 * la fila del espacio los serializa: el segundo cuenta ya con el primero
 * confirmado.
 */
async function serializedByMembers(db: Database, spaceId: string, statement: SQL) {
  const [, result] = await db.batch([
    // La fila del espacio, no un bloqueo consultivo: así también espera al
    // cambio de país (`leave_incompatible_shared_spaces` la toma FOR UPDATE y
    // elige sucesor). NO KEY UPDATE no frena los INSERT que solo referencian
    // el espacio por FK (movimientos, categorías…).
    db.execute(sql`SELECT 1 FROM spaces WHERE id = ${spaceId}::uuid FOR NO KEY UPDATE`),
    db.execute(statement),
  ]);
  return result;
}

export async function setMemberRole(db: Database, input: { spaceId: string; actorId: string; memberId: string; role: "owner" | "admin" | "member" }) {
  const result = await serializedByMembers(db, input.spaceId, sql`WITH target AS (SELECT id,user_id,role FROM space_members WHERE id=${input.memberId} AND space_id=${input.spaceId} AND status='active'), permitted AS (SELECT target.* FROM target WHERE (SELECT role FROM space_members WHERE space_id=${input.spaceId} AND user_id=${input.actorId} AND status='active')='owner' OR ((SELECT role FROM space_members WHERE space_id=${input.spaceId} AND user_id=${input.actorId} AND status='active')='admin' AND target.role='member' AND ${input.role}='member')), changed AS (UPDATE space_members SET role=${input.role},updated_at=now() WHERE id IN (SELECT id FROM permitted) AND (role <> 'owner' OR ${input.role}='owner' OR (SELECT count(*) FROM space_members WHERE space_id=${input.spaceId} AND status='active' AND role='owner') > 1) RETURNING id) SELECT id FROM changed`); return Boolean(result.rows[0]); }
export async function removeMember(db: Database, input: { spaceId: string; actorId: string; memberId: string }) { const result = await serializedByMembers(db, input.spaceId, sql`WITH target AS (SELECT id,role FROM space_members WHERE id=${input.memberId} AND space_id=${input.spaceId} AND status='active'), permitted AS (SELECT target.* FROM target WHERE (SELECT role FROM space_members WHERE space_id=${input.spaceId} AND user_id=${input.actorId} AND status='active')='owner' OR ((SELECT role FROM space_members WHERE space_id=${input.spaceId} AND user_id=${input.actorId} AND status='active')='admin' AND target.role='member')), changed AS (UPDATE space_members SET status='left',left_at=now(),updated_at=now() WHERE id IN (SELECT id FROM permitted) AND (role <> 'owner' OR (SELECT count(*) FROM space_members WHERE space_id=${input.spaceId} AND status='active' AND role='owner') > 1) RETURNING id) SELECT id FROM changed`); return Boolean(result.rows[0]); }
export async function leaveSpace(db: Database, input: { spaceId: string; userId: string }) { const result = await serializedByMembers(db, input.spaceId, sql`UPDATE space_members SET status='left',left_at=now(),updated_at=now() WHERE space_id=${input.spaceId} AND user_id=${input.userId} AND status='active' AND (role <> 'owner' OR (SELECT count(*) FROM space_members WHERE space_id=${input.spaceId} AND status='active' AND role='owner') > 1) RETURNING id`); return Boolean(result.rows[0]); }
