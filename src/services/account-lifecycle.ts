import { desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { legalAcceptances, user, userProfiles } from "../db/schema";
import { buildSnapshot, type Snapshot } from "./sync-snapshot";

export type LegalAcceptanceInput = {
  documentType: "privacy-policy" | "terms-of-service";
  documentVersion: string;
  appVersion: string | null;
  locale: string | null;
  source: string | null;
};

export async function recordLegalAcceptance(
  db: Database,
  userId: string,
  input: LegalAcceptanceInput,
) {
  const [row] = await db
    .insert(legalAcceptances)
    .values({ userId, ...input })
    .returning({
      id: legalAcceptances.id,
      documentType: legalAcceptances.documentType,
      documentVersion: legalAcceptances.documentVersion,
      acceptedAt: legalAcceptances.acceptedAt,
    });
  return row;
}

export type AccountExport = Snapshot & {
  profile: {
    userId: string;
    email: string;
    displayName: string | null;
    locale: string | null;
    defaultCurrency: string | null;
    avatarPath: string | null;
    createdAt: Date | null;
  } | null;
  legalAcceptances: {
    documentType: string;
    documentVersion: string;
    appVersion: string | null;
    locale: string | null;
    acceptedAt: Date;
  }[];
};

/** Sustituye la edge function `export-user-data`. */
export async function exportAccount(db: Database, userId: string): Promise<AccountExport> {
  const [snapshot, profiles, acceptances] = await Promise.all([
    buildSnapshot(db, userId),
    db
      .select({
        userId: user.id,
        email: user.email,
        displayName: userProfiles.displayName,
        locale: userProfiles.locale,
        defaultCurrency: userProfiles.defaultCurrency,
        avatarPath: userProfiles.avatarPath,
        createdAt: userProfiles.createdAt,
      })
      .from(user)
      .leftJoin(userProfiles, eq(userProfiles.userId, user.id))
      .where(eq(user.id, userId))
      .limit(1),
    db
      .select({
        documentType: legalAcceptances.documentType,
        documentVersion: legalAcceptances.documentVersion,
        appVersion: legalAcceptances.appVersion,
        locale: legalAcceptances.locale,
        acceptedAt: legalAcceptances.acceptedAt,
      })
      .from(legalAcceptances)
      .where(eq(legalAcceptances.userId, userId))
      .orderBy(desc(legalAcceptances.acceptedAt)),
  ]);

  return { ...snapshot, profile: profiles[0] ?? null, legalAcceptances: acceptances };
}

/**
 * Sustituye a `request_account_deletion` y a la edge function `delete-account`.
 *
 * Los espacios que la persona comparte con alguien más sobreviven: solo se
 * borran aquellos en los que era el último miembro activo, para no arrastrar el
 * historial de la pareja. Todo lo que cuelga del usuario (perfil, membresías,
 * invitaciones, consentimientos, lotes de migración) cae por `ON DELETE CASCADE`.
 */
export async function deleteAccount(db: Database, userId: string): Promise<void> {
  await db.execute(sql`
    WITH memberships AS (
      SELECT space_id FROM space_members WHERE user_id = ${userId} AND status = 'active'
    ), abandoned AS (
      SELECT memberships.space_id
      FROM memberships
      WHERE NOT EXISTS (
        SELECT 1 FROM space_members other
        WHERE other.space_id = memberships.space_id
          AND other.user_id <> ${userId}
          AND other.status = 'active'
      )
    ), released AS (
      -- El perfil apunta al espacio personal; hay que soltarlo antes de borrarlo.
      UPDATE user_profiles SET personal_space_id = NULL, updated_at = now()
      WHERE user_id = ${userId}
      RETURNING user_id
    ), removed_spaces AS (
      DELETE FROM spaces WHERE id IN (SELECT space_id FROM abandoned) RETURNING id
    )
    DELETE FROM "user" WHERE id = ${userId}
  `);
}
