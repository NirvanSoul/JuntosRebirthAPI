import { activeSpaceScope } from "./active-space-scope";
import { and, eq, isNull, sql } from "drizzle-orm";
import { createDb, type Database } from "../db/client";
import { spaceMembers, spaces, userProfiles } from "../db/schema";

export type SpaceSummary = {
  id: string;
  name: string;
  type: "personal" | "couple" | "other";
  currency: string;
  countryCode?: string | null;
  timezone: string;
  role: "owner" | "admin" | "member";
  activatedAt: Date | null;
  createdAt: Date;
};

export type CreateSpaceInput = {
  name: string;
  type: "personal" | "couple" | "other";
  currency: string;
  timezone: string;
};

export async function listActiveSpaces(
  db: Database,
  userId: string,
): Promise<SpaceSummary[]> {
  return buildListActiveSpacesQuery(db, userId);
}

export function buildListActiveSpacesQuery(db: Database, userId: string) {
  return db
    .select({
      id: spaces.id,
      name: spaces.name,
      type: spaces.type,
      currency: spaces.currency,
      countryCode: spaces.countryCode,
      timezone: spaces.timezone,
      role: spaceMembers.role,
      activatedAt: spaces.activatedAt,
      createdAt: spaces.createdAt,
    })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaceMembers.spaceId, spaces.id))
    .leftJoin(userProfiles, eq(userProfiles.userId, spaceMembers.userId))
    .where(
      and(
        eq(spaceMembers.userId, userId),
        eq(spaceMembers.status, "active"),
        isNull(spaces.archivedAt),
        activeSpaceScope(),
        sql`(
          ${spaces.type} <> 'couple'
          OR ${spaces.activatedAt} IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM space_invitations
            WHERE space_invitations.space_id = ${spaces.id}
              AND space_invitations.status = 'pending'
          )
        )`,
      ),
    );
}

export async function createSpaceWithOwner(
  db: Database,
  userId: string,
  input: CreateSpaceInput,
): Promise<SpaceSummary> {
  const id = crypto.randomUUID();
  const now = new Date();
  // Un espacio de pareja no está activo hasta que la invitación se acepta; el
  // cliente lo muestra como "esperando pareja" mientras `activatedAt` sea null.
  const activatedAt = input.type === "couple" ? null : now;

  // Un espacio nuevo nace sin categorías. Sembrar aquí las 18 plantillas hacía
  // que un espacio compartido recién creado apareciera en la app con el
  // historial de categorías ya hecho, como si la persona lo hubiera armado.
  // Las plantillas pertenecen al alta de la cuenta (`POST /v1/bootstrap`, que
  // siembra el espacio personal); en el resto, las categorías las trae quien
  // las crea desde la app o el primer `sync` del espacio.
  const [ownerProfile] = await db.select({ countryCode: userProfiles.countryCode }).from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1);
  await db.batch([
    db.insert(spaces).values({
      id,
      name: input.name,
      type: input.type,
      currency: input.currency,
      countryCode: ownerProfile?.countryCode ?? null,
      timezone: input.timezone,
      createdBy: userId,
      activatedAt,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(spaceMembers).values({
      spaceId: id,
      userId,
      role: "owner",
      status: "active",
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    }),
  ]);

  return {
    id,
    name: input.name,
    type: input.type,
    currency: input.currency,
    countryCode: ownerProfile?.countryCode ?? null,
    timezone: input.timezone,
    role: "owner",
    activatedAt,
    createdAt: now,
  };
}

export function createSpacesService(databaseUrl: string) {
  return createDb(databaseUrl);
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CancelPendingCoupleSpaceResult =
  | { success: true }
  | { success: false; code: "SPACE_NOT_FOUND" | "FORBIDDEN" | "INVALID_REQUEST" };

export async function cancelPendingCoupleSpace(
  db: Database,
  input: { spaceId: string; userId: string },
): Promise<CancelPendingCoupleSpaceResult> {
  if (!UUID_REGEX.test(input.spaceId)) {
    return { success: false, code: "SPACE_NOT_FOUND" };
  }

  const result = await db.execute<{
    space_id: string | null;
    space_type: string | null;
    space_activated_at: Date | null;
    space_archived_at: Date | null;
    member_role: string | null;
    member_status: string | null;
    active_partners: number | null;
    deleted_id: string | null;
  }>(sql`
    WITH locked_space AS (
      SELECT id, type, activated_at, archived_at
      FROM spaces
      WHERE id = ${input.spaceId}
      FOR UPDATE
    ),
    ownership AS (
      SELECT role, status
      FROM space_members
      WHERE space_id = ${input.spaceId} AND user_id = ${input.userId}
    ),
    partner_membership AS (
      SELECT count(*)::int AS active_partners
      FROM space_members
      WHERE space_id = ${input.spaceId} AND user_id != ${input.userId} AND status = 'active'
    ),
    locked_invitations AS (
      SELECT id
      FROM space_invitations
      WHERE space_id = ${input.spaceId} AND status = 'pending'
      FOR UPDATE
    ),
    revoked_invitations AS (
      UPDATE space_invitations
      SET status = 'revoked', updated_at = now()
      WHERE space_id = ${input.spaceId} AND status = 'pending'
        AND EXISTS (
          SELECT 1 FROM locked_space s, ownership o, partner_membership p
          WHERE s.type = 'couple'
            AND s.activated_at IS NULL
            AND s.archived_at IS NULL
            AND o.role = 'owner'
            AND o.status = 'active'
            AND p.active_partners = 0
        )
      RETURNING id
    ),
    deleted_members AS (
      DELETE FROM space_members
      WHERE space_id = ${input.spaceId}
        AND EXISTS (
          SELECT 1 FROM locked_space s, ownership o, partner_membership p
          WHERE s.type = 'couple'
            AND s.activated_at IS NULL
            AND s.archived_at IS NULL
            AND o.role = 'owner'
            AND o.status = 'active'
            AND p.active_partners = 0
        )
      RETURNING id
    ),
    deleted_space AS (
      DELETE FROM spaces
      WHERE id = ${input.spaceId}
        AND EXISTS (
          SELECT 1 FROM locked_space s, ownership o, partner_membership p
          WHERE s.type = 'couple'
            AND s.activated_at IS NULL
            AND s.archived_at IS NULL
            AND o.role = 'owner'
            AND o.status = 'active'
            AND p.active_partners = 0
        )
      RETURNING id
    )
    SELECT
      (SELECT id FROM locked_space) AS space_id,
      (SELECT type FROM locked_space) AS space_type,
      (SELECT activated_at FROM locked_space) AS space_activated_at,
      (SELECT archived_at FROM locked_space) AS space_archived_at,
      (SELECT role FROM ownership) AS member_role,
      (SELECT status FROM ownership) AS member_status,
      (SELECT active_partners FROM partner_membership) AS active_partners,
      (SELECT id FROM deleted_space) AS deleted_id
  `);

  const row = (result.rows ?? result)[0] as {
    space_id: string | null;
    space_type: string | null;
    space_activated_at: Date | null;
    space_archived_at: Date | null;
    member_role: string | null;
    member_status: string | null;
    active_partners: number | null;
    deleted_id: string | null;
  } | undefined;

  if (!row || !row.space_id) {
    return { success: false, code: "SPACE_NOT_FOUND" };
  }

  if (row.member_role !== "owner" || row.member_status !== "active") {
    return { success: false, code: "FORBIDDEN" };
  }

  if (row.space_type !== "couple") {
    return { success: false, code: "INVALID_REQUEST" };
  }

  if (row.space_activated_at !== null || (row.active_partners ?? 0) > 0 || row.space_archived_at !== null) {
    return { success: false, code: "INVALID_REQUEST" };
  }

  if (!row.deleted_id) {
    return { success: false, code: "INVALID_REQUEST" };
  }

  return { success: true };
}
