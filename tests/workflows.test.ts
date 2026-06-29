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

  test("respects an explicit recent GitHub issue count when writing a sheet", async () => {
    const issues = makeIssues(50);
    const writtenRows: Array<Record<string, unknown>> = [];
    const listCalls: ToolCall[] = [];
    const service = await makeWorkflowService({
      onToolCall: async (slug, args, context) => {
        if (slug === "GITHUB_LIST_REPOSITORY_ISSUES") {
          listCalls.push({ slug, args, context });
          const ordered = String(args.direction) === "desc" ? [...issues].reverse() : issues;
          return pageResult(ordered, args, "issues");
        }

        if (isSheetWrite(slug)) {
          writtenRows.push(...rowsFromArgs(args));
          return sheetWriteResult(writtenRows.length);
        }

        throw new Error(`Unexpected tool call: ${slug}`);
      },
    });

    const result = await service.runWorkflow(GITHUB_ISSUES_TO_SHEET, {
      userId: "user_recent_issues",
      repository: "composiohq/composio",
      prompt: "fetch 5 recent github issues on composiohq/composio and write them to a sheet",
    });

    expect(result).toMatchObject({
      status: "completed",
      writtenRows: 5,
    });
    expect(writtenRows).toHaveLength(5);
    expect(writtenRows.map((row) => row.issueNumber)).toEqual([50, 49, 48, 47, 46]);
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0].args).toMatchObject({
      per_page: 5,
      state: "all",
      direction: "desc",
      sort: "created",
    });
  });

  test("preserves explicit GitHub issue state filters when writing a sheet", async () => {
    const issues = makeIssues(40);
    const writtenRows: Array<Record<string, unknown>> = [];
    const listCalls: ToolCall[] = [];
    const service = await makeWorkflowService({
      onToolCall: async (slug, args, context) => {
        if (slug === "GITHUB_LIST_REPOSITORY_ISSUES") {
          listCalls.push({ slug, args, context });
          const filtered = issues.filter((issue) => issue.state === args.state);
          const ordered = String(args.direction) === "desc" ? [...filtered].reverse() : filtered;
          return pageResult(ordered, args, "issues");
        }

        if (isSheetWrite(slug)) {
          writtenRows.push(...rowsFromArgs(args));
          return sheetWriteResult(writtenRows.length);
        }

        throw new Error(`Unexpected tool call: ${slug}`);
      },
    });

    const result = await service.runWorkflow(GITHUB_ISSUES_TO_SHEET, {
      userId: "user_open_issues",
      repository: "composiohq/composio",
      prompt: "fetch 5 recent open github issues on composiohq/composio and write them to a sheet",
    });

    expect(result).toMatchObject({
      status: "completed",
      writtenRows: 5,
    });
    expect(writtenRows).toHaveLength(5);
    expect(writtenRows.every((row) => row.state === "open")).toBe(true);
    expect(listCalls[0].args).toMatchObject({
      per_page: 5,
      state: "open",
      direction: "desc",
    });
  });

  test("respects a count before an open and closed GitHub issue filter", async () => {
    const issues = makeIssues(50);
    const writtenRows: Array<Record<string, unknown>> = [];
    const listCalls: ToolCall[] = [];
    const service = await makeWorkflowService({
      onToolCall: async (slug, args, context) => {
        if (slug === "GITHUB_LIST_REPOSITORY_ISSUES") {
          listCalls.push({ slug, args, context });
          const ordered = String(args.direction) === "desc" ? [...issues].reverse() : issues;
          return pageResult(ordered, args, "issues");
        }

        if (isSheetWrite(slug)) {
          writtenRows.push(...rowsFromArgs(args));
          return sheetWriteResult(writtenRows.length);
        }

        throw new Error(`Unexpected tool call: ${slug}`);
      },
    });

    const result = await service.runWorkflow(GITHUB_ISSUES_TO_SHEET, {
      userId: "user_open_closed_issues",
      repository: "composiohq/composio",
      prompt: "Read 5 open and closed issues on composiohq/composio and make a Google Sheet of the problems people report",
    });

    expect(result).toMatchObject({
      status: "completed",
      writtenRows: 5,
    });
    expect(writtenRows).toHaveLength(5);
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0].args).toMatchObject({
      per_page: 5,
      state: "all",
      direction: "desc",
      sort: "created",
    });
  });

  const githubIssueLimitCases = [
    {
      name: "read only open issues",
      prompt: "Read only 4 open issues on composiohq/composio and make a Google Sheet",
      count: 4,
      state: "open",
      direction: "desc",
    },
    {
      name: "fetch exactly closed issues",
      prompt: "fetch exactly 3 closed issues on composiohq/composio and write them to a sheet",
      count: 3,
      state: "closed",
      direction: "desc",
    },
    {
      name: "first issues",
      prompt: "first 6 issues on composiohq/composio to a Google Sheet",
      count: 6,
      state: "all",
      direction: "asc",
    },
    {
      name: "bare count before issues",
      prompt: "7 issues from composiohq/composio to a sheet",
      count: 7,
      state: "all",
      direction: "desc",
    },
    {
      name: "most recent issues",
      prompt: "5 most recent issues from composiohq/composio to a sheet",
      count: 5,
      state: "all",
      direction: "desc",
    },
    {
      name: "limit to issues",
      prompt: "limit to 5 issues from composiohq/composio and make a sheet",
      count: 5,
      state: "all",
      direction: "desc",
    },
    {
      name: "first open and closed issues",
      prompt: "first 5 open and closed issues from composiohq/composio to a sheet",
      count: 5,
      state: "all",
      direction: "asc",
    },
    {
      name: "count before issues open and closed",
      prompt: "5 issues open and closed from composiohq/composio to a sheet",
      count: 5,
      state: "all",
      direction: "desc",
    },
    {
      name: "issues comma limit",
      prompt: "issues from composiohq/composio, limit 5, to a sheet",
      count: 5,
      state: "all",
      direction: "desc",
    },
  ];

  for (const testCase of githubIssueLimitCases) {
    test(`respects GitHub issue limit phrase: ${testCase.name}`, async () => {
      const { result, writtenRows, listCalls } = await runGithubIssueLimitPrompt(testCase.prompt);

      expect(result).toMatchObject({
        status: "completed",
        writtenRows: testCase.count,
      });
      expect(writtenRows).toHaveLength(testCase.count);
      expect(listCalls).toHaveLength(1);
      expect(listCalls[0].args).toMatchObject({
        per_page: testCase.count,
        state: testCase.state,
        direction: testCase.direction,
      });
    });
  }

  const githubIssueInputLimitCases = [
    ["limit", { limit: 7 }],
    ["issueLimit", { issueLimit: 7 }],
  ] as const;

  for (const [name, input] of githubIssueInputLimitCases) {
    test(`respects GitHub issue structured limit field: ${name}`, async () => {
      const { result, writtenRows, listCalls } = await runGithubIssueLimitPrompt(
        "issues from composiohq/composio to a sheet",
        input
      );

      expect(result).toMatchObject({
        status: "completed",
        writtenRows: 7,
      });
      expect(writtenRows).toHaveLength(7);
      expect(listCalls[0].args).toMatchObject({
        per_page: 7,
        state: "all",
      });
    });
  }

  test("stops GitHub issue pagination at the requested limit across pages", async () => {
    const issues = makeIssues(300);
    const writtenRows: Array<Record<string, unknown>> = [];
    const listCalls: ToolCall[] = [];
    const service = await makeWorkflowService({
      onToolCall: async (slug, args, context) => {
        if (slug === "GITHUB_LIST_REPOSITORY_ISSUES") {
          listCalls.push({ slug, args, context });
          return pageResult(issues, args, "issues");
        }

        if (isSheetWrite(slug)) {
          writtenRows.push(...rowsFromArgs(args));
          return sheetWriteResult(writtenRows.length);
        }

        throw new Error(`Unexpected tool call: ${slug}`);
      },
    });

    const result = await service.runWorkflow(GITHUB_ISSUES_TO_SHEET, {
      userId: "user_github_limit_pagination",
      repository: "composiohq/composio",
      limit: 125,
    });

    expect(result).toMatchObject({
      status: "completed",
      writtenRows: 125,
    });
    expect(writtenRows).toHaveLength(125);
    expect(listCalls.map((call) => call.args.page)).toEqual([1, 2]);
    expect(listCalls.map((call) => call.args.per_page)).toEqual([100, 100]);
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

  test("respects an explicit Drive resume count when writing a sheet", async () => {
    const resumes = makeResumeFiles(20);
    const writtenRows: Array<Record<string, unknown>> = [];
    const listCalls: ToolCall[] = [];
    const service = await makeWorkflowService({
      onToolCall: async (slug, args, context) => {
        if (slug === "GOOGLESUPER_FIND_FILE" || slug === "GOOGLESUPER_LIST_CHILDREN_V2") {
          listCalls.push({ slug, args, context });
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
          writtenRows.push(...rowsFromArgs(args));
          return sheetWriteResult(writtenRows.length);
        }

        throw new Error(`Unexpected tool call: ${slug}`);
      },
    });

    const result = await service.runWorkflow(DRIVE_RESUMES_TO_SHEET, {
      userId: "user_limited_resumes",
      folderId: "drive_folder_limited",
      prompt: "fetch exactly 3 resumes from this Drive folder and write their content to a sheet",
    });

    expect(result).toMatchObject({
      status: "completed",
      writtenRows: 3,
    });
    expect(writtenRows.map((row) => row.fileId)).toEqual(["resume_1", "resume_2", "resume_3"]);
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0].args).toMatchObject({ pageSize: 3 });
  });

  const driveResumeLimitCases = [
    {
      name: "take only resumes",
      prompt: "take only 4 resumes from this Drive folder and write them to a sheet",
      count: 4,
    },
    {
      name: "first resumes",
      prompt: "first 6 resumes from this Drive folder to a Google Sheet",
      count: 6,
    },
    {
      name: "top candidate documents",
      prompt: "process top 2 candidate documents from this Drive folder into a sheet",
      count: 2,
    },
    {
      name: "bare pdf count",
      prompt: "7 pdfs from this Drive folder to a sheet",
      count: 7,
    },
    {
      name: "up to resumes",
      prompt: "up to 3 resumes from this Drive folder to a sheet",
      count: 3,
    },
    {
      name: "most recent resumes",
      prompt: "3 most recent resumes from this Drive folder to a sheet",
      count: 3,
    },
    {
      name: "candidate resumes",
      prompt: "3 candidate resumes from this Drive folder to a sheet",
      count: 3,
    },
    {
      name: "CVs",
      prompt: "3 CVs from this Drive folder to a sheet",
      count: 3,
    },
    {
      name: "PDF files",
      prompt: "3 PDF files from this Drive folder to a sheet",
      count: 3,
    },
    {
      name: "resumes comma limit",
      prompt: "resumes from this Drive folder, limit 3, to a sheet",
      count: 3,
    },
  ];

  for (const testCase of driveResumeLimitCases) {
    test(`respects Drive resume limit phrase: ${testCase.name}`, async () => {
      const { result, writtenRows, listCalls } = await runDriveResumeLimitPrompt(testCase.prompt);

      expect(result).toMatchObject({
        status: "completed",
        writtenRows: testCase.count,
      });
      expect(writtenRows).toHaveLength(testCase.count);
      expect(writtenRows.map((row) => row.fileId)).toEqual(
        Array.from({ length: testCase.count }, (_, index) => `resume_${index + 1}`)
      );
      expect(listCalls).toHaveLength(1);
      expect(listCalls[0].args).toMatchObject({ pageSize: testCase.count });
    });
  }

  const driveResumeInputLimitCases = [
    ["resumeLimit", { resumeLimit: 4 }],
    ["maxFiles", { maxFiles: 4 }],
  ] as const;

  for (const [name, input] of driveResumeInputLimitCases) {
    test(`respects Drive resume structured limit field: ${name}`, async () => {
      const { result, writtenRows, listCalls } = await runDriveResumeLimitPrompt(
        "resumes from this Drive folder to a sheet",
        input
      );

      expect(result).toMatchObject({
        status: "completed",
        writtenRows: 4,
      });
      expect(writtenRows).toHaveLength(4);
      expect(listCalls[0].args).toMatchObject({ pageSize: 4 });
    });
  }

  test("continues Drive pagination until the requested non-folder file count is reached", async () => {
    const writtenRows: Array<Record<string, unknown>> = [];
    const listCalls: ToolCall[] = [];
    const firstPage = [
      { id: "folder_1", fileId: "folder_1", name: "Nested", mimeType: "application/vnd.google-apps.folder" },
      { id: "folder_2", fileId: "folder_2", name: "Archive", mimeType: "application/vnd.google-apps.folder" },
      ...makeResumeFiles(3),
    ];
    const secondPage = makeResumeFiles(10).slice(3);
    const service = await makeWorkflowService({
      onToolCall: async (slug, args, context) => {
        if (slug === "GOOGLESUPER_FIND_FILE" || slug === "GOOGLESUPER_LIST_CHILDREN_V2") {
          listCalls.push({ slug, args, context });
          const pageToken = args.pageToken ?? args.nextPageToken ?? args.cursor;
          return {
            files: pageToken ? secondPage : firstPage,
            items: pageToken ? secondPage : firstPage,
            nextPageToken: pageToken ? null : "page-2",
            total: 12,
          };
        }

        if (slug === "GOOGLESUPER_PARSE_FILE") {
          const fileId = stringArg(args, ["fileId", "file_id", "id"]);
          return { text: `Candidate ${fileId}` };
        }

        if (isSheetWrite(slug)) {
          writtenRows.push(...rowsFromArgs(args));
          return sheetWriteResult(writtenRows.length);
        }

        throw new Error(`Unexpected tool call: ${slug}`);
      },
    });

    const result = await service.runWorkflow(DRIVE_RESUMES_TO_SHEET, {
      userId: "user_drive_limit_pagination",
      folderId: "drive_folder_limit_pagination",
      resumeLimit: 5,
    });

    expect(result).toMatchObject({
      status: "completed",
      writtenRows: 5,
    });
    expect(writtenRows).toHaveLength(5);
    expect(writtenRows.map((row) => row.fileId)).toEqual(["resume_1", "resume_2", "resume_3", "resume_4", "resume_5"]);
    expect(listCalls).toHaveLength(2);
    expect(listCalls[0].args).toMatchObject({ pageSize: 5 });
    expect(listCalls[1].args).toMatchObject({ pageSize: 5 });
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

  test("defaults Drive resume parsing to concurrent work", async () => {
    const resumes = makeResumeFiles(5);
    let activeParses = 0;
    let maxActiveParses = 0;

    const service = await makeWorkflowService({
      onToolCall: async (slug, args) => {
        if (slug === "GOOGLESUPER_FIND_FILE" || slug === "GOOGLESUPER_LIST_CHILDREN_V2") {
          return pageResult(resumes, args, "files");
        }

        if (slug === "GOOGLESUPER_PARSE_FILE") {
          const fileId = stringArg(args, ["fileId", "file_id", "id"]);
          activeParses += 1;
          maxActiveParses = Math.max(maxActiveParses, activeParses);
          await sleep(5);
          activeParses -= 1;
          return { text: `Candidate ${fileId}` };
        }

        if (isSheetWrite(slug)) {
          return sheetWriteResult(rowsFromArgs(args).length);
        }

        throw new Error(`Unexpected tool call: ${slug}`);
      },
    });

    const result = await service.runWorkflow(DRIVE_RESUMES_TO_SHEET, {
      userId: "user_default_concurrency",
      folderId: "drive_folder_default_concurrency",
    });

    expect(result.status).toBe("completed");
    expect(maxActiveParses).toBeGreaterThan(1);
    expect(maxActiveParses).toBeLessThanOrEqual(resumes.length);
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

  test("reads created sheet headers before appending Google values batches", async () => {
    const issues = makeIssues(3);
    const calls: ToolCall[] = [];
    const service = await makeWorkflowService({
      sheetBatchSize: 2,
      sheetValueMode: "googleValues",
      onToolCall: async (slug, args, context) => {
        calls.push({ slug, args, context });

        if (slug === "GITHUB_LIST_REPOSITORY_ISSUES" || slug === "GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS") {
          return pageResult(issues, args, "issues");
        }

        if (slug === "GOOGLESUPER_SHEET_FROM_JSON") {
          return sheetWriteResult(2);
        }

        if (slug === "GOOGLESUPER_GET_BATCH_VALUES") {
          return {
            data: {
              valueRanges: [
                {
                  values: [["title", "issueNumber", "state"]],
                },
              ],
            },
          };
        }

        if (slug === "GOOGLESUPER_SPREADSHEETS_VALUES_APPEND") {
          return sheetWriteResult(1);
        }

        throw new Error(`Unexpected tool call: ${slug}`);
      },
    });

    const result = await service.runWorkflow(GITHUB_ISSUES_TO_SHEET, {
      userId: "user_google_values_headers",
      repository: "composiohq/composio",
      spreadsheetTitle: "Header ordered issue report",
    });

    expect(result).toMatchObject({
      status: "completed",
      writtenRows: 3,
    });

    const slugs = calls.map((call) => call.slug);
    expect(slugs).toContain("GOOGLESUPER_SHEET_FROM_JSON");
    expect(slugs).toContain("GOOGLESUPER_GET_BATCH_VALUES");
    expect(slugs).toContain("GOOGLESUPER_SPREADSHEETS_VALUES_APPEND");

    const appendCall = calls.find((call) => call.slug === "GOOGLESUPER_SPREADSHEETS_VALUES_APPEND");
    expect(appendCall?.args.values).toEqual([["Issue 3", 3, "open"]]);
  });
});

async function makeWorkflowService(options: {
  onToolCall: (slug: string, args: Record<string, unknown>, context: ToolContext) => Promise<unknown>;
  requestApproval?: (request: ApprovalRequest) => Promise<ApprovalGrant>;
  isCancelled?: (jobId: string) => Promise<boolean> | boolean;
  sheetBatchSize?: number;
  sheetValueMode?: "recordRows" | "googleValues";
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
      sheetValueMode: options.sheetValueMode,
      workflowConcurrency: options.workflowConcurrency,
    },
  }) as WorkflowService;
}

async function runGithubIssueLimitPrompt(prompt: string, inputOverrides: Record<string, unknown> = {}) {
  const issues = makeIssues(60);
  const writtenRows: Array<Record<string, unknown>> = [];
  const listCalls: ToolCall[] = [];
  const service = await makeWorkflowService({
    onToolCall: async (slug, args, context) => {
      if (slug === "GITHUB_LIST_REPOSITORY_ISSUES") {
        listCalls.push({ slug, args, context });
        const state = String(args.state ?? "all");
        const filtered = state === "all" ? issues : issues.filter((issue) => issue.state === state);
        const ordered = String(args.direction) === "desc" ? [...filtered].reverse() : filtered;
        return pageResult(ordered, args, "issues");
      }

      if (isSheetWrite(slug)) {
        writtenRows.push(...rowsFromArgs(args));
        return sheetWriteResult(writtenRows.length);
      }

      throw new Error(`Unexpected tool call: ${slug}`);
    },
  });

  const result = await service.runWorkflow(GITHUB_ISSUES_TO_SHEET, {
    userId: "user_github_limit_matrix",
    repository: "composiohq/composio",
    prompt,
    ...inputOverrides,
  });

  return { result, writtenRows, listCalls };
}

async function runDriveResumeLimitPrompt(prompt: string, inputOverrides: Record<string, unknown> = {}) {
  const resumes = makeResumeFiles(30);
  const writtenRows: Array<Record<string, unknown>> = [];
  const listCalls: ToolCall[] = [];
  const service = await makeWorkflowService({
    onToolCall: async (slug, args, context) => {
      if (slug === "GOOGLESUPER_FIND_FILE" || slug === "GOOGLESUPER_LIST_CHILDREN_V2") {
        listCalls.push({ slug, args, context });
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
        writtenRows.push(...rowsFromArgs(args));
        return sheetWriteResult(writtenRows.length);
      }

      throw new Error(`Unexpected tool call: ${slug}`);
    },
  });

  const result = await service.runWorkflow(DRIVE_RESUMES_TO_SHEET, {
    userId: "user_drive_limit_matrix",
    folderId: "drive_folder_limit_matrix",
    prompt,
    ...inputOverrides,
  });

  return { result, writtenRows, listCalls };
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
