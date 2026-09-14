import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createInvitationAcceptanceRoute, createInvitationsRoute } from "../src/routes/invitations";
import { createRequireAuth, type AuthVariables } from "../src/middleware/auth";
import type { Database } from "../src/db/client";
import type { Bindings } from "../src/types/env";

const bindings: Bindings = {
  DATABASE_URL: "postgresql://user:pass@ep-test.neon.tech/neondb",
  BETTER_AUTH_SECRET: "test-secret-min-32-chars-long-example-12345",
  BETTER_AUTH_URL: "https://juntos.test",
  GOOGLE_CLIENT_ID: "mock-google-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "mock-google-client-secret",
};

const mockUserEmail = "user@example.com";

function createTestApp(options: {
  userId?: string;
  declineInvitationResult?: boolean;
  revokeInvitationResult?: boolean;
}) {
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();

  app.use(
    "/v1/*",
    createRequireAuth(async () =>
      options.userId ? { userId: options.userId, emailVerified: true } : null,
    ),
  );

  const mockDb = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ email: mockUserEmail }]),
      }),
    }),
  } as unknown as Database;

  const mockDeps = {
    createDb: () => mockDb,
    sendSpaceInvitation: vi.fn(),
    listTokensForUser: vi.fn().mockResolvedValue([]),
    sendPush: vi.fn().mockResolvedValue({ status: "sent" }),
    mayManageMembers: () => true,
    createInvitation: vi.fn(),
    listInvitations: vi.fn().mockResolvedValue([]),
    declineInvitation: vi
      .fn()
      .mockResolvedValue(options.declineInvitationResult ?? true),
    revokeInvitation: vi
      .fn()
      .mockResolvedValue(options.revokeInvitationResult ?? true),
    expireStaleInvitations: vi.fn().mockResolvedValue(0),
    acceptInvitation: vi.fn(),
    acceptLinkedInvitation: vi.fn(),
    invitationCountryMatches: vi.fn().mockResolvedValue(true),
    previewInvitation: vi.fn(),
    claimEmailInvitations: vi.fn(),
    listIncomingInvitations: vi.fn().mockResolvedValue([]),
  };

  app.route("/v1/invitations", createInvitationAcceptanceRoute(mockDeps as any));
  app.route(
    "/v1/spaces/:spaceId/invitations",
    createInvitationsRoute(mockDeps as any, async (c, next) => {
      c.set("activeSpaceMembership" as any, { role: "owner" });
      await next();
    }),
  );

  return { app, mockDeps };
}

describe("Invitation cancellation & rejection routes", () => {
  const invitationId = "70bb35c5-659b-4a33-8353-2b6dd79f35b5";

  it("POST /v1/invitations/:invitationId/reject successfully cancels/rejects the invitation", async () => {
    const { app, mockDeps } = createTestApp({
      userId: "user-1",
      declineInvitationResult: true,
    });

    const response = await app.request(
      `http://localhost/v1/invitations/${invitationId}/reject`,
      { method: "POST" },
      bindings,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { data: { declined: boolean; rejected: boolean; cancelled: boolean } };
    expect(body).toEqual({
      data: {
        declined: true,
        rejected: true,
        cancelled: true,
      },
    });
    expect(mockDeps.declineInvitation).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      mockUserEmail,
      invitationId,
    );
  });

  it("POST /v1/invitations/:invitationId/decline successfully declines the invitation", async () => {
    const { app } = createTestApp({
      userId: "user-1",
      declineInvitationResult: true,
    });

    const response = await app.request(
      `http://localhost/v1/invitations/${invitationId}/decline`,
      { method: "POST" },
      bindings,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { data: { declined: boolean; rejected: boolean; cancelled: boolean } };
    expect(body.data).toMatchObject({
      declined: true,
      rejected: true,
      cancelled: true,
    });
  });

  it("POST /v1/invitations/:invitationId/cancel successfully cancels the invitation", async () => {
    const { app } = createTestApp({
      userId: "user-1",
      declineInvitationResult: true,
    });

    const response = await app.request(
      `http://localhost/v1/invitations/${invitationId}/cancel`,
      { method: "POST" },
      bindings,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { data: { declined: boolean; rejected: boolean; cancelled: boolean } };
    expect(body.data).toMatchObject({
      declined: true,
      rejected: true,
      cancelled: true,
    });
  });

  it("DELETE /v1/invitations/:invitationId successfully cancels the invitation", async () => {
    const { app } = createTestApp({
      userId: "user-1",
      declineInvitationResult: true,
    });

    const response = await app.request(
      `http://localhost/v1/invitations/${invitationId}`,
      { method: "DELETE" },
      bindings,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { data: { declined: boolean; rejected: boolean; cancelled: boolean } };
    expect(body.data).toMatchObject({
      declined: true,
      rejected: true,
      cancelled: true,
    });
  });

  it("returns 404 INVITATION_NOT_FOUND when invitation cannot be declined/found", async () => {
    const { app } = createTestApp({
      userId: "user-1",
      declineInvitationResult: false,
    });

    const response = await app.request(
      `http://localhost/v1/invitations/${invitationId}/reject`,
      { method: "POST" },
      bindings,
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: "INVITATION_NOT_FOUND",
        message: "Invitation not found.",
      },
    });
  });

  it("POST /v1/spaces/:spaceId/invitations/:invitationId/cancel allows space owner to cancel invitation", async () => {
    const { app, mockDeps } = createTestApp({
      userId: "user-1",
      revokeInvitationResult: true,
    });

    const spaceId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
    const response = await app.request(
      `http://localhost/v1/spaces/${spaceId}/invitations/${invitationId}/cancel`,
      { method: "POST" },
      bindings,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      data: {
        revoked: true,
        cancelled: true,
      },
    });
    expect(mockDeps.revokeInvitation).toHaveBeenCalledWith(
      expect.anything(),
      spaceId,
      invitationId,
    );
  });
});
