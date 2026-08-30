import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { spaceMembers, userPushTokens } from "../db/schema";

export const EXPO_PUSH_TOKEN = /^Expo(nent)?PushToken\[[^\]]+\]$/;

export type PushPlatform = "ios" | "android";

export function isExpoPushToken(value: unknown): value is string {
  return typeof value === "string" && EXPO_PUSH_TOKEN.test(value);
}

/**
 * Un token pertenece a un solo dispositivo, pero ese dispositivo puede cambiar
 * de cuenta: al registrarlo se reasigna al usuario actual.
 */
export async function registerPushToken(
  db: Database,
  userId: string,
  input: { expoPushToken: string; platform: PushPlatform },
): Promise<void> {
  await db
    .insert(userPushTokens)
    .values({ expoPushToken: input.expoPushToken, userId, platform: input.platform })
    .onConflictDoUpdate({
      target: userPushTokens.expoPushToken,
      set: { userId, platform: input.platform, updatedAt: new Date() },
    });
}

export async function unregisterPushToken(
  db: Database,
  userId: string,
  expoPushToken: string,
): Promise<void> {
  await db
    .delete(userPushTokens)
    .where(
      and(
        eq(userPushTokens.expoPushToken, expoPushToken),
        eq(userPushTokens.userId, userId),
      ),
    );
}

export async function listTokensForUser(db: Database, userId: string): Promise<string[]> {
  const rows = await db
    .select({ token: userPushTokens.expoPushToken })
    .from(userPushTokens)
    .where(eq(userPushTokens.userId, userId));
  return rows.map((row) => row.token);
}

/** Todos los dispositivos de los miembros activos de un espacio, menos el actor. */
export async function listTokensForSpace(
  db: Database,
  spaceId: string,
  excludeUserId?: string,
): Promise<string[]> {
  const rows = await db
    .select({ token: userPushTokens.expoPushToken })
    .from(userPushTokens)
    .innerJoin(spaceMembers, eq(spaceMembers.userId, userPushTokens.userId))
    .where(
      and(
        eq(spaceMembers.spaceId, spaceId),
        eq(spaceMembers.status, "active"),
        excludeUserId ? sql`${userPushTokens.userId} <> ${excludeUserId}` : undefined,
      ),
    );
  return [...new Set(rows.map((row) => row.token))];
}

export type PushMessage = {
  title: string;
  body: string;
  data?: Record<string, unknown>;
};

export type PushResult = { delivered: number; removed: number };

type Fetcher = typeof fetch;

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";

/**
 * Envía por la Expo Push API. Sustituye la edge function
 * `send-space-invitation-push` y su RPC `claim_space_invitation_push`.
 *
 * Un push nunca debe tumbar la operación que lo dispara: los fallos se
 * registran y se devuelven, no se lanzan. Los tokens que Expo marca como
 * inválidos se borran para no reintentarlos eternamente.
 */
export async function sendPush(
  db: Database,
  tokens: string[],
  message: PushMessage,
  // Envuelto por el mismo motivo que en `rates/venezuela.ts`: un `fetch`
  // desligado de su `this` global falla en Workers.
  fetcher: Fetcher = (input, init) => fetch(input, init),
): Promise<PushResult> {
  if (tokens.length === 0) return { delivered: 0, removed: 0 };

  let response: Response;
  try {
    response = await fetcher(EXPO_PUSH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(
        tokens.map((to) => ({
          to,
          title: message.title,
          body: message.body,
          sound: "default",
          ...(message.data ? { data: message.data } : {}),
        })),
      ),
    });
  } catch (error) {
    console.error("Expo push request failed:", error);
    return { delivered: 0, removed: 0 };
  }

  if (!response.ok) {
    console.error("Expo push rejected the batch:", response.status);
    return { delivered: 0, removed: 0 };
  }

  let tickets: { status?: string; details?: { error?: string } }[] = [];
  try {
    const payload = (await response.json()) as { data?: unknown };
    if (Array.isArray(payload.data)) tickets = payload.data;
  } catch {
    return { delivered: tokens.length, removed: 0 };
  }

  const stale = tokens.filter(
    (_token, index) => tickets[index]?.details?.error === "DeviceNotRegistered",
  );
  if (stale.length > 0) {
    await db.delete(userPushTokens).where(inArray(userPushTokens.expoPushToken, stale));
  }

  const delivered = tickets.filter((ticket) => ticket.status === "ok").length;
  return { delivered, removed: stale.length };
}
