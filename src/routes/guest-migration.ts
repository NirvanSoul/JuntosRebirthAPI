import { Hono } from "hono";
import { createDb } from "../db/client";
import type { AuthVariables } from "../middleware/auth";
import * as service from "../services/guest-migration";
import type { Bindings } from "../types/env";
type Env={Bindings:Bindings;Variables:AuthVariables};
export const guestMigrationRoute=new Hono<Env>();
guestMigrationRoute.post("/guest-migration",async c=>{try{const input:unknown=await c.req.json();if(!input||typeof input!=="object"||Array.isArray(input))return c.json({error:{code:"INVALID_REQUEST",message:"Invalid request."}},400);const p=input as Record<string,unknown>;const payload={batchId:p.batchId,installationId:p.installationId,spaces:p.spaces,categories:p.categories,moneyAccounts:p.moneyAccounts,recurringSeries:p.recurringSeries,transactions:p.transactions};if(Object.values(payload).some(v=>v===undefined)||!Array.isArray(payload.spaces)||!Array.isArray(payload.categories)||!Array.isArray(payload.moneyAccounts)||!Array.isArray(payload.recurringSeries)||!Array.isArray(payload.transactions))return c.json({error:{code:"INVALID_REQUEST",message:"Invalid request."}},400);const result=await service.migrateGuest(createDb(c.env.DATABASE_URL),c.get("currentUserId"),payload as service.GuestPayload);return c.json({data:result},201)}catch(error){const code=error instanceof Error?error.message:"INTERNAL_ERROR";return c.json({error:{code:code==="MIGRATION_IN_PROGRESS"?"MIGRATION_IN_PROGRESS":code==="BOOTSTRAP_REQUIRED"?"BOOTSTRAP_REQUIRED":"INVALID_REQUEST",message:"Guest migration could not be completed."}},code==="MIGRATION_IN_PROGRESS"?409:400)}});
