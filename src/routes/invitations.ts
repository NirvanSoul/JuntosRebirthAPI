import { Hono, type MiddlewareHandler } from "hono";
import { createDb } from "../db/client";
import { errorResponse } from "../lib/http";
import { isUniqueViolation } from "../lib/pg";
import { parseBody } from "../lib/validation";
import type { AuthVariables } from "../middleware/auth";
import { requireActiveSpaceMember, type SpaceAccessVariables } from "../middleware/space-access";
import * as service from "../services/invitations";
import { sendSpaceInvitation } from "../services/email";
import { listTokensForUser, sendPush } from "../services/push";
import { user } from "../db/schema";
import { eq } from "drizzle-orm";
import type { Bindings } from "../types/env";

type Env = { Bindings: Bindings; Variables: AuthVariables & SpaceAccessVariables };
type Deps = typeof service & { createDb: typeof createDb; sendSpaceInvitation: typeof sendSpaceInvitation; listTokensForUser: typeof listTokensForUser; sendPush: typeof sendPush };
const defaults: Deps = { createDb, sendSpaceInvitation, listTokensForUser, sendPush, ...service };
export function createInvitationsRoute(deps: Deps = defaults, access: MiddlewareHandler<Env> = requireActiveSpaceMember) {
  const route = new Hono<Env>(); route.use("*", access);
  route.get("/", async c => { if (!deps.mayManageMembers(c.get("activeSpaceMembership").role)) return errorResponse(c, "FORBIDDEN", "Insufficient role."); try { return c.json({ data: { invitations: await deps.listInvitations(deps.createDb(c.env.DATABASE_URL), c.req.param("spaceId")!) } }); } catch { return errorResponse(c, "INTERNAL_SERVER_ERROR"); } });
  route.post("/", async c => { if (!deps.mayManageMembers(c.get("activeSpaceMembership").role)) return errorResponse(c, "FORBIDDEN", "Insufficient role."); const input = await invitationInput(c.req.raw); if (!input) return errorResponse(c, "INVALID_REQUEST"); try { const created = await deps.createInvitation(deps.createDb(c.env.DATABASE_URL), { ...input, spaceId: c.req.param("spaceId")!, invitedBy: c.get("currentUserId") }); const mail = await deps.sendSpaceInvitation({ apiKey: c.env.RESEND_API_KEY, from: c.env.RESEND_FROM, appUrl: c.env.APP_URL }, { to: input.email, token: created.token, spaceName: created.spaceName ?? undefined }); notifyInvitee(c, deps, created); return c.json({ data: { invitation: created.invitation, email: mail } }, 201); } catch (error) { const reason = error instanceof Error ? error.message : ""; if (reason === "INVITATION_ALREADY_PENDING" || isUniqueViolation(error, "space_invitations_one_pending_per_email_idx")) return errorResponse(c, "INVITATION_ALREADY_PENDING"); console.error("Invitation creation failed:", reason); return errorResponse(c, "INTERNAL_SERVER_ERROR"); } });
  route.post("/:invitationId/revoke", async c => { if (!deps.mayManageMembers(c.get("activeSpaceMembership").role)) return errorResponse(c, "FORBIDDEN", "Insufficient role."); try { const revoked = await deps.revokeInvitation(deps.createDb(c.env.DATABASE_URL), c.req.param("spaceId")!, c.req.param("invitationId")!); return revoked ? c.json({ data: { revoked: true } }) : errorResponse(c, "INVITATION_NOT_FOUND"); } catch { return errorResponse(c, "INTERNAL_SERVER_ERROR"); } });
  route.delete("/:invitationId", async c => { if (!deps.mayManageMembers(c.get("activeSpaceMembership").role)) return errorResponse(c, "FORBIDDEN", "Insufficient role."); try { const revoked = await deps.revokeInvitation(deps.createDb(c.env.DATABASE_URL), c.req.param("spaceId")!, c.req.param("invitationId")!); return revoked ? c.body(null, 204) : errorResponse(c, "INVITATION_NOT_FOUND"); } catch { return errorResponse(c, "INTERNAL_SERVER_ERROR"); } });
  return route;
}
/**
 * El push es un extra sobre el correo: se lanza fuera de la respuesta con
 * `waitUntil` para no retrasar a quien invita, y cualquier fallo se traga.
 */
function notifyInvitee(
  c: { env: Bindings; executionCtx?: { waitUntil(promise: Promise<unknown>): void } },
  deps: Deps,
  created: { inviteeUserId: string | null; spaceName: string | null; invitation: { id: string } },
) {
  if (!created.inviteeUserId) return;

  const task = (async () => {
    try {
      const db = deps.createDb(c.env.DATABASE_URL);
      const tokens = await deps.listTokensForUser(db, created.inviteeUserId!);
      await deps.sendPush(db, tokens, {
        title: "Te invitaron a un espacio",
        body: `Te invitaron a ${created.spaceName ?? "un espacio"} en Juntoss.`,
        data: { type: "space-invitation", invitationId: created.invitation.id },
      });
    } catch (error) {
      console.error("Invitation push failed:", error);
    }
  })();

  try {
    c.executionCtx?.waitUntil(task);
  } catch {
    // Fuera de Workers (por ejemplo en pruebas) no hay ExecutionContext.
    void task;
  }
}

export function createInvitationAcceptanceRoute(deps: Deps = defaults) { const route = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>(); route.get("/", async c => { try { const db=deps.createDb(c.env.DATABASE_URL); const [current]=await db.select({email:user.email}).from(user).where(eq(user.id,c.get("currentUserId"))); return c.json({data:{invitations:current?await deps.listIncomingInvitations(db,c.get("currentUserId"),current.email):[]}}); } catch { return errorResponse(c, "INTERNAL_SERVER_ERROR"); } }); route.post("/accept", async c => { const body = await parseBody(c.req.raw, ["token"]); if (!body || typeof body.token !== "string" || !/^[a-f0-9]{64}$/.test(body.token)) return errorResponse(c, "INVALID_REQUEST"); try { const spaceId = await deps.acceptInvitation(deps.createDb(c.env.DATABASE_URL), c.get("currentUserId"), body.token); return spaceId ? c.json({ data: { spaceId } }) : errorResponse(c, "INVITATION_NOT_FOUND"); } catch { return errorResponse(c, "INTERNAL_SERVER_ERROR"); } }); route.post("/:invitationId/decline", async c => { try { const db=deps.createDb(c.env.DATABASE_URL); const [current]=await db.select({email:user.email}).from(user).where(eq(user.id,c.get("currentUserId"))); if(!current) return errorResponse(c, "INVITATION_NOT_FOUND"); const declined=await deps.declineInvitation(db,c.get("currentUserId"),current.email,c.req.param("invitationId")!); return declined?c.json({data:{declined:true}}):errorResponse(c, "INVITATION_NOT_FOUND"); } catch { return errorResponse(c, "INTERNAL_SERVER_ERROR"); } }); route.post("/:invitationId/accept", async c => { try { const spaceId=await deps.acceptLinkedInvitation(deps.createDb(c.env.DATABASE_URL),c.get("currentUserId"),c.req.param("invitationId")!); return spaceId?c.json({data:{spaceId}}):errorResponse(c, "INVITATION_NOT_FOUND"); } catch { return errorResponse(c, "INTERNAL_SERVER_ERROR"); } }); return route; }
export function createInvitationPreviewRoute(deps: Deps = defaults) { const route = new Hono<{ Bindings: Bindings }>(); route.get("/preview", async c => { const token=c.req.query("token"); if (!token || !/^[a-f0-9]{64}$/.test(token)) return errorResponse(c, "INVALID_REQUEST"); try { return c.json({data:{invitation:await deps.previewInvitation(deps.createDb(c.env.DATABASE_URL),token)}}); } catch { return errorResponse(c, "INTERNAL_SERVER_ERROR"); } }); return route; }
async function invitationInput(r: Request): Promise<{ email: string; role: "admin" | "member" } | null> { const x = await parseBody(r, ["email", "role"]); if (!x || typeof x.email !== "string" || !/^\S+@\S+\.\S+$/.test(x.email.trim()) || (x.role !== "admin" && x.role !== "member")) return null; return { email: x.email.trim().toLowerCase(), role: x.role }; }
