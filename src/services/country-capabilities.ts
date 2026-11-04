export type Capabilities = {
  venezuelaCurrencyMode: boolean;
  customExchangeRate: boolean;
  multiRateMovementDisplay: boolean;
  /** La app muestra USDT en el selector de tasas (BCV $ / EUR / USDT). */
  usdtReferenceRate: boolean;
};

/**
 * Todas las funcionalidades del modo Venezuela se derivan hoy de un único
 * booleano. No se almacenan como flags independientes en base de datos: si
 * mañana otro país necesita reglas cambiarias propias, esta es la única
 * función que cambia.
 */
export function deriveCapabilities(countryCode: string | null): Capabilities {
  const venezuelaCurrencyMode = countryCode === "VE";

  return {
    venezuelaCurrencyMode,
    customExchangeRate: venezuelaCurrencyMode,
    multiRateMovementDisplay: venezuelaCurrencyMode,
    usdtReferenceRate: venezuelaCurrencyMode,
  };
}
