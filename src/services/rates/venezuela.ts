const BCV_RATES_URL = "https://bcvscrapper.vercel.app/api/bcv";

type BcvRatesResponse = {
  success?: boolean;
  usd?: unknown;
  eur?: unknown;
};

export type VenezuelaRate = {
  source: "BCV";
  baseCurrency: "USD" | "EUR";
  quoteCurrency: "VES";
  rate: string;
};

export class VenezuelaRateServiceError extends Error {}

export class VenezuelaRateService {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async getRates(): Promise<VenezuelaRate[]> {
    let response: Response;

    try {
      response = await this.fetchFn(BCV_RATES_URL);
    } catch {
      throw new VenezuelaRateServiceError("Unable to fetch Venezuela rates");
    }

    if (!response.ok) {
      throw new VenezuelaRateServiceError("Venezuela rates source returned an error");
    }

    let payload: BcvRatesResponse;

    try {
      payload = (await response.json()) as BcvRatesResponse;
    } catch {
      throw new VenezuelaRateServiceError("Venezuela rates source returned invalid JSON");
    }

    if (!payload.success) {
      throw new VenezuelaRateServiceError("Venezuela rates source was unsuccessful");
    }

    return [
      {
        source: "BCV",
        baseCurrency: "USD",
        quoteCurrency: "VES",
        rate: normalizeRate(payload.usd),
      },
      {
        source: "BCV",
        baseCurrency: "EUR",
        quoteCurrency: "VES",
        rate: normalizeRate(payload.eur),
      },
    ];
  }
}

function normalizeRate(value: unknown): string {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    throw new VenezuelaRateServiceError("Venezuela rates source returned an invalid rate");
  }

  return numericValue.toFixed(10);
}
