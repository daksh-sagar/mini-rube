import type { NormalizedToolError } from "./tool-errors";

const GMAIL_FETCH_EMAILS_TOOL = "GOOGLESUPER_FETCH_EMAILS";
const COUNT_FIELDS = ["max_results", "maxResults", "limit", "per_page", "page_size", "pageSize"];
const VERBOSITY_FIELDS = [
  "verbose",
  "include_payload",
  "includePayload",
  "full",
  "raw",
  "include_body",
  "includeBody",
  "include_content",
  "includeContent",
  "include_attachments",
  "includeAttachments",
];

// Verbs that signal a write/side-effect. Matched as a WHOLE token anywhere in the
// slug — Google slugs often put the resource first (SPREADSHEETS_VALUES_APPEND,
// SHEET_FROM_JSON), so prefix-only matching silently misses real mutations.
const MUTATING_VERBS = new Set([
  "SEND", "CREATE", "UPDATE", "DELETE", "PATCH", "APPEND", "INSERT", "IMPORT", "MOVE",
  "TRASH", "UNTRASH", "MODIFY", "ADD", "REMOVE", "CLEAR", "REPLY", "FORWARD", "COPY",
  "DUPLICATE", "EDIT", "SET", "WRITE", "UPLOAD", "ARCHIVE", "RENAME", "SHARE", "REVOKE",
  "GRANT", "ENABLE", "DISABLE", "CANCEL", "ACCEPT", "DECLINE", "MERGE", "CLOSE", "REOPEN",
  "LOCK", "UNLOCK", "ASSIGN", "COMMENT", "POST", "PUT", "REPLACE", "DRAFT",
]);

// Verbs that signal a read-only retrieval. NOTE: "BATCH" is intentionally absent —
// it is ambiguous (BATCH_GET is a read, BATCH_UPDATE is a write), so we let the
// neighboring verb decide.
const READ_VERBS = new Set([
  "GET", "LIST", "FETCH", "FIND", "SEARCH", "LOOKUP", "DOWNLOAD", "EXPORT", "QUERY",
  "CHECK", "COMPUTE", "PARSE", "READ", "VIEW", "COUNT", "RETRIEVE", "DESCRIBE",
]);

function actionTokens(slug: string) {
  // Tokenize the whole slug (toolkit prefix included — toolkit names aren't verbs,
  // so they never match). Works for any toolkit, not just GOOGLESUPER/GITHUB.
  return slug.split(/[_]+/).filter(Boolean);
}

// Decide whether a tool mutates state (and therefore needs UI confirmation).
// A write verb anywhere wins; else a read verb means read; else default to MUTATING
// so an unrecognized tool is gated rather than silently executed.
export function isMutatingToolSlug(slug: string) {
  const tokens = actionTokens(slug);
  if (tokens.some((t) => MUTATING_VERBS.has(t))) return true;
  if (tokens.some((t) => READ_VERBS.has(t))) return false;
  return true;
}

export function isCollectionReadTool(slug: string) {
  const action = slug.replace(/^[A-Z0-9]+_/, "");
  return /^(LIST|FETCH|SEARCH|FIND|QUERY)/.test(action) && !isMutatingToolSlug(slug);
}

export function isDetailReadTool(slug: string) {
  const action = slug.replace(/^[A-Z0-9]+_/, "");
  return /^(GET|DOWNLOAD|EXPORT|PARSE)/.test(action) && !isMutatingToolSlug(slug);
}

export function normalizeToolArgs(toolSlug: string, args: Record<string, unknown>) {
  if (isMutatingToolSlug(toolSlug)) {
    return { ...args };
  }

  if (!isCollectionReadTool(toolSlug)) {
    return { ...args };
  }

  return reducePayloadArgs(args, 100);
}

export function applyPromptLimitToToolArgs(
  toolSlug: string,
  args: Record<string, unknown>,
  prompt?: string
) {
  if (toolSlug !== GMAIL_FETCH_EMAILS_TOOL) {
    return { ...args };
  }

  const promptLimit = explicitGmailLimit(prompt ?? "");
  if (!promptLimit) {
    return { ...args };
  }

  const countField = COUNT_FIELDS.find((field) => field in args) ?? "max_results";
  return { ...args, [countField]: promptLimit };
}

export function buildRetryArgs(
  toolSlug: string,
  args: Record<string, unknown>,
  error: NormalizedToolError,
  attempt: number
) {
  if (isMutatingToolSlug(toolSlug) || !error.retryable) {
    return null;
  }

  if (error.category === "payload_too_large") {
    return reducePayloadArgs(args, attempt <= 1 ? 25 : 10);
  }

  if (error.category === "server" && attempt <= 1) {
    return { ...args };
  }

  return null;
}

function reducePayloadArgs(args: Record<string, unknown>, safeLimit: number) {
  const next = { ...args };

  for (const field of COUNT_FIELDS) {
    if (field in next) {
      const current = toPositiveInt(next[field], safeLimit);
      next[field] = Math.min(current, safeLimit);
    }
  }

  if (!COUNT_FIELDS.some((field) => field in next)) {
    next.limit = safeLimit;
  }

  for (const field of VERBOSITY_FIELDS) {
    if (field in next || field === "verbose" || field === "include_payload") {
      next[field] = false;
    }
  }

  return next;
}

function toPositiveInt(value: unknown, fallback: number) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function explicitGmailLimit(prompt: string) {
  const lower = prompt.toLowerCase();
  if (!/\b(?:email|emails|gmail|inbox|message|messages)\b/.test(lower)) {
    return undefined;
  }

  const patterns = [
    /\b(?:last|latest|recent|newest|top|first|oldest|earliest)\s+(\d{1,4})\s+(?:gmail\s+)?(?:emails?|messages?)\b/,
    /\b(\d{1,4})\s+(?:most\s+recent|recent|latest|newest|last|oldest|earliest|top|first)\s+(?:gmail\s+)?(?:emails?|messages?)\b/,
    /\b(?:read|fetch|get|list|show|scan|summari[sz]e)\s+(?:the\s+)?(?:(?:exactly|only|just|up to|at most|no more than|limit(?:ed)? to|last|latest|recent|newest|top|first)\s+)?(\d{1,4})\s+(?:gmail\s+)?(?:emails?|messages?)\b/,
    /\b(\d{1,4})\s+(?:gmail\s+)?(?:emails?|messages?)\b/,
    /\b(?:emails?|messages?|gmail|inbox)\b.{0,40}\blimit(?:ed)?(?:\s+to)?\s+(\d{1,4})\b/,
  ];

  for (const pattern of patterns) {
    const match = lower.match(pattern);
    if (match) {
      const limit = toPositiveInt(match[1], 0);
      if (limit > 0) {
        return limit;
      }
    }
  }

  return undefined;
}
