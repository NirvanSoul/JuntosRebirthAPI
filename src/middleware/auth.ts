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
) => Promise<{ userId: string } | null>;

export function createRequireAuth(resolveSession: SessionResolver) {
  return createMiddleware<{ Bindings: Bindings; Variables: AuthVariables }>(
    async (c, next) => {
      try {
        const session = await resolveSession(c.req.raw.headers, c.env);

        if (!session) {
          return errorResponse(c, "UNAUTHORIZED");
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

  return session ? { userId: session.user.id } : null;
});
