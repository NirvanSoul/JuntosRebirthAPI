import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { spaceMembers, user, userProfiles } from "../db/schema";

export type Member = {
  id: string;
  userId: string;
  role: "owner" | "admin" | "member";
  displayName: string;
  image: string | null;
  /** Alimenta la caché `space_member_profiles` del SQLite local. */
  avatarPath: string | null;
  avatarUpdatedAt: Date | null;
  defaultCurrency: string | null;
  joinedAt: Date;
};
export async function listMembers(db: Database, spaceId: string): Promise<Member[]> { const rows=await db.select({ id: spaceMembers.id, userId: spaceMembers.userId, role: spaceMembers.role, displayName: userProfiles.displayName, image: user.image, avatarPath: userProfiles.avatarPath, avatarUpdatedAt: userProfiles.avatarUpdatedAt, defaultCurrency: userProfiles.defaultCurrency, joinedAt: spaceMembers.joinedAt }).from(spaceMembers).innerJoin(user, eq(spaceMembers.userId, user.id)).leftJoin(userProfiles, eq(userProfiles.userId, user.id)).where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.status, "active"))); return rows.map(row=>({...row,displayName:row.displayName??"Usuario"})); }
export async function setMemberRole(db: Database, input: { spaceId: string; actorId: string; memberId: string; role: "owner" | "admin" | "member" }) {
  const result = await db.execute(sql`WITH target AS (SELECT id,user_id,role FROM space_members WHERE id=${input.memberId} AND space_id=${input.spaceId} AND status='active'), permitted AS (SELECT target.* FROM target WHERE (SELECT role FROM space_members WHERE space_id=${input.spaceId} AND user_id=${input.actorId} AND status='active')='owner' OR ((SELECT role FROM space_members WHERE space_id=${input.spaceId} AND user_id=${input.actorId} AND status='active')='admin' AND target.role='member' AND ${input.role}='member')), changed AS (UPDATE space_members SET role=${input.role},updated_at=now() WHERE id IN (SELECT id FROM permitted) AND (role <> 'owner' OR ${input.role}='owner' OR (SELECT count(*) FROM space_members WHERE space_id=${input.spaceId} AND status='active' AND role='owner') > 1) RETURNING id) SELECT id FROM changed`); return Boolean(result.rows[0]); }
export async function removeMember(db: Database, input: { spaceId: string; actorId: string; memberId: string }) { const result = await db.execute(sql`WITH target AS (SELECT id,role FROM space_members WHERE id=${input.memberId} AND space_id=${input.spaceId} AND status='active'), permitted AS (SELECT target.* FROM target WHERE (SELECT role FROM space_members WHERE space_id=${input.spaceId} AND user_id=${input.actorId} AND status='active')='owner' OR ((SELECT role FROM space_members WHERE space_id=${input.spaceId} AND user_id=${input.actorId} AND status='active')='admin' AND target.role='member')), changed AS (UPDATE space_members SET status='left',left_at=now(),updated_at=now() WHERE id IN (SELECT id FROM permitted) AND (role <> 'owner' OR (SELECT count(*) FROM space_members WHERE space_id=${input.spaceId} AND status='active' AND role='owner') > 1) RETURNING id) SELECT id FROM changed`); return Boolean(result.rows[0]); }
export async function leaveSpace(db: Database, input: { spaceId: string; userId: string }) { const result = await db.execute(sql`UPDATE space_members SET status='left',left_at=now(),updated_at=now() WHERE space_id=${input.spaceId} AND user_id=${input.userId} AND status='active' AND (role <> 'owner' OR (SELECT count(*) FROM space_members WHERE space_id=${input.spaceId} AND status='active' AND role='owner') > 1) RETURNING id`); return Boolean(result.rows[0]); }
