/**
 * Utilidades compartidas de validación de request. Antes cada router llevaba su
 * propia pareja `objectBody`/`permitted` con nombres distintos y estrictez
 * distinta; esto unifica el contrato: un cuerpo vacío es `{}`, cualquier clave
 * fuera de la lista blanca invalida la petición.
 */
export async function parseBody(
  request: Request,
  allowed: readonly string[],
): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (!text.trim()) return {};

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) return null;

  const record = body as Record<string, unknown>;
  return Object.keys(record).every((key) => allowed.includes(key)) ? record : null;
}

/** Texto obligatorio, recortado, con longitud máxima. */
export function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

/** Texto opcional que también admite `null` explícito para borrar el valor. */
export function nullableString(value: unknown, maxLength: number): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= maxLength ? trimmed : undefined;
}
