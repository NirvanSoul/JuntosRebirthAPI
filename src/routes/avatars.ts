import { Hono } from "hono";
import { createDb } from "../db/client";
import { errorResponse, type ErrorCode } from "../lib/http";
import type { AuthVariables } from "../middleware/auth";
import {
  AVATAR_CONTENT_TYPE,
  MAX_AVATAR_BYTES,
  MAX_AVATAR_DIMENSION,
  MIN_AVATAR_DIMENSION,
  avatarKey,
  deleteAvatar,
  inspectAvatar,
  saveAvatar,
  sharesActiveSpace,
  type AvatarRejection,
} from "../services/avatars";
import type { Bindings } from "../types/env";

type Env = { Bindings: Bindings; Variables: AuthVariables };

type Deps = {
  createDb: typeof createDb;
  saveAvatar: typeof saveAvatar;
  deleteAvatar: typeof deleteAvatar;
  sharesActiveSpace: typeof sharesActiveSpace;
};

const defaults: Deps = { createDb, saveAvatar, deleteAvatar, sharesActiveSpace };

/**
 * Sustituye el bucket privado `avatars` de la base anterior. La app sube y
 * descarga siempre a través de la API: R2 nunca se expone al cliente.
 */
/**
 * Cada rechazo lleva su propio código: el cliente tiene que poder distinguir
 * "recomprime la foto" de "esa no es una imagen", y un mensaje de texto no es
 * un contrato sobre el que se pueda ramificar.
 */
const REJECTIONS: Record<AvatarRejection, { code: ErrorCode; message: string }> = {
  empty: { code: "AVATAR_INVALID_FORMAT", message: "Avatar is empty." },
  not_jpeg: { code: "AVATAR_INVALID_FORMAT", message: "Avatar must be a real JPEG file." },
  too_large: {
    code: "AVATAR_TOO_LARGE",
    message: `Avatar must be at most ${MAX_AVATAR_BYTES / 1024} KiB. Compress it on the device before uploading.`,
  },
  dimensions_too_large: {
    code: "AVATAR_TOO_LARGE",
    message: `Avatar must be at most ${MAX_AVATAR_DIMENSION}x${MAX_AVATAR_DIMENSION} pixels.`,
  },
  dimensions_too_small: {
    code: "AVATAR_TOO_SMALL",
    message: `Avatar must be at least ${MIN_AVATAR_DIMENSION}x${MIN_AVATAR_DIMENSION} pixels.`,
  },
};

export function createAvatarsRoute(deps: Deps = defaults) {
  const route = new Hono<Env>();

  route.put("/me/avatar", async (c) => {
    if (!c.env.AVATARS) return errorResponse(c, "INTERNAL_ERROR", "Avatar storage is not configured.");

    const contentType = c.req.header("content-type")?.split(";")[0]?.trim();
    if (contentType !== AVATAR_CONTENT_TYPE) {
      return errorResponse(c, "AVATAR_INVALID_FORMAT", "Avatar must be sent as image/jpeg.");
    }

    const body = await c.req.arrayBuffer();
    const inspected = inspectAvatar(body);
    if (!inspected.ok) {
      const rejection = REJECTIONS[inspected.reason];
      return errorResponse(c, rejection.code, rejection.message);
    }

    try {
      const avatar = await deps.saveAvatar(
        deps.createDb(c.env.DATABASE_URL),
        c.env.AVATARS,
        c.get("currentUserId"),
        body,
      );
      return c.json({ data: { avatar } });
    } catch (error) {
      console.error("Avatar upload failed:", error);
      return errorResponse(c, "INTERNAL_ERROR");
    }
  });

  route.delete("/me/avatar", async (c) => {
    if (!c.env.AVATARS) return errorResponse(c, "INTERNAL_ERROR", "Avatar storage is not configured.");

    try {
      await deps.deleteAvatar(
        deps.createDb(c.env.DATABASE_URL),
        c.env.AVATARS,
        c.get("currentUserId"),
      );
      return c.body(null, 204);
    } catch (error) {
      console.error("Avatar delete failed:", error);
      return errorResponse(c, "INTERNAL_ERROR");
    }
  });

  route.get("/avatars/:userId", async (c) => {
    if (!c.env.AVATARS) return errorResponse(c, "INTERNAL_ERROR", "Avatar storage is not configured.");

    const ownerId = c.req.param("userId")!;
    try {
      const allowed = await deps.sharesActiveSpace(
        deps.createDb(c.env.DATABASE_URL),
        c.get("currentUserId"),
        ownerId,
      );
      if (!allowed) return errorResponse(c, "FORBIDDEN");

      const object = await c.env.AVATARS.get(avatarKey(ownerId));
      if (!object) return errorResponse(c, "NOT_FOUND", "Avatar not found.");

      return new Response(object.body, {
        headers: {
          "Content-Type": object.httpMetadata?.contentType ?? AVATAR_CONTENT_TYPE,
          "Cache-Control": "private, max-age=300",
          ETag: object.httpEtag,
        },
      });
    } catch (error) {
      console.error("Avatar read failed:", error);
      return errorResponse(c, "INTERNAL_ERROR");
    }
  });

  return route;
}
