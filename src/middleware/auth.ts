import { createMiddleware } from "hono/factory";
import { errorResponse } from "../lib/http";
import { createAuth } from "../lib/auth";
import type { Bindings } from "../types/env";

export type AuthVariables = {
  currentUserId: string;
};

type SessionResolver = (
  headers: Headers,
  bindings: Bindings,
) => Promise<{ userId: string; emailVerified: boolean } | null>;

export function createRequireAuth(resolveSession: SessionResolver) {
  return createMiddleware<{ Bindings: Bindings; Variables: AuthVariables }>(
    async (c, next) => {
      try {
        const session = await resolveSession(c.req.raw.headers, c.env);

        if (!session) {
          return errorResponse(c, "UNAUTHORIZED");
        }

        // La sesión emitida durante el alta es deliberadamente insuficiente:
        // solo el OTP puede convertirla en acceso a datos de la aplicación.
        if (!session.emailVerified) {
          return errorResponse(c, "EMAIL_NOT_VERIFIED");
        }

        c.set("currentUserId", session.userId);
        await next();
      } catch {
        return errorResponse(c, "UNAUTHORIZED");
      }
    },
  );
}

export const requireAuth = createRequireAuth(async (headers, bindings) => {
  const session = await createAuth(bindings).api.getSession({ headers });

  return session
    ? { userId: session.user.id, emailVerified: session.user.emailVerified }
    : null;
});
