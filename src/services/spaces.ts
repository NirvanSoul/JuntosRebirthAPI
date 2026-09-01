import { and, eq, isNull } from "drizzle-orm";
import { createDb, type Database } from "../db/client";
import { spaceMembers, spaces } from "../db/schema";

export type SpaceSummary = {
  id: string;
  name: string;
  type: "personal" | "couple" | "other";
  currency: string;
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
      timezone: spaces.timezone,
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
  // Un espacio de pareja no está activo hasta que la invitación se acepta; el
  // cliente lo muestra como "esperando pareja" mientras `activatedAt` sea null.
  const activatedAt = input.type === "couple" ? null : now;

  // Un espacio nuevo nace sin categorías. Sembrar aquí las 18 plantillas hacía
  // que un espacio compartido recién creado apareciera en la app con el
  // historial de categorías ya hecho, como si la persona lo hubiera armado.
  // Las plantillas pertenecen al alta de la cuenta (`POST /v1/bootstrap`, que
  // siembra el espacio personal); en el resto, las categorías las trae quien
  // las crea desde la app o el primer `sync` del espacio.
  await db.batch([
    db.insert(spaces).values({
      id,
      name: input.name,
      type: input.type,
      currency: input.currency,
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
    timezone: input.timezone,
    role: "owner",
    activatedAt,
    createdAt: now,
  };
}

export function createSpacesService(databaseUrl: string) {
  return createDb(databaseUrl);
}
