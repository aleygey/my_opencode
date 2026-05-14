import { Database, eq, and, desc } from "../storage"
import {
  AutomationRunTable,
  AutomationTaskTable,
  type AutomationRunStatus,
  type AutomationTaskType,
} from "./automation.sql"
import { Log } from "../util"
import { Instance } from "../project/instance"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { AppRuntime } from "@/effect/app-runtime"
import { BootstrapRuntime } from "@/effect/bootstrap-runtime"
import { Worktree } from "@/worktree"
import { Identifier } from "@/id/id"
import { Effect } from "effect"
import { InstanceBootstrap } from "@/project/bootstrap"

const log = Log.create({ service: "automation-runner" })

/** Stable id-prefix helpers — keep them named exports so callers can build
 *  consistent ids without re-importing Identifier. */
export const runID = () => `atr_${Identifier.create("workspace", "ascending").slice(4)}`
export const automationID = () => `atm_${Identifier.create("workspace", "ascending").slice(4)}`

export type TaskRow = {
  id: string
  name: string
  type: AutomationTaskType
  expression: string
  prompt: string
  agent: string
  model?: { providerID?: string; modelID?: string; variant?: string } | null
  worktree_prefix?: string | null
}

export type RunOptions = {
  /** Override the worktree prefix for this run only. */
  worktreePrefix?: string
}

export type RunResult = {
  runID: string
  sessionID: string
  worktreeName?: string
  worktreeDirectory?: string
  worktreeBranch?: string
  status: AutomationRunStatus
  error?: string
}

function pruneRunHistory(taskID: string, max: number) {
  if (max <= 0) return
  const rows = Database.use((db) =>
    db
      .select({ id: AutomationRunTable.id })
      .from(AutomationRunTable)
      .where(eq(AutomationRunTable.task_id, taskID))
      .orderBy(desc(AutomationRunTable.time_created))
      .all(),
  )
  if (rows.length <= max) return
  const toDelete = rows.slice(max).map((r) => r.id)
  for (const id of toDelete) {
    Database.use((db) => db.delete(AutomationRunTable).where(eq(AutomationRunTable.id, id)).run())
  }
  log.info("pruned automation run history", { taskID, removed: toDelete.length })
}

/** Run a single fire of a scheduled task. Creates a fresh worktree, bootstraps
 *  an instance inside it, opens a session, and dispatches the orchestrator
 *  prompt. Returns a `running` status on a clean handoff — the orchestrator's
 *  own lifecycle is responsible for marking the run `completed` / `failed`
 *  via the session-finish hook (see `markRunFinished` below). */
export async function executeRun(task: TaskRow, opts: RunOptions = {}): Promise<RunResult> {
  const id = runID()
  const now = Date.now()

  // P0: concurrent guard. Only one running run per task at a time — second
  // firings get marked skipped with a clear message in the history.
  const hasConflict = Database.use((db) =>
    db
      .select({ id: AutomationRunTable.id })
      .from(AutomationRunTable)
      .where(and(eq(AutomationRunTable.task_id, task.id), eq(AutomationRunTable.status, "running")))
      .get(),
  )
  if (hasConflict) {
    Database.use((db) =>
      db
        .insert(AutomationRunTable)
        .values({
          id,
          task_id: task.id,
          status: "skipped",
          error_message: "Another run is already in progress for this task",
          started_at: now,
          finished_at: now,
          time_created: now,
          time_updated: now,
        })
        .run(),
    )
    log.info("automation run skipped (concurrent)", { id, taskID: task.id })
    return { runID: id, sessionID: "", status: "skipped", error: "Another run is already in progress" }
  }

  Database.use((db) =>
    db
      .insert(AutomationRunTable)
      .values({
        id,
        task_id: task.id,
        status: "running",
        started_at: now,
        time_created: now,
        time_updated: now,
      })
      .run(),
  )

  try {
    const rawPrefix = opts.worktreePrefix ?? task.worktree_prefix ?? task.name
    const slug = rawPrefix
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "automation"

    log.info("creating worktree for automation run", { id, slug })

    const wtInfo = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const wt = yield* Worktree.Service
        return yield* wt.create({ name: slug })
      }),
    )

    Database.use((db) =>
      db
        .update(AutomationRunTable)
        .set({
          worktree_name: wtInfo.name,
          worktree_directory: wtInfo.directory,
          worktree_branch: wtInfo.branch,
          time_updated: Date.now(),
        })
        .where(eq(AutomationRunTable.id, id))
        .run(),
    )

    log.info("bootstrapping instance in worktree", { id, directory: wtInfo.directory })

    await Instance.provide({
      directory: wtInfo.directory,
      init: () => BootstrapRuntime.runPromise(InstanceBootstrap),
      fn: async () => {
        // no-op — just bootstrap the instance
      },
    })

    log.info("creating session in worktree", { id, directory: wtInfo.directory })

    const sessionResult = await Instance.provide({
      directory: wtInfo.directory,
      fn: async () => {
        return AppRuntime.runPromise(
          Effect.gen(function* () {
            const s = yield* Session.Service
            return yield* s.create({ title: `Automation: ${task.name}` })
          }),
        )
      },
    })

    const sessionID = sessionResult.id

    Database.use((db) =>
      db
        .update(AutomationRunTable)
        .set({ session_id: sessionID, time_updated: Date.now() })
        .where(eq(AutomationRunTable.id, id))
        .run(),
    )

    log.info("sending prompt to orchestrator", { id, sessionID, agent: task.agent })

    await Instance.provide({
      directory: wtInfo.directory,
      fn: async () => {
        await AppRuntime.runPromise(
          Effect.gen(function* () {
            const sp = yield* SessionPrompt.Service
            return yield* sp.prompt({
              sessionID: SessionID.make(sessionID),
              agent: task.agent || "orchestrator",
              parts: [{ type: "text" as const, text: task.prompt }],
            })
          }),
        )
      },
    })

    log.info("automation run launched", { id, sessionID, worktreeName: wtInfo.name })

    return {
      runID: id,
      sessionID,
      worktreeName: wtInfo.name,
      worktreeDirectory: wtInfo.directory,
      worktreeBranch: wtInfo.branch,
      status: "running",
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error("automation run failed during setup", { id, error: message })
    Database.use((db) =>
      db
        .update(AutomationRunTable)
        .set({
          status: "failed",
          error_message: message.slice(0, 4096),
          finished_at: Date.now(),
          time_updated: Date.now(),
        })
        .where(eq(AutomationRunTable.id, id))
        .run(),
    )
    return { runID: id, sessionID: "", status: "failed", error: message }
  } finally {
    // Best-effort retention pruning. Failures here are non-fatal — the
    // run already landed in the table.
    try {
      const taskRow = Database.use((db) =>
        db.select().from(AutomationTaskTable).where(eq(AutomationTaskTable.id, task.id)).get(),
      )
      if (taskRow) pruneRunHistory(task.id, taskRow.max_retention)
    } catch (e) {
      log.warn("pruneRunHistory failed", { taskID: task.id, error: String(e) })
    }
  }
}

/** Update the run row (called by the session-finish hook in `api.ts`) so the
 *  history reflects the actual outcome rather than staying stuck at `running`
 *  forever. Also rolls the task's `status` + `consecutive_failures`. */
export function markRunFinished(input: {
  runID: string
  taskID: string
  status: Exclude<AutomationRunStatus, "running">
  error?: string
}) {
  const finishedAt = Date.now()
  Database.use((db) =>
    db
      .update(AutomationRunTable)
      .set({
        status: input.status,
        error_message: input.error ? input.error.slice(0, 4096) : null,
        finished_at: finishedAt,
        time_updated: finishedAt,
      })
      .where(eq(AutomationRunTable.id, input.runID))
      .run(),
  )

  Database.transaction((tx) => {
    const task = tx.select().from(AutomationTaskTable).where(eq(AutomationTaskTable.id, input.taskID)).get()
    if (!task) return

    if (input.status === "completed") {
      tx.update(AutomationTaskTable)
        .set({
          status: "idle",
          last_run_at: finishedAt,
          error_message: null,
          consecutive_failures: 0,
          time_updated: finishedAt,
        })
        .where(eq(AutomationTaskTable.id, input.taskID))
        .run()
      return
    }

    // Failure (failed / timeout). Increment the counter and trip the circuit
    // breaker by auto-disabling the task once it reaches the threshold.
    if (input.status === "failed" || input.status === "timeout") {
      const next = task.consecutive_failures + 1
      const shouldDisable = next >= task.max_consecutive_failures && task.max_consecutive_failures > 0
      tx.update(AutomationTaskTable)
        .set({
          status: shouldDisable ? "disabled" : "error",
          enabled: shouldDisable ? false : task.enabled,
          last_run_at: finishedAt,
          error_message: input.error ? input.error.slice(0, 4096) : null,
          consecutive_failures: next,
          time_updated: finishedAt,
        })
        .where(eq(AutomationTaskTable.id, input.taskID))
        .run()
      return
    }

    // "skipped" — concurrency conflict; don't churn task status.
    tx.update(AutomationTaskTable)
      .set({ time_updated: finishedAt })
      .where(eq(AutomationTaskTable.id, input.taskID))
      .run()
  })
}

export async function cleanupWorktree(directory: string) {
  try {
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        const wt = yield* Worktree.Service
        return yield* wt.remove({ directory })
      }),
    )
    log.info("worktree cleaned up", { directory })
  } catch (err) {
    log.error("worktree cleanup failed", { directory, error: String(err) })
  }
}
