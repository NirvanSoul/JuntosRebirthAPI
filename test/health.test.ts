import { describe, it, expect } from "vitest";
import app from "../src/index";

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
});
