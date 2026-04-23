import { Cron } from "croner"
import { eq } from "drizzle-orm"
import { Database } from "../storage"
import { ScheduledTaskTable, TaskExecutionTable, type TaskType, type TaskExecutionStatus } from "./scheduler.sql"
import { Log } from "../util"

const log = Log.create({ service: "scheduler" })

type Interval = ReturnType<typeof setInterval>

export interface Scheduler {
  register(task: { id: string; type: TaskType; expression: string; command: string }): void
  unregister(id: string): void
  start(): void
  stop(): void
}

type Registered = {
  id: string
  type: TaskType
  expression: string
  command: string
  handle: Cron | Interval | null
}

async function execute(id: string, command: string) {
  const startedAt = Date.now()
  log.info("executing task", { id, command })
  try {
    const proc = Bun.spawn(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" })
    const code = await proc.exited
    const finishedAt = Date.now()
    const status: TaskExecutionStatus = code === 0 ? "success" : "failed"
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const result = [stdout, stderr].filter(Boolean).join("\n").slice(0, 4096) || null
    Database.use((db) =>
      db.insert(TaskExecutionTable).values({
        id: crypto.randomUUID(),
        task_id: id,
        status,
        result,
        started_at: startedAt,
        finished_at: finishedAt,
      }),
    )
    log.info("task completed", { id, status })
  } catch (err) {
    const finishedAt = Date.now()
    log.warn("task execution error", { id, error: String(err) })
    Database.use((db) =>
      db.insert(TaskExecutionTable).values({
        id: crypto.randomUUID(),
        task_id: id,
        status: "failed" as TaskExecutionStatus,
        result: String(err).slice(0, 4096),
        started_at: startedAt,
        finished_at: finishedAt,
      }),
    )
  }
}

export function create(): Scheduler {
  const tasks = new Map<string, Registered>()
  let tickTimer: Interval | null = null

  function register(task: { id: string; type: TaskType; expression: string; command: string }) {
    if (tasks.has(task.id)) return
    const entry: Registered = { ...task, handle: null }

    if (task.type === "cron") {
      entry.handle = new Cron(task.expression)
    } else {
      const ms = parseInt(task.expression, 10)
      if (isNaN(ms) || ms <= 0) throw new Error(`invalid interval expression: ${task.expression}`)
      entry.handle = setInterval(() => execute(task.id, task.command), ms)
    }

    tasks.set(task.id, entry)
    log.info("registered task", { id: task.id, type: task.type })
  }

  function unregister(id: string) {
    const entry = tasks.get(id)
    if (!entry) return

    if (entry.type === "cron" && entry.handle instanceof Cron) {
      entry.handle.stop()
    } else if (entry.handle !== null && !(entry.handle instanceof Cron)) {
      clearInterval(entry.handle)
    }

    tasks.delete(id)
    log.info("unregistered task", { id })
  }

  function tick() {
    const now = new Date()
    for (const task of tasks.values()) {
      if (task.type !== "cron") continue
      if (!(task.handle instanceof Cron)) continue
      if (task.handle.isRunning()) continue
      if (task.handle.match(now)) execute(task.id, task.command)
    }
  }

  function start() {
    const rows = Database.use((db) =>
      db.select().from(ScheduledTaskTable).where(eq(ScheduledTaskTable.enabled, true)).all(),
    )
    for (const row of rows) {
      register({ id: row.id, type: row.type, expression: row.expression, command: row.command })
    }
    tickTimer = setInterval(tick, 60_000)
    log.info("scheduler started", { taskCount: rows.length })
  }

  function stop() {
    if (tickTimer !== null) {
      clearInterval(tickTimer)
      tickTimer = null
    }
    for (const task of tasks.values()) {
      if (task.type === "cron" && task.handle instanceof Cron) {
        task.handle.stop()
      } else if (task.handle !== null && !(task.handle instanceof Cron)) {
        clearInterval(task.handle)
      }
    }
    tasks.clear()
    log.info("scheduler stopped")
  }

  return { register, unregister, start, stop }
}
