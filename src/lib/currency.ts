const supportedCurrencies = new Set(Intl.supportedValuesOf("currency"));

export function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const currency = value.trim().toUpperCase();

  return supportedCurrencies.has(currency) ? currency : null;
}
