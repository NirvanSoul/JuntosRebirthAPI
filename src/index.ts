import { Hono } from "hono";
import { cors } from "hono/cors";
import { errorResponse } from "./lib/http";
import { reportConfigOnce } from "./lib/config";
import { healthRoute } from "./routes/health";
import { ratesRoute } from "./routes/rates";
import { spacesRoute } from "./routes/spaces";
import { categoriesRoute } from "./routes/categories";
import { moneyAccountsRoute } from "./routes/money-accounts";
import { transactionsRoute } from "./routes/transactions";
import { recurringTransactionsRoute } from "./routes/recurring-transactions";
import { requireAuth } from "./middleware/auth";
import { createAuth } from "./lib/auth";
import type { Bindings } from "./types/env";
import { runRecurrences } from "./services/recurrence-engine";
import { createDb } from "./db/client";
import { expireStaleInvitations } from "./services/invitations";
import { accountRoute } from "./routes/account";
import { createInvitationAcceptanceRoute, createInvitationPreviewRoute, createInvitationsRoute } from "./routes/invitations";
import { createMembersRoute } from "./routes/members";
import { guestMigrationRoute } from "./routes/guest-migration";
import { createSnapshotRoute, createSpaceSyncRoute } from "./routes/sync";
import { createAvatarsRoute } from "./routes/avatars";
import { createPushTokensRoute } from "./routes/push-tokens";
import { createImportsRoute } from "./routes/imports";

const app = new Hono<{ Bindings: Bindings }>();

// La app nativa no envía `Origin`, así que CORS solo afecta a los flujos web
// de OAuth y a Expo Web. La lista se mantiene alineada con `trustedOrigins`
// de Better Auth en `src/lib/auth.ts`.
// Un despliegue al que le falte un secreto debe verse en los logs desde la
// primera petición, no cuando alguien intente invitar a su pareja.
app.use("*", async (c, next) => {
  if (c.env) reportConfigOnce(c.env);
  await next();
});

app.use("*", (c, next) =>
  cors({
    origin: (origin) => {
      if (/^juntoss:\/\//.test(origin)) return origin;
      if (/^https:\/\/api\.aoraestudio\.com$/.test(origin)) return origin;
      if (/^https:\/\/juntosapi\.aora-estudio-o\.workers\.dev$/.test(origin)) return origin;
      if (c.env?.BETTER_AUTH_URL && origin === c.env.BETTER_AUTH_URL) return origin;
      if (c.env?.ENVIRONMENT === "development" && /^(exp|http):\/\//.test(origin)) {
        return origin;
      }
      return null;
    },
    credentials: true,
  })(c, next),
);

// Un throw fuera del `try` de un handler devolvía el 500 pelado de Hono, que
// no lleva el sobre `{ error: { code, message } }` que el cliente sabe leer.
app.onError((error, c) => {
  console.error("Unhandled error:", error instanceof Error ? error.message : error);
  return errorResponse(c, "INTERNAL_ERROR");
});

app.notFound((c) => errorResponse(c, "NOT_FOUND"));

// Antes de montar la ruta: en Hono el middleware registrado después de un
// handler ya no lo alcanza.
app.use("/health/config", requireAuth);
app.route("/", healthRoute);
app.route("/v1/rates", ratesRoute);
app.use("/v1/spaces", requireAuth);
app.use("/v1/spaces/*", requireAuth);
app.use("/v1/bootstrap", requireAuth);
app.use("/v1/me", requireAuth);
app.use("/v1/me/*", requireAuth);
app.use("/v1/sync/*", requireAuth);
app.use("/v1/avatars/*", requireAuth);
app.use("/v1/merchant-feedback", requireAuth);
app.route("/v1", accountRoute);
app.route("/v1", createAvatarsRoute());
app.route("/v1/me/push-tokens", createPushTokensRoute());
app.route("/v1", createImportsRoute());
app.route("/v1/sync", guestMigrationRoute);
app.route("/v1/sync", createSnapshotRoute());
// El orden importa: la vista previa de una invitación es pública (se abre
// desde el enlace del correo, sin sesión) y solo se libra de `requireAuth`
// porque se registra antes. Mover esta línea por debajo la rompe en silencio.
app.route("/v1/invitations", createInvitationPreviewRoute());
app.use("/v1/invitations/*", requireAuth);
app.route("/v1/invitations", createInvitationAcceptanceRoute());
app.route("/v1/spaces/:spaceId/invitations", createInvitationsRoute());
app.route("/v1/spaces/:spaceId/members", createMembersRoute());
app.route("/v1/spaces", spacesRoute);
app.route("/v1/spaces/:spaceId/sync", createSpaceSyncRoute());
app.route("/v1/spaces/:spaceId/categories", categoriesRoute);
app.route("/v1/spaces/:spaceId/money-accounts", moneyAccountsRoute);
app.route("/v1/spaces/:spaceId/transactions", transactionsRoute);
app.route(
  "/v1/spaces/:spaceId/recurring-transactions",
  recurringTransactionsRoute,
);

app.all("/api/auth/*", (c) => {
  const auth = createAuth(c.env);
  return auth.handler(c.req.raw);
});

const worker = Object.assign(app, {
  scheduled(_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        const [recurrences, expiredInvitations] = await Promise.all([
          runRecurrences(env.DATABASE_URL),
          expireStaleInvitations(createDb(env.DATABASE_URL)),
        ]);
        // `invalidSeries` y `truncatedSeries` son la señal de que algo dejó de
        // generarse: sin ellas una serie rota se reintentaba en silencio.
        console.log(JSON.stringify({ ...recurrences, expiredInvitations }));
      })(),
    );
  },
});

export default worker;
