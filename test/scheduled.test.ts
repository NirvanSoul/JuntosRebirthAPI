import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/recurrence-engine", () => ({ runRecurrences: vi.fn().mockResolvedValue({}) }));
vi.mock("../src/services/invitations", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  expireStaleInvitations: vi.fn().mockResolvedValue(0),
}));
vi.mock("../src/services/exchange-rates", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  captureNextDayRate: vi.fn().mockResolvedValue({ captured: false }),
}));
vi.mock("../src/services/venezuela-rate-sync-job", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runVenezuelaRateSync: vi.fn().mockResolvedValue({ initial: false, fetchedRows: 1, readingsInserted: 1 }),
}));

const { default: worker } = await import("../src/index");
const { runRecurrences } = await import("../src/services/recurrence-engine");
const { runVenezuelaRateSync } = await import("../src/services/venezuela-rate-sync-job");

async function fire(cron: string) {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as unknown as ExecutionContext;
  worker.scheduled({ cron } as ScheduledEvent, { DATABASE_URL: "postgresql://user:pass@db.invalid/test" } as never, ctx);
  await Promise.all(pending);
}

describe("scheduled", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs only the hourly tasks on the hourly trigger", async () => {
    await fire("0 * * * *");
    expect(runRecurrences).toHaveBeenCalledOnce();
    expect(runVenezuelaRateSync).not.toHaveBeenCalled();
  });

  it("runs only the rate sync on the half-hourly trigger", async () => {
    await fire("10,40 * * * *");
    expect(runVenezuelaRateSync).toHaveBeenCalledOnce();
    expect(runRecurrences).not.toHaveBeenCalled();
  });

  it("runs everything for an unknown trigger", async () => {
    await fire("* * * * *");
    expect(runRecurrences).toHaveBeenCalledOnce();
    expect(runVenezuelaRateSync).toHaveBeenCalledOnce();
  });
});
