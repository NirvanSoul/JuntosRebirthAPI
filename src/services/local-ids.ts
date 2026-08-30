import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import { categories, spaceMembers, spaces, userProfiles } from "../db/schema";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** El espacio personal tiene siempre este id en el SQLite del dispositivo. */
const LOCAL_PERSONAL_SPACE_ID = "personal";

/**
 * Traduce el id local de un espacio al remoto. El dispositivo conoce sus
 * espacios por identificadores propios, así que hay tres caminos:
 *
 *  1. ya es un UUID remoto del que la persona es miembro activo;
 *  2. está enlazado por `(source_installation_id, source_local_id)`;
 *  3. es el espacio personal, que en el cliente se llama literalmente "personal".
 */
export async function resolveSpaceId(
  db: Database,
  userId: string,
  installationId: string,
  localId: string,
): Promise<string | null> {
  const memberships = await db
    .select({
      id: spaces.id,
      sourceInstallationId: spaces.sourceInstallationId,
      sourceLocalId: spaces.sourceLocalId,
    })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaceMembers.spaceId, spaces.id))
    .where(and(eq(spaceMembers.userId, userId), eq(spaceMembers.status, "active")));

  if (UUID.test(localId)) {
    const direct = memberships.find((space) => space.id === localId);
    if (direct) return direct.id;
  }

  const linked = memberships.find(
    (space) =>
      space.sourceInstallationId === installationId && space.sourceLocalId === localId,
  );
  if (linked) return linked.id;

  if (localId === LOCAL_PERSONAL_SPACE_ID) {
    const [profile] = await db
      .select({ personalSpaceId: userProfiles.personalSpaceId })
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .limit(1);
    return profile?.personalSpaceId ?? null;
  }

  return null;
}

/** Mismo criterio, para las categorías de un espacio ya resuelto. */
export async function categoryIdResolver(
  db: Database,
  spaceIds: string[],
  installationId: string,
) {
  if (spaceIds.length === 0) return () => null;

  const rows = await db
    .select({
      id: categories.id,
      sourceInstallationId: categories.sourceInstallationId,
      sourceLocalId: categories.sourceLocalId,
    })
    .from(categories)
    .where(inArray(categories.spaceId, spaceIds));

  const byId = new Set(rows.map((row) => row.id));
  const bySource = new Map(
    rows
      .filter((row) => row.sourceInstallationId === installationId && row.sourceLocalId)
      .map((row) => [row.sourceLocalId as string, row.id]),
  );

  return (localId: unknown): string | null => {
    if (typeof localId !== "string" || !localId) return null;
    const linked = bySource.get(localId);
    if (linked) return linked;
    return byId.has(localId) ? localId : null;
  };
}

/**
 * Código de país para la inteligencia de comercios. El cliente no lo envía, así
 * que se deriva de la región del locale del perfil (`es-ES` → `ES`).
 */
export function countryFromLocale(locale: string | null | undefined): string {
  const region = typeof locale === "string" ? locale.split("-")[1] : undefined;
  return region && /^[A-Za-z]{2}$/.test(region) ? region.toUpperCase() : "XX";
}
