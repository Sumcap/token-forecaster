/**
 * Everything this extension reads out of claude.ai's DOM.
 *
 * Every read is a ladder of selectors that ends in a structural heuristic, so
 * a renamed class degrades one field instead of killing the chip. Nothing here
 * writes to the page and nothing here touches claude.ai's network or cookies.
 */
import { estimateTokensFromText } from "@token-forecaster/token-counter";

const BLOCK_TAGS = new Set(["P", "DIV", "LI", "BLOCKQUOTE", "PRE", "H1", "H2", "H3"]);

/** Text of a contenteditable, with block boundaries turned into newlines. */
export function textFromEditable(node: Node): string {
  let out = "";
  const walk = (current: Node, depth: number): void => {
    if (current.nodeType === 3 /* Node.TEXT_NODE */) {
      const text = current.nodeValue ?? "";
      // Indentation between block tags is markup, not typed text. Typed
      // whitespace inside the editor never carries a newline.
      if (text.trim().length === 0 && text.includes("\n")) return;
      out += text;
      return;
    }
    if (current.nodeType !== 1 /* Node.ELEMENT_NODE */) return;
    const element = current as Element;
    if (element.tagName === "BR") {
      out += "\n";
      return;
    }
    const isBlock = depth > 0 && BLOCK_TAGS.has(element.tagName);
    if (isBlock && out.length > 0 && !out.endsWith("\n")) out += "\n";
    for (const child of Array.from(element.childNodes)) walk(child, depth + 1);
    if (isBlock && out.length > 0 && !out.endsWith("\n")) out += "\n";
  };
  walk(node, 0);
  // ProseMirror keeps a zero-width placeholder in an empty paragraph.
  return out.replace(/\u200b/g, "").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function area(element: Element): number {
  const rect = element.getBoundingClientRect?.();
  if (rect === undefined) return 0;
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

/**
 * Find the composer. Rung 1 is ProseMirror's own class, which belongs to the
 * editor library rather than to claude.ai and has outlived several redesigns.
 */
export function findComposer(root: ParentNode = document): HTMLElement | null {
  const ladder = [
    'div.ProseMirror[contenteditable="true"]',
    '[data-testid="chat-input"] [contenteditable="true"]',
    'fieldset [contenteditable="true"]',
    '[contenteditable="true"][aria-label]',
  ];
  for (const selector of ladder) {
    const found = root.querySelector<HTMLElement>(selector);
    if (found !== null) return found;
  }
  // Last rung: the biggest editable box on the page, which is the composer on
  // every layout claude.ai has shipped. Falls back to document order when no
  // element reports a size (a detached document, or a test fixture).
  const editables = Array.from(root.querySelectorAll<HTMLElement>('[contenteditable="true"]'));
  if (editables.length === 0) return null;
  const sized = editables.filter((element) => area(element) > 0);
  const pool = sized.length > 0 ? sized : editables;
  return pool.reduce((best, element) => (area(element) > area(best) ? element : best));
}

const MODEL_NAME = /\b(?:claude\s+)?(fable|opus|sonnet|haiku)\s*[\d.]*/i;

/** The model name claude.ai currently shows, or null when it cannot be read. */
export function findModelLabel(root: ParentNode = document): string | null {
  const direct = root.querySelector<HTMLElement>('[data-testid="model-selector-dropdown"]');
  const directText = direct?.textContent?.trim();
  if (directText !== undefined && directText.length > 0) return directText;

  const buttons = Array.from(root.querySelectorAll<HTMLElement>("button, [role='button']"));
  for (const button of buttons) {
    const text = button.textContent?.trim() ?? "";
    if (text.length === 0 || text.length > 40) continue;
    const match = MODEL_NAME.exec(text);
    if (match !== null) return match[0].trim();
  }
  return null;
}

const EFFORT_WORD = /\b(off|none|standard|normal|instant|low|medium|high|max|maximum|extended|thinking)\b/i;

/**
 * The effort or thinking level claude.ai currently shows, e.g. "High". It sits
 * next to the model picker, sometimes inside the very same button, so the
 * model selector is searched before the page at large.
 */
export function findEffortLabel(root: ParentNode = document): string | null {
  const direct = root.querySelector<HTMLElement>(
    '[data-testid="thinking-toggle"], [data-testid="effort-selector"], [data-testid="reasoning-effort-selector"]',
  );
  const directText = direct?.textContent?.trim();
  if (directText !== undefined && directText.length > 0) {
    // "Thinking: Max" puts the label first and the level last, so the last
    // match is the value in every phrasing seen so far.
    const words = [...directText.matchAll(new RegExp(EFFORT_WORD, "gi"))];
    const last = words.at(-1);
    return last === undefined ? directText : last[0];
  }

  const selector = root.querySelector<HTMLElement>('[data-testid="model-selector-dropdown"]');
  const selectorText = selector?.textContent ?? "";
  // "Opus 5 High": the model name is stripped first so a version number or a
  // family name can never be read as an effort level.
  const withoutModel = selectorText.replace(/\b(?:claude\s+)?(fable|opus|sonnet|haiku)\s*[\d.]*/gi, " ");
  const inSelector = EFFORT_WORD.exec(withoutModel);
  if (inSelector !== null) return inSelector[0];

  const buttons = Array.from(root.querySelectorAll<HTMLElement>("button, [role='button']"));
  for (const button of buttons) {
    const text = button.textContent?.trim() ?? "";
    if (text.length === 0 || text.length > 20) continue;
    if (EFFORT_WORD.test(text) && /^[a-z\s]+$/i.test(text)) return text;
  }
  return null;
}

/**
 * Whether the composer carries an attachment that reads as an image. A false
 * here is a real observation (the composer is visible and holds no image), not
 * a stand-in for "unknown".
 */
export function hasImageAttachment(root: ParentNode = document): boolean {
  const scope =
    root.querySelector('[data-testid="chat-input-container"]') ??
    root.querySelector("fieldset") ??
    root;
  if (scope.querySelector('[data-testid="file-thumbnail"], [data-testid="image-preview"]') !== null) {
    return true;
  }
  const images = Array.from(scope.querySelectorAll<HTMLImageElement>("img"));
  return images.some((image) => {
    const source = image.getAttribute("src") ?? "";
    return source.startsWith("blob:") || source.startsWith("data:image");
  });
}

/**
 * Assistant replies already rendered, which is the request's zero-based
 * session position. Cheap enough to run on every DOM tick: it never reads
 * message text.
 */
export function countAssistantMessages(root: ParentNode = document): number {
  return findAssistantMessages(root).length;
}

/** Assistant replies in document order, newest last. */
export function findAssistantMessages(root: ParentNode = document): Element[] {
  const explicit = Array.from(root.querySelectorAll('[data-testid="assistant-message"]'));
  if (explicit.length > 0) return explicit;
  return Array.from(root.querySelectorAll(".font-claude-message, .font-claude-response"));
}

const THINKING_BLOCK =
  '[data-testid="thinking-block"], [data-testid="thinking-panel"], [data-testid="reasoning-block"], [data-testid="assistant-thinking"]';

/**
 * The header claude.ai puts on a thinking block, collapsed or expanded. The
 * summary sentence it sometimes writes there is generated per reply, so only
 * the fixed wordings are matched.
 */
const THINKING_HEADER =
  /^(?:show|hide)\s+thinking$|^thought\s+process$|^thinking(?:\s*(?:\.\.\.|\u2026))?$|^(?:thought|thinking|reasoned|pondered)\s+for\s+/i;

function hasThinkingBlock(message: Element): boolean {
  if (message.querySelector(THINKING_BLOCK) !== null) return true;
  const controls = Array.from(
    message.querySelectorAll<HTMLElement>('button, summary, [role="button"]'),
  );
  return controls.some((control) => THINKING_HEADER.test((control.textContent ?? "").trim()));
}

/**
 * Whether extended thinking was on for the newest reply on the page: true when
 * that reply carries a thinking block, false when it carries none, null when
 * there is no reply to read.
 *
 * Only the newest reply is read, so turning thinking off mid-conversation is
 * picked up on the very next reply instead of being outvoted by the history.
 * A false here is therefore a real observation of the current state; if
 * claude.ai renames the block, this rung reads "off" for a thinking session,
 * which is why the effort control is asked first and the user can override.
 */
export function findThinkingEvidence(root: ParentNode = document): boolean | null {
  const messages = findAssistantMessages(root);
  const latest = messages.at(-1);
  if (latest === undefined) return null;
  return hasThinkingBlock(latest);
}

/**
 * Ladder for "a reply is being written right now".
 *
 * Rung 1 is claude.ai's own streaming flag on the message container, which is
 * the only signal that is true for the whole stream and false the instant it
 * ends. Rung 2 and 3 are the stop control, which replaces the send button for
 * the duration of the turn: an aria-label match is loose on purpose, because
 * the control is the last thing a redesign leaves unlabelled.
 *
 * Every rung can go quiet on a redesign, so the tracker also treats growth in
 * the reply as evidence of a running turn; this function is the fast path, not
 * the only one.
 */
const STREAMING = [
  '[data-is-streaming="true"]',
  '[data-testid="stop-button"]',
  'button[aria-label*="stop response" i]',
  'button[aria-label*="stop generating" i]',
];

export function isGenerating(root: ParentNode = document): boolean {
  return STREAMING.some((selector) => root.querySelector(selector) !== null);
}

/**
 * Estimated tokens of a set of message nodes.
 *
 * On `/code` an assistant message renders tool calls and their results inside
 * the same block, so this is the text of the turn rather than the model's
 * output alone. Every surface that shows the number says it is an estimate off
 * the rendered text; nothing here pretends to be the API's count.
 */
export function tokensOfMessages(messages: readonly Element[]): number {
  let tokens = 0;
  for (const message of messages) tokens += estimateTokensFromText(message.textContent ?? "");
  return tokens;
}

export interface TranscriptReading {
  /** Character-heuristic tokens of every message this page renders. */
  tokens: number;
  /** Assistant replies already on screen: the zero-based session position. */
  assistantMessages: number;
  /** Number of message nodes found. Zero means "nothing readable". */
  messages: number;
}

const MESSAGE_SELECTORS = [
  '[data-testid="user-message"]',
  '[data-testid="assistant-message"]',
  ".font-claude-message",
  ".font-claude-response",
];

/**
 * Read the visible conversation. This is a LOWER BOUND on the request input:
 * it cannot see the system prompt, tool definitions, project instructions,
 * memory, attachment contents, or anything claude.ai has virtualized out of
 * the DOM.
 */
export function readTranscript(root: ParentNode = document): TranscriptReading {
  const nodes = new Set<Element>();
  for (const selector of MESSAGE_SELECTORS) {
    for (const node of Array.from(root.querySelectorAll(selector))) nodes.add(node);
  }
  let tokens = 0;
  let assistantMessages = 0;
  for (const node of nodes) {
    // Skip a node nested inside another match; it is already counted.
    let parent = node.parentElement;
    let nested = false;
    while (parent !== null) {
      if (nodes.has(parent)) {
        nested = true;
        break;
      }
      parent = parent.parentElement;
    }
    if (nested) continue;
    tokens += estimateTokensFromText(node.textContent ?? "");
    const isUser = node.matches('[data-testid="user-message"]');
    if (!isUser) assistantMessages += 1;
  }
  return { tokens, assistantMessages, messages: nodes.size };
}
