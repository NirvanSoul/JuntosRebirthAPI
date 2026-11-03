import type { ErrorHandler } from "hono";
import { errorResponse } from "./http";
import { logFailure } from "./log";

// Un throw fuera del `try` de un handler devolvía el 500 pelado de Hono, que
// no lleva el sobre `{ error: { code, message } }` que el cliente sabe leer.
// Se registra la ruta (patrón, sin ids) y nunca el mensaje del error.
export const handleUnhandledError: ErrorHandler = (error, c) => {
  logFailure("unhandled_error", error, { method: c.req.method, route: c.req.routePath });
  return errorResponse(c, "INTERNAL_SERVER_ERROR");
};
