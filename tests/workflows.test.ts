import { describe, expect, test } from "bun:test";
import { createMemoryWorkflowStore } from "../src/lib/job-store";
import {
  DRIVE_RESUMES_TO_SHEET,
  GITHUB_ISSUES_TO_SHEET,
  createWorkflowService,
} from "../src/lib/workflows";

type ToolContext = {
  userId: string;
  jobId: string;
  approvalId?: string;
};

type ToolCall = {
  slug: string;
  args: Record<string, unknown>;
  context: ToolContext;
};

type WorkflowService = {
  runWorkflow: (
    workflow: unknown,
    input: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
};

type ApprovalRequest = {
  jobId: string;
  workflowId: string;
  toolSlugs: string[];
  summary: string;
  rowCount: number;
};

type ApprovalGrant = {
  approved: true;
  approvalId: string;
  scope: "workflow";
};

describe("planned workflow execution", () => {
  test("writes all 550 GitHub issues to a sheet", async () => {
    const issues = makeIssues(550);
    const writtenRows: Array<Record<string, unknown>> = [];
    const toolCalls: ToolCall[] = [];
    const service = await makeWorkflowService({
      onToolCall: async (slug, args, context) => {
        toolCalls.push({ slug, args, context });

        if (slug === "GITHUB_LIST_REPOSITORY_ISSUES" || slug === "GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS") {
          return pageResult(issues, args, "issues");
        }

        if (slug === "GITHUB_GET_AN_ISSUE") {
          const number = numberArg(args, ["issue_number", "issueNumber", "number"]);
          return issues.find((issue) => issue.number === number);
        }

        if (isSheetWrite(slug)) {
          writtenRows.push(...rowsFromArgs(args));
          return sheetWriteResult(writtenRows.length);
        }

        throw new Error(`Unexpected tool call: ${slug}`);
      },
    });

    const result = await service.runWorkflow(GITHUB_ISSUES_TO_SHEET, {
      userId: "user_issues",
      repository: "composiohq/composio",
      spreadsheetTitle: "Composio issue report",
    });

    expect(result).toMatchObject({
      status: "completed",
      writtenRows: 550,
    });
    expect(writtenRows).toHaveLength(550);
    expect(new Set(writtenRows.map((row) => row.issueNumber ?? row.number)).size).toBe(550);
    expect(toolCalls.some((call) => call.slug === "GITHUB_LIST_REPOSITORY_ISSUES")).toBe(true);
    expect(toolCalls.filter((call) => isSheetWrite(call.slug)).length).toBeGreaterThan(0);
  });

  test("writes 1000 resume rows and includes parse failures as rows", async () => {
    const resumes = makeResumeFiles(1000);
    const parseFailureIds = new Set(["resume_17", "resume_250", "resume_999"]);
    const writtenRows: Array<Record<string, unknown>> = [];
    const service = await makeWorkflowService({
      onToolCall: async (slug, args) => {
        if (slug === "GOOGLESUPER_FIND_FILE" || slug === "GOOGLESUPER_LIST_CHILDREN_V2") {
          return pageResult(resumes, args, "files");
        }

        if (slug === "GOOGLESUPER_DOWNLOAD_FILE" || slug === "GOOGLESUPER_DOWNLOAD_FILE_OPERATION") {
          const fileId = stringArg(args, ["fileId", "file_id", "id"]);
          return {
            fileId,
            content: `Resume text for ${fileId}`,
          };
        }

        if (slug === "GOOGLESUPER_PARSE_FILE") {
          const fileId = stringArg(args, ["fileId", "file_id", "id"]);
          if (parseFailureIds.has(fileId)) {
            throw new Error(`Unable to parse ${fileId}`);
          }
          const index = Number(fileId.split("_").at(-1));
          return {
            text: `Candidate ${index}`,
            candidate: {
              name: `Candidate ${index}`,
              university: `University ${index % 25}`,
              lastJob: `Company ${index % 40}`,
            },
          };
        }

        if (isSheetWrite(slug)) {
          writtenRows.push(...rowsFromArgs(args));
          return sheetWriteResult(writtenRows.length);
        }

        throw new Error(`Unexpected tool call: ${slug}`);
      },
    });

    const result = await service.runWorkflow(DRIVE_RESUMES_TO_SHEET, {
      userId: "user_resumes",
      folderId: "drive_folder_123",
      spreadsheetTitle: "Candidate resumes",
    });

    expect(result).toMatchObject({
      status: "completed",
      writtenRows: 1000,
    });
    expect(writtenRows).toHaveLength(1000);
    expect(rowsWithParseErrors(writtenRows)).toHaveLength(parseFailureIds.size);
    expect(new Set(writtenRows.map((row) => row.fileId ?? row.id ?? row.sourceId)).size).toBe(1000);
  });

  test("parses Drive resumes with bounded concurrency and preserves sheet row order", async () => {
    const resumes = makeResumeFiles(12);
    const writtenRows: Array<Record<string, unknown>> = [];
    let activeParses = 0;
    let maxActiveParses = 0;

    const service = await makeWorkflowService({
      workflowConcurrency: 3,
      onToolCall: async (slug, args) => {
        if (slug === "GOOGLESUPER_FIND_FILE" || slug === "GOOGLESUPER_LIST_CHILDREN_V2") {
          return pageResult(resumes, args, "files");
        }

        if (slug === "GOOGLESUPER_PARSE_FILE") {
          const fileId = stringArg(args, ["fileId", "file_id", "id"]);
          const index = Number(fileId.split("_").at(-1));
          activeParses += 1;
          maxActiveParses = Math.max(maxActiveParses, activeParses);
          await sleep((13 - index) * 2);
          activeParses -= 1;
          return {
            text: `Candidate ${index}`,
            candidate: {
              name: `Candidate ${index}`,
              university: `University ${index}`,
              lastJob: `Company ${index}`,
            },
          };
        }

        if (isSheetWrite(slug)) {
          writtenRows.push(...rowsFromArgs(args));
          return sheetWriteResult(writtenRows.length);
        }

        throw new Error(`Unexpected tool call: ${slug}`);
      },
    });

    const result = await service.runWorkflow(DRIVE_RESUMES_TO_SHEET, {
      userId: "user_concurrent_resumes",
      folderId: "drive_folder_concurrent",
    });

    expect(result.status).toBe("completed");
    expect(maxActiveParses).toBeGreaterThan(1);
    expect(maxActiveParses).toBeLessThanOrEqual(3);
    expect(writtenRows.map((row) => row.fileId)).toEqual(resumes.map((resume) => resume.fileId));
  });

  test("cancels Drive resume workflow before sheet writes", async () => {
    const resumes = makeResumeFiles(8);
    let cancelled = false;
    let approvalRequests = 0;
    let sheetWrites = 0;

    const service = await makeWorkflowService({
      workflowConcurrency: 4,
      isCancelled: () => cancelled,
      requestApproval: async () => {
        approvalRequests += 1;
        cancelled = true;
        return {
          approved: true,
          approvalId: "approval_cancelled",
          scope: "workflow",
        };
      },
      onToolCall: async (slug, args) => {
        if (slug === "GOOGLESUPER_FIND_FILE" || slug === "GOOGLESUPER_LIST_CHILDREN_V2") {
          return pageResult(resumes, args, "files");
        }

        if (slug === "GOOGLESUPER_PARSE_FILE") {
          const fileId = stringArg(args, ["fileId", "file_id", "id"]);
          const index = Number(fileId.split("_").at(-1));
          return {
            text: `Candidate ${index}`,
            candidate: {
              name: `Candidate ${index}`,
              university: `University ${index}`,
              lastJob: `Company ${index}`,
            },
          };
        }

        if (isSheetWrite(slug)) {
          sheetWrites += 1;
          return sheetWriteResult(rowsFromArgs(args).length);
        }

        throw new Error(`Unexpected tool call: ${slug}`);
      },
    });

    const result = await service.runWorkflow(DRIVE_RESUMES_TO_SHEET, {
      userId: "user_cancelled_resumes",
      folderId: "drive_folder_cancelled",
    });

    expect(result).toMatchObject({
      status: "cancelled",
      writtenRows: 0,
    });
    expect(approvalRequests).toBe(1);
    expect(sheetWrites).toBe(0);
  });

  test("uses one workflow approval for batched sheet appends", async () => {
    const issues = makeIssues(225);
    const approvals: ApprovalRequest[] = [];
    const appendCalls: ToolCall[] = [];
    const service = await makeWorkflowService({
      sheetBatchSize: 50,
      requestApproval: async (request) => {
        approvals.push(request);
        return {
          approved: true,
          approvalId: "approval_once",
          scope: "workflow",
        };
      },
      onToolCall: async (slug, args, context) => {
        if (slug === "GITHUB_LIST_REPOSITORY_ISSUES" || slug === "GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS") {
          return pageResult(issues, args, "issues");
        }

        if (isSheetWrite(slug)) {
          appendCalls.push({ slug, args, context });
          return sheetWriteResult(rowsFromArgs(args).length);
        }

        throw new Error(`Unexpected tool call: ${slug}`);
      },
    });

    await service.runWorkflow(GITHUB_ISSUES_TO_SHEET, {
      userId: "user_approval",
      repository: "composiohq/composio",
      spreadsheetTitle: "Batched issue report",
    });

    expect(approvals).toHaveLength(1);
    expect(approvals[0].toolSlugs).toContain("GOOGLESUPER_SPREADSHEETS_VALUES_APPEND");
    expect(appendCalls.length).toBeGreaterThan(1);
    expect([...new Set(appendCalls.map((call) => call.context.approvalId))]).toEqual(["approval_once"]);
  });
});

async function makeWorkflowService(options: {
  onToolCall: (slug: string, args: Record<string, unknown>, context: ToolContext) => Promise<unknown>;
  requestApproval?: (request: ApprovalRequest) => Promise<ApprovalGrant>;
  isCancelled?: (jobId: string) => Promise<boolean> | boolean;
  sheetBatchSize?: number;
  workflowConcurrency?: number;
}): Promise<WorkflowService> {
  return createWorkflowService({
    store: await createMemoryWorkflowStore(),
    executeTool: options.onToolCall,
    requestApproval:
      options.requestApproval ??
      (async () => ({
        approved: true,
        approvalId: "approval_default",
        scope: "workflow",
      } as ApprovalGrant)),
    isCancelled: options.isCancelled,
    defaults: {
      sheetBatchSize: options.sheetBatchSize ?? 100,
      workflowConcurrency: options.workflowConcurrency,
    },
  }) as WorkflowService;
}

function makeIssues(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `issue_${index + 1}`,
    number: index + 1,
    title: `Issue ${index + 1}`,
    state: index % 3 === 0 ? "closed" : "open",
    html_url: `https://github.com/composiohq/composio/issues/${index + 1}`,
    body: `Problem report ${index + 1}`,
    created_at: "2026-01-01T00:00:00.000Z",
  }));
}

function makeResumeFiles(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `resume_${index + 1}`,
    fileId: `resume_${index + 1}`,
    name: `Candidate ${index + 1}.pdf`,
    mimeType: "application/pdf",
  }));
}

function pageResult<T>(items: T[], args: Record<string, unknown>, collectionKey: "issues" | "files") {
  const perPage = numberArg(args, ["per_page", "perPage", "pageSize", "limit"], 100);
  const offsetFromCursor = optionalNumberArg(args, ["cursor", "pageToken", "nextPageToken", "offset"]);
  const page = numberArg(args, ["page", "pageNumber", "page_number"], 1);
  const offset = offsetFromCursor ?? (page - 1) * perPage;
  const pageItems = items.slice(offset, offset + perPage);
  const nextOffset = offset + pageItems.length;
  const hasMore = nextOffset < items.length;
  const nextPage = hasMore ? page + 1 : null;
  const nextCursor = hasMore ? String(nextOffset) : null;

  return {
    [collectionKey]: pageItems,
    items: pageItems,
    results: pageItems,
    data: {
      [collectionKey]: pageItems,
      items: pageItems,
    },
    total: items.length,
    totalCount: items.length,
    hasMore,
    nextPage,
    nextCursor,
    nextPageToken: nextCursor,
  };
}

function isSheetWrite(slug: string) {
  return slug === "GOOGLESUPER_SHEET_FROM_JSON" || slug === "GOOGLESUPER_SPREADSHEETS_VALUES_APPEND";
}

function rowsFromArgs(args: Record<string, unknown>) {
  const candidates = [
    args.rows,
    args.records,
    args.items,
    args.values,
    args.data,
    isRecord(args.json) ? args.json.rows : undefined,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate as Array<Record<string, unknown>>;
    }
  }

  throw new Error(`Sheet write did not include rows: ${JSON.stringify(args)}`);
}

function rowsWithParseErrors(rows: Array<Record<string, unknown>>) {
  return rows.filter((row) => {
    const status = String(row.status ?? row.parseStatus ?? row.parse_status ?? "");
    return Boolean(row.error ?? row.parseError ?? row.parse_error) || /fail|error/i.test(status);
  });
}

function sheetWriteResult(writtenRows: number) {
  return {
    spreadsheetId: "sheet_123",
    spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet_123",
    updatedRows: writtenRows,
    updates: {
      updatedRows: writtenRows,
    },
  };
}

function numberArg(args: Record<string, unknown>, keys: string[], fallback?: number) {
  const value = optionalNumberArg(args, keys);
  if (value !== undefined) {
    return value;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`Missing numeric arg. Tried: ${keys.join(", ")}`);
}

function optionalNumberArg(args: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
}

function stringArg(args: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  throw new Error(`Missing string arg. Tried: ${keys.join(", ")}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
