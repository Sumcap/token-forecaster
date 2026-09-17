import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { baseTextHashTerms, createBaseTextHead } from "./base-text-head.js";
import type { BaseTextHeadAsset } from "./base-text-head.js";
// The bound head and its asset come from the subpath, not the main entry: the
// asset must stay off `index.ts`'s import graph (see `text-head/index.ts`).
import {
  BASE_TEXT_HEAD_ASSET,
  BASE_TEXT_HEAD_VERSION,
  baseTextHead,
} from "./text-head/index.js";

interface ParityFixture {
  generator: string;
  assetVersion: string;
  bits: number;
  dims: number;
  truncateChars: number;
  longestPromptChars: number;
  clampedPrompts: number;
  prompts: { text: string; head: [number, number, number] }[];
  hasher: { text: string; bits: number; terms: { bucket: number; sign: number }[] }[];
}

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./__fixtures__/base-text-head-parity.json", import.meta.url)),
    "utf8",
  ),
) as ParityFixture;

const TOLERANCE = 1e-6;

describe("base text head parity with the Python trainer", () => {
  it("is graded against the asset it was generated from", () => {
    expect(fixture.assetVersion).toBe(BASE_TEXT_HEAD_VERSION);
    expect(fixture.bits).toBe(BASE_TEXT_HEAD_ASSET.bits);
    expect(fixture.dims).toBe(BASE_TEXT_HEAD_ASSET.dims);
    expect(fixture.truncateChars).toBe(BASE_TEXT_HEAD_ASSET.truncateChars);
    expect(fixture.prompts).toHaveLength(200);
    expect(fixture.hasher).toHaveLength(20);
  });

  it("hashes by default at the size and truncation the shipped asset was trained at", () => {
    // `baseTextHashTerms` carries literal defaults so the pure module can stay
    // asset-free; these two assertions are what stops them drifting from the
    // asset after a retrain at another size.
    const text = fixture.prompts[3]!.text;
    expect(baseTextHashTerms(text)).toEqual(
      baseTextHashTerms(text, BASE_TEXT_HEAD_ASSET.bits),
    );
    const long = fixture.prompts.find(
      (row) => row.text.length > BASE_TEXT_HEAD_ASSET.truncateChars,
    );
    expect(long, "the fixture must contain a prompt past the truncation boundary").toBeDefined();
    const tail = (long as { text: string }).text;
    expect(baseTextHashTerms(tail)).toEqual(
      baseTextHashTerms(tail.slice(0, BASE_TEXT_HEAD_ASSET.truncateChars)),
    );
  });

  it("matches the Python evaluator on 200 synthetic prompts", () => {
    let worst = 0;
    let worstIndex = -1;
    fixture.prompts.forEach((row, index) => {
      const got = baseTextHead(row.text);
      for (let q = 0; q < 3; q++) {
        const delta = Math.abs((got[q] as number) - (row.head[q] as number));
        if (delta > worst) {
          worst = delta;
          worstIndex = index;
        }
      }
    });
    expect(
      worst,
      `worst disagreement ${worst} at synthetic prompt ${worstIndex}`,
    ).toBeLessThan(TOLERANCE);
  });

  it("returns finite, monotone quantiles for every fixture prompt", () => {
    for (const row of fixture.prompts) {
      const [p50, p90, p99] = baseTextHead(row.text);
      expect(Number.isFinite(p50) && Number.isFinite(p90) && Number.isFinite(p99)).toBe(
        true,
      );
      expect(p90).toBeGreaterThanOrEqual(p50);
      expect(p99).toBeGreaterThanOrEqual(p90);
    }
  });

  it("hashes the same buckets and signs as Python on 20 strings", () => {
    for (const testCase of fixture.hasher) {
      const terms = baseTextHashTerms(testCase.text, testCase.bits);
      expect(terms).toEqual(testCase.terms);
    }
  });

  it("truncates at the asset's character limit", () => {
    const limit = BASE_TEXT_HEAD_ASSET.truncateChars;
    const long = fixture.prompts.find((row) => row.text.length > limit);
    expect(long, "the fixture must contain a prompt past the truncation boundary").toBeDefined();
    const text = (long as { text: string }).text;
    expect(baseTextHead(text)).toEqual(baseTextHead(text.slice(0, limit)));
    expect(baseTextHead(text)).toEqual(baseTextHead(`${text.slice(0, limit)} ignored tail`));
  });

  it("is a pure function of the text, call after call", () => {
    const first = baseTextHead(fixture.prompts[0]!.text);
    baseTextHead(fixture.prompts[7]!.text);
    baseTextHead("");
    expect(baseTextHead(fixture.prompts[0]!.text)).toEqual(first);
  });

  it("handles the empty string without touching a bucket", () => {
    expect(baseTextHashTerms("")).toEqual([]);
    const [p50, p90, p99] = baseTextHead("");
    expect(Number.isFinite(p50) && Number.isFinite(p90) && Number.isFinite(p99)).toBe(true);
  });
});

describe("the asset contract", () => {
  it("carries exactly three quantile ensembles at 0.5, 0.9 and 0.99", () => {
    expect(BASE_TEXT_HEAD_ASSET.heads.map((h) => h.quantile)).toEqual([0.5, 0.9, 0.99]);
    for (const head of BASE_TEXT_HEAD_ASSET.heads) {
      expect(head.trees.length).toBeGreaterThan(0);
    }
  });

  it("holds no string long enough to be prompt text", () => {
    // The only long string in the asset is the base64 projection, and it decodes
    // to exactly bits x dims int16 values -- numbers, not words.
    const strings: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "string") strings.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    const { svd, ...rest } = BASE_TEXT_HEAD_ASSET as unknown as Record<string, unknown>;
    walk(rest);
    walk({ ...(svd as Record<string, unknown>), data: undefined });
    for (const value of strings) {
      expect(value.length).toBeLessThanOrEqual(fixture.longestPromptChars);
      expect(value).not.toMatch(/\s\s/);
    }
    const projection = (svd as { data?: string }).data;
    if (projection !== undefined) {
      expect(projection).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    }
  });
});

describe("the monotone clamp", () => {
  /** A three-bucket asset whose ensembles are deliberately out of order. */
  function assetWithBaselines(baselines: [number, number, number]): BaseTextHeadAsset {
    return {
      version: "test",
      dataset: "test",
      trainingRows: 0,
      bits: 3,
      dims: 2,
      truncateChars: 2000,
      svd: {
        encoding: "int16-rows",
        layout: "bucket-major",
        scale: 1e-4,
        rows: Array.from({ length: 8 }, (_, index) => [index, -index]),
      },
      heads: baselines.map((baseline, index) => ({
        quantile: [0.5, 0.9, 0.99][index] as number,
        baseline,
        trees: [{ value: 0 }],
      })),
    };
  }

  it("raises p90 and p99 rather than reporting an inverted interval", () => {
    const head = createBaseTextHead(assetWithBaselines([5, 2, 1]));
    expect(head("anything at all")).toEqual([5, 5, 5]);
  });

  it("leaves an already ordered triple alone", () => {
    const head = createBaseTextHead(assetWithBaselines([1, 2, 3]));
    expect(head("anything at all")).toEqual([1, 2, 3]);
  });

  it("clamps p99 up to p90 only", () => {
    const head = createBaseTextHead(assetWithBaselines([1, 4, 2]));
    expect(head("anything at all")).toEqual([1, 4, 4]);
  });
});
