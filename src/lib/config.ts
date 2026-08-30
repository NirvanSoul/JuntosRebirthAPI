import type { Bindings } from "../types/env";

/**
 * Config que el Worker necesita para funcionar. Se separa en secretos y
 * variables públicas porque se configuran de forma distinta en Cloudflare:
 * los secretos con `wrangler secret put`, las variables en `wrangler.jsonc`.
 *
 * `RESEND_FROM` y `APP_URL` no son secretos: son un remitente verificado y una
 * URL pública. Tratarlos como secretos solo los hace más difíciles de revisar.
 */
const REQUIRED_SECRETS = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "GOOGLE_CLIENT_SECRET",
] as const;

const REQUIRED_VARS = ["BETTER_AUTH_URL", "GOOGLE_CLIENT_ID"] as const;

/** Sin esto el Worker arranca, pero con funciones degradadas. */
const OPTIONAL_SECRETS = ["RESEND_API_KEY"] as const;
const OPTIONAL_VARS = ["RESEND_FROM", "APP_URL", "ENVIRONMENT"] as const;

export type ConfigReport = {
  ok: boolean;
  /** Falta algo imprescindible: el Worker no puede servir peticiones privadas. */
  missingRequired: string[];
  /** Falta algo que degrada una función concreta, no todo el servicio. */
  missingOptional: string[];
  /** Solo presencia. Nunca el valor. */
  present: Record<string, boolean>;
  degraded: string[];
};

function has(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0 : Boolean(value);
}

/**
 * Comprueba la configuración sin leer ni registrar ningún valor. El informe
 * solo dice si cada clave está presente, de modo que se puede exponer y
 * registrar sin filtrar secretos.
 */
export function inspectConfig(env: Bindings): ConfigReport {
  const present: Record<string, boolean> = {};
  const missingRequired: string[] = [];
  const missingOptional: string[] = [];

  for (const key of [...REQUIRED_SECRETS, ...REQUIRED_VARS]) {
    present[key] = has(env[key]);
    if (!present[key]) missingRequired.push(key);
  }
  for (const key of [...OPTIONAL_SECRETS, ...OPTIONAL_VARS]) {
    present[key] = has(env[key]);
    if (!present[key]) missingOptional.push(key);
  }

  present.AVATARS = Boolean(env.AVATARS);
  if (!present.AVATARS) missingOptional.push("AVATARS");

  const degraded: string[] = [];
  if (!present.RESEND_API_KEY) degraded.push("email: invitations and OTP are not delivered");
  if (!present.RESEND_FROM) degraded.push("email: falling back to the Resend sandbox sender");
  if (!present.APP_URL) degraded.push("email: invitation links fall back to juntoss://");
  if (!present.AVATARS) degraded.push("avatars: upload and download are unavailable");

  return {
    ok: missingRequired.length === 0,
    missingRequired,
    missingOptional,
    present,
    degraded,
  };
}

let reported = false;

/**
 * Registra el informe una sola vez por isolate. Un despliegue al que le falte
 * un secreto debe verse en los logs desde la primera petición, no cuando
 * alguien intente invitar a su pareja.
 */
export function reportConfigOnce(env: Bindings): void {
  if (reported) return;
  reported = true;

  const report = inspectConfig(env);
  if (!report.ok) {
    console.error("Runtime config incomplete:", JSON.stringify(report.missingRequired));
  }
  if (report.degraded.length > 0) {
    console.warn("Runtime config degraded:", JSON.stringify(report.degraded));
  }
}
