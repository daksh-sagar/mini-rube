import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryWorkflowStore, createSqliteWorkflowStore } from "../src/lib/job-store";
import { DRIVE_RESUMES_TO_SHEET } from "../src/lib/workflows";

type WorkflowJob = {
  id: string;
  workflowId: string;
  userId: string;
  status: "queued" | "running" | "interrupted" | "completed" | "failed";
  input: Record<string, unknown>;
  checkpoint?: Record<string, unknown>;
  attempt: number;
  lockedBy?: string;
};

type WorkflowStore = {
  createJob: (job: {
    workflowId: string;
    userId: string;
    input: Record<string, unknown>;
  }) => Promise<WorkflowJob>;
  saveCheckpoint: (jobId: string, checkpoint: Record<string, unknown>) => Promise<WorkflowJob>;
  markInterrupted: (jobId: string, details: { reason: string }) => Promise<WorkflowJob>;
  claimNextRunnableJob: (query: { workflowId?: string; workerId: string }) => Promise<WorkflowJob | null>;
  completeJob: (jobId: string, output: Record<string, unknown>) => Promise<WorkflowJob>;
  getJob: (jobId: string) => Promise<WorkflowJob | null>;
  close?: () => Promise<void> | void;
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("planned workflow job store", () => {
  test("memory store reclaims an interrupted job with its latest checkpoint", async () => {
    const store = (await createMemoryWorkflowStore()) as WorkflowStore;

    await expectInterruptedJobCanResumeFromCheckpoint({
      openStore: async () => store,
      reopenAfterInterrupt: false,
    });
  });

  test("sqlite store persists interrupted checkpoints across process restarts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mini-rube-jobs-"));
    tempDirs.push(dir);
    const databasePath = join(dir, "jobs.sqlite");

    await expectInterruptedJobCanResumeFromCheckpoint({
      openStore: async () => (await createSqliteWorkflowStore({ databasePath })) as WorkflowStore,
      reopenAfterInterrupt: true,
    });
  });
});

async function expectInterruptedJobCanResumeFromCheckpoint(options: {
  openStore: () => Promise<WorkflowStore>;
  reopenAfterInterrupt: boolean;
}) {
  let store = await options.openStore();
  const input = {
    folderId: "drive_folder_123",
    spreadsheetId: "sheet_123",
  };
  const checkpoint = {
    step: "parse-resumes",
    cursor: "drive-page-3",
    nextItemIndex: 240,
    processedItemIds: ["resume_238", "resume_239", "resume_240"],
    writtenRowCount: 240,
    spreadsheetId: "sheet_123",
  };

  const job = await store.createJob({
    workflowId: workflowIdOf(DRIVE_RESUMES_TO_SHEET),
    userId: "user_resume_checkpoint",
    input,
  });

  await store.saveCheckpoint(job.id, checkpoint);
  await store.markInterrupted(job.id, { reason: "worker stopped before the next batch append" });
  await store.close?.();

  if (options.reopenAfterInterrupt) {
    store = await options.openStore();
  }

  const resumed = await store.claimNextRunnableJob({
    workflowId: workflowIdOf(DRIVE_RESUMES_TO_SHEET),
    workerId: "worker_after_restart",
  });

  expect(resumed).not.toBeNull();
  expect(resumed).toMatchObject({
    id: job.id,
    workflowId: workflowIdOf(DRIVE_RESUMES_TO_SHEET),
    userId: "user_resume_checkpoint",
    input,
    checkpoint,
    status: "running",
    lockedBy: "worker_after_restart",
  });
  expect(resumed?.attempt).toBeGreaterThan(job.attempt);

  await store.saveCheckpoint(job.id, {
    ...checkpoint,
    cursor: null,
    nextItemIndex: 1000,
    writtenRowCount: 1000,
  });
  await store.completeJob(job.id, {
    writtenRows: 1000,
    resumedFromCheckpoint: checkpoint,
  });

  const completed = await store.getJob(job.id);
  expect(completed).toMatchObject({
    id: job.id,
    status: "completed",
    checkpoint: {
      cursor: null,
      nextItemIndex: 1000,
      writtenRowCount: 1000,
    },
  });

  await store.close?.();
}

function workflowIdOf(workflow: unknown) {
  if (typeof workflow === "string") {
    return workflow;
  }
  if (isRecord(workflow) && typeof workflow.id === "string") {
    return workflow.id;
  }
  throw new Error("Workflow definition must be a string id or include an id field");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
