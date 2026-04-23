import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Database, NotFoundError, eq, desc, asc, and, inArray, gt, sql } from "@/storage"
import { notInArray } from "drizzle-orm"
import { Effect } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { Identifier } from "@/id/id"
import { Instance } from "@/project/instance"
import { Log } from "@/util"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { fn } from "@/util/fn"
import z from "zod"
import {
  WorkflowCheckpointTable,
  WorkflowEdgeTable,
  WorkflowEditTable,
  WorkflowEventTable,
  WorkflowNodeTable,
  WorkflowTable,
  type WorkflowCheckpointStatus,
  type WorkflowEditStatus,
  type WorkflowInputPort,
  type WorkflowNodeResultStatus,
  type WorkflowNodeStatus,
  type WorkflowOutputPort,
  type WorkflowPortReducer,
  type WorkflowStatus,
  type WorkflowSummary,
} from "./workflow.sql"

const log = Log.create({ service: "workflow" })

// Local shim for the previous `Instance.state(init, cleanup)` API that
// returned a lazy, per-directory state. The upstream API was removed, but
// this module still uses it for module-scope subscriptions. Cleanup runs
// best-effort on process exit.
function instanceState<T>(init: () => T, cleanup: (entry: T) => void | Promise<void>) {
  const cache = new Map<string, T>()
  let registered = false
  return () => {
    const dir = Instance.directory
    let entry = cache.get(dir)
    if (!entry) {
      entry = init()
      cache.set(dir, entry)
      if (!registered) {
        registered = true
        process.on("beforeExit", () => {
          for (const e of cache.values()) {
            try {
              void cleanup(e)
            } catch {}
          }
          cache.clear()
        })
      }
    }
    return entry
  }
}

const workflowID = () => `wfl_${Identifier.create("workspace", "ascending").slice(4)}`
const nodeID = () => `wfn_${Identifier.create("workspace", "ascending").slice(4)}`
const edgeID = () => `wfe_${Identifier.create("workspace", "ascending").slice(4)}`
const checkpointID = () => `wfc_${Identifier.create("workspace", "ascending").slice(4)}`

const WorkflowStatus = z.enum(["pending", "running", "paused", "interrupted", "completed", "failed", "cancelled"])
const WorkflowNodeStatus = z.enum([
  "pending",
  "ready",
  "running",
  "waiting",
  "paused",
  "interrupted",
  "completed",
  "failed",
  "cancelled",
])
const WorkflowNodeResultStatus = z.enum(["unknown", "success", "fail", "partial"])
const WorkflowCheckpointStatus = z.enum(["pending", "passed", "failed", "skipped"])

// P1 — dynamic graph primitives. Port reducers govern how multiple upstream
// contributions fan into the same named input. `single` = exactly one allowed.
const WorkflowPortReducer = z.enum(["single", "last_wins", "array_concat", "object_deep_merge", "custom"])
const WorkflowInputPortSchema = z
  .object({
    name: z.string().min(1),
    reducer: WorkflowPortReducer,
    required: z.boolean().optional(),
    default: z.any().optional(),
    description: z.string().optional(),
  })
  .meta({ ref: "WorkflowInputPort" })
const WorkflowOutputPortSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
  })
  .meta({ ref: "WorkflowOutputPort" })

// Lifecycle of a proposed graph edit transaction (P3 `workflow_edit` row).
const WorkflowEditStatus = z.enum(["pending", "applied", "rejected", "superseded"])

// Canonical event-kind taxonomy. All runtime writes MUST use one of these.
// Slaves may still pass a free-form `event_kind` via workflow_update, in which
// case we coerce unknown values to `custom.<kind>` and bucket them as "ui"
// audience so they don't wake the orchestrator by accident.
const WorkflowEventKind = z.enum([
  // Workflow lifecycle
  "workflow.created",
  "workflow.updated",
  "workflow.orchestrator_woken",
  "workflow.orchestrator_wake_queued",
  "workflow.orchestrator_wake_requested",
  // Node lifecycle
  "node.created",
  "node.started",
  "node.updated",
  "node.completed",
  "node.failed",
  "node.paused",
  "node.aborted",
  "node.interrupted",
  "node.cancelled",
  "node.stalled",
  // Node state signals the orchestrator must react to
  "node.waiting",
  "node.blocked",
  "node.transition_rejected",
  "node.input_missing",
  "node.output_invalid",
  // Node attempt / action accounting
  "node.attempt_reported",
  "node.action",
  "node.action_limit_reached",
  "node.attempt_limit_reached",
  // Node ↔ orchestrator control channel
  "node.control",
  "node.pulled",
  "node.command_acked",
  "node.command_timeout",
  // P3 #15 — node or workflow has breached a configured budget limit.
  // Logged but NOT auto-aborted; the orchestrator decides how to react.
  "node.budget_exceeded",
  // Needs (P1.3)
  "node.need_opened",
  "node.need_fulfilled",
  "node.need_resolved",
  // Node runtime telemetry (UI audience)
  "node.runtime.tool_running",
  "node.runtime.tool_completed",
  "node.runtime.tool_failed",
  "node.runtime.skill_loaded",
  "node.runtime.subtask_requested",
  "node.runtime.subtask_started",
  "node.runtime.subtask_completed",
  "node.runtime.subtask_failed",
  // Edge
  "edge.created",
  "edge.updated",
  "edge.deleted",
  // P2 — invariant rejection. Emitted when the runtime refuses an edge
  // insert because it would violate DAG invariants (self-loop, cross-workflow,
  // missing endpoint, or cycle). Master uses these to unwind a speculative
  // propose and surface the rejection reason back to the proposer.
  "edge.rejected",
  // Checkpoint
  "checkpoint.created",
  "checkpoint.passed",
  "checkpoint.failed",
  "checkpoint.pending",
  "checkpoint.skipped",
])
type WorkflowEventKind = z.infer<typeof WorkflowEventKind>

const WorkflowEventAudience = z.enum(["orchestrator", "ui", "both"])
type WorkflowEventAudience = z.infer<typeof WorkflowEventAudience>

/** Bucket events by who should see them.
 *  - `orchestrator`: only master / runtime consumers (internal wake signals)
 *  - `ui`: display-only telemetry; master should NOT read these
 *  - `both`: life-cycle + decision-relevant events
 */
function audienceOf(kind: string): WorkflowEventAudience {
  if (kind.startsWith("node.runtime.")) return "ui"
  if (kind === "node.action") return "ui"
  if (kind === "node.pulled") return "ui"
  if (kind.startsWith("workflow.orchestrator_")) return "orchestrator"
  if (kind.startsWith("custom.")) return "ui"
  return "both"
}

/** Coerce a slave-supplied kind into a canonical string.
 *  Unknown kinds are namespaced under `custom.` so they never accidentally
 *  match an orchestrator trigger. Returns the coerced kind + whether it was
 *  known — callers may want to log unknowns. */
function coerceEventKind(raw: string): { kind: string; known: boolean } {
  const ok = WorkflowEventKind.safeParse(raw)
  if (ok.success) return { kind: ok.data, known: true }
  // Already namespaced? keep as-is.
  if (raw.startsWith("custom.")) return { kind: raw, known: false }
  return { kind: `custom.${raw}`, known: false }
}

/** Legal node status transitions. `source === "runtime"` bypasses this —
 *  runtime stalls / limit-reached handlers need to force terminal states
 *  even from atypical starts. Same-state transitions are always a no-op
 *  (handled separately). */
const NODE_TRANSITIONS: Record<WorkflowNodeStatus, ReadonlySet<WorkflowNodeStatus>> = {
  pending: new Set(["ready", "running", "waiting", "cancelled", "failed"]),
  ready: new Set(["running", "waiting", "cancelled", "failed"]),
  running: new Set(["waiting", "paused", "interrupted", "completed", "failed", "cancelled"]),
  waiting: new Set(["running", "paused", "interrupted", "cancelled", "failed"]),
  paused: new Set(["running", "waiting", "cancelled", "failed"]),
  interrupted: new Set(["running", "cancelled", "failed"]),
  // Terminal states require restart (runtime-source) to leave.
  completed: new Set([]),
  failed: new Set(["running", "cancelled"]),
  cancelled: new Set([]),
}

function isLegalNodeTransition(from: WorkflowNodeStatus, to: WorkflowNodeStatus): boolean {
  if (from === to) return true
  return NODE_TRANSITIONS[from]?.has(to) ?? false
}

export class InvalidNodeTransitionError extends Error {
  constructor(
    readonly nodeID: string,
    readonly from: WorkflowNodeStatus,
    readonly to: WorkflowNodeStatus,
  ) {
    super(`Illegal workflow node transition ${from} → ${to} for node ${nodeID}`)
    this.name = "InvalidNodeTransitionError"
  }
}

/** Thrown when a node tries to transition to `completed` but the guards
 *  (output_schema / outstanding checkpoints) reject it. Emits a structured
 *  event so the orchestrator can inject context and retry. */
export class NodeCompletionBlockedError extends Error {
  constructor(
    readonly nodeID: string,
    readonly reason: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(`Workflow node ${nodeID} cannot complete: ${reason}`)
    this.name = "NodeCompletionBlockedError"
  }
}

/** Thrown when a mutation would violate a structural graph invariant — DAG
 *  acyclicity, single-workflow scoping, or endpoint existence. Carries the
 *  machine-readable `reason` code so callers can route rejection events. */
export class WorkflowGraphInvariantError extends Error {
  constructor(
    readonly workflowID: string,
    readonly reason:
      | "self_loop"
      | "cycle"
      | "cross_workflow"
      | "from_node_missing"
      | "to_node_missing"
      | "duplicate_edge",
    readonly detail?: Record<string, unknown>,
  ) {
    super(`Workflow graph invariant violated on ${workflowID}: ${reason}`)
    this.name = "WorkflowGraphInvariantError"
  }
}

/** Shape of `config.output_schema`. Intentionally minimal — we keep it a
 *  lightweight contract rather than embedding a full JSON-schema validator.
 *  Callers that need richer checks can layer them on top via checkpoints. */
type OutputSchema = {
  required?: string[]
  forbid_empty?: boolean
}

function extractOutputSchema(config: Record<string, unknown> | null | undefined): OutputSchema | undefined {
  if (!config || typeof config !== "object") return undefined
  const raw = (config as Record<string, unknown>).output_schema
  if (!raw || typeof raw !== "object") return undefined
  const rec = raw as Record<string, unknown>
  const required = Array.isArray(rec.required)
    ? (rec.required as unknown[]).filter((x): x is string => typeof x === "string")
    : undefined
  const forbid_empty = rec.forbid_empty === true
  if (!required && !forbid_empty) return undefined
  return { required, forbid_empty }
}

function validateOutput(
  resultJson: Record<string, unknown> | null | undefined,
  schema: OutputSchema,
): { ok: true } | { ok: false; reason: string; missing?: string[] } {
  if (!resultJson || typeof resultJson !== "object") {
    return { ok: false, reason: "result_json_missing" }
  }
  if (schema.required && schema.required.length > 0) {
    const missing = schema.required.filter(
      (k) => !(k in resultJson) || resultJson[k] === null || resultJson[k] === undefined,
    )
    if (missing.length > 0) return { ok: false, reason: "required_fields_missing", missing }
  }
  if (schema.forbid_empty === true && Object.keys(resultJson).length === 0) {
    return { ok: false, reason: "result_json_empty" }
  }
  return { ok: true }
}

function mergeJSON(
  current: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
  mode: "replace" | "merge",
) {
  if (!next) return current
  if (mode === "replace") return next
  return { ...(current ?? {}), ...next }
}

/** Deterministic JSON stringifier used for the command dedup hash. Keys are
 *  sorted so `{ a, b }` and `{ b, a }` collide. Not cryptographically strong
 *  — we only need identity for short retry windows. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`
}

/** Small deterministic hash (djb2 variant). Good enough for command dedup. */
function shortHash(raw: string): string {
  let h = 5381
  for (let i = 0; i < raw.length; i++) {
    h = ((h << 5) + h + raw.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(16)
}

function commandFingerprint(command: string, payload: Record<string, unknown> | undefined): string {
  return `${command}:${shortHash(stableStringify(payload ?? {}))}`
}

/** Duplicate-command suppression window. Orchestrators that re-queue the same
 *  command back-to-back (typical LLM retry glitch) inside this window get a
 *  single event in the log instead of N. */
const COMMAND_DEDUP_WINDOW_MS = 5_000
/** Hard cap of how many recent commands we remember per node in state_json. */
const RECENT_COMMANDS_KEEP = 16

function normalizeWorkflowStatus(status: WorkflowNodeStatus | WorkflowStatus): WorkflowStatus {
  if (status === "running" || status === "waiting") return "running"
  if (status === "paused") return "paused"
  if (status === "interrupted") return "interrupted"
  if (status === "completed") return "completed"
  if (status === "failed") return "failed"
  if (status === "cancelled") return "cancelled"
  return "pending"
}

const wakeDelay = 15_000
const stallEvery = 15_000
const stallAfter = 45_000
/** If a pending command sits un-acked for this long we emit
 *  `node.command_timeout` so the orchestrator can retry or escalate. */
const commandAckTimeout = 60_000
/** P3 #11 — soft retention for the `workflow_event` log. Once a workflow
 *  accumulates more than this many events we prune the oldest rows whose
 *  kind is NOT a terminal/critical marker. Keeps long-running workflows
 *  from growing the event log without bound. */
const EVENT_RETENTION_HARD_CAP = 500
const EVENT_RETENTION_PRUNE_BATCH = 100
/** Kinds we never prune — they are the forensic trail a human or the
 *  orchestrator will want later. */
const EVENT_RETENTION_PROTECTED: ReadonlySet<string> = new Set<string>([
  "workflow.created",
  "workflow.updated",
  "workflow.completed",
  "workflow.failed",
  "workflow.cancelled",
  "node.failed",
  "node.completed",
  "node.interrupted",
  "node.action_limit_reached",
  "node.attempt_limit_reached",
  "node.output_invalid",
  "node.blocked",
  "node.transition_rejected",
  "node.command_timeout",
  "node.budget_exceeded",
  "checkpoint.failed",
])
/** P3 #11 — after this long a `timed_out_at`-stamped entry in
 *  `pending_commands` is removed. Acked entries are already removed
 *  eagerly by `ackCommand`; only timed-out entries can accumulate. */
const PENDING_COMMAND_TTL_MS = 60 * 60 * 1000

type Wake = {
  workflowID: string
  sessionID: string
  eventID: number
  nodeID?: string
  kind: string
  reason: string
  time: number
}

type WNode = {
  id: string
  status: WorkflowNodeStatus
  attempt: number
  state_json?: Record<string, unknown>
}

type RunAction = {
  kind: "tool" | "skill" | "subtask" | "mixed"
  name: string
  goal: string
  status: "pending" | "running" | "success" | "fail" | "partial" | "waiting"
  time: number
  note?: string
  error?: string
  session_id?: string
}

type RunTool = {
  name: string
  status: "success" | "error" | "running" | "cancelled"
  args?: string
  error?: string
}

type AttemptAction = {
  goal: string
  kind: "tool" | "skill" | "subtask" | "mixed"
  abilities: string[]
  outcome: "success" | "fail" | "partial" | "waiting"
  note?: string
  evidence?: {
    tools?: RunTool[]
    skills?: string[]
    files?: string[]
  }
}

type AttemptError = {
  source: string
  reason: string
  recoverable: boolean
}

type Attempt = {
  attempt: number
  result: "success" | "fail" | "partial" | "waiting"
  summary?: string
  needs: string[]
  actions: AttemptAction[]
  errors: AttemptError[]
  time: number
  message_id: string
}

type Run = {
  last_at?: number
  running_count?: number
  error_count?: number
  skills_loaded?: string[]
  active_tools?: Array<{
    call_id: string
    name: string
    goal: string
    status: "pending" | "running"
    started_at: number
  }>
  recent_actions?: RunAction[]
  last_attempt?: Attempt
  attempt_history?: Attempt[]
  /** P3 #15 — per-node budget accounting, rolled up from assistant
   *  message usage. Master reads the aggregated total via the workflow
   *  `Runtime.usage` rollup; per-node drill-down lives here. */
  usage?: RunUsage
  /** Message id of the most recent assistant message whose tokens/cost
   *  have already been folded into `usage`. Used to dedup across in-memory
   *  restarts so we don't double-count on a replayed `message.updated`. */
  usage_last_message_id?: string
  /** True once we have emitted `node.budget_exceeded` for the current
   *  crossing. Reset when the operator raises the limit or retries the
   *  node (attempt bump clears it). Keeps the event from spamming every
   *  subsequent tool call after the threshold is crossed. */
  budget_alerted?: boolean
}

type RunUsage = {
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost_usd: number
  tool_calls: number
  updated_at: number
}

const isRec = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const clip = (value: string, size = 360) => (value.length <= size ? value : `${value.slice(0, size - 1).trimEnd()}…`)

const json = (value: unknown) =>
  value === undefined ? undefined : clip(typeof value === "string" ? value : JSON.stringify(value), 220)

const first = (value?: string) =>
  value
    ?.split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean)

const summary = (parts: MessageV2.Part[]) =>
  clip(
    parts
      .filter((part): part is MessageV2.TextPart => part.type === "text")
      .filter((part) => !part.synthetic && !part.ignored)
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n\n"),
    500,
  )

const needs = (text?: string) => {
  if (!text) return [] as string[]
  const seen = new Set<string>()
  return text
    .split(/\r?\n/)
    .map((item) => item.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .filter((item) => /need|needs|missing|required|blocked|waiting for|缺少|需要|阻塞|无法|请提供|请确认/i.test(item))
    .filter((item) => {
      if (seen.has(item)) return false
      seen.add(item)
      return true
    })
    .slice(0, 5)
    .map((item) => clip(item, 160))
}

const goal = (tool: string, input: Record<string, unknown>) => {
  if (tool === "skill") {
    const name = typeof input.name === "string" ? input.name : "unknown"
    return `Load skill ${name}`
  }
  if (tool === "task") {
    if (typeof input.description === "string" && input.description.trim()) return clip(input.description.trim(), 120)
    return "Delegate subtask"
  }
  if (["glob", "grep", "read", "ls", "semantic_search", "codesearch", "websearch"].includes(tool))
    return "Inspect codebase or gather context"
  if (["edit", "write", "patch", "apply_patch"].includes(tool)) return "Modify files"
  if (["bash", "shell"].includes(tool)) return "Run commands or verify changes"
  if (["plan", "question"].includes(tool)) return "Clarify plan or unblock execution"
  return `Use ${tool}`
}

const ability = (part: MessageV2.ToolPart) => {
  if (part.tool === "skill" && typeof part.state.input.name === "string") return [part.tool, part.state.input.name]
  if (part.tool === "task" && typeof part.state.input.subagent_type === "string")
    return [part.tool, part.state.input.subagent_type]
  return [part.tool]
}

const note = (part: MessageV2.ToolPart) => {
  if (part.state.status === "completed") return first(part.state.title) ?? first(part.state.output) ?? json(part.state.metadata)
  if (part.state.status === "error") return first(part.state.error)
  if (part.state.status === "running") return first(part.state.title) ?? json(part.state.metadata)
  return json(part.state.input)
}

const fileList = (part: MessageV2.ToolPart) =>
  part.state.status === "completed"
    ? (part.state.attachments ?? [])
        .map((item) => item.filename)
        .filter((item): item is string => !!item)
        .slice(0, 8)
    : []

const runTool = (part: MessageV2.ToolPart): RunTool => ({
  name: part.tool,
  status:
    part.state.status === "completed"
      ? "success"
      : part.state.status === "error"
        ? "error"
        : part.state.status === "running"
          ? "running"
          : "cancelled",
  args: json(part.state.input),
  error: part.state.status === "error" ? clip(part.state.error, 160) : undefined,
})

const action = (part: MessageV2.ToolPart): AttemptAction => {
  const kind = part.tool === "skill" ? "skill" : part.tool === "task" ? "subtask" : "tool"
  const outcome =
    part.state.status === "completed"
      ? "success"
      : part.state.status === "error"
        ? "fail"
        : part.state.status === "running"
          ? "waiting"
          : "waiting"
  return {
    goal: goal(part.tool, part.state.input),
    kind,
    abilities: ability(part),
    outcome,
    note: note(part),
    evidence: {
      tools: part.tool === "skill" ? undefined : [runTool(part)],
      skills: part.tool === "skill" && typeof part.state.input.name === "string" ? [part.state.input.name] : undefined,
      files: fileList(part),
    },
  }
}

const mergeActions = (items: AttemptAction[]) => {
  const out = [] as AttemptAction[]
  for (const item of items) {
    const last = out.at(-1)
    if (!last || last.goal !== item.goal || last.kind !== item.kind) {
      out.push(item)
      continue
    }
    last.abilities = [...new Set([...last.abilities, ...item.abilities])]
    last.outcome = item.outcome === "fail" ? "fail" : last.outcome === "fail" ? "fail" : item.outcome
    last.note = item.note ?? last.note
    last.evidence = {
      tools: [...(last.evidence?.tools ?? []), ...(item.evidence?.tools ?? [])].slice(-6),
      skills: [...new Set([...(last.evidence?.skills ?? []), ...(item.evidence?.skills ?? [])])],
      files: [...new Set([...(last.evidence?.files ?? []), ...(item.evidence?.files ?? [])])].slice(-8),
    }
  }
  return out
}

const recoverable = (value: string) => /missing|need|required|blocked|timeout|not found|permission|缺少|需要|阻塞|找不到|权限/i.test(value)

/** P3 #15 — derive a single-message usage delta from a completed assistant
 *  message. The message tokens are absolute-for-this-round (not cumulative),
 *  so callers can fold the result into the running total with `addUsage`.
 *  Tool calls counted here are "completed or errored" — in-flight tool parts
 *  get counted next time the message re-emits with a final state. */
const messageUsage = (msg: MessageV2.WithParts): RunUsage | undefined => {
  if (msg.info.role !== "assistant") return undefined
  const t = msg.info.tokens
  const toolCalls = msg.parts.filter(
    (part) => part.type === "tool" && (part.state.status === "completed" || part.state.status === "error"),
  ).length
  return {
    input_tokens: typeof t?.input === "number" ? t.input : 0,
    output_tokens: typeof t?.output === "number" ? t.output : 0,
    reasoning_tokens: typeof t?.reasoning === "number" ? t.reasoning : 0,
    cache_read_tokens: typeof t?.cache?.read === "number" ? t.cache.read : 0,
    cache_write_tokens: typeof t?.cache?.write === "number" ? t.cache.write : 0,
    cost_usd: typeof msg.info.cost === "number" ? msg.info.cost : 0,
    tool_calls: toolCalls,
    updated_at: msg.info.time.completed ?? msg.info.time.created,
  }
}

const report = (node: WNode, msg: MessageV2.WithParts) => {
  const text = summary(msg.parts)
  const errs = msg.parts
    .flatMap((part) => {
      if (part.type !== "tool" || part.state.status !== "error") return [] as AttemptError[]
      return [
        {
          source: part.tool,
          reason: clip(part.state.error, 180),
          recoverable: recoverable(part.state.error),
        },
      ]
    })
  if (msg.info.role === "assistant" && msg.info.error) {
    const reason =
      "message" in msg.info.error && typeof msg.info.error.message === "string" ? msg.info.error.message : msg.info.error.name
    errs.unshift({
      source: msg.info.agent,
      reason: clip(reason, 180),
      recoverable: recoverable(reason),
    })
  }
  const acts = mergeActions(msg.parts.filter((part): part is MessageV2.ToolPart => part.type === "tool").map(action))
  const result =
    errs.length > 0
      ? text
        ? "partial"
        : "fail"
      : node.status === "waiting"
        ? "waiting"
        : msg.info.role === "assistant" && msg.info.finish && ["stop", "length"].includes(msg.info.finish)
          ? "success"
          : "partial"
  return {
    attempt: node.attempt,
    result,
    summary: text || undefined,
    needs: needs(text),
    actions: acts,
    errors: errs,
    time: msg.info.role === "assistant" ? (msg.info.time.completed ?? msg.info.time.created) : msg.info.time.created,
    message_id: msg.info.id,
  } satisfies Attempt
}

const runState = (node: WNode) => {
  const item = isRec(node.state_json?.runtime) ? (node.state_json.runtime as Record<string, unknown>) : undefined
  return {
    last_at: typeof item?.last_at === "number" ? item.last_at : undefined,
    running_count: typeof item?.running_count === "number" ? item.running_count : 0,
    error_count: typeof item?.error_count === "number" ? item.error_count : 0,
    skills_loaded: Array.isArray(item?.skills_loaded)
      ? item.skills_loaded.filter((entry): entry is string => typeof entry === "string")
      : [],
    active_tools: Array.isArray(item?.active_tools)
      ? item.active_tools.filter(isRec).map((entry) => ({
          call_id: typeof entry.call_id === "string" ? entry.call_id : "",
          name: typeof entry.name === "string" ? entry.name : "",
          goal: typeof entry.goal === "string" ? entry.goal : "",
          status: entry.status === "running" ? "running" : "pending",
          started_at: typeof entry.started_at === "number" ? entry.started_at : 0,
        }))
      : [],
    recent_actions: Array.isArray(item?.recent_actions)
      ? item.recent_actions.filter(isRec).map((entry) => ({
          kind:
            entry.kind === "skill" || entry.kind === "subtask" || entry.kind === "mixed" ? entry.kind : "tool",
          name: typeof entry.name === "string" ? entry.name : "",
          goal: typeof entry.goal === "string" ? entry.goal : "",
          status:
            entry.status === "pending" ||
            entry.status === "running" ||
            entry.status === "success" ||
            entry.status === "fail" ||
            entry.status === "partial" ||
            entry.status === "waiting"
              ? entry.status
              : "waiting",
          time: typeof entry.time === "number" ? entry.time : 0,
          note: typeof entry.note === "string" ? entry.note : undefined,
          error: typeof entry.error === "string" ? entry.error : undefined,
          session_id: typeof entry.session_id === "string" ? entry.session_id : undefined,
        }))
      : [],
    last_attempt: isRec(item?.last_attempt) ? (item.last_attempt as Attempt) : undefined,
    attempt_history: Array.isArray(item?.attempt_history) ? (item.attempt_history as Attempt[]) : [],
    usage: isRec(item?.usage) ? normalizeUsage(item.usage as Record<string, unknown>) : undefined,
    usage_last_message_id:
      typeof item?.usage_last_message_id === "string" ? (item.usage_last_message_id as string) : undefined,
    budget_alerted: item?.budget_alerted === true,
  } satisfies Run
}

function normalizeUsage(raw: Record<string, unknown>): RunUsage {
  const pick = (key: string) => (typeof raw[key] === "number" ? (raw[key] as number) : 0)
  return {
    input_tokens: pick("input_tokens"),
    output_tokens: pick("output_tokens"),
    reasoning_tokens: pick("reasoning_tokens"),
    cache_read_tokens: pick("cache_read_tokens"),
    cache_write_tokens: pick("cache_write_tokens"),
    cost_usd: typeof raw.cost_usd === "number" ? (raw.cost_usd as number) : 0,
    tool_calls: pick("tool_calls"),
    updated_at: typeof raw.updated_at === "number" ? (raw.updated_at as number) : 0,
  }
}

const EMPTY_USAGE: RunUsage = {
  input_tokens: 0,
  output_tokens: 0,
  reasoning_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  cost_usd: 0,
  tool_calls: 0,
  updated_at: 0,
}

function addUsage(a: RunUsage | undefined, b: RunUsage | undefined): RunUsage {
  const x = a ?? EMPTY_USAGE
  const y = b ?? EMPTY_USAGE
  return {
    input_tokens: x.input_tokens + y.input_tokens,
    output_tokens: x.output_tokens + y.output_tokens,
    reasoning_tokens: x.reasoning_tokens + y.reasoning_tokens,
    cache_read_tokens: x.cache_read_tokens + y.cache_read_tokens,
    cache_write_tokens: x.cache_write_tokens + y.cache_write_tokens,
    cost_usd: x.cost_usd + y.cost_usd,
    tool_calls: x.tool_calls + y.tool_calls,
    updated_at: Math.max(x.updated_at, y.updated_at),
  }
}

const withRun = (node: WNode, patch: Partial<Run>) => {
  const curr = runState(node)
  const next = {
    ...curr,
    ...patch,
    skills_loaded: patch.skills_loaded ?? curr.skills_loaded,
    active_tools: patch.active_tools ?? curr.active_tools,
    recent_actions: patch.recent_actions ?? curr.recent_actions,
    attempt_history: patch.attempt_history ?? curr.attempt_history,
  } satisfies Run
  return {
    last_at: next.last_at,
    running_count: next.running_count,
    error_count: next.error_count,
    skills_loaded: next.skills_loaded?.slice(-12),
    active_tools: next.active_tools?.slice(-12),
    recent_actions: next.recent_actions?.slice(-16),
    last_attempt: next.last_attempt,
    attempt_history: next.attempt_history?.slice(-5),
    usage: next.usage,
    usage_last_message_id: next.usage_last_message_id,
    budget_alerted: next.budget_alerted,
  } satisfies Run
}

export namespace Workflow {
  // Structured summary for a workflow. `.loose()` tolerates unknown keys so
  // legacy rows with free-form JSON still parse; known fields are typed.
  // Mirrors `WorkflowSummary` TS type in workflow.sql.ts — keep them in sync.
  export const Summary = z
    .object({
      // High-level objective displayed at the top of the workflow panel.
      objective: z.string().optional(),
      // Plan steps rendered as badges / progress indicators.
      plan: z
        .array(
          z.object({
            label: z.string(),
            status: z.enum(["todo", "doing", "done", "blocked"]).optional(),
            node_id: z.string().optional(),
          }),
        )
        .optional(),
      // Free-form badge strings displayed inline.
      badges: z.array(z.string()).optional(),
      // Agent-private scratchpad; UI does not guarantee rendering.
      scratch: z.record(z.string(), z.any()).optional(),
    })
    .loose()
    .meta({ ref: "WorkflowSummary" })
  export type Summary = z.infer<typeof Summary>

  export const Info = z
    .object({
      id: z.string(),
      session_id: z.string(),
      title: z.string(),
      status: WorkflowStatus,
      current_node_id: z.string().optional(),
      selected_node_id: z.string().optional(),
      version: z.number().int().nonnegative(),
      /** P1 — monotonic counter incremented on every committed graph edit.
       *  Optional on the wire to keep older client builds happy; the server
       *  always populates it for new workflows. */
      graph_rev: z.number().int().nonnegative().optional(),
      /** P1 — global cap on simultaneously running nodes (default 5).
       *  Read by the P4 scheduler. Optional for back-compat. */
      max_concurrent_nodes: z.number().int().positive().optional(),
      config: z.record(z.string(), z.any()).optional(),
      summary: Summary.optional(),
      /** P1 — master-owned registry of currently held exclusive resources,
       *  keyed `resource → node_id`. The runtime exposes this for conflict
       *  detection; it does NOT auto-lock. */
      resources_held: z.record(z.string(), z.string()).optional(),
      /** P5 — final workflow result posted by `workflow_finalize`. */
      result_json: z.record(z.string(), z.any()).optional(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        paused: z.number().optional(),
        completed: z.number().optional(),
      }),
    })
    .meta({ ref: "Workflow" })
  export type Info = z.infer<typeof Info>

  export const Node = z
    .object({
      id: z.string(),
      workflow_id: z.string(),
      session_id: z.string().optional(),
      title: z.string(),
      agent: z.string(),
      model: z
        .object({
          providerID: z.string().optional(),
          modelID: z.string().optional(),
          variant: z.string().optional(),
        })
        .optional(),
      config: z.record(z.string(), z.any()).optional(),
      /** P1 — declared input ports with reducers. Absent = implicit single
       *  `in` port accepting anything (back-compat for existing workflows). */
      input_ports: WorkflowInputPortSchema.array().optional(),
      /** P1 — declared output ports. Absent = implicit single `out` port. */
      output_ports: WorkflowOutputPortSchema.array().optional(),
      status: WorkflowNodeStatus,
      result_status: WorkflowNodeResultStatus,
      fail_reason: z.string().optional(),
      action_count: z.number().int().nonnegative(),
      attempt: z.number().int().nonnegative(),
      max_attempts: z.number().int().positive(),
      max_actions: z.number().int().positive(),
      version: z.number().int().nonnegative(),
      state_json: z.record(z.string(), z.any()).optional(),
      result_json: z.record(z.string(), z.any()).optional(),
      /** P1 — snapshot of the input values this node consumed at start,
       *  keyed by input-port name. Used for replay and staleness detection. */
      consumed_inputs: z.record(z.string(), z.any()).optional(),
      /** P1 — true when upstream changes invalidated this node's result.
       *  Master decides whether to rerun, accept, or discard. */
      stale: z.boolean().optional(),
      /** P1 — `workflow.graph_rev` observed when this node began running. */
      graph_rev_at_start: z.number().int().nonnegative().optional(),
      /** P1 — scheduling priority (higher runs first among ready nodes). */
      priority: z.number().int().optional(),
      /** P1 — exclusive resource keys this node wants held while running. */
      holds_resources: z.array(z.string()).optional(),
      position: z.number().int().nonnegative(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        started: z.number().optional(),
        completed: z.number().optional(),
      }),
    })
    .meta({ ref: "WorkflowNode" })
  export type Node = z.infer<typeof Node>

  export const Edge = z
    .object({
      id: z.string(),
      workflow_id: z.string(),
      from_node_id: z.string(),
      to_node_id: z.string(),
      label: z.string().optional(),
      config: z.record(z.string(), z.any()).optional(),
      /** P1 — outbound port on the producer (default `out` when absent). */
      from_port: z.string().optional(),
      /** P1 — inbound port on the consumer (default `in` when absent). */
      to_port: z.string().optional(),
      /** P1 — when true, downstream cannot become `ready` until this edge
       *  has produced a value. Defaults to true server-side. */
      required: z.boolean().optional(),
      time_created: z.number(),
    })
    .meta({ ref: "WorkflowEdge" })
  export type Edge = z.infer<typeof Edge>

  export const Checkpoint = z
    .object({
      id: z.string(),
      workflow_id: z.string(),
      node_id: z.string(),
      label: z.string(),
      status: WorkflowCheckpointStatus,
      config: z.record(z.string(), z.any()).optional(),
      result_json: z.record(z.string(), z.any()).optional(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
      }),
    })
    .meta({ ref: "WorkflowCheckpoint" })
  export type Checkpoint = z.infer<typeof Checkpoint>

  /** P1 — round-trip shape for a proposed graph edit transaction.
   *  The concrete `ops` union is defined in P3 along with the reconciler;
   *  here we keep it permissive so rows round-trip even before P3 lands. */
  export const Edit = z
    .object({
      id: z.string(),
      workflow_id: z.string(),
      proposer_session_id: z.string().optional(),
      ops: z.array(z.record(z.string(), z.any())),
      status: WorkflowEditStatus,
      reason: z.string().optional(),
      reject_reason: z.string().optional(),
      graph_rev_before: z.number().int().nonnegative(),
      graph_rev_after: z.number().int().nonnegative().optional(),
      time: z.object({
        created: z.number(),
        applied: z.number().optional(),
      }),
    })
    .meta({ ref: "WorkflowEdit" })
  export type Edit = z.infer<typeof Edit>

  export const EventInfo = z
    .object({
      id: z.number().int().nonnegative(),
      workflow_id: z.string(),
      node_id: z.string().optional(),
      session_id: z.string().optional(),
      target_node_id: z.string().optional(),
      kind: z.string(),
      source: z.string(),
      audience: WorkflowEventAudience.optional(),
      payload: z.record(z.string(), z.any()),
      time_created: z.number(),
    })
    .meta({ ref: "WorkflowEvent" })
  export type EventInfo = z.infer<typeof EventInfo>

  /** P3 #15 — token / cost rollup. `Usage` on `Runtime` is the per-workflow
   *  total summed across all nodes; individual node usage lives on
   *  `node.state_json.runtime.usage`. All counters are monotonic over the
   *  workflow lifetime (resetting would break "how much did this run cost"). */
  export const Usage = z
    .object({
      input_tokens: z.number().nonnegative(),
      output_tokens: z.number().nonnegative(),
      reasoning_tokens: z.number().nonnegative(),
      cache_read_tokens: z.number().nonnegative(),
      cache_write_tokens: z.number().nonnegative(),
      cost_usd: z.number().nonnegative(),
      tool_calls: z.number().int().nonnegative(),
      updated_at: z.number().nonnegative(),
    })
    .meta({ ref: "WorkflowUsage" })
  export type Usage = z.infer<typeof Usage>

  export const Runtime = z
    .object({
      phase: z.enum(["planning", "running", "waiting", "interrupted", "failed", "completed"]),
      active_node_id: z.string().optional(),
      waiting_node_ids: z.array(z.string()),
      failed_node_ids: z.array(z.string()),
      command_count: z.number().int().nonnegative(),
      update_count: z.number().int().nonnegative(),
      pull_count: z.number().int().nonnegative(),
      last_event_id: z.number().int().nonnegative(),
      /** Sum of token / cost usage across all nodes in this workflow.
       *  Omitted when no node has accumulated any usage yet (keeps the
       *  snapshot payload small for freshly-created workflows). */
      usage: Usage.optional(),
      /** Optional advisory budget caps read from `workflow.config.limits`.
       *  The runtime does NOT auto-cancel on breach — it only emits a
       *  `node.budget_exceeded` event so the master can decide policy. */
      limits: z
        .object({
          max_input_tokens: z.number().nonnegative().optional(),
          max_output_tokens: z.number().nonnegative().optional(),
          max_cost_usd: z.number().nonnegative().optional(),
        })
        .optional(),
    })
    .meta({ ref: "WorkflowRuntime" })
  export type Runtime = z.infer<typeof Runtime>

  export const Snapshot = z
    .object({
      workflow: Info,
      runtime: Runtime,
      nodes: Node.array(),
      edges: Edge.array(),
      checkpoints: Checkpoint.array(),
      events: EventInfo.array(),
      /** P1 — recent graph edit transactions. Optional on the wire; clients
       *  that don't care about edit provenance can ignore it. */
      edits: Edit.array().optional(),
      cursor: z.number().int().nonnegative(),
    })
    .meta({ ref: "WorkflowSnapshot" })
  export type Snapshot = z.infer<typeof Snapshot>

  export const ReadResult = z
    .object({
      workflow: Info.optional(),
      runtime: Runtime.optional(),
      nodes: Node.array(),
      edges: Edge.array(),
      checkpoints: Checkpoint.array(),
      events: EventInfo.array(),
      /** P1 — delta slice of edit transactions (pending + recently applied). */
      edits: Edit.array().optional(),
      cursor: z.number().int().nonnegative(),
    })
    .meta({ ref: "WorkflowReadResult" })
  export type ReadResult = z.infer<typeof ReadResult>

  export const Event = {
    Created: BusEvent.define("workflow.created", z.object({ info: Info })),
    Updated: BusEvent.define("workflow.updated", z.object({ info: Info })),
    NodeCreated: BusEvent.define("workflow.node.created", z.object({ info: Node })),
    NodeUpdated: BusEvent.define("workflow.node.updated", z.object({ info: Node })),
    EdgeCreated: BusEvent.define("workflow.edge.created", z.object({ info: Edge })),
    CheckpointUpdated: BusEvent.define("workflow.checkpoint.updated", z.object({ info: Checkpoint })),
    EventCreated: BusEvent.define("workflow.event.created", z.object({ info: EventInfo })),
  }

  async function workflowRow(workflowID: string) {
    return Database.use((db) => db.select().from(WorkflowTable).where(eq(WorkflowTable.id, workflowID)).get())
  }

  async function sendWake(wake: Wake) {
    const hint =
      wake.kind === "node.completed"
        ? "If downstream nodes are now unblocked, start the next ready node only when its model is fully configured."
        : "Then decide whether to continue, inject context, retry, replan, or ask the user."
    await writeEvent({
      workflowID: wake.workflowID,
      sessionID: wake.sessionID,
      nodeID: wake.nodeID,
      source: "runtime",
      kind: "workflow.orchestrator_woken",
      payload: {
        wake_kind: wake.kind,
        wake_reason: wake.reason,
        trigger_event_id: wake.eventID,
      },
    })
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        const sp = yield* SessionPrompt.Service
        return yield* sp.prompt({
          sessionID: SessionID.make(wake.sessionID),
          agent: "orchestrator",
          parts: [
            {
              type: "text",
              synthetic: true,
              metadata: {
                workflow_wake: true,
                wake_kind: wake.kind,
                wake_reason: wake.reason,
                trigger_event_id: wake.eventID,
              },
              text: [
                `Workflow wake event: ${wake.kind}`,
                `Reason: ${wake.reason}`,
                `Workflow ID: ${wake.workflowID}`,
                wake.nodeID ? `Node ID: ${wake.nodeID}` : "",
                `Trigger event ID: ${wake.eventID}`,
                "",
                `Call workflow_read with workflow_id="${wake.workflowID}" and cursor=${Math.max(0, wake.eventID - 1)} first.`,
                hint,
              ]
                .filter(Boolean)
                .join("\n"),
            },
          ],
        })
      }),
    )
  }

  function classify(event: EventInfo) {
    if (event.kind === "node.completed") return { kind: "node.completed", reason: "node completed" }
    if (event.kind === "node.failed") return { kind: "node.failed", reason: "node failed" }
    if (event.kind === "node.interrupted") return { kind: "node.interrupted", reason: "node interrupted" }
    if (
      event.kind === "node.attempt_reported" &&
      typeof event.payload.result === "string" &&
      event.payload.result !== "success"
    ) {
      return { kind: "node.attempt_reported", reason: `attempt reported ${event.payload.result}` }
    }
    if (event.kind === "node.action_limit_reached") return { kind: "node.limit_reached", reason: "action limit reached" }
    if (event.kind === "node.attempt_limit_reached") return { kind: "node.limit_reached", reason: "attempt limit reached" }
    if (event.kind === "node.stalled") return { kind: "node.stalled", reason: "node stalled without recent pull or update" }
    if (event.kind === "checkpoint.failed") return { kind: "checkpoint.failed", reason: "checkpoint failed" }
    if (event.kind === "checkpoint.pending") return { kind: "checkpoint.pending_manual", reason: "checkpoint pending manual review" }
    if (event.kind === "node.updated" && event.payload.status === "waiting") {
      return { kind: "node.waiting", reason: "node is waiting for orchestrator or user input" }
    }
    if (event.kind === "node.blocked") return { kind: "node.waiting", reason: "node reported a blocked state" }
  }

  async function patchRun(input: {
    nodeID: string
    event: {
      kind: string
      payload: Record<string, unknown>
    }
    action_delta?: number
    /** When set, also increments the top-level node.attempt column.
     * Previously `attempt_delta` lived only on the workflow_update
     * tool schema, and the LLM was expected to call it explicitly
     * every time a slave finished — which it almost never did. Now
     * onMessage can bump it in lockstep with node.attempt_reported
     * so the inspector's "attempt X/Y" counter actually reflects
     * reality. */
    attempt_delta?: number
    run: (node: WNode) => Partial<Run>
  }) {
    const node = await getNode(input.nodeID).catch(() => undefined)
    if (!node) return
    const next = withRun(node, input.run(node))
    await patchNode({
      nodeID: node.id,
      source: "runtime",
      patch: {
        state_json: {
          mode: "merge",
          value: {
            runtime: next,
          },
        },
        attempt_delta: input.attempt_delta,
      },
      action_delta: input.action_delta,
      event: {
        kind: input.event.kind,
        target_node_id: node.id,
        payload: input.event.payload,
      },
    }).catch((error) => {
      log.warn("failed to patch workflow runtime", { nodeID: input.nodeID, error })
    })
  }

  async function onTool(part: MessageV2.ToolPart) {
    const node = await nodeBySession(part.sessionID).catch(() => undefined)
    if (!node) return
    const curr = state()
    const prev = curr.parts[part.id]
    if (prev === part.state.status) return
    curr.parts[part.id] = part.state.status

    const name = part.tool === "skill" && typeof part.state.input.name === "string" ? part.state.input.name : part.tool
    const item = {
      kind: part.tool === "skill" ? "skill" : part.tool === "task" ? "subtask" : "tool",
      name,
      goal: goal(part.tool, part.state.input),
      status:
        part.state.status === "completed"
          ? "success"
          : part.state.status === "error"
            ? "fail"
            : part.state.status === "running"
              ? "running"
              : "pending",
      time:
        part.state.status === "completed" || part.state.status === "error"
          ? part.state.time.end
          : part.state.status === "running"
            ? part.state.time.start
            : Date.now(),
      note: note(part),
      error: part.state.status === "error" ? clip(part.state.error, 160) : undefined,
      session_id:
        part.tool === "task" && (part.state.status === "completed" || part.state.status === "running") && isRec(part.state.metadata)
          ? typeof part.state.metadata.sessionId === "string"
            ? part.state.metadata.sessionId
            : undefined
          : undefined,
    } satisfies RunAction

    const active = (runState(node).active_tools ?? []).filter((entry) => entry.call_id !== part.callID)
    if (part.state.status === "pending" || part.state.status === "running") {
      active.push({
        call_id: part.callID,
        name,
        goal: item.goal,
        status: part.state.status,
        started_at: part.state.status === "running" ? part.state.time.start : Date.now(),
      })
    }

    const run = (node: WNode) => {
      const curr = runState(node)
      const skills =
        part.tool === "skill" && part.state.status === "completed" && typeof part.state.input.name === "string"
          ? [...new Set([...(curr.skills_loaded ?? []), part.state.input.name])]
          : curr.skills_loaded
      return {
        last_at: item.time,
        running_count: active.length,
        error_count: (curr.error_count ?? 0) + (part.state.status === "error" ? 1 : 0),
        skills_loaded: skills,
        active_tools: active,
        recent_actions: [...(curr.recent_actions ?? []), item].slice(-16),
      } satisfies Partial<Run>
    }

    if (part.tool === "skill" && part.state.status === "completed") {
      await patchRun({
        nodeID: node.id,
        run,
        event: {
          kind: "node.runtime.skill_loaded",
          payload: {
            skill: typeof part.state.input.name === "string" ? part.state.input.name : "unknown",
            status: part.state.status,
          },
        },
      })
      return
    }

    if (part.tool === "task") {
      const kind =
        part.state.status === "completed"
          ? "node.runtime.subtask_completed"
          : part.state.status === "error"
            ? "node.runtime.subtask_failed"
            : "node.runtime.subtask_started"
      await patchRun({
        nodeID: node.id,
        run,
        action_delta: part.state.status === "pending" ? 1 : undefined,
        event: {
          kind,
          payload: {
            subagent_type: typeof part.state.input.subagent_type === "string" ? part.state.input.subagent_type : "unknown",
            description: typeof part.state.input.description === "string" ? part.state.input.description : undefined,
            session_id: item.session_id,
            status: part.state.status,
            error: part.state.status === "error" ? part.state.error : undefined,
          },
        },
      })
      return
    }

    const kind =
      part.state.status === "completed"
        ? "node.runtime.tool_completed"
        : part.state.status === "error"
          ? "node.runtime.tool_failed"
          : part.state.status === "running"
            ? "node.runtime.tool_running"
            : "node.action"
    await patchRun({
      nodeID: node.id,
      run,
      action_delta: part.state.status === "pending" ? 1 : undefined,
      event: {
        kind,
        payload: {
          call_id: part.callID,
          tool: part.tool,
          goal: item.goal,
          status: part.state.status,
          error: part.state.status === "error" ? part.state.error : undefined,
        },
      },
    })
  }

  async function onSubtask(part: MessageV2.SubtaskPart) {
    const node = await nodeBySession(part.sessionID).catch(() => undefined)
    if (!node) return
    const curr = state()
    const key = `${part.id}:subtask`
    if (curr.parts[key]) return
    curr.parts[key] = "seen"
    await patchRun({
      nodeID: node.id,
      run: (node) => {
        const curr = runState(node)
        const item = {
          kind: "subtask",
          name: part.agent,
          goal: clip(part.description, 120),
          status: "waiting",
          time: Date.now(),
          note: clip(part.prompt, 180),
        } satisfies RunAction
        return {
          last_at: Date.now(),
          recent_actions: [...(curr.recent_actions ?? []), item].slice(-16),
        } satisfies Partial<Run>
      },
      event: {
        kind: "node.runtime.subtask_requested",
        payload: {
          agent: part.agent,
          description: part.description,
        },
      },
    })
  }

  async function onMessage(info: MessageV2.Info) {
    if (info.role !== "assistant") return
    if (typeof info.time.completed !== "number") return
    if (info.finish && ["tool-calls", "unknown"].includes(info.finish) && !info.error) return
    const node = await nodeBySession(info.sessionID).catch(() => undefined)
    if (!node) return
    const curr = state()
    const done = curr.msg[info.id]
    if (done === info.time.completed) return
    curr.msg[info.id] = info.time.completed
    let msg: MessageV2.WithParts | undefined
    try {
      msg = MessageV2.get({
        sessionID: info.sessionID,
        messageID: info.id,
      })
    } catch {
      msg = undefined
    }
    if (!msg) return
    const rep = report(node, msg)
    const delta = messageUsage(msg)
    // P3 #15 — pull advisory limits from workflow.config once per message.
    // `limitsFromConfig` returns undefined when none are set, in which case
    // the breach check below becomes a no-op. `get()` returns the full
    // snapshot shape `{ workflow, runtime, nodes, ... }`, so we drill into
    // `.workflow.config` — not `.config` directly.
    const snapshot = await get(node.workflow_id).catch(() => undefined)
    const limits = snapshot ? limitsFromConfig(snapshot.workflow.config) : undefined
    // Bump the top-level attempt counter on every definitive result so
    // the inspector "attempt X/Y" badge actually moves. "waiting" is
    // excluded — those are in-flight pauses, not completed tries. The
    // orchestrator can still override via workflow_update if it wants
    // to force a specific count after a manual retry.
    const shouldBumpAttempt = rep.result !== "waiting"
    // Captured in the run closure and inspected after the patch lands, so
    // we can emit the `node.budget_exceeded` event outside the transaction
    // (the patch itself already carries `node.attempt_reported`, and
    // patchRun/patchNode only accepts one event per call).
    let breachedNow: { reasons: string[]; usage: RunUsage; limits: NonNullable<Runtime["limits"]> } | undefined
    await patchRun({
      nodeID: node.id,
      attempt_delta: shouldBumpAttempt ? 1 : undefined,
      run: (node) => {
        const curr = runState(node)
        const hist = [...(curr.attempt_history ?? []).filter((item) => item.message_id !== rep.message_id), rep]
        // P3 #15 — fold assistant-message tokens/cost into the running total.
        // Dedup by message id so a replayed `message.updated` after a
        // restart can't double-count; attempt bumps clear `budget_alerted`
        // so each retry starts fresh.
        let nextUsage = curr.usage
        let nextLastMsg = curr.usage_last_message_id
        if (delta && curr.usage_last_message_id !== rep.message_id) {
          nextUsage = addUsage(curr.usage, delta)
          nextLastMsg = rep.message_id
        }
        let nextAlerted = shouldBumpAttempt ? false : curr.budget_alerted === true
        if (limits && nextUsage && !nextAlerted) {
          const reasons = budgetBreach(limits, nextUsage)
          if (reasons) {
            nextAlerted = true
            breachedNow = { reasons, usage: nextUsage, limits }
          }
        }
        return {
          last_at: rep.time,
          last_attempt: rep,
          attempt_history: hist,
          usage: nextUsage,
          usage_last_message_id: nextLastMsg,
          budget_alerted: nextAlerted,
        } satisfies Partial<Run>
      },
      event: {
        kind: "node.attempt_reported",
        payload: {
          attempt: rep.attempt,
          result: rep.result,
          summary: rep.summary,
          needs: rep.needs,
          actions: rep.actions,
          errors: rep.errors,
          message_id: rep.message_id,
        },
      },
    })
    if (breachedNow) {
      await writeEvent({
        workflowID: node.workflow_id,
        nodeID: node.id,
        source: "runtime",
        kind: "node.budget_exceeded",
        payload: {
          reasons: breachedNow.reasons,
          usage: breachedNow.usage,
          limits: breachedNow.limits,
          message_id: rep.message_id,
        },
      }).catch((error) => {
        log.warn("failed to emit budget_exceeded event", { nodeID: node.id, error })
      })
    }
  }

  async function queueWake(input: Wake) {
    const current = state()
    const key = `${input.workflowID}:${input.kind}:${input.nodeID ?? "root"}`
    const seen = current.seen[key]
    if (seen && input.time - seen < wakeDelay) return
    current.seen[key] = input.time

    // Previously this read `SessionStatus.get(...)` directly on the
    // namespace, but `get` lives inside the Effect layer closure and
    // isn't a top-level export — so the call threw `TypeError: get is
    // not a function` every time, silently killing the wake pipeline.
    // That's why slave completions stopped waking the orchestrator
    // after the first round: the queue path never ran, and the
    // unsubStatus flush path had nothing to flush. We now fetch the
    // real status through the Effect runtime. Any failure (layer not
    // ready, runtime shutting down) falls through to the queue branch
    // so the wake still lands on the next idle transition.
    let idleNow = false
    try {
      const info = await AppRuntime.runPromise(
        SessionStatus.Service.use((svc) => svc.get(SessionID.make(input.sessionID))),
      )
      idleNow = info.type === "idle"
    } catch (error) {
      log.warn("failed to read orchestrator status; queueing wake", {
        workflowID: input.workflowID,
        error,
      })
    }
    if (idleNow) {
      await sendWake(input).catch(async (error) => {
        if (!(error instanceof Session.BusyError)) {
          log.warn("failed to wake orchestrator", { workflowID: input.workflowID, error })
          return
        }
        current.queue[input.sessionID] = [...(current.queue[input.sessionID] ?? []), input]
        await writeEvent({
          workflowID: input.workflowID,
          sessionID: input.sessionID,
          nodeID: input.nodeID,
          source: "runtime",
          kind: "workflow.orchestrator_wake_queued",
          payload: {
            wake_kind: input.kind,
            wake_reason: input.reason,
            trigger_event_id: input.eventID,
          },
        })
      })
      return
    }

    current.queue[input.sessionID] = [...(current.queue[input.sessionID] ?? []), input]
    await writeEvent({
      workflowID: input.workflowID,
      sessionID: input.sessionID,
      nodeID: input.nodeID,
      source: "runtime",
      kind: "workflow.orchestrator_wake_queued",
      payload: {
        wake_kind: input.kind,
        wake_reason: input.reason,
        trigger_event_id: input.eventID,
      },
    })
  }

  async function flush(sessionID: string) {
    const current = state()
    const items = current.queue[sessionID]
    if (!items?.length) return
    const wake = items.at(-1)
    delete current.queue[sessionID]
    if (!wake) return
    await sendWake(wake).catch((error) => {
      current.queue[sessionID] = [...(current.queue[sessionID] ?? []), wake]
      log.warn("failed to flush orchestrator wake", { sessionID, error })
    })
  }

  async function detectStall() {
    const now = Date.now()
    const current = state()
    const nodes = Database.use((db) =>
      db
        .select()
        .from(WorkflowNodeTable)
        .where(inArray(WorkflowNodeTable.status, ["running", "waiting"]))
        .all(),
    ).map(fromNodeRow)
    const ids = new Set(nodes.map((node) => node.id))
    Object.keys(current.stall).forEach((id) => {
      if (ids.has(id)) return
      delete current.stall[id]
    })
    for (const node of nodes) {
      // P1.1 command ACK timeout — do this before the stall short-circuit so a
      // fresh stall timer can't hide a much older un-acked command.
      await detectCommandTimeouts(node, now)

      if (now - node.time.updated < stallAfter) {
        delete current.stall[node.id]
        continue
      }
      const mark = `${node.status}:${node.time.updated}`
      if (current.stall[node.id] === mark) continue
      current.stall[node.id] = mark
      await writeEvent({
        workflowID: node.workflow_id,
        nodeID: node.id,
        sessionID: node.session_id,
        target_node_id: node.id,
        source: "runtime",
        kind: "node.stalled",
        payload: {
          status: node.status,
          updated_at: node.time.updated,
          stalled_for_ms: now - node.time.updated,
        },
      })
    }
  }

  /** Scan pending_commands on a node and emit `node.command_timeout` for any
   *  entry older than `commandAckTimeout`. Timed-out entries are marked
   *  `timed_out_at` so we don't keep re-firing for them.
   *
   *  P3 #11 — also drops entries whose `timed_out_at` is older than
   *  `PENDING_COMMAND_TTL_MS` so the queue does not accumulate stale
   *  records forever. Acked entries are removed eagerly by `ackCommand`,
   *  so only timed-out entries can pile up here. */
  async function detectCommandTimeouts(node: Node, now: number) {
    const runtimeState = isRec(node.state_json) ? node.state_json : {}
    const pending = Array.isArray(runtimeState.pending_commands)
      ? (runtimeState.pending_commands as Array<Record<string, unknown>>)
      : []
    if (pending.length === 0) return

    const timedOutNow: Array<Record<string, unknown>> = []
    // First pass: stamp newly-timed-out entries AND drop long-expired ones.
    const stamped = pending
      .map((entry) => {
        if (!isRec(entry)) return entry
        const issuedAt = typeof entry.issued_at === "number" ? (entry.issued_at as number) : now
        if (entry.timed_out_at) return entry
        if (now - issuedAt < commandAckTimeout) return entry
        const next = { ...entry, timed_out_at: now }
        timedOutNow.push(next)
        return next
      })
      .filter((entry) => {
        if (!isRec(entry)) return true
        const stampedAt = typeof entry.timed_out_at === "number" ? (entry.timed_out_at as number) : undefined
        if (stampedAt === undefined) return true
        // Keep entries that were just stamped (we still want to emit the
        // event for them); drop ones that have aged past the TTL.
        return now - stampedAt < PENDING_COMMAND_TTL_MS
      })
    const nextPending = stamped
    const changed = nextPending.length !== pending.length || timedOutNow.length > 0

    if (!changed) return

    // Persist the stamped `timed_out_at` (and the pruned list) so the next
    // tick doesn't re-fire or re-evaluate stale records.
    await patchNode({
      nodeID: node.id,
      source: "runtime",
      patch: {
        state_json: {
          mode: "merge",
          value: { pending_commands: nextPending },
        },
      },
    })

    if (timedOutNow.length === 0) return
    for (const entry of timedOutNow) {
      await writeEvent({
        workflowID: node.workflow_id,
        nodeID: node.id,
        sessionID: node.session_id,
        target_node_id: node.id,
        source: "runtime",
        kind: "node.command_timeout",
        payload: {
          command_id: entry.command_id,
          command: entry.command,
          issued_at: entry.issued_at,
          age_ms: now - ((entry.issued_at as number) ?? now),
        },
      })
    }
  }

  type State = {
    unsubPart: () => void
    unsubMsg: () => void
    unsubWorkflow: () => void
    unsubStatus: () => void
    timer: ReturnType<typeof setInterval>
    queue: Record<string, Wake[]>
    seen: Record<string, number>
    stall: Record<string, string>
    parts: Record<string, string>
    msg: Record<string, number>
  }
  function createState(): State {
    const unsubPart = Bus.subscribe(MessageV2.Event.PartUpdated, async (event) => {
      const part = event.properties.part
      if (part.type === "tool") {
        await onTool(part)
        return
      }
      if (part.type === "subtask") {
        await onSubtask(part)
      }
    })
    const unsubMsg = Bus.subscribe(MessageV2.Event.Updated, async (event) => {
      await onMessage(event.properties.info)
    })
    const unsubWorkflow = Bus.subscribe(Event.EventCreated, async (event) => {
      const info = event.properties.info
      const wake = classify(info)
      if (!wake) return
      const workflow = await workflowRow(info.workflow_id)
      if (!workflow || ["completed", "failed", "cancelled"].includes(workflow.status)) return
      await writeEvent({
        workflowID: info.workflow_id,
        sessionID: workflow.session_id,
        nodeID: info.node_id,
        source: "runtime",
        kind: "workflow.orchestrator_wake_requested",
        payload: {
          wake_kind: wake.kind,
          wake_reason: wake.reason,
          trigger_event_id: info.id,
          node_id: info.node_id,
        },
      })
      await queueWake({
        workflowID: info.workflow_id,
        sessionID: workflow.session_id,
        eventID: info.id,
        nodeID: info.node_id,
        kind: wake.kind,
        reason: wake.reason,
        time: Date.now(),
      })
    })
    const unsubStatus = Bus.subscribe(SessionStatus.Event.Status, async (event) => {
      if (event.properties.status.type !== "idle") return
      await flush(event.properties.sessionID)
    })
    const timer = setInterval(() => {
      void detectStall()
    }, stallEvery)
    return {
      unsubPart,
      unsubMsg,
      unsubWorkflow,
      unsubStatus,
      timer,
      queue: {} as Record<string, Wake[]>,
      seen: {} as Record<string, number>,
      stall: {} as Record<string, string>,
      parts: {} as Record<string, string>,
      msg: {} as Record<string, number>,
    }
  }
  const state = instanceState<State>(createState, async (entry) => {
    entry.unsubPart()
    entry.unsubMsg()
    entry.unsubWorkflow()
    entry.unsubStatus()
    clearInterval(entry.timer)
  })

  function fromWorkflowRow(row: typeof WorkflowTable.$inferSelect): Info {
    return {
      id: row.id,
      session_id: row.session_id,
      title: row.title,
      status: row.status,
      current_node_id: row.current_node_id ?? undefined,
      selected_node_id: row.selected_node_id ?? undefined,
      version: row.version,
      // P1 — dynamic graph metadata. Older rows pre-migration could in theory
      // have NULL here, but the migration sets `NOT NULL DEFAULT 0/5`; we
      // still coalesce defensively so the snapshot type stays stable.
      graph_rev: row.graph_rev ?? 0,
      max_concurrent_nodes: row.max_concurrent_nodes ?? 5,
      resources_held: row.resources_held ?? undefined,
      result_json: row.result_json ?? undefined,
      config: row.config ?? undefined,
      summary: row.summary ?? undefined,
      time: {
        created: row.time_created,
        updated: row.time_updated,
        paused: row.time_paused ?? undefined,
        completed: row.time_completed ?? undefined,
      },
    }
  }

  function fromNodeRow(row: typeof WorkflowNodeTable.$inferSelect): Node {
    return {
      id: row.id,
      workflow_id: row.workflow_id,
      session_id: row.session_id ?? undefined,
      title: row.title,
      agent: row.agent,
      model: row.model ?? undefined,
      config: row.config ?? undefined,
      // P1 — port + scheduling metadata. All additive; `undefined` preserves
      // existing-row behaviour (implicit single `in` / `out` ports).
      input_ports: row.input_ports ?? undefined,
      output_ports: row.output_ports ?? undefined,
      status: row.status,
      result_status: row.result_status,
      fail_reason: row.fail_reason ?? undefined,
      action_count: row.action_count,
      attempt: row.attempt,
      max_attempts: row.max_attempts,
      max_actions: row.max_actions,
      version: row.version,
      state_json: row.state_json ?? undefined,
      result_json: row.result_json ?? undefined,
      consumed_inputs: row.consumed_inputs ?? undefined,
      // SQLite stores booleans as 0/1 integers — normalise to bool at the edge.
      stale: row.stale === 1 ? true : row.stale === 0 ? false : undefined,
      graph_rev_at_start: row.graph_rev_at_start ?? undefined,
      priority: row.priority ?? 0,
      holds_resources: row.holds_resources ?? undefined,
      position: row.position,
      time: {
        created: row.time_created,
        updated: row.time_updated,
        started: row.time_started ?? undefined,
        completed: row.time_completed ?? undefined,
      },
    }
  }

  function fromEdgeRow(row: typeof WorkflowEdgeTable.$inferSelect): Edge {
    return {
      id: row.id,
      workflow_id: row.workflow_id,
      from_node_id: row.from_node_id,
      to_node_id: row.to_node_id,
      label: row.label ?? undefined,
      config: row.config ?? undefined,
      // P1 — port routing + required-edge flag. Defaults: implicit
      // `out` → `in`, required=true.
      from_port: row.from_port ?? undefined,
      to_port: row.to_port ?? undefined,
      required: row.required === 1 ? true : row.required === 0 ? false : undefined,
      time_created: row.time_created,
    }
  }

  function fromEditRow(row: typeof WorkflowEditTable.$inferSelect): Edit {
    return {
      id: row.id,
      workflow_id: row.workflow_id,
      proposer_session_id: row.proposer_session_id ?? undefined,
      ops: (row.ops ?? []) as Edit["ops"],
      status: row.status,
      reason: row.reason ?? undefined,
      reject_reason: row.reject_reason ?? undefined,
      graph_rev_before: row.graph_rev_before,
      graph_rev_after: row.graph_rev_after ?? undefined,
      time: {
        created: row.time_created,
        applied: row.time_applied ?? undefined,
      },
    }
  }

  function fromCheckpointRow(row: typeof WorkflowCheckpointTable.$inferSelect): Checkpoint {
    return {
      id: row.id,
      workflow_id: row.workflow_id,
      node_id: row.node_id,
      label: row.label,
      status: row.status,
      config: row.config ?? undefined,
      result_json: row.result_json ?? undefined,
      time: {
        created: row.time_created,
        updated: row.time_updated,
      },
    }
  }

  function fromEventRow(row: typeof WorkflowEventTable.$inferSelect): EventInfo {
    // `_audience` is stamped by writeEvent; lift it out so API consumers see
    // a clean `audience` field and the payload is free of our internal marker.
    const raw = row.payload ?? {}
    const tagged = typeof raw._audience === "string" ? raw._audience : undefined
    const audience = WorkflowEventAudience.safeParse(tagged).success
      ? (tagged as WorkflowEventAudience)
      : audienceOf(row.kind)
    const { _audience: _omit, ...payload } = raw as Record<string, unknown>
    return {
      id: row.id,
      workflow_id: row.workflow_id,
      node_id: row.node_id ?? undefined,
      session_id: row.session_id ?? undefined,
      target_node_id: row.target_node_id ?? undefined,
      kind: row.kind,
      source: row.source,
      audience,
      payload,
      time_created: row.time_created,
    }
  }

  function runtime(input: { workflow: Info; nodes: Node[]; events: EventInfo[] }): Runtime {
    const active = input.nodes.find((node) => node.status === "running") ?? input.nodes.find((node) => node.status === "waiting")
    const waiting = input.nodes.filter((node) => node.status === "waiting").map((node) => node.id)
    const failed = input.nodes.filter((node) => node.status === "failed").map((node) => node.id)
    const phase =
      input.workflow.status === "completed"
        ? "completed"
        : input.workflow.status === "failed"
          ? "failed"
          : input.workflow.status === "interrupted"
            ? "interrupted"
            : waiting.length > 0
              ? "waiting"
              : active
                ? "running"
                : "planning"
    // P3 #15 — roll up per-node usage. We only emit the field when at least
    // one node has non-zero usage so new workflows don't carry a no-op stub.
    let total: RunUsage | undefined
    for (const node of input.nodes) {
      const u = runState(node).usage
      if (!u) continue
      total = addUsage(total, u)
    }
    const hasUsage =
      !!total &&
      (total.input_tokens > 0 ||
        total.output_tokens > 0 ||
        total.reasoning_tokens > 0 ||
        total.cache_read_tokens > 0 ||
        total.cache_write_tokens > 0 ||
        total.cost_usd > 0 ||
        total.tool_calls > 0)
    return {
      phase,
      active_node_id: active?.id,
      waiting_node_ids: waiting,
      failed_node_ids: failed,
      command_count: input.events.filter((event) => event.kind === "node.control").length,
      update_count: input.events.filter((event) => event.kind === "node.updated").length,
      pull_count: input.events.filter((event) => event.kind === "node.pulled").length,
      last_event_id: input.events.at(-1)?.id ?? 0,
      usage: hasUsage ? total : undefined,
      limits: limitsFromConfig(input.workflow.config),
    }
  }

  /** Compare an accumulated usage total against the advisory limits. Returns
   *  the list of breached dimensions (as strings) or undefined when the
   *  total is still under every configured cap. */
  function budgetBreach(
    limits: NonNullable<Runtime["limits"]> | undefined,
    usage: RunUsage | undefined,
  ): string[] | undefined {
    if (!limits || !usage) return undefined
    const reasons: string[] = []
    if (typeof limits.max_input_tokens === "number" && usage.input_tokens > limits.max_input_tokens)
      reasons.push("input_tokens")
    if (typeof limits.max_output_tokens === "number" && usage.output_tokens > limits.max_output_tokens)
      reasons.push("output_tokens")
    if (typeof limits.max_cost_usd === "number" && usage.cost_usd > limits.max_cost_usd) reasons.push("cost_usd")
    return reasons.length > 0 ? reasons : undefined
  }

  /** Extract optional `limits` advisory from `workflow.config.limits`. We
   *  treat it as purely advisory (read-only from the runtime's perspective) —
   *  the master decides whether to cancel / retry / raise the cap when the
   *  `node.budget_exceeded` event fires. */
  function limitsFromConfig(config: Record<string, unknown> | undefined): Runtime["limits"] {
    if (!isRec(config)) return undefined
    const raw = isRec(config.limits) ? (config.limits as Record<string, unknown>) : undefined
    if (!raw) return undefined
    const pick = (key: string) => {
      const v = raw[key]
      return typeof v === "number" && v >= 0 ? v : undefined
    }
    const out = {
      max_input_tokens: pick("max_input_tokens"),
      max_output_tokens: pick("max_output_tokens"),
      max_cost_usd: pick("max_cost_usd"),
    }
    if (out.max_input_tokens === undefined && out.max_output_tokens === undefined && out.max_cost_usd === undefined)
      return undefined
    return out
  }

  async function writeEvent(input: {
    workflowID: string
    nodeID?: string
    sessionID?: string
    target_node_id?: string
    kind: WorkflowEventKind | string
    source: string
    payload?: Record<string, unknown>
  }) {
    // Validate / coerce kind to the canonical taxonomy. Unknown kinds from
    // slaves get namespaced under `custom.` so they never match orchestrator
    // triggers — the orchestrator stays reactive to the closed set above.
    const { kind, known } = coerceEventKind(input.kind)
    if (!known) {
      log.warn("workflow event with unknown kind coerced to custom.*", {
        workflowID: input.workflowID,
        raw: input.kind,
        coerced: kind,
        source: input.source,
      })
    }
    const audience = audienceOf(kind)
    const row = Database.use((db) =>
      db
        .insert(WorkflowEventTable)
        .values({
          workflow_id: input.workflowID,
          node_id: input.nodeID,
          session_id: input.sessionID,
          target_node_id: input.target_node_id,
          kind,
          source: input.source,
          // Audience is stamped in payload so we don't need a schema migration.
          // `workflow_read` / `workflow_pull` honour it via audienceOf() on read.
          payload: { ...(input.payload ?? {}), _audience: audience },
        })
        .returning()
        .get(),
    )
    if (!row) throw new Error("Failed to create workflow event")
    const info = fromEventRow(row)
    Database.effect(() => Bus.publish(Event.EventCreated, { info }))
    // P3 #11 — soft event retention. Counting + pruning is cheap relative to
    // LLM-driven write frequency; doing it inline keeps the cap tight without
    // needing a separate GC timer.
    pruneOldEvents(input.workflowID)
    return info
  }

  /** P3 #11 — keep the event log bounded per workflow. We count current
   *  rows; when over the cap we delete the oldest non-protected rows in a
   *  batch so we only pay the write cost once every `PRUNE_BATCH` inserts. */
  function pruneOldEvents(workflowID: string) {
    try {
      const totalRow = Database.use((db) =>
        db
          .select({ count: sql<number>`count(*)` })
          .from(WorkflowEventTable)
          .where(eq(WorkflowEventTable.workflow_id, workflowID))
          .get(),
      )
      const total = totalRow?.count ?? 0
      if (total <= EVENT_RETENTION_HARD_CAP) return

      // Fetch ids of the oldest prunable rows. We exclude protected kinds so
      // the forensic trail (completed / failed / limits breached) is preserved
      // even on a very long workflow.
      const protectedList = Array.from(EVENT_RETENTION_PROTECTED)
      const overflow = Math.min(total - EVENT_RETENTION_HARD_CAP, EVENT_RETENTION_PRUNE_BATCH)
      const victims = Database.use((db) =>
        db
          .select({ id: WorkflowEventTable.id })
          .from(WorkflowEventTable)
          .where(
            and(
              eq(WorkflowEventTable.workflow_id, workflowID),
              notInArray(WorkflowEventTable.kind, protectedList),
            ),
          )
          .orderBy(asc(WorkflowEventTable.id))
          .limit(overflow)
          .all(),
      )
      if (victims.length === 0) return
      const ids = victims.map((v) => v.id)
      Database.use((db) => db.delete(WorkflowEventTable).where(inArray(WorkflowEventTable.id, ids)).run())
    } catch (error) {
      // Retention is best-effort; never let a cleanup failure interfere
      // with the main write path.
      log.warn("failed to prune workflow events", { workflowID, error })
    }
  }

  async function touchWorkflow(input: {
    workflowID: string
    patch?: Partial<{
      status: WorkflowStatus
      current_node_id: string | null
      selected_node_id: string | null
      summary: WorkflowSummary | null
      resources_held: Record<string, string> | null
      result_json: Record<string, unknown> | null
    }>
    /** When true, also increments `graph_rev` atomically. Use this for any
     *  topology-changing mutation (node/edge insert, replace, delete). Purely
     *  cosmetic updates (status, summary) must leave `graph_rev` alone so the
     *  master's optimistic-concurrency checks keep their meaning. */
    bumpGraphRev?: boolean
  }) {
    const row = Database.use((db) =>
      db
        .update(WorkflowTable)
        .set({
          ...(input.patch?.status ? { status: input.patch.status } : {}),
          ...(input.patch?.current_node_id !== undefined ? { current_node_id: input.patch.current_node_id } : {}),
          ...(input.patch?.selected_node_id !== undefined ? { selected_node_id: input.patch.selected_node_id } : {}),
          ...(input.patch?.summary !== undefined ? { summary: input.patch.summary ?? null } : {}),
          ...(input.patch?.resources_held !== undefined
            ? { resources_held: input.patch.resources_held ?? null }
            : {}),
          ...(input.patch?.result_json !== undefined ? { result_json: input.patch.result_json ?? null } : {}),
          version: sql`${WorkflowTable.version} + 1`,
          ...(input.bumpGraphRev ? { graph_rev: sql`${WorkflowTable.graph_rev} + 1` } : {}),
          time_updated: Date.now(),
        })
        .where(eq(WorkflowTable.id, input.workflowID))
        .returning()
        .get(),
    )
    if (!row) throw new NotFoundError({ message: `Workflow not found: ${input.workflowID}` })
    const info = fromWorkflowRow(row)
    Database.effect(() => Bus.publish(Event.Updated, { info }))
    return info
  }

  /** Forward DFS from `start` over outgoing edges; returns true if `target`
   *  is reachable. Used by edge-insert to detect would-be cycles: if the
   *  target-node can already reach the source-node, a new edge source→target
   *  closes a loop. Fetches all edges for the workflow in one query; for the
   *  expected graph sizes (< ~200 edges) this is cheaper than per-node
   *  round-trips. */
  function canReach(workflowID: string, start: string, target: string): boolean {
    if (start === target) return true
    const edges = Database.use((db) =>
      db
        .select({ from_node_id: WorkflowEdgeTable.from_node_id, to_node_id: WorkflowEdgeTable.to_node_id })
        .from(WorkflowEdgeTable)
        .where(eq(WorkflowEdgeTable.workflow_id, workflowID))
        .all(),
    )
    const adj = new Map<string, string[]>()
    for (const e of edges) {
      const list = adj.get(e.from_node_id)
      if (list) list.push(e.to_node_id)
      else adj.set(e.from_node_id, [e.to_node_id])
    }
    const stack = [start]
    const seen = new Set<string>()
    while (stack.length > 0) {
      const cur = stack.pop()!
      if (cur === target) return true
      if (seen.has(cur)) continue
      seen.add(cur)
      const nexts = adj.get(cur)
      if (nexts) for (const n of nexts) stack.push(n)
    }
    return false
  }

  /** Validate endpoint existence + workflow scoping + acyclicity for a
   *  prospective edge. Throws `WorkflowGraphInvariantError` on violation;
   *  callers are expected to emit `edge.rejected` with the same reason code. */
  function assertEdgeInvariants(input: { workflowID: string; from_node_id: string; to_node_id: string }) {
    if (input.from_node_id === input.to_node_id) {
      throw new WorkflowGraphInvariantError(input.workflowID, "self_loop", {
        node_id: input.from_node_id,
      })
    }
    const endpoints = Database.use((db) =>
      db
        .select({ id: WorkflowNodeTable.id, workflow_id: WorkflowNodeTable.workflow_id })
        .from(WorkflowNodeTable)
        .where(inArray(WorkflowNodeTable.id, [input.from_node_id, input.to_node_id]))
        .all(),
    )
    const byID = new Map(endpoints.map((n) => [n.id, n]))
    const fromRow = byID.get(input.from_node_id)
    const toRow = byID.get(input.to_node_id)
    if (!fromRow) {
      throw new WorkflowGraphInvariantError(input.workflowID, "from_node_missing", {
        node_id: input.from_node_id,
      })
    }
    if (!toRow) {
      throw new WorkflowGraphInvariantError(input.workflowID, "to_node_missing", {
        node_id: input.to_node_id,
      })
    }
    if (fromRow.workflow_id !== input.workflowID || toRow.workflow_id !== input.workflowID) {
      throw new WorkflowGraphInvariantError(input.workflowID, "cross_workflow", {
        from_node_id: input.from_node_id,
        from_workflow_id: fromRow.workflow_id,
        to_node_id: input.to_node_id,
        to_workflow_id: toRow.workflow_id,
      })
    }
    // Cycle check: a new edge from→to introduces a cycle iff `to` can already
    // reach `from` via existing edges.
    if (canReach(input.workflowID, input.to_node_id, input.from_node_id)) {
      throw new WorkflowGraphInvariantError(input.workflowID, "cycle", {
        from_node_id: input.from_node_id,
        to_node_id: input.to_node_id,
      })
    }
  }

  export const create = fn(
    z.object({
      session_id: z.string(),
      title: z.string(),
      config: z.record(z.string(), z.any()).optional(),
      summary: Summary.optional(),
      nodes: z
        .array(
          z.object({
            id: z.string().optional(),
            session_id: z.string().optional(),
            title: z.string(),
            agent: z.string(),
            model: Node.shape.model.optional(),
            config: z.record(z.string(), z.any()).optional(),
            status: WorkflowNodeStatus.optional(),
            result_status: WorkflowNodeResultStatus.optional(),
            fail_reason: z.string().optional(),
            action_count: z.number().int().nonnegative().optional(),
            attempt: z.number().int().nonnegative().optional(),
            max_attempts: z.number().int().positive().optional(),
            max_actions: z.number().int().positive().optional(),
            state_json: z.record(z.string(), z.any()).optional(),
            result_json: z.record(z.string(), z.any()).optional(),
            position: z.number().int().nonnegative().optional(),
          }),
        )
        .optional(),
      edges: z
        .array(
          z.object({
            id: z.string().optional(),
            from_node_id: z.string(),
            to_node_id: z.string(),
            label: z.string().optional(),
            config: z.record(z.string(), z.any()).optional(),
          }),
        )
        .optional(),
      checkpoints: z
        .array(
          z.object({
            id: z.string().optional(),
            node_id: z.string(),
            label: z.string(),
            status: WorkflowCheckpointStatus.optional(),
            config: z.record(z.string(), z.any()).optional(),
            result_json: z.record(z.string(), z.any()).optional(),
          }),
        )
        .optional(),
    }),
    async (input) => {
      await state()
      const workflow = Database.transaction((tx) => {
        const row = tx
          .insert(WorkflowTable)
          .values({
            id: workflowID(),
            session_id: input.session_id,
            title: input.title,
            status: "pending",
            config: input.config,
            summary: input.summary,
          })
          .returning()
          .get()
        if (!row) throw new Error("Failed to create workflow")
        const created = fromWorkflowRow(row)

        for (const [index, node] of (input.nodes ?? []).entries()) {
          tx.insert(WorkflowNodeTable).values({
            id: node.id ?? nodeID(),
            workflow_id: created.id,
            session_id: node.session_id,
            title: node.title,
            agent: node.agent,
            model: node.model,
            config: node.config,
            status: node.status ?? "pending",
            result_status: node.result_status ?? "unknown",
            fail_reason: node.fail_reason,
            action_count: node.action_count ?? 0,
            attempt: node.attempt ?? 0,
            max_attempts: node.max_attempts ?? 1,
            max_actions: node.max_actions ?? 20,
            state_json: node.state_json,
            result_json: node.result_json,
            position: node.position ?? index,
          }).run()
        }

        for (const edge of input.edges ?? []) {
          tx.insert(WorkflowEdgeTable).values({
            id: edge.id ?? edgeID(),
            workflow_id: created.id,
            from_node_id: edge.from_node_id,
            to_node_id: edge.to_node_id,
            label: edge.label,
            config: edge.config,
          }).run()
        }

        for (const checkpoint of input.checkpoints ?? []) {
          tx.insert(WorkflowCheckpointTable).values({
            id: checkpoint.id ?? checkpointID(),
            workflow_id: created.id,
            node_id: checkpoint.node_id,
            label: checkpoint.label,
            status: checkpoint.status ?? "pending",
            config: checkpoint.config,
            result_json: checkpoint.result_json,
          }).run()
        }

        return created
      })

      Database.effect(async () => {
        await Bus.publish(Event.Created, { info: workflow })
        await writeEvent({
          workflowID: workflow.id,
          sessionID: workflow.session_id,
          source: "runtime",
          kind: "workflow.created",
          payload: {
            title: workflow.title,
          },
        })
        const snapshot = await get(workflow.id)
        for (const node of snapshot.nodes) {
          await Bus.publish(Event.NodeCreated, { info: node })
        }
        for (const edge of snapshot.edges) {
          await Bus.publish(Event.EdgeCreated, { info: edge })
        }
        for (const checkpoint of snapshot.checkpoints) {
          await Bus.publish(Event.CheckpointUpdated, { info: checkpoint })
        }
      })

      return workflow
    },
  )

  export const createNode = fn(
    z.object({
      workflowID: z.string(),
      session_id: z.string().optional(),
      title: z.string(),
      agent: z.string(),
      model: Node.shape.model.optional(),
      config: z.record(z.string(), z.any()).optional(),
      status: WorkflowNodeStatus.optional(),
      result_status: WorkflowNodeResultStatus.optional(),
      max_attempts: z.number().int().positive().optional(),
      max_actions: z.number().int().positive().optional(),
      position: z.number().int().nonnegative().optional(),
    }),
    async (input) => {
      await state()
      const row = Database.use((db) =>
        db
          .insert(WorkflowNodeTable)
          .values({
            id: nodeID(),
            workflow_id: input.workflowID,
            session_id: input.session_id,
            title: input.title,
            agent: input.agent,
            model: input.model,
            config: input.config,
            status: input.status ?? "pending",
            result_status: input.result_status ?? "unknown",
            max_attempts: input.max_attempts ?? 1,
            max_actions: input.max_actions ?? 20,
            position: input.position ?? 0,
          })
          .returning()
          .get(),
      )
      if (!row) throw new Error("Failed to create workflow node")
      const info = fromNodeRow(row)
      Database.effect(async () => {
        await Bus.publish(Event.NodeCreated, { info })
        await writeEvent({
          workflowID: info.workflow_id,
          nodeID: info.id,
          sessionID: info.session_id,
          source: "orchestrator",
          kind: "node.created",
          payload: {
            title: info.title,
            agent: info.agent,
          },
        })
        // Topology change: bump graph_rev so in-flight masters can detect
        // upstream drift relative to the graph they planned against.
        await touchWorkflow({ workflowID: info.workflow_id, bumpGraphRev: true })
      })
      return info
    },
  )

  export const createEdge = fn(
    z.object({
      workflowID: z.string(),
      from_node_id: z.string(),
      to_node_id: z.string(),
      label: z.string().optional(),
      config: z.record(z.string(), z.any()).optional(),
      from_port: z.string().optional(),
      to_port: z.string().optional(),
      required: z.boolean().optional(),
    }),
    async (input) => {
      // Pre-flight DAG + scoping validation. On failure we emit a structured
      // `edge.rejected` event (best-effort; failures during the rejection
      // event write are swallowed) and re-throw so the caller can react.
      try {
        assertEdgeInvariants({
          workflowID: input.workflowID,
          from_node_id: input.from_node_id,
          to_node_id: input.to_node_id,
        })
      } catch (error) {
        if (error instanceof WorkflowGraphInvariantError) {
          try {
            await writeEvent({
              workflowID: input.workflowID,
              source: "runtime",
              kind: "edge.rejected",
              payload: {
                reason: error.reason,
                from_node_id: input.from_node_id,
                to_node_id: input.to_node_id,
                ...(error.detail ?? {}),
              },
            })
          } catch (writeError) {
            log.warn("failed to record edge.rejected event", { workflowID: input.workflowID, writeError })
          }
        }
        throw error
      }

      const row = Database.use((db) =>
        db
          .insert(WorkflowEdgeTable)
          .values({
            id: edgeID(),
            workflow_id: input.workflowID,
            from_node_id: input.from_node_id,
            to_node_id: input.to_node_id,
            label: input.label,
            config: input.config,
            from_port: input.from_port,
            to_port: input.to_port,
            ...(input.required !== undefined ? { required: input.required ? 1 : 0 } : {}),
          })
          .returning()
          .get(),
      )
      if (!row) throw new Error("Failed to create workflow edge")
      const info = fromEdgeRow(row)
      Database.effect(async () => {
        await Bus.publish(Event.EdgeCreated, { info })
        await writeEvent({
          workflowID: info.workflow_id,
          source: "orchestrator",
          kind: "edge.created",
          payload: {
            from_node_id: info.from_node_id,
            to_node_id: info.to_node_id,
            label: info.label,
            from_port: info.from_port,
            to_port: info.to_port,
            required: info.required,
          },
        })
        // Topology change: bump graph_rev (see createNode for rationale).
        await touchWorkflow({ workflowID: info.workflow_id, bumpGraphRev: true })
      })
      return info
    },
  )

  export const createCheckpoint = fn(
    z.object({
      workflowID: z.string(),
      node_id: z.string(),
      label: z.string(),
      status: WorkflowCheckpointStatus.optional(),
      config: z.record(z.string(), z.any()).optional(),
      result_json: z.record(z.string(), z.any()).optional(),
    }),
    async (input) => {
      const row = Database.use((db) =>
        db
          .insert(WorkflowCheckpointTable)
          .values({
            id: checkpointID(),
            workflow_id: input.workflowID,
            node_id: input.node_id,
            label: input.label,
            status: input.status ?? "pending",
            config: input.config,
            result_json: input.result_json,
          })
          .returning()
          .get(),
      )
      if (!row) throw new Error("Failed to create workflow checkpoint")
      const info = fromCheckpointRow(row)
      Database.effect(async () => {
        await Bus.publish(Event.CheckpointUpdated, { info })
        await writeEvent({
          workflowID: info.workflow_id,
          nodeID: info.node_id,
          source: "orchestrator",
          kind: "checkpoint.created",
          payload: {
            label: info.label,
            status: info.status,
          },
        })
        await touchWorkflow({ workflowID: info.workflow_id })
      })
      return info
    },
  )

  export const getNode = fn(z.string(), async (nodeID) => {
    await state()
    const row = Database.use((db) => db.select().from(WorkflowNodeTable).where(eq(WorkflowNodeTable.id, nodeID)).get())
    if (!row) throw new NotFoundError({ message: `Workflow node not found: ${nodeID}` })
    return fromNodeRow(row)
  })

  export const nodeBySession = fn(z.string(), async (sessionID) => {
    await state()
    const row = Database.use((db) =>
      db.select().from(WorkflowNodeTable).where(eq(WorkflowNodeTable.session_id, sessionID)).get(),
    )
    if (!row) throw new NotFoundError({ message: `Workflow node not found for session: ${sessionID}` })
    return fromNodeRow(row)
  })

  export const get = fn(z.string(), async (workflowID) => {
    await state()
    const workflowRow = Database.use((db) =>
      db.select().from(WorkflowTable).where(eq(WorkflowTable.id, workflowID)).get(),
    )
    if (!workflowRow) throw new NotFoundError({ message: `Workflow not found: ${workflowID}` })
    const workflow = fromWorkflowRow(workflowRow)
    // Prefer the root session's title once auto-titling has upgraded it from the
    // "New session - <timestamp>" placeholder. This lets the workflow card in
    // the sidebar and canvas track the task's actual subject (e.g. "Flash
    // RT3000 firmware and debug boot") instead of a generic placeholder the
    // master agent passed at creation time ("Workflow", "Plan via Sand Table",
    // etc.). Failures fall back silently to the stored workflow title.
    try {
      const session = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const svc = yield* Session.Service
          return yield* svc.get(SessionID.make(workflow.session_id))
        }),
      )
      if (session?.title && !Session.isDefaultTitle(session.title)) {
        workflow.title = session.title
      }
    } catch {
      // Swallow — workflow snapshot should still be usable even if session
      // lookup fails (e.g. archived, transient DB issue).
    }
    const rows = Database.use((db) => ({
      nodes: db
        .select()
        .from(WorkflowNodeTable)
        .where(eq(WorkflowNodeTable.workflow_id, workflowID))
        .orderBy(WorkflowNodeTable.position)
        .all(),
      edges: db.select().from(WorkflowEdgeTable).where(eq(WorkflowEdgeTable.workflow_id, workflowID)).all(),
      checkpoints: db
        .select()
        .from(WorkflowCheckpointTable)
        .where(eq(WorkflowCheckpointTable.workflow_id, workflowID))
        .all(),
      events: db
        .select()
        .from(WorkflowEventTable)
        .where(eq(WorkflowEventTable.workflow_id, workflowID))
        .orderBy(desc(WorkflowEventTable.id))
        .limit(100)
        .all(),
    }))
    const events = rows.events.toReversed().map(fromEventRow)
    const nodes = rows.nodes.map(fromNodeRow)
    return {
      workflow,
      runtime: runtime({
        workflow,
        nodes,
        events,
      }),
      nodes,
      edges: rows.edges.map(fromEdgeRow),
      checkpoints: rows.checkpoints.map(fromCheckpointRow),
      events,
      cursor: events.at(-1)?.id ?? 0,
    }
  })

  export const bySession = fn(z.string(), async (sessionID) => {
    await state()
    // When multiple workflows exist for a session (e.g. boot placeholder + agent-created),
    // prefer the most recently updated one (which has actual nodes).
    const direct = Database.use((db) =>
      db
        .select()
        .from(WorkflowTable)
        .where(eq(WorkflowTable.session_id, sessionID))
        .orderBy(desc(WorkflowTable.time_updated))
        .get(),
    )
    if (direct) return get(direct.id)
    const node = await nodeBySession(sessionID).catch(() => undefined)
    if (!node) throw new NotFoundError({ message: `Workflow not found for session: ${sessionID}` })
    return get(node.workflow_id)
  })

  export const removeBySession = fn(z.string(), async (sessionID) => {
    await state()
    const snap = await bySession(sessionID)
    const ids = [
      snap.workflow.session_id,
      ...snap.nodes.map((node) => node.session_id).filter((id): id is string => !!id),
    ]
    for (const id of ids) {
      await AppRuntime.runPromise(
        Effect.gen(function* () {
          const sp = yield* SessionPrompt.Service
          yield* sp.cancel(SessionID.make(id))
        }),
      ).catch(() => undefined)
    }
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        const s = yield* Session.Service
        yield* s.remove(SessionID.make(snap.workflow.session_id))
      }),
    )
    return true
  })

  export const read = fn(
    z.object({
      workflowID: z.string(),
      cursor: z.number().int().nonnegative().optional(),
      /** Audience filter for the returned event feed. Default `orchestrator`
       *  (master-facing) — drops `ui` telemetry so the master doesn't waste
       *  context on tool/skill step-by-step noise. UI clients should pass
       *  `all` to get the full timeline. */
      audience: z.enum(["orchestrator", "ui", "all"]).optional(),
    }),
    async (input) => {
      await state()
      const workflowRow = Database.use((db) =>
        db.select().from(WorkflowTable).where(eq(WorkflowTable.id, input.workflowID)).get(),
      )
      if (!workflowRow) throw new NotFoundError({ message: `Workflow not found: ${input.workflowID}` })
      const rawEvents = Database.use((db) =>
        db
          .select()
          .from(WorkflowEventTable)
          .where(and(eq(WorkflowEventTable.workflow_id, input.workflowID), gt(WorkflowEventTable.id, input.cursor ?? 0)))
          .orderBy(WorkflowEventTable.id)
          .all(),
      )
      const aud = input.audience ?? "orchestrator"
      const events = rawEvents.filter((row) => {
        if (aud === "all") return true
        const a = audienceOf(row.kind)
        return aud === "ui" ? a !== "orchestrator" : a !== "ui"
      })
      const changedNodeIDs = [...new Set(events.map((row) => row.node_id).filter(Boolean))] as string[]
      const changedNodes = changedNodeIDs.length
        ? Database.use((db) =>
            db.select().from(WorkflowNodeTable).where(inArray(WorkflowNodeTable.id, changedNodeIDs)).all(),
          ).map(fromNodeRow)
        : []
      const changedEdge = events.some((row) => row.kind.startsWith("edge."))
      const changedCheckpoint = events.some((row) => row.kind.startsWith("checkpoint."))
      const includeWorkflow = events.some((row) => row.kind.startsWith("workflow.") || row.kind.startsWith("node."))
      const info = fromWorkflowRow(workflowRow)
      const feed = events.map((row) => fromEventRow(row))
      return {
        workflow: includeWorkflow ? info : undefined,
        runtime: includeWorkflow
          ? runtime({
              workflow: info,
              nodes: changedNodes.length > 0
                ? changedNodes
                : Database.use((db) =>
                    db.select().from(WorkflowNodeTable).where(eq(WorkflowNodeTable.workflow_id, input.workflowID)).all(),
                  ).map(fromNodeRow),
              events: input.cursor === undefined
                ? feed
                : Database.use((db) =>
                    db
                      .select()
                      .from(WorkflowEventTable)
                      .where(eq(WorkflowEventTable.workflow_id, input.workflowID))
                      .orderBy(WorkflowEventTable.id)
                      .all(),
                  ).map(fromEventRow),
            })
          : undefined,
        nodes: changedNodes,
        edges: changedEdge
          ? Database.use((db) => db.select().from(WorkflowEdgeTable).where(eq(WorkflowEdgeTable.workflow_id, input.workflowID)).all()).map(fromEdgeRow)
          : [],
        checkpoints: changedCheckpoint
          ? Database.use((db) =>
              db.select().from(WorkflowCheckpointTable).where(eq(WorkflowCheckpointTable.workflow_id, input.workflowID)).all(),
            ).map(fromCheckpointRow)
          : [],
        events: feed,
        cursor: events.at(-1)?.id ?? input.cursor ?? 0,
      }
    },
  )

  export const patchNode = fn(
    z.object({
      nodeID: z.string(),
      source: z.string(),
      patch: z.object({
        status: WorkflowNodeStatus.optional(),
        result_status: WorkflowNodeResultStatus.optional(),
        fail_reason: z.string().nullable().optional(),
        session_id: z.string().nullable().optional(),
        model: Node.shape.model.nullable().optional(),
        config: z.object({
          mode: z.enum(["replace", "merge"]).optional(),
          value: z.record(z.string(), z.any()).optional(),
        }).optional(),
        state_json: z.object({
          mode: z.enum(["replace", "merge"]).optional(),
          value: z.record(z.string(), z.any()).optional(),
        }).optional(),
        result_json: z.object({
          mode: z.enum(["replace", "merge"]).optional(),
          value: z.record(z.string(), z.any()).optional(),
        }).optional(),
        attempt_delta: z.number().int().optional(),
        action_count: z.number().int().nonnegative().optional(),
        max_attempts: z.number().int().positive().optional(),
        max_actions: z.number().int().positive().optional(),
        title: z.string().optional(),
      }),
      action_delta: z.number().int().optional(),
      event: z
        .object({
          kind: z.string(),
          target_node_id: z.string().optional(),
          payload: z.record(z.string(), z.any()).optional(),
        })
        .optional(),
    }),
    async (input) => {
      await state()
      // State-machine guard. runtime-sourced patches are allowed to force any
      // state (stall detection, limit breaches, restart logic need this);
      // orchestrator / node sources must walk legal transitions only. On
      // rejection we emit `node.transition_rejected` so the orchestrator
      // learns about it instead of silently dropping the intent.
      type Rejection =
        | {
            type: "transition"
            from: WorkflowNodeStatus
            to: WorkflowNodeStatus
            nodeID: string
            workflow_id: string
          }
        | {
            type: "output_invalid"
            nodeID: string
            workflow_id: string
            reason: string
            missing?: string[]
          }
        | {
            type: "checkpoint_blocked"
            nodeID: string
            workflow_id: string
            blockers: Array<{ id: string; label: string; status: string }>
          }
      let rejection: Rejection | undefined
      const row = Database.transaction((tx) => {
        const found = tx.select().from(WorkflowNodeTable).where(eq(WorkflowNodeTable.id, input.nodeID)).get()
        if (!found) throw new NotFoundError({ message: `Workflow node not found: ${input.nodeID}` })

        const current = fromNodeRow(found)
        const requestedStatus = input.patch.status ?? current.status
        if (
          requestedStatus !== current.status &&
          input.source !== "runtime" &&
          !isLegalNodeTransition(current.status, requestedStatus)
        ) {
          rejection = {
            type: "transition",
            from: current.status,
            to: requestedStatus,
            nodeID: current.id,
            workflow_id: current.workflow_id,
          }
          return current
        }

        // P1.2 completion guards. Only apply when the caller is trying to
        // mark the node `completed`. runtime-sourced forces still bypass —
        // stall/limit handlers may need to end a node with partial output.
        if (
          requestedStatus === "completed" &&
          current.status !== "completed" &&
          input.source !== "runtime"
        ) {
          // Simulate the result_json merge so we validate the final value,
          // not the existing one.
          const mergedResult =
            input.patch.result_json === undefined
              ? current.result_json
              : mergeJSON(
                  current.result_json,
                  input.patch.result_json.value,
                  input.patch.result_json.mode ?? "merge",
                )
          const mergedConfig =
            input.patch.config === undefined
              ? current.config
              : mergeJSON(
                  current.config,
                  input.patch.config.value,
                  input.patch.config.mode ?? "merge",
                )
          const schema = extractOutputSchema(mergedConfig as Record<string, unknown> | null | undefined)
          if (schema) {
            const result = validateOutput(mergedResult as Record<string, unknown> | null | undefined, schema)
            if (!result.ok) {
              rejection = {
                type: "output_invalid",
                nodeID: current.id,
                workflow_id: current.workflow_id,
                reason: result.reason,
                missing: result.missing,
              }
              return current
            }
          }
          // Block completion if any attached checkpoint is still pending or
          // explicitly failed. `skipped` and `passed` are both acceptable.
          const openCheckpoints = tx
            .select()
            .from(WorkflowCheckpointTable)
            .where(
              and(
                eq(WorkflowCheckpointTable.node_id, current.id),
                inArray(WorkflowCheckpointTable.status, ["pending", "failed"]),
              ),
            )
            .all()
          if (openCheckpoints.length > 0) {
            rejection = {
              type: "checkpoint_blocked",
              nodeID: current.id,
              workflow_id: current.workflow_id,
              blockers: openCheckpoints.map((cp) => ({
                id: cp.id,
                label: cp.label,
                status: cp.status,
              })),
            }
            return current
          }
        }
        const nextStatus = requestedStatus
        const attempt = current.attempt + (input.patch.attempt_delta ?? 0)
        const actionCount =
          input.patch.action_count ?? current.action_count + (input.action_delta ?? 0)
        const updated = tx
          .update(WorkflowNodeTable)
          .set({
            status: nextStatus,
            result_status: input.patch.result_status ?? current.result_status,
            fail_reason:
              input.patch.fail_reason === undefined ? current.fail_reason : (input.patch.fail_reason ?? null),
            session_id:
              input.patch.session_id === undefined ? current.session_id : (input.patch.session_id ?? null),
            model:
              input.patch.model === undefined ? current.model : (input.patch.model ?? null),
            config:
              input.patch.config === undefined
                ? current.config
                : (mergeJSON(
                    current.config,
                    input.patch.config.value,
                    input.patch.config.mode ?? "merge",
                  ) ?? null),
            state_json:
              input.patch.state_json === undefined
                ? current.state_json
                : (mergeJSON(
                    current.state_json,
                    input.patch.state_json.value,
                    input.patch.state_json.mode ?? "merge",
                  ) ?? null),
            result_json:
              input.patch.result_json === undefined
                ? current.result_json
                : (mergeJSON(
                    current.result_json,
                    input.patch.result_json.value,
                    input.patch.result_json.mode ?? "merge",
                  ) ?? null),
            attempt,
            action_count: actionCount,
            max_attempts: input.patch.max_attempts ?? current.max_attempts,
            max_actions: input.patch.max_actions ?? current.max_actions,
            title: input.patch.title ?? current.title,
            version: current.version + 1,
            time_started: current.time.started ?? (nextStatus === "running" ? Date.now() : null),
            time_completed:
              nextStatus === "completed" || nextStatus === "failed" || nextStatus === "cancelled"
                ? Date.now()
                : current.time.completed,
            time_updated: Date.now(),
          })
          .where(eq(WorkflowNodeTable.id, input.nodeID))
          .returning()
          .get()
        if (!updated) throw new Error("Failed to update workflow node")
        return fromNodeRow(updated)
      })

      if (rejection) {
        if (rejection.type === "transition") {
          await writeEvent({
            workflowID: rejection.workflow_id,
            nodeID: rejection.nodeID,
            target_node_id: rejection.nodeID,
            source: input.source,
            kind: "node.transition_rejected",
            payload: {
              from: rejection.from,
              to: rejection.to,
              requested_by: input.source,
            },
          })
          throw new InvalidNodeTransitionError(rejection.nodeID, rejection.from, rejection.to)
        }
        if (rejection.type === "output_invalid") {
          await writeEvent({
            workflowID: rejection.workflow_id,
            nodeID: rejection.nodeID,
            target_node_id: rejection.nodeID,
            source: input.source,
            kind: "node.output_invalid",
            payload: {
              reason: rejection.reason,
              missing: rejection.missing ?? [],
              requested_by: input.source,
            },
          })
          throw new NodeCompletionBlockedError(rejection.nodeID, rejection.reason, {
            missing: rejection.missing,
          })
        }
        if (rejection.type === "checkpoint_blocked") {
          await writeEvent({
            workflowID: rejection.workflow_id,
            nodeID: rejection.nodeID,
            target_node_id: rejection.nodeID,
            source: input.source,
            kind: "node.blocked",
            payload: {
              reason: "checkpoint_blocked",
              blockers: rejection.blockers,
              requested_by: input.source,
            },
          })
          throw new NodeCompletionBlockedError(rejection.nodeID, "checkpoint_blocked", {
            blockers: rejection.blockers,
          })
        }
      }

      const workflow = await touchWorkflow({
        workflowID: row.workflow_id,
        patch: {
          status: normalizeWorkflowStatus(row.status),
          current_node_id: row.status === "running" ? row.id : null,
          selected_node_id: row.id,
        },
      })
      Database.effect(async () => {
        await Bus.publish(Event.NodeUpdated, { info: row })
        await writeEvent({
          workflowID: row.workflow_id,
          nodeID: row.id,
          sessionID: row.session_id,
          target_node_id: input.event?.target_node_id,
          source: input.source,
          kind: input.event?.kind ?? "node.updated",
          payload: {
            ...(input.event?.payload ?? {}),
            status: row.status,
            result_status: row.result_status,
            action_count: row.action_count,
            attempt: row.attempt,
          },
        })
        if (row.action_count >= row.max_actions) {
          await writeEvent({
            workflowID: row.workflow_id,
            nodeID: row.id,
            sessionID: row.session_id,
            target_node_id: row.id,
            source: "runtime",
            kind: "node.action_limit_reached",
            payload: {
              action_count: row.action_count,
              max_actions: row.max_actions,
            },
          })
        }
        if (row.attempt >= row.max_attempts) {
          await writeEvent({
            workflowID: row.workflow_id,
            nodeID: row.id,
            sessionID: row.session_id,
            target_node_id: row.id,
            source: "runtime",
            kind: "node.attempt_limit_reached",
            payload: {
              attempt: row.attempt,
              max_attempts: row.max_attempts,
            },
          })
        }
        await Bus.publish(Event.Updated, { info: workflow })
      })
      return row
    },
  )

  export const control = fn(
    z.object({
      workflowID: z.string(),
      nodeID: z.string(),
      source: z.string(),
      command: z.enum(["continue", "resume", "retry", "inject_context"]),
      payload: z.record(z.string(), z.any()).optional(),
      /** Optional caller-supplied command id. Mostly for tests; control
       *  always generates one when omitted so ACK tracking works. */
      command_id: z.string().optional(),
      /** Skip dedup guard. Only the stall detector / tests should need this. */
      force: z.boolean().optional(),
    }),
    async (input) => {
      await state()
      const node = await getNode(input.nodeID)
      const fingerprint = commandFingerprint(input.command, input.payload)
      const now = Date.now()

      // P0.3 dedup: if the same (command, payload) was enqueued within the
      // dedup window, return the prior command_id without writing a new event.
      // This absorbs LLM-retry-loop noise where the master fires the same
      // `continue` twice because it forgot it already called the tool.
      const runtimeState = isRec(node.state_json) ? node.state_json : {}
      const recent = Array.isArray(runtimeState.recent_commands)
        ? (runtimeState.recent_commands as Array<Record<string, unknown>>)
        : []
      const duplicate = !input.force
        ? recent.find(
            (entry) =>
              typeof entry?.fingerprint === "string" &&
              entry.fingerprint === fingerprint &&
              typeof entry?.time === "number" &&
              now - (entry.time as number) < COMMAND_DEDUP_WINDOW_MS,
          )
        : undefined
      if (duplicate) {
        log.info("workflow.control deduped", {
          workflowID: input.workflowID,
          nodeID: input.nodeID,
          command: input.command,
          fingerprint,
        })
        return {
          ok: true as const,
          deduped: true as const,
          command_id: typeof duplicate.command_id === "string" ? (duplicate.command_id as string) : undefined,
        }
      }

      const command_id = input.command_id ?? `cmd_${Identifier.create("workspace", "ascending").slice(4)}`

      // P1.1 ACK: track the command in state_json.pending_commands so the
      // slave sees it via pull and can ack it via workflow_update.patch.ack.
      const pending = Array.isArray(runtimeState.pending_commands)
        ? (runtimeState.pending_commands as Array<Record<string, unknown>>).filter((c) =>
            isRec(c) && typeof c.command_id === "string" ? c.command_id !== command_id : true,
          )
        : []
      pending.push({
        command_id,
        command: input.command,
        payload: input.payload ?? {},
        fingerprint,
        issued_by: input.source,
        issued_at: now,
      })

      const nextRecent = [...recent, { command_id, fingerprint, time: now }].slice(-RECENT_COMMANDS_KEEP)

      await patchNode({
        nodeID: input.nodeID,
        source: "runtime",
        patch: {
          state_json: {
            mode: "merge",
            value: {
              pending_commands: pending,
              recent_commands: nextRecent,
            },
          },
        },
      })

      await writeEvent({
        workflowID: input.workflowID,
        nodeID: input.nodeID,
        target_node_id: input.nodeID,
        source: input.source,
        kind: "node.control",
        payload: {
          command_id,
          command: input.command,
          ...(input.payload ?? {}),
        },
      })
      return { ok: true as const, deduped: false as const, command_id }
    },
  )

  /** P1.1 — Acknowledge one or more runtime commands. Slave calls this from
   *  the node session after it has actually applied the command. The entry
   *  is removed from `pending_commands`, and a `node.command_acked` event is
   *  emitted so the orchestrator learns the command reached the slave. */
  export const ackCommand = fn(
    z.object({
      nodeID: z.string(),
      source: z.string(),
      command_ids: z.array(z.string()).nonempty(),
      note: z.string().optional(),
    }),
    async (input) => {
      await state()
      const node = await getNode(input.nodeID)
      const runtimeState = isRec(node.state_json) ? node.state_json : {}
      const pending = Array.isArray(runtimeState.pending_commands)
        ? (runtimeState.pending_commands as Array<Record<string, unknown>>)
        : []
      if (pending.length === 0) {
        return { ok: true as const, acked: [] as string[] }
      }
      const toAck = new Set(input.command_ids)
      const acked: Array<Record<string, unknown>> = []
      const remaining: Array<Record<string, unknown>> = []
      for (const entry of pending) {
        if (isRec(entry) && typeof entry.command_id === "string" && toAck.has(entry.command_id as string)) {
          acked.push(entry)
        } else {
          remaining.push(entry)
        }
      }
      if (acked.length === 0) {
        return { ok: true as const, acked: [] as string[] }
      }
      await patchNode({
        nodeID: node.id,
        source: "runtime",
        patch: {
          state_json: {
            mode: "merge",
            value: { pending_commands: remaining },
          },
        },
      })
      for (const entry of acked) {
        await writeEvent({
          workflowID: node.workflow_id,
          nodeID: node.id,
          sessionID: node.session_id,
          source: input.source,
          kind: "node.command_acked",
          payload: {
            command_id: entry.command_id,
            command: entry.command,
            ack_note: input.note,
            acked_at: Date.now(),
          },
        })
      }
      return {
        ok: true as const,
        acked: acked.map((e) => e.command_id as string),
      }
    },
  )

  /** P1.3 — Slave opens a structured need. Creates an entry in
   *  state_json.open_needs, emits `node.need_opened`, and auto-transitions
   *  the node to `waiting` so the orchestrator reacts. `required_by` lets the
   *  slave state which action is blocked. */
  export const openNeed = fn(
    z.object({
      nodeID: z.string(),
      source: z.string(),
      title: z.string(),
      prompt: z.string().optional(),
      kind: z.enum(["context", "approval", "tool", "other"]).optional(),
      required_by: z.string().optional(),
      /** If omitted, a fresh need_id is generated. */
      need_id: z.string().optional(),
    }),
    async (input) => {
      await state()
      const node = await getNode(input.nodeID)
      const runtimeState = isRec(node.state_json) ? node.state_json : {}
      const open = Array.isArray(runtimeState.open_needs)
        ? (runtimeState.open_needs as Array<Record<string, unknown>>)
        : []
      // Dedup by title so a slave that repeatedly reports the same need
      // doesn't stack up duplicates. New prompt overrides the old one.
      const existing = open.find((entry) => isRec(entry) && entry.title === input.title && !entry.resolved_at)
      const need_id = existing && typeof existing.need_id === "string"
        ? (existing.need_id as string)
        : (input.need_id ?? `nd_${Identifier.create("workspace", "ascending").slice(4)}`)
      const entry = {
        need_id,
        title: input.title,
        prompt: input.prompt ?? null,
        kind: input.kind ?? "context",
        required_by: input.required_by ?? null,
        opened_by: input.source,
        opened_at: Date.now(),
      }
      const nextOpen = existing
        ? open.map((e) => (isRec(e) && e.need_id === need_id ? entry : e))
        : [...open, entry]

      // Transition to waiting if currently running. patchNode merges the
      // state_json and writes the transition atomically.
      const shouldWait = node.status === "running"
      const updated = await patchNode({
        nodeID: node.id,
        source: "node",
        patch: {
          ...(shouldWait ? { status: "waiting" as const } : {}),
          state_json: {
            mode: "merge",
            value: { open_needs: nextOpen },
          },
        },
        event: {
          kind: "node.need_opened",
          payload: {
            need_id,
            title: input.title,
            kind: entry.kind,
            required_by: entry.required_by,
          },
        },
      })
      return { ok: true as const, need_id, node: updated }
    },
  )

  /** P1.3 — Orchestrator fulfills a need by supplying context. Moves the
   *  entry from open_needs to resolved_needs, emits `node.need_fulfilled`,
   *  and injects the fulfillment as an `inject_context` control command so
   *  the slave wakes up and continues. */
  export const fulfillNeed = fn(
    z.object({
      nodeID: z.string(),
      source: z.string(),
      need_id: z.string(),
      context: z.string(),
      resolution_note: z.string().optional(),
    }),
    async (input) => {
      await state()
      const node = await getNode(input.nodeID)
      const runtimeState = isRec(node.state_json) ? node.state_json : {}
      const open = Array.isArray(runtimeState.open_needs)
        ? (runtimeState.open_needs as Array<Record<string, unknown>>)
        : []
      const resolved = Array.isArray(runtimeState.resolved_needs)
        ? (runtimeState.resolved_needs as Array<Record<string, unknown>>)
        : []
      const entry = open.find((e) => isRec(e) && e.need_id === input.need_id)
      if (!entry) {
        throw new Error(`No open need with id ${input.need_id} for node ${input.nodeID}.`)
      }
      const stamped = {
        ...entry,
        resolved_by: input.source,
        resolved_at: Date.now(),
        resolution_note: input.resolution_note ?? null,
        context: input.context,
      }
      const nextOpen = open.filter((e) => !isRec(e) || e.need_id !== input.need_id)
      const nextResolved = [...resolved, stamped].slice(-RECENT_COMMANDS_KEEP * 2)

      await patchNode({
        nodeID: node.id,
        source: "runtime",
        patch: {
          state_json: {
            mode: "merge",
            value: { open_needs: nextOpen, resolved_needs: nextResolved },
          },
        },
        event: {
          kind: "node.need_fulfilled",
          payload: {
            need_id: input.need_id,
            title: entry.title,
            resolved_by: input.source,
          },
        },
      })

      // Auto-wake via inject_context. If there are no remaining open needs
      // we also want to flip the node back to running so the slave picks up.
      const command = await control({
        workflowID: node.workflow_id,
        nodeID: node.id,
        source: input.source,
        command: "inject_context",
        payload: {
          need_id: input.need_id,
          context: input.context,
          resolution_note: input.resolution_note,
        },
      })

      if (nextOpen.length === 0 && node.status === "waiting") {
        await patchNode({
          nodeID: node.id,
          source: "runtime",
          patch: { status: "running" },
          event: {
            kind: "node.need_resolved",
            payload: { need_id: input.need_id },
          },
        })
      }

      return {
        ok: true as const,
        need_id: input.need_id,
        remaining_open: nextOpen.length,
        command_id: command.command_id,
      }
    },
  )

  export const pauseNode = fn(
    z.object({
      nodeID: z.string(),
      source: z.string(),
      reason: z.string().optional(),
    }),
    async (input) => {
      await state()
      const node = await getNode(input.nodeID)
      if (node.status === "cancelled") return node
      if (node.session_id) {
        const sessionID = SessionID.make(node.session_id)
        await AppRuntime.runPromise(
          Effect.gen(function* () {
            const sp = yield* SessionPrompt.Service
            yield* sp.cancel(sessionID)
          }),
        ).catch(() => undefined)
      }
      return patchNode({
        nodeID: node.id,
        source: input.source,
        patch: {
          status: "paused",
        },
        event: {
          kind: "node.paused",
          payload: input.reason
            ? {
                reason: input.reason,
              }
            : undefined,
        },
      })
    },
  )

  export const abortNode = fn(
    z.object({
      nodeID: z.string(),
      source: z.string(),
      reason: z.string().optional(),
    }),
    async (input) => {
      await state()
      const node = await getNode(input.nodeID)
      if (node.status === "cancelled") return node
      if (node.session_id) {
        const sessionID = SessionID.make(node.session_id)
        await AppRuntime.runPromise(
          Effect.gen(function* () {
            const sp = yield* SessionPrompt.Service
            yield* sp.cancel(sessionID)
          }),
        ).catch(() => undefined)
      }
      return patchNode({
        nodeID: node.id,
        source: input.source,
        patch: {
          status: "cancelled",
          fail_reason: input.reason ?? node.fail_reason ?? "aborted_by_orchestrator",
        },
        event: {
          kind: "node.aborted",
          payload: input.reason
            ? {
                reason: input.reason,
              }
            : undefined,
        },
      })
    },
  )

  export const pull = fn(
    z.object({
      nodeID: z.string(),
      cursor: z.number().int().nonnegative().optional(),
      /** Filter events by intended audience. Default `orchestrator` — slave
       *  pulls only orchestrator/both events (control commands + life-cycle).
       *  Pass `all` to include ui telemetry (debug only). */
      audience: z.enum(["orchestrator", "ui", "all"]).optional(),
    }),
    async (input) => {
      await state()
      const node = await getNode(input.nodeID)
      const rows = Database.use((db) =>
        db
          .select()
          .from(WorkflowEventTable)
          .where(
            and(
              eq(WorkflowEventTable.workflow_id, node.workflow_id),
              eq(WorkflowEventTable.target_node_id, node.id),
              gt(WorkflowEventTable.id, input.cursor ?? 0),
            ),
          )
          .orderBy(WorkflowEventTable.id)
          .all(),
      )
      const aud = input.audience ?? "orchestrator"
      const events = rows
        .map(fromEventRow)
        .filter((event) =>
          aud === "all"
            ? true
            : aud === "ui"
              ? event.audience !== "orchestrator"
              : event.audience !== "ui",
        )
      await writeEvent({
        workflowID: node.workflow_id,
        nodeID: node.id,
        sessionID: node.session_id,
        source: "node",
        kind: "node.pulled",
        payload: {
          cursor: input.cursor ?? 0,
          pending: events.length,
          audience: aud,
        },
      })
      // Surface the structured ACK queue to slave, alongside open_needs and
      // resolved_needs. See P1.1 / P1.3 — these live in state_json by
      // convention so no schema migration is required.
      const runtimeState = isRec(node.state_json) ? node.state_json : {}
      const pending_commands = Array.isArray(runtimeState.pending_commands)
        ? (runtimeState.pending_commands as unknown[])
        : []
      const open_needs = Array.isArray(runtimeState.open_needs)
        ? (runtimeState.open_needs as unknown[])
        : []
      const resolved_needs = Array.isArray(runtimeState.resolved_needs)
        ? (runtimeState.resolved_needs as unknown[])
        : []
      return {
        node,
        cursor: rows.at(-1)?.id ?? input.cursor ?? 0,
        events,
        pending_commands,
        open_needs,
        resolved_needs,
      }
    },
  )

  export const setCheckpoint = fn(
    z.object({
      checkpointID: z.string(),
      status: WorkflowCheckpointStatus,
      result_json: z.record(z.string(), z.any()).optional(),
    }),
    async (input) => {
      await state()
      const row = Database.use((db) =>
        db
          .update(WorkflowCheckpointTable)
          .set({
            status: input.status,
            result_json: input.result_json,
            time_updated: Date.now(),
          })
          .where(eq(WorkflowCheckpointTable.id, input.checkpointID))
          .returning()
          .get(),
      )
      if (!row) throw new NotFoundError({ message: `Workflow checkpoint not found: ${input.checkpointID}` })
      const info = fromCheckpointRow(row)
      Database.effect(async () => {
        await Bus.publish(Event.CheckpointUpdated, { info })
        await writeEvent({
          workflowID: info.workflow_id,
          nodeID: info.node_id,
          source: "runtime",
          kind: `checkpoint.${info.status}`,
          payload: {
            checkpoint_id: info.id,
            label: info.label,
          },
        })
        await touchWorkflow({ workflowID: info.workflow_id })
      })
      return info
    },
  )

  const runSessionDiff = (sessionID: SessionID) =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const s = yield* Session.Service
        return yield* s.diff(sessionID)
      }),
    )

  export const diff = fn(z.string(), async (workflowID) => {
    await state()
    const snapshot = await get(workflowID)
    type DiffEntry = Awaited<ReturnType<typeof runSessionDiff>>[number]
    const byFile = new Map<string, DiffEntry>()

    for (const sessionID of [snapshot.workflow.session_id, ...snapshot.nodes.map((node) => node.session_id).filter(Boolean)]) {
      if (!sessionID) continue
      const diffs = await runSessionDiff(SessionID.make(sessionID))
      for (const diff of diffs) {
        const existing = byFile.get(diff.file)
        if (!existing) {
          byFile.set(diff.file, diff)
          continue
        }
        byFile.set(diff.file, {
          ...existing,
          additions: existing.additions + diff.additions,
          deletions: existing.deletions + diff.deletions,
          status:
            existing.status === diff.status
              ? existing.status
              : existing.status === "deleted" && diff.status === "added"
                ? "modified"
                : "modified",
        })
      }
    }

    return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file))
  })

  export const codeChanges = fn(z.string(), async (nodeID) => {
    await state()
    const node = await getNode(nodeID)
    if (!node.session_id) return []
    return runSessionDiff(SessionID.make(node.session_id))
  })
}
