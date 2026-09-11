import { sql } from "drizzle-orm";
import { spaces, userProfiles } from "../db/schema";

/** El libro personal lo decide el perfil; el país limita los compartidos. */
export function activeSpaceScope() {
  return sql`(
    (${spaces.type} = 'personal' AND ${spaces.id} = ${userProfiles.personalSpaceId})
    OR (${spaces.type} <> 'personal'
      AND ${spaces.countryCode} IS NOT DISTINCT FROM ${userProfiles.countryCode})
  )`;
}
