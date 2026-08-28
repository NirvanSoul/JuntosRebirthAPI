import { and, eq, isNull } from "drizzle-orm";
import { createDb, type Database } from "../db/client";
import { spaceMembers, spaces } from "../db/schema";

export type ActiveSpaceMembership = {
  spaceId: string;
  role: "owner" | "admin" | "member";
};

export async function findActiveSpaceMembership(
  db: Database,
  userId: string,
  spaceId: string,
): Promise<ActiveSpaceMembership | null> {
  const [membership] = await buildActiveSpaceMembershipQuery(db, userId, spaceId);

  return membership ?? null;
}

export function buildActiveSpaceMembershipQuery(
  db: Database,
  userId: string,
  spaceId: string,
) {
  return db
    .select({
      spaceId: spaceMembers.spaceId,
      role: spaceMembers.role,
    })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaceMembers.spaceId, spaces.id))
    .where(
      and(
        eq(spaceMembers.spaceId, spaceId),
        eq(spaceMembers.userId, userId),
        eq(spaceMembers.status, "active"),
        isNull(spaces.archivedAt),
      ),
    )
    .limit(1);
}

export function createSpaceAccessService(databaseUrl: string) {
  return createDb(databaseUrl);
}
