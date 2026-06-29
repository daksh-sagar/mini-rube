import type { WorkflowJob, WorkflowStore } from "../job-store";
import { generateJson } from "../llm";

export type WorkflowDefinition = {
  id: "github.issues_to_sheet" | "drive.resumes_to_sheet";
  label: string;
};

export type WorkflowProgress = {
  totalItems: number;
  fetchedItems: number;
  processedItems: number;
  writtenRows: number;
  failedItems: number;
  phase: string;
};

export type WorkflowArtifact = {
  label: string;
  url?: string;
  value?: unknown;
};

export type ToolExecutionContext = {
  userId: string;
  jobId: string;
  approvalId?: string;
};

export type ApprovalRequest = {
  jobId: string;
  workflowId: string;
  toolSlugs: string[];
  summary: string;
  rowCount: number;
};

export type ApprovalGrant = {
  approved: true;
  approvalId: string;
  scope: "workflow";
};

export type WorkflowServiceOptions = {
  store: WorkflowStore;
  executeTool: (slug: string, args: Record<string, unknown>, context: ToolExecutionContext) => Promise<unknown>;
  requestApproval: (request: ApprovalRequest) => Promise<ApprovalGrant>;
  isCancelled?: (jobId: string) => Promise<boolean> | boolean;
  defaults?: {
    pageSize?: number;
    sheetBatchSize?: number;
    sheetValueMode?: "recordRows" | "googleValues";
    workerId?: string;
    useLlmExtraction?: boolean;
    workflowConcurrency?: number;
  };
};

export type WorkflowRunInput = Record<string, unknown> & {
  userId?: string;
  prompt?: string;
  repository?: string;
  folderId?: string;
  spreadsheetTitle?: string;
  jobId?: string;
};

export type WorkflowRunStatus = "completed" | "failed" | "cancelled";

export type WorkflowRunResult = {
  status: WorkflowRunStatus;
  jobId: string;
  workflowId: string;
  totalItems: number;
  writtenRows: number;
  failedItems: number;
  artifacts: WorkflowArtifact[];
};

type WorkflowRuntime = Required<NonNullable<WorkflowServiceOptions["defaults"]>> & {
  store: WorkflowStore;
  executeTool: WorkflowServiceOptions["executeTool"];
  requestApproval: WorkflowServiceOptions["requestApproval"];
  isCancelled: NonNullable<WorkflowServiceOptions["isCancelled"]>;
};

type SheetWriteResult = {
  spreadsheetId?: string;
  spreadsheetUrl?: string;
  writtenRows: number;
  artifacts: WorkflowArtifact[];
};

type GithubIssueCollectionOptions = {
  limit?: number;
  sort: "created" | "updated";
  direction: "asc" | "desc";
  state: "all" | "open" | "closed";
};

export const GITHUB_ISSUES_TO_SHEET: WorkflowDefinition = {
  id: "github.issues_to_sheet",
  label: "GitHub issues to Google Sheet",
};

export const DRIVE_RESUMES_TO_SHEET: WorkflowDefinition = {
  id: "drive.resumes_to_sheet",
  label: "Drive resumes to Google Sheet",
};

const GITHUB_HEADERS = [
  "issueNumber",
  "title",
  "state",
  "author",
  "createdAt",
  "updatedAt",
  "labels",
  "url",
  "problemSummary",
  "status",
  "error",
];

const RESUME_HEADERS = [
  "fileId",
  "filename",
  "url",
  "candidateName",
  "university",
  "lastJob",
  "status",
  "error",
];

export function createWorkflowService(options: WorkflowServiceOptions) {
  const runtime: WorkflowRuntime = {
    store: options.store,
    executeTool: options.executeTool,
    requestApproval: options.requestApproval,
    isCancelled:
      options.isCancelled ??
      (async (jobId) => {
        const job = await options.store.getJob(jobId);
        return job?.status === "cancelled";
      }),
    pageSize: options.defaults?.pageSize ?? 100,
    sheetBatchSize: options.defaults?.sheetBatchSize ?? 100,
    sheetValueMode: options.defaults?.sheetValueMode ?? "recordRows",
    workerId: options.defaults?.workerId ?? "workflow_service",
    useLlmExtraction: options.defaults?.useLlmExtraction ?? false,
    workflowConcurrency: positiveInteger(options.defaults?.workflowConcurrency, 1),
  };

  return {
    runWorkflow(workflow: WorkflowDefinition | string, input: WorkflowRunInput) {
      const workflowId = workflowIdOf(workflow);
      if (workflowId === GITHUB_ISSUES_TO_SHEET.id) {
        return runGithubIssuesToSheet(runtime, input);
      }
      if (workflowId === DRIVE_RESUMES_TO_SHEET.id) {
        return runDriveResumesToSheet(runtime, input);
      }
      throw new Error(`Unsupported workflow: ${workflowId}`);
    },
  };
}

export function workflowIdOf(workflow: WorkflowDefinition | string) {
  return typeof workflow === "string" ? workflow : workflow.id;
}

export function isWorkflowIntent(intentIds: string[] | undefined) {
  const ids = new Set(intentIds ?? []);
  if (ids.has(GITHUB_ISSUES_TO_SHEET.id)) {
    return GITHUB_ISSUES_TO_SHEET;
  }
  if (ids.has(DRIVE_RESUMES_TO_SHEET.id)) {
    return DRIVE_RESUMES_TO_SHEET;
  }
  return null;
}

export const NO_REPO_MESSAGE =
  "I can build that sheet — which GitHub repository should I pull issues from? Tell me the owner/repo (e.g. composiohq/composio) or paste the repo URL.";

// Words that show up in "x/y" phrases ("and/or", "input/output") but aren't repos.
const REPO_FALSE_POSITIVES = new Set([
  "and", "or", "either", "neither", "input", "output", "to", "from", "yes", "no", "on", "off", "read", "write", "he", "she",
]);

export function tryParseGithubRepository(
  input: WorkflowRunInput
): { owner: string; repo: string; repository: string } | null {
  const source = String(input.repository ?? input.prompt ?? "");
  const url = source.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/);
  const match = url ?? source.match(/\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\b/);
  if (!match) return null;
  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, "");
  // The bare "x/y" fallback can match prose like "and/or" — reject obvious non-repos.
  if (!url && (REPO_FALSE_POSITIVES.has(owner.toLowerCase()) || REPO_FALSE_POSITIVES.has(repo.toLowerCase()))) {
    return null;
  }
  return { owner, repo, repository: `${owner}/${repo}` };
}

export function parseGithubRepository(input: WorkflowRunInput) {
  const parsed = tryParseGithubRepository(input);
  if (!parsed) throw new Error(NO_REPO_MESSAGE);
  return parsed;
}

export function resolveGithubRepoRequest(prompt: string): { repository: string } | { ask: string } {
  const parsed = tryParseGithubRepository({ prompt });
  if (parsed) return { repository: parsed.repository };
  return { ask: NO_REPO_MESSAGE };
}

const FOLDER_NAME_STOPWORDS = new Set([
  "this", "the", "my", "a", "an", "that", "your", "our", "same",
  "drive", "google", "shared", "above", "current", "given", "following", "specified",
]);

export const NO_FOLDER_MESSAGE =
  "I can build that sheet — which Drive folder are the resumes in? Paste the folder's share link (open it in Drive → Share → Copy link) or tell me its exact name, and I'll pull every resume's candidate name, university, and last job into a Google Sheet.";

// A tool executor scoped to a user — lets the server (pre-check) and the workflow
// runtime share one folder-resolution implementation.
export type FolderToolExecutor = (slug: string, args: Record<string, unknown>) => Promise<unknown>;

export type DriveFolderResolution = { folderId: string } | { ask: string };

// Pull an explicit Drive folder id out of the request without throwing.
// An explicit `folderId` (e.g. from the direct-trigger API) is authoritative; the
// prompt is only scanned for a share link, an `id=` param, or a long Drive-id token.
export function tryParseDriveFolderId(input: WorkflowRunInput): string | null {
  if (typeof input.folderId === "string" && input.folderId.trim()) {
    return input.folderId.trim();
  }
  const source = String(input.prompt ?? "");
  const link =
    source.match(/\/folders\/([A-Za-z0-9_-]+)/) ?? source.match(/[?&]id=([A-Za-z0-9_-]+)/);
  if (link) return link[1];
  // Drive ids are long mixed tokens — require length + a digit so ordinary words
  // ("university", "candidate") never get mistaken for an id.
  const bare = source.match(/\b([A-Za-z0-9_-]{20,})\b/);
  if (bare && /\d/.test(bare[1])) return bare[1];
  return null;
}

// Best-effort: if the user names a folder ("the pdfs folder", 'folder named "Q3"'),
// pull that name so we can resolve it to an id via FIND_FOLDER.
export function extractFolderNameHint(prompt: string): string | null {
  const text = String(prompt ?? "");
  // 1) "folder named/called/titled X" — X quoted, or a short bare phrase.
  let m = text.match(/folder\s+(?:named|called|titled)\s+["']([^"'\n]{1,60})["']/i);
  if (m) return m[1].trim();
  m = text.match(
    /folder\s+(?:named|called|titled)\s+([A-Za-z0-9][A-Za-z0-9 _-]{0,58}?)(?=\s+(?:and|then|please|to)\b|[,.]|$)/i
  );
  if (m) return m[1].trim();
  // 2) a quoted name adjacent to "folder": "X" folder  or  folder "X".
  m =
    text.match(/["']([^"'\n]{1,60})["']\s+folder\b/i) ??
    text.match(/folder\s+["']([^"'\n]{1,60})["']/i);
  if (m) return m[1].trim();
  // 3) "<words> folder" — take the last word before "folder" unless it's a stopword.
  m = text.match(/\b([A-Za-z0-9_][A-Za-z0-9 _-]{0,40})\s+folder\b/i);
  if (m) {
    const last = (m[1].trim().split(/\s+/).pop() ?? "").trim();
    if (last && !FOLDER_NAME_STOPWORDS.has(last.toLowerCase())) return last;
  }
  return null;
}

export function parseDriveFolderId(input: WorkflowRunInput): string {
  const id = tryParseDriveFolderId(input);
  if (!id) throw new Error(NO_FOLDER_MESSAGE);
  return id;
}

// Resolve the target folder, or return a conversational ask. Shared by the server
// pre-check (so we never start a doomed job) and the workflow runtime.
// Order: explicit id/link → named folder via FIND_FOLDER → ask the user.
export async function resolveDriveFolderRequest(
  prompt: string,
  exec: FolderToolExecutor
): Promise<DriveFolderResolution> {
  const explicit = tryParseDriveFolderId({ prompt });
  if (explicit) return { folderId: explicit };

  const hint = extractFolderNameHint(prompt);
  if (!hint) return { ask: NO_FOLDER_MESSAGE };

  const found = await lookupDriveFolderIdByName(hint, exec);
  if (found) return { folderId: found };
  return {
    ask: `I couldn't find a Drive folder named "${hint}". Double-check the spelling, or paste the folder's share link (Share → Copy link) and I'll process it.`,
  };
}

export async function lookupDriveFolderIdByName(
  name: string,
  exec: FolderToolExecutor
): Promise<string | null> {
  try {
    const result = await exec("GOOGLESUPER_FIND_FOLDER", { query: name });
    const folders = findCollection(result, ["files", "folders", "items", "results"]);
    const target = name.trim().toLowerCase();
    const exact = folders.find(
      (f) => String((f as Record<string, unknown>).name ?? "").trim().toLowerCase() === target
    );
    const partial = folders.find((f) =>
      String((f as Record<string, unknown>).name ?? "").toLowerCase().includes(target)
    );
    const picked = exact ?? partial;
    return picked ? firstString(picked, ["id", "fileId", "file_id"]) ?? null : null;
  } catch {
    return null;
  }
}

// Lenient resolver for a follow-up reply to "which Drive folder?". The whole reply
// is the answer, so a bare name ("pdfs") or "the pdfs folder" or a link all work.
export async function resolveDriveFolderReply(
  reply: string,
  exec: FolderToolExecutor
): Promise<DriveFolderResolution> {
  const id = tryParseDriveFolderId({ prompt: reply });
  if (id) return { folderId: id };

  let name = extractFolderNameHint(reply);
  if (!name) {
    const trimmed = reply
      .trim()
      .replace(/^(it'?s|its|the|folder|named|called|use)\s+/gi, "")
      .replace(/\s+folder\s*$/i, "")
      .trim();
    if (trimmed && trimmed.length <= 50 && trimmed.split(/\s+/).length <= 4) name = trimmed;
  }
  if (!name) return { ask: NO_FOLDER_MESSAGE };

  const found = await lookupDriveFolderIdByName(name, exec);
  if (found) return { folderId: found };
  return {
    ask: `I couldn't find a Drive folder named "${name}". Double-check the spelling, or paste the folder's share link (Share → Copy link) and I'll process it.`,
  };
}

// Workflow-runtime wrapper: honor an explicit folderId, else resolve / throw the ask.
async function resolveDriveFolderId(
  runtime: WorkflowRuntime,
  input: WorkflowRunInput,
  jobId: string
): Promise<string> {
  const explicit = tryParseDriveFolderId(input);
  if (explicit) return explicit;

  const userId = String(input.userId ?? "");
  const resolution = await resolveDriveFolderRequest(String(input.prompt ?? ""), (slug, args) =>
    runtime.executeTool(slug, args, { userId, jobId })
  );
  if ("folderId" in resolution) return resolution.folderId;
  throw new Error(resolution.ask);
}

async function runGithubIssuesToSheet(
  runtime: WorkflowRuntime,
  input: WorkflowRunInput
): Promise<WorkflowRunResult> {
  const job = await prepareJob(runtime, GITHUB_ISSUES_TO_SHEET.id, input);
  try {
    const repo = parseGithubRepository(input);
    const collectionOptions = githubIssueCollectionOptions(input);
    await updateProgress(runtime, job.id, { phase: "fetching", totalItems: 0 });
    const issues = await collectGithubIssues(runtime, job, repo.owner, repo.repo, collectionOptions);
    const rows = issues.map((issue) => githubIssueToRow(issue));
    await updateProgress(runtime, job.id, {
      phase: "approval",
      totalItems: rows.length,
      fetchedItems: rows.length,
      processedItems: rows.length,
      failedItems: 0,
    });

    await assertNotCancelled(runtime, job.id, {
      totalItems: rows.length,
      failedItems: 0,
    });
    const approval = await requestWorkflowApproval(runtime, job, {
      workflowId: GITHUB_ISSUES_TO_SHEET.id,
      toolSlugs: ["GOOGLESUPER_SHEET_FROM_JSON", "GOOGLESUPER_SPREADSHEETS_VALUES_APPEND"],
      summary: `Create a Google Sheet with ${rows.length} GitHub issue rows for ${repo.repository}.`,
      rowCount: rows.length,
    });

    const sheet = await writeRowsToSheet(runtime, job, {
      title: String(input.spreadsheetTitle ?? `${repo.repository} issue report`),
      sheetName: "Issues",
      headers: GITHUB_HEADERS,
      rows,
      approvalId: approval.approvalId,
    });

    return completeWorkflow(runtime, job.id, GITHUB_ISSUES_TO_SHEET.id, rows.length, 0, sheet);
  } catch (err) {
    if (err instanceof WorkflowCancelledError) {
      return cancelWorkflow(runtime, job.id, GITHUB_ISSUES_TO_SHEET.id, err.totalItems, err.writtenRows, err.failedItems);
    }
    return failWorkflow(runtime, job.id, GITHUB_ISSUES_TO_SHEET.id, err);
  }
}

async function runDriveResumesToSheet(
  runtime: WorkflowRuntime,
  input: WorkflowRunInput
): Promise<WorkflowRunResult> {
  const job = await prepareJob(runtime, DRIVE_RESUMES_TO_SHEET.id, input);
  try {
    const folderId = await resolveDriveFolderId(runtime, input, job.id);
    const limit = explicitResumeLimit(input);
    await updateProgress(runtime, job.id, { phase: "listing", totalItems: 0 });
    const files = await collectDriveFiles(runtime, job, folderId, limit);
    const rows = await parseResumeFiles(runtime, job, files);

    await assertNotCancelled(runtime, job.id, {
      totalItems: rows.length,
      failedItems: countFailedRows(rows),
    });
    const approval = await requestWorkflowApproval(runtime, job, {
      workflowId: DRIVE_RESUMES_TO_SHEET.id,
      toolSlugs: ["GOOGLESUPER_SHEET_FROM_JSON", "GOOGLESUPER_SPREADSHEETS_VALUES_APPEND"],
      summary: `Create a Google Sheet with ${rows.length} resume candidate rows from Drive folder ${folderId}.`,
      rowCount: rows.length,
    });

    const sheet = await writeRowsToSheet(runtime, job, {
      title: String(input.spreadsheetTitle ?? "Candidate resumes"),
      sheetName: "Candidates",
      headers: RESUME_HEADERS,
      rows,
      approvalId: approval.approvalId,
    });

    return completeWorkflow(runtime, job.id, DRIVE_RESUMES_TO_SHEET.id, rows.length, countFailedRows(rows), sheet);
  } catch (err) {
    if (err instanceof WorkflowCancelledError) {
      return cancelWorkflow(runtime, job.id, DRIVE_RESUMES_TO_SHEET.id, err.totalItems, err.writtenRows, err.failedItems);
    }
    return failWorkflow(runtime, job.id, DRIVE_RESUMES_TO_SHEET.id, err);
  }
}

async function prepareJob(runtime: WorkflowRuntime, workflowId: string, input: WorkflowRunInput) {
  if (typeof input.jobId === "string") {
    const existing = await runtime.store.getJob(input.jobId);
    if (existing) {
      if (["queued", "interrupted"].includes(existing.status)) {
        return (
          (await runtime.store.claimNextRunnableJob({
            workflowId,
            workerId: runtime.workerId,
          })) ?? existing
        );
      }
      return existing;
    }
  }

  const userId = typeof input.userId === "string" && input.userId.trim() ? input.userId.trim() : "workflow_user";
  const created = await runtime.store.createJob({ workflowId, userId, input });
  return (
    (await runtime.store.claimNextRunnableJob({ workflowId, workerId: runtime.workerId })) ??
    created
  );
}

async function collectGithubIssues(
  runtime: WorkflowRuntime,
  job: WorkflowJob,
  owner: string,
  repo: string,
  options: GithubIssueCollectionOptions
) {
  const byNumber = new Map<number, Record<string, unknown>>();
  let page = 1;
  const pageSize = options.limit ? Math.min(runtime.pageSize, options.limit) : runtime.pageSize;

  while (true) {
    await assertNotCancelled(runtime, job.id, {
      totalItems: byNumber.size,
      failedItems: 0,
    });
    const result = await executeWithRetry(runtime, "GITHUB_LIST_REPOSITORY_ISSUES", {
      owner,
      repo,
      state: options.state,
      per_page: pageSize,
      page,
      direction: options.direction,
      sort: options.sort,
    }, context(job));
    const items = findCollection(result, ["issues", "items", "results"]);
    for (const item of items) {
      if (isRecord(item.pull_request)) {
        continue;
      }
      const number = toNumber(item.number);
      if (number !== undefined) {
        byNumber.set(number, item);
      }
      if (options.limit && byNumber.size >= options.limit) {
        break;
      }
    }

    await runtime.store.saveCheckpoint(job.id, {
      step: "fetch-github-issues",
      page,
      fetchedItems: byNumber.size,
    });
    await updateProgress(runtime, job.id, {
      phase: "fetching",
      fetchedItems: byNumber.size,
      processedItems: byNumber.size,
      totalItems: options.limit
        ? Math.min(options.limit, bestTotal(result, byNumber.size))
        : bestTotal(result, byNumber.size),
    });

    if (options.limit && byNumber.size >= options.limit) {
      break;
    }
    if (!hasNextPage(result, items.length, pageSize, page)) {
      break;
    }
    page += 1;
  }

  const issues = [...byNumber.values()];
  if (options.limit) {
    return issues.slice(0, options.limit);
  }
  return issues.sort((a, b) => (toNumber(a.number) ?? 0) - (toNumber(b.number) ?? 0));
}

function githubIssueCollectionOptions(input: WorkflowRunInput): GithubIssueCollectionOptions {
  const prompt = String(input.prompt ?? "");
  const explicitLimit = explicitGithubIssueLimit(input);
  const lower = prompt.toLowerCase();
  const wantsOldest = /\b(oldest|earliest|first)\b/.test(lower);
  const wantsUpdated = /\b(updated|modified|changed|active|recently updated)\b/.test(lower);
  const wantsOpenAndClosed = /\b(open\s+(?:and|&)\s+closed|closed\s+(?:and|&)\s+open|open\/closed|all\s+issues?)\b/.test(lower);
  const wantsClosed = !wantsOpenAndClosed && /\b(closed|resolved)\b/.test(lower);
  const wantsOpen = !wantsOpenAndClosed && !wantsClosed && /\b(open|unresolved)\b/.test(lower);

  return {
    limit: explicitLimit,
    sort: wantsUpdated ? "updated" : "created",
    direction: explicitLimit ? (wantsOldest ? "asc" : "desc") : "asc",
    state: wantsClosed ? "closed" : wantsOpen ? "open" : "all",
  };
}

function explicitGithubIssueLimit(input: WorkflowRunInput): number | undefined {
  for (const key of ["limit", "maxItems", "max_items", "maxIssues", "max_issues", "issueLimit", "issue_limit"]) {
    const value = positiveInteger(input[key], 0);
    if (value > 0) {
      return value;
    }
  }

  const prompt = String(input.prompt ?? "").toLowerCase();
  if (!prompt) {
    return undefined;
  }

  const patterns = [
    /\b(?:last|latest|recent|newest|top|first|oldest|earliest)\s+(\d{1,4})\s+(?:open\s+|closed\s+|resolved\s+|unresolved\s+)?(?:github\s+|repo\s+|repository\s+)?issues?\b/,
    /\b(\d{1,4})\s+(?:recent|latest|newest|last|oldest|earliest|top)\s+(?:open\s+|closed\s+|resolved\s+|unresolved\s+)?(?:github\s+|repo\s+|repository\s+)?issues?\b/,
    /\b(?:fetch|get|list|read|show|write|export|summari[sz]e|make|create)\s+(?:the\s+)?(?:last|latest|recent|newest|oldest|earliest|top|first\s+)?(\d{1,4})\s+(?:recent\s+|latest\s+|newest\s+|open\s+|closed\s+|resolved\s+|unresolved\s+)*(?:github\s+|repo\s+|repository\s+)?issues?\b/,
    /\b(\d{1,4})\s+(?:open\s+|closed\s+|resolved\s+|unresolved\s+)?(?:github\s+|repo\s+|repository\s+)?issues?\b/,
  ];

  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (match) {
      const limit = positiveInteger(match[1], 0);
      if (limit > 0) {
        return limit;
      }
    }
  }

  return undefined;
}

function explicitResumeLimit(input: WorkflowRunInput): number | undefined {
  for (const key of ["limit", "maxItems", "max_items", "maxFiles", "max_files", "resumeLimit", "resume_limit"]) {
    const value = positiveInteger(input[key], 0);
    if (value > 0) {
      return value;
    }
  }

  const prompt = String(input.prompt ?? "").toLowerCase();
  if (!prompt) {
    return undefined;
  }

  const patterns = [
    /\b(?:first|last|latest|recent|newest|oldest|top)\s+(\d{1,4})\s+(?:resume|resumes|candidate\s+documents?|pdfs?|files?)\b/,
    /\b(\d{1,4})\s+(?:recent|latest|newest|last|oldest|first|top)\s+(?:resume|resumes|candidate\s+documents?|pdfs?|files?)\b/,
    /\b(?:take|fetch|download|get|parse|extract|process|read|list|write|export|make|create)\s+(?:the\s+)?(?:first|last|latest|recent|newest|oldest|top\s+)?(\d{1,4})\s+(?:resume|resumes|candidate\s+documents?|pdfs?|files?)\b/,
    /\b(\d{1,4})\s+(?:resume|resumes|candidate\s+documents?|pdfs?)\b/,
  ];

  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (match) {
      const limit = positiveInteger(match[1], 0);
      if (limit > 0) {
        return limit;
      }
    }
  }

  return undefined;
}

type DriveListStrategy = {
  slug: string;
  buildArgs: (folderId: string, pageToken: string | undefined, pageSize: number) => Record<string, unknown>;
};

// FIND_FILE(folder_id) reliably paginates a folder's contents, so it's the
// primary lister; LIST_CHILDREN_V2 is a fallback for accounts/folders where
// FIND_FILE returns nothing. Success is judged on raw file count (before the
// resume filter) so a folder with no resumes doesn't trigger a wasteful second
// listing pass.
const DRIVE_LIST_STRATEGIES: DriveListStrategy[] = [
  {
    slug: "GOOGLESUPER_FIND_FILE",
    buildArgs: (folderId, pageToken, pageSize) => ({
      folder_id: folderId,
      pageToken,
      pageSize,
      fields: "nextPageToken,files(id,name,mimeType,webViewLink,size)",
    }),
  },
  {
    slug: "GOOGLESUPER_LIST_CHILDREN_V2",
    buildArgs: (folderId, pageToken, pageSize) => ({ folder_id: folderId, pageToken, pageSize }),
  },
];

async function collectDriveFiles(
  runtime: WorkflowRuntime,
  job: WorkflowJob,
  folderId: string,
  limit?: number
) {
  let lastError: unknown;

  for (const strategy of DRIVE_LIST_STRATEGIES) {
    try {
      const rawFiles = await listFolderFiles(runtime, job, folderId, strategy, limit);
      if (rawFiles.length > 0) {
        const resumes = rawFiles.filter(isResumeLikeFile);
        return limit ? resumes.slice(0, limit) : resumes;
      }
    } catch (err) {
      lastError = err;
      // Only fall through to the next listing tool when this one is rejected
      // outright (bad tool/params); genuine transient failures already retried.
      if (!isNonRetryableToolError(err)) {
        throw err;
      }
    }
  }

  if (lastError) {
    throw lastError;
  }
  return [];
}

async function listFolderFiles(
  runtime: WorkflowRuntime,
  job: WorkflowJob,
  folderId: string,
  strategy: DriveListStrategy,
  limit?: number
) {
  const files = new Map<string, Record<string, unknown>>();
  let pageToken: string | undefined;
  let resumeCount = 0;
  const pageSize = limit ? Math.min(runtime.pageSize, limit) : runtime.pageSize;

  do {
    await assertNotCancelled(runtime, job.id, {
      totalItems: files.size,
      failedItems: 0,
    });
    const result = await executeWithRetry(
      runtime,
      strategy.slug,
      strategy.buildArgs(folderId, pageToken, pageSize),
      context(job)
    );
    const items = findCollection(result, ["files", "items", "children", "results"]);
    for (const item of items) {
      const id = firstString(item, ["id", "fileId", "file_id"]);
      if (!id) {
        continue;
      }
      const alreadySeen = files.has(id);
      files.set(id, {
        ...item,
        id,
        fileId: firstString(item, ["fileId", "file_id"]) ?? id,
      });
      if (!alreadySeen && isResumeLikeFile(item)) {
        resumeCount += 1;
      }
      if (limit && resumeCount >= limit) {
        break;
      }
    }

    pageToken = nextToken(result);
    await runtime.store.saveCheckpoint(job.id, {
      step: "list-drive-files",
      cursor: pageToken ?? null,
      fetchedItems: files.size,
    });
    await updateProgress(runtime, job.id, {
      phase: "listing",
      fetchedItems: files.size,
      totalItems: bestTotal(result, files.size),
    });
  } while (pageToken && (!limit || resumeCount < limit));

  return [...files.values()];
}

async function parseResumeFiles(runtime: WorkflowRuntime, job: WorkflowJob, files: Record<string, unknown>[]) {
  const rows = new Array<Record<string, unknown> | undefined>(files.length);
  const workerCount = Math.min(runtime.workflowConcurrency, files.length);
  let nextIndex = 0;
  let processedItems = 0;
  let cancelled = false;

  const worker = async () => {
    while (true) {
      if (cancelled) {
        return;
      }
      await assertNotCancelled(runtime, job.id, {
        totalItems: files.length,
        failedItems: countFailedRows(compactRows(rows)),
      });

      const index = nextIndex;
      nextIndex += 1;
      if (index >= files.length) {
        return;
      }

      const row = await resumeFileToRow(runtime, job, files[index]);
      rows[index] = row;
      processedItems += 1;

      if (await isWorkflowCancelled(runtime, job.id)) {
        cancelled = true;
        throw new WorkflowCancelledError(job.id, {
          totalItems: files.length,
          failedItems: countFailedRows(compactRows(rows)),
        });
      }

      const completedRows = compactRows(rows);
      await runtime.store.saveCheckpoint(job.id, {
        step: "parse-resumes",
        nextItemIndex: contiguousRowCount(rows),
        processedItemIds: completedRows.map((item) => item.fileId).slice(-20),
      });
      await updateProgress(runtime, job.id, {
        phase: "parsing",
        totalItems: files.length,
        fetchedItems: files.length,
        processedItems,
        failedItems: countFailedRows(completedRows),
      });
    }
  };

  const results = await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
  const cancellation = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected" && result.reason instanceof WorkflowCancelledError
  );
  if (cancellation) {
    throw cancellation.reason;
  }
  const rejection = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejection) {
    throw rejection.reason;
  }

  return rows.map((row, index) => {
    if (row) {
      return row;
    }
    const file = files[index];
    const fileId = firstString(file, ["fileId", "file_id", "id"]) ?? "";
    return {
      fileId,
      filename: firstString(file, ["name", "title", "filename"]) ?? fileId,
      url: firstString(file, ["webViewLink", "url", "alternateLink", "childLink"]),
      candidateName: "",
      university: "",
      lastJob: "",
      status: "parse_failed",
      error: "Resume parsing did not complete.",
    };
  });
}

async function resumeFileToRow(runtime: WorkflowRuntime, job: WorkflowJob, file: Record<string, unknown>) {
  const fileId = firstString(file, ["fileId", "file_id", "id"]) ?? "";
  const filename = firstString(file, ["name", "title", "filename"]) ?? fileId;
  const url = firstString(file, ["webViewLink", "url", "alternateLink", "childLink"]);

  try {
    const parsed = await executeWithRetry(runtime, "GOOGLESUPER_PARSE_FILE", {
      file_id: fileId,
      mime_type: "text/plain",
    }, context(job));
    // PARSE_FILE only downloads the file (no text for PDFs), so extract the
    // text ourselves from the returned file bytes before field extraction.
    const text = await extractPdfText(parsed);
    const candidate = await extractCandidateFields(runtime, text, filename);
    return {
      fileId,
      filename,
      url,
      candidateName: candidate.name,
      university: candidate.university,
      lastJob: candidate.lastJob,
      status: "ok",
      error: "",
    };
  } catch (err) {
    return {
      fileId,
      filename,
      url,
      candidateName: "",
      university: "",
      lastJob: "",
      status: "parse_failed",
      error: errorMessage(err),
    };
  }
}

// Fetch the downloaded PDF bytes (PARSE_FILE returns an s3 URL + local path, not
// text) and extract text with unpdf. Falls back to any inline text field so the
// unit-test mocks (which return { text } directly) still flow through.
async function extractPdfText(parsed: unknown): Promise<string> {
  const inlineText = textFromParsedFile(parsed);
  if (inlineText.trim()) {
    return inlineText;
  }

  const bytes = await fetchFileBytes(parsed);
  if (!bytes) {
    return "";
  }

  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join("\n") : String(text ?? "");
  } catch {
    return "";
  }
}

async function fetchFileBytes(parsed: unknown): Promise<Uint8Array | undefined> {
  const s3url = firstStringFromAny(parsed, ["s3url", "s3Url", "downloadUrl", "download_url"]);
  if (s3url) {
    try {
      const response = await fetch(s3url);
      if (response.ok) {
        return new Uint8Array(await response.arrayBuffer());
      }
    } catch {
      // fall through to local path
    }
  }

  const localUri = firstStringFromAny(parsed, ["uri", "path", "filepath", "file_path"]);
  if (localUri && !/^https?:/i.test(localUri)) {
    try {
      return new Uint8Array(await Bun.file(localUri).arrayBuffer());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function extractCandidateFields(
  runtime: WorkflowRuntime,
  text: string,
  filename: string
) {
  const deterministic = {
    name: firstNonEmptyLine(text) ?? filename.replace(/\.[^.]+$/, ""),
    university: guessUniversity(text),
    lastJob: "",
  };

  // No usable text (e.g. parser returned only metadata) — the LLM can't help.
  if (!runtime.useLlmExtraction || !text.trim()) {
    return deterministic;
  }

  // Retry on transient rate-limits; on persistent failure fall back to the
  // deterministic fields (first line as name + heuristic university) so a 429
  // degrades a single row instead of failing it.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const value = await generateJson({
        system: [
          "You extract structured fields from resume text.",
          'Return strict JSON: {"name": string, "university": string, "lastJob": string}.',
          '"name" is the candidate\'s full name. "university" is the most recent/highest school attended.',
          '"lastJob" is the candidate\'s most recent employer or company name (not the job title).',
          "Use an empty string for any field you cannot find. Do not invent values.",
        ].join(" "),
        prompt: `Filename: ${filename}\n\nResume text:\n${text.slice(0, 8_000)}`,
      });
      const obj = isRecord(value) ? value : {};
      return {
        name: firstString(obj, ["name", "candidateName", "candidate_name"]) ?? deterministic.name,
        university: firstString(obj, ["university", "uni", "school", "college"]) ?? deterministic.university,
        lastJob:
          firstString(obj, ["lastJob", "last_job", "company", "lastCompany", "last_company"]) ??
          deterministic.lastJob,
      };
    } catch (err) {
      if (attempt < 2 && isRetryableToolError(err)) {
        await sleep(backoffDelayMs(attempt + 1));
        continue;
      }
      return deterministic;
    }
  }
  return deterministic;
}

// Cheap heuristic used when LLM extraction is disabled or fails: the first
// short line that names an educational institution.
function guessUniversity(text: string) {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length > 4 && line.length < 120 && /\b(university|college|institute|polytechnic|school of)\b/i.test(line)) {
      return line;
    }
  }
  return "";
}

async function writeRowsToSheet(
  runtime: WorkflowRuntime,
  job: WorkflowJob,
  options: {
    title: string;
    sheetName: string;
    headers: string[];
    rows: Array<Record<string, unknown>>;
    approvalId: string;
  }
): Promise<SheetWriteResult> {
  let spreadsheetId = "";
  let spreadsheetUrl = "";
  let writtenRows = 0;
  const artifacts: WorkflowArtifact[] = [];
  let offset = 0;
  // SHEET_FROM_JSON decides its own column order from the row objects, which may
  // differ from `options.headers`. Appends must use the sheet's ACTUAL column
  // order or the data lands under the wrong headers — so we read it back below.
  let sheetHeaders = options.headers;

  await assertNotCancelled(runtime, job.id, {
    totalItems: options.rows.length,
    failedItems: countFailedRows(options.rows),
  });

  if (runtime.sheetValueMode === "googleValues") {
    const firstBatch = options.rows.slice(0, runtime.sheetBatchSize);
    await assertNotCancelled(runtime, job.id, {
      totalItems: options.rows.length,
      writtenRows,
      failedItems: countFailedRows(options.rows),
    });
    const createResult = await runtime.executeTool(
      "GOOGLESUPER_SHEET_FROM_JSON",
      {
        title: options.title,
        sheet_name: options.sheetName,
        sheet_json: firstBatch,
      },
      {
        ...context(job),
        approvalId: options.approvalId,
      }
    );
    spreadsheetId = firstStringFromAny(createResult, ["spreadsheetId", "spreadsheet_id", "id"]) ?? spreadsheetId;
    spreadsheetUrl = firstUrl(createResult) ?? spreadsheetUrl;
    writtenRows = firstBatch.length;
    offset = firstBatch.length;
    sheetHeaders = await readSheetHeaderOrder(runtime, job, spreadsheetId, options.sheetName, options.headers);

    await runtime.store.saveCheckpoint(job.id, {
      step: "write-sheet",
      nextItemIndex: writtenRows,
      writtenRowCount: writtenRows,
      spreadsheetId,
      spreadsheetUrl,
    });
    await updateProgress(runtime, job.id, {
      phase: "writing",
      totalItems: options.rows.length,
      processedItems: options.rows.length,
      writtenRows,
      failedItems: countFailedRows(options.rows),
    });
  }

  for (; offset < options.rows.length; offset += runtime.sheetBatchSize) {
    const batch = options.rows.slice(offset, offset + runtime.sheetBatchSize);
    await assertNotCancelled(runtime, job.id, {
      totalItems: options.rows.length,
      writtenRows,
      failedItems: countFailedRows(options.rows),
    });
    const args =
      runtime.sheetValueMode === "googleValues"
        ? appendArgsForGoogleValues(options, batch, spreadsheetId, sheetHeaders)
        : appendArgsForRecordRows(batch, spreadsheetId);
    const result = await runtime.executeTool("GOOGLESUPER_SPREADSHEETS_VALUES_APPEND", args, {
      ...context(job),
      approvalId: options.approvalId,
    });
    spreadsheetId = firstStringFromAny(result, ["spreadsheetId", "spreadsheet_id", "id"]) ?? spreadsheetId;
    spreadsheetUrl = firstUrl(result) ?? spreadsheetUrl;
    writtenRows += batch.length;

    await runtime.store.saveCheckpoint(job.id, {
      step: "write-sheet",
      nextItemIndex: writtenRows,
      writtenRowCount: writtenRows,
      spreadsheetId,
      spreadsheetUrl,
    });
    await updateProgress(runtime, job.id, {
      phase: "writing",
      totalItems: options.rows.length,
      processedItems: options.rows.length,
      writtenRows,
      failedItems: countFailedRows(options.rows),
    });
  }

  if (spreadsheetUrl) {
    artifacts.push({ label: "Generated Google Sheet", url: spreadsheetUrl });
  } else if (spreadsheetId) {
    artifacts.push({
      label: "Generated Google Sheet",
      url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
    });
  }

  return { spreadsheetId, spreadsheetUrl, writtenRows, artifacts };
}

function appendArgsForRecordRows(rows: Array<Record<string, unknown>>, spreadsheetId: string) {
  return {
    spreadsheetId: spreadsheetId || "pending_spreadsheet",
    range: "Sheet1",
    valueInputOption: "RAW",
    values: rows,
  };
}

function appendArgsForGoogleValues(
  options: { title: string; sheetName: string; headers: string[] },
  rows: Array<Record<string, unknown>>,
  spreadsheetId: string,
  headers: string[] = options.headers
) {
  const values = rows.map((row) => headers.map((header) => scalarCell(row[header])));
  return {
    spreadsheetId: spreadsheetId || "pending_spreadsheet",
    range: `${options.sheetName}!A:${columnName(headers.length)}`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    majorDimension: "ROWS",
    values,
  };
}

// Read back the header row the sheet was actually created with, so appended
// rows are ordered to match those columns. Best-effort: on any failure (or in
// tests, where this tool isn't mocked) we keep the expected header order.
async function readSheetHeaderOrder(
  runtime: WorkflowRuntime,
  job: WorkflowJob,
  spreadsheetId: string,
  sheetName: string,
  fallback: string[]
): Promise<string[]> {
  if (!spreadsheetId) {
    return fallback;
  }
  try {
    const result = await runtime.executeTool(
      "GOOGLESUPER_GET_BATCH_VALUES",
      { spreadsheet_id: spreadsheetId, ranges: [`${sheetName}!A1:1`] },
      context(job)
    );
    const header = extractHeaderRow(result);
    return header.length ? header : fallback;
  } catch {
    return fallback;
  }
}

function extractHeaderRow(result: unknown): string[] {
  if (!isRecord(result)) {
    return [];
  }
  const data = isRecord(result.data) ? result.data : result;
  const ranges = (data.valueRanges ?? data.value_ranges) as unknown;
  const first = Array.isArray(ranges) ? ranges[0] : undefined;
  const values = isRecord(first) ? first.values : undefined;
  const header = Array.isArray(values) ? values[0] : undefined;
  return Array.isArray(header) ? header.map((cell) => String(cell ?? "").trim()).filter(Boolean) : [];
}

async function requestWorkflowApproval(
  runtime: WorkflowRuntime,
  job: WorkflowJob,
  request: Omit<ApprovalRequest, "jobId">
) {
  await assertNotCancelled(runtime, job.id, {
    totalItems: request.rowCount,
    failedItems: 0,
  });
  await runtime.store.markWaitingForConfirmation(job.id, {
    phase: "waiting_confirmation",
    pendingSummary: request.summary,
    rowCount: request.rowCount,
  });
  const grant = await runtime.requestApproval({
    jobId: job.id,
    ...request,
  });
  // The grant is in (or the job was cancelled). Flip the persisted status back to
  // "running" so the UI stops showing the approval card / "Ready to write" while the
  // sheet is actually being written. Guarded to no-op if the job is already terminal.
  await runtime.store.markRunning(job.id);
  return grant;
}

async function completeWorkflow(
  runtime: WorkflowRuntime,
  jobId: string,
  workflowId: string,
  totalItems: number,
  failedItems: number,
  sheet: SheetWriteResult
) {
  const output = {
    status: "completed",
    workflowId,
    totalItems,
    writtenRows: sheet.writtenRows,
    failedItems,
    artifacts: sheet.artifacts,
  };
  await runtime.store.completeJob(jobId, output);
  return {
    ...output,
    jobId,
  } as WorkflowRunResult;
}

async function cancelWorkflow(
  runtime: WorkflowRuntime,
  jobId: string,
  workflowId: string,
  totalItems = 0,
  writtenRows = 0,
  failedItems = 0
): Promise<WorkflowRunResult> {
  await updateProgress(runtime, jobId, {
    phase: "cancelled",
    totalItems,
    writtenRows,
    failedItems,
  });
  const existing = await runtime.store.getJob(jobId);
  if (existing?.status !== "cancelled") {
    await runtime.store.cancelJob(jobId, "Workflow cancelled.");
  }
  return {
    status: "cancelled",
    jobId,
    workflowId,
    totalItems,
    writtenRows,
    failedItems,
    artifacts: [],
  };
}

async function failWorkflow(
  runtime: WorkflowRuntime,
  jobId: string,
  workflowId: string,
  err: unknown
): Promise<WorkflowRunResult> {
  const message = errorMessage(err);
  await runtime.store.failJob(jobId, message);
  return {
    status: "failed",
    jobId,
    workflowId,
    totalItems: 0,
    writtenRows: 0,
    failedItems: 0,
    artifacts: [],
  };
}

async function updateProgress(runtime: WorkflowRuntime, jobId: string, progress: Partial<WorkflowProgress>) {
  return runtime.store.updateProgress(jobId, progress as Record<string, unknown>);
}

class WorkflowCancelledError extends Error {
  totalItems: number;
  writtenRows: number;
  failedItems: number;

  constructor(jobId: string, details: { totalItems?: number; writtenRows?: number; failedItems?: number } = {}) {
    super(`Workflow job cancelled: ${jobId}`);
    this.name = "WorkflowCancelledError";
    this.totalItems = details.totalItems ?? 0;
    this.writtenRows = details.writtenRows ?? 0;
    this.failedItems = details.failedItems ?? 0;
  }
}

async function assertNotCancelled(
  runtime: WorkflowRuntime,
  jobId: string,
  details: { totalItems?: number; writtenRows?: number; failedItems?: number } = {}
) {
  if (await isWorkflowCancelled(runtime, jobId)) {
    throw new WorkflowCancelledError(jobId, details);
  }
}

async function isWorkflowCancelled(runtime: WorkflowRuntime, jobId: string) {
  return Boolean(await runtime.isCancelled(jobId));
}

async function executeWithRetry(
  runtime: WorkflowRuntime,
  slug: string,
  args: Record<string, unknown>,
  context: ToolExecutionContext
) {
  let nextArgs = { ...args };
  let lastError: unknown;

  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await runtime.executeTool(slug, nextArgs, context);
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) {
        break;
      }
      if (isPayloadTooLargeError(err)) {
        nextArgs = reducePageSize(nextArgs);
      } else if (!isRetryableToolError(err)) {
        throw err;
      }
      await sleep(backoffDelayMs(attempt));
    }
  }

  throw lastError;
}

function isPayloadTooLargeError(err: unknown) {
  return errorStatusCode(err) === 413 || /payload|too large|413/i.test(errorMessage(err));
}

function isRetryableToolError(err: unknown) {
  if (isNonRetryableToolError(err)) {
    return false;
  }

  const status = errorStatusCode(err);
  if (status === 429 || (status !== undefined && status >= 500 && status <= 599)) {
    return true;
  }

  const code = firstStringFromAny(err, ["code", "errorCode", "errno"]);
  if (code && /^(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETDOWN|ENETRESET|ENETUNREACH|EHOSTUNREACH|UND_ERR_|TIMEOUT)/i.test(code)) {
    return true;
  }

  return /rate limit|too many requests|timeout|timed out|temporar|try again|service unavailable|bad gateway|gateway timeout|socket hang up|connection reset/i.test(
    errorMessage(err)
  );
}

function isNonRetryableToolError(err: unknown) {
  const status = errorStatusCode(err);
  if (status !== undefined) {
    return (
      (status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 425 && status !== 429) ||
      status === 501
    );
  }

  return /unauthori[sz]ed|forbidden|permission|invalid[_ -]?(grant|token|request)|bad request|not found|unprocessable|missing required|validation/i.test(
    errorMessage(err)
  );
}

function errorStatusCode(err: unknown): number | undefined {
  if (!isRecord(err)) {
    return undefined;
  }
  for (const key of ["status", "statusCode", "status_code", "code"]) {
    const value = toNumber(err[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return (
    errorStatusCode(err.response) ??
    errorStatusCode(err.cause) ??
    errorStatusCode(err.error)
  );
}

function backoffDelayMs(attempt: number) {
  const base = Math.min(1_000, 100 * 2 ** (attempt - 1));
  return base + Math.floor(Math.random() * base);
}

function reducePageSize(args: Record<string, unknown>) {
  const next = { ...args };
  for (const key of ["per_page", "maxResults", "pageSize", "limit"]) {
    if (key in next) {
      next[key] = Math.max(10, Math.floor((toNumber(next[key]) ?? 100) / 2));
    }
  }
  return next;
}

function githubIssueToRow(issue: Record<string, unknown>) {
  return {
    issueNumber: toNumber(issue.number) ?? "",
    title: firstString(issue, ["title"]) ?? "",
    state: firstString(issue, ["state"]) ?? "",
    author: firstString(firstRecord(issue, ["user", "author"]), ["login", "name"]) ?? "",
    createdAt: firstString(issue, ["created_at", "createdAt"]) ?? "",
    updatedAt: firstString(issue, ["updated_at", "updatedAt"]) ?? "",
    labels: labelsText(issue.labels),
    url: firstString(issue, ["html_url", "htmlUrl", "url"]) ?? "",
    problemSummary: firstString(issue, ["body", "summary", "description"])?.slice(0, 1_000) ?? "",
    status: "ok",
    error: "",
  };
}

function labelsText(value: unknown) {
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((label) => (isRecord(label) ? firstString(label, ["name"]) : typeof label === "string" ? label : ""))
    .filter(Boolean)
    .join(", ");
}

function isResumeLikeFile(file: Record<string, unknown>) {
  const mimeType = (firstString(file, ["mimeType", "mime_type"]) ?? "").toLowerCase();
  // Exclude sub-folders only. The user asked for "all the resumes in this
  // folder", so we keep every document/file rather than risk dropping a resume
  // whose name or mime type doesn't match a hardcoded pattern; non-parseable
  // files still become rows with a parse_failed status.
  return mimeType !== "application/vnd.google-apps.folder";
}

function findCollection(value: unknown, preferredKeys: string[]) {
  const direct = findCollectionAtKeys(value, preferredKeys);
  if (direct.length) {
    return direct;
  }
  const any = findFirstRecordArray(value);
  return any ?? [];
}

function findCollectionAtKeys(value: unknown, keys: string[]): Record<string, unknown>[] {
  if (!isRecord(value)) {
    return [];
  }

  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      return candidate.filter(isRecord);
    }
  }

  for (const nested of Object.values(value)) {
    const found = findCollectionAtKeys(nested, keys);
    if (found.length) {
      return found;
    }
  }

  return [];
}

function findFirstRecordArray(value: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(value)) {
    const records = value.filter(isRecord);
    return records.length ? records : null;
  }
  if (!isRecord(value)) {
    return null;
  }
  for (const nested of Object.values(value)) {
    const found = findFirstRecordArray(nested);
    if (found?.length) {
      return found;
    }
  }
  return null;
}

function hasNextPage(result: unknown, itemCount: number, pageSize: number, page: number) {
  if (firstStringFromAny(result, ["nextPageToken", "next_page_token", "nextCursor", "next_cursor"])) {
    return true;
  }
  const nextPage = firstNumberFromAny(result, ["nextPage", "next_page"]);
  if (nextPage && nextPage > page) {
    return true;
  }
  const hasMore = firstBooleanFromAny(result, ["hasMore", "has_more"]);
  if (hasMore !== undefined) {
    return hasMore;
  }
  return itemCount >= pageSize;
}

function nextToken(result: unknown) {
  return firstStringFromAny(result, ["nextPageToken", "next_page_token", "nextCursor", "next_cursor"]);
}

function bestTotal(result: unknown, fallback: number) {
  return firstNumberFromAny(result, ["total", "totalCount", "total_count"]) ?? fallback;
}

function countFailedRows(rows: Array<Record<string, unknown>>) {
  return rows.filter((row) => /fail|error/i.test(String(row.status ?? "")) || Boolean(row.error)).length;
}

function compactRows(rows: Array<Record<string, unknown> | undefined>) {
  return rows.filter((row): row is Record<string, unknown> => Boolean(row));
}

function contiguousRowCount(rows: Array<Record<string, unknown> | undefined>) {
  let count = 0;
  while (count < rows.length && rows[count]) {
    count += 1;
  }
  return count;
}

function positiveInteger(value: unknown, fallback: number) {
  const number = toNumber(value);
  if (number === undefined || number < 1) {
    return fallback;
  }
  return Math.floor(number);
}

function firstRecord(value: unknown, keys: string[]) {
  if (!isRecord(value)) {
    return {};
  }
  for (const key of keys) {
    const candidate = value[key];
    if (isRecord(candidate)) {
      return candidate;
    }
  }
  return {};
}

function firstString(record: unknown, keys: string[]) {
  if (!isRecord(record)) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number") {
      return String(value);
    }
  }
  return undefined;
}

function firstStringFromAny(value: unknown, keys: string[]): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const direct = firstString(value, keys);
  if (direct) {
    return direct;
  }
  for (const nested of Object.values(value)) {
    const found: string | undefined = firstStringFromAny(nested, keys);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function firstNumberFromAny(value: unknown, keys: string[]): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of keys) {
    const number = toNumber(value[key]);
    if (number !== undefined) {
      return number;
    }
  }
  for (const nested of Object.values(value)) {
    const found: number | undefined = firstNumberFromAny(nested, keys);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function firstBooleanFromAny(value: unknown, keys: string[]): boolean | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of keys) {
    if (typeof value[key] === "boolean") {
      return value[key];
    }
  }
  for (const nested of Object.values(value)) {
    const found: boolean | undefined = firstBooleanFromAny(nested, keys);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function firstUrl(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+[^\s"'<>]*/)?.[0];
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found: string | undefined = firstUrl(item);
      if (found) return found;
    }
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      const found: string | undefined = firstUrl(item);
      if (found) return found;
    }
  }
  return undefined;
}

function textFromParsedFile(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  return firstStringFromAny(value, ["text", "content", "body", "markdown", "rawText", "raw_text"]) ?? "";
}

function firstNonEmptyLine(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function scalarCell(value: unknown) {
  if (value === undefined || value === null) {
    return "";
  }
  if (["string", "number", "boolean"].includes(typeof value)) {
    return value as string | number | boolean;
  }
  return JSON.stringify(value);
}

function columnName(count: number) {
  let n = count;
  let name = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name || "A";
}

function context(job: WorkflowJob): ToolExecutionContext {
  return {
    userId: job.userId,
    jobId: job.id,
  };
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

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
