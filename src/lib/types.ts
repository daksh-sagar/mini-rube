export type ToolCatalogEntry = {
  slug: string;
  description: string;
  toolkit?: string;
};

export type RoutingMode =
  | "deterministic"
  | "llm_refined"
  | "llm_first"
  | "llm_first_fallback"
  | "shadow_llm"
  | "catalog_llm"
  | "catalog_lexical"
  | "none";

export type RouterStrategy = "llm_first" | "deterministic" | "shadow";

export type RouterMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ActiveRouteTask = {
  intentId: string;
  promptHistory: string[];
  selectedTools: string[];
};

export type LlmToolRouteResult = {
  intentIds?: unknown;
  toolSlugs?: unknown;
  isContinuation?: unknown;
  missingSlots?: unknown;
  confidence?: unknown;
  rationale?: unknown;
};

export type LlmRouterInput = {
  prompt: string;
  messages: RouterMessage[];
  activeTask?: ActiveRouteTask;
  availableIntents: Array<{
    id: string;
    domain: string;
    description: string;
    mutating: boolean;
    toolSlugs: string[];
    examples: string[];
  }>;
  availableTools: ToolCatalogEntry[];
  maxTools: number;
  maxIntents: number;
};

export type LlmRouterFn = (input: LlmRouterInput) => Promise<LlmToolRouteResult>;

export type RouteToolsResult = {
  slugs: string[];
  rationale: string;
  intentIds?: string[];
  confidence?: number;
  routingMode?: RoutingMode;
  routeScope?: "standalone" | "contextual_followup" | "ambiguous";
  clarification?: string;
  scores?: Array<{ intentId: string; score: number }>;
};

export type RouteToolsOptions = {
  catalog?: ToolCatalogEntry[];
  maxTools?: number;
  maxIntents?: number;
  strategy?: RouterStrategy;
  messages?: RouterMessage[];
  activeTask?: ActiveRouteTask;
  llmRouter?: LlmRouterFn;
  useLLM?: boolean;
  /**
   * Enables LLM/lexical discovery over the full catalog when the deterministic
   * registry route is low-confidence or empty. Defaults to `useLLM`, so the
   * deterministic-only tests stay deterministic.
   */
  discovery?: boolean;
  forceRefreshCatalog?: boolean;
  connectedToolkits?: string[];
};

export type ComposioToolSchema = {
  slug?: string;
  name?: string;
  description?: string;
  inputParameters?: unknown;
  input_parameters?: unknown;
  [key: string]: unknown;
};

export type RunTraceEntry = {
  id: string;
  at: string;
  type: "plan" | "tool" | "confirmation" | "error" | "info";
  title: string;
  detail?: string;
  toolSlug?: string;
  args?: unknown;
  resultPreview?: unknown;
};

export type ActionDetail = { label: string; value: string };

export type PendingAction = {
  id: string;
  userId: string;
  runId: string;
  toolSlug: string;
  args: Record<string, unknown>;
  summary: string;
  /** Human-readable one-line description of the action, safe to show in the UI. */
  actionTitle: string;
  /** Key fields of the action (already redacted) for the confirmation card. */
  actionDetails: ActionDetail[];
  status: "pending" | "executed" | "failed";
  createdAt: string;
  executedAt?: string;
  result?: unknown;
  error?: string;
};

export type RunState = {
  id: string;
  userId: string;
  status: "running" | "waiting_confirmation" | "completed" | "failed" | "cancelled";
  prompt: string;
  selectedTools: string[];
  rationale: string;
  startedAt: string;
  updatedAt: string;
  traces: RunTraceEntry[];
  pendingActions: string[];
  artifacts: Array<{ label: string; url?: string; value?: unknown }>;
};
