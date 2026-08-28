const integerPattern = /^-?\d+$/;

export function parseMinorAmount(value: unknown): bigint | null {
  if (typeof value !== "string" || !integerPattern.test(value)) return null;

  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

export function serializeMinorAmount(value: bigint): string {
  return value.toString();
}
