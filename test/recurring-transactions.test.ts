import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import type { AuthVariables } from "../src/middleware/auth";
import type { SpaceAccessVariables } from "../src/middleware/space-access";
import { createRecurringTransactionsRoute } from "../src/routes/recurring-transactions";
import type { Bindings } from "../src/types/env";
const bindings:Bindings={DATABASE_URL:"postgres://test",BETTER_AUTH_SECRET:"x",BETTER_AUTH_URL:"https://test",GOOGLE_CLIENT_ID:"x",GOOGLE_CLIENT_SECRET:"x"};
const recurring={id:"series-1",type:"expense" as const,amountMinor:"2499",currency:"EUR",title:"Netflix",categoryId:"cat",moneyAccountId:null,frequency:"monthly" as const,startsOn:"2026-09-15",nextOccurrenceOn:"2026-09-15",createdAt:new Date(),updatedAt:new Date(),isArchived:false,generatedOccurrences:0};
function setup(overrides:Record<string,unknown>={}){const deps={createDb:()=>({}as Database),runRecurrences:vi.fn().mockResolvedValue({processedSeries:1,generatedTransactions:2,invalidSeries:0,truncatedSeries:0,errors:0}),listSeries:vi.fn().mockResolvedValue([recurring]),findSeries:vi.fn().mockResolvedValue(recurring),createSeries:vi.fn().mockResolvedValue(recurring),updateSeries:vi.fn().mockResolvedValue(recurring),pendingNext:vi.fn().mockResolvedValue("2026-09-03"),createOccurrence:vi.fn().mockResolvedValue({id:"occ",scheduledOn:"2026-09-03",status:"pending",generatedTransactionId:null}),findOccurrence:vi.fn().mockResolvedValue({id:"occ",scheduledOn:"2026-09-03",status:"pending",generatedTransactionId:null}),findOccurrenceOn:vi.fn().mockResolvedValue(null),updateOccurrence:vi.fn(),findActiveCategory:vi.fn().mockResolvedValue({id:"cat"}),findActiveMoneyAccount:vi.fn(),accountHasCurrency:vi.fn().mockResolvedValue(true),...overrides};const app=new Hono<{Bindings:Bindings;Variables:AuthVariables&SpaceAccessVariables}>();app.use("*",async(c,n)=>{c.set("currentUserId","user");c.set("activeSpaceMembership",{spaceId:"space",role:"member"});await n()});app.route("/v1/spaces/:spaceId/recurring-transactions",createRecurringTransactionsRoute(deps,async(_,n)=>n()));return{app,deps}}
const monthly={type:"expense",amountMinor:"9007199254740993",currency:"eur",title:" Netflix ",categoryId:"cat",moneyAccountId:null,frequency:"monthly",startsOn:"2026-09-15"};
describe("recurring transactions",()=>{
 it("creates monthly series with startsOn as next occurrence and bigint amount",async()=>{const{app,deps}=setup();const r=await app.request("/v1/spaces/space/recurring-transactions",{method:"POST",body:JSON.stringify(monthly)},bindings);expect(r.status).toBe(201);expect(deps.createSeries).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({currency:"EUR",amountMinor:9007199254740993n,startsOn:"2026-09-15"}))});
 it("creates sorted custom dates and rejects duplicates",async()=>{const{app,deps}=setup();const{startsOn,...customBase}=monthly;const r=await app.request("/v1/spaces/space/recurring-transactions",{method:"POST",body:JSON.stringify({...customBase,frequency:"custom",customDates:["2026-11-08","2026-09-03"]})},bindings);expect(r.status).toBe(201);expect(deps.createSeries).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({startsOn:"2026-09-03",customDates:["2026-09-03","2026-11-08"]}));const bad=await app.request("/v1/spaces/space/recurring-transactions",{method:"POST",body:JSON.stringify({...customBase,frequency:"custom",customDates:["2026-09-03","2026-09-03"]})},bindings);expect(bad.status).toBe(400)});
 it("does not allow occurrence editing outside custom series",async()=>{const{app}=setup();const r=await app.request("/v1/spaces/space/recurring-transactions/series-1/occurrences",{method:"POST",body:JSON.stringify({scheduledOn:"2026-10-01"})},bindings);expect(r.status).toBe(400)});
 it("prevents changes to calendar after generated history",async()=>{const{app}=setup({findSeries:vi.fn().mockResolvedValue({...recurring,generatedOccurrences:1})});const r=await app.request("/v1/spaces/space/recurring-transactions/series-1",{method:"PATCH",body:JSON.stringify({startsOn:"2026-10-01"})},bindings);expect(r.status).toBe(400)});
});

describe("manual recurrence run", () => {
  it("runs the engine only for the space the caller belongs to", async () => {
    const { app, deps } = setup();

    const response = await app.request(
      "/v1/spaces/space-1/recurring-transactions/run",
      { method: "POST" },
      { DATABASE_URL: "postgres://x" } as never,
    );

    expect(response.status).toBe(200);
    // Sin acotar por espacio, cualquiera podría disparar la generación ajena.
    expect(deps.runRecurrences).toHaveBeenCalledWith(
      "postgres://x",
      expect.any(Date),
      ["space-1"],
    );
  });
});
