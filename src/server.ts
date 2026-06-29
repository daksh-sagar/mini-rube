import { createDataStreamResponse, formatDataStreamPart, streamText, tool, jsonSchema, type CoreMessage } from "ai";
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { AUTH_CONFIGS } from "./lib/composio";
import { connectAccount, deleteConnectedAccount, deleteConnectedAccountsForToolkit, getConnectedAccounts } from "./lib/auth";
import { authRequirementsForToolkit } from "./lib/auth-requirements";
import { executeTool } from "./lib/tools";
import { AGENT_MAX_TOKENS, AGENT_MODEL, agentModel } from "./lib/llm";
import { uploadPdfToComposio, type UploadedFileRef } from "./lib/files";
import { normalizeToolError, toolErrorForModel } from "./lib/tool-errors";
import { applyPromptLimitToToolArgs, buildRetryArgs, isMutatingToolSlug, normalizeToolArgs } from "./lib/tool-recovery";
import { compactToolResult } from "./lib/tool-results";
import { maybePaginateCollectionRead } from "./lib/tool-pagination";
import {
  getToolCatalog,
  getToolInputSchema,
  getToolSlug,
  loadToolSchemas,
  supportedToolkits,
  supportedToolSlugs,
} from "./lib/tool-catalog";
import { routeToolsForPrompt } from "./lib/router";
import { DEFAULT_CALENDAR_TIMEZONE, parseCalendarEventDraft, type CalendarEventDraft } from "./lib/calendar-intent";
import { createSqliteWorkflowStore, type WorkflowJob } from "./lib/job-store";
import {
  createWorkflowService,
  isWorkflowIntent,
  workflowIdOf,
  resolveDriveFolderRequest,
  resolveDriveFolderReply,
  resolveGithubRepoRequest,
  type ApprovalGrant,
  type ApprovalRequest,
  type WorkflowDefinition,
  type WorkflowArtifact,
} from "./lib/workflows";
import type { ComposioToolSchema, PendingAction, RouteToolsResult, RunState, RunTraceEntry } from "./lib/types";

type PendingConnection = {
  link: Awaited<ReturnType<typeof connectAccount>>;
  userId: string;
  toolkit: string;
  connectionId: string;
  redirectUrl?: string;
  createdAt: string;
};

type ActiveTaskIntentId = "calendar.schedule";

type ActiveTask = {
  id: string;
  userId: string;
  intentId: ActiveTaskIntentId;
  promptHistory: string[];
  selectedTools: string[];
  rationale: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
};

const pendingConnections = new Map<string, PendingConnection>();
const uploadedFiles = new Map<string, UploadedFileRef>();
const pendingActions = new Map<string, PendingAction>();
const runs = new Map<string, RunState>();
const activeTasks = new Map<string, ActiveTask>();
const workflowApprovals = new Map<
  string,
  { request: ApprovalRequest; resolve: (grant: ApprovalGrant) => void }
>();
const preApprovedWorkflowJobs = new Set<string>();
const workflowJobRuns = new Map<string, string>();
const cancelledWorkflowJobs = new Set<string>();
const CLEAR_ACTIVE_JOB_HEADER = "x-mini-rube-clear-active-job";
const PORT = Number(process.env.PORT ?? 3001);
const IDLE_TIMEOUT_SECONDS = Number(process.env.BUN_IDLE_TIMEOUT ?? 120);
const STATIC_DIR = resolve(import.meta.dir, "app/dist");
const ACTIVE_TASK_TTL_MS = 10 * 60 * 1000;
const ACTIVE_TASK_HISTORY_LIMIT = 12;
const CALENDAR_SCHEDULE_INTENT_ID: ActiveTaskIntentId = "calendar.schedule";
const CALENDAR_SCHEDULE_SLUGS = [
  "GOOGLESUPER_CREATE_EVENT",
  "GOOGLESUPER_FIND_FREE_SLOTS",
  "GOOGLESUPER_EVENTS_LIST",
  "GOOGLESUPER_GET_CONTACTS",
  "GOOGLESUPER_SEARCH_PEOPLE",
  "GOOGLESUPER_GET_CURRENT_DATE_TIME",
];
const workflowStore = await createSqliteWorkflowStore({
  databasePath: process.env.WORKFLOW_DB_PATH ?? ".mini-rube/workflows.sqlite",
});
const workflowService = createWorkflowService({
  store: workflowStore,
  executeTool: async (slug, args, context) => executeTool(slug, context.userId, args),
  requestApproval: requestWorkflowApproval,
  isCancelled: async (jobId) => {
    if (cancelledWorkflowJobs.has(jobId)) {
      return true;
    }
    const job = await workflowStore.getJob(jobId);
    return job?.status === "cancelled";
  },
  defaults: {
    sheetBatchSize: Number(process.env.WORKFLOW_SHEET_BATCH_SIZE ?? 100),
    pageSize: Number(process.env.WORKFLOW_PAGE_SIZE ?? 100),
    workflowConcurrency: Number(process.env.WORKFLOW_CONCURRENCY ?? 8),
    sheetValueMode: "googleValues",
    workerId: `server_${process.pid}`,
    // The resume prompt explicitly asks for name/university/last-job, which
    // deterministic parsing can't reliably pull from arbitrary PDFs. Default to
    // LLM-assisted extraction; set WORKFLOW_USE_LLM_EXTRACTION=0 to opt out.
    useLlmExtraction: process.env.WORKFLOW_USE_LLM_EXTRACTION !== "0",
  },
});

function makeId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function connectionKey(userId: string, toolkit: string) {
  return `${userId}:${toolkit}`;
}

function nowIso() {
  return new Date().toISOString();
}

function createRun(userId: string, prompt: string, selectedTools: string[], rationale: string): RunState {
  const now = nowIso();
  const run: RunState = {
    id: makeId("run"),
    userId,
    status: "running",
    prompt,
    selectedTools,
    rationale,
    startedAt: now,
    updatedAt: now,
    traces: [],
    pendingActions: [],
    artifacts: [],
  };
  runs.set(run.id, run);
  addTrace(run, {
    type: "plan",
    title: "Selected tools",
    detail: `${selectedTools.join(", ")} (${rationale})`,
  });
  return run;
}

function addTrace(run: RunState, entry: Omit<RunTraceEntry, "id" | "at">) {
  run.traces.push({
    id: makeId("trace"),
    at: nowIso(),
    ...entry,
  });
  run.updatedAt = nowIso();
}

function latestUserText(messages: CoreMessage[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") {
      continue;
    }
    if (typeof message.content === "string") {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join("\n");
    }
  }
  return "";
}

function latestAssistantText(messages: CoreMessage[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join("\n");
    }
    return "";
  }
  return "";
}

function messageText(message: CoreMessage) {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function routeMessages(messages: CoreMessage[]) {
  return messages
    .filter((message): message is CoreMessage & { role: "user" | "assistant" } =>
      message.role === "user" || message.role === "assistant"
    )
    .map((message) => ({
      role: message.role,
      content: messageText(message),
    }))
    .filter((message) => message.content.trim().length > 0);
}

function previousUserBeforeLatest(messages: CoreMessage[]) {
  let seenLatest = false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "user") {
      continue;
    }
    if (!seenLatest) {
      seenLatest = true;
      continue;
    }
    const text = messageText(message).trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function combinedFollowupPrompt(messages: CoreMessage[], prompt: string) {
  const previous = previousUserBeforeLatest(messages);
  return previous ? `${previous}\n${prompt}` : prompt;
}

function effectiveRunPrompt(messages: CoreMessage[], prompt: string, route: Pick<RouteToolsResult, "routeScope">) {
  return route.routeScope === "contextual_followup" ? combinedFollowupPrompt(messages, prompt) : prompt;
}

function promptHasContextualReference(prompt: string) {
  return /\b(?:again|above|it|that|them|these|those|this|same|previous|prior|ones)\b/i.test(prompt);
}

// Reinforce attachment context inside the conversation itself. A multi-turn
// model can trust its earlier "please upload a file" turns over a system-prompt
// note, so we append the fact to the latest user message where it can't be missed.
function appendAttachmentNote(messages: CoreMessage[], names: string): CoreMessage[] {
  const note = `\n\n[Attachments already uploaded and ready: ${names}. These will be attached automatically when the email is sent — do not ask me to upload or provide them again.]`;
  const next = [...messages];
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const message = next[i];
    if (message.role !== "user") {
      continue;
    }
    if (typeof message.content === "string") {
      next[i] = { ...message, content: `${message.content}${note}` };
    } else if (Array.isArray(message.content)) {
      next[i] = {
        ...message,
        content: [...message.content, { type: "text", text: note }],
      } as CoreMessage;
    }
    break;
  }
  return next;
}

function safeStringify(value: unknown, maxLength = 4_000) {
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > maxLength ? safeTextPreview(text, maxLength) : text;
  } catch {
    const text = String(value);
    return text.length > maxLength ? safeTextPreview(text, maxLength) : text;
  }
}

function safeTextPreview(text: string, maxLength: number) {
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

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const haystack = errorHaystack(error);
  if (/rate[\s-]?limit|temporarily rate-limited|too many requests|\b429\b/.test(haystack)) {
    return "The model is temporarily rate-limited (common on free-tier models). Please wait a few seconds and try again.";
  }
  if (/requires more credits|can only afford|insufficient.*(credit|fund|balance)|negative balance|prompt tokens limit exceeded/.test(haystack)) {
    return "The model request was rejected for this account's credit balance. Add OpenRouter credits, switch to a free model, or lower AGENT_MAX_TOKENS/JSON_MAX_TOKENS.";
  }
  if (/model tried to call unavailable tool|unavailable tool .*available tools/i.test(haystack)) {
    return "The model selected a tool that was not available for this turn, so the app did not run anything. Please retry the request; the active task context will be kept for the next turn.";
  }
  return message || "The model request failed. Check the server logs for details.";
}

// Flatten an error into one lowercased string so we can recognize provider
// rate-limit / credit failures. The AI SDK wraps the real provider error inside
// RetryError (.lastError / .errors[]) and APICallError (.responseBody / .cause),
// so we walk all of those, not just the top-level message.
function errorHaystack(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown, depth: number) => {
    if (!node || depth > 6 || seen.has(node)) {
      return;
    }
    seen.add(node);
    if (typeof node === "string") {
      parts.push(node);
      return;
    }
    if (node instanceof Error || isRecord(node)) {
      const rec = node as Record<string, unknown>;
      for (const key of ["message", "responseBody", "statusCode", "code"]) {
        if (typeof rec[key] === "string" || typeof rec[key] === "number") {
          parts.push(String(rec[key]));
        }
      }
      visit(rec.cause, depth + 1);
      visit(rec.lastError, depth + 1);
      if (Array.isArray(rec.errors)) {
        for (const inner of rec.errors) {
          visit(inner, depth + 1);
        }
      }
    }
  };
  visit(error, 0);
  return parts.join(" ").toLowerCase();
}

function isConnectionWaitTimeout(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();
  return /timeout|timed out|pending|not.*connected|connection.*request/i.test(message);
}

function isCapabilitiesPrompt(prompt: string) {
  const normalized = prompt.trim().toLowerCase();
  return (
    /\b(what|which) (can|do) you do\b/.test(normalized) ||
    /\bwhat (else|other|more)( things| stuff)? can you (do|help)\b/.test(normalized) ||
    /\b(anything|something) else (you )?can (you )?(do|help)\b/.test(normalized) ||
    /\bwhat are (your|you) capab/.test(normalized) ||
    /\bwhat can you help (me )?with\b/.test(normalized) ||
    /^(help|capabilities|what else|anything else|what other things|what more)\??$/.test(normalized)
  );
}

function capabilitiesText(runId: string) {
  return `I can help you use connected Google and GitHub accounts through Composio.

Examples:
- Read recent Gmail messages and summarize the important ones.
- Draft or send emails, including an uploaded PDF attachment after you confirm.
- Schedule Google Calendar events after resolving missing details and confirmation.
- Read GitHub repository issues and create a Google Sheet summary.
- Read files from a Google Drive folder and create a Sheet with extracted fields.

Connect Google and GitHub from the top-right buttons first. I will ask before any action that sends, creates, or updates something.`;
}

function makeLocalTextResponse(text: string, runId: string, extraHeaders: Record<string, string> = {}) {
  return createDataStreamResponse({
    headers: {
      "x-run-id": runId,
      ...extraHeaders,
    },
    execute(dataStream) {
      dataStream.write(formatDataStreamPart("text", text));
      dataStream.write(
        formatDataStreamPart("finish_message", {
          finishReason: "stop",
          usage: { promptTokens: 0, completionTokens: 0 },
        })
      );
    },
  });
}

function clearActiveJobHeaders(route: Pick<RouteToolsResult, "intentIds" | "routeScope">): Record<string, string> {
  if (route.routeScope === "standalone" && !isWorkflowIntent(route.intentIds)) {
    return { [CLEAR_ACTIVE_JOB_HEADER]: "true" };
  }
  return {};
}

// Friendly names for the toolkits we ship today. Any toolkit not listed here
// falls back to a capitalized slug, so new toolkits work without code changes.
const TOOLKIT_LABELS: Record<string, string> = {
  googlesuper: "Google",
  github: "GitHub",
};

// Derive the owning toolkit from a tool slug's prefix (e.g. GITHUB_GET_AN_ISSUE
// -> "github") and validate it against the configured auth configs. This keeps
// connection gating generic instead of hardcoding GOOGLESUPER_/GITHUB_ checks.
function toolkitForSlug(slug: string): string | undefined {
  const prefix = slug.split("_")[0]?.toLowerCase();
  return prefix && prefix in AUTH_CONFIGS ? prefix : undefined;
}

function requiredToolkitsForSlugs(slugs: string[]): string[] {
  const required = new Set<string>();
  for (const slug of slugs) {
    const toolkit = toolkitForSlug(slug);
    if (toolkit) {
      required.add(toolkit);
    }
  }
  return [...required];
}

function connectionLabel(toolkit: string) {
  return TOOLKIT_LABELS[toolkit] ?? toolkit.charAt(0).toUpperCase() + toolkit.slice(1);
}

function missingConnectionText(toolkits: string[], runId: string) {
  const labels = toolkits.map(connectionLabel);
  const joined =
    labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;

  return `I need ${joined} connected before I can do that.

Use the ${toolkits.map((toolkit) => `"Connect ${connectionLabel(toolkit)}"`).join(" and ")} button${
    toolkits.length === 1 ? "" : "s"
  } at the top of the app, complete OAuth, then send the request again.

I did not run any tools or create any pending actions.`;
}

function missingToolSchemaText(route: { slugs: string[] }, runId: string) {
  const tools = route.slugs.length ? route.slugs.join(", ") : "the selected tools";
  return `I found the right tool route (${tools}), but the app could not load the live Composio tool schema for it.

This is a tool-catalog loading problem, not a Gmail connection problem. Refresh the app and try again; if it repeats, reconnect Google from the top bar.

I did not run any tools or create any pending actions.`;
}

function unsupportedNoToolActionText() {
  return `I don't have a supported tool for that action in Mini Rube.

I did not run any tools or create any pending actions.`;
}

function isUnsupportedNoToolAction(prompt: string) {
  return (
    /\b(?:append|archive|book|create|delete|post|remove|schedule|send|trash|update|write)\b/i.test(prompt) &&
    /\b(?:calendar|doc|drive|email|event|file|folder|github|issue|linear|mail|meeting|message|pr|pull request|repo|sheet|slack|spreadsheet|task)\b/i.test(prompt)
  );
}

function redactEmailsForCalendar(toolSlug: string, value: string) {
  if (!/(EVENT|CALENDAR|FREE_SLOTS)/.test(toolSlug)) {
    return value;
  }
  return redactResolvedEmails(value);
}

// Mask the local part of any email but keep the domain ("***@gmail.com") so the
// reply stays useful without exposing a resolved contact's full address.
function redactResolvedEmails(value: string) {
  return value.replace(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi, "***@$1");
}

function summarizePendingAction(toolSlug: string, args: Record<string, unknown>) {
  return redactEmailsForCalendar(toolSlug, `${toolSlug}\n${safeStringify(args, 1_500)}`);
}

// Turn a tool slug like GOOGLESUPER_SEND_EMAIL into a verb phrase ("Send email")
// so the confirmation card reads naturally for any toolkit.
function actionTitleForSlug(toolSlug: string) {
  const action = toolSlug.replace(/^[A-Z0-9]+_/, "").replace(/_/g, " ").toLowerCase();
  return action ? action.charAt(0).toUpperCase() + action.slice(1) : toolSlug;
}

const ACTION_DETAIL_FIELDS: Array<{ keys: string[]; label: string }> = [
  { keys: ["to", "recipient", "recipients", "recipient_email", "email", "to_email"], label: "To" },
  { keys: ["cc"], label: "Cc" },
  { keys: ["subject", "title", "summary", "name"], label: "Subject" },
  { keys: ["start_datetime", "start", "start_time", "startTime", "when"], label: "Start" },
  { keys: ["end_datetime", "end", "end_time", "endTime"], label: "End" },
  { keys: ["attendees", "guests", "participants"], label: "Attendees" },
  { keys: ["location"], label: "Location" },
  { keys: ["spreadsheetTitle", "spreadsheet_title", "sheet_name"], label: "Sheet" },
  { keys: ["body", "text", "message", "description", "content"], label: "Body" },
];

// Pull a few recognizable fields out of the tool args for the confirmation card,
// redacting inferred email addresses (the same rule applied to the chat text).
function actionDetailsFromArgs(toolSlug: string, args: Record<string, unknown>) {
  const details: Array<{ label: string; value: string }> = [];
  const used = new Set<string>();
  for (const field of ACTION_DETAIL_FIELDS) {
    const key = field.keys.find((candidate) => candidate in args && args[candidate] != null);
    if (!key || used.has(field.label)) {
      continue;
    }
    used.add(field.label);
    let value = stringifyArgValue(args[key]);
    if (!value) {
      continue;
    }
    if (value.length > 160) {
      value = `${value.slice(0, 157)}…`;
    }
    details.push({ label: field.label, value: redactEmailsForCalendar(toolSlug, value) });
  }

  // Attachments are file-reference objects, not scalars — surface a clean count
  // rather than dumping the raw ref JSON into the confirmation card.
  const attachmentValue = args.attachments ?? args.attachment ?? args.files ?? args.file;
  if (attachmentValue != null && !used.has("Attachment")) {
    const count = Array.isArray(attachmentValue) ? attachmentValue.length : 1;
    details.push({ label: "Attachment", value: `${count} file${count === 1 ? "" : "s"}` });
  }

  return details;
}

function stringifyArgValue(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map(stringifyArgValue).filter(Boolean).join(", ");
  }
  if (typeof value === "object") {
    const named = (value as Record<string, unknown>).email ?? (value as Record<string, unknown>).name;
    return named != null ? String(named) : safeStringify(value, 160);
  }
  return String(value).trim();
}

function createPendingAction(
  userId: string,
  run: RunState,
  toolSlug: string,
  args: Record<string, unknown>
) {
  const action: PendingAction = {
    id: makeId("act"),
    userId,
    runId: run.id,
    toolSlug,
    args,
    summary: summarizePendingAction(toolSlug, args),
    actionTitle: actionTitleForSlug(toolSlug),
    actionDetails: actionDetailsFromArgs(toolSlug, args),
    status: "pending",
    createdAt: nowIso(),
  };
  pendingActions.set(action.id, action);
  run.pendingActions.push(action.id);
  run.status = "waiting_confirmation";
  addTrace(run, {
    type: "confirmation",
    title: "Waiting for confirmation",
    detail: `pending_action:${action.id}`,
    toolSlug,
    args,
  });
  return action;
}

async function requestWorkflowApproval(request: ApprovalRequest): Promise<ApprovalGrant> {
  const run = runForWorkflowJob(request.jobId);
  if (run) {
    run.status = "waiting_confirmation";
    addTrace(run, {
      type: "confirmation",
      title: "Workflow waiting for confirmation",
      detail: request.summary,
    });
  }

  if (preApprovedWorkflowJobs.delete(request.jobId)) {
    return {
      approved: true,
      approvalId: makeId("approval"),
      scope: "workflow",
    };
  }

  return new Promise((resolve) => {
    workflowApprovals.set(request.jobId, { request, resolve });
  });
}

function runForWorkflowJob(jobId: string) {
  const runId = workflowJobRuns.get(jobId);
  return runId ? runs.get(runId) : undefined;
}

function workflowDefinitionForId(workflowId: string): WorkflowDefinition | null {
  if (workflowId === "github.issues_to_sheet") {
    return { id: "github.issues_to_sheet", label: "GitHub issues to Google Sheet" };
  }
  if (workflowId === "drive.resumes_to_sheet") {
    return { id: "drive.resumes_to_sheet", label: "Drive resumes to Google Sheet" };
  }
  return null;
}

function startWorkflowJob(workflow: WorkflowDefinition, job: WorkflowJob, run: RunState) {
  workflowJobRuns.set(job.id, run.id);
  addTrace(run, {
    type: "info",
    title: "Workflow job started",
    detail: `job_id:${job.id}`,
  });

  void workflowService
    .runWorkflow(workflow, {
      ...job.input,
      jobId: job.id,
      userId: job.userId,
    })
    .then((result) => {
      const latestJob = workflowStore.getJob(job.id);
      run.status =
        result.status === "completed"
          ? "completed"
          : result.status === "cancelled"
            ? "cancelled"
            : "failed";
      addTrace(run, {
        type: result.status === "failed" ? "error" : "info",
        title:
          result.status === "completed"
            ? "Workflow completed"
            : result.status === "cancelled"
              ? "Workflow cancelled"
              : "Workflow failed",
        detail: `Processed ${result.totalItems} items, wrote ${result.writtenRows} rows, ${result.failedItems} failures.`,
        resultPreview: result,
      });
      for (const artifact of result.artifacts) {
        run.artifacts.push(artifact);
      }
      return latestJob;
    })
    .catch(async (err) => {
      const message = getErrorMessage(err);
      await workflowStore.failJob(job.id, message).catch(() => undefined);
      run.status = "failed";
      addTrace(run, {
        type: "error",
        title: "Workflow crashed",
        detail: message,
      });
    });
}

async function confirmWorkflowJob(jobId: string, userId: string) {
  const job = await workflowStore.getJob(jobId);
  if (!job) {
    return Response.json({ error: "Workflow job not found" }, { status: 404 });
  }
  if (job.userId !== userId) {
    return Response.json({ error: "Workflow job does not belong to this user" }, { status: 403 });
  }

  const pending = workflowApprovals.get(jobId);
  if (pending) {
    workflowApprovals.delete(jobId);
    pending.resolve({
      approved: true,
      approvalId: makeId("approval"),
      scope: "workflow",
    });
  } else if (job.status !== "completed" && job.status !== "failed" && job.status !== "cancelled") {
    preApprovedWorkflowJobs.add(jobId);
    const workflow = workflowDefinitionForId(job.workflowId);
    if (workflow && !runForWorkflowJob(job.id)) {
      const run = createRun(job.userId, String(job.input.prompt ?? ""), [], "resumed workflow job");
      startWorkflowJob(workflow, job, run);
    }
  }

  const refreshed = (await workflowStore.getJob(jobId)) ?? job;
  return Response.json({ job: jobResponse(refreshed) });
}

async function cancelWorkflowJob(jobId: string, userId: string, reason: string) {
  const job = await workflowStore.getJob(jobId);
  if (!job) {
    return Response.json({ error: "Workflow job not found" }, { status: 404 });
  }
  if (job.userId !== userId) {
    return Response.json({ error: "Workflow job does not belong to this user" }, { status: 403 });
  }
  if (["completed", "failed", "cancelled"].includes(job.status)) {
    return Response.json({ job: jobResponse(job) });
  }

  cancelledWorkflowJobs.add(jobId);
  preApprovedWorkflowJobs.delete(jobId);
  const pendingApproval = workflowApprovals.get(jobId);
  workflowApprovals.delete(jobId);
  pendingApproval?.resolve({
    approved: true,
    approvalId: makeId("cancelled_approval"),
    scope: "workflow",
  });
  const cancelled = await workflowStore.cancelJob(jobId, reason);
  const run = runForWorkflowJob(jobId);
  if (run) {
    run.status = "cancelled";
    addTrace(run, {
      type: "info",
      title: "Workflow cancelled",
      detail: reason,
    });
  }
  return Response.json({ job: jobResponse(cancelled) });
}

function workflowQueuedText(runId: string, jobId: string, workflow: WorkflowDefinition) {
  return `I started a ${workflow.label} workflow.

It will collect the source rows deterministically, then ask for confirmation before writing to Google Sheets. You can track progress in the workflow panel.`;
}

// A workflow was recognized but is missing its source (Drive folder / GitHub repo).
// Reply conversationally asking for it rather than starting a job that would fail.
function workflowInputNeededResponse(
  userId: string,
  prompt: string,
  route: { slugs: string[]; rationale: string },
  ask: string
) {
  const run = createRun(userId, prompt, route.slugs, route.rationale);
  addTrace(run, { type: "info", title: "Need more detail", detail: ask });
  run.status = "completed";
  return makeLocalTextResponse(ask, run.id);
}

async function startWorkflowResponse(
  workflow: WorkflowDefinition,
  userId: string,
  prompt: string,
  slugs: string[],
  rationale: string,
  extraInput: Record<string, unknown>
) {
  const run = createRun(userId, prompt, slugs, rationale);
  const job = await workflowStore.createJob({
    workflowId: workflowIdOf(workflow),
    userId,
    input: {
      userId,
      prompt,
      ...extraInput,
      spreadsheetTitle:
        workflow.id === "github.issues_to_sheet" ? "GitHub issue report" : "Candidate resumes",
    },
  });
  startWorkflowJob(workflow, job, run);
  return makeLocalTextResponse(workflowQueuedText(run.id, job.id, workflow), run.id, {
    "x-job-id": job.id,
  });
}

function calendarDraftResponse(
  userId: string,
  prompt: string,
  route: { slugs: string[]; rationale: string },
  draft: CalendarEventDraft,
  extraHeaders: Record<string, string> = {}
) {
  const run = createRun(userId, prompt, route.slugs, `${route.rationale} (deterministic calendar draft)`);
  createPendingAction(userId, run, "GOOGLESUPER_CREATE_EVENT", draft.args);
  return makeLocalTextResponse(calendarDraftText(draft), run.id, extraHeaders);
}

function emailDraftResponse(
  userId: string,
  prompt: string,
  route: { slugs: string[]; rationale: string },
  draft: EmailDraft,
  extraHeaders: Record<string, string> = {}
) {
  const run = createRun(userId, prompt, route.slugs, `${route.rationale} (deterministic email draft)`);
  createPendingAction(userId, run, "GOOGLESUPER_SEND_EMAIL", draft.args);
  return makeLocalTextResponse(emailDraftText(draft), run.id, extraHeaders);
}

type EmailDraft = {
  args: Record<string, unknown>;
  display: {
    recipient: string;
    subject: string;
    body: string;
    attachmentNames: string;
  };
};

function emailDraftText(draft: EmailDraft) {
  return `I prepared the email and it is waiting for your confirmation in the UI.

- To: ${draft.display.recipient}
- Subject: ${draft.display.subject}
- Body: ${draft.display.body}
- Attachment: ${draft.display.attachmentNames}

Click Confirm to send it.`;
}

function attachedPdfMissingText(staleFileIds: boolean) {
  if (staleFileIds) {
    return "The PDF chip in the chat points to an upload the server no longer has. Please remove it, upload the PDF again with the PDF button, then send the email request again.";
  }

  return "I don't see a PDF attached to this chat. Please upload the PDF using the app's PDF button, then send the email request again.";
}

function attachedPdfMissingResponse(
  userId: string,
  prompt: string,
  route: { slugs: string[]; rationale: string },
  staleFileIds: boolean,
  extraHeaders: Record<string, string> = {}
) {
  const text = attachedPdfMissingText(staleFileIds);
  const run = createRun(userId, prompt, route.slugs, `${route.rationale} (missing attached PDF)`);
  addTrace(run, {
    type: "info",
    title: staleFileIds ? "Stale attached file" : "Missing attached file",
    detail: text,
  });
  run.status = "completed";
  return makeLocalTextResponse(text, run.id, extraHeaders);
}

function calendarDraftText(draft: CalendarEventDraft) {
  return `I prepared the calendar event and it is waiting for your confirmation in the UI.

- Title: ${draft.display.summary}
- Start: ${draft.display.start} (${DEFAULT_CALENDAR_TIMEZONE})
- Duration: ${draft.display.durationMinutes} minutes

Click Confirm to create the event.`;
}

function activeTaskKey(userId: string, intentId: ActiveTaskIntentId) {
  return `${userId}:${intentId}`;
}

function getActiveTask(userId: string, intentId: ActiveTaskIntentId) {
  const key = activeTaskKey(userId, intentId);
  const task = activeTasks.get(key);
  if (!task) {
    return null;
  }
  if (task.expiresAt <= Date.now()) {
    activeTasks.delete(key);
    return null;
  }
  return task;
}

function clearActiveTask(userId: string, intentId: ActiveTaskIntentId) {
  activeTasks.delete(activeTaskKey(userId, intentId));
}

function routeIsCalendarSchedule(route: Pick<RouteToolsResult, "intentIds" | "slugs">) {
  return (
    route.intentIds?.includes(CALENDAR_SCHEDULE_INTENT_ID) ||
    route.slugs.includes("GOOGLESUPER_CREATE_EVENT")
  );
}

function calendarToolsForRoute(route: Pick<RouteToolsResult, "slugs">) {
  const selected = route.slugs.filter((slug) => CALENDAR_SCHEDULE_SLUGS.includes(slug));
  const merged = ["GOOGLESUPER_CREATE_EVENT", ...selected, ...CALENDAR_SCHEDULE_SLUGS];
  return merged.filter((slug, index, all) => all.indexOf(slug) === index);
}

function appendActiveTaskPrompt(task: ActiveTask, prompt: string) {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return task;
  }
  if (task.promptHistory.at(-1) !== trimmed) {
    task.promptHistory = [...task.promptHistory, trimmed].slice(-ACTIVE_TASK_HISTORY_LIMIT);
  }
  task.updatedAt = nowIso();
  task.expiresAt = Date.now() + ACTIVE_TASK_TTL_MS;
  activeTasks.set(activeTaskKey(task.userId, task.intentId), task);
  return task;
}

function saveCalendarTask(userId: string, prompt: string, route: Pick<RouteToolsResult, "slugs" | "rationale">) {
  const existing = getActiveTask(userId, CALENDAR_SCHEDULE_INTENT_ID);
  if (existing && !isCalendarScheduleAnchor(prompt)) {
    existing.selectedTools = calendarToolsForRoute(route);
    existing.rationale = route.rationale || existing.rationale;
    return appendActiveTaskPrompt(existing, prompt);
  }

  const now = nowIso();
  const task: ActiveTask = {
    id: makeId("task"),
    userId,
    intentId: CALENDAR_SCHEDULE_INTENT_ID,
    promptHistory: [],
    selectedTools: calendarToolsForRoute(route),
    rationale: route.rationale || "calendar.schedule",
    createdAt: now,
    updatedAt: now,
    expiresAt: Date.now() + ACTIVE_TASK_TTL_MS,
  };
  return appendActiveTaskPrompt(task, prompt);
}

function saveCalendarTaskFromHistory(userId: string, promptHistory: string[]) {
  const now = nowIso();
  const task: ActiveTask = {
    id: makeId("task"),
    userId,
    intentId: CALENDAR_SCHEDULE_INTENT_ID,
    promptHistory: promptHistory.map((prompt) => prompt.trim()).filter(Boolean).slice(-ACTIVE_TASK_HISTORY_LIMIT),
    selectedTools: [...CALENDAR_SCHEDULE_SLUGS],
    rationale: "calendar.schedule reconstructed from conversation history",
    createdAt: now,
    updatedAt: now,
    expiresAt: Date.now() + ACTIVE_TASK_TTL_MS,
  };
  activeTasks.set(activeTaskKey(userId, CALENDAR_SCHEDULE_INTENT_ID), task);
  return task;
}

function activeTaskRoute(task: ActiveTask): RouteToolsResult {
  return {
    slugs: task.selectedTools,
    rationale: `${task.rationale}; active task follow-up`,
    intentIds: [task.intentId],
    confidence: 1,
    routingMode: "deterministic",
    routeScope: "contextual_followup",
  };
}

function activeTaskPrompt(task: ActiveTask) {
  return task.promptHistory.join("\n");
}

function latestAssistantSuggestsCalendarFollowup(
  messages: CoreMessage[],
  task?: Pick<ActiveTask, "promptHistory">
) {
  const text = latestAssistantText(messages);
  const asksForDetails =
    /\b(?:email|date|time|duration|title|details|provide|need|what|which|when|how long)\b/i.test(text);
  if (!asksForDetails) {
    return false;
  }
  if (/\b(?:schedule|calendar|event|meeting|invite)\b/i.test(text)) {
    return true;
  }
  return task ? assistantReferencesCalendarTask(text, task) : false;
}

function assistantReferencesCalendarTask(text: string, task: Pick<ActiveTask, "promptHistory">) {
  const normalized = text.toLowerCase();
  return calendarTaskReferenceTokens(task).some((token) => normalized.includes(token));
}

function calendarTaskReferenceTokens(task: Pick<ActiveTask, "promptHistory">) {
  const source = task.promptHistory
    .join("\n")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, " ");
  const tokens = new Set<string>();

  for (const match of source.matchAll(/\b[A-Z][a-z][A-Za-z.'-]{1,}\b/g)) {
    addCalendarReferenceToken(tokens, match[0]);
  }
  for (const match of source.matchAll(/\b(?:with|invite|for)\s+([a-z][a-z.'-]{2,})\b/gi)) {
    addCalendarReferenceToken(tokens, match[1]);
  }

  return [...tokens];
}

function addCalendarReferenceToken(tokens: Set<string>, value: string) {
  const token = value.toLowerCase().replace(/'s$/, "");
  if (
    token.length < 3 ||
    /^(schedule|calendar|event|meeting|invite|call|today|tomorrow|next|title|duration|with|for|the|and|test|tests|january|february|march|april|june|july|august|september|october|november|december)$/i.test(
      token
    )
  ) {
    return;
  }
  tokens.add(token);
}

function isLikelyCalendarFollowup(prompt: string) {
  const text = prompt.trim();
  if (!text || text.length > 500) {
    return false;
  }
  return (
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text) ||
    /^(?:yes|yep|yeah|ok|okay|sure|the\s+)?(?:first|second|third|1st|2nd|3rd)(?:\s+one)?$/i.test(text) ||
    /^(?:yes|yep|yeah|ok|okay|sure|that one|this one|the one)$/i.test(text) ||
    /\b(?:primary|work calendar|personal calendar)\b/i.test(text) ||
    /\b(?:today|tomorrow|next|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/i.test(text) ||
    /\b20\d{2}-\d{1,2}-\d{1,2}\b/.test(text) ||
    /\b(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*(?:am|pm)\b/i.test(text) ||
    /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/.test(text) ||
    /\b\d+(?:\.\d+)?\s*-?\s*(?:hours?|hrs?|hr|h|minutes?|mins?|min|m)\b/i.test(text) ||
    /\b(?:title|titled|called|named|duration|email)\b/i.test(text) ||
    (text.length <= 160 && text.includes(","))
  );
}

function looksLikeNewNonCalendarIntent(prompt: string) {
  return (
    !isCalendarScheduleAnchor(prompt) &&
    (/\b(?:send|reply|forward|draft|write|github|issue|issues|sheet|spreadsheet|drive|resume|resumes)\b/i.test(
      prompt
    ) ||
      isEmailReadRequest(prompt) ||
      /\b(?:email|mail)\s+(?:it|this|that|them|him|her|to)\b/i.test(prompt))
  );
}

function isEmailReadRequest(prompt: string) {
  return (
    /\b(?:read|fetch|get|show|list|scan|summari[sz]e)\b/i.test(prompt) &&
    /\b(?:emails?|gmail|inbox|messages?|subjects?)\b/i.test(prompt) &&
    !/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(prompt)
  );
}

function isCalendarScheduleAnchor(prompt: string) {
  return (
    /\b(?:schedule|book|create|set up|setup|add|put|make)\b/i.test(prompt) &&
    /\b(?:calendar|event|meeting|invite|call|with)\b/i.test(prompt)
  );
}

function reconstructCalendarTaskHistory(messages: CoreMessage[]) {
  const userTexts = messages
    .filter((message) => message.role === "user")
    .map(messageText)
    .map((text) => text.trim())
    .filter(Boolean);

  for (let i = userTexts.length - 1; i >= 0; i -= 1) {
    if (isCalendarScheduleAnchor(userTexts[i])) {
      return userTexts.slice(i).slice(-ACTIVE_TASK_HISTORY_LIMIT);
    }
  }
  return null;
}

function activeCalendarTaskForFollowup(userId: string, messages: CoreMessage[], prompt: string) {
  if (isCalendarScheduleAnchor(prompt)) {
    return null;
  }
  if (looksLikeNewNonCalendarIntent(prompt)) {
    return null;
  }
  if (!isLikelyCalendarFollowup(prompt)) {
    return null;
  }

  const existing = getActiveTask(userId, CALENDAR_SCHEDULE_INTENT_ID);
  if (existing) {
    if (!latestAssistantSuggestsCalendarFollowup(messages, existing)) {
      return null;
    }
    return appendActiveTaskPrompt(existing, prompt);
  }

  const history = reconstructCalendarTaskHistory(messages);
  if (!history || history.length === 0) {
    return null;
  }
  const reconstructed = { promptHistory: history };
  if (!latestAssistantSuggestsCalendarFollowup(messages, reconstructed)) {
    return null;
  }
  return saveCalendarTaskFromHistory(userId, history);
}

// If the previous turn asked the user for a workflow source (repo / Drive folder)
// and this turn supplies it, resume that workflow instead of treating the terse
// reply as a brand-new request (which would lose the original sheet intent).
// The detection strings must stay in sync with NO_REPO_MESSAGE / NO_FOLDER_MESSAGE.
async function maybeResumeWorkflowFromFollowup(
  messages: CoreMessage[],
  prompt: string,
  userId: string
) {
  const previous = latestAssistantText(messages);
  if (!previous || prompt.trim().length > 200) return null;
  const workflowPrompt = combinedFollowupPrompt(messages, prompt);

  if (previous.includes("which GitHub repository")) {
    if (!previousUserRequestedGithubSheet(messages)) {
      return null;
    }
    if (!isGithubWorkflowSourceReply(prompt)) {
      return null;
    }
    const repo = resolveGithubRepoRequest(prompt);
    if ("repository" in repo) {
      const workflow = isWorkflowIntent(["github.issues_to_sheet"]);
      if (workflow) {
        return startWorkflowResponse(workflow, userId, workflowPrompt, [], "repository provided in follow-up", {
          repository: repo.repository,
        });
      }
    }
  } else if (previous.includes("which Drive folder are the resumes in")) {
    if (!previousUserRequestedDriveSheet(messages)) {
      return null;
    }
    const resolution = await resolveDriveFolderReply(prompt, (slug, args) =>
      executeTool(slug, userId, args)
    );
    if ("folderId" in resolution) {
      const workflow = isWorkflowIntent(["drive.resumes_to_sheet"]);
      if (workflow) {
        return startWorkflowResponse(workflow, userId, workflowPrompt, [], "folder provided in follow-up", {
          folderId: resolution.folderId,
        });
      }
    }
  }
  return null;
}

function previousUserRequestedGithubSheet(messages: CoreMessage[]) {
  const previous = previousUserBeforeLatest(messages);
  return hasSheetWriteIntent(previous) && /\b(?:github|repo|repository|issue|issues|pull request|pull requests)\b/i.test(previous);
}

function previousUserRequestedDriveSheet(messages: CoreMessage[]) {
  const previous = previousUserBeforeLatest(messages);
  return hasSheetWriteIntent(previous) && /\b(?:drive|folder|resume|resumes|candidate|candidates|pdf|pdfs|document|documents)\b/i.test(previous);
}

function hasSheetWriteIntent(prompt: string) {
  return (
    /\b(?:sheet|spreadsheet|table|csv)\b/i.test(prompt) &&
    /\b(?:write|create|make|export|append|put|save)\b/i.test(prompt)
  );
}

function isGithubWorkflowSourceReply(prompt: string) {
  if (isReadOnlyGithubPrompt(prompt)) {
    return false;
  }
  return !/\b(?:email|emails|gmail|inbox|calendar|event|meeting|drive|folder|resume|resumes)\b/i.test(prompt);
}

function isReadOnlyGithubPrompt(prompt: string) {
  const lower = prompt.toLowerCase();
  return (
    /\b(?:just|only|simply)?\s*(?:get|fetch|read|show|list|summari[sz]e)\b/.test(lower) &&
    /\b(?:issue|issues|github|repo|repository|pull request|pull requests)\b/.test(lower) &&
    (/\b(?:don'?t|do not|without|no)\s+(?:write|create|make|export|append|put|save)\b/.test(lower) ||
      !/\b(?:sheet|spreadsheet|table|csv)\b/.test(lower))
  );
}

async function resolveDriveFolderForWorkflow(messages: CoreMessage[], prompt: string, userId: string) {
  const direct = await resolveDriveFolderRequest(prompt, (slug, args) => executeTool(slug, userId, args));
  if (!("ask" in direct) || !promptHasContextualReference(prompt)) {
    return { resolution: direct, promptForJob: prompt };
  }

  const contextualPrompt = combinedFollowupPrompt(messages, prompt);
  const contextual = await resolveDriveFolderRequest(contextualPrompt, (slug, args) => executeTool(slug, userId, args));
  return "ask" in contextual
    ? { resolution: direct, promptForJob: prompt }
    : { resolution: contextual, promptForJob: contextualPrompt };
}

function resolveGithubRepoForWorkflow(messages: CoreMessage[], prompt: string) {
  const direct = resolveGithubRepoRequest(prompt);
  if (!("ask" in direct) || !promptHasContextualReference(prompt)) {
    return { resolution: direct, promptForJob: prompt };
  }

  const contextualPrompt = combinedFollowupPrompt(messages, prompt);
  const contextual = resolveGithubRepoRequest(contextualPrompt);
  return "ask" in contextual
    ? { resolution: direct, promptForJob: prompt }
    : { resolution: contextual, promptForJob: contextualPrompt };
}

function jobResponse(job: WorkflowJob) {
  const output = isRecord(job.output) ? job.output : {};
  const progress = isRecord(job.progress) ? job.progress : {};
  const phase = workflowPhaseForResponse(job, progress);
  const artifacts = normalizeArtifacts(output.artifacts);
  const approval = workflowApprovals.get(job.id);
  return {
    id: job.id,
    userId: job.userId,
    type: job.workflowId,
    status: job.status,
    phase,
    approvalStatus: approval
      ? "waiting_confirmation"
      : job.status === "waiting_confirmation"
        ? "waiting_confirmation"
        : job.status === "completed"
          ? "completed"
          : job.status === "cancelled"
            ? "cancelled"
          : "not_required",
    approvalSummary: approval?.request.summary ?? (typeof progress.pendingSummary === "string" ? progress.pendingSummary : undefined),
    progress: {
      phase,
      totalItems: toNumber(progress.totalItems) ?? 0,
      fetchedItems: toNumber(progress.fetchedItems) ?? 0,
      processedItems: toNumber(progress.processedItems) ?? 0,
      writtenRows: toNumber(progress.writtenRows) ?? toNumber(output.writtenRows) ?? 0,
      failedItems: toNumber(progress.failedItems) ?? toNumber(output.failedItems) ?? 0,
    },
    artifacts,
    error: job.error,
    updatedAt: job.updatedAt,
  };
}

function workflowPhaseForResponse(job: WorkflowJob, progress: Record<string, unknown>) {
  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    return job.status;
  }
  return typeof progress.phase === "string" ? progress.phase : job.status;
}

function normalizeArtifacts(value: unknown): WorkflowArtifact[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const artifacts: WorkflowArtifact[] = [];
  for (const artifact of value) {
      if (!isRecord(artifact)) {
      continue;
      }
    artifacts.push({
        label: typeof artifact.label === "string" ? artifact.label : "Generated artifact",
        url: typeof artifact.url === "string" ? artifact.url : undefined,
        value: artifact.value,
    });
  }
  return artifacts;
}

function filesForUser(userId: string, fileIds: string[]) {
  return fileIds
    .map((id) => uploadedFiles.get(id))
    .filter((file): file is UploadedFileRef => file !== undefined && file.userId === userId);
}

function attachUploadedFilesIfNeeded(
  toolSchema: ComposioToolSchema,
  args: Record<string, unknown>,
  files: UploadedFileRef[]
) {
  const slug = getToolSlug(toolSchema);
  if (slug !== "GOOGLESUPER_SEND_EMAIL" || files.length === 0) {
    return args;
  }

  const schema = getToolInputSchema(toolSchema);
  const properties = isRecord(schema.properties) ? schema.properties : {};
  // SEND_EMAIL's attachment param wants FileUploadable objects: each needs a
  // valid `name`, `mimetype` (with a "/"), and the `s3key` from the upload
  // response. Passing the raw upload ref (id/key/presigned_url, no name/mimetype)
  // is silently treated as "no attachment" — which produced blank emails.
  const attachField = ["attachment", "attachments"].find((key) => key in properties);
  if (!attachField) {
    return args;
  }
  // Always override any attachment the model set: it can't know the real s3key
  // and typically guesses s3key = filename, which Composio rejects as "no
  // attachment" (the blank-email bug). Only the server has the upload ref.

  const uploadables = files
    .map((file) => ({
      name: file.filename,
      mimetype: file.mimeType && file.mimeType.includes("/") ? file.mimeType : "application/pdf",
      s3key: attachmentS3Key(file.composioFileRef),
    }))
    .filter((uploadable) => Boolean(uploadable.s3key));

  if (uploadables.length === 0) {
    return args;
  }

  return { ...args, [attachField]: uploadables.length === 1 ? uploadables[0] : uploadables };
}

function attachmentS3Key(ref: Record<string, unknown>): string | undefined {
  for (const key of ["s3key", "s3Key", "key", "fileKey", "file_key"]) {
    const value = ref[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function parseAttachedEmailDraft(prompt: string, files: UploadedFileRef[]): EmailDraft | null {
  if (files.length === 0 || !/\b(?:send|email|mail)\b/i.test(prompt)) {
    return null;
  }

  const recipient = prompt.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  if (!recipient) {
    return null;
  }

  const subject = extractEmailField(prompt, "subject");
  const body = extractEmailField(prompt, "body|message|content");
  if (!subject && !body) {
    return null;
  }

  const uploadables = files
    .map((file) => ({
      name: file.filename,
      mimetype: file.mimeType && file.mimeType.includes("/") ? file.mimeType : "application/pdf",
      s3key: attachmentS3Key(file.composioFileRef),
    }))
    .filter((file) => file.s3key);

  if (uploadables.length === 0) {
    return null;
  }

  return {
    args: {
      recipient_email: recipient,
      subject: subject ?? "",
      body: body ?? "",
      is_html: false,
      user_id: "me",
      attachment: uploadables.length === 1 ? uploadables[0] : uploadables,
    },
    display: {
      recipient,
      subject: subject ?? "(no subject)",
      body: body ?? "(empty body)",
      attachmentNames: files.map((file) => file.filename).join(", "),
    },
  };
}

function extractEmailField(prompt: string, fieldPattern: string) {
  const pattern = new RegExp(
    `\\b(?:${fieldPattern})\\s*[:=-]?\\s*(.+?)(?=\\s*,?\\s*(?:subject|body|message|content)\\b|$)`,
    "i"
  );
  return prompt.match(pattern)?.[1]?.trim().replace(/[.。]\s*$/u, "") || null;
}

function isAttachedPdfEmailRequest(route: Pick<RouteToolsResult, "intentIds" | "slugs">, prompt: string) {
  return (
    route.intentIds?.includes("email.send_with_upload") ||
    (route.slugs.includes("GOOGLESUPER_SEND_EMAIL") &&
      /\b(?:attached|attachment|attach|uploaded|upload|pdf|pdfs)\b/i.test(prompt))
  );
}

async function executeToolWithRecovery(
  toolSlug: string,
  userId: string,
  initialArgs: Record<string, unknown>,
  run: RunState
) {
  let args = normalizeToolArgs(toolSlug, applyPromptLimitToToolArgs(toolSlug, initialArgs, run.prompt));

	  for (let attempt = 1; attempt <= 3; attempt += 1) {
	    try {
	      const result = await executeTool(toolSlug, userId, args);
	      let extraPageCount = 0;
	      const paginatedResult = await maybePaginateCollectionRead(
	        toolSlug,
	        args,
	        result,
	        async (pageArgs) => {
	          const pageResult = await executeTool(toolSlug, userId, pageArgs);
	          extraPageCount += 1;
	          return pageResult;
	        }
	      );
	      const compact = compactToolResult(toolSlug, paginatedResult, { prompt: run.prompt, args });
	      addTrace(run, {
	        type: "tool",
	        title: attempt === 1 ? "Executed tool" : "Executed tool after retry",
	        toolSlug,
	        args,
	        resultPreview: compactToolResult(toolSlug, paginatedResult, { maxLength: 3_000, maxItems: 20, prompt: run.prompt, args }),
	      });
	      if (extraPageCount > 0) {
	        addTrace(run, {
	          type: "info",
	          title: "Fetched additional Gmail pages",
	          detail: `${extraPageCount} additional page${extraPageCount === 1 ? "" : "s"}`,
	          toolSlug,
	        });
	      }
	      return compact;
	    } catch (err) {
      const normalized = normalizeToolError(err);
      console.error(`[tool error] ${toolSlug}:`, normalized.message, normalized);
      addTrace(run, {
        type: "error",
        title: `Tool failed (${normalized.category})`,
        detail: normalized.suggestedFix
          ? `${normalized.message}\nSuggested fix: ${normalized.suggestedFix}`
          : normalized.message,
        toolSlug,
        args,
        resultPreview: normalized,
      });

      const retryArgs = buildRetryArgs(toolSlug, args, normalized, attempt);
      const changedArgs = retryArgs && JSON.stringify(retryArgs) !== JSON.stringify(args);
      const retrySameArgs = normalized.category === "server";
      if (retryArgs && attempt < 3 && (changedArgs || retrySameArgs)) {
        addTrace(run, {
          type: "info",
          title: "Retrying tool with safer arguments",
          detail: normalized.category,
          toolSlug,
          args: retryArgs,
        });
        args = retryArgs;
        continue;
      }

      return toolErrorForModel(normalized);
    }
  }
}

function makeAITools(
  toolSchemas: ComposioToolSchema[],
  options: { userId: string; run: RunState; files: UploadedFileRef[] }
) {
  const aiTools: Record<string, any> = {};

  for (const toolSchema of toolSchemas) {
    const slug = getToolSlug(toolSchema);
    if (!slug) {
      continue;
    }

    aiTools[slug] = tool({
      description: toolSchema.description ?? slug,
      parameters: jsonSchema(getToolInputSchema(toolSchema)),
      execute: async (rawArgs: unknown) => {
        const attachedArgs = attachUploadedFilesIfNeeded(
          toolSchema,
          isRecord(rawArgs) ? rawArgs : {},
          options.files
        );
        const args = normalizeToolArgs(slug, attachedArgs);
        console.log(`[tool] ${slug}`, args);

        if (isMutatingToolSlug(slug)) {
          const pendingAction = createPendingAction(options.userId, options.run, slug, args);
          return {
            needsConfirmation: true,
            instruction:
              "This action needs the user's confirmation, which appears as an approve button in the UI. Briefly describe exactly what you are about to do and that it is awaiting confirmation. Do not claim it has executed yet.",
            summary: pendingAction.summary,
          };
        }

        return executeToolWithRecovery(slug, options.userId, args, options.run);
      },
    });
  }

  return aiTools;
}

async function confirmAction(actionId: string, userId: string) {
  const action = pendingActions.get(actionId);
  if (!action) {
    return Response.json({ error: "Pending action not found" }, { status: 404 });
  }
  if (action.userId !== userId) {
    return Response.json({ error: "Pending action does not belong to this user" }, { status: 403 });
  }
  if (action.status !== "pending") {
    return Response.json({ action }, { status: 200 });
  }

  const run = runs.get(action.runId);
  try {
    const result = await executeTool(action.toolSlug, userId, action.args);
    const compactResult = compactToolResult(action.toolSlug, result, { prompt: run?.prompt });
    action.status = "executed";
    action.executedAt = nowIso();
    action.result = compactResult;

    if (run) {
      run.status = "completed";
      addTrace(run, {
        type: "tool",
        title: "Confirmed action executed",
        toolSlug: action.toolSlug,
        args: action.args,
        resultPreview: compactToolResult(action.toolSlug, result, { maxLength: 3_000, maxItems: 20, prompt: run.prompt }),
      });
      collectArtifacts(run, result);
    }

    return Response.json({ action, result: compactResult });
  } catch (err: any) {
    const normalized = normalizeToolError(err);
    const message = normalized.message;
    action.status = "failed";
    action.error = message;
    if (run) {
      run.status = "failed";
      addTrace(run, {
        type: "error",
        title: `Confirmed action failed (${normalized.category})`,
        detail: normalized.suggestedFix
          ? `${normalized.message}\nSuggested fix: ${normalized.suggestedFix}`
          : normalized.message,
        toolSlug: action.toolSlug,
      });
    }
    return Response.json({ error: message, action }, { status: 500 });
  }
}

function collectArtifacts(run: RunState, result: unknown) {
  const urls = new Set<string>();
  collectUrls(result, urls);
  for (const url of urls) {
    if (/docs\.google\.com|drive\.google\.com|github\.com/.test(url)) {
      run.artifacts.push({ label: "Generated artifact", url });
    }
  }
}

function collectUrls(value: unknown, urls: Set<string>) {
  if (typeof value === "string") {
    for (const match of value.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
      urls.add(match[0]);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectUrls(item, urls));
    return;
  }
  if (isRecord(value)) {
    Object.values(value).forEach((item) => collectUrls(item, urls));
  }
}

async function readJson(req: Request) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

async function getConnectionStatuses(userId: string) {
  return (await getConnectionStatusReport(userId)).connections;
}

async function getConnectionStatusReport(userId: string) {
  const connections: Record<string, boolean> = Object.fromEntries(Object.keys(AUTH_CONFIGS).map((toolkit) => [toolkit, false]));
  const details: Record<string, Record<string, unknown>> = Object.fromEntries(
    Object.keys(AUTH_CONFIGS).map((toolkit) => [
      toolkit,
      {
        connected: false,
        status: "disconnected",
        requiredAccess: authRequirementsForToolkit(toolkit),
      },
    ])
  );

  try {
    const response = await getConnectedAccounts(userId);
    const accounts = normalizeConnectionList(response);
    for (const account of accounts) {
      const toolkit = getConnectionToolkit(account);
      const status = String(account.status ?? account.state ?? "").toUpperCase();
      if (toolkit && toolkit in connections) {
        const connected = !status || ["ACTIVE", "CONNECTED", "ENABLED"].includes(status);
        connections[toolkit] = connections[toolkit] || connected;
        details[toolkit] = {
          ...details[toolkit],
          connected: connections[toolkit],
          status: status.toLowerCase() || (connected ? "active" : "unknown"),
          accountId: typeof account.id === "string" ? account.id : undefined,
          updatedAt: typeof account.updatedAt === "string" ? account.updatedAt : typeof account.updated_at === "string" ? account.updated_at : undefined,
          error: connectionErrorText(account),
        };
      }
    }
  } catch (err) {
    console.warn("[connections] failed to list connected accounts", err);
    for (const toolkit of Object.keys(details)) {
      details[toolkit] = {
        ...details[toolkit],
        status: "error",
        error: getErrorMessage(err),
      };
    }
  }

  return { connections, details };
}

function normalizeConnectionList(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  if (!isRecord(value)) {
    return [];
  }
  for (const key of ["items", "data", "connectedAccounts", "connected_accounts"]) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      return candidate.filter(isRecord);
    }
  }
  return [];
}

function getConnectionToolkit(account: Record<string, unknown>) {
  const direct =
    account.toolkitSlug ??
    account.toolkit_slug ??
    account.appName ??
    account.app_name ??
    account.toolkit;
  if (typeof direct === "string") {
    return direct.toLowerCase();
  }
  if (isRecord(account.toolkit)) {
    const slug = account.toolkit.slug ?? account.toolkit.name;
    return typeof slug === "string" ? slug.toLowerCase() : undefined;
  }
  if (isRecord(account.authConfig)) {
    const toolkit = account.authConfig.toolkit ?? account.authConfig.toolkit_slug;
    return typeof toolkit === "string" ? toolkit.toLowerCase() : undefined;
  }
  return undefined;
}

function connectionErrorText(account: Record<string, unknown>) {
  const state = isRecord(account.state) ? account.state : {};
  const val = isRecord(state.val) ? state.val : {};
  const candidates = [
    account.statusReason,
    account.status_reason,
    account.error,
    account.error_description,
    val.error,
    val.error_description,
  ];
  return candidates.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function staticContentType(pathname: string) {
  return STATIC_CONTENT_TYPES[extname(pathname).toLowerCase()] ?? "application/octet-stream";
}

function safeStaticRelativePath(pathname: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (decoded.includes("\0")) {
    return null;
  }

  const normalized = normalize(decoded).replace(/^[/\\]+/, "");
  if (!normalized || normalized === ".") {
    return "index.html";
  }
  if (isAbsolute(normalized) || normalized === ".." || normalized.startsWith(`..${sep}`)) {
    return null;
  }
  return normalized;
}

async function staticFileResponse(pathname: string, method: string) {
  if (pathname !== "/" && pathname.endsWith("/")) {
    return null;
  }

  const relativePath = safeStaticRelativePath(pathname);
  if (!relativePath) {
    return null;
  }

  const filePath = resolve(join(STATIC_DIR, relativePath));
  const relativeToStaticDir = relative(STATIC_DIR, filePath);
  if (relativeToStaticDir === "" || relativeToStaticDir.startsWith("..") || isAbsolute(relativeToStaticDir)) {
    return null;
  }

  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return null;
  }

  const isImmutableAsset = relativeToStaticDir.startsWith(`assets${sep}`);
  return new Response(method === "HEAD" ? null : file, {
    headers: {
      "cache-control": isImmutableAsset ? "public, max-age=31536000, immutable" : "no-cache",
      "content-type": staticContentType(filePath),
    },
  });
}

async function serveFrontend(req: Request) {
  const url = new URL(req.url);
  if (url.pathname === "/healthz") {
    return Response.json({ ok: true });
  }
  if (url.pathname.startsWith("/api/")) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }

  const file = await staticFileResponse(url.pathname, req.method);
  if (file) {
    return file;
  }

  const index = await staticFileResponse("/index.html", req.method);
  if (index) {
    return index;
  }

  return new Response("Frontend build not found. Run `bun run build` before starting the production server.", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: IDLE_TIMEOUT_SECONDS,
  fetch: serveFrontend,
  routes: {
    "/api/session": {
      async POST(req) {
        const body = await readJson(req);
        const existing = typeof body.userId === "string" ? body.userId.trim() : "";
        return Response.json({ userId: existing || makeId("user") });
      },
    },

    "/api/connections": {
      async GET(req) {
        const url = new URL(req.url);
        const userId = url.searchParams.get("userId")?.trim();
        if (!userId) {
          return Response.json({ error: "userId required" }, { status: 400 });
        }
        return Response.json(await getConnectionStatusReport(userId));
      },
    },

    "/api/auth/callback": {
      GET(req) {
        const url = new URL(req.url);
        const toolkit = url.searchParams.get("toolkit") ?? "";
        const status = url.searchParams.get("status") ?? "returned";
        const payload = JSON.stringify({ type: "mini-rube-auth-callback", toolkit, status });
        return new Response(
          `<!doctype html><html><head><title>Mini Rube Auth</title></head><body><p>Authentication ${escapeHtml(status)}. You can close this window.</p><script>try{window.opener&&window.opener.postMessage(${payload},"*")}catch(e){};setTimeout(()=>window.close(),500);</script></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } }
        );
      },
    },

    "/api/connect/:toolkit": {
      async POST(req) {
        const toolkit = req.params.toolkit;
        const body = await readJson(req);
        const userId = typeof body.userId === "string" ? body.userId : "";
        const forceReconnect = body.forceReconnect === true;
        if (!userId) {
          return Response.json({ error: "userId required" }, { status: 400 });
        }
        if (!AUTH_CONFIGS[toolkit]) {
          return Response.json(
            { error: `Unknown toolkit: ${toolkit}. Available: ${Object.keys(AUTH_CONFIGS).join(", ")}` },
            { status: 400 }
          );
        }
        try {
          const callbackUrl = new URL(`/api/auth/callback?toolkit=${encodeURIComponent(toolkit)}`, req.url).toString();
          const link = await connectAccount(userId, toolkit, { callbackUrl, forceReconnect });
          const redirectUrl = (link as any).redirectUrl ?? (link as any).url;
          const connectionId = String((link as any).id ?? (link as any).connectedAccountId ?? "");
          pendingConnections.set(connectionKey(userId, toolkit), {
            link,
            userId,
            toolkit,
            connectionId,
            redirectUrl,
            createdAt: nowIso(),
          });
          return Response.json({
            redirectUrl,
            id: connectionId,
            connectionId,
            toolkit,
            requiredAccess: authRequirementsForToolkit(toolkit),
          });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      },
    },

    "/api/connect/:toolkit/wait": {
      async POST(req) {
        const toolkit = req.params.toolkit;
        const body = await readJson(req);
        const userId = typeof body.userId === "string" ? body.userId : "";
        const timeoutMs = Math.max(1_000, Math.min(15_000, toNumber(body.timeoutMs) ?? 8_000));
        const pending = pendingConnections.get(connectionKey(userId, toolkit));
        if (!userId) {
          return Response.json({ error: "userId required" }, { status: 400 });
        }
        if (!pending) {
          return Response.json({ error: "No pending connection for " + toolkit }, { status: 400 });
        }
        try {
          await pending.link.waitForConnection(timeoutMs);
          pendingConnections.delete(connectionKey(userId, toolkit));
          return Response.json({ connected: true, toolkit });
        } catch (err: any) {
          if (isConnectionWaitTimeout(err)) {
            return Response.json(
              {
                connected: false,
                toolkit,
                status: "pending",
                connectionId: pending.connectionId,
                message: "OAuth has not completed yet.",
              },
              { status: 202 }
            );
          }
          pendingConnections.delete(connectionKey(userId, toolkit));
          return Response.json({ error: err.message }, { status: 500 });
        }
      },
    },

    "/api/connect/:toolkit/cancel": {
      async POST(req) {
        const toolkit = req.params.toolkit;
        const body = await readJson(req);
        const userId = typeof body.userId === "string" ? body.userId : "";
        if (!userId) {
          return Response.json({ error: "userId required" }, { status: 400 });
        }
        const pending = pendingConnections.get(connectionKey(userId, toolkit));
        pendingConnections.delete(connectionKey(userId, toolkit));
        if (pending?.connectionId) {
          await deleteConnectedAccount(pending.connectionId);
        }
        return Response.json({ connected: false, toolkit, status: "cancelled" });
      },
    },

    "/api/connect/:toolkit/disconnect": {
      async POST(req) {
        const toolkit = req.params.toolkit;
        const body = await readJson(req);
        const userId = typeof body.userId === "string" ? body.userId : "";
        if (!userId) {
          return Response.json({ error: "userId required" }, { status: 400 });
        }
        pendingConnections.delete(connectionKey(userId, toolkit));
        await deleteConnectedAccountsForToolkit(userId, toolkit);
        return Response.json({ connected: false, toolkit, status: "disconnected" });
      },
    },

    "/api/files": {
      async POST(req) {
        try {
          const form = await req.formData();
          const userId = String(form.get("userId") ?? "").trim();
          const file = form.get("file");
          if (!userId) {
            return Response.json({ error: "userId required" }, { status: 400 });
          }
          if (!file || typeof (file as File).arrayBuffer !== "function") {
            return Response.json({ error: "PDF file required" }, { status: 400 });
          }
          const uploaded = await uploadPdfToComposio({ file: file as File, userId });
          uploadedFiles.set(uploaded.id, uploaded);
          return Response.json({
            id: uploaded.id,
            filename: uploaded.filename,
            size: uploaded.size,
            mimeType: uploaded.mimeType,
            composioFileRef: uploaded.composioFileRef,
          });
        } catch (err: any) {
          return Response.json({ error: err.message ?? String(err) }, { status: 500 });
        }
      },
    },

    "/api/actions/:id/confirm": {
      async POST(req) {
        const body = await readJson(req);
        const userId = typeof body.userId === "string" ? body.userId : "";
        if (!userId) {
          return Response.json({ error: "userId required" }, { status: 400 });
        }
        return confirmAction(req.params.id, userId);
      },
    },

    "/api/runs/:id": {
      GET(req) {
        const run = runs.get(req.params.id);
        if (!run) {
          return Response.json({ error: "Run not found" }, { status: 404 });
        }
        return Response.json({
          run,
          pendingActions: run.pendingActions.map((id) => pendingActions.get(id)).filter(Boolean),
        });
      },
    },

    "/api/jobs": {
      async POST(req) {
        const body = await readJson(req);
        const userId = typeof body.userId === "string" ? body.userId : "";
        const workflowId = typeof body.intentId === "string" ? body.intentId : typeof body.workflowId === "string" ? body.workflowId : "";
        const workflow = workflowDefinitionForId(workflowId);
        if (!userId) {
          return Response.json({ error: "userId required" }, { status: 400 });
        }
        if (!workflow) {
          return Response.json({ error: "Supported workflowId required" }, { status: 400 });
        }
        const prompt = typeof body.prompt === "string" ? body.prompt : "";
        const run = createRun(userId, prompt, [], "direct workflow job");
        const job = await workflowStore.createJob({
          workflowId: workflow.id,
          userId,
          input: {
            userId,
            prompt,
            repository: typeof body.repository === "string" ? body.repository : undefined,
            folderId: typeof body.folderId === "string" ? body.folderId : undefined,
            spreadsheetTitle: typeof body.spreadsheetTitle === "string" ? body.spreadsheetTitle : undefined,
          },
        });
        startWorkflowJob(workflow, job, run);
        return Response.json({ run, job: jobResponse(job) });
      },
    },

    "/api/jobs/:id": {
      async GET(req) {
        const job = await workflowStore.getJob(req.params.id);
        if (!job) {
          return Response.json({ error: "Workflow job not found" }, { status: 404 });
        }
        return Response.json({ job: jobResponse(job) });
      },
    },

    "/api/jobs/:id/confirm": {
      async POST(req) {
        const body = await readJson(req);
        const userId = typeof body.userId === "string" ? body.userId : "";
        if (!userId) {
          return Response.json({ error: "userId required" }, { status: 400 });
        }
        return confirmWorkflowJob(req.params.id, userId);
      },
    },

    "/api/jobs/:id/cancel": {
      async POST(req) {
        const body = await readJson(req);
        const userId = typeof body.userId === "string" ? body.userId : "";
        const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : "Cancelled by user";
        if (!userId) {
          return Response.json({ error: "userId required" }, { status: 400 });
        }
        return cancelWorkflowJob(req.params.id, userId, reason);
      },
    },

    "/api/tools": {
      async GET() {
        try {
          const liveTools = await getToolCatalog();
          const liveBySlug = new Map(liveTools.map((tool) => [tool.slug, tool]));
          const tools = supportedToolSlugs().map((slug) => liveBySlug.get(slug) ?? {
            slug,
            description: "",
            toolkit: toolkitForSlug(slug),
          });
          return Response.json({ tools });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      },
    },

    "/api/chat": {
      async POST(req) {
        const body = await readJson(req);
        const messages: CoreMessage[] = body.messages ?? [];
        const userId = typeof body.userId === "string" ? body.userId : "";
        const fileIds = Array.isArray(body.fileIds) ? body.fileIds.filter((id: unknown) => typeof id === "string") : [];

        if (!userId) {
          return Response.json({ error: "userId required" }, { status: 400 });
        }

        const prompt = latestUserText(messages);

        if (isCapabilitiesPrompt(prompt)) {
          const run = createRun(userId, prompt, [], "local capabilities response");
          run.status = "completed";
          addTrace(run, {
            type: "info",
            title: "Answered locally",
            detail: "Capabilities prompt does not require model or tool calls.",
          });
          return makeLocalTextResponse(capabilitiesText(run.id), run.id);
        }

        // If we just asked for a workflow source and this turn supplies it, resume
        // that workflow rather than re-routing the terse reply as a new request.
        const resumed = await maybeResumeWorkflowFromFollowup(messages, prompt, userId);
        if (resumed) return resumed;

        const activeCalendarTask = activeCalendarTaskForFollowup(userId, messages, prompt);
        const route = activeCalendarTask
          ? activeTaskRoute(activeCalendarTask)
          : await routeToolsForPrompt(prompt, {
              messages: routeMessages(messages),
            });
        const routeResponseHeaders = clearActiveJobHeaders(route);
        let calendarTask = activeCalendarTask;
        if (!calendarTask && routeIsCalendarSchedule(route)) {
          calendarTask = saveCalendarTask(userId, prompt, route);
        }

        if (route.routeScope === "ambiguous" && route.clarification) {
          const run = createRun(userId, prompt, [], route.rationale);
          run.status = "completed";
          addTrace(run, {
            type: "info",
            title: "Ambiguous follow-up",
            detail: route.clarification,
          });
          return makeLocalTextResponse(route.clarification, run.id);
        }

        if (route.slugs.length === 0 && isUnsupportedNoToolAction(prompt)) {
          const run = createRun(userId, prompt, [], "no supported tool route");
          run.status = "completed";
          addTrace(run, {
            type: "info",
            title: "No supported tool",
            detail: "The request asks for an external action outside the supported tool surface.",
          });
          return makeLocalTextResponse(unsupportedNoToolActionText(), run.id, routeResponseHeaders);
        }

        const requiredToolkits = requiredToolkitsForSlugs(route.slugs);
        if (requiredToolkits.length) {
          const connections = await getConnectionStatuses(userId);
          const missingToolkits = requiredToolkits.filter((toolkit) => !connections[toolkit]);

          if (missingToolkits.length) {
            const run = createRun(userId, prompt, route.slugs, "missing required connection");
            run.status = "completed";
            addTrace(run, {
              type: "info",
              title: "Missing connection",
              detail: missingToolkits.map(connectionLabel).join(", "),
            });
            return makeLocalTextResponse(missingConnectionText(missingToolkits, run.id), run.id, routeResponseHeaders);
          }
        }

        const workflow = isWorkflowIntent(route.intentIds);
        if (workflow) {
          // Both workflows need a source (Drive folder / GitHub repo). Resolve it up
          // front; if we can't, ask the user conversationally instead of starting a
          // job that would just fail.
          const extraInput: Record<string, unknown> = {};
          let workflowPrompt = prompt;
          if (workflow.id === "drive.resumes_to_sheet") {
            const { resolution, promptForJob } = await resolveDriveFolderForWorkflow(messages, prompt, userId);
            if ("ask" in resolution) {
              return workflowInputNeededResponse(userId, prompt, route, resolution.ask);
            }
            workflowPrompt = promptForJob;
            extraInput.folderId = resolution.folderId;
          } else if (workflow.id === "github.issues_to_sheet") {
            const { resolution, promptForJob } = resolveGithubRepoForWorkflow(messages, prompt);
            if ("ask" in resolution) {
              return workflowInputNeededResponse(userId, prompt, route, resolution.ask);
            }
            workflowPrompt = promptForJob;
            extraInput.repository = resolution.repository;
          }

          return startWorkflowResponse(workflow, userId, workflowPrompt, route.slugs, route.rationale, extraInput);
        }

        if (routeIsCalendarSchedule(route)) {
          const task = calendarTask ?? saveCalendarTask(userId, prompt, route);
          const combinedPrompt = activeTaskPrompt(task);
          const draft = parseCalendarEventDraft(combinedPrompt, {
            now: new Date(),
            timeZone: DEFAULT_CALENDAR_TIMEZONE,
          });
          if (draft) {
            clearActiveTask(userId, CALENDAR_SCHEDULE_INTENT_ID);
            return calendarDraftResponse(userId, combinedPrompt, route, draft, routeResponseHeaders);
          }
        }

        const files = filesForUser(userId, fileIds);
        if (isAttachedPdfEmailRequest(route, prompt) && files.length === 0) {
          return attachedPdfMissingResponse(userId, prompt, route, fileIds.length > 0, routeResponseHeaders);
        }

        const emailDraft = route.slugs.includes("GOOGLESUPER_SEND_EMAIL")
          ? parseAttachedEmailDraft(prompt, files)
          : null;
        if (emailDraft) {
          return emailDraftResponse(userId, prompt, route, emailDraft, routeResponseHeaders);
        }

        const toolSchemas = await loadToolSchemas(route.slugs);
        if (route.slugs.length > 0 && toolSchemas.length === 0) {
          const run = createRun(userId, prompt, route.slugs, "tool schema load failed");
          run.status = "completed";
          addTrace(run, {
            type: "error",
            title: "Selected tool schemas unavailable",
            detail: route.slugs.join(", "),
          });
          return makeLocalTextResponse(missingToolSchemaText(route, run.id), run.id, routeResponseHeaders);
        }
        const runPrompt = effectiveRunPrompt(messages, prompt, route);
        const run = createRun(userId, runPrompt, toolSchemas.map(getToolSlug).filter(Boolean), route.rationale);

        if (files.length) {
          addTrace(run, {
            type: "info",
            title: "Attached files",
            detail: files.map((file) => file.filename).join(", "),
          });
        }

        const currentDate = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Kolkata",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date());

        const attachedNames = files.map((file) => file.filename).join(", ");
        const filesNote = files.length
          ? `\n\nIMPORTANT — attachments: The user has ALREADY uploaded ${files.length} file(s) for this request: ${attachedNames}. The file(s) are present now and will be attached automatically by the system when you call the send-email tool. Do NOT ask the user to upload, re-upload, share, or provide the file again, and do not say you cannot see it — it is already here. Do NOT set or guess the attachment field yourself (you do not have the file's storage key); just call the send-email tool with the recipient/subject/body and the system attaches the file.`
          : route.intentIds?.includes("email.send_with_upload")
            ? `\n\nIMPORTANT — attachments: The user is asking about an attached/uploaded PDF, but no file is attached in this chat turn. Ask them to upload the PDF using the app's PDF button and provide any missing email details. Do NOT ask for file paths, storage keys, S3 keys, upload keys, or internal file references. Do NOT call the send-email tool until a file is attached and the recipient/message details are available.`
          : "";

        // Also reinforce the attachment fact inside the conversation (see helper).
        const messagesForModel = files.length ? appendAttachmentNote(messages, attachedNames) : messages;

        const toolsForRequest = run.selectedTools.length ? run.selectedTools.join(", ") : "(none for this request)";
        const system = `You are Mini Rube, a general agent that acts through Composio direct tools.

Current date: ${currentDate}. Treat relative dates like "tomorrow" from this date unless the user specifies otherwise.

SCOPE — you can ONLY act through the services connected via Composio: Google (Gmail, Google Calendar, Google Drive, Google Sheets) and GitHub. You have NO access to Slack, Notion, Microsoft/Teams, Linear, or any other service. If the user asks for something you have no tool for (e.g. "send a Slack message"), tell them plainly you can't do that and briefly note what you can do (Google and GitHub) — never claim or pretend to do it, and never invent a tool you don't have.

You have only the selected tools for this request: ${toolsForRequest}.
Do not mention unavailable tools. Do not use or request COMPOSIO_* meta tools.${filesNote}

Format answers in Markdown: use short paragraphs, bullet lists for multiple items, and Markdown links for any URLs (sheets, docs, issues).
When listing records that include a URL/htmlUrl/webUrl field, make each record title a Markdown link unless the user explicitly asks for plain text only.
For missing required details, ask concise follow-up questions.
For read-only requests, always answer with the relevant records or summary from the tool result. Never reply only with "Done", "Fetched", or a generic completion acknowledgement after a successful read.
If a tool result has category "auth" or mentions missing/insufficient OAuth scopes, tell the user the connected account does not have the required permission and ask them to reconnect the relevant account from the app header. Do not retry the same tool call or claim the action succeeded.
For large tasks, paginate and process in batches. Do not request huge context windows. When writing sheets, preserve one row per source item and include an error/status column rather than dropping failed items.
When the user asks for a specific quantity (e.g. "my last 100 emails"), request that many; if a single read returns fewer than asked and the response includes a next-page token, fetch the next page(s) until you have the requested count or the source is exhausted. Give ONE clean final answer — do not narrate each fetch attempt ("let me try the next page…") as separate prose, and never surface raw API internals (next-page tokens, result-size estimates, fields like "itemCount" or "resultSizeEstimate", "truncated at item boundaries") to the user. A compacted preview count is not the mailbox total. If the source genuinely holds fewer items than requested, simply state the real count plainly (e.g. "Your mailbox has 23 emails — here they are:") and list them; do not present an estimate as if it were the total.
Before sending email, creating calendar events, creating/updating sheets, or any other external mutation, the tool returns a pending action that the user must approve in the UI. Clearly describe what you are about to do and that it is awaiting confirmation. Do not claim it has been completed until the user confirms.
For destructive or bulk-irreversible requests (e.g. "delete all my emails", deleting many files, mass changes), be especially cautious: warn that it is permanent, do NOT fetch or stage items just to make the deletion easier, and ask the user to confirm a specific, narrowly-scoped target rather than acting on a blanket "delete everything".
A confirmation/approve button appears in the UI ONLY when you actually call one of those mutating tools. NEVER tell the user an action is "awaiting confirmation" or to "click confirm" unless you actually called such a tool in this turn. If you have no tool for the request, just say you can't do it.
When you resolve a person's email from their name (e.g. scheduling a calendar event with "karan"), NEVER write the full resolved email address anywhere in your reply — refer to the person by name only, or mask it as ***@domain. This holds even if the user then asks "what is their email?". (Recipient addresses the user typed themselves are fine to echo.)`;

        const result = streamText({
          model: agentModel(AGENT_MODEL),
          system,
          messages: messagesForModel,
          tools: makeAITools(toolSchemas, { userId, run, files }),
          maxSteps: 25,
          maxTokens: AGENT_MAX_TOKENS,
          temperature: 0.2,
          onError: ({ error }) => {
            console.error("[chat stream error]", getErrorMessage(error), error);
            run.status = "failed";
            addTrace(run, {
              type: "error",
              title: "Model stream failed",
              detail: getErrorMessage(error),
            });
          },
          onFinish: () => {
            if (run.status === "running") {
              run.status = "completed";
              run.updatedAt = nowIso();
            }
          },
        });

        return result.toDataStreamResponse({
          headers: {
            "x-run-id": run.id,
            ...routeResponseHeaders,
          },
          getErrorMessage,
        });
      },
    },
  },
  development: {
    hmr: process.env.NODE_ENV !== "production",
    console: true,
  },
});

console.log(`Server running at http://0.0.0.0:${PORT}`);
