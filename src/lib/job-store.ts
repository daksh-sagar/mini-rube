import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";

export type WorkflowJobStatus =
  | "queued"
  | "running"
  | "waiting_confirmation"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkflowJob = {
  id: string;
  workflowId: string;
  userId: string;
  status: WorkflowJobStatus;
  input: Record<string, unknown>;
  checkpoint?: Record<string, unknown>;
  progress?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  attempt: number;
  lockedBy?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type WorkflowStore = {
  createJob(job: {
    workflowId: string;
    userId: string;
    input: Record<string, unknown>;
    id?: string;
  }): Promise<WorkflowJob>;
  saveCheckpoint(jobId: string, checkpoint: Record<string, unknown>): Promise<WorkflowJob>;
  updateProgress(jobId: string, progress: Record<string, unknown>): Promise<WorkflowJob>;
  markWaitingForConfirmation(jobId: string, details?: Record<string, unknown>): Promise<WorkflowJob>;
  // Transition a job that was paused for approval back to "running" once the grant
  // is in. Only flips "waiting_confirmation" → "running" so it can't clobber a
  // terminal status set by a concurrent cancel/fail.
  markRunning(jobId: string): Promise<WorkflowJob>;
  markInterrupted(jobId: string, details: { reason: string }): Promise<WorkflowJob>;
  claimNextRunnableJob(query: { workflowId?: string; workerId: string }): Promise<WorkflowJob | null>;
  completeJob(jobId: string, output: Record<string, unknown>): Promise<WorkflowJob>;
  failJob(jobId: string, error: string): Promise<WorkflowJob>;
  cancelJob(jobId: string, reason?: string): Promise<WorkflowJob>;
  getJob(jobId: string): Promise<WorkflowJob | null>;
  listJobsByUser?(userId: string): Promise<WorkflowJob[]>;
  close?(): Promise<void> | void;
};

type StoredWorkflowJob = WorkflowJob & {
  input: Record<string, unknown>;
  checkpoint?: Record<string, unknown>;
  progress?: Record<string, unknown>;
  output?: Record<string, unknown>;
};

export async function createMemoryWorkflowStore(): Promise<WorkflowStore> {
  const jobs = new Map<string, StoredWorkflowJob>();

  return {
    async createJob(job) {
      const now = nowIso();
      const next: StoredWorkflowJob = {
        id: job.id ?? makeId("job"),
        workflowId: job.workflowId,
        userId: job.userId,
        status: "queued",
        input: cloneRecord(job.input),
        attempt: 0,
        createdAt: now,
        updatedAt: now,
      };
      jobs.set(next.id, next);
      return cloneJob(next);
    },

    async saveCheckpoint(jobId, checkpoint) {
      const job = requireJob(jobs, jobId);
      job.checkpoint = cloneRecord(checkpoint);
      job.updatedAt = nowIso();
      return cloneJob(job);
    },

    async updateProgress(jobId, progress) {
      const job = requireJob(jobs, jobId);
      job.progress = { ...(job.progress ?? {}), ...cloneRecord(progress) };
      job.updatedAt = nowIso();
      return cloneJob(job);
    },

    async markWaitingForConfirmation(jobId, details = {}) {
      const job = requireJob(jobs, jobId);
      job.status = "waiting_confirmation";
      job.progress = { ...(job.progress ?? {}), ...cloneRecord(details) };
      job.updatedAt = nowIso();
      return cloneJob(job);
    },

    async markRunning(jobId) {
      const job = requireJob(jobs, jobId);
      if (job.status === "waiting_confirmation") {
        job.status = "running";
        job.updatedAt = nowIso();
      }
      return cloneJob(job);
    },

    async markInterrupted(jobId, details) {
      const job = requireJob(jobs, jobId);
      job.status = "interrupted";
      job.error = details.reason;
      job.lockedBy = undefined;
      job.updatedAt = nowIso();
      return cloneJob(job);
    },

    async claimNextRunnableJob(query) {
      const candidate = [...jobs.values()]
        .filter((job) => ["queued", "interrupted"].includes(job.status))
        .filter((job) => !query.workflowId || job.workflowId === query.workflowId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];

      if (!candidate) {
        return null;
      }

      candidate.status = "running";
      candidate.lockedBy = query.workerId;
      candidate.attempt += 1;
      candidate.updatedAt = nowIso();
      return cloneJob(candidate);
    },

    async completeJob(jobId, output) {
      const job = requireJob(jobs, jobId);
      job.status = "completed";
      job.output = cloneRecord(output);
      job.lockedBy = undefined;
      job.completedAt = nowIso();
      job.updatedAt = job.completedAt;
      return cloneJob(job);
    },

    async failJob(jobId, error) {
      const job = requireJob(jobs, jobId);
      job.status = "failed";
      job.error = error;
      job.lockedBy = undefined;
      job.updatedAt = nowIso();
      return cloneJob(job);
    },

    async cancelJob(jobId, reason) {
      const job = requireJob(jobs, jobId);
      job.status = "cancelled";
      job.error = reason;
      job.lockedBy = undefined;
      job.updatedAt = nowIso();
      return cloneJob(job);
    },

    async getJob(jobId) {
      const job = jobs.get(jobId);
      return job ? cloneJob(job) : null;
    },

    async listJobsByUser(userId) {
      return [...jobs.values()]
        .filter((job) => job.userId === userId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(cloneJob);
    },
  };
}

export async function createSqliteWorkflowStore(options: {
  databasePath?: string;
} = {}): Promise<WorkflowStore> {
  const databasePath = resolve(options.databasePath ?? ".mini-rube/workflows.sqlite");
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new Database(databasePath, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run(`
    CREATE TABLE IF NOT EXISTS workflow_jobs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      input_json TEXT NOT NULL,
      checkpoint_json TEXT,
      progress_json TEXT,
      output_json TEXT,
      error TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      locked_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_workflow_jobs_status ON workflow_jobs(status, workflow_id, created_at)");
  db.run("CREATE INDEX IF NOT EXISTS idx_workflow_jobs_user ON workflow_jobs(user_id, updated_at)");

  const insertJob = db.prepare(`
    INSERT INTO workflow_jobs (
      id, workflow_id, user_id, status, input_json, attempt, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectJob = db.prepare("SELECT * FROM workflow_jobs WHERE id = ?");
  const selectRunnable = db.prepare(`
    SELECT * FROM workflow_jobs
    WHERE status IN ('queued', 'interrupted')
      AND (? IS NULL OR workflow_id = ?)
    ORDER BY created_at ASC
    LIMIT 1
  `);
  const selectByUser = db.prepare(`
    SELECT * FROM workflow_jobs
    WHERE user_id = ?
    ORDER BY updated_at DESC
  `);
  const getSqliteJob = (jobId: string) => {
    const row = selectJob.get(jobId);
    return row ? rowToJob(row) : null;
  };

  return {
    async createJob(job) {
      const now = nowIso();
      const id = job.id ?? makeId("job");
      insertJob.run(id, job.workflowId, job.userId, "queued", stringifyJson(job.input), 0, now, now);
      return requireSqliteJob(getSqliteJob(id), id);
    },

    async saveCheckpoint(jobId, checkpoint) {
      db.prepare("UPDATE workflow_jobs SET checkpoint_json = ?, updated_at = ? WHERE id = ?").run(
        stringifyJson(checkpoint),
        nowIso(),
        jobId
      );
      return requireSqliteJob(getSqliteJob(jobId), jobId);
    },

    async updateProgress(jobId, progress) {
      const job = requireSqliteJob(getSqliteJob(jobId), jobId);
      const nextProgress = { ...(job.progress ?? {}), ...cloneRecord(progress) };
      db.prepare("UPDATE workflow_jobs SET progress_json = ?, updated_at = ? WHERE id = ?").run(
        stringifyJson(nextProgress),
        nowIso(),
        jobId
      );
      return requireSqliteJob(getSqliteJob(jobId), jobId);
    },

    async markWaitingForConfirmation(jobId, details = {}) {
      const job = requireSqliteJob(getSqliteJob(jobId), jobId);
      const nextProgress = { ...(job.progress ?? {}), ...cloneRecord(details) };
      db.prepare("UPDATE workflow_jobs SET status = 'waiting_confirmation', progress_json = ?, updated_at = ? WHERE id = ?").run(
        stringifyJson(nextProgress),
        nowIso(),
        jobId
      );
      return requireSqliteJob(getSqliteJob(jobId), jobId);
    },

    async markRunning(jobId) {
      db.prepare(
        "UPDATE workflow_jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'waiting_confirmation'"
      ).run(nowIso(), jobId);
      return requireSqliteJob(getSqliteJob(jobId), jobId);
    },

    async markInterrupted(jobId, details) {
      db.prepare(
        "UPDATE workflow_jobs SET status = 'interrupted', error = ?, locked_by = NULL, updated_at = ? WHERE id = ?"
      ).run(details.reason, nowIso(), jobId);
      return requireSqliteJob(getSqliteJob(jobId), jobId);
    },

    async claimNextRunnableJob(query) {
      const row = selectRunnable.get(query.workflowId ?? null, query.workflowId ?? null);
      if (!row) {
        return null;
      }
      const job = rowToJob(row);
      db.prepare(
        "UPDATE workflow_jobs SET status = 'running', locked_by = ?, attempt = attempt + 1, updated_at = ? WHERE id = ?"
      ).run(query.workerId, nowIso(), job.id);
      return requireSqliteJob(getSqliteJob(job.id), job.id);
    },

    async completeJob(jobId, output) {
      const completedAt = nowIso();
      db.prepare(
        "UPDATE workflow_jobs SET status = 'completed', output_json = ?, locked_by = NULL, completed_at = ?, updated_at = ? WHERE id = ?"
      ).run(stringifyJson(output), completedAt, completedAt, jobId);
      return requireSqliteJob(getSqliteJob(jobId), jobId);
    },

    async failJob(jobId, error) {
      db.prepare(
        "UPDATE workflow_jobs SET status = 'failed', error = ?, locked_by = NULL, updated_at = ? WHERE id = ?"
      ).run(error, nowIso(), jobId);
      return requireSqliteJob(getSqliteJob(jobId), jobId);
    },

    async cancelJob(jobId, reason) {
      db.prepare(
        "UPDATE workflow_jobs SET status = 'cancelled', error = ?, locked_by = NULL, updated_at = ? WHERE id = ?"
      ).run(reason ?? null, nowIso(), jobId);
      return requireSqliteJob(getSqliteJob(jobId), jobId);
    },

    async getJob(jobId) {
      return getSqliteJob(jobId);
    },

    async listJobsByUser(userId) {
      return selectByUser.all(userId).map(rowToJob);
    },

    close() {
      db.close();
    },
  };
}

function requireJob(jobs: Map<string, StoredWorkflowJob>, jobId: string) {
  const job = jobs.get(jobId);
  if (!job) {
    throw new Error(`Workflow job not found: ${jobId}`);
  }
  return job;
}

function requireSqliteJob(job: WorkflowJob | null, jobId: string) {
  if (!job) {
    throw new Error(`Workflow job not found: ${jobId}`);
  }
  return job;
}

function rowToJob(row: any): WorkflowJob {
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    userId: String(row.user_id),
    status: row.status as WorkflowJobStatus,
    input: parseRecord(row.input_json),
    checkpoint: parseOptionalRecord(row.checkpoint_json),
    progress: parseOptionalRecord(row.progress_json),
    output: parseOptionalRecord(row.output_json),
    error: typeof row.error === "string" ? row.error : undefined,
    attempt: Number(row.attempt ?? 0),
    lockedBy: typeof row.locked_by === "string" ? row.locked_by : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: typeof row.completed_at === "string" ? row.completed_at : undefined,
  };
}

function cloneJob(job: WorkflowJob): WorkflowJob {
  return {
    ...job,
    input: cloneRecord(job.input),
    checkpoint: job.checkpoint ? cloneRecord(job.checkpoint) : undefined,
    progress: job.progress ? cloneRecord(job.progress) : undefined,
    output: job.output ? cloneRecord(job.output) : undefined,
  };
}

function cloneRecord(value: Record<string, unknown>) {
  return JSON.parse(JSON.stringify(value ?? {})) as Record<string, unknown>;
}

function stringifyJson(value: unknown) {
  return JSON.stringify(value ?? {});
}

function parseRecord(value: unknown) {
  const parsed = parseJson(value);
  return isRecord(parsed) ? parsed : {};
}

function parseOptionalRecord(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = parseJson(value);
  return isRecord(parsed) ? parsed : undefined;
}

function parseJson(value: unknown) {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}
