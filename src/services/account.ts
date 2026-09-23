import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { financialContexts, spaceMembers, spaces, user, userProfiles } from "../db/schema";
import { normalizeCountryCode } from "../lib/country";
import { claimEmailInvitations } from "./invitations";

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
};

export type Profile = {
  displayName: string;
  locale: string;
  defaultCurrency: string;
  countryCode: string | null;
  avatarPath: string | null;
  avatarUpdatedAt: Date | null;
};

export type PersonalSpace = {
  id: string;
  name: string;
  type: "personal";
  currency: string;
  timezone: string;
  role: "owner";
};

export type FinancialContext = {
  id: string;
  countryCode: string;
  canonicalCurrency: string;
  personalSpaceId: string;
};

export type CurrentAccount = {
  user: CurrentUser;
  profile: Profile | null;
  personalSpaceId: string | null;
  activeFinancialContext: FinancialContext | null;
};

export async function findCurrentUser(
  db: Database,
  userId: string,
): Promise<CurrentUser | null> {
  const [row] = await db
    .select({ id: user.id, name: user.name, email: user.email, image: user.image })
    .from(user)
    .where(eq(user.id, userId));
  return row ?? null;
}

/**
 * Lectura compacta para `GET /me`. El polling antes requería una consulta de
 * usuario, otra de perfil y una tercera para el contexto financiero; este
 * join por claves primarias conserva la respuesta y usa una sola lectura.
 */
export async function findCurrentAccount(
  db: Database,
  userId: string,
): Promise<CurrentAccount | null> {
  const [row] = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      displayName: userProfiles.displayName,
      locale: userProfiles.locale,
      defaultCurrency: userProfiles.defaultCurrency,
      countryCode: userProfiles.countryCode,
      avatarPath: userProfiles.avatarPath,
      avatarUpdatedAt: userProfiles.avatarUpdatedAt,
      personalSpaceId: userProfiles.personalSpaceId,
      contextId: financialContexts.id,
      contextCountryCode: financialContexts.countryCode,
      canonicalCurrency: financialContexts.canonicalCurrency,
      contextPersonalSpaceId: financialContexts.personalSpaceId,
    })
    .from(user)
    .leftJoin(userProfiles, eq(userProfiles.userId, user.id))
    .leftJoin(financialContexts, eq(userProfiles.activeFinancialContextId, financialContexts.id))
    .where(eq(user.id, userId));

  if (!row) return null;
  return {
    user: { id: row.id, name: row.name, email: row.email, image: row.image },
    profile: row.displayName === null
      ? null
      : {
          displayName: row.displayName,
          locale: row.locale!,
          defaultCurrency: row.defaultCurrency!,
          countryCode: row.countryCode,
          avatarPath: row.avatarPath,
          avatarUpdatedAt: row.avatarUpdatedAt,
        },
    personalSpaceId: row.personalSpaceId,
    activeFinancialContext: row.contextId
      ? {
          id: row.contextId,
          countryCode: row.contextCountryCode!,
          canonicalCurrency: row.canonicalCurrency!,
          personalSpaceId: row.contextPersonalSpaceId!,
        }
      : null,
  };
}

export async function bootstrapAccount(
  db: Database,
  currentUser: CurrentUser,
  timezone: string,
) {
  const displayName = normalizeDisplayName(currentUser.name);
  const [createdProfile] = await db
    .insert(userProfiles)
    .values({ userId: currentUser.id, displayName })
    .onConflictDoNothing()
    .returning({ userId: userProfiles.userId });

  await claimEmailInvitations(db, currentUser.id, currentUser.email);

  const spaceId = crypto.randomUUID();
  const contextId = crypto.randomUUID();

  const result = await db.execute(sql`
    WITH claimed_profile AS (
      UPDATE user_profiles
      SET personal_space_id = ${spaceId}, active_financial_context_id = ${contextId}, updated_at = now()
      WHERE user_id = ${currentUser.id} AND personal_space_id IS NULL
      RETURNING personal_space_id
    ), new_space AS (
      INSERT INTO spaces (id, name, type, currency, country_code, timezone, created_by, activated_at, created_at, updated_at)
      SELECT ${spaceId}, 'Personal', 'personal', default_currency, country_code, ${timezone}, ${currentUser.id}, now(), now(), now()
      FROM user_profiles
      WHERE user_id = ${currentUser.id} AND EXISTS (SELECT 1 FROM claimed_profile)
      RETURNING id, country_code, currency
    ), owner_membership AS (
      INSERT INTO space_members (space_id, user_id, role, status, joined_at, created_at, updated_at)
      SELECT id, ${currentUser.id}, 'owner', 'active', now(), now(), now()
      FROM new_space
      ON CONFLICT (space_id, user_id) DO UPDATE
        SET role = 'owner', status = 'active', left_at = NULL, updated_at = now()
      RETURNING space_id
    ), new_context AS (
      INSERT INTO financial_contexts (id, user_id, country_code, canonical_currency, personal_space_id, created_at, updated_at)
      SELECT ${contextId}, ${currentUser.id}, COALESCE(country_code, 'ZZ'), currency, id, now(), now()
      FROM new_space
      ON CONFLICT (user_id, country_code) DO NOTHING
      RETURNING id, personal_space_id
    ), active_context AS (
      UPDATE user_profiles
      SET active_financial_context_id = COALESCE(
        (SELECT id FROM new_context),
        (SELECT id FROM financial_contexts WHERE user_id=${currentUser.id}
          AND personal_space_id=(SELECT personal_space_id FROM user_profiles WHERE user_id=${currentUser.id}) LIMIT 1)
      ), updated_at=now()
      -- Los perfiles nuevos ya se actualizan en claimed_profile. PostgreSQL
      -- no permite actualizar de forma fiable la misma fila en dos CTE.
      WHERE user_id=${currentUser.id} AND personal_space_id IS NOT NULL
        AND active_financial_context_id IS NULL
      RETURNING active_financial_context_id
    )
    SELECT EXISTS (SELECT 1 FROM new_space) AS personal_space_created
  `);

  const personalSpace = await findPersonalSpace(db, currentUser.id);
  if (!personalSpace) throw new Error("Bootstrap did not produce a personal space");

  const profile = await findProfile(db, currentUser.id);
  if (!profile) throw new Error("Bootstrap did not produce a profile");

  return {
    profile,
    personalSpace,
    activeFinancialContext: await findActiveFinancialContext(db, currentUser.id),
    created: {
      profile: Boolean(createdProfile),
      personalSpace: Boolean(result.rows[0]?.personal_space_created),
    },
  };
}

export async function getAccountState(db: Database, userId: string) {
  const [profile] = await db
    .select({
      displayName: userProfiles.displayName,
      locale: userProfiles.locale,
      defaultCurrency: userProfiles.defaultCurrency,
      countryCode: userProfiles.countryCode,
      avatarPath: userProfiles.avatarPath,
      avatarUpdatedAt: userProfiles.avatarUpdatedAt,
      personalSpaceId: userProfiles.personalSpaceId,
      activeFinancialContextId: userProfiles.activeFinancialContextId,
    })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId));

  return {
    profile: profile
      ? {
          displayName: profile.displayName,
          locale: profile.locale,
          defaultCurrency: profile.defaultCurrency,
          countryCode: profile.countryCode,
          avatarPath: profile.avatarPath,
          avatarUpdatedAt: profile.avatarUpdatedAt,
        }
      : null,
    personalSpaceId: profile?.personalSpaceId ?? null,
    activeFinancialContext: profile?.activeFinancialContextId
      ? await findActiveFinancialContext(db, userId)
      : null,
  };
}

export async function findUserCountryCode(db: Database, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ countryCode: userProfiles.countryCode })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId));
  return row?.countryCode ?? null;
}

export async function updateProfile(
  db: Database,
  userId: string,
  input: Partial<Pick<Profile, "displayName" | "locale" | "defaultCurrency" | "countryCode">>,
): Promise<(Profile & { leftSharedSpaceIds?: string[] }) | null> {
  // El país activa un libro personal independiente. Los libros anteriores no
  // se modifican: al volver al país se recupera el mismo espacio personal.
  // La consulta y el UPDATE viven en una única sentencia: si la condición deja
  // de cumplirse entre ambas fases, no queda un perfil a medio cambiar.
  if (input.countryCode !== undefined) {
    const countryCode = normalizeCountryCode(input.countryCode);
    if (!countryCode) throw new Error("INVALID_REQUEST");
    const canonicalCurrency = canonicalCurrencyForCountry(
      countryCode,
      input.defaultCurrency,
    );
    const spaceId = crypto.randomUUID();
    const contextId = crypto.randomUUID();
    const result = await db.execute(sql`
      WITH existing_context AS (
        SELECT id, personal_space_id, canonical_currency
        FROM financial_contexts WHERE user_id=${userId} AND country_code=${countryCode}
      ), new_space AS (
        INSERT INTO spaces (id, name, type, currency, country_code, timezone, created_by, activated_at, created_at, updated_at)
        SELECT ${spaceId}, 'Personal', 'personal', ${canonicalCurrency}, ${countryCode},
          COALESCE((SELECT timezone FROM spaces WHERE id=(SELECT personal_space_id FROM user_profiles WHERE user_id=${userId})), 'UTC'),
          ${userId}, now(), now(), now()
        WHERE EXISTS (SELECT 1 FROM user_profiles WHERE user_id=${userId})
          AND NOT EXISTS (SELECT 1 FROM existing_context)
        RETURNING id
      ), new_membership AS (
        INSERT INTO space_members (space_id, user_id, role, status, joined_at, created_at, updated_at)
        SELECT id, ${userId}, 'owner', 'active', now(), now(), now() FROM new_space
        ON CONFLICT (space_id, user_id) DO UPDATE SET status='active', left_at=NULL, updated_at=now()
      ), new_context AS (
        INSERT INTO financial_contexts (id, user_id, country_code, canonical_currency, personal_space_id, created_at, updated_at)
        SELECT ${contextId}, ${userId}, ${countryCode}, ${canonicalCurrency}, id, now(), now() FROM new_space
        RETURNING id, personal_space_id, canonical_currency
      ), activated_context AS (
        SELECT id, personal_space_id, canonical_currency FROM existing_context
        UNION ALL
        SELECT id, personal_space_id, canonical_currency FROM new_context
      ), changed AS (
        UPDATE user_profiles SET
          display_name=COALESCE(${input.displayName ?? null}, display_name),
          locale=COALESCE(${input.locale ?? null}, locale),
          default_currency=(SELECT canonical_currency FROM activated_context),
          country_code=${countryCode},
          personal_space_id=(SELECT personal_space_id FROM activated_context),
          active_financial_context_id=(SELECT id FROM activated_context), updated_at=now()
        WHERE user_id=${userId}
        RETURNING display_name, locale, default_currency, country_code, avatar_path, avatar_updated_at
      )
      -- El snapshot de esta sentencia conserva las membresías anteriores.
      -- El trigger user_profiles_country_memberships materializa la salida
      -- de forma atómica con changed antes de devolver la respuesta.
      SELECT changed.*, ARRAY(
        SELECT m.space_id FROM space_members m
        JOIN spaces s ON s.id=m.space_id
        WHERE m.user_id=${userId} AND m.status='active' AND s.type<>'personal'
          AND s.country_code IS DISTINCT FROM ${countryCode}
        ORDER BY m.space_id
      ) AS left_shared_space_ids FROM changed
    `);
    const row = result.rows[0];
    if (row && input.displayName) {
      await db
        .update(user)
        .set({ name: input.displayName, updatedAt: new Date() })
        .where(eq(user.id, userId));
    }
    return row ? { displayName: row.display_name as string, locale: row.locale as string, defaultCurrency: row.default_currency as string, countryCode: row.country_code as string | null, avatarPath: row.avatar_path as string | null, avatarUpdatedAt: row.avatar_updated_at as Date | null, leftSharedSpaceIds: row.left_shared_space_ids as string[] } : null;
  }
  const [profile] = await db
    .update(userProfiles)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(userProfiles.userId, userId))
    .returning({
      displayName: userProfiles.displayName,
      locale: userProfiles.locale,
      defaultCurrency: userProfiles.defaultCurrency,
      countryCode: userProfiles.countryCode,
      avatarPath: userProfiles.avatarPath,
      avatarUpdatedAt: userProfiles.avatarUpdatedAt,
    });
  if (profile && input.displayName) {
    await db
      .update(user)
      .set({ name: input.displayName, updatedAt: new Date() })
      .where(eq(user.id, userId));
  }
  return profile ?? null;
}

export async function findActiveFinancialContext(
  db: Database,
  userId: string,
): Promise<FinancialContext | null> {
  const [row] = await db
    .select({
      id: financialContexts.id,
      countryCode: financialContexts.countryCode,
      canonicalCurrency: financialContexts.canonicalCurrency,
      personalSpaceId: financialContexts.personalSpaceId,
    })
    .from(userProfiles)
    .innerJoin(financialContexts, eq(userProfiles.activeFinancialContextId, financialContexts.id))
    .where(eq(userProfiles.userId, userId));
  return row ?? null;
}

function canonicalCurrencyForCountry(countryCode: string, requestedCurrency?: string) {
  if (countryCode === "VE") return "USD";
  if (countryCode === "ES") return "EUR";
  return requestedCurrency ?? "EUR";
}

async function findProfile(db: Database, userId: string): Promise<Profile | null> {
  const [profile] = await db
    .select({
      displayName: userProfiles.displayName,
      locale: userProfiles.locale,
      defaultCurrency: userProfiles.defaultCurrency,
      countryCode: userProfiles.countryCode,
      avatarPath: userProfiles.avatarPath,
      avatarUpdatedAt: userProfiles.avatarUpdatedAt,
    })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId));
  return profile ?? null;
}

async function findPersonalSpace(
  db: Database,
  userId: string,
): Promise<PersonalSpace | null> {
  const [row] = await db
    .select({
      id: spaces.id,
      name: spaces.name,
      type: spaces.type,
      currency: spaces.currency,
      timezone: spaces.timezone,
      role: spaceMembers.role,
    })
    .from(userProfiles)
    .innerJoin(spaces, eq(userProfiles.personalSpaceId, spaces.id))
    .innerJoin(
      spaceMembers,
      and(eq(spaceMembers.spaceId, spaces.id), eq(spaceMembers.userId, userId)),
    )
    .where(eq(userProfiles.userId, userId));

  if (!row || row.type !== "personal" || row.role !== "owner") return null;
  return { ...row, type: "personal", role: "owner" };
}

function normalizeDisplayName(value: string) {
  return value.trim().slice(0, 60) || "Usuario";
}
