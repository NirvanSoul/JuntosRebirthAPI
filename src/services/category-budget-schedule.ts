import type { CategoryBudgetOverride, CategoryBudgetSegment } from "../db/schema";

/**
 * Periodicidad de un presupuesto de categoría tal como viaja en el sync.
 * Ausente equivale a mensual sin excepciones, que es lo que envían los
 * clientes anteriores.
 */
export type CategoryBudgetSchedule = {
  period: "month" | "week" | "fortnight" | "custom";
  intervalDays: number | null;
  anchorOn: string | null;
  overrides: CategoryBudgetOverride[];
  history: CategoryBudgetSegment[];
};

export type CategoryBudgetScheduleIssue = {
  path: (string | number)[];
  reason: string;
};

const periods = new Set(["month", "week", "fortnight", "custom"]);
const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;
const maxOverrides = 400;
const maxHistory = 100;

function isDateOnly(value: unknown): value is string {
  return (
    typeof value === "string" &&
    dateOnlyPattern.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
  );
}

/** Lee y valida la periodicidad; devuelve la incidencia en vez de lanzar. */
function parsePeriodFields(
  value: Record<string, unknown>,
): Pick<CategoryBudgetSchedule, "anchorOn" | "intervalDays" | "period"> | CategoryBudgetScheduleIssue {
  const period = value.period ?? "month";
  if (typeof period !== "string" || !periods.has(period)) {
    return { path: ["period"], reason: "INVALID_BUDGET_PERIOD" };
  }
  if (period !== "custom") {
    return { period: period as CategoryBudgetSchedule["period"], intervalDays: null, anchorOn: null };
  }
  if (
    typeof value.intervalDays !== "number" ||
    !Number.isInteger(value.intervalDays) ||
    value.intervalDays < 2 ||
    value.intervalDays > 365
  ) {
    return { path: ["intervalDays"], reason: "EXPECTED_DAYS_BETWEEN_2_AND_365" };
  }
  if (!isDateOnly(value.anchorOn)) {
    return { path: ["anchorOn"], reason: "EXPECTED_ISO_DATE" };
  }
  return { period: "custom", intervalDays: value.intervalDays, anchorOn: value.anchorOn };
}

function isPositiveAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Lee y valida la periodicidad; devuelve la incidencia en vez de lanzar. */
export function parseCategoryBudgetSchedule(
  budget: Record<string, unknown>,
): CategoryBudgetSchedule | CategoryBudgetScheduleIssue {
  const fields = parsePeriodFields(budget);
  if ("reason" in fields) return fields;

  const rawOverrides = budget.overrides ?? [];
  if (!Array.isArray(rawOverrides) || rawOverrides.length > maxOverrides) {
    return { path: ["overrides"], reason: "EXPECTED_ARRAY" };
  }
  const overrides: CategoryBudgetOverride[] = [];
  const seen = new Set<string>();
  for (const [index, value] of rawOverrides.entries()) {
    if (typeof value !== "object" || value === null) {
      return { path: ["overrides", index], reason: "EXPECTED_OBJECT" };
    }
    const { periodStartOn, budgetAmountMinor } = value as Record<string, unknown>;
    if (!isDateOnly(periodStartOn) || seen.has(periodStartOn)) {
      return { path: ["overrides", index, "periodStartOn"], reason: "EXPECTED_UNIQUE_ISO_DATE" };
    }
    if (!isPositiveAmount(budgetAmountMinor)) {
      return { path: ["overrides", index, "budgetAmountMinor"], reason: "MUST_BE_POSITIVE" };
    }
    seen.add(periodStartOn);
    overrides.push({ periodStartOn, budgetAmountMinor: String(budgetAmountMinor) });
  }

  const rawHistory = budget.history ?? [];
  if (!Array.isArray(rawHistory) || rawHistory.length > maxHistory) {
    return { path: ["history"], reason: "EXPECTED_ARRAY" };
  }
  const history: CategoryBudgetSegment[] = [];
  for (const [index, value] of rawHistory.entries()) {
    if (typeof value !== "object" || value === null) {
      return { path: ["history", index], reason: "EXPECTED_OBJECT" };
    }
    const segment = value as Record<string, unknown>;
    const previous = history.at(-1)?.endsOn;
    if (!isDateOnly(segment.endsOn) || (previous && segment.endsOn <= previous)) {
      return { path: ["history", index, "endsOn"], reason: "EXPECTED_ASCENDING_ISO_DATE" };
    }
    if (!isPositiveAmount(segment.budgetAmountMinor)) {
      return { path: ["history", index, "budgetAmountMinor"], reason: "MUST_BE_POSITIVE" };
    }
    const segmentFields = parsePeriodFields(segment);
    if ("reason" in segmentFields) {
      return { path: ["history", index, ...segmentFields.path], reason: segmentFields.reason };
    }
    history.push({
      endsOn: segment.endsOn,
      budgetAmountMinor: String(segment.budgetAmountMinor),
      ...segmentFields,
    });
  }

  return { ...fields, overrides, history };
}

export function isCategoryBudgetScheduleIssue(
  value: CategoryBudgetSchedule | CategoryBudgetScheduleIssue,
): value is CategoryBudgetScheduleIssue {
  return "reason" in value;
}

/** Forma pública del presupuesto en snapshot y cambios. */
export function serializeCategoryBudgetSchedule(row: {
  period: string;
  intervalDays: number | null;
  anchorOn: string | null;
  overrides: CategoryBudgetOverride[] | null;
  history: CategoryBudgetSegment[] | null;
}) {
  return {
    period: row.period,
    intervalDays: row.intervalDays,
    anchorOn: row.anchorOn,
    overrides: row.overrides ?? [],
    history: row.history ?? [],
  };
}
