import { and, eq, isNull } from "drizzle-orm";
import { createDb, type Database } from "../db/client";
import { spaceMembers, spaces } from "../db/schema";

export type SpaceSummary = {
  id: string;
  name: string;
  type: "personal" | "couple" | "other";
  currency: string;
  role: "owner" | "admin" | "member";
  activatedAt: Date | null;
  createdAt: Date;
};

export type CreateSpaceInput = {
  name: string;
  type: "personal" | "couple" | "other";
  currency: string;
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
      role: spaceMembers.role,
      activatedAt: spaces.activatedAt,
      createdAt: spaces.createdAt,
    })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaceMembers.spaceId, spaces.id))
    .where(
      and(
        eq(spaceMembers.userId, userId),
        eq(spaceMembers.status, "active"),
        isNull(spaces.archivedAt),
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

  await db.batch([
    db.insert(spaces).values({
      id,
      name: input.name,
      type: input.type,
      currency: input.currency,
      createdBy: userId,
      activatedAt: now,
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
    role: "owner",
    activatedAt: now,
    createdAt: now,
  };
}

export function createSpacesService(databaseUrl: string) {
  return createDb(databaseUrl);
}
