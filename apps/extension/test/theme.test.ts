import { describe, expect, it } from "vitest";
import { detectDarkPage, isDarkColor, luminance, parseCssColor } from "../src/lib/theme.js";

describe("parseCssColor", () => {
  it("reads both computed forms", () => {
    expect(parseCssColor("rgb(255, 255, 255)")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor("rgba(30, 30, 28, 0.5)")).toEqual({ r: 30, g: 30, b: 28, a: 0.5 });
  });

  it("returns null for anything else", () => {
    expect(parseCssColor("transparent")).toBeNull();
    expect(parseCssColor("")).toBeNull();
  });
});

describe("luminance", () => {
  it("runs from black to white", () => {
    expect(luminance({ r: 0, g: 0, b: 0, a: 1 })).toBe(0);
    expect(luminance({ r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(1);
  });
});

describe("isDarkColor", () => {
  it("says nothing about a see-through background", () => {
    expect(isDarkColor("rgba(0, 0, 0, 0)")).toBeNull();
  });

  it("separates claude.ai's two themes", () => {
    expect(isDarkColor("rgb(250, 249, 245)")).toBe(false);
    expect(isDarkColor("rgb(30, 30, 28)")).toBe(true);
  });
});

describe("detectDarkPage", () => {
  it("reads the page's own background before the operating system's", () => {
    document.body.style.backgroundColor = "rgb(30, 30, 28)";
    expect(detectDarkPage()).toBe(true);
    document.body.style.backgroundColor = "rgb(250, 249, 245)";
    expect(detectDarkPage()).toBe(false);
  });
});
