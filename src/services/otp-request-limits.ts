import { sql } from "drizzle-orm";
import type { Database } from "../db/client";

export const OTP_REQUEST_LIMIT = 3;
export const OTP_REQUEST_WINDOW_SECONDS = 60 * 60;

/**
 * Consume uno de los tres envíos de OTP permitidos por correo y hora.
 *
 * La cláusula `WHERE` del upsert hace que la decisión sea atómica: peticiones
 * simultáneas no pueden observar el mismo contador y superar el límite. Se
 * reutiliza `rate_limit`, cuya limpieza ya realiza Better Auth, con una clave
 * que no puede colisionar con sus contadores por IP.
 */
export async function consumeOtpRequestLimit(
  db: Database,
  email: string,
): Promise<boolean> {
  const key = `otp-request:${email}`;
  const result = await db.execute(sql`
    INSERT INTO rate_limit ("key", "count", last_request)
    VALUES (${key}, 1, floor(extract(epoch FROM now()) * 1000)::bigint)
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE
        WHEN rate_limit.last_request <= floor(extract(epoch FROM now() - interval '1 hour')) * 1000
          THEN 1
        ELSE rate_limit."count" + 1
      END,
      last_request = CASE
        WHEN rate_limit.last_request <= floor(extract(epoch FROM now() - interval '1 hour')) * 1000
          THEN floor(extract(epoch FROM now()) * 1000)::bigint
        ELSE rate_limit.last_request
      END
    WHERE rate_limit.last_request <= floor(extract(epoch FROM now() - interval '1 hour')) * 1000
       OR rate_limit."count" < ${OTP_REQUEST_LIMIT}
    RETURNING "count"
  `);

  return result.rows.length > 0;
}
