import { Hono } from "hono";
import { healthRoute } from "./routes/health";
import { ratesRoute } from "./routes/rates";
import { createAuth } from "./lib/auth";
import type { Bindings } from "./types/env";

const app = new Hono<{ Bindings: Bindings }>();

app.route("/", healthRoute);
app.route("/v1/rates", ratesRoute);

app.all("/api/auth/*", (c) => {
  const auth = createAuth(c.env);
  return auth.handler(c.req.raw);
});

export default app;
