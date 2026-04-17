import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Database, eq, desc, and, inArray, gt, sql } from "@/storage/db"
import { Identifier } from "@/id/id"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { MessageV2 } from "@/session/message-v2"
import { NotFoundError } from "@/storage/db"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { fn } from "@/util/fn"
import z from "zod"
import {
  WorkflowCheckpointTable,
  WorkflowEdgeTable,
  WorkflowEventTable,
  WorkflowNodeTable,
  WorkflowTable,
  type WorkflowCheckpointStatus,
  type WorkflowNodeResultStatus,
  type WorkflowNodeStatus,
  type WorkflowStatus,
} from "./workflow.sql"

const log = Log.create({ service: "workflow" })

const workflowID = () => `wfl_${Identifier.create("workspace", false).slice(4)}`
const nodeID = () => `wfn_${Identifier.create("workspace", false).slice(4)}`
const edgeID = () => `wfe_${Identifier.create("workspace", false).slice(4)}`
const checkpointID = () => `wfc_${Identifier.create("workspace", false).slice(4)}`

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

function mergeJSON(
  current: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
  mode: "replace" | "merge",
) {
  if (!next) return current
  if (mode === "replace") return next
  return { ...(current ?? {}), ...next }
}

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
  } satisfies Run
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
  } satisfies Run
}

export namespace Workflow {
  export const Info = z
    .object({
      id: z.string(),
      session_id: z.string(),
      title: z.string(),
      status: WorkflowStatus,
      current_node_id: z.string().optional(),
      selected_node_id: z.string().optional(),
      version: z.number().int().nonnegative(),
      config: z.record(z.string(), z.any()).optional(),
      summary: z.record(z.string(), z.any()).optional(),
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

  export const EventInfo = z
    .object({
      id: z.number().int().nonnegative(),
      workflow_id: z.string(),
      node_id: z.string().optional(),
      session_id: z.string().optional(),
      target_node_id: z.string().optional(),
      kind: z.string(),
      source: z.string(),
      payload: z.record(z.string(), z.any()),
      time_created: z.number(),
    })
    .meta({ ref: "WorkflowEvent" })
  export type EventInfo = z.infer<typeof EventInfo>

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
    await SessionPrompt.prompt({
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
    const msg = await MessageV2.get({
      sessionID: info.sessionID,
      messageID: info.id,
    }).catch(() => undefined)
    if (!msg) return
    const rep = report(node, msg)
    await patchRun({
      nodeID: node.id,
      run: (node) => {
        const curr = runState(node)
        const hist = [...(curr.attempt_history ?? []).filter((item) => item.message_id !== rep.message_id), rep]
        return {
          last_at: rep.time,
          last_attempt: rep,
          attempt_history: hist,
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
  }

  async function queueWake(input: Wake) {
    const current = state()
    const key = `${input.workflowID}:${input.kind}:${input.nodeID ?? "root"}`
    const seen = current.seen[key]
    if (seen && input.time - seen < wakeDelay) return
    current.seen[key] = input.time

    const status = SessionStatus.get(SessionID.make(input.sessionID))
    if (status.type === "idle") {
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

  const state = Instance.state(() => {
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
  }, async (entry) => {
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
      time_created: row.time_created,
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
    return {
      id: row.id,
      workflow_id: row.workflow_id,
      node_id: row.node_id ?? undefined,
      session_id: row.session_id ?? undefined,
      target_node_id: row.target_node_id ?? undefined,
      kind: row.kind,
      source: row.source,
      payload: row.payload,
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
    return {
      phase,
      active_node_id: active?.id,
      waiting_node_ids: waiting,
      failed_node_ids: failed,
      command_count: input.events.filter((event) => event.kind === "node.control").length,
      update_count: input.events.filter((event) => event.kind === "node.updated").length,
      pull_count: input.events.filter((event) => event.kind === "node.pulled").length,
      last_event_id: input.events.at(-1)?.id ?? 0,
    }
  }

  async function writeEvent(input: {
    workflowID: string
    nodeID?: string
    sessionID?: string
    target_node_id?: string
    kind: string
    source: string
    payload?: Record<string, unknown>
  }) {
    const row = Database.use((db) =>
      db
        .insert(WorkflowEventTable)
        .values({
          workflow_id: input.workflowID,
          node_id: input.nodeID,
          session_id: input.sessionID,
          target_node_id: input.target_node_id,
          kind: input.kind,
          source: input.source,
          payload: input.payload ?? {},
        })
        .returning()
        .get(),
    )
    if (!row) throw new Error("Failed to create workflow event")
    const info = fromEventRow(row)
    Database.effect(() => Bus.publish(Event.EventCreated, { info }))
    void Instance.bind(async () => {
      const { Refiner } = await import("@/refiner")
      await Refiner.observeWorkflowEvent(info)
    })().catch((error) => {
      log.warn("failed to observe workflow event with refiner", {
        workflowID: input.workflowID,
        eventID: info.id,
        kind: info.kind,
        error,
      })
    })
    return info
  }

  async function touchWorkflow(input: {
    workflowID: string
    patch?: Partial<{
      status: WorkflowStatus
      current_node_id: string | null
      selected_node_id: string | null
      summary: Record<string, unknown> | null
    }>
  }) {
    const row = Database.use((db) =>
      db
        .update(WorkflowTable)
        .set({
          ...(input.patch?.status ? { status: input.patch.status } : {}),
          ...(input.patch?.current_node_id !== undefined ? { current_node_id: input.patch.current_node_id } : {}),
          ...(input.patch?.selected_node_id !== undefined ? { selected_node_id: input.patch.selected_node_id } : {}),
          ...(input.patch?.summary !== undefined ? { summary: input.patch.summary ?? null } : {}),
          version: sql`${WorkflowTable.version} + 1`,
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

  export const create = fn(
    z.object({
      session_id: z.string(),
      title: z.string(),
      config: z.record(z.string(), z.any()).optional(),
      summary: z.record(z.string(), z.any()).optional(),
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
        await touchWorkflow({ workflowID: info.workflow_id })
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
    }),
    async (input) => {
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
          },
        })
        await touchWorkflow({ workflowID: info.workflow_id })
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
      SessionPrompt.cancel(SessionID.make(id))
    }
    await Session.remove(SessionID.make(snap.workflow.session_id))
    return true
  })

  export const read = fn(
    z.object({
      workflowID: z.string(),
      cursor: z.number().int().nonnegative().optional(),
    }),
    async (input) => {
      await state()
      const workflowRow = Database.use((db) =>
        db.select().from(WorkflowTable).where(eq(WorkflowTable.id, input.workflowID)).get(),
      )
      if (!workflowRow) throw new NotFoundError({ message: `Workflow not found: ${input.workflowID}` })
      const events = Database.use((db) =>
        db
          .select()
          .from(WorkflowEventTable)
          .where(and(eq(WorkflowEventTable.workflow_id, input.workflowID), gt(WorkflowEventTable.id, input.cursor ?? 0)))
          .orderBy(WorkflowEventTable.id)
          .all(),
      )
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
      const feed = events.map(fromEventRow)
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
      const row = Database.transaction((tx) => {
        const found = tx.select().from(WorkflowNodeTable).where(eq(WorkflowNodeTable.id, input.nodeID)).get()
        if (!found) throw new NotFoundError({ message: `Workflow node not found: ${input.nodeID}` })

        const current = fromNodeRow(found)
        const nextStatus = input.patch.status ?? current.status
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
    }),
    async (input) => {
      await state()
      await getNode(input.nodeID)
      await writeEvent({
        workflowID: input.workflowID,
        nodeID: input.nodeID,
        target_node_id: input.nodeID,
        source: input.source,
        kind: "node.control",
        payload: {
          command: input.command,
          ...(input.payload ?? {}),
        },
      })
      return true
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
        SessionPrompt.cancel(SessionID.make(node.session_id))
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
        SessionPrompt.cancel(SessionID.make(node.session_id))
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
      await writeEvent({
        workflowID: node.workflow_id,
        nodeID: node.id,
        sessionID: node.session_id,
        source: "node",
        kind: "node.pulled",
        payload: {
          cursor: input.cursor ?? 0,
          pending: rows.length,
        },
      })
      return {
        node,
        cursor: rows.at(-1)?.id ?? input.cursor ?? 0,
        events: rows.map(fromEventRow),
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

  export const diff = fn(z.string(), async (workflowID) => {
    await state()
    const snapshot = await get(workflowID)
    const byFile = new Map<string, Awaited<ReturnType<typeof Session.diff>>[number]>()

    for (const sessionID of [snapshot.workflow.session_id, ...snapshot.nodes.map((node) => node.session_id).filter(Boolean)]) {
      if (!sessionID) continue
      const diffs = await Session.diff(SessionID.make(sessionID))
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
    return Session.diff(SessionID.make(node.session_id))
  })
}
