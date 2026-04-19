import { eq } from "drizzle-orm"
import { Database } from "../storage/db"
import { TaskExecutionTable, type TaskExecutionStatus } from "./scheduler.sql"
import { Log } from "../util/log"

const log = Log.create({ service: "runner" })

const MAX_RESULT = 10 * 1024
const DEFAULT_TIMEOUT = 30_000

export interface RunResult {
  status: "success" | "failed"
  output: string
  exitCode: number | null
}

function truncate(text: string): string {
  return text.slice(0, MAX_RESULT)
}

export async function run(command: string, taskId: string): Promise<RunResult> {
  const startedAt = Date.now()
  const executionId = crypto.randomUUID()

  Database.use((db) =>
    db
      .insert(TaskExecutionTable)
      .values({
        id: executionId,
        task_id: taskId,
        status: "running" as TaskExecutionStatus,
        started_at: startedAt,
      })
      .run(),
  )

  log.info("executing command", { taskId, command })

  const proc = Bun.spawn(["sh", "-c", command], {
    stdout: "pipe",
    stderr: "pipe",
  })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, DEFAULT_TIMEOUT)

  const exitCode = await proc.exited
  clearTimeout(timer)

  const finishedAt = Date.now()
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()

  if (timedOut) {
    const result = truncate(`Execution timed out after ${DEFAULT_TIMEOUT / 1000}s\n${stderr}`)
    Database.use((db) =>
      db
        .update(TaskExecutionTable)
        .set({ status: "failed", result, finished_at: finishedAt })
        .where(eq(TaskExecutionTable.id, executionId))
        .run(),
    )
    log.info("task timed out", { taskId })
    return { status: "failed", output: result, exitCode: null }
  }

  if (exitCode === 0) {
    const result = truncate(stdout)
    Database.use((db) =>
      db
        .update(TaskExecutionTable)
        .set({ status: "success", result, finished_at: finishedAt })
        .where(eq(TaskExecutionTable.id, executionId))
        .run(),
    )
    log.info("task succeeded", { taskId, exitCode })
    return { status: "success", output: result, exitCode }
  }

  const result = truncate(stderr) || truncate(stdout)
  Database.use((db) =>
    db
      .update(TaskExecutionTable)
      .set({ status: "failed", result, finished_at: finishedAt })
      .where(eq(TaskExecutionTable.id, executionId))
      .run(),
  )
  log.info("task failed", { taskId, exitCode })
  return { status: "failed", output: result, exitCode }
}
