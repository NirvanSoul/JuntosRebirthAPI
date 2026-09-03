/**
 * Multiplica o divide un monto en unidades menores (bigint) por una tasa
 * decimal (string, como las columnas `numeric`), redondeando half-up. Todo
 * en `BigInt`: un movimiento histórico no puede depender de la precisión de
 * `float`.
 */
export function convertMinorAmount(
  amountMinor: bigint,
  rate: string,
  direction: "multiply" | "divide",
): bigint {
  const { unscaled, scale } = parseDecimal(rate);
  const scaleFactor = 10n ** BigInt(scale);

  const numerator = direction === "multiply" ? amountMinor * unscaled : amountMinor * scaleFactor;
  const denominator = direction === "multiply" ? scaleFactor : unscaled;

  return roundedDivide(numerator, denominator);
}

/** Convierte un string decimal en "unidades mayores" (p.ej. "10000.5") a unidades menores (bigint), redondeando half-up. */
export function toMinorUnits(value: string, minorDigits = 2): bigint {
  const { unscaled, scale } = parseDecimal(value);
  if (scale === minorDigits) return unscaled;
  if (scale < minorDigits) return unscaled * 10n ** BigInt(minorDigits - scale);
  return roundedDivide(unscaled, 10n ** BigInt(scale - minorDigits));
}

/** Inversa de `toMinorUnits`: unidades menores (bigint) a string decimal de unidades mayores. */
export function fromMinorUnits(value: bigint, minorDigits = 2): string {
  const factor = 10n ** BigInt(minorDigits);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / factor;
  const fraction = (abs % factor).toString().padStart(minorDigits, "0");
  return `${negative ? "-" : ""}${whole}${minorDigits > 0 ? "." + fraction : ""}`;
}

export function isPositiveDecimal(value: unknown): value is string {
  return typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim()) && Number(value) > 0;
}

function parseDecimal(value: string): { unscaled: bigint; scale: number } {
  const match = /^(-?\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid decimal string: ${value}`);

  const [, integerPart, fractionPart = ""] = match;
  const unscaled = BigInt(integerPart + fractionPart);

  return { unscaled, scale: fractionPart.length };
}

function roundedDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("Division by zero");

  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;

  const quotient = (absNumerator * 2n + absDenominator) / (absDenominator * 2n);

  return negative ? -quotient : quotient;
}
