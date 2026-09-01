import { describe, expect, it, vi } from "vitest";
import { consumeOtpRequestLimit } from "../src/services/otp-request-limits";
import type { Database } from "../src/db/client";

describe("OTP request limit", () => {
  it("allows an atomic upsert that returned a row", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [{ count: 1 }] });

    await expect(
      consumeOtpRequestLimit({ execute } as unknown as Database, "ada@example.com"),
    ).resolves.toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("denies an OTP request when the atomic upsert returned no row", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });

    await expect(
      consumeOtpRequestLimit({ execute } as unknown as Database, "ada@example.com"),
    ).resolves.toBe(false);
  });
});
