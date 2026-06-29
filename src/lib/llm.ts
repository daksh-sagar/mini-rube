import { createOpenAI } from "@ai-sdk/openai";
import { generateText, type CoreMessage } from "ai";

// Per-role defaults chosen from a head-to-head eval (see README + memory).
// - AGENT: claude-haiku-4.5 (~200k ctx, well under the brief's 500k ceiling) won on
//   quality + safety (only model that refused a "delete all my emails" prompt
//   safely); accepts Composio tool schemas as-is.
// - PLANNER/EXTRACTOR: deepseek-v4-flash — extremely cheap and produces clean JSON
//   for these narrow tasks (matched deepseek-v3/kimi extraction in the eval). Its
//   context window is ~1M, ABOVE the brief's 500k guideline, but we use it only for
//   bounded inputs (short routing prompts; 8k-char resume slices; capped page
//   reads) — it never ingests a corpus, so the "don't run out of context" intent is
//   honored even though the window is large. (gpt-5-mini is unusable here — OpenAI
//   strict function-schema mode rejects Composio's tool schemas.)
// Every role stays overridable via env for quick A/B without code changes.
const DEFAULT_AGENT_MODEL = "anthropic/claude-haiku-4.5";
const DEFAULT_PLANNER_MODEL = "deepseek/deepseek-v4-flash";
const DEFAULT_EXTRACTOR_MODEL = "deepseek/deepseek-v4-flash";

export const AGENT_MODEL = process.env.AGENT_MODEL ?? DEFAULT_AGENT_MODEL;
export const PLANNER_MODEL = process.env.PLANNER_MODEL ?? DEFAULT_PLANNER_MODEL;
export const EXTRACTOR_MODEL = process.env.EXTRACTOR_MODEL ?? DEFAULT_EXTRACTOR_MODEL;
export const AGENT_MAX_TOKENS = readPositiveInt(process.env.AGENT_MAX_TOKENS, 2048);
export const JSON_MAX_TOKENS = readPositiveInt(process.env.JSON_MAX_TOKENS, 1024);

let openrouterClient: ReturnType<typeof createOpenAI> | null = null;

export function getOpenRouter() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  openrouterClient ??= createOpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey,
  });

  return openrouterClient;
}

export function openrouter(model: string) {
  return getOpenRouter()(model);
}

export function agentModel(model = AGENT_MODEL) {
  return openrouter(model);
}

export function plannerModel(model = PLANNER_MODEL) {
  return openrouter(model);
}

export function extractorModel(model = EXTRACTOR_MODEL) {
  return openrouter(model);
}

export type GenerateJsonOptions<T> = {
  system?: string;
  prompt?: string;
  messages?: CoreMessage[];
  model?: string;
  temperature?: number;
  maxRetries?: number;
  fallback?: T;
};

export async function generateJson<T = unknown>(options: GenerateJsonOptions<T>): Promise<T> {
  const maxRetries = options.maxRetries ?? 1;
  let prompt = options.prompt;
  let messages = options.messages;
  let lastOutput = "";

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const result = await generateText({
      model: agentModel(options.model ?? EXTRACTOR_MODEL),
      system: [
        options.system,
        "Return only valid JSON. Do not wrap it in Markdown or add prose.",
      ]
        .filter(Boolean)
        .join("\n\n"),
      messages: messages ?? [{ role: "user", content: prompt ?? "" }],
      temperature: options.temperature ?? 0,
      maxTokens: JSON_MAX_TOKENS,
    });

    lastOutput = result.text;
    const parsed = parseJsonCandidate<T>(lastOutput);
    if (parsed.ok) {
      return parsed.value;
    }

    prompt = [
      "Repair this model output into strict JSON only.",
      "Do not add commentary or markdown.",
      "",
      lastOutput,
    ].join("\n");
    messages = undefined;
  }

  if ("fallback" in options) {
    return options.fallback as T;
  }

  throw new Error(`Model did not return valid JSON. Output preview: ${lastOutput.trim().slice(0, 300)}`);
}

function readPositiveInt(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const generateStructuredJson = generateJson;

export function parseJsonOrFallback<T>(text: string, fallback: T): T {
  const parsed = parseJsonCandidate<T>(text);
  return parsed.ok ? parsed.value : fallback;
}

export function tryParseJsonFromText<T = unknown>(text: string): T | null {
  const parsed = parseJsonCandidate<T>(text);
  return parsed.ok ? parsed.value : null;
}

export function parseJsonFromText<T = unknown>(text: string): T {
  const parsed = parseJsonCandidate<T>(text);
  if (parsed.ok) {
    return parsed.value;
  }
  throw new Error(`Model did not return valid JSON. Output preview: ${text.trim().slice(0, 300)}`);
}

function parseJsonCandidate<T>(text: string): { ok: true; value: T } | { ok: false } {
  for (const candidate of jsonCandidates(text)) {
    try {
      return { ok: true, value: JSON.parse(candidate) as T };
    } catch {
      // Try the next candidate.
    }
  }

  return { ok: false };
}

function jsonCandidates(text: string) {
  const trimmed = text.trim();
  const candidates: string[] = [];

  pushCandidate(candidates, trimmed);
  pushCandidate(candidates, stripOuterFence(trimmed));

  const fencePattern = /```(?:json|javascript|js)?\s*([\s\S]*?)```/gi;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fencePattern.exec(text))) {
    pushCandidate(candidates, fenceMatch[1]?.trim() ?? "");
  }

  for (const candidate of balancedJsonSlices(text)) {
    pushCandidate(candidates, candidate);
  }

  return candidates;
}

function pushCandidate(candidates: string[], value: string) {
  const cleaned = value.trim().replace(/^\uFEFF/, "");
  if (cleaned && !candidates.includes(cleaned)) {
    candidates.push(cleaned);
  }
}

function stripOuterFence(text: string) {
  return text
    .replace(/^```(?:json|javascript|js)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function balancedJsonSlices(text: string) {
  const slices: string[] = [];

  for (let start = 0; start < text.length; start += 1) {
    const first = text[start];
    if (first !== "{" && first !== "[") {
      continue;
    }

    const stack: string[] = [];
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index += 1) {
      const char = text[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === "{" || char === "[") {
        stack.push(char === "{" ? "}" : "]");
        continue;
      }

      if (char === "}" || char === "]") {
        const expected = stack.pop();
        if (char !== expected) {
          break;
        }
        if (stack.length === 0) {
          slices.push(text.slice(start, index + 1).trim());
          break;
        }
      }
    }
  }

  return slices;
}
