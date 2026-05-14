import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"
import { z } from "zod"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutomationTaskType = "cron" | "interval"

/** Task-level status. Tracks the latest known state across runs.
 *   - `idle`: enabled but no recent failure; ready to fire on schedule.
 *   - `running`: a run is currently in progress.
 *   - `error`: the most recent run failed; new runs still attempt unless the
 *     consecutive-failure budget is exhausted (which auto-disables `enabled`).
 *   - `disabled`: explicitly switched off by the user. */
export type AutomationTaskStatus = "idle" | "running" | "error" | "disabled"

/** Per-run terminal status. `running` is non-terminal until the runner
 *   transitions to one of the others. `skipped` is the concurrent-conflict
 *   case where another run for the same task is already in flight. */
export type AutomationRunStatus = "running" | "completed" | "failed" | "skipped" | "timeout"

// ---------------------------------------------------------------------------
// Drizzle tables
// ---------------------------------------------------------------------------

export const AutomationTaskTable = sqliteTable(
  "automation_task",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    type: text().notNull().$type<AutomationTaskType>(),
    /** For `cron` tasks: a standard 5-field cron expression (croner-compatible).
     *  For `interval` tasks: a positive integer in milliseconds. */
    expression: text().notNull(),
    /** The orchestrator prompt to send when the task fires. */
    prompt: text().notNull(),
    agent: text().notNull().default("orchestrator"),
    model: text({ mode: "json" }).$type<{ providerID?: string; modelID?: string; variant?: string } | null>(),
    /** When set, used as the worktree-name prefix instead of slugifying `name`. */
    worktree_prefix: text(),
    enabled: integer({ mode: "boolean" }).notNull().default(true),
    /** Latest known status — UI summary field. */
    status: text().notNull().$type<AutomationTaskStatus>().default("idle"),
    /** Wall-clock ms of the last fired run. */
    last_run_at: integer(),
    /** Last error message if `status === "error"`. */
    error_message: text(),
    /** Running count of consecutive failed runs. Reset to 0 on any success. */
    consecutive_failures: integer().notNull().default(0),
    /** Soft circuit breaker — when failures reach this, `enabled` is auto-set
     *  to false so a broken task doesn't hammer the LLM provider. */
    max_consecutive_failures: integer().notNull().default(3),
    /** Soft cap on persisted run history per task; older runs are pruned by
     *  the API after each insert. */
    max_retention: integer().notNull().default(20),
    ...Timestamps,
  },
  (table) => [
    index("automation_task_type_idx").on(table.type),
    index("automation_task_enabled_idx").on(table.enabled),
  ],
)

export const AutomationRunTable = sqliteTable(
  "automation_run",
  {
    id: text().primaryKey(),
    task_id: text()
      .notNull()
      .references(() => AutomationTaskTable.id, { onDelete: "cascade" }),
    /** Filled once the runner has created the orchestrator session. */
    session_id: text(),
    /** Filled when the orchestrator hands off to a workflow runtime. */
    workflow_id: text(),
    worktree_name: text(),
    worktree_directory: text(),
    worktree_branch: text(),
    status: text().notNull().$type<AutomationRunStatus>().default("running"),
    error_message: text(),
    started_at: integer(),
    finished_at: integer(),
    ...Timestamps,
  },
  (table) => [
    index("automation_run_task_idx").on(table.task_id),
    index("automation_run_status_idx").on(table.status),
  ],
)

// ---------------------------------------------------------------------------
// Insert/select types
// ---------------------------------------------------------------------------

export type AutomationTask = typeof AutomationTaskTable.$inferSelect
export type AutomationTaskInsert = typeof AutomationTaskTable.$inferInsert
export type AutomationRun = typeof AutomationRunTable.$inferSelect
export type AutomationRunInsert = typeof AutomationRunTable.$inferInsert

// ---------------------------------------------------------------------------
// Zod schemas (API validation + SDK shape)
// ---------------------------------------------------------------------------

export const AutomationTaskTypeSchema = z.enum(["cron", "interval"])
export const AutomationTaskStatusSchema = z.enum(["idle", "running", "error", "disabled"])
export const AutomationRunStatusSchema = z.enum(["running", "completed", "failed", "skipped", "timeout"])

const ModelHintSchema = z
  .object({
    providerID: z.string().optional(),
    modelID: z.string().optional(),
    variant: z.string().optional(),
  })
  .nullable()
  .optional()

export const CreateAutomationTaskSchema = z.object({
  name: z.string().min(1).max(120),
  type: AutomationTaskTypeSchema,
  expression: z.string().min(1),
  prompt: z.string().min(1),
  agent: z.string().optional(),
  model: ModelHintSchema,
  worktree_prefix: z.string().optional(),
  enabled: z.boolean().optional(),
  max_retention: z.number().int().positive().optional(),
  max_consecutive_failures: z.number().int().nonnegative().optional(),
})

export const UpdateAutomationTaskSchema = CreateAutomationTaskSchema.partial()

export const AutomationTaskInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: AutomationTaskTypeSchema,
  expression: z.string(),
  prompt: z.string(),
  agent: z.string(),
  model: z.object({
    providerID: z.string().optional(),
    modelID: z.string().optional(),
    variant: z.string().optional(),
  }).nullable().optional(),
  worktree_prefix: z.string().nullable().optional(),
  enabled: z.boolean(),
  status: AutomationTaskStatusSchema,
  last_run_at: z.number().nullable().optional(),
  error_message: z.string().nullable().optional(),
  consecutive_failures: z.number().int(),
  max_consecutive_failures: z.number().int(),
  max_retention: z.number().int(),
  time_created: z.number(),
  time_updated: z.number(),
})

export const AutomationRunInfoSchema = z.object({
  id: z.string(),
  task_id: z.string(),
  session_id: z.string().nullable().optional(),
  workflow_id: z.string().nullable().optional(),
  worktree_name: z.string().nullable().optional(),
  worktree_directory: z.string().nullable().optional(),
  worktree_branch: z.string().nullable().optional(),
  status: AutomationRunStatusSchema,
  error_message: z.string().nullable().optional(),
  started_at: z.number().nullable().optional(),
  finished_at: z.number().nullable().optional(),
  time_created: z.number(),
  time_updated: z.number(),
})
