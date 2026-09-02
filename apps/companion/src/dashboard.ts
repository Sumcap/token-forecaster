import type {
  PersonalEvaluation,
  PersonalProfile,
  SufficiencyReport,
} from "@token-forecaster/personal";

import { renderPage, type PageData } from "./ui/pages.js";
import { PAGES, type PageSlug } from "./ui/shell.js";

export { PAGES, SECTIONS } from "./ui/shell.js";
export type { PageSlug } from "./ui/shell.js";
export type { PageData } from "./ui/pages.js";

/** True when `slug` names a real page. */
export function isPageSlug(slug: string): slug is PageSlug {
  return PAGES.some((page) => page.slug === slug);
}

/**
 * Render one dashboard page.
 *
 * The dashboard is one scrolling page with an in-page section rail:
 * server-rendered SVG charts, no script and no remote resource, so the strict
 * content policy on the response holds. Every chart is backed by a table so no
 * value is reachable only by hovering.
 */
export function dashboardHtml(options: {
  slug: PageSlug;
  token: string;
  health: Record<string, unknown>;
  evaluation: PersonalEvaluation | null;
  profile: PersonalProfile | null;
  sufficiency: SufficiencyReport | null;
  weekly: { week: string; provider: string; count: number }[];
}): string {
  const data: PageData = {
    health: options.health,
    profile: options.profile,
    evaluation: options.evaluation,
    sufficiency: options.sufficiency,
    weekly: options.weekly,
    token: options.token,
  };
  return renderPage(options.slug, data);
}
