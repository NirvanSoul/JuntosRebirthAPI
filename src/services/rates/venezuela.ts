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
  /**
   * El `fetch` de Workers exige su `this` global. Guardarlo tal cual como
   * propiedad y llamarlo con `this.fetchFn(...)` le pasa la instancia de la
   * clase y workerd lo rechaza con "Illegal invocation", así que el valor por
   * defecto va envuelto. Las pruebas siguen pudiendo inyectar un doble.
   */
  constructor(
    private readonly fetchFn: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async getRates(): Promise<VenezuelaRate[]> {
    let response: Response;

    try {
      response = await this.fetchFn(BCV_RATES_URL);
    } catch (error) {
      // La causa se conserva: "no se pudo consultar" no dice si fue DNS, TLS o
      // un rechazo del proveedor, y sin eso no hay forma de diagnosticarlo.
      throw new VenezuelaRateServiceError("Unable to fetch Venezuela rates", {
        cause: error,
      });
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
