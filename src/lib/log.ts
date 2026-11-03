import { databaseErrorCodes, databaseErrorIdentifiers, isDatabaseSchemaOutdated } from "./database-errors";

/**
 * Registro de fallos sin datos sensibles.
 *
 * El `message` de un error no es seguro: PostgreSQL/Neon incluyen valores de
 * fila en `detail` y a veces en el mensaje (`Key (email)=(...)`), los errores
 * de conexión pueden llevar la URL con credenciales y un `fetch` fallido, la
 * URL pedida. Por eso nunca se registra el objeto de error ni su mensaje
 * libre, solo:
 *
 * - `errorName` y `causeName`;
 * - `errorCode`: el mensaje solo si es un código de dominio (`SPACE_NOT_FOUND`)
 *   o el mensaje constante de una clase propia de la lista `SAFE_MESSAGE_ERRORS`;
 * - `databaseCodes` (SQLSTATE) e identificadores técnicos (tabla, columna,
 *   restricción), suficientes para clasificar el fallo.
 *
 * El contexto admite solo escalares; quien llama decide qué correlación
 * (requestId, ids opacos) aporta.
 */

const DOMAIN_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** Clases cuyo `message` siempre es una constante escrita en este repo. */
const SAFE_MESSAGE_ERRORS = new Set(["VenezuelaRateServiceError", "ExchangeRatesUnavailableError"]);

type LogScalar = string | number | boolean | null | undefined;

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return error === null ? "null" : typeof error;
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (DOMAIN_CODE.test(error.message)) return error.message;
  if (SAFE_MESSAGE_ERRORS.has(error.name) && error.message.length <= 120) return error.message;
  return undefined;
}

export function errorSummary(error: unknown) {
  const cause = error instanceof Error ? error.cause : undefined;
  return {
    errorName: errorName(error),
    errorCode: errorCode(error),
    causeName: cause === undefined ? undefined : errorName(cause),
    causeCode: cause === undefined ? undefined : errorCode(cause),
    databaseCodes: databaseErrorCodes(error),
    databaseIdentifiers: databaseErrorIdentifiers(error),
    schemaOutdated: isDatabaseSchemaOutdated(error),
  };
}

export function logFailure(operation: string, error: unknown, context: Record<string, LogScalar> = {}): void {
  console.error(JSON.stringify({ event: "operation_failed", operation, ...context, ...errorSummary(error) }));
}
