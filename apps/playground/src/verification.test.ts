import { describe, expect, it, vi } from "vitest";
import { requestVerifiedInputTokens } from "./verification.js";

const request = {
  model: "claude-opus-5",
  messages: [{ role: "user", content: "hello" }],
};

describe("requestVerifiedInputTokens", () => {
  it("returns the provider count", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ tokens: 8 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      requestVerifiedInputTokens(request, { fetchImpl }),
    ).resolves.toBe(8);
  });

  it("preserves a useful error returned by the count server", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "authentication failed" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      requestVerifiedInputTokens(request, { fetchImpl }),
    ).rejects.toThrow("Token verification failed (401): authentication failed");
  });

  it("points to the missing local server when Vite returns an empty 500", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));

    await expect(
      requestVerifiedInputTokens(request, { fetchImpl }),
    ).rejects.toThrow("pnpm dev:server");
  });
});
