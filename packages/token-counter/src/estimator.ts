/**
 * Deliberately simple local estimate. It exists so the UI can move while the
 * user types; it is never authoritative and is always labelled
 * "character_heuristic". The Anthropic count_tokens API replaces it after a
 * debounce.
 *
 * Heuristic: English-ish prose averages roughly 4 characters per token on
 * Claude tokenizers; code and non-Latin text run denser (more tokens per
 * character). We count characters, weight non-ASCII characters higher, and
 * add a small per-message structural overhead.
 */

export interface EstimatableRequest {
  system?: string;
  messages: Array<{ role: string; content: string }>;
  /** Tool definitions, counted via their JSON serialization. */
  tools?: unknown[];
}

const CHARS_PER_TOKEN = 4;
const NON_ASCII_CHARS_PER_TOKEN = 1.8;
const PER_MESSAGE_OVERHEAD_TOKENS = 5;
const BASE_OVERHEAD_TOKENS = 3;

export function estimateTokensFromText(text: string): number {
  if (text.length === 0) return 0;
  let ascii = 0;
  let nonAscii = 0;
  for (const ch of text) {
    if (ch.codePointAt(0)! < 128) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / CHARS_PER_TOKEN + nonAscii / NON_ASCII_CHARS_PER_TOKEN);
}

/**
 * Estimate the full composed request, matching what count_tokens would see:
 * system prompt, all messages, and tool definitions. Recalculates everything
 * on each call; no incremental tokenization in the MVP.
 */
export function estimateRequestTokens(request: EstimatableRequest): number {
  let tokens = BASE_OVERHEAD_TOKENS;
  if (request.system) tokens += estimateTokensFromText(request.system);
  for (const message of request.messages) {
    tokens += PER_MESSAGE_OVERHEAD_TOKENS + estimateTokensFromText(message.content);
  }
  if (request.tools && request.tools.length > 0) {
    tokens += estimateTokensFromText(JSON.stringify(request.tools));
  }
  return tokens;
}
