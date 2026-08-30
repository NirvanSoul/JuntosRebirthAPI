import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import {
  clearFailedAttempts,
  lockedUntil,
  MAX_FAILED_ATTEMPTS,
  normalizeEmail,
  registerFailedAttempt,
} from "../src/services/login-attempts";

function databaseReturning(rows: unknown[]) {
  const chain = { where: () => ({ limit: () => Promise.resolve(rows) }) };
  return { select: () => ({ from: () => chain }) } as unknown as Database;
}

describe("login attempt lockout", () => {
  it("normalizes the email so casing and spacing cannot bypass the counter", () => {
    expect(normalizeEmail("  Ana@Example.COM ")).toBe("ana@example.com");
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
  });

  it("reports a lock that is still in force", async () => {
    const until = new Date(Date.now() + 60_000);
    await expect(lockedUntil(databaseReturning([{ lockedUntil: until }]), "a@b.c")).resolves.toEqual(
      until,
    );
  });

  it("treats an elapsed lock as unlocked", async () => {
    const past = new Date(Date.now() - 60_000);
    await expect(lockedUntil(databaseReturning([{ lockedUntil: past }]), "a@b.c")).resolves.toBeNull();
  });

  it("does not lock an account that never failed", async () => {
    await expect(lockedUntil(databaseReturning([]), "a@b.c")).resolves.toBeNull();
  });

  it("counts the failure and the lock in a single statement", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    await registerFailedAttempt({ execute } as unknown as Database, "a@b.c");

    expect(execute).toHaveBeenCalledOnce();
    // Un solo INSERT ... ON CONFLICT evita que dos intentos simultáneos se pisen.
    const query = execute.mock.calls[0]?.[0] as { queryChunks: unknown[] };
    const sql = JSON.stringify(query.queryChunks);
    expect(sql).toContain("ON CONFLICT");
    expect(sql).toContain("a@b.c");
    expect(sql).toContain(String(MAX_FAILED_ATTEMPTS));
  });

  it("forgets the history after a successful sign-in", async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const db = { delete: vi.fn(() => ({ where })) } as unknown as Database;

    await clearFailedAttempts(db, "a@b.c");

    expect(where).toHaveBeenCalledOnce();
  });
});
