import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"

export type TaskType = "cron" | "interval"
export type TaskExecutionStatus = "running" | "success" | "failed"

export const ScheduledTaskTable = sqliteTable(
  "scheduled_task",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    type: text().notNull().$type<TaskType>(),
    expression: text().notNull(),
    command: text().notNull(),
    enabled: integer({ mode: "boolean" }).notNull().default(true),
    ...Timestamps,
  },
  (table) => [index("scheduled_task_type_idx").on(table.type)],
)

export const TaskExecutionTable = sqliteTable(
  "task_execution",
  {
    id: text().primaryKey(),
    task_id: text()
      .notNull()
      .references(() => ScheduledTaskTable.id, { onDelete: "cascade" }),
    status: text().notNull().$type<TaskExecutionStatus>(),
    result: text(),
    started_at: integer().notNull(),
    finished_at: integer(),
    ...Timestamps,
  },
  (table) => [index("task_execution_task_idx").on(table.task_id)],
)

export type ScheduledTask = typeof ScheduledTaskTable.$inferInsert
export type TaskExecution = typeof TaskExecutionTable.$inferInsert
