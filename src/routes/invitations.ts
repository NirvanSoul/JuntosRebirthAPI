import { Hono, type MiddlewareHandler } from "hono";
import { createDb } from "../db/client";
import type { AuthVariables } from "../middleware/auth";
import { requireActiveSpaceMember, type SpaceAccessVariables } from "../middleware/space-access";
import * as service from "../services/invitations";
import { sendSpaceInvitation } from "../services/email";
import { user } from "../db/schema";
import { eq } from "drizzle-orm";
import type { Bindings } from "../types/env";

type Env = { Bindings: Bindings; Variables: AuthVariables & SpaceAccessVariables };
type Deps = typeof service & { createDb: typeof createDb; sendSpaceInvitation: typeof sendSpaceInvitation };
const defaults: Deps = { createDb, sendSpaceInvitation, ...service };
export function createInvitationsRoute(deps: Deps = defaults, access: MiddlewareHandler<Env> = requireActiveSpaceMember) {
  const route = new Hono<Env>(); route.use("*", access);
  route.get("/", async c => { if (!deps.mayManageMembers(c.get("activeSpaceMembership").role)) return forbidden(c); try { return c.json({ data: { invitations: await deps.listInvitations(deps.createDb(c.env.DATABASE_URL), c.req.param("spaceId")!) } }); } catch { return internal(c); } });
  route.post("/", async c => { if (!deps.mayManageMembers(c.get("activeSpaceMembership").role)) return forbidden(c); const input = await invitationInput(c.req.raw); if (!input) return invalid(c); try { const created = await deps.createInvitation(deps.createDb(c.env.DATABASE_URL), { ...input, spaceId: c.req.param("spaceId")!, invitedBy: c.get("currentUserId") }); const mail = await deps.sendSpaceInvitation(c.env.RESEND_API_KEY, { to: input.email, token: created.token, spaceId: c.req.param("spaceId")! }); return c.json({ data: { invitation: created.invitation, email: mail } }, 201); } catch { return internal(c); } });
  return route;
}
export function createInvitationAcceptanceRoute(deps: Deps = defaults) { const route = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>(); route.get("/", async c => { try { const db=deps.createDb(c.env.DATABASE_URL); const [current]=await db.select({email:user.email}).from(user).where(eq(user.id,c.get("currentUserId"))); return c.json({data:{invitations:current?await deps.listIncomingInvitations(db,c.get("currentUserId"),current.email):[]}}); } catch { return internal(c as never); } }); route.post("/accept", async c => { const body = await bodyOf(c.req.raw); if (!body || typeof body.token !== "string" || !/^[a-f0-9]{64}$/.test(body.token)) return invalid(c as never); try { const spaceId = await deps.acceptInvitation(deps.createDb(c.env.DATABASE_URL), c.get("currentUserId"), body.token); return spaceId ? c.json({ data: { spaceId } }) : c.json({ error: { code: "INVITATION_NOT_FOUND", message: "Invitation not found." } }, 404); } catch { return internal(c as never); } }); route.post("/:invitationId/accept", async c => { try { const spaceId=await deps.acceptLinkedInvitation(deps.createDb(c.env.DATABASE_URL),c.get("currentUserId"),c.req.param("invitationId")!); return spaceId?c.json({data:{spaceId}}):c.json({error:{code:"INVITATION_NOT_FOUND",message:"Invitation not found."}},404); } catch { return internal(c as never); } }); return route; }
export function createInvitationPreviewRoute(deps: Deps = defaults) { const route = new Hono<{ Bindings: Bindings }>(); route.get("/preview", async c => { const token=c.req.query("token"); if (!token || !/^[a-f0-9]{64}$/.test(token)) return invalid(c as never); try { return c.json({data:{invitation:await deps.previewInvitation(deps.createDb(c.env.DATABASE_URL),token)}}); } catch { return internal(c as never); } }); return route; }
async function bodyOf(r: Request) { try { const x: unknown = await r.json(); return x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : null; } catch { return null; } }
async function invitationInput(r: Request): Promise<{ email: string; role: "admin" | "member" } | null> { const x = await bodyOf(r); if (!x || Object.keys(x).some(k => k !== "email" && k !== "role") || typeof x.email !== "string" || !/^\S+@\S+\.\S+$/.test(x.email.trim()) || (x.role !== "admin" && x.role !== "member")) return null; return { email: x.email.trim().toLowerCase(), role: x.role }; }
function invalid(c: any) { return c.json({ error: { code: "INVALID_REQUEST", message: "Invalid request." } }, 400); } function forbidden(c: any) { return c.json({ error: { code: "FORBIDDEN", message: "Insufficient role." } }, 403); } function internal(c: any) { return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal error." } }, 500); }
