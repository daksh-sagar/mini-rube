const GMAIL_FETCH_EMAILS_TOOL = "GOOGLESUPER_FETCH_EMAILS";
const DEFAULT_COLLECTION_LIMIT = 100;
const COUNT_FIELDS = ["max_results", "maxResults", "limit", "per_page", "page_size", "pageSize"];
const TOKEN_FIELDS = ["pageToken", "page_token", "nextPageToken", "next_page_token", "cursor"];
const NEXT_TOKEN_FIELDS = [
  "nextPageToken",
  "next_page_token",
  "nextCursor",
  "next_cursor",
  "next",
];

type CollectionPath = Array<string | number>;

type CollectionMatch = {
  path: CollectionPath;
  items: Record<string, unknown>[];
  score: number;
};

export async function maybePaginateCollectionRead(
  toolSlug: string,
  initialArgs: Record<string, unknown>,
  initialResult: unknown,
  executePage: (args: Record<string, unknown>) => Promise<unknown>,
  options: { maxPages?: number; maxItems?: number } = {}
) {
  if (toolSlug !== GMAIL_FETCH_EMAILS_TOOL) {
    return initialResult;
  }

  const requested = Math.min(
    requestedCollectionCount(initialArgs),
    options.maxItems ?? DEFAULT_COLLECTION_LIMIT
  );
  if (requested <= 0) {
    return initialResult;
  }

  const firstCollection = findBestCollection(initialResult);
  if (!firstCollection || firstCollection.items.length >= requested) {
    return initialResult;
  }

  let nextToken = findNextPageToken(initialResult);
  if (!nextToken) {
    return initialResult;
  }

  const mergedResult = cloneJson(initialResult);
  const mergedCollection = getCollectionAtPath(mergedResult, firstCollection.path);
  if (!mergedCollection) {
    return initialResult;
  }

  const seenTokens = new Set<string>();
  const maxPages = options.maxPages ?? 8;
  let page = 1;

  while (nextToken && mergedCollection.length < requested && page < maxPages) {
    if (seenTokens.has(nextToken.value)) break;
    seenTokens.add(nextToken.value);

    const remaining = requested - mergedCollection.length;
    const nextArgs = argsForNextPage(initialArgs, nextToken, remaining);
    let nextResult: unknown;
    try {
      nextResult = await executePage(nextArgs);
    } catch {
      break;
    }
    const nextCollection = findBestCollection(nextResult);
    if (!nextCollection || nextCollection.items.length === 0) break;

    mergedCollection.push(...nextCollection.items.slice(0, remaining));
    nextToken = findNextPageToken(nextResult);
    page += 1;
  }

  return mergedResult;
}

export function requestedCollectionCount(args: Record<string, unknown>) {
  for (const field of COUNT_FIELDS) {
    const parsed = toPositiveInt(args[field]);
    if (parsed != null) return Math.min(parsed, DEFAULT_COLLECTION_LIMIT);
  }
  return DEFAULT_COLLECTION_LIMIT;
}

function argsForNextPage(
  args: Record<string, unknown>,
  nextToken: { key: string; value: string },
  remaining: number
) {
  const next = { ...args };
  const tokenField = TOKEN_FIELDS.find((field) => field in next) ?? requestTokenField(nextToken.key);
  next[tokenField] = nextToken.value;

  const countField = COUNT_FIELDS.find((field) => field in next);
  if (countField) {
    next[countField] = Math.max(1, Math.min(remaining, requestedCollectionCount(args)));
  }

  return next;
}

function requestTokenField(responseTokenField: string) {
  if (responseTokenField === "next_page_token") return "page_token";
  if (responseTokenField === "nextCursor" || responseTokenField === "next_cursor") return "cursor";
  if (responseTokenField === "next") return "cursor";
  return "pageToken";
}

function findBestCollection(value: unknown): CollectionMatch | undefined {
  const candidates: CollectionMatch[] = [];

  function visit(node: unknown, depth: number, path: CollectionPath) {
    if (depth > 6 || node == null) return;

    if (Array.isArray(node)) {
      const records = node.filter(isRecord);
      if (records.length >= 2 && records.length >= node.length * 0.6) {
        candidates.push({
          path,
          items: records,
          score: records.length * 10 - depth,
        });
      }
      node.slice(0, 20).forEach((item, index) => visit(item, depth + 1, [...path, index]));
      return;
    }

    if (isRecord(node)) {
      for (const [key, item] of Object.entries(node)) {
        visit(item, depth + 1, [...path, key]);
      }
    }
  }

  visit(value, 0, []);
  return candidates.sort((a, b) => b.score - a.score)[0];
}

function getCollectionAtPath(value: unknown, path: CollectionPath) {
  let current = value;
  for (const part of path) {
    if (Array.isArray(current) && typeof part === "number") {
      current = current[part];
    } else if (isRecord(current) && typeof part === "string") {
      current = current[part];
    } else {
      return null;
    }
  }

  if (!Array.isArray(current)) return null;
  return current as unknown[];
}

function findNextPageToken(value: unknown) {
  const found = findScalarByKey(value, new Set(NEXT_TOKEN_FIELDS), 0);
  if (!found || typeof found.value !== "string" || !found.value.trim()) return null;
  return { key: found.key, value: found.value.trim() };
}

function findScalarByKey(
  value: unknown,
  keys: Set<string>,
  depth: number
): { key: string; value: string | number | boolean } | undefined {
  if (depth > 5 || value == null) return undefined;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) {
      const found = findScalarByKey(item, keys, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;

  for (const [key, item] of Object.entries(value)) {
    if (keys.has(key) && isScalar(item) && String(item).trim()) return { key, value: item };
  }
  for (const item of Object.values(value)) {
    const found = findScalarByKey(item, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function cloneJson(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isScalar(value: unknown): value is string | number | boolean {
  return ["string", "number", "boolean"].includes(typeof value);
}

function toPositiveInt(value: unknown) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
