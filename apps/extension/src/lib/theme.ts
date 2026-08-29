/**
 * Which palette the chip should wear.
 *
 * claude.ai has its own light/dark switch, so `prefers-color-scheme` is only
 * the fallback: the page's own background is the authority when it can be
 * read, otherwise a chip in the wrong palette sits on top of the app.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Parse the `rgb()` / `rgba()` form that getComputedStyle returns. */
export function parseCssColor(value: string): Rgb | null {
  const match = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.%]+))?\s*\)/.exec(
    value,
  );
  if (match === null) return null;
  const alphaText = match[4];
  const alpha =
    alphaText === undefined
      ? 1
      : alphaText.endsWith("%")
        ? Number(alphaText.slice(0, -1)) / 100
        : Number(alphaText);
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
    a: Number.isFinite(alpha) ? alpha : 1,
  };
}

/** Relative luminance, 0 (black) to 1 (white). */
export function luminance(color: Rgb): number {
  return (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;
}

export function isDarkColor(value: string): boolean | null {
  const color = parseCssColor(value);
  // A transparent background says nothing about the page behind it.
  if (color === null || color.a < 0.5) return null;
  return luminance(color) < 0.5;
}

/** Read the page's palette, falling back to the operating system's. */
export function detectDarkPage(view: Window = window): boolean {
  const doc = view.document;
  for (const element of [doc.body, doc.documentElement]) {
    if (element === null) continue;
    const dark = isDarkColor(view.getComputedStyle(element).backgroundColor);
    if (dark !== null) return dark;
  }
  return view.matchMedia("(prefers-color-scheme: dark)").matches;
}
