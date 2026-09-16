import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeSyncPolling } from "../src/middleware/sync-observability";

describe("sync polling observability", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits latency, status, 429 and in-flight data without request identifiers", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const app = new Hono();
    app.use("/changes", observeSyncPolling("sync_changes"));
    app.get("/changes", (c) => c.json({ ok: true }));

    const response = await app.request("/changes?since=secret-cursor");

    expect(response.status).toBe(200);
    expect(log).toHaveBeenCalledTimes(1);
    const metric = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(metric).toMatchObject({
      metric: "sync_poll_request",
      endpoint: "sync_changes",
      method: "GET",
      status: 200,
      inFlight: 1,
      isError: false,
      isThrottled: false,
      sampleRate: 0.01,
    });
    expect(metric.durationMs).toEqual(expect.any(Number));
    expect(JSON.stringify(metric)).not.toContain("secret-cursor");
  });

  it("marks a throttled response so 429s can be alerted on", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const app = new Hono();
    app.use("/changes", observeSyncPolling("sync_changes"));
    app.get("/changes", (c) => c.body(null, 429));

    await app.request("/changes");

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      status: 429,
      isError: true,
      isThrottled: true,
      sampleRate: 1,
    });
  });
});
