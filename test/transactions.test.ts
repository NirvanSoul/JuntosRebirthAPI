import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Database } from "../src/db/client";
import type { AuthVariables } from "../src/middleware/auth";
import type { SpaceAccessVariables } from "../src/middleware/space-access";
import { createTransactionsRoute } from "../src/routes/transactions";
import type { Bindings } from "../src/types/env";

const bindings: Bindings = { DATABASE_URL: "postgresql://test", BETTER_AUTH_SECRET: "test-secret", BETTER_AUTH_URL: "https://test", GOOGLE_CLIENT_ID: "test", GOOGLE_CLIENT_SECRET: "test" };
const transaction = { id: "tx-1", type: "expense" as const, amountMinor: "2599", currency: "EUR", title: "Supermercado", occurredOn: "2026-08-28", categoryId: "category-1", moneyAccountId: "account-1", recurrenceSeriesId: null, createdAt: new Date("2026-08-28T12:00:00Z"), updatedAt: new Date("2026-08-28T12:00:00Z"), exchangeSnapshot: null };

function setup(overrides: Record<string, unknown> = {}) {
  const deps = {
    createDb: () => ({} as Database),
    findUserCountryCode: vi.fn().mockResolvedValue(null),
    listTransactions: vi.fn().mockResolvedValue({ transactions: [transaction], nextCursor: null }),
    findActiveCategory: vi.fn().mockResolvedValue({ id: "category-1" }),
    findActiveMoneyAccount: vi.fn().mockResolvedValue({ id: "account-1" }),
    accountHasCurrency: vi.fn().mockResolvedValue(true),
    findTransactionInSpace: vi.fn().mockResolvedValue(transaction),
    createTransaction: vi.fn().mockResolvedValue({ transaction }),
    updateTransaction: vi.fn().mockResolvedValue({ transaction }),
    ...overrides,
  };
  const testApp = new Hono<{ Bindings: Bindings; Variables: AuthVariables & SpaceAccessVariables }>();
  testApp.use("*", async (c, next) => { c.set("currentUserId", "user-1"); c.set("activeSpaceMembership", { spaceId: "space-1", role: "member" }); await next(); });
  testApp.route("/v1/spaces/:spaceId/transactions", createTransactionsRoute(deps, async (_c, next) => next()));
  return { testApp, deps };
}
const body = { type: "expense", amountMinor: "2599", currency: "eur", title: " Supermercado ", occurredOn: "2026-08-28", categoryId: "category-1", moneyAccountId: "account-1" };

describe("Transactions routes", () => {
  it("requires authentication", async () => { expect((await app.request("/v1/spaces/space-1/transactions")).status).toBe(401); });
  it("lists a cursor-paginated page without exposing implementation details", async () => {
    const { testApp, deps } = setup({ listTransactions: vi.fn().mockResolvedValue({ transactions: [transaction], nextCursor: { occurredOn: "2026-08-28", createdAt: transaction.createdAt.toISOString(), id: "tx-1" } }) });
    const response = await testApp.request("/v1/spaces/space-1/transactions?limit=1", {}, bindings);
    expect(response.status).toBe(200); const json = await response.json() as { data: { nextCursor: string } }; expect(json.data.nextCursor).not.toContain("tx-1"); expect(deps.listTransactions).toHaveBeenCalledWith(expect.anything(), "space-1", 1, null);
  });
  it.each([2599, "2.5", "0", "-1"])("rejects invalid amountMinor %j", async amountMinor => {
    const { testApp } = setup(); const response = await testApp.request("/v1/spaces/space-1/transactions", { method: "POST", body: JSON.stringify({ ...body, amountMinor }) }, bindings); expect(response.status).toBe(400);
  });
  it("creates using the authenticated user, normalized currency and a bigint", async () => {
    const { testApp, deps } = setup(); const response = await testApp.request("/v1/spaces/space-1/transactions", { method: "POST", body: JSON.stringify(body) }, bindings);
    expect(response.status).toBe(201); expect(deps.createTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: "user-1", spaceId: "space-1", currency: "EUR", title: "Supermercado", amountMinor: 2599n }));
  });
  it("rejects an archived or foreign category", async () => {
    const { testApp } = setup({ findActiveCategory: vi.fn().mockResolvedValue(null) }); const response = await testApp.request("/v1/spaces/space-1/transactions", { method: "POST", body: JSON.stringify(body) }, bindings); expect(response.status).toBe(404); await expect(response.json()).resolves.toMatchObject({ error: { code: "CATEGORY_NOT_FOUND" } });
  });
  it("rejects an account without a balance in the transaction currency", async () => {
    const { testApp } = setup({ accountHasCurrency: vi.fn().mockResolvedValue(false) }); const response = await testApp.request("/v1/spaces/space-1/transactions", { method: "POST", body: JSON.stringify(body) }, bindings); expect(response.status).toBe(400);
  });
  it("allows null moneyAccountId", async () => {
    const { testApp, deps } = setup(); const response = await testApp.request("/v1/spaces/space-1/transactions", { method: "POST", body: JSON.stringify({ ...body, moneyAccountId: null }) }, bindings); expect(response.status).toBe(201); expect(deps.createTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ moneyAccountId: null }));
  });
  it("rejects invalid calendar dates", async () => { const { testApp } = setup(); const response = await testApp.request("/v1/spaces/space-1/transactions", { method: "POST", body: JSON.stringify({ ...body, occurredOn: "2026-02-30" }) }, bindings); expect(response.status).toBe(400); });
  it("does not expose transactions from another space", async () => { const { testApp } = setup({ findTransactionInSpace: vi.fn().mockResolvedValue(null) }); const response = await testApp.request("/v1/spaces/space-1/transactions/other", { method: "PATCH", body: JSON.stringify({ title: "x" }) }, bindings); expect(response.status).toBe(404); await expect(response.json()).resolves.toMatchObject({ error: { code: "TRANSACTION_NOT_FOUND" } }); });
  it("archives and restores through the service", async () => { const { testApp, deps } = setup(); await testApp.request("/v1/spaces/space-1/transactions/tx-1", { method: "PATCH", body: JSON.stringify({ isArchived: true }) }, bindings); await testApp.request("/v1/spaces/space-1/transactions/tx-1", { method: "PATCH", body: JSON.stringify({ isArchived: false }) }, bindings); expect(deps.updateTransaction).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({ isArchived: true })); expect(deps.updateTransaction).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({ isArchived: false })); });
  it("keeps historical archived relations editable unless changed", async () => { const { testApp, deps } = setup({ findTransactionInSpace: vi.fn().mockResolvedValue({ ...transaction, moneyAccountId: "archived-account" }) }); const response = await testApp.request("/v1/spaces/space-1/transactions/tx-1", { method: "PATCH", body: JSON.stringify({ title: "Nuevo título" }) }, bindings); expect(response.status).toBe(200); expect(deps.findActiveMoneyAccount).not.toHaveBeenCalled(); });
  it("rejects recurrenceSeriesId as a client-controlled field", async () => { const { testApp } = setup(); const response = await testApp.request("/v1/spaces/space-1/transactions/tx-1", { method: "PATCH", body: JSON.stringify({ recurrenceSeriesId: "series" }) }, bindings); expect(response.status).toBe(400); });

  it("passes the creator's countryCode and customRateId to the service on create", async () => {
    const { testApp, deps } = setup({ findUserCountryCode: vi.fn().mockResolvedValue("VE") });
    const response = await testApp.request("/v1/spaces/space-1/transactions", { method: "POST", body: JSON.stringify({ ...body, currency: "VES", customRateId: "rate-1" }) }, bindings);
    expect(response.status).toBe(201);
    expect(deps.createTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ creatorCountryCode: "VE", customRateId: "rate-1", currency: "VES" }));
  });
  it("rejects an empty-string customRateId", async () => {
    const { testApp } = setup(); const response = await testApp.request("/v1/spaces/space-1/transactions", { method: "POST", body: JSON.stringify({ ...body, customRateId: "" }) }, bindings); expect(response.status).toBe(400);
  });
  it("surfaces CUSTOM_RATE_NOT_FOUND from the service as a 404", async () => {
    const { testApp } = setup({ createTransaction: vi.fn().mockResolvedValue({ transaction: null, error: "CUSTOM_RATE_NOT_FOUND" }) });
    const response = await testApp.request("/v1/spaces/space-1/transactions", { method: "POST", body: JSON.stringify({ ...body, customRateId: "missing" }) }, bindings);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "CUSTOM_RATE_NOT_FOUND" } });
  });
  it("passes the editor's countryCode when updating a movement", async () => {
    const { testApp, deps } = setup({ findUserCountryCode: vi.fn().mockResolvedValue("VE") });
    await testApp.request("/v1/spaces/space-1/transactions/tx-1", { method: "PATCH", body: JSON.stringify({ amountMinor: "5000" }) }, bindings);
    expect(deps.updateTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ creatorCountryCode: "VE", amountMinor: 5000n }));
  });
});
