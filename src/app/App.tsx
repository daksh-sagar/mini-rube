import React, { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { Markdown } from "./markdown";

const SESSION_KEY = "mini_rube_user_id";

// Defensive cap so a confirm button can never sit in "Confirming" forever if the
// server is briefly unresponsive (e.g. a heavy background job starves the event loop).
const CONFIRM_TIMEOUT_MS = 90_000;

const EXAMPLE_PROMPTS = [
  "Read my last 100 emails and show me the important ones",
  "Schedule a calendar event tomorrow with Karan",
  "Read all open and closed issues on composiohq/composio and make a Google Sheet of the problems people report",
  "Take all the resumes in this Drive folder (paste the folder link or name) and make a Google Sheet with candidate name, university, and last job",
  "Send an email with the attached PDF",
];
const TOOLKITS = ["googlesuper", "github"] as const;
const TOOLKIT_LABELS: Record<(typeof TOOLKITS)[number], string> = {
  googlesuper: "Google",
  github: "GitHub",
};

type Toolkit = (typeof TOOLKITS)[number];
type ConnectionState =
  | "checking"
  | "connected"
  | "disconnected"
  | "connecting"
  | "error";

type UploadedFile = {
  id: string;
  name: string;
};

type ActionDetail = {
  label: string;
  value: string;
};

type PendingAction = {
  id: string;
  label?: string;
  title?: string;
  details?: ActionDetail[];
  source: "assistant" | "trace";
};

type TraceItem = {
  id: string;
  title: string;
  detail?: string;
  status?: string;
};

type RunTrace = Record<string, unknown>;

type JobState = "idle" | "loading" | "ready" | "error";

type JobProgress = {
  totalItems: number;
  fetchedItems: number;
  processedItems: number;
  writtenRows: number;
  failedItems: number;
};

type JobArtifact = {
  label: string;
  url: string;
};

type WorkflowJob = {
  id: string;
  userId: string;
  type: string;
  status: string;
  approvalStatus: string;
  approvalSummary?: string;
  phase?: string;
  progress: JobProgress;
  artifacts: JobArtifact[];
  error?: string;
  updatedAt?: string;
};

type PrimaryApproval =
  | {
      kind: "job";
      title: string;
      summary: string;
      confirmLabel: string;
      confirming: boolean;
      disabled: boolean;
      onConfirm: () => void;
    }
  | {
      kind: "action";
      title: string;
      summary: string;
      confirmLabel: string;
      confirming: boolean;
      disabled: boolean;
      onConfirm: () => void;
    };

type ConnectionDetail = {
  status?: string;
  connected?: boolean;
  accountId?: string;
  requiredAccess: string[];
  error?: string;
};

const initialConnections: Record<Toolkit, ConnectionState> = {
  googlesuper: "checking",
  github: "checking",
};

const initialConnectionDetails: Record<Toolkit, ConnectionDetail> = {
  googlesuper: { requiredAccess: [] },
  github: { requiredAccess: [] },
};

function createFallbackUserId() {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `browser_${suffix}`;
}

function getObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function getSessionUserId(payload: unknown) {
  const obj = getObject(payload);
  if (!obj) return null;

  return (
    getString(obj.userId) ??
    getString(obj.id) ??
    getString(obj.user_id) ??
    getString(getObject(obj.user)?.id)
  );
}

function normalizeConnectionValue(value: unknown): ConnectionState {
  if (value === true) return "connected";
  if (value === false || value == null) return "disconnected";
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (["connected", "active", "ready", "ok"].includes(normalized)) {
      return "connected";
    }
    if (["connecting", "pending", "loading"].includes(normalized)) {
      return "connecting";
    }
    if (["error", "failed", "invalid", "expired"].includes(normalized)) {
      return "error";
    }
    return "disconnected";
  }

  const obj = getObject(value);
  if (!obj) return "disconnected";
  return normalizeConnectionValue(
    obj.connected ?? obj.status ?? obj.state ?? obj.isConnected
  );
}

function readConnectionStatus(payload: unknown, toolkit: Toolkit): ConnectionState {
  const obj = getObject(payload);
  if (!obj) return "disconnected";

  const connections = obj.connections;
  const connectionMap = getObject(connections);
  if (connectionMap && toolkit in connectionMap) {
    return normalizeConnectionValue(connectionMap[toolkit]);
  }

  if (Array.isArray(connections)) {
    const match = connections.find((entry) => {
      const item = getObject(entry);
      return item?.toolkit === toolkit || item?.slug === toolkit || item?.name === toolkit;
    });
    if (match) return normalizeConnectionValue(match);
  }

  const detail = getObject(getObject(obj.details)?.[toolkit]);
  if (detail) return normalizeConnectionValue(detail.connected ?? detail.status ?? detail.state);

  return normalizeConnectionValue(obj[toolkit]);
}

function normalizeRequiredAccess(value: unknown): string[] {
  if (value == null) return [];

  if (Array.isArray(value)) {
    return value.flatMap(normalizeRequiredAccess);
  }

  if (typeof value === "string") {
    return value
      .split(/\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  const obj = getObject(value);
  if (!obj) return [String(value)].filter(Boolean);

  const direct =
    getString(obj.label) ??
    getString(obj.name) ??
    getString(obj.title) ??
    getString(obj.description) ??
    getString(obj.scope) ??
    getString(obj.value);
  if (direct) return [direct];

  try {
    return [JSON.stringify(obj)];
  } catch {
    return [];
  }
}

function readConnectionDetails(payload: unknown): Record<Toolkit, ConnectionDetail> {
  const obj = getObject(payload);
  const details = getObject(obj?.details);
  const next = {} as Record<Toolkit, ConnectionDetail>;

  TOOLKITS.forEach((toolkit) => {
    const detailObj = getObject(details?.[toolkit]);
    next[toolkit] = {
      status: getString(detailObj?.status) ?? undefined,
      connected: getBoolean(detailObj?.connected) ?? undefined,
      accountId:
        getString(detailObj?.accountId) ??
        getString(detailObj?.account_id) ??
        undefined,
      requiredAccess: normalizeRequiredAccess(detailObj?.requiredAccess),
      error:
        getString(detailObj?.error) ??
        getString(getObject(detailObj?.error)?.message) ??
        undefined,
    };
  });

  return next;
}

function summarizeRequiredAccess(toolkit: Toolkit, value: unknown) {
  const items = normalizeRequiredAccess(value);
  if (items.length === 0) return null;

  const visible = items.slice(0, 4).join(", ");
  const suffix = items.length > 4 ? `, and ${items.length - 4} more` : "";
  return `${TOOLKIT_LABELS[toolkit]} will request access to: ${visible}${suffix}.`;
}

function extractUploadedFileId(payload: unknown) {
  const obj = getObject(payload);
  if (!obj) return null;

  const file = getObject(obj.file);
  const firstFile = Array.isArray(obj.files) ? getObject(obj.files[0]) : null;
  return (
    getString(obj.fileId) ??
    getString(obj.id) ??
    getString(file?.id) ??
    getString(file?.fileId) ??
    getString(firstFile?.id) ??
    getString(firstFile?.fileId)
  );
}

function extractRunIdFromText(content: string) {
  const match = content.match(/\brun[_-]?id\s*[:=]\s*([A-Za-z0-9_.:-]+)/i);
  return match?.[1]?.replace(/[),.;]+$/, "") ?? null;
}

function extractJobIdFromText(content: string) {
  const match = content.match(/\bjob[_-]?id\s*[:=]\s*([A-Za-z0-9_.:-]+)/i);
  return match?.[1]?.replace(/[),.;]+$/, "") ?? null;
}

function extractPendingActionsFromText(content: string): PendingAction[] {
  const actions = new Map<string, PendingAction>();
  const pattern = /pending_action:([A-Za-z0-9_.:-]+)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content))) {
    const id = match[1].replace(/[),.;]+$/, "");
    if (id) actions.set(id, { id, source: "assistant" });
  }

  return [...actions.values()];
}

function cleanAssistantContent(content: string) {
  const hasJobToken = /\bjob[_-]?id\s*[:=]\s*[A-Za-z0-9_.:-]+/i.test(content);
  const cleaned = content
    .replace(/pending_action:[A-Za-z0-9_.:-]+/g, "")
    .replace(/\brun[_-]?id\s*[:=]\s*[A-Za-z0-9_.:-]+/gi, "")
    .replace(/\bjob[_-]?id\s*[:=]\s*[A-Za-z0-9_.:-]+/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (cleaned) {
    return cleaned;
  }
  // Empty assistant text: either still streaming, or the model returned tool
  // calls without a final summary. Stay neutral instead of implying a pending
  // action — real pending actions and tool activity show in the side panel.
  return hasJobToken ? "Workflow started — see the workflow panel." : "…";
}

function collectTracePendingActions(trace: unknown): PendingAction[] {
  const actions = new Map<string, PendingAction>();

  function addAction(value: unknown) {
    if (typeof value === "string") {
      const id = value.trim();
      if (id) actions.set(id, { id, source: "trace" });
      return;
    }

    const obj = getObject(value);
    if (!obj) return;

    const id =
      getString(obj.id) ??
      getString(obj.actionId) ??
      getString(obj.action_id) ??
      getString(obj.pendingActionId);
    if (!id) return;

    const status = getString(obj.status)?.toLowerCase();
    if (status && !["pending", "requires_confirmation", "waiting"].includes(status)) {
      return;
    }

    const details = Array.isArray(obj.actionDetails)
      ? obj.actionDetails.flatMap((entry): ActionDetail[] => {
          const detail = getObject(entry);
          const label = getString(detail?.label);
          const value = getString(detail?.value);
          return label && value ? [{ label, value }] : [];
        })
      : undefined;

    actions.set(id, {
      id,
      source: "trace",
      title:
        getString(obj.actionTitle) ??
        getString(obj.title) ??
        getString(obj.name) ??
        undefined,
      details: details && details.length > 0 ? details : undefined,
      label:
        getString(obj.label) ??
        getString(obj.name) ??
        getString(obj.title) ??
        undefined,
    });
  }

  function visit(value: unknown, depth = 0) {
    if (depth > 4 || value == null) return;

    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, depth + 1));
      return;
    }

    const obj = getObject(value);
    if (!obj) return;

    for (const [key, entry] of Object.entries(obj)) {
      if (
        ["pendingActions", "pending_actions", "actions", "confirmations"].includes(key) &&
        Array.isArray(entry)
      ) {
        entry.forEach(addAction);
      } else {
        visit(entry, depth + 1);
      }
    }
  }

  visit(trace);
  return [...actions.values()];
}

function collectTraceItems(trace: RunTrace | null): TraceItem[] {
  if (!trace) return [];

  const run = getObject(trace.run);
  const source = [
    run?.traces,
    trace.steps,
    trace.events,
    trace.traces,
    trace.trace,
    trace.logs,
  ].find(Array.isArray) as unknown[] | undefined;

  return (source ?? []).slice(-6).map((entry, index) => {
    const obj = getObject(entry);
    if (!obj) {
      return {
        id: `${index}`,
        title: String(entry),
      };
    }

    const title =
      getString(obj.title) ??
      getString(obj.name) ??
      getString(obj.tool) ??
      getString(obj.toolSlug) ??
      getString(obj.tool_slug) ??
      getString(obj.type) ??
      `Step ${index + 1}`;
    const detail =
      getString(obj.message) ??
      getString(obj.detail) ??
      getString(obj.description) ??
      getString(obj.output);
    const status = getString(obj.status) ?? getString(obj.state) ?? undefined;

    return {
      id: getString(obj.id) ?? `${index}-${title}`,
      title,
      detail: detail ?? undefined,
      status,
    };
  });
}

function getTraceStatus(trace: RunTrace | null) {
  if (!trace) return null;
  return (
    getString(trace.status) ??
    getString(trace.state) ??
    getString(getObject(trace.run)?.status) ??
    null
  );
}

function getTraceSelectedTools(trace: RunTrace | null): string[] {
  if (!trace) return [];
  const run = getObject(trace.run);
  const tools = run?.selectedTools ?? (trace as Record<string, unknown>).selectedTools;
  return Array.isArray(tools) ? tools.filter((t): t is string => typeof t === "string") : [];
}

// After a completed read, suggest contextual follow-ups based on the tools the run
// actually used — the "expand search / load more" affordance the brief calls out.
function followUpsForTools(tools: string[]): string[] {
  const has = (re: RegExp) => tools.some((t) => re.test(t));
  if (has(/FETCH_EMAILS|GMAIL|FETCH_MESSAGE/i)) {
    return ["Show 50 more emails", "Only the unread ones", "Draft a reply to the most important one"];
  }
  if (has(/REPOSITORY_ISSUES|SEARCH_ISSUES|GET_AN_ISSUE/i)) {
    return ["Only the open issues", "Put these in a Google Sheet", "Show more"];
  }
  if (has(/FIND_FILE|LIST_CHILDREN|FIND_FOLDER/i)) {
    return ["Only PDFs", "Make a Google Sheet of these", "Show more"];
  }
  if (has(/EVENTS_LIST|FIND_FREE_SLOTS/i)) {
    return ["Only this week", "What's free tomorrow afternoon?"];
  }
  if (has(/_(LIST|SEARCH|FIND|FETCH|QUERY)/i)) {
    return ["Show more results", "Broaden the search"];
  }
  return [];
}

function summarizeTrace(trace: RunTrace | null) {
  if (!trace) return "";
  try {
    return JSON.stringify(trace, null, 2);
  } catch {
    return String(trace);
  }
}

function readJob(payload: unknown): WorkflowJob | null {
  const payloadObj = getObject(payload);
  const jobObj = getObject(payloadObj?.job) ?? getObject(payload);
  if (!jobObj) return null;

  const id = getString(jobObj.id);
  if (!id) return null;

  const progress = getObject(jobObj.progress);
  const artifacts = Array.isArray(jobObj.artifacts)
    ? jobObj.artifacts.flatMap((entry, index): JobArtifact[] => {
        const artifact = getObject(entry);
        if (!artifact) return [];

        const url = getString(artifact.url);
        if (!url) return [];

        return [
          {
            label:
              getString(artifact.label) ??
              getString(artifact.name) ??
              `Artifact ${index + 1}`,
            url,
          },
        ];
      })
    : [];

  const status = getString(jobObj.status) ?? "unknown";
  const rawPhase =
    getString(jobObj.phase) ??
    getString(jobObj.currentPhase) ??
    getString(jobObj.current_phase) ??
    getString(progress?.phase) ??
    undefined;

  return {
    id,
    userId: getString(jobObj.userId) ?? getString(jobObj.user_id) ?? "",
    type: getString(jobObj.type) ?? "workflow",
    status,
    approvalStatus:
      getString(jobObj.approvalStatus) ??
      getString(jobObj.approval_status) ??
      "unknown",
    approvalSummary:
      getString(jobObj.approvalSummary) ?? getString(jobObj.approval_summary) ?? undefined,
    phase: getJobPhaseForDisplay(status, rawPhase),
    progress: {
      totalItems: getNumber(progress?.totalItems ?? progress?.total_items) ?? 0,
      fetchedItems: getNumber(progress?.fetchedItems ?? progress?.fetched_items) ?? 0,
      processedItems:
        getNumber(progress?.processedItems ?? progress?.processed_items) ?? 0,
      writtenRows: getNumber(progress?.writtenRows ?? progress?.written_rows) ?? 0,
      failedItems: getNumber(progress?.failedItems ?? progress?.failed_items) ?? 0,
    },
    artifacts,
    error: getString(jobObj.error) ?? getString(getObject(jobObj.error)?.message) ?? undefined,
    updatedAt:
      getString(jobObj.updatedAt) ?? getString(jobObj.updated_at) ?? undefined,
  };
}

function normalizeJobValue(value: string | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function getTerminalJobPhase(status: string | undefined) {
  const normalized = normalizeJobValue(status);
  if (normalized === "cancelled" || normalized === "canceled") return "cancelled";
  if (normalized === "completed" || normalized === "succeeded") return "completed";
  if (normalized === "failed") return "failed";
  return null;
}

function getJobPhaseForDisplay(status: string | undefined, phase: string | undefined) {
  return getTerminalJobPhase(status) ?? phase;
}

function getJobDisplayPhase(job: WorkflowJob | null) {
  return getJobPhaseForDisplay(job?.status, job?.phase);
}

function shouldPollJob(job: WorkflowJob | null) {
  return ["queued", "running", "waiting_confirmation"].includes(
    normalizeJobValue(job?.status)
  );
}

function canCancelJob(job: WorkflowJob | null) {
  return ["queued", "running", "waiting_confirmation"].includes(
    normalizeJobValue(job?.status)
  );
}

function isTerminalJob(job: WorkflowJob | null) {
  return getTerminalJobPhase(job?.status) !== null;
}

function jobNeedsConfirmation(job: WorkflowJob | null) {
  if (!job) return false;

  const status = normalizeJobValue(job.status);
  if (isTerminalJob(job)) return false;

  return jobHasConfirmationRequest(job);
}

function jobHasConfirmationRequest(job: WorkflowJob | null) {
  if (!job) return false;

  const status = normalizeJobValue(job.status);
  const approvalStatus = normalizeJobValue(job.approvalStatus);
  return (
    status === "waiting_confirmation" ||
    ["pending", "required", "requires_confirmation", "waiting", "waiting_confirmation"].includes(
      approvalStatus
    )
  );
}

// Phases where the workflow is still discovering items via pagination, so the
// "total" is provisional (it equals whatever has been fetched so far). Showing a
// percentage here is misleading — it pins at 100% while the count keeps climbing —
// so we render an indeterminate bar instead.
const DISCOVERY_PHASES = new Set(["fetching", "listing"]);

// Phases where the job is actively doing work (not paused at the approval gate).
const ACTIVE_WORK_PHASES = new Set(["parsing", "writing"]);

// The collection is complete and the write either awaits approval or is just about to
// start. The phase stays here from the moment the approval card appears until writing
// actually begins, so labelling off it (rather than the approval status flag) keeps the
// heading stable across the click instead of flashing "100%" in the gap.
const READY_TO_WRITE_PHASES = new Set(["approval", "waiting_confirmation"]);

function isJobInDiscovery(job: WorkflowJob | null) {
  return !isTerminalJob(job) && DISCOVERY_PHASES.has(normalizeJobValue(getJobDisplayPhase(job)));
}

function isJobReadyToWrite(job: WorkflowJob | null) {
  return !isTerminalJob(job) && READY_TO_WRITE_PHASES.has(normalizeJobValue(getJobDisplayPhase(job)));
}

function getJobProgressPercent(job: WorkflowJob | null) {
  if (!job || job.progress.totalItems <= 0) return null;
  // During discovery the total isn't known yet (fetched === total), so don't
  // pretend we're at a fixed percentage — the caller renders an indeterminate bar.
  if (isJobInDiscovery(job)) return null;

  // Track whichever counter actually advances in the current phase. During writing,
  // processedItems is pinned at the total while writtenRows climbs, so writtenRows is
  // the honest numerator; during parsing/other phases processedItems is what grows.
  const phase = normalizeJobValue(getJobDisplayPhase(job));
  const completed =
    phase === "writing" ? job.progress.writtenRows : job.progress.processedItems;
  const bounded = Math.min(Math.max(completed, 0), job.progress.totalItems);
  return Math.max(0, Math.min(100, Math.round((bounded / job.progress.totalItems) * 100)));
}

function formatJobDate(value: string | undefined) {
  if (!value) return null;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function getJobTerminalMessage(job: WorkflowJob | null) {
  if (!job) return null;

  const status = normalizeJobValue(job.status);
  if (status === "completed" || status === "succeeded") {
    return "Workflow completed. Review artifacts or final chat output for the result.";
  }
  if (status === "cancelled" || status === "canceled") {
    return "Workflow cancelled. No further confirmations are available for this job.";
  }
  if (status === "failed") {
    return job.error
      ? "Workflow failed. The error details are shown below."
      : "Workflow failed before producing a result.";
  }

  return null;
}

function summarizeActionForDock(action: PendingAction) {
  if (action.details && action.details.length > 0) {
    return action.details
      .slice(0, 2)
      .map((detail) => `${detail.label}: ${detail.value}`)
      .join(" · ");
  }

  return "Awaiting your approval before it runs.";
}

// Trim long opaque ids (run_…/job_…) so the panel heading doesn't wrap; the full
// id stays available via the title attribute.
function shortId(id: string) {
  return id.length > 16 ? `${id.slice(0, 14)}…` : id;
}

function getConnectionButtonLabel(toolkit: Toolkit, state: ConnectionState) {
  const label = TOOLKIT_LABELS[toolkit];
  if (state === "connected") return `${label} · Connected`;
  if (state === "connecting") return `${label} · Connecting…`;
  if (state === "checking") return `${label} · Checking…`;
  if (state === "error") return `Reconnect ${label}`;
  return `Connect ${label}`;
}

function TypingDots() {
  return (
    <span className="typing" role="status" aria-label="Assistant is working">
      <span className="typing-dot" />
      <span className="typing-dot" />
      <span className="typing-dot" />
    </span>
  );
}

function ButtonSpinner() {
  return <span className="btn-spinner" aria-hidden="true" />;
}

function Notice({
  tone = "info",
  onDismiss,
  children,
}: {
  tone?: "info" | "error";
  onDismiss?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`notice ${tone === "error" ? "error" : ""}`} role={tone === "error" ? "alert" : "status"}>
      <span className="notice-text">{children}</span>
      {onDismiss && (
        <button type="button" className="notice-dismiss" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  );
}

export default function App() {
  const [userId, setUserId] = useState<string | null>(null);
  const [sessionState, setSessionState] = useState<"loading" | "ready" | "error">(
    "loading"
  );
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [connections, setConnections] =
    useState<Record<Toolkit, ConnectionState>>(initialConnections);
  const [connectionDetails, setConnectionDetails] =
    useState<Record<Toolkit, ConnectionDetail>>(initialConnectionDetails);
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [runTrace, setRunTrace] = useState<RunTrace | null>(null);
  const [traceState, setTraceState] = useState<"idle" | "loading" | "ready" | "error">(
    "idle"
  );
  const [traceError, setTraceError] = useState<string | null>(null);
  const [traceRefresh, setTraceRefresh] = useState(0);
  // Tracks which run's trace we've already shown, so background polls don't flash the
  // "Loading…" state on every refresh (only the first fetch of a new run does).
  const traceLoadedRunIdRef = useRef<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<WorkflowJob | null>(null);
  const [jobState, setJobState] = useState<JobState>("idle");
  const [jobError, setJobError] = useState<string | null>(null);
  const [jobRefresh, setJobRefresh] = useState(0);
  const [confirmingJob, setConfirmingJob] = useState(false);
  const [cancellingJob, setCancellingJob] = useState(false);
  const [jobActionError, setJobActionError] = useState<string | null>(null);
  const [confirmedActions, setConfirmedActions] = useState<Set<string>>(() => new Set());
  const [pendingActionStore, setPendingActionStore] = useState<Record<string, PendingAction>>({});
  const [confirmingAction, setConfirmingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Stick to the bottom only when the user is already there, so streaming tokens
  // don't yank them down while they scroll up to read earlier messages.
  const atBottomRef = useRef(true);
  const [showScrollDown, setShowScrollDown] = useState(false);

  const fileIds = useMemo(() => files.map((file) => file.id), [files]);
  const chatBody = useMemo(() => ({ userId, fileIds }), [userId, fileIds]);

  const { messages, input, setInput, handleInputChange, handleSubmit, isLoading, status, error, stop, setMessages, append } =
    useChat({
      api: "/api/chat",
      body: chatBody,
      keepLastMessageOnError: true,
      onResponse(response) {
        setChatError(null);
        const responseRunId =
          getString(response.headers.get("x-run-id")) ??
          getString(response.headers.get("x-mini-rube-run-id")) ??
          getString(response.headers.get("x-rube-run-id"));
        if (responseRunId) setRunId(responseRunId);

        const responseJobId =
          getString(response.headers.get("x-job-id")) ??
          getString(response.headers.get("x-mini-rube-job-id")) ??
          getString(response.headers.get("x-rube-job-id"));
        if (responseJobId) setJobId(responseJobId);
      },
      onError(err) {
        setChatError(err.message || "The chat request failed.");
      },
    });

  useEffect(() => {
    let cancelled = false;

    async function ensureSession() {
      const stored = window.localStorage.getItem(SESSION_KEY);
      if (stored) {
        setUserId(stored);
        setSessionState("ready");
        return;
      }

      setSessionState("loading");
      try {
        const response = await fetch("/api/session", { method: "POST" });
        if (!response.ok) throw new Error(`Session request failed (${response.status})`);

        const data = await response.json();
        const nextUserId = getSessionUserId(data);
        if (!nextUserId) throw new Error("Session response did not include a user id");

        if (!cancelled) {
          window.localStorage.setItem(SESSION_KEY, nextUserId);
          setUserId(nextUserId);
          setSessionState("ready");
        }
      } catch (err) {
        const fallbackUserId = createFallbackUserId();
        if (!cancelled) {
          window.localStorage.setItem(SESSION_KEY, fallbackUserId);
          setUserId(fallbackUserId);
          setSessionState("ready");
          setSessionError(err instanceof Error ? err.message : "Could not create session");
        }
      }
    }

    ensureSession();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const el = chatRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function handleChatScroll() {
    const el = chatRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottomRef.current = nearBottom;
    setShowScrollDown(!nearBottom && messages.length > 0);
  }

  function scrollChatToBottom() {
    const el = chatRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setShowScrollDown(false);
  }

  useEffect(() => {
    const latestRunId = [...messages]
      .reverse()
      .map((message) => extractRunIdFromText(message.content))
      .find(Boolean);

    if (latestRunId && latestRunId !== runId) setRunId(latestRunId);
  }, [messages, runId]);

  useEffect(() => {
    const latestJobId = [...messages]
      .reverse()
      .filter((message) => message.role === "assistant")
      .map((message) => extractJobIdFromText(message.content))
      .find(Boolean);

    if (latestJobId) {
      setJobId((current) => (current === latestJobId ? current : latestJobId));
    }
  }, [messages]);

  useEffect(() => {
    const currentUserId = userId ?? "";
    if (!currentUserId) return;

    let cancelled = false;

    async function loadConnections() {
      setConnectionError(null);
      setConnections((current) => ({
        googlesuper: current.googlesuper === "connected" ? "connected" : "checking",
        github: current.github === "connected" ? "connected" : "checking",
      }));

      try {
        const response = await fetch(
          `/api/connections?userId=${encodeURIComponent(currentUserId)}`
        );
        if (!response.ok) {
          throw new Error(`Connection status failed (${response.status})`);
        }

        const data = await response.json();
        if (!cancelled) {
          setConnections({
            googlesuper: readConnectionStatus(data, "googlesuper"),
            github: readConnectionStatus(data, "github"),
          });
          setConnectionDetails(readConnectionDetails(data));
        }
      } catch (err) {
        if (!cancelled) {
          setConnectionError(
            err instanceof Error ? err.message : "Could not load connection status"
          );
          setConnections({
            googlesuper: "error",
            github: "error",
          });
          setConnectionDetails(initialConnectionDetails);
        }
      }
    }

    loadConnections();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
	    if (!runId) {
	      setRunTrace(null);
	      setTraceState("idle");
	      setTraceError(null);
	      traceLoadedRunIdRef.current = null;
	      return;
	    }

    const controller = new AbortController();
    let cancelled = false;

	    async function loadTrace() {
	      const firstLoadForRun = traceLoadedRunIdRef.current !== runId;
	      if (firstLoadForRun) setTraceState("loading");
	      setTraceError(null);
	      try {
	        const response = await fetch(`/api/runs/${encodeURIComponent(runId!)}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Trace request failed (${response.status})`);

	        const data = await response.json();
	        if (!cancelled) {
	          setRunTrace(data);
	          setTraceState("ready");
	          traceLoadedRunIdRef.current = runId;
	        }
	      } catch (err) {
	        if (!cancelled && !(err instanceof DOMException && err.name === "AbortError")) {
	          if (firstLoadForRun) {
	            setRunTrace(null);
	            setTraceState("error");
	          } else {
	            setTraceState("ready");
	          }
	          setTraceError(err instanceof Error ? err.message : "Could not load run trace");
	        }
	      }
    }

    loadTrace();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [runId, traceRefresh]);

  useEffect(() => {
    const status = getTraceStatus(runTrace)?.toLowerCase();
    if (!runId || !status || !["queued", "pending", "running", "in_progress"].includes(status)) {
      return;
    }

    const timer = window.setTimeout(() => {
      setTraceRefresh((value) => value + 1);
    }, 3000);

    return () => window.clearTimeout(timer);
  }, [runId, runTrace]);

  useEffect(() => {
    if (!jobId) {
      setJob(null);
      setJobState("idle");
      setJobError(null);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    async function loadJob() {
      if (!job || job.id !== jobId) setJobState("loading");
      setJobError(null);
      try {
        const response = await fetch(`/api/jobs/${encodeURIComponent(jobId!)}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Job request failed (${response.status})`);

        const data = await response.json();
        const nextJob = readJob(data);
        if (!nextJob) throw new Error("Job response did not include a job");

        if (!cancelled) {
          setJob(nextJob);
          setJobState("ready");
        }
      } catch (err) {
        if (!cancelled && !(err instanceof DOMException && err.name === "AbortError")) {
          setJob(null);
          setJobState("error");
          setJobError(err instanceof Error ? err.message : "Could not load job");
        }
      }
    }

    loadJob();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [jobId, jobRefresh]);

  useEffect(() => {
    if (!jobId || !shouldPollJob(job)) return;

    const timer = window.setTimeout(() => {
      setJobRefresh((value) => value + 1);
    }, 3000);

    return () => window.clearTimeout(timer);
  }, [jobId, job]);

  // When a workflow finishes, report the result (and the sheet link) back in the
  // chat — not just the side panel — so the agent "tells" the user it's done.
  const notedJobsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!job) return;
    const status = job.status?.toLowerCase() ?? "";
    if (!["completed", "succeeded", "failed"].includes(status)) return;

    const key = `${job.id}:${status}`;
    if (notedJobsRef.current.has(key)) return;
    notedJobsRef.current.add(key);

    if (status === "failed") {
      appendSystemNote(`❌ The workflow could not finish${job.error ? `: ${job.error}` : "."}`);
      return;
    }

    const sheet =
      job.artifacts.find((artifact) => /docs\.google\.com\/spreadsheets/.test(artifact.url)) ??
      job.artifacts[0];
    const written = job.progress?.writtenRows;
    const rowsNote = typeof written === "number" && written > 0 ? ` with ${written.toLocaleString()} rows` : "";
    if (sheet) {
      appendSystemNote(`✅ Done — your Google Sheet is ready${rowsNote}: [Open the sheet](${sheet.url})`);
    } else {
      appendSystemNote("✅ Workflow completed.");
    }
  }, [job]);

  async function refreshConnections() {
    if (!userId) return;

    setConnections({
      googlesuper: "checking",
      github: "checking",
    });

    try {
      const response = await fetch(`/api/connections?userId=${encodeURIComponent(userId)}`);
      if (!response.ok) throw new Error(`Connection status failed (${response.status})`);

      const data = await response.json();
      setConnections({
        googlesuper: readConnectionStatus(data, "googlesuper"),
        github: readConnectionStatus(data, "github"),
      });
      setConnectionDetails(readConnectionDetails(data));
      setConnectionError(null);
    } catch (err) {
      setConnections({
        googlesuper: "error",
        github: "error",
      });
      setConnectionDetails(initialConnectionDetails);
      setConnectionError(
        err instanceof Error ? err.message : "Could not load connection status"
      );
    }
  }

  async function disconnect(toolkit: Toolkit) {
    if (!userId || connections[toolkit] === "connecting") return;
    setConnectionError(null);
    setConnectionNotice(null);
    setConnections((current) => ({ ...current, [toolkit]: "checking" }));
    try {
      const response = await fetch(`/api/connect/${toolkit}/disconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!response.ok) throw new Error(`Disconnect failed (${response.status})`);
    } catch (err) {
      setConnectionError(err instanceof Error ? err.message : `Could not disconnect ${TOOLKIT_LABELS[toolkit]}`);
    } finally {
      await refreshConnections();
    }
  }

  async function connect(toolkit: Toolkit, forceReconnect = false) {
    if (!userId) return;
    const currentUserId = userId;

    const existingAccess = connectionDetails[toolkit].requiredAccess;
    const existingAccessNotice =
      existingAccess.length > 0 ? summarizeRequiredAccess(toolkit, existingAccess) : null;

    setConnectionNotice(existingAccessNotice);
    setConnectionError(null);
    setConnections((current) => ({ ...current, [toolkit]: "connecting" }));

    const bodyObject = {
      userId: currentUserId,
      ...(forceReconnect ? { forceReconnect: true } : {}),
    };
    const body = JSON.stringify(bodyObject);
    let popup: Window | null = null;
    let closeTimer: number | null = null;
    let closedBeforeSuccess = false;
    let connected = false;
    let activeWaitController: AbortController | null = null;

    async function cancelPendingConnection(connectionId: string | null) {
      await fetch(`/api/connect/${toolkit}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, connectionId }),
      }).catch(() => null);
    }

    try {
      const response = await fetch(`/api/connect/${toolkit}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (!response.ok) throw new Error(`Connect failed (${response.status})`);

      const data = await response.json();
      const dataObj = getObject(data);
      const redirectUrl = getString(dataObj?.redirectUrl) ?? getString(dataObj?.url);
      const connectionId = getString(dataObj?.connectionId);
      const accessItems = normalizeRequiredAccess(dataObj?.requiredAccess);
      const accessNotice = summarizeRequiredAccess(toolkit, dataObj?.requiredAccess);
      if (accessItems.length > 0) {
        setConnectionDetails((current) => ({
          ...current,
          [toolkit]: {
            ...current[toolkit],
            status: "connecting",
            requiredAccess: accessItems,
            error: undefined,
          },
        }));
      }
      setConnectionNotice(
        accessNotice ?? `Opening ${TOOLKIT_LABELS[toolkit]} authorization...`
      );

      if (redirectUrl) {
        popup = window.open(redirectUrl, "_blank", "width=600,height=700");
        if (!popup) {
          await cancelPendingConnection(connectionId);
          throw new Error("Authorization popup was blocked. Allow popups and try again.");
        }
      }

      const popupClosedPromise =
        popup == null
          ? null
          : new Promise<"popup-closed">((resolve) => {
              closeTimer = window.setInterval(() => {
                if (popup?.closed) resolve("popup-closed");
              }, 400);
            });

      const deadline = Date.now() + 120_000;
      let waitData: unknown = null;

      async function waitForConnection(timeoutMs = 8_000) {
        activeWaitController = new AbortController();
        const waitResponse = await fetch(`/api/connect/${toolkit}/wait`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...bodyObject, connectionId, timeoutMs }),
          signal: activeWaitController.signal,
        });
        if (!waitResponse.ok) {
          throw new Error(`Connection wait failed (${waitResponse.status})`);
        }
        return waitResponse.json();
      }

      async function loadCurrentConnectionState() {
        const statusResponse = await fetch(
          `/api/connections?userId=${encodeURIComponent(currentUserId)}`
        );
        if (!statusResponse.ok) return "disconnected";
        const statusData = await statusResponse.json();
        return readConnectionStatus(statusData, toolkit);
      }

      while (Date.now() < deadline) {
        const waitPromise = waitForConnection();

        const result = popupClosedPromise
          ? await Promise.race([waitPromise, popupClosedPromise])
          : await waitPromise;

        if (result === "popup-closed") {
          (activeWaitController as AbortController | null)?.abort();
          setConnectionNotice(
            `${TOOLKIT_LABELS[toolkit]} authorization window closed. Verifying connection...`
          );

          try {
            waitData = await waitForConnection(12_000);
            connected = getBoolean(getObject(waitData)?.connected) === true;
          } catch (err) {
            if (!(err instanceof DOMException && err.name === "AbortError")) {
              const statusAfterClose = await loadCurrentConnectionState().catch(() => "disconnected");
              connected = statusAfterClose === "connected";
              waitData = { connected };
            }
          }

          if (!connected) {
            const statusAfterClose = await loadCurrentConnectionState().catch(() => "disconnected");
            connected = statusAfterClose === "connected";
            if (connected) {
              waitData = { connected };
            }
          }

          if (connected) {
            break;
          }

          closedBeforeSuccess = true;
          await cancelPendingConnection(connectionId);
          setConnections((current) => ({ ...current, [toolkit]: "disconnected" }));
          setConnectionNotice(
            `${TOOLKIT_LABELS[toolkit]} authorization was closed before it completed.`
          );
          await refreshConnections();
          return;
        }

        waitData = result;
        const waitObj = getObject(waitData);
        connected = getBoolean(waitObj?.connected) === true;
        const waitStatus = getString(waitObj?.status)?.toLowerCase();

        if (connected) {
          break;
        }

        if (waitStatus === "cancelled") {
          setConnections((current) => ({ ...current, [toolkit]: "disconnected" }));
          setConnectionNotice(`${TOOLKIT_LABELS[toolkit]} authorization was cancelled.`);
          return;
        }

        if (waitStatus === "pending" || waitStatus === "timeout") {
          setConnectionNotice(
            `${TOOLKIT_LABELS[toolkit]} authorization is still waiting for OAuth completion...`
          );
          continue;
        }

        setConnections((current) => ({ ...current, [toolkit]: "disconnected" }));
        setConnectionNotice(
          `${TOOLKIT_LABELS[toolkit]} is not connected yet. Reconnect after completing authorization.`
        );
        return;
      }

      if (!connected) {
        await cancelPendingConnection(connectionId);
        setConnections((current) => ({ ...current, [toolkit]: "disconnected" }));
        setConnectionNotice(
          `${TOOLKIT_LABELS[toolkit]} authorization timed out. Reconnect when you are ready.`
        );
        return;
      }

      setConnections((current) => ({
        ...current,
        [toolkit]: readConnectionStatus(
          { [toolkit]: getObject(waitData)?.connected ?? waitData },
          toolkit
        ),
      }));
      setConnectionNotice(`${TOOLKIT_LABELS[toolkit]} connected.`);
      await refreshConnections();
    } catch (err) {
      if (closedBeforeSuccess || (err instanceof DOMException && err.name === "AbortError")) {
        return;
      }
      setConnections((current) => ({ ...current, [toolkit]: "error" }));
      setConnectionError(err instanceof Error ? err.message : `Could not connect ${toolkit}`);
    } finally {
      activeWaitController = null;
      if (closeTimer != null) window.clearInterval(closeTimer);
      if (connected && popup && !popup.closed) popup.close();
    }
  }

  async function uploadFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setUploadError("Only PDF files can be attached.");
      event.target.value = "";
      return;
    }

    if (!userId) {
      setUploadError("Session is still loading.");
      event.target.value = "";
      return;
    }

    setUploading(true);
    setUploadError(null);

    try {
      const formData = new FormData();
      formData.append("userId", userId);
      formData.append("file", file);

      const response = await fetch("/api/files", {
        method: "POST",
        body: formData,
      });
      if (!response.ok) throw new Error(`Upload failed (${response.status})`);

      const data = await response.json();
      const id = extractUploadedFileId(data);
      if (!id) throw new Error("Upload response did not include a file id");

      setFiles((current) => {
        if (current.some((item) => item.id === id)) return current;
        return [...current, { id, name: file.name }];
      });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Could not upload file");
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  }

  function removeFile(fileId: string) {
    setFiles((current) => current.filter((file) => file.id !== fileId));
  }

  function submitChat(event: React.FormEvent<HTMLFormElement>) {
    setChatError(null);
    handleSubmit(event, { body: chatBody });
  }

  // Drop the example into the input (rather than auto-sending) so the user can
  // tailor it first — add their Drive folder link, repo, or recipient.
  function fillExample(prompt: string) {
    if (!userId || chatBusy) return;
    setChatError(null);
    setInput(prompt);
    document.querySelector<HTMLInputElement>(".input-bar input:not([type=file])")?.focus();
  }

  // Follow-up quick actions auto-send (one-click refine/expand on a completed read).
  function sendFollowUp(prompt: string) {
    if (!userId || chatBusy) return;
    setChatError(null);
    void append({ role: "user", content: prompt }, { body: chatBody });
  }

  function resetChatState() {
    stop();
    setMessages([]);
    setRunId(null);
    setRunTrace(null);
    setTraceState("idle");
    setTraceError(null);
    setJobId(null);
    setJob(null);
    setJobState("idle");
    setJobError(null);
    setConfirmingJob(false);
    setCancellingJob(false);
    setJobActionError(null);
    setActionError(null);
    setChatError(null);
    setPendingActionStore({});
    setConfirmedActions(new Set());
  }

  async function confirmJob() {
    if (!userId || !jobId || confirmingJob) return;

    setJobActionError(null);
    setConfirmingJob(true);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIRM_TIMEOUT_MS);
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Job confirmation failed (${response.status})`);

      const data = await response.json().catch(() => null);
      const confirmedJob = readJob(data);
      if (confirmedJob) {
        // The POST usually returns before the workflow has flipped the status off the
        // gate. Optimistically clear the approval flags so the Confirm card disappears
        // the instant the click registers (no "did it work?" gap), while leaving the
        // phase alone — the phase-driven heading keeps showing "Ready to write" until
        // real write progress streams in. Subsequent polls overwrite this.
        setJob(
          jobHasConfirmationRequest(confirmedJob)
            ? { ...confirmedJob, status: "running", approvalStatus: "not_required" }
            : confirmedJob
        );
        setJobState("ready");
      }
      setJobRefresh((value) => value + 1);
    } catch (err) {
      if (controller.signal.aborted) {
        setJobActionError(
          "This is taking longer than expected. The job may still be starting — use Refresh to check its status."
        );
      } else {
        setJobActionError(err instanceof Error ? err.message : "Could not confirm job");
      }
    } finally {
      clearTimeout(timeout);
      setConfirmingJob(false);
    }
  }

  async function cancelJob() {
    if (!userId || !jobId || !canCancelJob(job)) return;

    setJobActionError(null);
    setCancellingJob(true);

    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!response.ok) throw new Error(`Job cancellation failed (${response.status})`);

      const data = await response.json().catch(() => null);
      const cancelledJob = readJob(data);
      if (cancelledJob) {
        setJob(cancelledJob);
        setJobState("ready");
      } else {
        setJob((current) =>
          current && current.id === jobId ? { ...current, status: "cancelled", phase: "cancelled" } : current
        );
        setJobRefresh((value) => value + 1);
      }
    } catch (err) {
      setJobActionError(err instanceof Error ? err.message : "Could not cancel job");
    } finally {
      setCancellingJob(false);
    }
  }

  function appendSystemNote(content: string) {
    setMessages((current) => [
      ...current,
      {
        id: `note-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role: "assistant" as const,
        content,
      },
    ]);
  }

  async function confirmAction(actionId: string) {
    if (!userId || confirmingAction) return;

    const label = pendingActions.find((action) => action.id === actionId)?.title ?? "The action";
    setActionError(null);
    setConfirmingAction(actionId);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIRM_TIMEOUT_MS);
    try {
      const response = await fetch(`/api/actions/${encodeURIComponent(actionId)}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);

      // Remove it from the pending list either way.
      setConfirmedActions((current) => {
        const next = new Set(current);
        next.add(actionId);
        return next;
      });

      if (!response.ok) {
        const message = getString(getObject(data)?.error) ?? `Confirm failed (${response.status})`;
        setActionError(message);
        appendSystemNote(`❌ ${label} could not be completed: ${message}`);
        return;
      }

      // Feedback to the user + a record the agent can see on the next turn.
      appendSystemNote(`✅ ${label} completed.`);
      setTraceRefresh((value) => value + 1);
    } catch (err) {
      if (controller.signal.aborted) {
        // The fetch was aborted by our timeout. A mutating action may still finish
        // server-side, so we keep it in the pending list (so a real failure can be
        // retried) but warn against blindly re-confirming.
        setActionError(
          "This is taking longer than expected. The action may still complete on the server — check the result (e.g. your inbox) before retrying to avoid duplicates."
        );
      } else {
        setActionError(err instanceof Error ? err.message : "Could not confirm action");
      }
    } finally {
      clearTimeout(timeout);
      setConfirmingAction(null);
    }
  }

  const messagePendingActions = useMemo(() => {
    const actions = new Map<string, PendingAction>();
    messages.forEach((message) => {
      if (message.role !== "assistant") return;
      extractPendingActionsFromText(message.content).forEach((action) => {
        actions.set(action.id, action);
      });
    });
    return [...actions.values()];
  }, [messages]);

  // Accumulate pending actions seen in any run's trace so the confirm button
  // does not vanish if the user sends a follow-up before approving (which would
  // otherwise switch runId away from the run that holds the pending action).
  useEffect(() => {
    const found = collectTracePendingActions(runTrace);
    if (found.length === 0) return;
    setPendingActionStore((current) => {
      const next = { ...current };
      for (const action of found) {
        next[action.id] = { ...next[action.id], ...action };
      }
      return next;
    });
  }, [runTrace]);

  const pendingActions = useMemo(() => {
    const actions = new Map<string, PendingAction>();
    messagePendingActions.forEach((action) => actions.set(action.id, action));
    Object.values(pendingActionStore).forEach((action) => {
      const existing = actions.get(action.id);
      actions.set(
        action.id,
        existing
          ? { ...existing, ...action, label: existing.label ?? action.label }
          : action
      );
    });
    return [...actions.values()].filter((action) => !confirmedActions.has(action.id));
  }, [confirmedActions, messagePendingActions, pendingActionStore]);

  const traceItems = useMemo(() => collectTraceItems(runTrace), [runTrace]);
  const traceStatus = getTraceStatus(runTrace);
  const jobProgressPercent = getJobProgressPercent(job);
  const jobInDiscovery = isJobInDiscovery(job);
  const jobReadyToWrite = isJobReadyToWrite(job);
  const jobDisplayPhase = getJobDisplayPhase(job);
  const formattedJobUpdatedAt = formatJobDate(job?.updatedAt);
  const canConfirmJob = jobNeedsConfirmation(job);
  // Only treat the job as awaiting approval when it isn't already doing active work.
  // Guards against the brief poll window where status can lag behind the phase right
  // after the user confirms (phase flips to writing before the next status refresh).
  const showJobConfirmation =
    canConfirmJob && !ACTIVE_WORK_PHASES.has(normalizeJobValue(jobDisplayPhase));
  const firstPendingAction = pendingActions[0];
  const primaryApproval: PrimaryApproval | null = showJobConfirmation && job
    ? {
        kind: "job",
        title: "Workflow approval required",
        summary: job.approvalSummary ?? `Approve workflow ${job.type}.`,
        confirmLabel: "Confirm workflow",
        confirming: confirmingJob,
        disabled: !userId || confirmingJob || !canConfirmJob,
        onConfirm: confirmJob,
      }
    : firstPendingAction
      ? {
          kind: "action",
          title: firstPendingAction.title ?? firstPendingAction.label ?? "Pending action",
          summary: summarizeActionForDock(firstPendingAction),
          confirmLabel: "Confirm action",
          confirming: confirmingAction === firstPendingAction.id,
          disabled: !userId || confirmingAction !== null,
          onConfirm: () => confirmAction(firstPendingAction.id),
        }
      : null;
	  const cancellableJob = canCancelJob(job);
  const jobTerminalMessage = getJobTerminalMessage(job);
  const sessionLabel = userId ? userId.slice(0, 12) : "loading";
  const chatBusy = status === "submitted" || status === "streaming" || isLoading;
  const chatFailed = status === "error" || Boolean(error || chatError);
  const canSend = Boolean(userId && input.trim() && !chatBusy);
  const noConnections = TOOLKITS.every((toolkit) => connections[toolkit] !== "connected");
  // Keep the side panel (run trace / workflow job / confirmations) collapsed until
  // there's actually something to show, so the empty/first-load state is chat-first
  // instead of ~30% placeholders.
  const showSidePanel = Boolean(runId || jobId) || pendingActions.length > 0;
  // Contextual quick-action chips after a completed read (load more / refine).
  const followUpSuggestions = useMemo(() => {
    if (chatBusy || pendingActions.length > 0 || jobId) return [];
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return [];
    return followUpsForTools(getTraceSelectedTools(runTrace));
  }, [chatBusy, pendingActions.length, jobId, messages, runTrace]);
  // The agent often streams a line ("Let me retrieve them now"), then runs a slow
  // tool with no new tokens. Keep a "Working…" indicator visible the whole time the
  // request is in flight after the assistant has already shown some text, so the UI
  // never looks frozen.
  const lastMessage = messages[messages.length - 1];
  const lastAssistantContent =
    lastMessage?.role === "assistant" ? cleanAssistantContent(lastMessage.content) : "";
  const showWorkingRow =
    chatBusy && lastMessage?.role === "assistant" && Boolean(lastAssistantContent) && lastAssistantContent !== "…";

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <h1>Mini Rube</h1>
          <span className={`session-pill ${sessionState}`}>
            {sessionState === "loading" ? "Session loading" : `User ${sessionLabel}`}
          </span>
        </div>

        <div className="connections" aria-label="Connections">
          {TOOLKITS.map((toolkit) => (
            <span className="connect-control" key={toolkit}>
              <button
                className={`connect-btn ${connections[toolkit]}`}
                type="button"
                onClick={() =>
                  connect(
                    toolkit,
                    connections[toolkit] === "connected" || connections[toolkit] === "error"
                  )
                }
                disabled={!userId || connections[toolkit] === "connecting"}
                title={
                  connections[toolkit] === "connected"
                    ? `Connected${connectionDetails[toolkit].accountId ? ` as ${connectionDetails[toolkit].accountId}` : ""} — click to reconnect`
                    : connectionDetails[toolkit].accountId
                      ? `${TOOLKIT_LABELS[toolkit]} account ${connectionDetails[toolkit].accountId}`
                      : `Connect ${TOOLKIT_LABELS[toolkit]}`
                }
              >
                <span className="status-dot" aria-hidden="true" />
                {getConnectionButtonLabel(toolkit, connections[toolkit])}
              </button>
              {connections[toolkit] === "connected" && (
                <button
                  className="disconnect-btn"
                  type="button"
                  onClick={() => disconnect(toolkit)}
                  disabled={!userId}
                  title={`Disconnect ${TOOLKIT_LABELS[toolkit]}`}
                  aria-label={`Disconnect ${TOOLKIT_LABELS[toolkit]}`}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      </header>

      <div className={`workspace${showSidePanel ? "" : " chat-only"}`}>
        <section className="chat-panel" aria-label="Chat">
          {(sessionError ||
            connectionNotice ||
            connectionError ||
            uploadError ||
            jobActionError ||
            actionError ||
            chatError) && (
            <div className="notice-stack" aria-live="polite">
              {sessionError && (
                <Notice onDismiss={() => setSessionError(null)}>
                  Session API unavailable; using a browser-local id.
                </Notice>
              )}
              {connectionNotice && (
                <Notice onDismiss={() => setConnectionNotice(null)}>{connectionNotice}</Notice>
              )}
              {connectionError && (
                <Notice tone="error" onDismiss={() => setConnectionError(null)}>{connectionError}</Notice>
              )}
              {uploadError && (
                <Notice tone="error" onDismiss={() => setUploadError(null)}>{uploadError}</Notice>
              )}
              {jobActionError && (
                <Notice tone="error" onDismiss={() => setJobActionError(null)}>{jobActionError}</Notice>
              )}
              {actionError && (
                <Notice tone="error" onDismiss={() => setActionError(null)}>{actionError}</Notice>
              )}
              {chatError && (
                <Notice tone="error" onDismiss={() => setChatError(null)}>{chatError}</Notice>
              )}
            </div>
          )}

          <div className="chat" ref={chatRef} onScroll={handleChatScroll}>
            {messages.length === 0 && (
              <div className="empty-chat">
                <h2>What should the agent do?</h2>
                <p>
                  Chat to work across Gmail, Google Calendar, Drive, Sheets, and GitHub. The agent
                  discovers and picks the right tools for each request.
                </p>
                {noConnections && (
                  <p className="empty-hint">Connect Google or GitHub above to get started.</p>
                )}
                <div className="example-prompts" aria-label="Example prompts">
                  {EXAMPLE_PROMPTS.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      className="example-chip"
                      onClick={() => fillExample(prompt)}
                      disabled={!userId || chatBusy}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((message, index) => {
              const isLast = index === messages.length - 1;
              const cleaned =
                message.role === "assistant" ? cleanAssistantContent(message.content) : message.content;
              // While streaming, the last assistant bubble can be empty ("…")
              // before the first token — show the typing animation instead.
              if (message.role === "assistant" && isLast && chatBusy && (!cleaned || cleaned === "…")) {
                return (
                  <div key={message.id} className="msg assistant">
                    <TypingDots />
                  </div>
                );
              }
              return (
                <div key={message.id} className={`msg ${message.role}`}>
                  {message.role === "assistant" ? <Markdown text={cleaned} /> : message.content}
                </div>
              );
            })}
            {/* The agent hasn't created its response bubble yet (e.g. running a tool). */}
            {chatBusy && messages[messages.length - 1]?.role === "user" && (
              <div className="msg assistant">
                <TypingDots />
              </div>
            )}
            {/* Agent has shown some text but is still working (e.g. a slow tool call). */}
            {showWorkingRow && (
              <div className="working-row" role="status" aria-label="Assistant is working">
                <TypingDots />
                <span>Working…</span>
              </div>
            )}
            {/* Chat/stream errors surface in the dismissible notice stack above (chatError),
                so we don't also render them inline here. */}
          </div>

          {showScrollDown && (
            <button
              type="button"
              className="scroll-down-btn"
              onClick={scrollChatToBottom}
              aria-label="Scroll to latest messages"
              title="Scroll to latest"
            >
              ↓
            </button>
          )}

          {files.length > 0 && (
            <div className="attachment-strip" aria-label="Attached files">
              {files.map((file) => (
                <span className="file-chip" key={file.id}>
                  <span>{file.name}</span>
                  <button
                    type="button"
                    onClick={() => removeFile(file.id)}
                    title={`Remove ${file.name}`}
                    aria-label={`Remove ${file.name}`}
                  >
                    x
                  </button>
                </span>
              ))}
            </div>
          )}

          {followUpSuggestions.length > 0 && (
            <div className="followups" aria-label="Suggested follow-ups">
              {followUpSuggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="followup-chip"
                  onClick={() => sendFollowUp(s)}
                  disabled={!userId || chatBusy}
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          <form className="input-bar" onSubmit={submitChat}>
            <label className="upload-btn">
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf,.pdf"
                onChange={uploadFile}
                disabled={!userId || uploading}
              />
              {uploading ? "Uploading" : "PDF"}
            </label>
            <input
              value={input}
              onChange={handleInputChange}
              placeholder="Ask the agent to plan, search, draft, or act..."
              autoComplete="off"
              disabled={chatBusy || !userId}
            />
            <button type="submit" disabled={!canSend}>
              {chatBusy ? "Sending" : "Send"}
            </button>
            {chatBusy && (
              <button className="secondary-action" type="button" onClick={stop}>
                Stop
              </button>
            )}
            {(messages.length > 0 || chatFailed) && !chatBusy && (
              <button className="secondary-action" type="button" onClick={resetChatState}>
                Reset
              </button>
            )}
          </form>
        </section>

	        {showSidePanel && (
	        <aside className="side-panel" aria-label="Run progress and confirmations">
	          <div className="side-panel-scroll">
	          <section className="panel-section">
            <div className="panel-heading">
              <div>
                <h2>Run Trace</h2>
                <p title={runId ?? undefined}>{runId ? `Run ${shortId(runId)}` : "No run selected"}</p>
              </div>
              <button
                className="ghost-btn"
                type="button"
                onClick={() => setTraceRefresh((value) => value + 1)}
                disabled={!runId || traceState === "loading"}
              >
                Refresh
              </button>
            </div>

            <div className="trace-body">
              {traceState === "idle" && <p className="muted">Trace appears after a run id is available.</p>}
              {traceState === "loading" && <p className="muted">Loading trace...</p>}
              {traceState === "error" && (
                <p className="muted error-text">{traceError ?? "Trace unavailable."}</p>
              )}
              {traceState === "ready" && (
                <>
                  <div className="trace-status">
                    <span>Status</span>
                    <strong>{traceStatus ?? "unknown"}</strong>
                  </div>
                  {traceItems.length > 0 ? (
                    <ol className="trace-list">
                      {traceItems.map((item) => (
                        <li key={item.id}>
                          <div>
                            <strong>{item.title}</strong>
                            {item.detail && <p>{item.detail}</p>}
                          </div>
                          {item.status && <span>{item.status}</span>}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <pre className="trace-json">{summarizeTrace(runTrace)}</pre>
                  )}
                </>
              )}
            </div>
          </section>

          <section className="panel-section">
            <div className="panel-heading">
              <div>
                <h2>Workflow Job</h2>
                <p title={jobId ?? undefined}>{jobId ? `Job ${shortId(jobId)}` : "No job selected"}</p>
              </div>
              <button
                className="ghost-btn"
                type="button"
                onClick={() => setJobRefresh((value) => value + 1)}
                disabled={!jobId || jobState === "loading"}
              >
                Refresh
              </button>
            </div>

            <div className="job-body">
              {jobState === "idle" && <p className="muted">Job progress appears after a job id is available.</p>}
              {jobState === "loading" && <p className="muted">Loading job...</p>}
              {jobState === "error" && (
                <p className="muted error-text">{jobError ?? "Job unavailable."}</p>
              )}
              {jobState === "ready" && job && (
                <>
                  <div className="job-status-grid">
                    <div>
                      <span>Type</span>
                      <strong>{job.type}</strong>
                    </div>
                    <div>
                      <span>Status</span>
                      <strong>{job.status}</strong>
                    </div>
                    <div>
                      <span>Approval</span>
                      <strong>{job.approvalStatus}</strong>
                    </div>
                    {jobDisplayPhase && (
                      <div>
                        <span>Phase</span>
                        <strong>{jobDisplayPhase}</strong>
                      </div>
                    )}
                    {formattedJobUpdatedAt && (
                      <div>
                        <span>Updated</span>
                        <strong>{formattedJobUpdatedAt}</strong>
                      </div>
                    )}
                  </div>

                  {jobTerminalMessage && (
                    <p className="job-terminal">{jobTerminalMessage}</p>
                  )}

                  {cancellableJob && (
                    <div className="job-actions">
                      <button
                        className="danger-action"
                        type="button"
                        onClick={cancelJob}
                        disabled={!userId || cancellingJob}
                      >
                        {cancellingJob ? "Cancelling" : "Cancel job"}
                      </button>
                    </div>
                  )}

                  <div className="job-progress">
                    <div className="job-progress-heading">
                      <span>Progress</span>
                      <strong>
                        {jobInDiscovery
                          ? `${job.progress.fetchedItems.toLocaleString()} so far…`
                          : jobReadyToWrite
                            ? "Ready to write"
                            : jobProgressPercent == null
                              ? "No total"
                              : `${jobProgressPercent}%`}
                      </strong>
                    </div>
                    <div
                      className={`job-progress-bar${jobInDiscovery ? " indeterminate" : ""}`}
                      role="progressbar"
                      aria-label="Workflow job progress"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={jobInDiscovery ? undefined : jobProgressPercent ?? undefined}
                    >
                      <span style={jobInDiscovery ? undefined : { width: `${jobProgressPercent ?? 0}%` }} />
                    </div>
                    <dl className="job-metrics">
                      <div>
                        <dt>Total</dt>
                        <dd>{jobInDiscovery ? "—" : job.progress.totalItems.toLocaleString()}</dd>
                      </div>
                      <div>
                        <dt>Fetched</dt>
                        <dd>{job.progress.fetchedItems.toLocaleString()}</dd>
                      </div>
                      <div>
                        <dt>Processed</dt>
                        <dd>{job.progress.processedItems.toLocaleString()}</dd>
                      </div>
                      <div>
                        <dt>Written</dt>
                        <dd>{job.progress.writtenRows.toLocaleString()}</dd>
                      </div>
                      <div>
                        <dt>Failed</dt>
                        <dd>{job.progress.failedItems.toLocaleString()}</dd>
                      </div>
                    </dl>
                  </div>

                  {showJobConfirmation && (
                    <div className="job-approval">
                      <div>
                        <strong>Workflow approval required</strong>
                        <p>{job.approvalSummary ?? `Approve workflow ${job.type}.`}</p>
                      </div>
                      <button
                        type="button"
                        className={confirmingJob ? "is-confirming" : undefined}
                        onClick={confirmJob}
                        disabled={!userId || confirmingJob || !canConfirmJob}
                      >
                        {confirmingJob ? (
                          <>
                            <ButtonSpinner />
                            Confirming…
                          </>
                        ) : (
                          "Confirm"
                        )}
                      </button>
                    </div>
                  )}

                  {job.error && <p className="job-error">{job.error}</p>}

                  {job.artifacts.length > 0 && (
                    <div className="artifact-list">
                      <h3>Artifacts</h3>
                      <ul>
                        {job.artifacts.map((artifact) => (
                          <li key={`${artifact.label}-${artifact.url}`}>
                            <a href={artifact.url} target="_blank" rel="noreferrer">
                              {artifact.label}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
          </section>

          <section className="panel-section">
            <div className="panel-heading">
              <div>
                <h2>Confirmations</h2>
                <p>{pendingActions.length ? `${pendingActions.length} pending` : "None pending"}</p>
              </div>
            </div>

            <div className="pending-list">
              {pendingActions.length === 0 ? (
                <p className="muted">Actions that need approval will appear here.</p>
              ) : (
                pendingActions.map((action) => (
                  <div className="pending-action" key={action.id}>
                    <div className="pending-action-info">
                      <strong>{action.title ?? action.label ?? "Pending action"}</strong>
                      {action.details && action.details.length > 0 ? (
                        <dl className="pending-action-details">
                          {action.details.map((detail) => (
                            <div key={detail.label}>
                              <dt>{detail.label}</dt>
                              <dd>{detail.value}</dd>
                            </div>
                          ))}
                        </dl>
                      ) : (
                        <p className="pending-action-note">Awaiting your approval before it runs.</p>
                      )}
                    </div>
                    <button
                      type="button"
                      className={confirmingAction === action.id ? "is-confirming" : undefined}
                      onClick={() => confirmAction(action.id)}
                      disabled={confirmingAction !== null}
                    >
                      {confirmingAction === action.id ? (
                        <>
                          <ButtonSpinner />
                          Confirming…
                        </>
                      ) : (
                        "Confirm"
                      )}
                    </button>
                  </div>
                ))
              )}
            </div>
	          </section>
	          </div>
	          {primaryApproval && (
	            <div className={`approval-dock ${primaryApproval.kind}`}>
	              <div className="approval-dock-copy">
	                <strong>{primaryApproval.title}</strong>
	                <p>{primaryApproval.summary}</p>
	              </div>
	              <button
	                type="button"
	                className={primaryApproval.confirming ? "is-confirming" : undefined}
	                onClick={primaryApproval.onConfirm}
	                disabled={primaryApproval.disabled}
	              >
	                {primaryApproval.confirming ? (
	                  <>
	                    <ButtonSpinner />
	                    <span>Confirming</span>
	                  </>
	                ) : (
	                  primaryApproval.confirmLabel
	                )}
	              </button>
	            </div>
	          )}
	        </aside>
	        )}
      </div>
    </main>
  );
}
