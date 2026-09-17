/**
 * Map what claude.ai's model picker displays onto a model id the registry
 * knows.
 *
 * The table is derived from `listModels()` at runtime instead of being kept by
 * hand: a second copy of the model list is a second thing to forget to update,
 * and this file must never be the reason a new model looks unknown.
 */
import { DEFAULT_MODEL_ID, getModel, listModels } from "@token-forecaster/model-registry";

export type ModelFamily = "fable" | "opus" | "sonnet" | "haiku";

const FAMILY_PATTERN = /\b(fable|opus|sonnet|haiku)\b/;
const VERSION_PATTERN = /\b(\d+(?:\.\d+)?)\b/;

export interface ParsedModelName {
  family: ModelFamily;
  /** Numeric version, e.g. 4.6. Undefined when the label carries no number. */
  version?: number;
}

/** Pull the family and version out of a display name or a model id. */
export function parseModelName(label: string): ParsedModelName | null {
  const lower = label.toLowerCase();
  const family = FAMILY_PATTERN.exec(lower);
  if (family === null) return null;
  // "claude-sonnet-4-6" writes its version with dashes; "Claude Sonnet 4.6"
  // with a dot. Normalize the id form before looking for a number.
  const normalized = lower.replace(
    /(fable|opus|sonnet|haiku)-(\d+)-(\d+)/,
    (_match, name: string, major: string, minor: string) => `${name} ${major}.${minor}`,
  );
  const version = VERSION_PATTERN.exec(normalized.slice(normalized.indexOf(family[1]!)));
  const parsedFamily = family[1] as ModelFamily;
  if (version === null) return { family: parsedFamily };
  return { family: parsedFamily, version: Number(version[1]) };
}

export type ModelMatchKind = "id" | "exact" | "family" | "none";

export interface ModelMatch {
  /** Always a registry id: `DEFAULT_MODEL_ID` when nothing matched. */
  id: string;
  kind: ModelMatchKind;
}

/**
 * Resolve a picker label such as "Claude Sonnet 4.6" or "Opus 5" to a registry
 * id. An unrecognized label resolves to the default model and says so, because
 * the alternative — `requireModel` on DOM text — throws `UnknownModelError`
 * and would take the chip down every time Anthropic ships a model.
 */
export function matchModelLabel(label: string): ModelMatch {
  const trimmed = label.trim();
  if (trimmed.length === 0) return { id: DEFAULT_MODEL_ID, kind: "none" };
  // Canonical and dated ids both resolve directly through the registry.
  const direct = getModel(trimmed);
  if (direct !== undefined) return { id: direct.id, kind: "id" };

  const wanted = parseModelName(trimmed);
  if (wanted === null) return { id: DEFAULT_MODEL_ID, kind: "none" };

  const candidates = listModels().flatMap((entry) => {
    const parsed = parseModelName(entry.displayName) ?? parseModelName(entry.id);
    return parsed === null || parsed.family !== wanted.family
      ? []
      : [{ id: entry.id, version: parsed.version ?? 0 }];
  });
  if (candidates.length === 0) return { id: DEFAULT_MODEL_ID, kind: "none" };

  if (wanted.version !== undefined) {
    const exact = candidates.find((candidate) => candidate.version === wanted.version);
    if (exact !== undefined) return { id: exact.id, kind: "exact" };
  }
  // Same family, different version: the newest known member of that family is
  // a far better forecast group than a blend across families.
  const newest = candidates.reduce((best, candidate) =>
    candidate.version > best.version ? candidate : best,
  );
  return { id: newest.id, kind: "family" };
}

export type ModelResolution = "override" | "page" | "family" | "assumed";

export interface ResolvedModel {
  id: string;
  resolution: ModelResolution;
  /** What the page said, when the page is where the name came from. */
  pageLabel: string | null;
}

/**
 * Precedence: an explicit override, then the page's picker, then the default.
 * `family` means the page named a model this build has never heard of but the
 * family was recognizable, so a sibling answers instead.
 */
export function resolveModel(
  modelOverride: string,
  pageLabel: string | null,
): ResolvedModel {
  if (modelOverride !== "auto" && getModel(modelOverride) !== undefined) {
    return { id: modelOverride, resolution: "override", pageLabel };
  }
  if (pageLabel !== null && pageLabel.trim().length > 0) {
    const match = matchModelLabel(pageLabel);
    if (match.kind === "id" || match.kind === "exact") {
      return { id: match.id, resolution: "page", pageLabel };
    }
    if (match.kind === "family") {
      return { id: match.id, resolution: "family", pageLabel };
    }
    return { id: match.id, resolution: "assumed", pageLabel };
  }
  return { id: DEFAULT_MODEL_ID, resolution: "assumed", pageLabel };
}
