export type CompactToolResultOptions = {
  maxLength?: number;
  maxItems?: number;
  prompt?: string;
  args?: Record<string, unknown>;
};

type CompactOptions = Required<Pick<CompactToolResultOptions, "maxLength">> &
  Omit<CompactToolResultOptions, "maxLength">;

type CollectionCandidate = {
  path: string;
  items: Record<string, unknown>[];
  score: number;
};

type FieldCandidate = {
  key: string;
  value: string | number | boolean;
  score: number;
};

const DEFAULT_MAX_LENGTH = 16_000;
const COLLECTION_MIN_ITEMS = 8;
const MAX_FIELDS_PER_ITEM = 12;
const MAX_STRING_FIELD_LENGTH = 600;
const GMAIL_FETCH_EMAILS_TOOL = "GOOGLESUPER_FETCH_EMAILS";
const GMAIL_MAX_ITEMS = 100;
const GITHUB_MAX_ITEMS = 100;
const COUNT_FIELDS = ["max_results", "maxResults", "limit", "per_page", "page_size", "pageSize"];

const FIELD_PRIORITY = [
  "id",
  "threadId",
  "messageId",
  "number",
  "title",
  "subject",
  "name",
  "from",
  "to",
  "cc",
  "date",
  "createdAt",
  "updatedAt",
  "state",
  "status",
  "email",
  "sender",
  "recipient",
  "url",
  "htmlUrl",
  "webUrl",
  "snippet",
  "summary",
  "description",
  "filename",
  "mimeType",
  "size",
  "type",
  "body",
  "text",
  "content",
];

const FIELD_PRIORITY_BY_KEY = new Map(FIELD_PRIORITY.map((key, index) => [key, FIELD_PRIORITY.length - index]));

export function compactToolResult(
  toolSlug: string,
  result: unknown,
  optionsOrMaxLength: number | CompactToolResultOptions = DEFAULT_MAX_LENGTH
): unknown {
  const options = normalizeOptions(optionsOrMaxLength);
  const text = stringify(result);
  const collection = findBestCollection(result);

  if (collection && toolSlug === GMAIL_FETCH_EMAILS_TOOL) {
    return compactGmailEmailCollection(toolSlug, collection, options);
  }

  if (collection && isGithubCollectionTool(toolSlug)) {
    return compactGithubIssueCollection(toolSlug, collection, options);
  }

  if (collection && (text.length > options.maxLength || collection.items.length >= COLLECTION_MIN_ITEMS)) {
    return compactCollection(toolSlug, collection, options);
  }

  return compactJson(result, options.maxLength);
}

function normalizeOptions(optionsOrMaxLength: number | CompactToolResultOptions): CompactOptions {
  if (typeof optionsOrMaxLength === "number") {
    return { maxLength: optionsOrMaxLength };
  }

  return {
    ...optionsOrMaxLength,
    maxLength: optionsOrMaxLength.maxLength ?? DEFAULT_MAX_LENGTH,
  };
}

function compactCollection(toolSlug: string, collection: CollectionCandidate, options: CompactOptions) {
  const promptTerms = termSet(options.prompt ?? "");
  const maxItems = Math.min(options.maxItems ?? collection.items.length, collection.items.length);
  let returnedCount = maxItems;
  let compacted = buildCollectionResult(toolSlug, collection, promptTerms, returnedCount);

  while (returnedCount > 1 && stringify(compacted).length > options.maxLength) {
    returnedCount = Math.max(1, Math.floor(returnedCount * 0.75));
    compacted = buildCollectionResult(toolSlug, collection, promptTerms, returnedCount);
  }

  if (stringify(compacted).length > options.maxLength) {
    return compactJson(compacted, options.maxLength);
  }

  return compacted;
}

function compactGmailEmailCollection(
  toolSlug: string,
  collection: CollectionCandidate,
  options: CompactOptions
) {
  const promptTerms = termSet(options.prompt ?? "");
  const requested = requestedItemCount(options, GMAIL_MAX_ITEMS);
  const targetCount = Math.min(
    collection.items.length,
    options.maxItems ?? requested,
    GMAIL_MAX_ITEMS
  );

  let returnedCount = targetCount;
  let snippetLength = 180;
  let includeSnippet = true;
  let includeLabels = true;
  let includeTechnicalIds = true;
  let compacted = buildGmailCollectionResult(
    toolSlug,
    collection,
    promptTerms,
    returnedCount,
    snippetLength,
    includeSnippet,
    includeLabels,
    includeTechnicalIds
  );

  while (stringify(compacted).length > options.maxLength && snippetLength > 80) {
    snippetLength = Math.max(80, Math.floor(snippetLength * 0.7));
    compacted = buildGmailCollectionResult(
      toolSlug,
      collection,
      promptTerms,
      returnedCount,
      snippetLength,
      includeSnippet,
      includeLabels,
      includeTechnicalIds
    );
  }

  if (stringify(compacted).length > options.maxLength) {
    includeLabels = false;
    compacted = buildGmailCollectionResult(
      toolSlug,
      collection,
      promptTerms,
      returnedCount,
      snippetLength,
      includeSnippet,
      includeLabels,
      includeTechnicalIds
    );
  }

  if (stringify(compacted).length > options.maxLength) {
    includeTechnicalIds = false;
    compacted = buildGmailCollectionResult(
      toolSlug,
      collection,
      promptTerms,
      returnedCount,
      snippetLength,
      includeSnippet,
      includeLabels,
      includeTechnicalIds
    );
  }

  if (stringify(compacted).length > options.maxLength) {
    includeSnippet = false;
    compacted = buildGmailCollectionResult(
      toolSlug,
      collection,
      promptTerms,
      returnedCount,
      snippetLength,
      includeSnippet,
      includeLabels,
      includeTechnicalIds
    );
  }

  while (returnedCount > 1 && stringify(compacted).length > options.maxLength) {
    returnedCount = Math.max(1, Math.floor(returnedCount * 0.9));
    compacted = buildGmailCollectionResult(
      toolSlug,
      collection,
      promptTerms,
      returnedCount,
      snippetLength,
      includeSnippet,
      includeLabels,
      includeTechnicalIds
    );
  }

  return stringify(compacted).length > options.maxLength
    ? compactJson(compacted, options.maxLength)
    : compacted;
}

function compactGithubIssueCollection(
  toolSlug: string,
  collection: CollectionCandidate,
  options: CompactOptions
) {
  const promptTerms = termSet(options.prompt ?? "");
  const requested = requestedItemCount(options, GITHUB_MAX_ITEMS);
  const targetCount = Math.min(collection.items.length, options.maxItems ?? requested, GITHUB_MAX_ITEMS);

  let returnedCount = targetCount;
  let bodyLength = 260;
  let includeBody = true;
  let compacted = buildGithubIssueCollectionResult(
    toolSlug,
    collection,
    promptTerms,
    returnedCount,
    bodyLength,
    includeBody
  );

  while (stringify(compacted).length > options.maxLength && bodyLength > 80) {
    bodyLength = Math.max(80, Math.floor(bodyLength * 0.7));
    compacted = buildGithubIssueCollectionResult(
      toolSlug,
      collection,
      promptTerms,
      returnedCount,
      bodyLength,
      includeBody
    );
  }

  if (stringify(compacted).length > options.maxLength) {
    includeBody = false;
    compacted = buildGithubIssueCollectionResult(
      toolSlug,
      collection,
      promptTerms,
      returnedCount,
      bodyLength,
      includeBody
    );
  }

  while (returnedCount > 1 && stringify(compacted).length > options.maxLength) {
    returnedCount = Math.max(1, Math.floor(returnedCount * 0.9));
    compacted = buildGithubIssueCollectionResult(
      toolSlug,
      collection,
      promptTerms,
      returnedCount,
      bodyLength,
      includeBody
    );
  }

  return stringify(compacted).length > options.maxLength
    ? compactJson(compacted, options.maxLength)
    : compacted;
}

function buildGmailCollectionResult(
  toolSlug: string,
  collection: CollectionCandidate,
  promptTerms: Set<string>,
  returnedCount: number,
  snippetLength: number,
  includeSnippet: boolean,
  includeLabels: boolean,
  includeTechnicalIds: boolean
) {
  return {
    resultType: "collection",
    sourceTool: toolSlug,
    path: collection.path,
    itemCount: collection.items.length,
    returnedCount,
    truncated: returnedCount < collection.items.length,
    note:
      returnedCount < collection.items.length
        ? "Gmail messages were compacted by field first; only excess items beyond the requested/safe count were omitted."
        : "Gmail messages were compacted to preserve one item per message while dropping long payload fields.",
    items: collection.items
      .slice(0, returnedCount)
      .map((item, index) =>
        projectGmailMessage(
          item,
          index,
          promptTerms,
          snippetLength,
          includeSnippet,
          includeLabels,
          includeTechnicalIds
        )
      ),
  };
}

function projectGmailMessage(
  record: Record<string, unknown>,
  index: number,
  promptTerms: Set<string>,
  snippetLength: number,
  includeSnippet: boolean,
  includeLabels: boolean,
  includeTechnicalIds: boolean
) {
  const fields = collectFieldCandidates(record, promptTerms);
  const projected: Record<string, string | number | boolean> = { index: index + 1 };

  if (includeTechnicalIds) {
    addProjected(projected, "id", pickField(fields, ["id", "messageId"]), 90);
    addProjected(projected, "threadId", pickField(fields, ["threadId"]), 90);
  }
  addProjected(projected, "date", pickField(fields, ["date", "createdAt", "updatedAt"]), 90);
  addProjected(projected, "from", pickField(fields, ["from", "sender", "email"]), 140);
  addProjected(projected, "to", pickField(fields, ["to", "recipient"]), 140);
  addProjected(projected, "subject", pickField(fields, ["subject", "title", "name"]), 180);
  if (includeLabels) {
    addProjected(projected, "labels", pickField(fields, ["labelIds", "labels", "status"]), 160);
  }
  if (includeSnippet) {
    addProjected(projected, "snippet", pickField(fields, ["snippet", "summary", "description"]), snippetLength);
  }

  return projected;
}

function buildGithubIssueCollectionResult(
  toolSlug: string,
  collection: CollectionCandidate,
  promptTerms: Set<string>,
  returnedCount: number,
  bodyLength: number,
  includeBody: boolean
) {
  return {
    resultType: "collection",
    sourceTool: toolSlug,
    path: collection.path,
    itemCount: collection.items.length,
    returnedCount,
    truncated: returnedCount < collection.items.length,
    note:
      returnedCount < collection.items.length
        ? "GitHub issues were compacted by field first; only excess items beyond the requested/safe count were omitted."
        : includeBody
          ? "GitHub issues were compacted to preserve one item per issue with short body excerpts."
          : "GitHub issues were compacted to preserve one item per issue while dropping long body fields.",
    items: collection.items
      .slice(0, returnedCount)
      .map((item, index) => projectGithubIssue(item, index, promptTerms, bodyLength, includeBody)),
  };
}

function projectGithubIssue(
  record: Record<string, unknown>,
  index: number,
  promptTerms: Set<string>,
  bodyLength: number,
  includeBody: boolean
) {
  const fields = collectFieldCandidates(record, promptTerms);
  const projected: Record<string, string | number | boolean> = { index: index + 1 };

  addProjected(projected, "number", pickField(fields, ["number"]), 60);
  addProjected(projected, "title", pickField(fields, ["title", "name", "subject"]), 220);
  addProjected(projected, "state", pickField(fields, ["state", "status"]), 80);
  addProjected(projected, "createdAt", pickField(fields, ["createdAt", "date"]), 90);
  addProjected(projected, "updatedAt", pickField(fields, ["updatedAt"]), 90);
  addProjected(projected, "htmlUrl", pickPreferredField(fields, ["htmlUrl", "webUrl", "url"]), 240);
  addProjected(projected, "comments", pickField(fields, ["comments"]), 40);
  if (includeBody) {
    addProjected(projected, "body", pickField(fields, ["body", "summary", "description", "text"]), bodyLength);
  }

  return projected;
}

function requestedItemCount(options: CompactOptions, maxItems: number) {
  const args = options.args ?? {};
  for (const field of COUNT_FIELDS) {
    const parsed = toPositiveInt(args[field]);
    if (parsed != null) return Math.min(parsed, maxItems);
  }
  return options.maxItems ?? maxItems;
}

function isGithubCollectionTool(toolSlug: string) {
  return toolSlug.startsWith("GITHUB_");
}

function pickField(fields: FieldCandidate[], keys: string[]) {
  const keySet = new Set(keys);
  return fields
    .filter((field) => keySet.has(field.key))
    .sort((a, b) => b.score - a.score)[0]?.value;
}

function pickPreferredField(fields: FieldCandidate[], keys: string[]) {
  for (const key of keys) {
    const match = fields.filter((field) => field.key === key).sort((a, b) => b.score - a.score)[0];
    if (match) return match.value;
  }
  return undefined;
}

function addProjected(
  projected: Record<string, string | number | boolean>,
  key: string,
  value: string | number | boolean | undefined,
  maxLength: number
) {
  if (value === undefined) return;
  projected[key] = typeof value === "string" ? limitString(value, maxLength) : value;
}

function buildCollectionResult(
  toolSlug: string,
  collection: CollectionCandidate,
  promptTerms: Set<string>,
  returnedCount: number
) {
  return {
    resultType: "collection",
    sourceTool: toolSlug,
    path: collection.path,
    itemCount: collection.items.length,
    returnedCount,
    truncated: returnedCount < collection.items.length,
    note:
      returnedCount < collection.items.length
        ? "Tool result was compacted at item boundaries. Ask for the next page or a narrower filter for omitted items."
        : "Tool result was structurally compacted to preserve useful fields within model context.",
    items: collection.items.slice(0, returnedCount).map((item, index) => projectRecord(item, index, promptTerms)),
  };
}

function compactJson(value: unknown, maxLength: number) {
  const text = stringify(value);
  if (text.length <= maxLength) {
    return value;
  }

  return {
    truncated: true,
    note:
      "Tool result was too large for model context. The preview is cut at a structural or word boundary; use pagination or request narrower fields for full coverage.",
    preview: safePreview(text, maxLength),
  };
}

function findBestCollection(value: unknown): CollectionCandidate | undefined {
  const candidates: CollectionCandidate[] = [];

  function visit(node: unknown, depth: number, path: string) {
    if (depth > 6 || node == null) {
      return;
    }

    if (Array.isArray(node)) {
      const records = node.filter(isRecord);
      if (records.length >= 2 && records.length >= node.length * 0.6) {
        const score = records.length * 10 + averageProjectableFieldCount(records) * 3 - depth;
        candidates.push({ path, items: records, score });
      }

      node.slice(0, 20).forEach((item, index) => visit(item, depth + 1, `${path}[${index}]`));
      return;
    }

    if (isRecord(node)) {
      for (const [key, item] of Object.entries(node)) {
        visit(item, depth + 1, path === "$" ? `$.${key}` : `${path}.${key}`);
      }
    }
  }

  visit(value, 0, "$");
  return candidates.sort((a, b) => b.score - a.score)[0];
}

function averageProjectableFieldCount(records: Record<string, unknown>[]) {
  const sample = records.slice(0, 5);
  if (sample.length === 0) {
    return 0;
  }

  return sample.reduce((sum, record) => sum + collectFieldCandidates(record, new Set()).length, 0) / sample.length;
}

function projectRecord(record: Record<string, unknown>, index: number, promptTerms: Set<string>) {
  const fields = new Map<string, FieldCandidate>();
  fields.set("index", { key: "index", value: index + 1, score: Number.MAX_SAFE_INTEGER });

  for (const candidate of collectFieldCandidates(record, promptTerms)) {
    const current = fields.get(candidate.key);
    if (!current || candidate.score > current.score) {
      fields.set(candidate.key, candidate);
    }
  }

  const selected = [...fields.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_FIELDS_PER_ITEM)
    .sort((a, b) => fieldOutputOrder(a.key) - fieldOutputOrder(b.key));

  return Object.fromEntries(selected.map((field) => [field.key, field.value]));
}

function collectFieldCandidates(record: Record<string, unknown>, promptTerms: Set<string>) {
  const candidates: FieldCandidate[] = [];

  function visit(node: unknown, depth: number, parentKey?: string) {
    if (depth > 3 || node == null) {
      return;
    }

    if (Array.isArray(node)) {
      const namedValues = namedValueEntries(node);
      if (namedValues.length > 0) {
        for (const { name, value } of namedValues) {
          addField(name, value, depth, promptTerms, candidates, true);
        }
        return;
      }

      const scalarValues = node.filter(isScalar).slice(0, 10);
      if (parentKey && scalarValues.length > 0 && scalarValues.length === node.length) {
        addField(parentKey, scalarValues.join(", "), depth, promptTerms, candidates, false);
      }
      return;
    }

    if (!isRecord(node)) {
      if (parentKey && isScalar(node)) {
        addField(parentKey, node, depth, promptTerms, candidates, false);
      }
      return;
    }

    const named = namedValueEntry(node);
    if (named) {
      addField(named.name, named.value, depth, promptTerms, candidates, true);
    }

    for (const [key, value] of Object.entries(node)) {
      if (isScalar(value)) {
        addField(key, value, depth, promptTerms, candidates, false);
        continue;
      }

      if (depth < 3 && (Array.isArray(value) || isRecord(value))) {
        visit(value, depth + 1, key);
      }
    }
  }

  visit(record, 0);
  return candidates;
}

function addField(
  rawKey: string,
  rawValue: unknown,
  depth: number,
  promptTerms: Set<string>,
  candidates: FieldCandidate[],
  fromNamedValue: boolean
) {
  if (!isScalar(rawValue)) {
    return;
  }

  const key = normalizeKey(rawKey);
  const value = normalizeValue(rawValue);
  if (!key || value === undefined) {
    return;
  }

  const priority = FIELD_PRIORITY_BY_KEY.get(key) ?? 0;
  const matchesPrompt = fieldMatchesPrompt(key, rawKey, promptTerms);
  if (!priority && !matchesPrompt && depth > 1 && !fromNamedValue) {
    return;
  }

  candidates.push({
    key,
    value,
    score:
      priority * 100 +
      (matchesPrompt ? 1_000 : 0) +
      (fromNamedValue ? 250 : 0) -
      depth * 20 -
      String(value).length / 100,
  });
}

function namedValueEntries(value: unknown[]): Array<{ name: string; value: string | number | boolean }> {
  return value
    .map(namedValueEntry)
    .filter((entry): entry is { name: string; value: string | number | boolean } => Boolean(entry));
}

function namedValueEntry(value: unknown): { name: string; value: string | number | boolean } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const name = firstScalar(value, ["name", "key", "field", "label"]);
  const fieldValue = firstScalar(value, ["value", "text", "content"]);
  if (name === undefined || fieldValue === undefined) {
    return undefined;
  }

  return { name: String(name), value: fieldValue };
}

function firstScalar(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (isScalar(value) && String(value).trim()) {
      return value;
    }
  }
  return undefined;
}

function fieldMatchesPrompt(key: string, rawKey: string, promptTerms: Set<string>) {
  if (promptTerms.size === 0) {
    return false;
  }

  const keyTerms = [...termSet(key), ...termSet(rawKey)];
  return keyTerms.some((term) => promptTerms.has(term));
}

function fieldOutputOrder(key: string) {
  if (key === "index") {
    return -1;
  }

  const priority = FIELD_PRIORITY_BY_KEY.get(key);
  return priority ? FIELD_PRIORITY.length - priority : FIELD_PRIORITY.length + 1;
}

function normalizeKey(input: string) {
  const words = input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .map((word) => word.trim())
    .filter(Boolean);

  if (words.length === 0) {
    return "";
  }

  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      return index === 0 ? lower : `${lower[0].toUpperCase()}${lower.slice(1)}`;
    })
    .join("");
}

function normalizeValue(value: string | number | boolean) {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.length > MAX_STRING_FIELD_LENGTH ? truncateText(trimmed, MAX_STRING_FIELD_LENGTH) : trimmed;
}

function limitString(value: string, maxLength: number) {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return truncateText(trimmed, maxLength);
}

function toPositiveInt(value: unknown) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function safePreview(text: string, maxLength: number) {
  const sliced = text.slice(0, maxLength);
  const structuralBoundary = Math.max(
    sliced.lastIndexOf("\n"),
    sliced.lastIndexOf("},"),
    sliced.lastIndexOf("],"),
    sliced.lastIndexOf(",")
  );
  const wordBoundary = Math.max(sliced.lastIndexOf(" "), sliced.lastIndexOf("."), sliced.lastIndexOf(";"));
  const boundary = Math.max(structuralBoundary, wordBoundary);
  const cut = boundary > maxLength * 0.7 ? boundary + 1 : maxLength;
  return `${sliced.slice(0, cut).trimEnd()}\n...`;
}

function truncateText(text: string, maxLength: number) {
  if (text.length <= maxLength) {
    return text;
  }

  const sliced = text.slice(0, maxLength);
  const boundary = Math.max(sliced.lastIndexOf(" "), sliced.lastIndexOf("."), sliced.lastIndexOf(";"));
  return `${sliced.slice(0, boundary > maxLength * 0.7 ? boundary : maxLength).trimEnd()}...`;
}

function termSet(text: string) {
  return new Set(
    text
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length >= 2)
  );
}

function stringify(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
