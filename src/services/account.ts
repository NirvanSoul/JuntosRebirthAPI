import { and, eq, sql } from "drizzle-orm";
import { defaultCategories } from "../constants/default-categories";
import type { Database } from "../db/client";
import { spaceMembers, spaces, user, userProfiles } from "../db/schema";
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
};

export type PersonalSpace = {
  id: string;
  name: string;
  type: "personal";
  currency: string;
  timezone: string;
  role: "owner";
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
  const categoryValues = sql.join(
    defaultCategories.map(
      (category) =>
        sql`(${category.key}, ${category.name}, ${category.icon}, ${category.colorToken})`,
    ),
    sql`, `,
  );

  const result = await db.execute(sql`
    WITH claimed_profile AS (
      UPDATE user_profiles
      SET personal_space_id = ${spaceId}, updated_at = now()
      WHERE user_id = ${currentUser.id} AND personal_space_id IS NULL
      RETURNING personal_space_id
    ), new_space AS (
      INSERT INTO spaces (id, name, type, currency, timezone, created_by, activated_at, created_at, updated_at)
      SELECT ${spaceId}, 'Personal', 'personal', default_currency, ${timezone}, ${currentUser.id}, now(), now(), now()
      FROM user_profiles
      WHERE user_id = ${currentUser.id} AND EXISTS (SELECT 1 FROM claimed_profile)
      RETURNING id
    ), owner_membership AS (
      INSERT INTO space_members (space_id, user_id, role, status, joined_at, created_at, updated_at)
      SELECT id, ${currentUser.id}, 'owner', 'active', now(), now(), now()
      FROM new_space
      ON CONFLICT (space_id, user_id) DO UPDATE
        SET role = 'owner', status = 'active', left_at = NULL, updated_at = now()
      RETURNING space_id
    ), initial_categories AS (
      INSERT INTO categories (space_id, name, icon, color_token, created_by, is_default, template_key, created_at, updated_at)
      SELECT new_space.id, definition.name, definition.icon, definition.color_token,
        ${currentUser.id}, true, definition.template_key, now(), now()
      FROM new_space
      CROSS JOIN (VALUES ${categoryValues}) AS definition(template_key, name, icon, color_token)
      ON CONFLICT (space_id, template_key) WHERE template_key IS NOT NULL DO NOTHING
      RETURNING id
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
      personalSpaceId: userProfiles.personalSpaceId,
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
        }
      : null,
    personalSpaceId: profile?.personalSpaceId ?? null,
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
): Promise<Profile | null> {
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
    });
  return profile ?? null;
}

async function findProfile(db: Database, userId: string): Promise<Profile | null> {
  const [profile] = await db
    .select({
      displayName: userProfiles.displayName,
      locale: userProfiles.locale,
      defaultCurrency: userProfiles.defaultCurrency,
      countryCode: userProfiles.countryCode,
      avatarPath: userProfiles.avatarPath,
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
  return value.trim().slice(0, 80) || "Usuario";
}
