import { describe, expect, it } from "vitest";
import { runVenezuelaRateSync } from "../../src/services/venezuela-rate-sync-job";
import type { Bindings } from "../../src/types/env";

const base = { DATABASE_URL: "postgresql://test" } as Bindings;

describe("runVenezuelaRateSync", () => {
  it("skips without Kuanto configuration", async () => {
    await expect(runVenezuelaRateSync(base)).resolves.toEqual({ skipped: "KUANTO_SUPABASE_NOT_CONFIGURED" });
  });

  it("never throws, so a Supabase or database outage cannot break the cron", async () => {
    const env = { ...base, DATABASE_URL: "not-a-url", KUANTO_SUPABASE_URL: "https://kuanto.invalid", KUANTO_SUPABASE_PUBLISHABLE_KEY: "key" };
    await expect(runVenezuelaRateSync(env)).resolves.toEqual({ failed: true });
  });
});
