import { describe, expect, it } from "vitest";
import { surfaceFromPath } from "../src/lib/surface.js";

describe("surfaceFromPath", () => {
  it("recognizes the Claude Code surface", () => {
    expect(surfaceFromPath("/code")).toBe("code");
    expect(surfaceFromPath("/code/")).toBe("code");
    expect(surfaceFromPath("/code/session/abc123")).toBe("code");
  });

  it("treats everything else as chat", () => {
    expect(surfaceFromPath("/")).toBe("chat");
    expect(surfaceFromPath("/chat/abc123")).toBe("chat");
    expect(surfaceFromPath("/new")).toBe("chat");
    expect(surfaceFromPath("/codex")).toBe("chat");
  });
});
