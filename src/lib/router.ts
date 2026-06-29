import { ROUTER_INTENTS, type RouterIntent } from "./intent-registry";
import { generateJson, PLANNER_MODEL } from "./llm";
import { filterAllowedToolCatalog, getToolCatalog } from "./tool-catalog";
import { isMutatingToolSlug } from "./tool-recovery";
import type {
  ActiveRouteTask,
  LlmRouterFn,
  LlmRouterInput,
  LlmToolRouteResult,
  RouteToolsOptions,
  RouterMessage,
  RouterStrategy,
  RouteToolsResult,
  ToolCatalogEntry,
} from "./types";

type ScoredIntent = {
  intent: RouterIntent;
  score: number;
};

type LlmIntentRouteResult = {
  intentIds: string[];
  rationale: string;
};

type LlmRouteContext = {
  prompt: string;
  routingPrompt: string;
  routeScope: RouteToolsResult["routeScope"];
  messages: RouterMessage[];
  activeTask?: ActiveRouteTask;
  catalog: ToolCatalogEntry[];
  scored: ScoredIntent[];
  deterministic: RouteToolsResult;
  maxTools: number;
  maxIntents: number;
  llmRouter?: LlmRouterFn;
};

const DEFAULT_TOOL_DESCRIPTIONS: Record<string, string> = {
  GOOGLESUPER_FETCH_EMAILS: "Fetch emails from Gmail",
  GOOGLESUPER_SEND_EMAIL: "Send Email",
  GOOGLESUPER_FETCH_MESSAGE_BY_MESSAGE_ID: "Fetch Gmail message by message ID",
  GOOGLESUPER_GET_ATTACHMENT: "Get Gmail attachment",
  GOOGLESUPER_CREATE_EVENT: "Create Event",
  GOOGLESUPER_FIND_FREE_SLOTS: "Find free slots",
  GOOGLESUPER_GET_CONTACTS: "Get contacts",
  GOOGLESUPER_SEARCH_PEOPLE: "Search People",
  GOOGLESUPER_GET_CURRENT_DATE_TIME: "Get current date and time",
  GOOGLESUPER_EVENTS_LIST: "List Events",
  GOOGLESUPER_FIND_FILE: "Find file",
  GOOGLESUPER_FIND_FOLDER: "Find folder",
  GOOGLESUPER_LIST_CHILDREN_V2: "List Folder Children",
  GOOGLESUPER_DOWNLOAD_FILE: "Download a file from Google Drive",
  GOOGLESUPER_DOWNLOAD_FILE_OPERATION: "Download file via operation",
  GOOGLESUPER_PARSE_FILE: "Export or download a file",
  GOOGLESUPER_SHEET_FROM_JSON: "Create sheet from JSON",
  GOOGLESUPER_CREATE_GOOGLE_SHEET1: "Create a Google Sheet",
  GOOGLESUPER_SPREADSHEETS_VALUES_APPEND: "Append Values to Spreadsheet",
  GOOGLESUPER_GET_BATCH_VALUES: "Get spreadsheet values",
  GITHUB_LIST_REPOSITORY_ISSUES: "List repository issues",
  GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS: "Search issues and pull requests",
  GITHUB_GET_AN_ISSUE: "Get an issue",
};

const DEFAULT_TOOLS = Object.keys(DEFAULT_TOOL_DESCRIPTIONS);
const MIN_INTENT_SCORE = 4;
const LLM_CANDIDATE_SCORE = 2;
const ROUTE_SCORE_COUNT = 8;
// Below this confidence the deterministic registry route is treated as a weak
// guess, so discovery over the full catalog gets a chance to do better. Set
// just above the borderline keyword-only matches (e.g. "weather" grazing the
// calendar intent at ~0.34) so those go to discovery instead of misfiring.
const FAST_PATH_CONFIDENCE = 0.4;
// How many catalog tools to hand to the discovery LLM as candidates.
const DISCOVERY_CANDIDATES = 40;
// Minimum lexical relevance for the offline fallback to pick a tool at all.
const MIN_LEXICAL_SCORE = 5;
const CONTEXTUAL_ROUTE_CONFIDENCE = 0.4;
const MUTATION_TERMS = [
  "send",
  "create",
  "schedule",
  "book",
  "update",
  "append",
  "write",
  "draft",
  "reply",
  "forward",
  "delete",
  "remove",
  "post",
  "make",
];
const UNSUPPORTED_CAPABILITY_ACTION_TERMS = new Set([
  "append",
  "create",
  "delete",
  "post",
  "remove",
  "send",
  "update",
]);

const FALLBACK_CATALOG: ToolCatalogEntry[] = DEFAULT_TOOLS.map((slug) => ({
  slug,
  description: DEFAULT_TOOL_DESCRIPTIONS[slug] ?? slug,
  toolkit: toolkitForSlug(slug),
}));

export async function routeToolsForPrompt(
  prompt: string,
  options: RouteToolsOptions = {}
): Promise<RouteToolsResult> {
  const catalog = await loadCatalog(options);
  const maxTools = options.maxTools ?? 10;
  const maxIntents = options.maxIntents ?? 3;

  // Short acknowledgements / non-requests ("confirmed", "yes", "thanks") must
  // not route to any tool. Confirmations happen via the UI approve button, not
  // by chatting "confirmed" — otherwise discovery/lexical can mis-route them.
  const promptTerms = termSet(prompt);
  if (promptTerms.size === 0 || [...promptTerms].every((term) => ACK_TERMS.has(term))) {
    return buildRouteFromScoredIntents([], [], catalog, maxTools, "none");
  }

  const ambiguous = ambiguousFollowupClarification(prompt, options.messages ?? []);
  if (ambiguous) {
    return {
      slugs: [],
      intentIds: [],
      rationale: "ambiguous follow-up across multiple prior task domains",
      confidence: 0,
      routingMode: "none",
      routeScope: "ambiguous",
      clarification: ambiguous,
    };
  }

  const routingPrompt = contextualRoutingPrompt(prompt, options.messages ?? []);
  const routeScope: RouteToolsResult["routeScope"] =
    routingPrompt === prompt ? "standalone" : "contextual_followup";
  const scored = scoreIntentsForPrompt(routingPrompt, catalog);
  const deterministic = buildRouteFromScoredIntents(
    selectIntents(scored, maxIntents),
    scored,
    catalog,
    maxTools,
    "deterministic"
  );

  const strategy = resolveRouterStrategy(options);
  let route: RouteToolsResult;
  if (strategy === "llm_first") {
    route = await routeLlmFirst({
      prompt,
      routingPrompt,
      routeScope,
      messages: options.messages ?? [],
      activeTask: options.activeTask,
      catalog,
      scored,
      deterministic,
      maxTools,
      maxIntents,
      llmRouter: options.llmRouter,
    });
  } else if (strategy === "shadow") {
    route = await routeWithLlmShadow({
      prompt,
      routingPrompt,
      routeScope,
      messages: options.messages ?? [],
      activeTask: options.activeTask,
      catalog,
      scored,
      deterministic,
      maxTools,
      maxIntents,
      llmRouter: options.llmRouter,
    }, options);
  } else {
    route = await routeDeterministicOrDiscovery(routingPrompt, options, catalog, scored, deterministic, maxTools, maxIntents);
  }

  const constrained = filterRouteForPromptConstraints(route, routingPrompt, prompt, catalog);
  return { ...constrained, routeScope: constrained.routeScope ?? routeScope };
}

async function routeDeterministicOrDiscovery(
  prompt: string,
  options: RouteToolsOptions,
  catalog: ToolCatalogEntry[],
  scored: ScoredIntent[],
  deterministic: RouteToolsResult,
  maxTools: number,
  maxIntents: number
) {
  const useLLM = options.useLLM ?? process.env.TOOL_ROUTER_USE_LLM === "1";
  // Discovery defaults to `useLLM`, so deterministic callers (tests) stay
  // deterministic, while the server (which sets neither) opts in by default.
  const useDiscovery =
    options.discovery ?? options.useLLM ?? process.env.TOOL_ROUTER_DISCOVERY !== "0";

  const hasConfidentRoute =
    (deterministic.intentIds?.length ?? 0) > 0 &&
    (isWorkflowRoute(deterministic) || (deterministic.confidence ?? 0) >= FAST_PATH_CONFIDENCE);

  // Fast path: a confident registry hit (and always for the heavy workflows,
  // which must never be bypassed by generic discovery).
  if (hasConfidentRoute) {
    return useLLM ? await refineWithLlm(prompt, scored, catalog, maxTools, maxIntents, deterministic) : deterministic;
  }

  // Discovery path: the registry is unsure or has no intent for this prompt
  // (e.g. a toolkit it was never taught about). Select straight from the live
  // catalog so new toolkits work without code changes. Seed the candidate pool
  // with the curated tool bundles of the best-scoring intents, so supporting
  // tools (contacts, date, ...) that don't match the prompt wording are still
  // offered to the model.
  if (useDiscovery) {
    const allowedSlugs = new Set(catalog.map((tool) => tool.slug));
    // Always offer the curated registry tools (every known intent's core actions)
    // to the model, plus the best-scoring intents' bundles. This guarantees the
    // model can pick the right tool even when typos defeat lexical ranking — the
    // model handles spelling, but only among the candidates we hand it. Without
    // this, a misspelled "schedlue a meting" ranks 0 tools and the 40-tool
    // shortlist excludes CREATE_EVENT, so the model never gets the chance.
    const seedSlugs = [
      ...registryCoreSlugs(),
      ...scored
        .filter((entry) => entry.score >= LLM_CANDIDATE_SCORE)
        .slice(0, 2)
        .flatMap((entry) => entry.intent.toolSlugs),
    ].filter((slug) => allowedSlugs.has(slug));

    try {
      const discovered = await discoverToolsFromCatalog(prompt, catalog, maxTools, seedSlugs);
      if (discovered && discovered.slugs.length > 0) {
        return discovered;
      }
      // Discovery saw the real candidates and chose nothing relevant (e.g. a
      // Slack request when only Google/GitHub are loaded). Trust that over a
      // weak keyword guess and return "none" so the agent can say it can't help
      // rather than misfiring to an unrelated tool.
      return buildRouteFromScoredIntents([], scored, catalog, maxTools, "none");
    } catch {
      // The model was unavailable — degrade to a pure lexical match so the
      // agent still gets reasonable tools instead of nothing.
      const lexical = lexicalRoute(prompt, catalog, maxTools);
      if (lexical.slugs.length > 0) {
        return lexical;
      }
      return buildRouteFromScoredIntents([], scored, catalog, maxTools, "none");
    }
  }

  return deterministic;
}

async function routeLlmFirst(context: LlmRouteContext): Promise<RouteToolsResult> {
  try {
    const raw = await callLlmRouter(context);
    const validated = validateLlmRoute(raw, context, "llm_first");
    if (routeConflictsWithLatestPrompt(context, validated)) {
      return {
        ...context.deterministic,
        routingMode: "llm_first_fallback",
        rationale: `${context.deterministic.rationale}; LLM-first route conflicted with latest prompt domain`,
      };
    }
    if (shouldPreserveDeterministicWorkflow(context, validated)) {
      return {
        ...context.deterministic,
        routingMode: "llm_first_fallback",
        rationale: `${context.deterministic.rationale}; LLM-first omitted required workflow tools`,
      };
    }
    if (validated.slugs.length > 0) {
      return validated;
    }
    if ((validated.confidence ?? 0) >= 0.7 && !hasConfidentContextualRoute(context)) {
      return validated;
    }

    const fallback = await routeDeterministicOrDiscovery(
      context.routingPrompt,
      { discovery: true, useLLM: false },
      context.catalog,
      context.scored,
      context.deterministic,
      context.maxTools,
      context.maxIntents
    );
    return {
      ...fallback,
      routingMode: "llm_first_fallback",
      rationale: `${fallback.rationale}; LLM-first returned no usable low-confidence route`,
    };
  } catch (err) {
    const fallback = await routeDeterministicOrDiscovery(
      context.routingPrompt,
      { discovery: true, useLLM: false },
      context.catalog,
      context.scored,
      context.deterministic,
      context.maxTools,
      context.maxIntents
    );
    return {
      ...fallback,
      routingMode: "llm_first_fallback",
      rationale: `${fallback.rationale}; LLM-first failed: ${errorPreview(err)}`,
    };
  }
}

async function routeWithLlmShadow(
  context: LlmRouteContext,
  options: RouteToolsOptions
): Promise<RouteToolsResult> {
  const active = await routeDeterministicOrDiscovery(
    context.routingPrompt,
    { ...options, strategy: "deterministic" },
    context.catalog,
    context.scored,
    context.deterministic,
    context.maxTools,
    context.maxIntents
  );

  try {
    const raw = await callLlmRouter(context);
    const shadow = validateLlmRoute(raw, context, "shadow_llm");
    return {
      ...active,
      routingMode: "shadow_llm",
      rationale: `${active.rationale}; shadow LLM would select [${shadow.slugs.join(", ")}] (${shadow.rationale})`,
    };
  } catch (err) {
    return {
      ...active,
      routingMode: "shadow_llm",
      rationale: `${active.rationale}; shadow LLM failed: ${errorPreview(err)}`,
    };
  }
}

async function callLlmRouter(context: LlmRouteContext): Promise<LlmToolRouteResult> {
  const input = llmRouterInput(context);
  if (context.llmRouter) {
    return context.llmRouter(input);
  }

  return generateJson<LlmToolRouteResult>({
    model: PLANNER_MODEL,
    system: [
      "You are the first-layer tool router for an app that can only use the provided tools.",
      "Choose intent IDs and tool slugs needed for the user's latest message. Recent conversation may fill missing references, but it must not override the latest message's domain or action.",
      "Only return intent IDs from availableIntents and tool slugs from availableTools. Never invent tool names.",
      "Prefer read tools for read tasks. Include mutating tools only when the user asks to send, create, update, append, schedule, or otherwise change external state.",
      "If the task continues an active task, set isContinuation true. If no available tool fits, return empty intentIds/toolSlugs with high confidence.",
    ].join(" "),
    prompt: JSON.stringify({
      ...input,
      responseShape: {
        intentIds: ["intent.id"],
        toolSlugs: ["TOOLKIT_ACTION"],
        isContinuation: false,
        missingSlots: ["field_name"],
        confidence: 0.0,
        rationale: "short reason",
      },
    }),
  });
}

function llmRouterInput(context: LlmRouteContext): LlmRouterInput {
  return {
    prompt: context.prompt,
    messages: context.messages.slice(-8),
    activeTask: context.activeTask,
    availableIntents: availableIntentSummaries(context.catalog),
    availableTools: candidateToolsForLlm(context.routingPrompt, context.catalog, context.scored, context.deterministic),
    maxTools: context.maxTools,
    maxIntents: context.maxIntents,
  };
}

function hasConfidentContextualRoute(context: LlmRouteContext) {
  return (
    context.routeScope === "contextual_followup" &&
    context.deterministic.slugs.length > 0 &&
    (isWorkflowRoute(context.deterministic) ||
      (context.deterministic.confidence ?? 0) >= CONTEXTUAL_ROUTE_CONFIDENCE)
  );
}

function shouldPreserveDeterministicWorkflow(context: LlmRouteContext, validated: RouteToolsResult) {
  if (!isWorkflowRoute(context.deterministic) || (context.deterministic.confidence ?? 0) < FAST_PATH_CONFIDENCE) {
    return false;
  }
  if (isWorkflowRoute(validated)) {
    return false;
  }

  const deterministicSlugs = new Set(context.deterministic.slugs);
  return context.deterministic.slugs.some((slug) => !validated.slugs.includes(slug) && deterministicSlugs.has(slug));
}

function routeConflictsWithLatestPrompt(context: LlmRouteContext, route: RouteToolsResult) {
  const explicit = explicitPromptDomains(context.prompt);
  if (explicit.size === 0 || route.slugs.length === 0) {
    return false;
  }
  const routeDomains = domainsForRoute(route);
  if (routeDomains.size === 0) {
    return false;
  }
  return ![...routeDomains].some((domain) => explicit.has(domain));
}

function domainsForRoute(route: RouteToolsResult) {
  const domains = new Set<RouterIntent["domain"]>();
  const intentById = new Map(ROUTER_INTENTS.map((intent) => [intent.id, intent]));
  for (const intentId of route.intentIds ?? []) {
    const domain = intentById.get(intentId)?.domain;
    if (domain) domains.add(domain);
  }
  for (const slug of route.slugs) {
    const domain = domainForToolSlug(slug);
    if (domain) domains.add(domain);
  }
  return domains;
}

function domainForToolSlug(slug: string): RouterIntent["domain"] | undefined {
  if (slug.startsWith("GITHUB_")) return "github";
  if (slug.includes("SHEET") || slug.includes("SPREADSHEET")) return "sheet";
  if (slug.includes("EVENT") || slug.includes("FREE_SLOT")) return "calendar";
  if (slug.includes("CONTACT") || slug.includes("PEOPLE")) return "contacts";
  if (
    slug.includes("DRIVE") ||
    slug.includes("FILE") ||
    slug.includes("FOLDER") ||
    slug.includes("CHILDREN") ||
    slug.includes("PARSE")
  ) {
    return "drive";
  }
  if (slug.includes("EMAIL") || slug.includes("MESSAGE") || slug.includes("ATTACHMENT")) return "email";
  return undefined;
}

function contextualRoutingPrompt(prompt: string, messages: RouterMessage[]) {
  if (!shouldUseConversationContext(prompt, messages)) {
    return prompt;
  }

  const context = recentConversationContext(messages, prompt);
  if (!context || !hasSupportedDomainSignal(context)) {
    return prompt;
  }

  return `${context}\nuser: ${prompt}`;
}

function shouldUseConversationContext(prompt: string, messages: RouterMessage[]) {
  if (isBareGithubRepoReference(prompt)) {
    return latestAssistantAskedGithubRepository(messages, prompt);
  }
  if (!isContextualFollowup(prompt)) {
    return false;
  }
  if (isSheetFromPriorItemsFollowup(prompt)) {
    return true;
  }
  if (explicitPromptDomains(prompt).size > 0) {
    return false;
  }
  return true;
}

function isBareGithubRepoReference(prompt: string) {
  return /^(?:https?:\/\/github\.com\/)?[a-z0-9_.-]+\/[a-z0-9_.-]+\/?$/i.test(prompt.trim());
}

function latestAssistantAskedGithubRepository(messages: RouterMessage[], prompt: string) {
  const current = prompt.trim();
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const content = message.content.trim();
    if (!content) {
      continue;
    }
    if (message.role === "user" && content === current) {
      continue;
    }
    if (message.role !== "assistant") {
      return false;
    }
    return /\bwhich\s+github\s+repository\b|\bgithub\s+repository\b.{0,80}\b(?:check|pull|read|fetch|use)\b|\bowner\b.{0,80}\brepo(?:sitory)?\b/i.test(
      content
    );
  }
  return false;
}

function ambiguousFollowupClarification(prompt: string, messages: RouterMessage[]) {
  if (!isBareAmbiguousFollowup(prompt)) {
    return null;
  }
  const domains = recentSourceDomains(messages, prompt);
  if (domains.length <= 1) {
    return null;
  }
  const labels = domains.map(domainLabel).join(", ");
  return `Which task should I continue: ${labels}?`;
}

function isBareAmbiguousFollowup(prompt: string) {
  const normalized = prompt.trim().toLowerCase().replace(/[?.!]+$/g, "");
  return /^(?:continue|do it|do that|same|same thing|that|this|them|these|those|more|show me more|again|next)$/i.test(
    normalized
  );
}

function recentSourceDomains(messages: RouterMessage[], prompt: string) {
  const current = prompt.trim();
  const domains = new Set<Exclude<RouterIntent["domain"], "sheet" | "contacts">>();
  for (const message of messages.slice(-8)) {
    const content = message.content.trim();
    if (!content || (message.role === "user" && content === current)) {
      continue;
    }
    for (const domain of explicitPromptDomains(content)) {
      if (domain !== "sheet" && domain !== "contacts") {
        domains.add(domain);
      }
    }
  }
  return [...domains];
}

function domainLabel(domain: RouterIntent["domain"]) {
  switch (domain) {
    case "email":
      return "emails";
    case "calendar":
      return "calendar";
    case "github":
      return "GitHub issues";
    case "drive":
      return "Drive files/resumes";
    case "sheet":
      return "Google Sheets";
    case "contacts":
      return "contacts";
  }
}

function recentConversationContext(messages: RouterMessage[], prompt: string) {
  const current = prompt.trim();
  const prior = messages
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
    }))
    .filter((message) => message.content.length > 0);

  if (prior.at(-1)?.role === "user" && prior.at(-1)?.content === current) {
    prior.pop();
  }

  return prior
    .slice(-6)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n")
    .slice(-4_000);
}

function isContextualFollowup(prompt: string) {
  return /\b(?:again|another|continue|do it|fetch|get|latest|more|newer|newest|ones|previous|prior|recent|same|that|them|these|this|those)\b/i.test(
    prompt
  );
}

function isSheetFromPriorItemsFollowup(prompt: string) {
  return (
    /\b(?:it|that|them|these|those|this|above|results?|rows?|items?)\b/i.test(prompt) &&
    /\b(?:sheet|spreadsheet|table|csv)\b/i.test(prompt) &&
    /\b(?:write|create|make|export|append|put|save)\b/i.test(prompt) &&
    !/\b(?:github|repo|repository|issue|issues|drive|folder|resume|resumes|email|emails|gmail|inbox|calendar|event|meeting)\b/i.test(
      prompt
    )
  );
}

function hasSupportedDomainSignal(text: string) {
  return /\b(?:attachment|calendar|drive|email|emails|event|file|folder|github|gmail|inbox|issue|issues|mail|meeting|message|messages|pdf|pull request|repo|repository|resume|resumes|sheet|spreadsheet)\b/i.test(
    text
  );
}

function explicitPromptDomains(prompt: string) {
  const lower = prompt.toLowerCase();
  const terms = termSet(prompt);
  const domains = new Set<RouterIntent["domain"]>();

  if (
    /\b(?:gmail|inbox|emails?|messages?|mail)\b/.test(lower) &&
    !/\b(?:github|issue|issues|pull request|repo|repository)\b/.test(lower)
  ) {
    domains.add("email");
  }
  if (
    /\b(?:github|repo|repository|issue|issues|pull request|pull requests|\bpr\b)\b/.test(lower) ||
    /[a-z0-9_.-]+\/[a-z0-9_.-]+/.test(lower)
  ) {
    domains.add("github");
  }
  if (/\b(?:drive|folder|resume|resumes|candidate|candidates|pdf|pdfs|document|documents)\b/.test(lower)) {
    domains.add("drive");
  }
  if (/\b(?:calendar|event|meeting|invite|agenda|schedule|book|free slot|availability)\b/.test(lower)) {
    domains.add("calendar");
  }
  if (hasAny(terms, ["sheet", "spreadsheet", "table", "csv"])) {
    domains.add("sheet");
  }
  if (hasAny(terms, ["contact", "contacts", "people", "person"])) {
    domains.add("contacts");
  }

  return domains;
}

function isReadOnlyAgainstSheetWorkflow(prompt: string) {
  const lower = prompt.toLowerCase();
  return (
    /\b(?:just|only|simply)?\s*(?:get|fetch|read|show|list|summari[sz]e)\b/.test(lower) &&
    /\b(?:issue|issues|github|repo|repository|pull request|pull requests)\b/.test(lower) &&
    (/\b(?:don'?t|do not|without|no)\s+(?:write|create|make|export|append|put|save)\b/.test(lower) ||
      !/\b(?:sheet|spreadsheet|table|csv)\b/.test(lower))
  );
}

function filterRouteForPromptConstraints(
  route: RouteToolsResult,
  routedPrompt: string,
  latestPrompt: string,
  catalog: ToolCatalogEntry[]
) {
  if (
    isSheetFromPriorItemsFollowup(latestPrompt) ||
    !isReadOnlyAgainstSheetWorkflow(routedPrompt) ||
    (!route.intentIds?.includes("github.issues_to_sheet") && !route.slugs.some((slug) => slug.startsWith("GITHUB_")))
  ) {
    return route;
  }

  const allowed = new Set(catalog.map((tool) => tool.slug));
  const readIntent = ROUTER_INTENTS.find((intent) => intent.id === "github.issues_read");
  const slugs = (readIntent?.toolSlugs ?? [])
    .filter((slug) => allowed.has(slug))
    .filter((slug, index, all) => all.indexOf(slug) === index);

  return {
    ...route,
    slugs,
    intentIds: ["github.issues_read"],
    rationale: `${route.rationale}; constrained to read-only by routed prompt`,
  };
}

function validateLlmRoute(
  raw: LlmToolRouteResult,
  context: LlmRouteContext,
  routingMode: "llm_first" | "shadow_llm"
): RouteToolsResult {
  const allowedSlugs = new Set(context.catalog.map((tool) => tool.slug));
  const allowedSlugByUpper = new Map(context.catalog.map((tool) => [tool.slug.toUpperCase(), tool.slug]));
  const intentById = new Map(ROUTER_INTENTS.map((intent) => [intent.id, intent]));
  const droppedSlugs: string[] = [];
  const droppedIntentIds: string[] = [];
  const rawIntentIds = stringArray(raw.intentIds);
  const rawToolSlugs = stringArray(raw.toolSlugs).map(
    (slug) => allowedSlugByUpper.get(slug.toUpperCase()) ?? slug
  );

  const mutationAllowed =
    Boolean(raw.isContinuation && context.activeTask?.selectedTools.some(isMutatingToolSlug)) ||
    isExplicitMutationPrompt(context.prompt);

  const intentIds = rawIntentIds
    .filter((intentId, index, all) => all.indexOf(intentId) === index)
    .filter((intentId) => {
      const intent = intentById.get(intentId);
      const valid = Boolean(
        intent &&
          intent.toolSlugs.some((slug) => allowedSlugs.has(slug)) &&
          (!intent.mutating || mutationAllowed)
      );
      if (!valid) droppedIntentIds.push(intentId);
      return valid;
    })
    .slice(0, context.maxIntents);

  const selectedIntents = intentIds
    .map((intentId) => intentById.get(intentId))
    .filter((intent): intent is RouterIntent => Boolean(intent));

  const intentSlugs = selectedIntents
    .flatMap((intent) => intent.toolSlugs)
    .filter((slug) => allowedSlugs.has(slug));

  const llmSlugs = rawToolSlugs.filter((slug) => {
    const valid = allowedSlugs.has(slug);
    if (!valid) droppedSlugs.push(slug);
    return valid;
  });

  const slugs = [...intentSlugs, ...llmSlugs]
    .filter((slug) => !isMutatingToolSlug(slug) || mutationAllowed)
    .filter((slug, index, all) => all.indexOf(slug) === index)
    .slice(0, context.maxTools);

  const rawHadSelections = rawIntentIds.length > 0 || rawToolSlugs.length > 0;
  const allSelectionsDropped = rawHadSelections && intentIds.length === 0 && slugs.length === 0;
  const onlyUnsupportedCapabilitySelections =
    allSelectionsDropped &&
    rawIntentIds.length === 0 &&
    droppedSlugs.length > 0 &&
    droppedSlugs.every((slug) => isUnsupportedCapabilitySlug(slug, context.catalog));
  const confidence = allSelectionsDropped && !onlyUnsupportedCapabilitySelections ? 0 : clampConfidence(raw.confidence);
  const rationaleParts = [
    stringValue(raw.rationale) || "LLM-first route",
    droppedIntentIds.length ? `dropped unknown intents: ${droppedIntentIds.join(", ")}` : "",
    droppedSlugs.length ? `dropped unknown tools: ${droppedSlugs.join(", ")}` : "",
  ].filter(Boolean);

  return {
    slugs,
    rationale: rationaleParts.join("; "),
    intentIds,
    confidence,
    routingMode,
    scores: context.deterministic.scores ?? [],
  };
}

function availableIntentSummaries(catalog: ToolCatalogEntry[]) {
  const allowed = new Set(catalog.map((tool) => tool.slug));
  return ROUTER_INTENTS.filter((intent) => intent.toolSlugs.some((slug) => allowed.has(slug))).map((intent) => ({
    id: intent.id,
    domain: intent.domain,
    description: intent.description,
    mutating: intent.mutating,
    toolSlugs: intent.toolSlugs.filter((slug) => allowed.has(slug)),
    examples: intent.examplePrompts.slice(0, 3),
  }));
}

function candidateToolsForLlm(
  prompt: string,
  catalog: ToolCatalogEntry[],
  scored: ScoredIntent[],
  deterministic: RouteToolsResult
) {
  const bySlug = new Map(catalog.map((tool) => [tool.slug, tool]));
  const ordered = [
    ...(deterministic.slugs ?? []),
    ...registryCoreSlugs(),
    ...scored
      .filter((entry) => entry.score >= LLM_CANDIDATE_SCORE)
      .slice(0, 3)
      .flatMap((entry) => entry.intent.toolSlugs),
    ...rankCatalogByPrompt(prompt, catalog).map((entry) => entry.tool.slug),
    ...catalog.map((tool) => tool.slug),
  ];

  const candidates: ToolCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const slug of ordered) {
    const tool = bySlug.get(slug);
    if (!tool || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    candidates.push(tool);
    if (candidates.length >= DISCOVERY_CANDIDATES) {
      break;
    }
  }
  return candidates;
}

function resolveRouterStrategy(options: RouteToolsOptions): RouterStrategy {
  if (options.strategy) {
    return options.strategy;
  }
  if (options.useLLM === false) {
    return "deterministic";
  }
  const env = process.env.TOOL_ROUTER_STRATEGY?.toLowerCase();
  if (env === "deterministic" || env === "shadow" || env === "llm_first") {
    return env;
  }
  if (process.env.TOOL_ROUTER_USE_LLM === "0") {
    return "deterministic";
  }
  return "llm_first";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
    : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function clampConfidence(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 0;
}

function isExplicitMutationPrompt(prompt: string) {
  if (isNegativeMutationPrompt(prompt)) {
    return false;
  }
  const terms = termSet(prompt);
  return hasAny(terms, MUTATION_TERMS);
}

function isNegativeMutationPrompt(prompt: string) {
  return /\b(?:don'?t|do not|without|no)\s+(?:send|create|schedule|book|update|append|write|draft|reply|forward|delete|remove|post|make|export|save|put)\b/i.test(
    prompt
  );
}

function errorPreview(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 160);
}

function isUnsupportedCapabilitySlug(slug: string, catalog: ToolCatalogEntry[]) {
  if (slug.startsWith("COMPOSIO_")) {
    return false;
  }
  const prefix = slug.split("_")[0]?.toUpperCase();
  if (!prefix) {
    return false;
  }
  const sameToolkitTools = catalog.filter((tool) => tool.slug.split("_")[0]?.toUpperCase() === prefix);
  if (sameToolkitTools.length === 0) {
    return true;
  }

  const requestedActions = [...termSet(slug.replace(/^[A-Z0-9]+_/, "").replace(/_/g, " "))].filter((term) =>
    UNSUPPORTED_CAPABILITY_ACTION_TERMS.has(term)
  );
  if (requestedActions.length === 0) {
    return false;
  }

  const availableTerms = new Set<string>();
  for (const tool of sameToolkitTools) {
    const actionText = `${tool.slug.replace(/^[A-Z0-9]+_/, "").replace(/_/g, " ")} ${tool.description ?? ""}`;
    termSet(actionText).forEach((term) => availableTerms.add(term));
  }

  return requestedActions.every((term) => !availableTerms.has(term));
}

async function refineWithLlm(
  prompt: string,
  scored: ScoredIntent[],
  catalog: ToolCatalogEntry[],
  maxTools: number,
  maxIntents: number,
  deterministic: RouteToolsResult
): Promise<RouteToolsResult> {
  const candidates = scored.filter((entry) => entry.score >= LLM_CANDIDATE_SCORE).slice(0, Math.max(6, maxIntents));
  if (candidates.length === 0) {
    return deterministic;
  }

  const candidateIds = new Set(candidates.map((entry) => entry.intent.id));
  const llmResult = await generateJson<LlmIntentRouteResult>({
    system:
      "You refine an intent route for a user task. Pick only intent IDs from the provided candidateIntents. Do not invent tools or new intent IDs.",
    prompt: JSON.stringify({
      userPrompt: prompt,
      candidateIntents: candidates.map(({ intent, score }) => ({
        id: intent.id,
        domain: intent.domain,
        description: intent.description,
        examples: intent.examplePrompts.slice(0, 3),
        score: roundScore(score),
      })),
      responseShape: { intentIds: ["intent.id"], rationale: "short reason" },
    }),
    fallback: { intentIds: deterministic.intentIds ?? [], rationale: deterministic.rationale },
  }).catch(() => ({ intentIds: deterministic.intentIds ?? [], rationale: deterministic.rationale }));

  const refined = llmResult.intentIds
    .filter((intentId) => candidateIds.has(intentId))
    .filter((intentId, index, all) => all.indexOf(intentId) === index)
    .map((intentId) => candidates.find((entry) => entry.intent.id === intentId))
    .filter((entry): entry is ScoredIntent => Boolean(entry))
    .slice(0, maxIntents);

  if (refined.length === 0) {
    return deterministic;
  }

  return {
    ...buildRouteFromScoredIntents(refined, scored, catalog, maxTools, "llm_refined"),
    rationale: llmResult.rationale || deterministic.rationale,
  };
}

function isWorkflowRoute(route: RouteToolsResult) {
  return (route.intentIds ?? []).some((id) => id.endsWith("_to_sheet"));
}

type LlmDiscoveryResult = {
  toolSlugs: string[];
  rationale: string;
};

/**
 * Toolkit-agnostic discovery: rank the entire live catalog by lexical relevance
 * to the prompt, hand the top candidates (slug + description) to the model, and
 * let it pick the minimal set of tools. Because the candidate pool is the live
 * catalog, any newly enabled toolkit's tools are selectable without code.
 */
async function discoverToolsFromCatalog(
  prompt: string,
  catalog: ToolCatalogEntry[],
  maxTools: number,
  seedSlugs: string[] = []
): Promise<RouteToolsResult | null> {
  const ranked = rankCatalogByPrompt(prompt, catalog);
  const bySlug = new Map(catalog.map((tool) => [tool.slug, tool]));
  const ordered = [
    ...seedSlugs.map((slug) => bySlug.get(slug)).filter((tool): tool is ToolCatalogEntry => Boolean(tool)),
    ...(ranked.length ? ranked.map((entry) => entry.tool) : catalog),
  ];
  const candidates: ToolCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const tool of ordered) {
    if (seen.has(tool.slug)) {
      continue;
    }
    seen.add(tool.slug);
    candidates.push(tool);
    if (candidates.length >= DISCOVERY_CANDIDATES) {
      break;
    }
  }
  if (candidates.length === 0) {
    return null;
  }

  const allowed = new Set(candidates.map((tool) => tool.slug));
  // No `fallback`: let generateJson throw if the model is unavailable, so the
  // caller can distinguish "model down -> lexical fallback" from "model chose
  // nothing relevant -> return none".
  const result = await generateJson<LlmDiscoveryResult>({
    model: PLANNER_MODEL,
    system: [
      "You are a tool router. Given a user task and a list of available tools, choose the tool slugs needed to complete the task end to end.",
      "Only return slugs that appear in availableTools. Prefer read tools for read tasks; include a write/create tool only when the task asks to send, create, or modify something.",
      "Also include any supporting read/lookup tools the task needs to resolve references — e.g. tools that look up a contact/person by name, resolve a file or folder, or return the current date when the task uses a relative date like 'tomorrow' or 'next tuesday'.",
      "If none of the available tools fit the task, return an empty toolSlugs array.",
    ].join(" "),
    prompt: JSON.stringify({
      userTask: prompt,
      maxTools,
      availableTools: candidates.map((tool) => ({ slug: tool.slug, description: tool.description })),
      responseShape: { toolSlugs: ["TOOLKIT_ACTION"], rationale: "short reason" },
    }),
  });

  const slugs = (Array.isArray(result.toolSlugs) ? result.toolSlugs : [])
    .filter((slug): slug is string => typeof slug === "string" && allowed.has(slug))
    .filter((slug, index, all) => all.indexOf(slug) === index)
    .slice(0, maxTools);

  if (slugs.length === 0) {
    return null;
  }

  return {
    slugs,
    rationale: result.rationale?.trim() || "catalog discovery",
    intentIds: [],
    confidence: 0.6,
    routingMode: "catalog_llm",
    scores: [],
  };
}

/** Pure lexical fallback used when the discovery LLM is unavailable or empty. */
function lexicalRoute(prompt: string, catalog: ToolCatalogEntry[], maxTools: number): RouteToolsResult {
  const allRanked = rankCatalogByPrompt(prompt, catalog);
  // Require a real top match; otherwise weak word overlaps (e.g. a stray "user"
  // matching unrelated GitHub tools) would mis-route. Below the floor -> none.
  const ranked = (allRanked[0]?.score ?? 0) >= MIN_LEXICAL_SCORE ? allRanked.slice(0, maxTools) : [];
  return {
    slugs: ranked.map((entry) => entry.tool.slug),
    rationale: ranked.length ? "lexical catalog match" : "no matching tool",
    intentIds: [],
    confidence: ranked.length ? 0.3 : 0,
    routingMode: ranked.length ? "catalog_lexical" : "none",
    scores: [],
  };
}

/**
 * Rank the entire catalog by lexical relevance of the prompt to each tool's
 * (de-prefixed) slug and description. Toolkit-agnostic: a newly enabled
 * toolkit's tools are ranked purely on their descriptions, with no code.
 */
export function rankCatalogByPrompt(prompt: string, catalog: ToolCatalogEntry[]) {
  const promptTerms = termSet(prompt);
  if (promptTerms.size === 0) {
    return [];
  }

  return catalog
    .map((tool) => {
      const slugTerms = termSet(tool.slug.replace(/^[A-Z0-9]+_/, "").replace(/_/g, " "));
      const descTerms = termSet(tool.description ?? "");
      const score = overlapCount(promptTerms, slugTerms) * 3 + overlapCount(promptTerms, descTerms);
      return { tool, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.slug.localeCompare(b.tool.slug));
}

async function loadCatalog(options: RouteToolsOptions) {
  if (options.catalog) {
    return mergeFallbackCatalog(filterAllowedToolCatalog(options.catalog));
  }

  try {
    return mergeFallbackCatalog(filterAllowedToolCatalog(await getToolCatalog(options.forceRefreshCatalog ?? false)));
  } catch {
    return FALLBACK_CATALOG;
  }
}

// Union of every registry intent's tool bundle — the curated "core" actions
// (send email, create event, list issues, ...). Always offered to discovery so
// the model can choose correctly even when typos zero out lexical ranking.
let cachedRegistryCoreSlugs: string[] | null = null;
function registryCoreSlugs(): string[] {
  if (!cachedRegistryCoreSlugs) {
    const slugs = new Set<string>();
    for (const intent of ROUTER_INTENTS) {
      intent.toolSlugs.forEach((slug) => slugs.add(slug));
    }
    cachedRegistryCoreSlugs = [...slugs];
  }
  return cachedRegistryCoreSlugs;
}

function scoreIntentsForPrompt(prompt: string, catalog: ToolCatalogEntry[]) {
  const allowed = new Set(catalog.map((tool) => tool.slug));
  const lower = prompt.toLowerCase();
  const terms = termSet(prompt);

  return ROUTER_INTENTS.map((intent) => ({
    intent,
    score: allowedIntentScore(intent, allowed) + scoreIntent(intent, lower, terms),
  }))
    .filter((entry) => entry.score > 0 && entry.intent.toolSlugs.some((slug) => allowed.has(slug)))
    .sort((a, b) => b.score - a.score || a.intent.id.localeCompare(b.intent.id));
}

function allowedIntentScore(intent: RouterIntent, allowed: Set<string>) {
  const allowedCount = intent.toolSlugs.filter((slug) => allowed.has(slug)).length;
  if (allowedCount === 0) {
    return -100;
  }

  return allowedCount === intent.toolSlugs.length ? 0.5 : 0;
}

function scoreIntent(intent: RouterIntent, lowerPrompt: string, promptTerms: Set<string>) {
  if (promptTerms.size === 0) {
    return 0;
  }

  let score = 0;
  for (const keyword of intent.keywords) {
    score += scoreKeyword(keyword, lowerPrompt, promptTerms);
  }

  const exampleScores = intent.examplePrompts
    .map((example) => overlapCount(promptTerms, termSet(example)))
    .sort((a, b) => b - a);
  score += (exampleScores[0] ?? 0) * 1.4 + (exampleScores[1] ?? 0) * 0.6;
  score += overlapCount(promptTerms, termSet(intent.description)) * 0.4;
  score += domainSignalScore(intent, lowerPrompt, promptTerms);
  score += sourceGuardScore(intent, lowerPrompt, promptTerms);
  return score;
}

function scoreKeyword(keyword: string, lowerPrompt: string, promptTerms: Set<string>) {
  const lowerKeyword = keyword.toLowerCase();
  const keywordTerms = termSet(keyword);
  if (lowerKeyword.includes(" ") && lowerPrompt.includes(lowerKeyword)) {
    return 5 + Math.min(keywordTerms.size, 4);
  }

  if (!lowerKeyword.includes(" ") && promptTerms.has(normalizeTerm(lowerKeyword))) {
    return 3;
  }

  const overlap = overlapCount(promptTerms, keywordTerms);
  if (keywordTerms.size > 1 && overlap === keywordTerms.size) {
    return 3 + overlap;
  }

  return 0;
}

function domainSignalScore(intent: RouterIntent, lowerPrompt: string, promptTerms: Set<string>) {
  let score = 0;
  if (intent.domain === "drive" && /drive\.google\.com|\/drive\/folders\//.test(lowerPrompt)) {
    score += 10;
  }
  if (intent.domain === "github" && /github\.com|[a-z0-9_.-]+\/[a-z0-9_.-]+/.test(lowerPrompt)) {
    score += 7;
  }
  if (intent.id.endsWith("_to_sheet") && hasAny(promptTerms, ["sheet", "spreadsheet", "table", "row"])) {
    score += 6;
  }
  if (intent.id === "sheet.create_or_update" && hasAny(promptTerms, ["sheet", "spreadsheet", "table", "row", "csv"])) {
    score += 4;
  }
  if (intent.id === "email.send_with_upload" && hasAny(promptTerms, ["attach", "attached", "attachment", "uploaded", "pdf", "file"])) {
    score += hasAny(promptTerms, ["send", "email", "mail"]) ? 8 : 4;
  }
  if (intent.id === "email.find_attachment" && hasAny(promptTerms, ["attach", "attached", "attachment"])) {
    score += hasAny(promptTerms, ["send", "compose", "draft"]) ? 0 : 5;
  }
  if (intent.id === "calendar.schedule" && hasAny(promptTerms, ["schedule", "book", "create", "invite"])) {
    score += 5;
  }
  if (intent.id === "email.purchase_history" && hasAny(promptTerms, ["bought", "buy", "purchase", "order", "receipt", "invoice"])) {
    score += 5;
  }
  return score;
}

function sourceGuardScore(intent: RouterIntent, lowerPrompt: string, promptTerms: Set<string>) {
  if (
    intent.id === "github.issues_to_sheet" &&
    !/github\.com|[a-z0-9_.-]+\/[a-z0-9_.-]+/.test(lowerPrompt) &&
    !hasAny(promptTerms, ["github", "repo", "repository", "issue", "pull", "pr"])
  ) {
    return -18;
  }

  if (
    intent.id === "drive.resumes_to_sheet" &&
    !/drive\.google\.com|\/drive\/folders\//.test(lowerPrompt) &&
    !hasAny(promptTerms, ["drive", "folder", "resume", "candidate", "pdf", "document"])
  ) {
    return -18;
  }

  return 0;
}

function selectIntents(scored: ScoredIntent[], maxIntents: number) {
  const eligible = scored.filter((entry) => entry.score >= MIN_INTENT_SCORE);
  if (eligible.length === 0) {
    return [];
  }

  const relativeFloor = Math.max(MIN_INTENT_SCORE, eligible[0].score * 0.55);
  const bestByDomain = new Map<RouterIntent["domain"], ScoredIntent>();
  for (const entry of eligible) {
    if (entry.score < relativeFloor) {
      continue;
    }

    const current = bestByDomain.get(entry.intent.domain);
    if (!current || entry.score > current.score) {
      bestByDomain.set(entry.intent.domain, entry);
    }
  }

  return [...bestByDomain.values()]
    .sort((a, b) => b.score - a.score || a.intent.id.localeCompare(b.intent.id))
    .slice(0, maxIntents);
}

function buildRouteFromScoredIntents(
  selected: ScoredIntent[],
  scored: ScoredIntent[],
  catalog: ToolCatalogEntry[],
  maxTools: number,
  routingMode: RouteToolsResult["routingMode"]
): RouteToolsResult {
  const scores = scored.slice(0, ROUTE_SCORE_COUNT).map((entry) => ({
    intentId: entry.intent.id,
    score: roundScore(entry.score),
  }));

  if (selected.length === 0) {
    return {
      slugs: [],
      rationale: "no matching intent",
      intentIds: [],
      confidence: 0,
      routingMode: "none",
      scores,
    };
  }

  const allowed = new Set(catalog.map((tool) => tool.slug));
  const slugs = selected
    .flatMap((entry) => entry.intent.toolSlugs)
    .filter((slug) => allowed.has(slug))
    .filter((slug, index, all) => all.indexOf(slug) === index)
    .slice(0, maxTools);

  if (slugs.length === 0) {
    return {
      slugs: [],
      rationale: "selected intents have no available tools",
      intentIds: selected.map((entry) => entry.intent.id),
      confidence: 0,
      routingMode: "none",
      scores,
    };
  }

  return {
    slugs,
    rationale: selected.map((entry) => entry.intent.id).join(", "),
    intentIds: selected.map((entry) => entry.intent.id),
    confidence: routeConfidence(selected[0].score, scored[1]?.score ?? 0),
    routingMode,
    scores,
  };
}

function routeConfidence(topScore: number, nextScore: number) {
  const absolute = Math.min(topScore / 24, 1);
  const margin = topScore <= 0 ? 0 : Math.min(Math.max((topScore - nextScore) / topScore, 0), 1);
  return roundScore(absolute * 0.75 + margin * 0.25);
}

function mergeFallbackCatalog(catalog: ToolCatalogEntry[]) {
  const bySlug = new Map(filterAllowedToolCatalog(catalog).map((tool) => [tool.slug, tool]));
  for (const tool of FALLBACK_CATALOG) {
    if (!bySlug.has(tool.slug)) {
      bySlug.set(tool.slug, tool);
    }
  }
  return [...bySlug.values()];
}

function toolkitForSlug(slug: string) {
  if (slug.startsWith("GOOGLESUPER_")) {
    return "googlesuper";
  }
  if (slug.startsWith("GITHUB_")) {
    return "github";
  }
  return undefined;
}

function overlapCount(left: Set<string>, right: Set<string>) {
  let count = 0;
  for (const term of left) {
    if (right.has(term)) {
      count += 1;
    }
  }
  return count;
}

function hasAny(terms: Set<string>, candidates: string[]) {
  return candidates.some((candidate) => terms.has(normalizeTerm(candidate)));
}

function termSet(text: string) {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map(normalizeTerm)
      .filter((term) => term.length > 1 && !STOP_WORDS.has(term))
  );
}

function normalizeTerm(term: string) {
  const lower = term.toLowerCase();
  if (lower.length > 4 && lower.endsWith("ies")) {
    return `${lower.slice(0, -3)}y`;
  }
  if (lower.length > 3 && lower.endsWith("s")) {
    return lower.slice(0, -1);
  }
  return lower;
}

function roundScore(score: number) {
  return Math.round(score * 100) / 100;
}

// Bare acknowledgements / control words that should never select a tool.
const ACK_TERMS = new Set([
  "confirm",
  "confirmed",
  "yes",
  "yeah",
  "yep",
  "ok",
  "okay",
  "sure",
  "nope",
  "thanks",
  "thank",
  "thankyou",
  "done",
  "cool",
  "great",
  "cancel",
  "stop",
  "approved",
  "approve",
]);

const STOP_WORDS = new Set([
  "what",
  "else",
  "can",
  "you",
  "your",
  "with",
  "from",
  "for",
  "the",
  "and",
  "are",
  "have",
  "has",
  "had",
  "about",
  "this",
  "that",
  "should",
  "would",
  "could",
  "please",
  "help",
  "google",
  "make",
  "last",
  "past",
  "month",
  "week",
  "year",
  "day",
  "all",
]);
