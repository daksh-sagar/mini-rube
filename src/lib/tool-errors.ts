export type ToolErrorCategory =
  | "payload_too_large"
  | "rate_limited"
  | "auth"
  | "server"
  | "not_found"
  | "bad_request"
  | "unknown";

export type NormalizedToolError = {
  message: string;
  category: ToolErrorCategory;
  retryable: boolean;
  status?: number;
  code?: string | number;
  slug?: string;
  requestId?: string;
  suggestedFix?: string;
};

export function normalizeToolError(error: unknown): NormalizedToolError {
  const status = findNumber(error, ["status", "statusCode", "status_code"]);
  const nestedError = findRecord(error, ["error"]);
  const errorPayload = findRecord(nestedError, ["error"]) ?? nestedError;
  const code = findStringOrNumber(errorPayload, ["code"]) ?? findStringOrNumber(error, ["code"]);
  const slug = findString(errorPayload, ["slug"]) ?? findString(error, ["slug"]);
  const requestId =
    findString(errorPayload, ["request_id", "requestId"]) ??
    findHeader(error, "x-request-id") ??
    findString(error, ["request_id", "requestId"]);
  const rawSuggestedFix =
    findString(errorPayload, ["suggested_fix", "suggestedFix"]) ??
    findString(error, ["suggested_fix", "suggestedFix"]);
  const message =
    findString(errorPayload, ["message"]) ??
    findString(error, ["message"]) ??
    safeString(error, 500) ??
    "Tool execution failed.";
  const category = categorizeError(status, code, slug, message);
  const suggestedFix = rawSuggestedFix ?? defaultSuggestedFix(category);

  return {
    message,
    category,
    retryable: isRetryable(category),
    status,
    code,
    slug,
    requestId,
    suggestedFix,
  };
}

export function toolErrorForModel(error: NormalizedToolError) {
  return {
    error: true,
    message: error.message,
    category: error.category,
    retryable: error.retryable,
    status: error.status,
    code: error.code,
    requestId: error.requestId,
    suggestedFix: error.suggestedFix,
  };
}

function categorizeError(
  status: number | undefined,
  code: string | number | undefined,
  slug: string | undefined,
  message: string
): ToolErrorCategory {
  const haystack = `${code ?? ""} ${slug ?? ""} ${message}`.toLowerCase();

  if (status === 413 || haystack.includes("payloadtoolarge") || haystack.includes("payload too large")) {
    return "payload_too_large";
  }
  if (status === 429 || haystack.includes("rate")) {
    return "rate_limited";
  }
  if (
    status === 401 ||
    status === 403 ||
    /auth|unauthorized|forbidden|reconnect|permission|scope|access[_ -]?denied|consent/.test(haystack)
  ) {
    return "auth";
  }
  if (status === 404 || haystack.includes("not found")) {
    return "not_found";
  }
  if (status && status >= 500) {
    return "server";
  }
  if (status && status >= 400) {
    return "bad_request";
  }
  return "unknown";
}

function isRetryable(category: ToolErrorCategory) {
  return category === "payload_too_large" || category === "rate_limited" || category === "server";
}

function defaultSuggestedFix(category: ToolErrorCategory) {
  if (category === "auth") {
    return "Reconnect the relevant account from the app header and grant the requested permissions, then try again.";
  }
  return undefined;
}

function findRecord(value: unknown, keys: string[]): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (isRecord(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function findString(value: unknown, keys: string[]): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  return undefined;
}

function findNumber(value: unknown, keys: string[]): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number") {
      return candidate;
    }
  }

  return undefined;
}

function findStringOrNumber(value: unknown, keys: string[]) {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = value[key];
    if ((typeof candidate === "string" && candidate.trim()) || typeof candidate === "number") {
      return candidate;
    }
  }

  return undefined;
}

function findHeader(value: unknown, headerName: string) {
  if (!isRecord(value) || !isHeadersLike(value.headers)) {
    return undefined;
  }
  return value.headers.get(headerName) ?? undefined;
}

function isHeadersLike(value: unknown): value is Pick<Headers, "get"> {
  return typeof value === "object" && value !== null && typeof (value as Headers).get === "function";
}

function safeString(value: unknown, maxLength: number) {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string") {
    return value.length > maxLength ? safePreview(value, maxLength) : value;
  }

  try {
    const text = JSON.stringify(value);
    return text.length > maxLength ? safePreview(text, maxLength) : text;
  } catch {
    const text = String(value);
    return text.length > maxLength ? safePreview(text, maxLength) : text;
  }
}

function safePreview(text: string, maxLength: number) {
  const sliced = text.slice(0, maxLength);
  const boundary = Math.max(
    sliced.lastIndexOf("\n"),
    sliced.lastIndexOf("},"),
    sliced.lastIndexOf("],"),
    sliced.lastIndexOf(","),
    sliced.lastIndexOf(" "),
    sliced.lastIndexOf(".")
  );
  return `${sliced.slice(0, boundary > maxLength * 0.7 ? boundary + 1 : maxLength).trimEnd()}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
