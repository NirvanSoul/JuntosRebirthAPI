import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { loginAttempts } from "../db/schema";

/** Mismos umbrales que la edge function `login-with-lockout` que se sustituye. */
export const MAX_FAILED_ATTEMPTS = 9;
export const LOCK_DURATION_MS = 60 * 60 * 1000;

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length > 0 && email.length <= 320 ? email : null;
}

/** Devuelve hasta cuándo está bloqueado el correo, o `null` si puede intentarlo. */
export async function lockedUntil(db: Database, email: string): Promise<Date | null> {
  const [row] = await db
    .select({ lockedUntil: loginAttempts.lockedUntil })
    .from(loginAttempts)
    .where(eq(loginAttempts.email, email))
    .limit(1);

  if (!row?.lockedUntil) return null;
  return row.lockedUntil > new Date() ? row.lockedUntil : null;
}

/**
 * Suma un intento fallido y bloquea al alcanzar el umbral. El contador y el
 * bloqueo se resuelven en un solo `INSERT ... ON CONFLICT` para que dos
 * intentos simultáneos no se pisen.
 */
export async function registerFailedAttempt(db: Database, email: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO login_attempts (email, failed_count, last_attempt_at)
    VALUES (${email}, 1, now())
    ON CONFLICT (email) DO UPDATE SET
      failed_count = CASE
        WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until <= now()
          THEN 1
        ELSE login_attempts.failed_count + 1
      END,
      locked_until = CASE
        WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until <= now()
          THEN NULL
        WHEN login_attempts.failed_count + 1 >= ${MAX_FAILED_ATTEMPTS}
          THEN now() + ${sql.raw(`interval '${LOCK_DURATION_MS} milliseconds'`)}
        ELSE login_attempts.locked_until
      END,
      last_attempt_at = now()
  `);
}

/** Un acceso correcto limpia el historial de ese correo. */
export async function clearFailedAttempts(db: Database, email: string): Promise<void> {
  await db.delete(loginAttempts).where(eq(loginAttempts.email, email));
}
