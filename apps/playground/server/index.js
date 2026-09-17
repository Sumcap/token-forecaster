/**
 * Local playground server. Owns the Anthropic API key; the browser never
 * sees it. Exposes exactly one route in Phase 1/2:
 *
 *   POST /api/count-tokens
 *     { model, system?, messages, tools? } -> { tokens, quality, countedAt }
 *
 * Run `pnpm build` first (this imports the built workspace packages), then
 * `pnpm dev:server`. Credentials resolve from the environment
 * (ANTHROPIC_API_KEY or an `ant auth login` profile).
 */
import express from "express";
import { createAnthropicTokenService } from "@token-forecaster/anthropic";
import { requireModel, UnknownModelError } from "@token-forecaster/model-registry";

const PORT = Number(process.env.PORT ?? 8765);
const app = express();
app.use(express.json({ limit: "10mb" }));

const service = createAnthropicTokenService();

app.post("/api/count-tokens", async (req, res) => {
  const { model, system, messages, tools } = req.body ?? {};
  if (typeof model !== "string" || !Array.isArray(messages)) {
    res.status(400).json({ error: "body must include model (string) and messages (array)" });
    return;
  }
  if (messages.length === 0) {
    res.status(400).json({ error: "messages must not be empty" });
    return;
  }
  try {
    requireModel(model);
  } catch (error) {
    if (error instanceof UnknownModelError) {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }

  try {
    const count = await service.countInputTokens({
      model,
      system,
      messages,
      tools,
      maxTokens: 1,
    });
    res.json(count);
  } catch (error) {
    // Never echo request bodies or credentials into logs or responses.
    const message = error instanceof Error ? error.message : "count_tokens failed";
    const status = typeof error?.status === "number" ? error.status : 502;
    console.error(`[count-tokens] ${status}: ${message}`);
    res.status(status >= 400 && status < 600 ? status : 502).json({ error: message });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`token-forecaster playground server on http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(
      "note: ANTHROPIC_API_KEY is not set; the SDK will fall back to an `ant auth login` profile if one exists",
    );
  }
});
