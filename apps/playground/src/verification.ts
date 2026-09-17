const DEFAULT_TIMEOUT_MS = 20_000;

interface VerificationRequest {
  model: string;
  system?: string;
  messages: unknown[];
}

interface VerificationOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

async function responseError(response: Response): Promise<string | null> {
  const text = await response.text();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : null;
  } catch {
    return text.slice(0, 240);
  }
}

/**
 * Ask the local server for an Anthropic-authoritative input count.
 * A deadline prevents a slow or disconnected server from leaving the browser
 * in a permanent "verifying" state.
 */
export async function requestVerifiedInputTokens(
  request: VerificationRequest,
  options: VerificationOptions = {},
): Promise<number> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl("/api/count-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await responseError(response);
      if (detail) {
        throw new Error(`Token verification failed (${response.status}): ${detail}`);
      }
      throw new Error(
        `Count server failed (${response.status}). Check that \`pnpm dev:server\` is running.`,
      );
    }

    const body = (await response.json()) as { tokens?: unknown };
    if (!Number.isInteger(body.tokens) || Number(body.tokens) < 0) {
      throw new Error("Count server returned an invalid token count.");
    }
    return Number(body.tokens);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `Provider verification timed out after ${Math.round(timeoutMs / 1_000)} seconds.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
