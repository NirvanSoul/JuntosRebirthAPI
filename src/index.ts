import { Hono } from "hono";
import { healthRoute } from "./routes/health";
import { createAuth } from "./lib/auth";
import type { Bindings } from "./types/env";

const app = new Hono<{ Bindings: Bindings }>();

app.route("/", healthRoute);

app.on(["POST", "GET"], "/api/auth/*", (c) => {
  const auth = createAuth(c.env);
  return auth.handler(c.req.raw);
});

export default app;
