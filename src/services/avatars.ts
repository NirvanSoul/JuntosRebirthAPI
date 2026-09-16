import { and, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "../db/client";
import { spaceMembers, spaces, userProfiles } from "../db/schema";
import { readJpegInfo } from "../lib/jpeg";

/** Mismos límites que el bucket `avatars` de la base anterior. */
export const MAX_AVATAR_BYTES = 256 * 1024;
export const AVATAR_CONTENT_TYPE = "image/jpeg";

/**
 * Un avatar se pinta como mucho a unos 128 px lógicos; 1024 de lado ya es el
 * doble de lo que necesita una pantalla a 3x. Por encima solo se paga
 * almacenamiento y descarga.
 */
export const MAX_AVATAR_DIMENSION = 1024;
/** Por debajo de esto se ve borroso en cualquier móvil moderno. */
export const MIN_AVATAR_DIMENSION = 64;

export type AvatarRejection =
  | "not_jpeg"
  | "too_large"
  | "empty"
  | "dimensions_too_large"
  | "dimensions_too_small";

/**
 * Comprueba que lo subido es de verdad un JPEG con dimensiones razonables.
 * `Content-Type` lo elige el cliente, así que se valida sobre los bytes.
 */
export function inspectAvatar(
  body: ArrayBuffer,
): { ok: true; width: number; height: number } | { ok: false; reason: AvatarRejection } {
  if (body.byteLength === 0) return { ok: false, reason: "empty" };
  if (body.byteLength > MAX_AVATAR_BYTES) return { ok: false, reason: "too_large" };

  const info = readJpegInfo(body);
  if (!info) return { ok: false, reason: "not_jpeg" };
  if (info.width > MAX_AVATAR_DIMENSION || info.height > MAX_AVATAR_DIMENSION) {
    return { ok: false, reason: "dimensions_too_large" };
  }
  if (info.width < MIN_AVATAR_DIMENSION || info.height < MIN_AVATAR_DIMENSION) {
    return { ok: false, reason: "dimensions_too_small" };
  }

  return { ok: true, ...info };
}

export function avatarKey(userId: string) {
  return `${userId}/avatar.jpg`;
}

export async function saveAvatar(
  db: Database,
  bucket: R2Bucket,
  userId: string,
  body: ArrayBuffer,
): Promise<{ avatarPath: string; avatarUpdatedAt: Date }> {
  const avatarPath = avatarKey(userId);

  await bucket.put(avatarPath, body, {
    httpMetadata: { contentType: AVATAR_CONTENT_TYPE },
  });
  const [profile] = await db
    .update(userProfiles)
    .set({
      avatarPath,
      // La ruta del objeto es estable, por lo que este sello es la única clave
      // de invalidación de caché. El incremento mínimo evita repetir versión
      // incluso si dos cargas se procesan dentro del mismo milisegundo.
      avatarUpdatedAt: sql<Date>`CASE
        WHEN ${userProfiles.avatarUpdatedAt} IS NULL THEN clock_timestamp()
        ELSE GREATEST(clock_timestamp(), ${userProfiles.avatarUpdatedAt} + interval '1 millisecond')
      END`,
      updatedAt: sql<Date>`clock_timestamp()`,
    })
    .where(eq(userProfiles.userId, userId))
    .returning({ avatarUpdatedAt: userProfiles.avatarUpdatedAt });

  if (!profile?.avatarUpdatedAt) throw new Error("PROFILE_NOT_FOUND");

  return { avatarPath, avatarUpdatedAt: profile.avatarUpdatedAt };
}

export async function deleteAvatar(
  db: Database,
  bucket: R2Bucket,
  userId: string,
): Promise<void> {
  await bucket.delete(avatarKey(userId));
  await db
    .update(userProfiles)
    .set({ avatarPath: null, avatarUpdatedAt: null, updatedAt: new Date() })
    .where(eq(userProfiles.userId, userId));
}

/**
 * Reimplementa la política de almacenamiento `shares_active_space_with`: un
 * avatar solo lo ve su dueño o quien comparta con él un espacio activo.
 */
export async function sharesActiveSpace(
  db: Database,
  viewerId: string,
  ownerId: string,
): Promise<boolean> {
  if (viewerId === ownerId) return true;

  const viewer = alias(spaceMembers, "viewer");
  const owner = alias(spaceMembers, "owner");

  const [shared] = await db
    .select({ spaceId: viewer.spaceId })
    .from(viewer)
    .innerJoin(owner, eq(owner.spaceId, viewer.spaceId))
    .innerJoin(spaces, eq(spaces.id, viewer.spaceId))
    .where(
      and(
        eq(viewer.userId, viewerId),
        eq(viewer.status, "active"),
        eq(owner.userId, ownerId),
        eq(owner.status, "active"),
        isNull(spaces.archivedAt),
      ),
    )
    .limit(1);

  return Boolean(shared);
}
