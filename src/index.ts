import { Hono } from "hono";
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
import { accountRoute } from "./routes/account";

const app = new Hono<{ Bindings: Bindings }>();

app.route("/", healthRoute);
app.route("/v1/rates", ratesRoute);
app.use("/v1/spaces", requireAuth);
app.use("/v1/spaces/*", requireAuth);
app.use("/v1/bootstrap", requireAuth);
app.use("/v1/me", requireAuth);
app.use("/v1/me/*", requireAuth);
app.route("/v1", accountRoute);
app.route("/v1/spaces", spacesRoute);
app.route("/v1/spaces/:spaceId/categories", categoriesRoute);
app.route("/v1/spaces/:spaceId/money-accounts", moneyAccountsRoute);
app.route("/v1/spaces/:spaceId/transactions", transactionsRoute);
app.route("/v1/spaces/:spaceId/recurring-transactions", recurringTransactionsRoute);

app.all("/api/auth/*", (c) => {
  const auth = createAuth(c.env);
  return auth.handler(c.req.raw);
});

export default app;
