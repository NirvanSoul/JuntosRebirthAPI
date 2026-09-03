/**
 * Venezuela vive en UTC-4 todo el año (sin horario de verano), así que un
 * simple offset fijo basta — no hace falta el catálogo de zonas horarias.
 */
const VE_OFFSET_MS = 4 * 60 * 60 * 1000;

/** Fecha calendario ("YYYY-MM-DD") en hora de Venezuela para un instante dado. */
export function veDateString(date: Date): string {
  const shifted = new Date(date.getTime() - VE_OFFSET_MS);
  return shifted.toISOString().slice(0, 10);
}

/** Instante UTC que representa la medianoche de Venezuela de una fecha "YYYY-MM-DD". */
export function veMidnightUtc(dateString: string): Date {
  return new Date(`${dateString}T${String(VE_OFFSET_MS / 3_600_000).padStart(2, "0")}:00:00.000Z`);
}

export function addDaysToDateString(dateString: string, days: number): string {
  const [year, month, day] = dateString.split("-").map(Number);
  const next = new Date(Date.UTC(year!, month! - 1, day! + days));
  return next.toISOString().slice(0, 10);
}

/**
 * El BCV publica la tasa del día siguiente entre ~3:00pm y ~8:30pm hora VE;
 * fuera de esa ventana no tiene sentido sondear, el valor no cambia.
 */
export function isWithinVenezuelaPublishWindow(date: Date): boolean {
  const shifted = new Date(date.getTime() - VE_OFFSET_MS);
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  return hour >= 15 && (hour < 20 || (hour === 20 && minute <= 30));
}
