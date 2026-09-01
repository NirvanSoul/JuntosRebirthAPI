import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createRequireAuth, type AuthVariables } from "../src/middleware/auth";
import { createAvatarsRoute } from "../src/routes/avatars";
import { sharesActiveSpace } from "../src/services/avatars";
import type { Database } from "../src/db/client";
import type { Bindings } from "../src/types/env";

/** JPEG mínimo válido con las dimensiones dadas. */
function jpeg(width = 256, height = 256): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
  ];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0xff, 0xda, 0x00, 0x08, 0xff, 0xd9]);
}

function fakeBucket(stored?: { body: string; contentType?: string }) {
  return {
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(
      stored
        ? {
            body: stored.body,
            httpMetadata: { contentType: stored.contentType ?? "image/jpeg" },
            httpEtag: '"etag"',
          }
        : null,
    ),
  } as unknown as R2Bucket & { put: ReturnType<typeof vi.fn> };
}

function appWith(overrides: Parameters<typeof createAvatarsRoute>[0], env: Partial<Bindings>) {
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  app.use("*", createRequireAuth(async () => ({ userId: "viewer-1", emailVerified: true })));
  app.route("/v1", createAvatarsRoute(overrides));
  return { app, env: { DATABASE_URL: "postgres://x", ...env } as Bindings };
}

const deps = {
  createDb: vi.fn(() => ({}) as Database),
  saveAvatar: vi.fn().mockResolvedValue({ avatarPath: "viewer-1/avatar.jpg", avatarUpdatedAt: new Date() }),
  deleteAvatar: vi.fn().mockResolvedValue(undefined),
  sharesActiveSpace: vi.fn().mockResolvedValue(true),
};

describe("avatars", () => {
  it("gives each rejection its own code so the client can branch", async () => {
    const { app, env } = appWith({ ...deps }, { AVATARS: fakeBucket() });
    const upload = async (body: BodyInit) =>
      (await (
        await app.request(
          "/v1/me/avatar",
          { method: "PUT", headers: { "content-type": "image/jpeg" }, body },
          env,
        )
      ).json()) as { error: { code: string } };

    // "recomprime la foto" y "esa no es una imagen" piden copys distintos.
    expect((await upload(new TextEncoder().encode("basura"))).error.code).toBe(
      "AVATAR_INVALID_FORMAT",
    );
    expect((await upload(new Uint8Array(256 * 1024 + 1))).error.code).toBe("AVATAR_TOO_LARGE");
    expect((await upload(jpeg(4000, 4000))).error.code).toBe("AVATAR_TOO_LARGE");
    expect((await upload(jpeg(16, 16))).error.code).toBe("AVATAR_TOO_SMALL");
  });

  it("rejects anything that is not a jpeg", async () => {
    const { app, env } = appWith({ ...deps }, { AVATARS: fakeBucket() });

    const response = await app.request(
      "/v1/me/avatar",
      { method: "PUT", headers: { "content-type": "image/png" }, body: new Uint8Array([1]) },
      env,
    );

    expect(response.status).toBe(400);
    expect(deps.saveAvatar).not.toHaveBeenCalled();
  });

  it("rejects an avatar over the 256 KiB budget", async () => {
    const { app, env } = appWith({ ...deps }, { AVATARS: fakeBucket() });

    const response = await app.request(
      "/v1/me/avatar",
      {
        method: "PUT",
        headers: { "content-type": "image/jpeg" },
        body: new Uint8Array(256 * 1024 + 1),
      },
      env,
    );

    expect(response.status).toBe(400);
  });

  it("rejects arbitrary bytes announced as a jpeg", async () => {
    const save = vi.fn();
    const { app, env } = appWith({ ...deps, saveAvatar: save }, { AVATARS: fakeBucket() });

    // `Content-Type` lo elige quien sube: sin mirar los bytes, esto se guardaba.
    const response = await app.request(
      "/v1/me/avatar",
      {
        method: "PUT",
        headers: { "content-type": "image/jpeg" },
        body: new TextEncoder().encode("esto no es una imagen en absoluto"),
      },
      env,
    );

    expect(response.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it("rejects an image whose real dimensions are absurd", async () => {
    const { app, env } = appWith({ ...deps }, { AVATARS: fakeBucket() });

    const big = await app.request(
      "/v1/me/avatar",
      { method: "PUT", headers: { "content-type": "image/jpeg" }, body: jpeg(4000, 4000) },
      env,
    );
    const tiny = await app.request(
      "/v1/me/avatar",
      { method: "PUT", headers: { "content-type": "image/jpeg" }, body: jpeg(16, 16) },
      env,
    );

    expect(big.status).toBe(400);
    expect(tiny.status).toBe(400);
  });

  it("stores a valid avatar under the owner's folder", async () => {
    const save = vi
      .fn()
      .mockResolvedValue({ avatarPath: "viewer-1/avatar.jpg", avatarUpdatedAt: new Date() });
    const { app, env } = appWith({ ...deps, saveAvatar: save }, { AVATARS: fakeBucket() });

    const response = await app.request(
      "/v1/me/avatar",
      {
        method: "PUT",
        headers: { "content-type": "image/jpeg" },
        body: jpeg(),
      },
      env,
    );

    expect(response.status).toBe(200);
    // Nunca se confía en un userId enviado por el cliente: sale de la sesión.
    expect(save).toHaveBeenCalledWith(expect.anything(), expect.anything(), "viewer-1", expect.anything());
  });

  it("refuses to serve the avatar of someone outside your spaces", async () => {
    const { app, env } = appWith(
      { ...deps, sharesActiveSpace: vi.fn().mockResolvedValue(false) },
      { AVATARS: fakeBucket({ body: "jpeg" }) },
    );

    const response = await app.request("/v1/avatars/stranger", {}, env);

    expect(response.status).toBe(403);
  });

  it("serves the avatar of someone in a shared space", async () => {
    const { app, env } = appWith({ ...deps }, { AVATARS: fakeBucket({ body: "jpeg" }) });

    const response = await app.request("/v1/avatars/partner-1", {}, env);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
  });

  it("short-circuits the membership check for your own avatar", async () => {
    const select = vi.fn();
    await expect(
      sharesActiveSpace({ select } as unknown as Database, "user-1", "user-1"),
    ).resolves.toBe(true);
    expect(select).not.toHaveBeenCalled();
  });
});
