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

/**
 * Elimina la información financiera y de perfil de una persona sin borrar sus
 * credenciales. Los espacios compartidos y su historial sobreviven para la
 * otra persona; se retira la membresía y se anonimiza la autoría del usuario
 * para que no vuelva a asociarse a un perfil que se recreará en el próximo
 * inicio de sesión.
 */
export async function deleteAccountData(db: Database, userId: string): Promise<void> {
  await db.execute(sql`
    WITH memberships AS (
      SELECT space_id FROM space_members WHERE user_id = ${userId}
    ), abandoned AS (
      SELECT memberships.space_id
      FROM memberships
      WHERE NOT EXISTS (
        SELECT 1 FROM space_members other
        WHERE other.space_id = memberships.space_id
          AND other.user_id <> ${userId}
          AND other.status = 'active'
      )
    ), detached_profile AS (
      DELETE FROM user_profiles WHERE user_id = ${userId}
      RETURNING user_id
    ), detached_memberships AS (
      DELETE FROM space_members WHERE user_id = ${userId}
      RETURNING space_id
    ), removed_spaces AS (
      DELETE FROM spaces WHERE id IN (SELECT space_id FROM abandoned)
      RETURNING id
    ), anonymized_spaces AS (
      UPDATE spaces SET created_by = NULL, updated_at = now()
      WHERE created_by = ${userId}
        AND id NOT IN (SELECT space_id FROM abandoned)
      RETURNING id
    ), anonymized_categories AS (
      UPDATE categories SET created_by = NULL, updated_at = now()
      WHERE created_by = ${userId}
        AND space_id NOT IN (SELECT space_id FROM abandoned)
      RETURNING id
    ), anonymized_budgets AS (
      UPDATE category_budgets SET created_by = NULL, updated_at = now()
      WHERE created_by = ${userId}
        AND category_id NOT IN (
          SELECT id FROM categories WHERE space_id IN (SELECT space_id FROM abandoned)
        )
      RETURNING id
    ), anonymized_accounts AS (
      UPDATE money_accounts SET created_by = NULL, updated_at = now()
      WHERE created_by = ${userId}
        AND space_id NOT IN (SELECT space_id FROM abandoned)
      RETURNING id
    ), anonymized_series AS (
      UPDATE recurring_transaction_series SET created_by = NULL, updated_at = now()
      WHERE created_by = ${userId}
        AND space_id NOT IN (SELECT space_id FROM abandoned)
      RETURNING id
    ), anonymized_transactions AS (
      UPDATE transactions SET created_by = NULL, updated_at = now()
      WHERE created_by = ${userId}
        AND space_id NOT IN (SELECT space_id FROM abandoned)
      RETURNING id
    ), removed_invitations AS (
      DELETE FROM space_invitations
      WHERE invited_by = ${userId}
        AND space_id NOT IN (SELECT space_id FROM abandoned)
      RETURNING id
    ), removed_acceptances AS (
      DELETE FROM legal_acceptances WHERE user_id = ${userId}
      RETURNING id
    )
    DELETE FROM user_push_tokens WHERE user_id = ${userId}
  `);
}
