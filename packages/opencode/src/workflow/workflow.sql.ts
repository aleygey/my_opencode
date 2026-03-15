import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/session.sql"
import { Timestamps } from "../storage/schema.sql"

export type WorkflowStatus = "pending" | "running" | "paused" | "interrupted" | "completed" | "failed" | "cancelled"
export type WorkflowNodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "waiting"
  | "paused"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled"
export type WorkflowNodeResultStatus = "unknown" | "success" | "fail" | "partial"
export type WorkflowCheckpointStatus = "pending" | "passed" | "failed" | "skipped"

export const WorkflowTable = sqliteTable(
  "workflow",
  {
    id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    title: text().notNull(),
    status: text().notNull().$type<WorkflowStatus>(),
    current_node_id: text(),
    selected_node_id: text(),
    version: integer().notNull().default(0),
    config: text({ mode: "json" }).$type<Record<string, unknown>>(),
    summary: text({ mode: "json" }).$type<Record<string, unknown>>(),
    time_paused: integer(),
    time_completed: integer(),
    ...Timestamps,
  },
  (table) => [index("workflow_session_idx").on(table.session_id)],
)

export const WorkflowNodeTable = sqliteTable(
  "workflow_node",
  {
    id: text().primaryKey(),
    workflow_id: text()
      .notNull()
      .references(() => WorkflowTable.id, { onDelete: "cascade" }),
    session_id: text().references(() => SessionTable.id, { onDelete: "set null" }),
    title: text().notNull(),
    agent: text().notNull(),
    model: text({ mode: "json" }).$type<{
      providerID?: string
      modelID?: string
      variant?: string
    }>(),
    config: text({ mode: "json" }).$type<Record<string, unknown>>(),
    status: text().notNull().$type<WorkflowNodeStatus>(),
    result_status: text().notNull().$type<WorkflowNodeResultStatus>(),
    fail_reason: text(),
    action_count: integer().notNull().default(0),
    attempt: integer().notNull().default(0),
    max_attempts: integer().notNull().default(1),
    max_actions: integer().notNull().default(20),
    version: integer().notNull().default(0),
    state_json: text({ mode: "json" }).$type<Record<string, unknown>>(),
    result_json: text({ mode: "json" }).$type<Record<string, unknown>>(),
    position: integer().notNull().default(0),
    time_started: integer(),
    time_completed: integer(),
    ...Timestamps,
  },
  (table) => [
    index("workflow_node_workflow_idx").on(table.workflow_id),
    index("workflow_node_session_idx").on(table.session_id),
  ],
)

export const WorkflowEdgeTable = sqliteTable(
  "workflow_edge",
  {
    id: text().primaryKey(),
    workflow_id: text()
      .notNull()
      .references(() => WorkflowTable.id, { onDelete: "cascade" }),
    from_node_id: text()
      .notNull()
      .references(() => WorkflowNodeTable.id, { onDelete: "cascade" }),
    to_node_id: text()
      .notNull()
      .references(() => WorkflowNodeTable.id, { onDelete: "cascade" }),
    label: text(),
    config: text({ mode: "json" }).$type<Record<string, unknown>>(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("workflow_edge_workflow_idx").on(table.workflow_id),
    index("workflow_edge_from_idx").on(table.from_node_id),
    index("workflow_edge_to_idx").on(table.to_node_id),
  ],
)

export const WorkflowCheckpointTable = sqliteTable(
  "workflow_checkpoint",
  {
    id: text().primaryKey(),
    workflow_id: text()
      .notNull()
      .references(() => WorkflowTable.id, { onDelete: "cascade" }),
    node_id: text()
      .notNull()
      .references(() => WorkflowNodeTable.id, { onDelete: "cascade" }),
    label: text().notNull(),
    status: text().notNull().$type<WorkflowCheckpointStatus>(),
    config: text({ mode: "json" }).$type<Record<string, unknown>>(),
    result_json: text({ mode: "json" }).$type<Record<string, unknown>>(),
    ...Timestamps,
  },
  (table) => [index("workflow_checkpoint_workflow_idx").on(table.workflow_id), index("workflow_checkpoint_node_idx").on(table.node_id)],
)

export const WorkflowEventTable = sqliteTable(
  "workflow_event",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    workflow_id: text()
      .notNull()
      .references(() => WorkflowTable.id, { onDelete: "cascade" }),
    node_id: text().references(() => WorkflowNodeTable.id, { onDelete: "cascade" }),
    session_id: text().references(() => SessionTable.id, { onDelete: "set null" }),
    target_node_id: text().references(() => WorkflowNodeTable.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    source: text().notNull(),
    payload: text({ mode: "json" }).notNull().$type<Record<string, unknown>>(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("workflow_event_workflow_idx").on(table.workflow_id),
    index("workflow_event_node_idx").on(table.node_id),
    index("workflow_event_target_idx").on(table.target_node_id),
  ],
)
