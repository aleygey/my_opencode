import { Cron } from "croner"
import { Database, eq } from "../storage"
import { AutomationTaskTable, type AutomationTaskType } from "./automation.sql"
import { triggerRun, setOnChange } from "./api"
import { Log } from "../util"

const log = Log.create({ service: "automation-scheduler" })

type IntervalHandle = ReturnType<typeof setInterval>

type Registered = {
  id: string
  type: AutomationTaskType
  expression: string
  handle: Cron | IntervalHandle | null
}

export interface AutomationScheduler {
  register(task: { id: string; type: AutomationTaskType; expression: string }): void
  unregister(id: string): void
  start(): void
  stop(): void
  isStarted(): boolean
}

/** Build a fresh scheduler. The instance is process-wide — there should only
 *  ever be ONE running scheduler per opencode process; multiple would race
 *  on `triggerRun()` and produce duplicate runs. */
export function create(): AutomationScheduler {
  const tasks = new Map<string, Registered>()
  let started = false

  function fire(taskID: string) {
    log.info("automation trigger fired", { taskID })
    void triggerRun(taskID)
      .then((result) => log.info("automation trigger completed", { taskID, status: result.status }))
      .catch((err) => log.error("automation trigger error", { taskID, error: String(err) }))
  }

  function unregister(id: string) {
    const entry = tasks.get(id)
    if (!entry) return
    if (entry.handle instanceof Cron) {
      entry.handle.stop()
    } else if (entry.handle !== null) {
      clearInterval(entry.handle)
    }
    tasks.delete(id)
    log.info("unregistered automation task", { id })
  }

  function register(task: { id: string; type: AutomationTaskType; expression: string }) {
    if (tasks.has(task.id)) unregister(task.id)

    const entry: Registered = { ...task, handle: null }

    if (task.type === "cron") {
      try {
        entry.handle = new Cron(task.expression, () => fire(task.id))
      } catch (err) {
        log.warn("failed to register cron task", { id: task.id, error: String(err) })
        return
      }
    } else {
      const ms = parseInt(task.expression, 10)
      if (isNaN(ms) || ms <= 0) {
        log.warn("invalid interval expression — skipping", { id: task.id, expression: task.expression })
        return
      }
      entry.handle = setInterval(() => fire(task.id), ms)
    }

    tasks.set(task.id, entry)
    log.info("registered automation task", { id: task.id, type: task.type, expression: task.expression })
  }

  function start() {
    if (started) {
      log.warn("automation scheduler already started — start() is a no-op")
      return
    }
    started = true

    // Load all enabled tasks from disk and schedule them.
    const rows = Database.use((db) =>
      db.select().from(AutomationTaskTable).where(eq(AutomationTaskTable.enabled, true)).all(),
    )
    for (const row of rows) {
      register({ id: row.id, type: row.type, expression: row.expression })
    }

    // Keep registrations in lock-step with the task table — any
    // create / update / delete via the API triggers a re-register here so
    // the user doesn't need to restart the process to pick up changes.
    setOnChange((event) => {
      if (event.kind === "deleted") {
        unregister(event.id)
        return
      }
      if (event.kind === "created" && event.task && event.task.enabled) {
        register({ id: event.task.id, type: event.task.type, expression: event.task.expression })
        return
      }
      if (event.kind === "updated" && event.task) {
        unregister(event.task.id)
        if (event.task.enabled) {
          register({ id: event.task.id, type: event.task.type, expression: event.task.expression })
        }
      }
    })

    log.info("automation scheduler started", { taskCount: rows.length })
  }

  function stop() {
    setOnChange(null)
    for (const entry of tasks.values()) {
      if (entry.handle instanceof Cron) {
        entry.handle.stop()
      } else if (entry.handle !== null) {
        clearInterval(entry.handle)
      }
    }
    tasks.clear()
    started = false
    log.info("automation scheduler stopped")
  }

  return { register, unregister, start, stop, isStarted: () => started }
}
