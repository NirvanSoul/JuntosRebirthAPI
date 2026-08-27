import { Hono } from "hono";
import { healthRoute } from "./routes/health";
import type { Bindings } from "./types/env";

const app = new Hono<{ Bindings: Bindings }>();

app.route("/", healthRoute);

export default app;
