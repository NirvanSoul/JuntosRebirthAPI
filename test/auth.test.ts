import { describe, it, expect } from "vitest";
import { createAuth } from "../src/lib/auth";

describe("Better Auth Factory", () => {
  it("throws error when DATABASE_URL is missing", () => {
    expect(() =>
      createAuth({
        DATABASE_URL: "",
        BETTER_AUTH_SECRET: "test-secret-min-32-chars-long-example-12345",
        BETTER_AUTH_URL: "https://example.workers.dev",
      })
    ).toThrow("DATABASE_URL is required to initialize auth");
  });

  it("initializes auth instance with valid bindings", () => {
    const auth = createAuth({
      DATABASE_URL: "postgresql://user:pass@ep-test.neon.tech/neondb",
      BETTER_AUTH_SECRET: "test-secret-min-32-chars-long-example-12345",
      BETTER_AUTH_URL: "https://example.workers.dev",
    });

    expect(auth).toBeDefined();
    expect(auth.handler).toBeTypeOf("function");
  });
});
