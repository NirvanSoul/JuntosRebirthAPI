import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import { createMoneyAccountWithBalances, listMoneyAccounts } from "../src/services/money-accounts";
import { parseCreateMoneyAccountInput } from "../src/routes/money-accounts";

function databaseWithRows(rows: unknown[]) {
  const chain = { leftJoin: () => chain, where: () => Promise.resolve(rows) };
  return { select: () => ({ from: () => ({ leftJoin: () => chain }) }) } as unknown as Database;
}

describe("money account balances", () => {
  it("uses opening balance when there are no transactions", async () => {
    const accounts = await listMoneyAccounts(databaseWithRows([{
      id: "a", name: "Revolut", kind: "bank", icon: null, colorToken: null, primaryCurrency: "EUR", createdAt: new Date(), balanceId: "b", balanceCurrency: "EUR", opening: 100000n, displayOrder: 0, transactionType: null, transactionAmount: null,
    }]), "space-1");
    expect(accounts[0]?.balances[0]?.currentBalanceMinor).toBe("100000");
  });

  it("adds income and subtracts expense in the same balance currency", async () => {
    const base = { id:"a",name:"Revolut",kind:"bank" as const,icon:null,colorToken:null,primaryCurrency:"EUR",createdAt:new Date(),balanceId:"b",balanceCurrency:"EUR",opening:100000n,displayOrder:0 };
    const accounts = await listMoneyAccounts(databaseWithRows([
      {...base,transactionType:"income",transactionAmount:50000n},
      {...base,transactionType:"expense",transactionAmount:25000n},
    ]), "space-1");
    expect(accounts[0]?.balances[0]?.currentBalanceMinor).toBe("125000");
  });

  it("creates account and all balances in one Neon batch", async () => {
    const inserted: unknown[]=[]; const batch=vi.fn().mockResolvedValue([]);
    const db={insert:vi.fn(()=>({values:(value:unknown)=>{inserted.push(value);return value}})),batch} as unknown as Database;
    const account=await createMoneyAccountWithBalances(db,{spaceId:"space-1",userId:"user-1",name:"Revolut",kind:"bank",icon:null,colorToken:null,primaryCurrency:"EUR",balances:[{currency:"EUR",openingBalanceMinor:100000n,displayOrder:0},{currency:"USD",openingBalanceMinor:-2500n,displayOrder:1}]});
    expect(batch).toHaveBeenCalledOnce();
    expect(batch.mock.calls[0]?.[0]).toHaveLength(3);
    expect(account.balances[1]).toMatchObject({openingBalanceMinor:"-2500",currentBalanceMinor:"-2500"});
    expect(inserted).toHaveLength(3);
  });
});

describe("create money account input", () => {
  function body(payload: unknown) {
    return new Request("https://x/", { method: "POST", body: JSON.stringify(payload) });
  }

  const base = {
    name: "Wallet",
    kind: "cash",
    primaryCurrency: "EUR",
    balances: [{ currency: "EUR", openingBalanceMinor: "100000", displayOrder: 0 }],
  };

  it("accepts a payload that omits the optional icon and colorToken", async () => {
    // Están documentados como opcionales: omitirlos devolvía 400.
    const input = await parseCreateMoneyAccountInput(body(base));

    expect(input).toMatchObject({ name: "Wallet", icon: null, colorToken: null });
  });

  it("still accepts them as explicit nulls or strings", async () => {
    await expect(
      parseCreateMoneyAccountInput(body({ ...base, icon: null, colorToken: "teal" })),
    ).resolves.toMatchObject({ icon: null, colorToken: "teal" });
  });

  it("rejects a wrong type instead of treating it as absent", async () => {
    await expect(
      parseCreateMoneyAccountInput(body({ ...base, icon: 42 })),
    ).resolves.toBeNull();
  });
});
