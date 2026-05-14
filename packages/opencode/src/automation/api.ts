import { Database, eq, desc } from "../storage"
import {
  AutomationTaskTable,
  AutomationRunTable,
  type AutomationTaskStatus,
  type AutomationTaskType,
  type AutomationTask,
  type AutomationRun,
} from "./automation.sql"
import { executeRun, cleanupWorktree, type TaskRow, automationID, markRunFinished } from "./runner"
import { notify } from "../scheduler/notify"
import { Log } from "../util"
import { Cron } from "croner"

const log = Log.create({ service: "automation-api" })

export type CreateTaskInput = {
  name: string
  type: AutomationTaskType
  expression: string
  prompt: string
  agent?: string
  model?: { providerID?: string; modelID?: string; variant?: string } | null
  worktree_prefix?: string
  enabled?: boolean
  max_retention?: number
  max_consecutive_failures?: number
}

export type UpdateTaskInput = Partial<CreateTaskInput>

function validateExpression(type: AutomationTaskType, expression: string) {
  if (type === "cron") {
    try {
      // Construct + immediately stop — croner validates at construction time.
      // We never want this transient instance scheduled, so attach a no-op
      // handler and stop on the next tick equivalent (`stop()` returns void).
      const c = new Cron(expression, { paused: true })
      c.stop()
    } catch (e) {
      throw new Error(`Invalid cron expression: ${expression} — ${e instanceof Error ? e.message : String(e)}`)
    }
  } else {
    const ms = parseInt(expression, 10)
    if (isNaN(ms) || ms <= 0) throw new Error(`Invalid interval (ms) expression: ${expression}`)
  }
}

function toTaskRow(row: AutomationTask): TaskRow {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    expression: row.expression,
    prompt: row.prompt,
    agent: row.agent,
    model: row.model ?? null,
    worktree_prefix: row.worktree_prefix ?? null,
  }
}

/** Callback fired whenever the task table changes — the scheduler hooks into
 *  this so registrations stay in lock-step with the API. Wired up at startup
 *  in `automation/index.ts -> startScheduler()`. */
type OnChange = (event: { kind: "created" | "updated" | "deleted"; task: AutomationTask | null; id: string }) => void
let onChangeHandler: OnChange | null = null
export function setOnChange(handler: OnChange | null) {
  onChangeHandler = handler
}
function emit(event: Parameters<OnChange>[0]) {
  try {
    onChangeHandler?.(event)
  } catch (e) {
    log.warn("automation onChange handler failed", { error: String(e) })
  }
}

export function createTask(input: CreateTaskInput): AutomationTask {
  validateExpression(input.type, input.expression)
  const now = Date.now()
  const id = automationID()
  Database.use((db) =>
    db
      .insert(AutomationTaskTable)
      .values({
        id,
        name: input.name,
        type: input.type,
        expression: input.expression,
        prompt: input.prompt,
        agent: input.agent ?? "orchestrator",
        model: input.model ?? null,
        worktree_prefix: input.worktree_prefix ?? null,
        enabled: input.enabled ?? true,
        status: input.enabled === false ? "disabled" : "idle",
        max_retention: input.max_retention ?? 20,
        max_consecutive_failures: input.max_consecutive_failures ?? 3,
        consecutive_failures: 0,
        time_created: now,
        time_updated: now,
      })
      .run(),
  )
  const row = Database.use((db) =>
    db.select().from(AutomationTaskTable).where(eq(AutomationTaskTable.id, id)).get(),
  )!
  emit({ kind: "created", task: row, id })
  return row
}

export function removeTask(id: string): boolean {
  const row = Database.use((db) =>
    db.select().from(AutomationTaskTable).where(eq(AutomationTaskTable.id, id)).get(),
  )
  if (!row) return false

  // Best-effort worktree cleanup for any historical run that still owns one.
  const runs = Database.use((db) =>
    db.select().from(AutomationRunTable).where(eq(AutomationRunTable.task_id, id)).all(),
  )
  for (const run of runs) {
    if (run.worktree_directory) void cleanupWorktree(run.worktree_directory).catch(() => undefined)
  }

  Database.use((db) => db.delete(AutomationTaskTable).where(eq(AutomationTaskTable.id, id)).run())
  emit({ kind: "deleted", task: null, id })
  return true
}

export function updateTask(id: string, input: UpdateTaskInput): AutomationTask | null {
  const row = Database.use((db) =>
    db.select().from(AutomationTaskTable).where(eq(AutomationTaskTable.id, id)).get(),
  )
  if (!row) return null

  if (input.expression !== undefined || input.type !== undefined) {
    validateExpression(input.type ?? row.type, input.expression ?? row.expression)
  }

  const updates: Record<string, unknown> = { time_updated: Date.now() }
  if (input.name !== undefined) updates.name = input.name
  if (input.type !== undefined) updates.type = input.type
  if (input.expression !== undefined) updates.expression = input.expression
  if (input.prompt !== undefined) updates.prompt = input.prompt
  if (input.agent !== undefined) updates.agent = input.agent
  if (input.model !== undefined) updates.model = input.model
  if (input.worktree_prefix !== undefined) updates.worktree_prefix = input.worktree_prefix
  if (input.enabled !== undefined) {
    updates.enabled = input.enabled
    // Toggling enabled also clears the disabled-marker so a freshly re-enabled
    // task starts in `idle` instead of looking like it's still broken.
    if (input.enabled === true && row.status === "disabled") {
      updates.status = "idle"
      updates.consecutive_failures = 0
      updates.error_message = null
    } else if (input.enabled === false) {
      updates.status = "disabled"
    }
  }
  if (input.max_retention !== undefined) updates.max_retention = input.max_retention
  if (input.max_consecutive_failures !== undefined) updates.max_consecutive_failures = input.max_consecutive_failures

  Database.use((db) =>
    db.update(AutomationTaskTable).set(updates).where(eq(AutomationTaskTable.id, id)).run(),
  )
  const next = Database.use((db) =>
    db.select().from(AutomationTaskTable).where(eq(AutomationTaskTable.id, id)).get(),
  )!
  emit({ kind: "updated", task: next, id })
  return next
}

export function listTasks(): AutomationTask[] {
  return Database.use((db) =>
    db.select().from(AutomationTaskTable).orderBy(desc(AutomationTaskTable.time_created)).all(),
  )
}

export function getTask(id: string): AutomationTask | undefined {
  return Database.use((db) =>
    db.select().from(AutomationTaskTable).where(eq(AutomationTaskTable.id, id)).get(),
  )
}

export function toggleTask(id: string): AutomationTask | null {
  const row = Database.use((db) =>
    db.select().from(AutomationTaskTable).where(eq(AutomationTaskTable.id, id)).get(),
  )
  if (!row) return null
  return updateTask(id, { enabled: !row.enabled })
}

export async function triggerRun(
  taskID: string,
): Promise<{ runID: string; status: string; error?: string }> {
  const row = Database.use((db) =>
    db.select().from(AutomationTaskTable).where(eq(AutomationTaskTable.id, taskID)).get(),
  )
  if (!row) return { runID: "", status: "failed", error: `Task not found: ${taskID}` }
  if (!row.enabled) return { runID: "", status: "skipped", error: "Task is disabled" }

  // Mark task as running for the duration of the kickoff phase. The
  // session-finish hook (markRunFinished) will roll status back to idle/error.
  Database.use((db) =>
    db
      .update(AutomationTaskTable)
      .set({ status: "running", time_updated: Date.now() })
      .where(eq(AutomationTaskTable.id, taskID))
      .run(),
  )

  const result = await executeRun(toTaskRow(row))

  // The runner returns synchronously after firing the orchestrator prompt —
  // its long-running phase (the orchestrator's session) lives on independently.
  // We only finalize the run row immediately if setup itself failed.
  if (result.status === "failed" || result.status === "skipped" || result.status === "timeout") {
    markRunFinished({ runID: result.runID, taskID, status: result.status, error: result.error })
  }

  void notify(
    `Automation: ${row.name}`,
    result.status === "running" || result.status === "completed"
      ? "Run started successfully"
      : `Run ${result.status}${result.error ? `: ${result.error}` : ""}`,
  ).catch(() => undefined)

  return { runID: result.runID, status: result.status, error: result.error }
}

export function listRuns(taskID?: string, limit = 20): AutomationRun[] {
  const q = Database.use((db) =>
    taskID
      ? db
          .select()
          .from(AutomationRunTable)
          .where(eq(AutomationRunTable.task_id, taskID))
          .orderBy(desc(AutomationRunTable.time_created))
          .limit(limit)
          .all()
      : db
          .select()
          .from(AutomationRunTable)
          .orderBy(desc(AutomationRunTable.time_created))
          .limit(limit)
          .all(),
  )
  return q
}

export function getRun(id: string): AutomationRun | undefined {
  return Database.use((db) =>
    db.select().from(AutomationRunTable).where(eq(AutomationRunTable.id, id)).get(),
  )
}

/** Public helper used by the session-finish hook to mark a run terminal.
 *  Mirror the runner's helper so callers don't reach into the runner module. */
export { markRunFinished, type AutomationTaskStatus }
