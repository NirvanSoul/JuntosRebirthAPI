import { describe, it, expect, vi } from "vitest";
import app from "../src/index";
import * as client from "../src/db/client";

describe("Health Route", () => {
  it("GET /health returns status 200 and expected json payload", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({
      status: "ok",
      service: "juntoss-api",
    });
  });

  describe("GET /health/db", () => {
    it("returns 500 when DATABASE_URL is not provided", async () => {
      const res = await app.request("/health/db");
      expect(res.status).toBe(500);

      const body = await res.json();
      expect(body).toEqual({
        status: "error",
        database: "unavailable",
      });
    });

    it("returns 200 and connected when db execute succeeds", async () => {
      const mockExecute = vi.fn().mockResolvedValue([{ "?column?": 1 }]);
      vi.spyOn(client, "createDb").mockReturnValue({
        execute: mockExecute,
      } as unknown as client.Database);

      const res = await app.request(
        "/health/db",
        {},
        { DATABASE_URL: "postgresql://user:pass@ep-test.neon.tech/neondb" }
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({
        status: "ok",
        database: "connected",
      });
      expect(mockExecute).toHaveBeenCalled();
    });

    it("returns 500 when db connection fails without exposing secrets", async () => {
      vi.spyOn(client, "createDb").mockImplementation(() => {
        throw new Error("Connection refused password=secret_pw");
      });

      const res = await app.request(
        "/health/db",
        {},
        { DATABASE_URL: "postgresql://user:pass@ep-test.neon.tech/neondb" }
      );
      expect(res.status).toBe(500);

      const body = await res.json();
      expect(body).toEqual({
        status: "error",
        database: "unavailable",
      });
    });
  });
});
