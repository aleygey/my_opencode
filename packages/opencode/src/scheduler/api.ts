import { eq } from "drizzle-orm"
import { Database } from "../storage/db"
import { ScheduledTaskTable, type TaskType } from "./scheduler.sql"
import type { Scheduler } from "./scheduler"

type TaskRow = typeof ScheduledTaskTable.$inferSelect
type TaskInsert = typeof ScheduledTaskTable.$inferInsert

export type CreateInput = {
  id: string
  name: string
  type: TaskType
  expression: string
  command: string
  enabled?: boolean
}

export type UpdateInput = {
  name?: string
  type?: TaskType
  expression?: string
  command?: string
  enabled?: boolean
}

export function create(scheduler: Scheduler, input: CreateInput): TaskRow {
  const now = Date.now()
  const row: TaskInsert = {
    id: input.id,
    name: input.name,
    type: input.type,
    expression: input.expression,
    command: input.command,
    enabled: input.enabled ?? true,
    time_created: now,
    time_updated: now,
  }
  Database.use((db) => db.insert(ScheduledTaskTable).values(row).run())
  if (row.enabled) {
    scheduler.register({ id: row.id, type: row.type, expression: row.expression, command: row.command })
  }
  return Database.use((db) => db.select().from(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, input.id)).get())!
}

export function remove(scheduler: Scheduler, id: string): boolean {
  const row = Database.use((db) => db.select().from(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, id)).get())
  if (!row) return false
  if (row.enabled) scheduler.unregister(id)
  Database.use((db) => db.delete(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, id)).run())
  return true
}

export function update(scheduler: Scheduler, id: string, input: UpdateInput): TaskRow | null {
  const row = Database.use((db) => db.select().from(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, id)).get())
  if (!row) return null

  const expressionChanged = input.expression !== undefined && input.expression !== row.expression
  const typeChanged = input.type !== undefined && input.type !== row.type
  const needsReregister = expressionChanged || typeChanged

  const updates: Record<string, unknown> = { time_updated: Date.now() }
  if (input.name !== undefined) updates.name = input.name
  if (input.type !== undefined) updates.type = input.type
  if (input.expression !== undefined) updates.expression = input.expression
  if (input.command !== undefined) updates.command = input.command
  if (input.enabled !== undefined) updates.enabled = input.enabled

  Database.use((db) => db.update(ScheduledTaskTable).set(updates).where(eq(ScheduledTaskTable.id, id)).run())

  // Re-register if the task should now be active in the scheduler
  const disabling = input.enabled === false
  if (row.enabled && (needsReregister || disabling)) scheduler.unregister(id)

  // After DB update, sync scheduler registration if task is enabled
  const updated = Database.use((db) => db.select().from(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, id)).get())!
  if (updated.enabled)
    scheduler.register({ id: updated.id, type: updated.type, expression: updated.expression, command: updated.command })

  return updated
}

export function list(): TaskRow[] {
  return Database.use((db) => db.select().from(ScheduledTaskTable).all())
}

export function get(id: string): TaskRow | undefined {
  return Database.use((db) => db.select().from(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, id)).get())
}

export function toggle(scheduler: Scheduler, id: string): TaskRow | null {
  const row = Database.use((db) => db.select().from(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, id)).get())
  if (!row) return null

  const nowEnabled = !row.enabled
  if (nowEnabled) {
    scheduler.register({ id: row.id, type: row.type, expression: row.expression, command: row.command })
  } else {
    scheduler.unregister(id)
  }

  Database.use((db) =>
    db
      .update(ScheduledTaskTable)
      .set({ enabled: nowEnabled, time_updated: Date.now() })
      .where(eq(ScheduledTaskTable.id, id))
      .run(),
  )
  return Database.use((db) => db.select().from(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, id)).get())!
}
