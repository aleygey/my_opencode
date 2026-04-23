import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/session.sql"
import { Timestamps } from "../storage/schema.sql"

export type WorkflowStatus = "pending" | "running" | "paused" | "interrupted" | "completed" | "failed" | "cancelled"

/**
 * Structured summary for a workflow. Kept in sync with `Workflow.Summary` zod
 * schema in `workflow/index.ts`. Unknown keys are tolerated so existing rows
 * with free-form summary JSON still load.
 */
export type WorkflowSummary = {
  /** High-level objective shown at the top of the workflow panel. */
  objective?: string
  /** Plan steps rendered as badges. */
  plan?: Array<{
    label: string
    status?: "todo" | "doing" | "done" | "blocked"
    node_id?: string
  }>
  /** Free-form badge strings displayed inline. */
  badges?: string[]
  /** Agent-private scratchpad; UI does not guarantee rendering. */
  scratch?: Record<string, unknown>
  /** Tolerated unknown keys (matches zod `.loose()`). */
  [key: string]: unknown
}
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

/**
 * Declared input port on a node. The reducer decides how multiple upstream
 * contributions are merged when several edges feed the same port.
 *
 *  - `single`:            exactly one upstream is allowed (validation error otherwise)
 *  - `last_wins`:         later writes overwrite earlier ones
 *  - `array_concat`:      contributions are appended in upstream-completion order
 *  - `object_deep_merge`: structured merge of object-valued contributions
 *  - `custom`:            runtime looks up a named reducer (reserved, P4)
 */
export type WorkflowPortReducer = "single" | "last_wins" | "array_concat" | "object_deep_merge" | "custom"
export type WorkflowInputPort = {
  name: string
  reducer: WorkflowPortReducer
  required?: boolean
  /** Optional default when no upstream contributes and reducer allows it. */
  default?: unknown
  /** Free-form description surfaced in master prompts / UI. */
  description?: string
}
export type WorkflowOutputPort = {
  name: string
  description?: string
}

/** Lifecycle of a proposed graph edit transaction. */
export type WorkflowEditStatus = "pending" | "applied" | "rejected" | "superseded"

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
    /** Monotonic counter incremented by every committed graph edit
     *  (node or edge insert / modify / delete). Masters stamp
     *  `graph_rev_at_start` on nodes when they begin running so the runtime
     *  can detect upstream changes and mark downstream work stale. */
    graph_rev: integer().notNull().default(0),
    /** Hard cap on simultaneously-running nodes for this workflow. The P4
     *  scheduler consults this before promoting `ready` → `running`.
     *  Default 5 per agreed design. */
    max_concurrent_nodes: integer().notNull().default(5),
    config: text({ mode: "json" }).$type<Record<string, unknown>>(),
    summary: text({ mode: "json" }).$type<WorkflowSummary>(),
    /** Master-owned registry of exclusive resources currently held by
     *  running nodes: `{ [resource_key]: node_id }`. The runtime surfaces
     *  this for conflict detection but does NOT auto-lock — the master
     *  decides scheduling. */
    resources_held: text({ mode: "json" }).$type<Record<string, string>>(),
    /** Final structured result posted by `workflow_finalize` (P5). The
     *  runtime never writes this on its own; it only tracks completion. */
    result_json: text({ mode: "json" }).$type<Record<string, unknown>>(),
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
    /** Declared named inputs (with reducers). When absent the node is
     *  treated as an unstructured fan-in target (all upstream outputs
     *  available under an implicit `in` port). P3 reconciler validates
     *  that every incoming edge lands on a declared port. */
    input_ports: text({ mode: "json" }).$type<WorkflowInputPort[]>(),
    /** Declared named outputs. When absent the node is treated as having
     *  a single implicit `out` port. */
    output_ports: text({ mode: "json" }).$type<WorkflowOutputPort[]>(),
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
    /** Snapshot of the inputs the node actually consumed at the moment it
     *  transitioned to `running` — keyed by input port. Used to detect
     *  upstream-changed-since-start and to support deterministic replay. */
    consumed_inputs: text({ mode: "json" }).$type<Record<string, unknown>>(),
    /** True when an upstream change invalidates this node's result. The
     *  runtime flips this during reconcile; the master decides whether to
     *  rerun, accept, or discard. Stored as 0/1 integer (SQLite boolean). */
    stale: integer().notNull().default(0),
    /** `workflow.graph_rev` observed when this node started running.
     *  Comparing against the current `graph_rev` tells us whether
     *  upstream mutations could have invalidated `consumed_inputs`. */
    graph_rev_at_start: integer(),
    /** Scheduling priority (higher runs first among ready nodes). */
    priority: integer().notNull().default(0),
    /** Exclusive resource keys the node wants to acquire before running
     *  (e.g. `["repo:packages/app"]`). The master uses these plus
     *  `workflow.resources_held` to schedule around conflicts. */
    holds_resources: text({ mode: "json" }).$type<string[]>(),
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
    /** Outbound port on the producer. Defaults to the implicit `out` port
     *  at read time when null. */
    from_port: text(),
    /** Inbound port on the consumer. Defaults to the implicit `in` port
     *  at read time when null. */
    to_port: text(),
    /** When 1, the downstream node cannot be promoted to `ready` until
     *  this edge has produced a value. When 0, the edge is advisory
     *  (reducer may accept missing contributions). Stored as 0/1 integer. */
    required: integer().notNull().default(1),
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

/**
 * Proposed-then-applied transactions for graph edits (P3). Each row captures
 * one multi-op edit: the proposer, the ops array, the `graph_rev` the edit
 * was planned against, and the final disposition. The table is append-only;
 * `status` transitions `pending → applied | rejected | superseded` in place.
 *
 * `ops` is an array of discriminated union entries — `INSERT_NODE`,
 * `REPLACE_NODE`, `MODIFY_NODE`, `INSERT_EDGE`, `DELETE_EDGE`, `DELETE_NODE`.
 * The concrete zod schema lives in `workflow/index.ts` and is intentionally
 * the only contract for op shape — schema here is kept untyped JSON so
 * future op kinds don't require a migration.
 */
export const WorkflowEditTable = sqliteTable(
  "workflow_edit",
  {
    id: text().primaryKey(),
    workflow_id: text()
      .notNull()
      .references(() => WorkflowTable.id, { onDelete: "cascade" }),
    /** The master session that proposed this edit. Nullable because
     *  runtime-originated reconciliation edits are also allowed. */
    proposer_session_id: text().references(() => SessionTable.id, { onDelete: "set null" }),
    /** Discriminated-union ops array; see workflow/index.ts `EditOp`. */
    ops: text({ mode: "json" }).notNull().$type<unknown[]>(),
    status: text().notNull().$type<WorkflowEditStatus>(),
    /** Human-readable rationale from the proposer. */
    reason: text(),
    /** Populated when `status === "rejected"`. */
    reject_reason: text(),
    /** `workflow.graph_rev` at propose-time; optimistic-concurrency guard. */
    graph_rev_before: integer().notNull(),
    /** `workflow.graph_rev` after apply; null for pending / rejected. */
    graph_rev_after: integer(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
    time_applied: integer(),
  },
  (table) => [
    index("workflow_edit_workflow_idx").on(table.workflow_id),
    index("workflow_edit_status_idx").on(table.status),
  ],
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
