import type { SnapshotFileDiff as FileDiff, Message, Part, TextPart, ToolPart } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/shared/util/encode"
import { createEffect, createMemo, For, on, onCleanup, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate, useParams } from "@solidjs/router"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { useSync } from "@/context/sync"
import { DialogSelectModel } from "@/components/dialog-select-model"
import { DialogSelectProvider } from "@/components/dialog-select-provider"
import { useProviders } from "@/hooks/use-providers"
import { useLocal } from "@/context/local"
import { getSessionContextMetrics } from "@/components/session/session-context-metrics"
import { WorkflowApp, type WorkflowAppProps } from "@/react-workflow/app"
import type { Msg } from "@/react-workflow/components/chat-panel"
import type { WorkflowPlan } from "@/react-workflow/components/plan-card"
import type { SandTableDiscussion } from "@/react-workflow/components/sand-table-session-view"
import { Identifier } from "@/utils/id"
import { extractPromptFromParts } from "@/utils/prompt"
import { createElement } from "react"
import { createRoot, type Root } from "react-dom/client"

export type WorkflowInfo = {
  id: string
  session_id: string
  title: string
  status: string
  summary?: {
    objective?: string
  }
  current_node_id?: string
  selected_node_id?: string
  version: number
  /** P1 — dynamic graph rev counter. Optional on wire for back-compat. */
  graph_rev?: number
  /** P1 — global concurrency cap (default 5 server-side). */
  max_concurrent_nodes?: number
  /** P1 — currently held exclusive resources `{ resource → node_id }`. */
  resources_held?: Record<string, string>
  /** P5 — finalised workflow result. Not populated until P5 lands. */
  result_json?: Record<string, unknown>
  time?: {
    created: number
    updated: number
  }
}

export type WorkflowRuntime = {
  phase: string
  active_node_id?: string
  waiting_node_ids: string[]
  failed_node_ids: string[]
  command_count: number
  update_count: number
  pull_count: number
  last_event_id: number
}

/** P1 — reducer variants for named input ports; matches server `WorkflowPortReducer`. */
export type WorkflowPortReducer = "single" | "last_wins" | "array_concat" | "object_deep_merge" | "custom"
export type WorkflowInputPort = {
  name: string
  reducer: WorkflowPortReducer
  required?: boolean
  default?: unknown
  description?: string
}
export type WorkflowOutputPort = {
  name: string
  description?: string
}

export type WorkflowNode = {
  id: string
  workflow_id: string
  session_id?: string
  title: string
  agent: string
  model?: {
    providerID?: string
    modelID?: string
    variant?: string
  }
  config?: Record<string, unknown>
  /** P1 — declared input ports with reducers. Absent = implicit single `in` port. */
  input_ports?: WorkflowInputPort[]
  /** P1 — declared output ports. Absent = implicit single `out` port. */
  output_ports?: WorkflowOutputPort[]
  status: string
  result_status: string
  fail_reason?: string
  action_count: number
  attempt: number
  max_attempts: number
  max_actions: number
  version: number
  position: number
  state_json?: Record<string, unknown>
  result_json?: Record<string, unknown>
  /** P1 — snapshot of consumed inputs keyed by input-port name. */
  consumed_inputs?: Record<string, unknown>
  /** P1 — upstream change invalidated this node's result. */
  stale?: boolean
  /** P1 — `graph_rev` observed when this node started running. */
  graph_rev_at_start?: number
  /** P1 — scheduling priority (higher wins among ready siblings). */
  priority?: number
  /** P1 — exclusive resources this node wants held while running. */
  holds_resources?: string[]
  time: {
    created: number
    updated: number
    started?: number
    completed?: number
  }
}

export type WorkflowEdge = {
  id: string
  workflow_id: string
  from_node_id: string
  to_node_id: string
  label?: string
  /** P1 — outbound port on the producer (default `out`). */
  from_port?: string
  /** P1 — inbound port on the consumer (default `in`). */
  to_port?: string
  /** P1 — downstream can't become ready until this edge has a value (default true). */
  required?: boolean
}

/** P1 — lifecycle status of a graph edit transaction. */
export type WorkflowEditStatus = "pending" | "applied" | "rejected" | "superseded"

/** P3 — discriminated union of edit ops the master can batch into a single
 *  transaction. Mirrors `Workflow.EditOp` zod schema in
 *  packages/opencode/src/workflow/index.ts. Kept structurally permissive on
 *  the FE side (`Record<string, unknown>` for nested shapes) so a server-side
 *  schema tweak doesn't immediately break the panel. */
export type WorkflowEditOp =
  | { kind: "INSERT_NODE"; node: Record<string, unknown> }
  | { kind: "REPLACE_NODE"; node_id: string; node: Record<string, unknown> }
  | { kind: "MODIFY_NODE"; node_id: string; patch: Record<string, unknown> }
  | { kind: "DELETE_NODE"; node_id: string }
  | { kind: "INSERT_EDGE"; edge: Record<string, unknown> }
  | { kind: "DELETE_EDGE"; edge_id: string }

/** P1/P3 — a proposed-then-applied graph edit. */
export type WorkflowEdit = {
  id: string
  workflow_id: string
  proposer_session_id?: string
  ops: WorkflowEditOp[]
  status: WorkflowEditStatus
  reason?: string
  reject_reason?: string
  graph_rev_before: number
  graph_rev_after?: number
  time: {
    created: number
    applied?: number
  }
}

export type WorkflowEvent = {
  id: number
  workflow_id: string
  node_id?: string
  session_id?: string
  target_node_id?: string
  kind: string
  source: string
  payload: Record<string, unknown>
  time_created: number
}

export type WorkflowCheckpoint = {
  id: string
  workflow_id: string
  node_id: string
  label: string
  status: string
}

export type WorkflowSnapshot = {
  workflow: WorkflowInfo
  runtime: WorkflowRuntime
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  checkpoints: WorkflowCheckpoint[]
  events: WorkflowEvent[]
  /** P1 — graph-edit transactions. Optional; server only includes from P3. */
  edits?: WorkflowEdit[]
  cursor: number
}

type WorkflowReadResult = {
  workflow?: WorkflowInfo
  runtime?: WorkflowRuntime
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  checkpoints: WorkflowCheckpoint[]
  events: WorkflowEvent[]
  /** P1 — delta slice of edit transactions. */
  edits?: WorkflowEdit[]
  cursor: number
}

type WorkflowBusEvent = {
  type: string
  properties: {
    info: {
      id?: string
      workflow_id?: string
    }
  }
}

type Row = {
  id: string
  role: "system" | "assistant" | "user" | "tool"
  body: string
  time: string
  label: string
  thinking?: {
    status: "running" | "completed"
  }
  toolCall?: {
    name: string
    status: "running" | "completed" | "failed"
    duration?: string
    progress?: number
    sessionId?: string
    input?: Record<string, unknown>
  }
  reasoning?: { text: string; time?: { start: number; end?: number } }
  file?: { mime: string; filename?: string; url: string }
  patch?: { hash: string; files: string[] }
  subtask?: { description: string; agent: string; prompt: string }
  stepFinish?: { reason: string; cost: number; tokens: { input: number; output: number } }
  retry?: { attempt: number; error: string }
  agent?: { name: string }
  plan?: WorkflowPlan
  sandTable?: unknown
  question?: unknown
  permission?: unknown
}

const dot = {
  pending: "border-slate-300 bg-white",
  running: "border-sky-400 bg-sky-400",
  completed: "border-emerald-400 bg-emerald-400",
  failed: "border-rose-400 bg-rose-400",
}

const tint = {
  pending: {
    ring: "ring-1 ring-slate-200/90",
    panel: "border-slate-200/80 bg-white/80",
    soft: "bg-slate-100 text-slate-600",
    text: "text-slate-500",
  },
  running: {
    ring: "ring-2 ring-sky-400/55",
    panel: "border-sky-200/80 bg-white/95 shadow-[0_18px_48px_rgba(56,189,248,0.12)]",
    soft: "bg-sky-50 text-sky-700",
    text: "text-sky-600",
  },
  completed: {
    ring: "ring-1 ring-emerald-200/90",
    panel: "border-emerald-200/80 bg-white/92",
    soft: "bg-emerald-50 text-emerald-700",
    text: "text-emerald-600",
  },
  failed: {
    ring: "ring-1 ring-rose-200/90",
    panel: "border-rose-200/80 bg-white/92",
    soft: "bg-rose-50 text-rose-700",
    text: "text-rose-600",
  },
}

const roleTone = {
  system: {
    box: "bg-violet-500/10 text-violet-600",
    label: "text-violet-600",
  },
  assistant: {
    box: "bg-emerald-500/10 text-emerald-600",
    label: "text-emerald-600",
  },
  user: {
    box: "bg-sky-500/10 text-sky-600",
    label: "text-sky-600",
  },
  tool: {
    box: "bg-amber-500/10 text-amber-700",
    label: "text-amber-700",
  },
}

const done = (status: string) => ["completed", "failed", "cancelled"].includes(status)
const live = (status: string) => ["running", "waiting"].includes(status)
const tone = (status: string) =>
  status === "completed" ? "completed" : status === "failed" || status === "cancelled" ? "failed" : live(status) ? "running" : "pending"
const cap = (value: string) => value.replaceAll("-", " ").replace(/\b\w/g, (v) => v.toUpperCase())
const fmt = (time?: number) => (time ? new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "--:--")
const clip = (value: string, size = 320) => (value.length <= size ? value : `${value.slice(0, size - 1).trimEnd()}…`)
const duration = (start?: number, end?: number) =>
  typeof start === "number" && typeof end === "number" ? `${((end - start) / 1000).toFixed(1)}s` : undefined

const modelReady = (node: WorkflowNode) => !!node.model?.providerID && !!node.model?.modelID

const modelLabel = (node: WorkflowNode) => {
  const id = node.model?.modelID
  const provider = node.model?.providerID
  if (!id && !provider) return "route required"
  if (!provider) return id!
  if (!id) return provider
  return `${provider}/${id}`
}

const short = (value: unknown) => JSON.stringify(value ?? {}, null, 2)

const sortNodes = (nodes: WorkflowNode[]) =>
  [...nodes].sort((a, b) => a.position - b.position || a.time.created - b.time.created || a.id.localeCompare(b.id))

const mergeNodes = (base: WorkflowNode[], next: WorkflowNode[]) => {
  const map = new Map(base.map((item) => [item.id, item] as const))
  next.forEach((item) => map.set(item.id, item))
  return sortNodes([...map.values()])
}

const nodeKind = (node: WorkflowNode) => {
  const text = `${node.agent} ${node.title}`.toLowerCase()
  if (/(build|compile|flash|bundle|pack)/.test(text)) return "build"
  if (/(debug|verify|inspect|test|check)/.test(text)) return "debug"
  if (/(deploy|transfer|release|ship|push)/.test(text)) return "deploy"
  return "coding"
}

const goal = (snap: WorkflowSnapshot) =>
  snap.workflow.summary?.objective ?? "The root session owns orchestration for the entire multi-agent workflow."

const workflowIDFromEvent = (event: WorkflowBusEvent) => {
  if (event.type === "workflow.created" || event.type === "workflow.updated") return event.properties.info.id
  if (event.type === "workflow.node.created" || event.type === "workflow.node.updated") return event.properties.info.workflow_id
  if (event.type === "workflow.edge.created") return event.properties.info.workflow_id
  if (event.type === "workflow.checkpoint.updated") return event.properties.info.workflow_id
  if (event.type === "workflow.event.created") return event.properties.info.workflow_id
}

const controlText = {
  run: "Execution routing is confirmed. Use the workflow graph and the configured node models already stored in runtime. Start only nodes that are dependency-ready and fully routed, and do not start any unrouted node.",
  restart:
    "Restart the whole task from the approved plan. Re-run the workflow from the beginning and refresh any child execution that needs to be recreated.",
  stop: "Abort the current workflow execution. Cancel running work and do not continue unless the user explicitly starts again.",
  pause:
    "Pause workflow execution now. Wait for more user context before resuming any node, and do not continue until the user explicitly asks to resume.",
}

const eventNote = (event: WorkflowEvent) => {
  const summary =
    typeof event.payload.summary === "string"
      ? event.payload.summary
      : typeof event.payload.reason === "string"
        ? event.payload.reason
        : typeof event.payload.command === "string"
          ? `command=${event.payload.command}`
          : typeof event.payload.status === "string"
            ? `status=${event.payload.status}`
            : undefined
  return summary ? `${event.kind} · ${summary}` : event.kind
}

const pickText = (parts: Part[]) =>
  parts
    .filter((part): part is TextPart => part.type === "text")
    .filter((part) => !part.synthetic && !part.ignored)
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")

const pickReasoning = (parts: Part[]) =>
  parts
    .filter((part): part is Extract<Part, { type: "reasoning" }> => part.type === "reasoning")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")

const toolText = (part: ToolPart) => {
  const state = part.state
  if (state.status === "completed") return clip(state.output || state.title || part.tool, 500)
  if (state.status === "error") return clip(state.error, 500)
  if (state.status === "running") return state.title ?? `Running ${part.tool}`
  return `Waiting on ${part.tool}`
}

const toolCall = (part: ToolPart) => ({
  name: part.tool,
  status:
    part.state.status === "completed"
      ? ("completed" as const)
      : part.state.status === "error"
        ? ("failed" as const)
        : ("running" as const),
  duration:
    part.state.status === "completed"
      ? duration(part.state.time.start, part.state.time.end)
      : part.state.status === "error"
        ? duration(part.state.time.start, part.state.time.end)
        : undefined,
  progress:
    part.state.status === "running" && typeof part.state.metadata?.progress === "number"
      ? Math.max(0, Math.min(100, Number(part.state.metadata.progress)))
      : undefined,
  sessionId:
    part.tool === "task" && part.state.status !== "pending"
      ? (part.state.metadata?.sessionId as string | undefined)
      : undefined,
  input: part.state.status !== "pending" ? part.state.input : undefined,
})

const promptText = (parts: Part[], dir: string) =>
  extractPromptFromParts(parts, { directory: dir, attachmentName: "attachment" })
    .map((part) => (part.type === "image" ? `[image] ${part.filename}` : part.content))
    .join("")
    .trim()

const wakePrompt = (parts: Part[]) =>
  parts.some(
    (part) =>
      part.type === "text" &&
      typeof part.text === "string" &&
      (part.metadata?.workflow_wake === true || part.text.startsWith("Workflow wake event:")),
  )

const isWorkflowPlan = (value: unknown): value is WorkflowPlan => {
  if (!value || typeof value !== "object") return false
  const plan = value as Record<string, unknown>
  return (
    typeof plan.objective === "string" &&
    Array.isArray(plan.nodes) &&
    Array.isArray(plan.checkpoints)
  )
}

const parsePlanCandidate = (raw: string) => {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return
    const plan = (parsed as Record<string, unknown>).plan
    if (!isWorkflowPlan(plan)) return
    return plan
  } catch {
    return
  }
}

const splitPlanFromBody = (body: string): { text: string; plan?: WorkflowPlan } => {
  const trimmed = body.trim()
  if (!trimmed) return { text: body }

  const whole = parsePlanCandidate(trimmed)
  if (whole) return { text: "", plan: whole }

  const fenced = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
  for (let idx = fenced.length - 1; idx >= 0; idx -= 1) {
    const match = fenced[idx]
    const plan = parsePlanCandidate(match[1].trim())
    if (!plan) continue
    const text = `${trimmed.slice(0, match.index).trim()}\n\n${trimmed.slice((match.index ?? 0) + match[0].length).trim()}`
      .trim()
    return { text, plan }
  }

  const start = trimmed.lastIndexOf('{"plan"')
  if (start >= 0) {
    const candidate = trimmed.slice(start).trim()
    const plan = parsePlanCandidate(candidate)
    if (plan) return { text: trimmed.slice(0, start).trim(), plan }
  }

  return { text: body }
}

type SandTableMessage = {
  role?: string
  model?: string
  content?: string
  round?: number
}

type SandTableOutput = {
  sand_table_id?: string
  status?: string
  rounds?: number
  final_plan?: string
  last_evaluation?: string
  history?: SandTableMessage[]
}

const parseSandTableOutput = (raw?: string) => {
  if (!raw) return
  try {
    const parsed = JSON.parse(raw) as SandTableOutput
    return parsed && typeof parsed === "object" ? parsed : undefined
  } catch {
    return
  }
}

const sandTableSummary = (messages: Message[], parts: Record<string, Part[] | undefined>) => {
  let latest:
    | {
        message: Message
        part: ToolPart
        output?: SandTableOutput
      }
    | undefined

  for (const message of messages) {
    for (const part of parts[message.id] ?? []) {
      if (part.type !== "tool" || part.tool !== "sand_table") continue
      latest = {
        message,
        part,
        output:
          part.state.status === "completed"
            ? parseSandTableOutput(typeof part.state.output === "string" ? part.state.output : undefined)
            : undefined,
      }
    }
  }

  if (!latest) return

  const input =
    latest.part.state.status !== "pending" &&
    latest.part.state.input &&
    typeof latest.part.state.input === "object"
      ? (latest.part.state.input as Record<string, unknown>)
      : undefined
  const topic = typeof input?.topic === "string" ? input.topic.trim() : ""
  const title = topic ? clip(`Plan · ${topic}`, 48) : "Plan via Sand Table"
  const status =
    latest.part.state.status === "error"
      ? "failed"
      : latest.part.state.status === "running"
        ? "running"
        : latest.part.state.status === "pending"
          ? "pending"
        : latest.output?.status === "failed"
          ? "failed"
          : "completed"

  const output = latest.output
  const history = Array.isArray(output?.history) ? output.history : []
  // When the tool output exceeds opencode's size limit, the runtime replaces
  // `state.output` with a plain-text notice and JSON.parse returns undefined.
  // The tool still records the real discussion id under `state.metadata`, so
  // prefer that — otherwise the fetch URL falls back to the tool part id and
  // every `/workflow/sand_table/:id` request 404s.
  const metadata =
    latest.part.state.status !== "pending" && typeof latest.part.state.metadata === "object"
      ? (latest.part.state.metadata as Record<string, unknown>)
      : undefined
  const metadataID = typeof metadata?.sandTableID === "string" ? metadata.sandTableID : undefined
  // The backend registers each discussion under both its real `discussionID`
  // (published via ctx.metadata.sandTableID) AND the tool `callID`, so we can
  // fall back to callID when metadata hasn't propagated yet. `part.id` is a
  // last-resort fallback that won't match, but we keep it as a defined id so
  // React keys stay stable.
  return {
    id: output?.sand_table_id ?? metadataID ?? latest.part.callID ?? latest.part.id,
    title,
    topic: topic || "Planning discussion",
    status: status as "pending" | "running" | "completed" | "failed",
    rounds: typeof output?.rounds === "number" ? output.rounds : 0,
    finalPlan: output?.final_plan,
    lastEvaluation: output?.last_evaluation,
    history,
    sessionID: latest.message.sessionID,
  }
}

const sandPlanBadges = (plan: NonNullable<ReturnType<typeof sandTableSummary>>) => {
  const badges: string[] = []
  if (plan.rounds > 0) badges.push(`${plan.rounds} round${plan.rounds > 1 ? "s" : ""}`)
  if (plan.history.length > 0) badges.push(`${plan.history.length} msgs`)
  if (plan.status === "completed") {
    badges.push(plan.finalPlan ? "plan ready" : "complete")
  } else if (plan.status === "failed") {
    badges.push("failed")
  } else if (plan.lastEvaluation && /approve/i.test(plan.lastEvaluation)) {
    badges.push("approved")
  } else if (plan.lastEvaluation && /revise/i.test(plan.lastEvaluation)) {
    badges.push("revise")
  } else if (plan.status === "running") {
    badges.push("discussing")
  }
  return badges.slice(0, 3)
}

const buildRows = (input: {
  dir: string
  messages: Message[]
  parts: Record<string, Part[] | undefined>
  snap: WorkflowSnapshot
  node?: WorkflowNode
}) => {
  // Previously the chat list opened with a synthetic "System · STATUS ·
  // PHASE" row built from the workflow snapshot. The user pointed out
  // it carries no real information — the same status / phase already
  // appears in the shell header's STAGE/NODES meta strip. Dropping the
  // pseudo-row gives the agent's reply more visual room and avoids the
  // "no useful title" feeling.
  const rows: Row[] = []
  for (const msg of input.messages) {
    const parts = input.parts[msg.id] ?? []
    if (msg.role === "user") {
      if (wakePrompt(parts)) continue
      const body = promptText(parts, input.dir)
      if (!body) continue
      rows.push({
        id: msg.id,
        role: "user",
        label: "User",
        time: fmt(msg.time.created),
        body,
      })
      continue
    }
    const body = pickText(parts)
    const reasoning = pickReasoning(parts)
    const parsedPlan = body ? splitPlanFromBody(body) : { text: "" }
    const thinking = parts.some((part) => part.type === "step-start")
    const done = parts.some((part) => part.type === "step-finish") || !!msg.time.completed
    if (thinking && (!body || reasoning)) {
      rows.push({
        id: `${msg.id}:thinking`,
        role: "assistant",
        label: "Thinking",
        time: fmt(msg.time.created),
        body: reasoning || (done ? "Finalizing response..." : "Thinking..."),
        thinking: {
          status: done ? "completed" : "running",
        },
      })
    }
    parts
      .filter((part): part is ToolPart => part.type === "tool")
      .forEach((part, idx) => {
        // Check if this is a sand_table tool call — emit sandTable row
        if (part.tool === "sand_table" && part.state.status === "completed" && (part.state as any).output) {
          try {
            const parsed = JSON.parse((part.state as any).output)
            rows.push({
              id: `${msg.id}:sandtable:${idx}`,
              role: "assistant",
              label: "Sand Table",
              time: fmt(msg.time.created),
              body: "",
              sandTable: {
                id: parsed.sand_table_id ?? "",
                topic: parsed.final_plan?.slice(0, 60) ?? "Planning",
                rounds: parsed.rounds ?? 0,
                status: parsed.status ?? "completed",
                messages: (parsed.history ?? []).map((m: any) => ({
                  role: m.role ?? "orchestrator",
                  model: m.model ?? "",
                  content: m.content ?? "",
                  round: m.round ?? 1,
                })),
                finalPlan: parsed.final_plan,
              },
            })
            return
          } catch {
            // Fall through to normal tool rendering
          }
        }
        rows.push({
          id: `${msg.id}:tool:${idx}`,
          role: "tool",
          label: cap(part.tool),
          time: fmt(msg.time.created),
          body: toolText(part),
          toolCall: toolCall(part),
        })
      })
    // Reasoning parts (standalone, not the thinking block already handled above)
    const reasoningParts = parts.filter((p): p is Extract<Part, { type: "reasoning" }> => p.type === "reasoning")
    if (reasoningParts.length > 0 && !thinking) {
      reasoningParts.forEach((rp, idx) =>
        rows.push({
          id: `${msg.id}:reasoning:${idx}`,
          role: "assistant",
          label: "Reasoning",
          time: fmt(msg.time.created),
          body: rp.text,
          reasoning: { text: rp.text, time: rp.time },
        }),
      )
    }
    // File parts
    parts
      .filter((p): p is Extract<Part, { type: "file" }> => p.type === "file")
      .forEach((fp, idx) =>
        rows.push({
          id: `${msg.id}:file:${idx}`,
          role: "assistant",
          label: fp.filename ?? "File",
          time: fmt(msg.time.created),
          body: fp.filename ?? fp.mime,
          file: { mime: fp.mime, filename: fp.filename, url: fp.url },
        }),
      )
    // Patch parts
    parts
      .filter((p): p is Extract<Part, { type: "patch" }> => p.type === "patch")
      .forEach((pp, idx) =>
        rows.push({
          id: `${msg.id}:patch:${idx}`,
          role: "assistant",
          label: "Code Changes",
          time: fmt(msg.time.created),
          body: `${pp.files.length} files changed`,
          patch: { hash: pp.hash, files: pp.files },
        }),
      )
    // Subtask parts
    parts
      .filter((p): p is Extract<Part, { type: "subtask" }> => p.type === "subtask")
      .forEach((sp, idx) =>
        rows.push({
          id: `${msg.id}:subtask:${idx}`,
          role: "assistant",
          label: sp.description,
          time: fmt(msg.time.created),
          body: sp.description,
          subtask: { description: sp.description, agent: sp.agent, prompt: sp.prompt },
        }),
      )
    // Retry parts
    parts
      .filter((p): p is Extract<Part, { type: "retry" }> => p.type === "retry")
      .forEach((rp, idx) =>
        rows.push({
          id: `${msg.id}:retry:${idx}`,
          role: "assistant",
          label: `Retry #${rp.attempt}`,
          time: fmt(msg.time.created),
          body: typeof rp.error === "string" ? rp.error : (rp.error as any)?.message ?? "Error",
          retry: { attempt: rp.attempt, error: typeof rp.error === "string" ? rp.error : (rp.error as any)?.message ?? "Error" },
        }),
      )
    // StepFinish parts
    parts
      .filter((p): p is Extract<Part, { type: "step-finish" }> => p.type === "step-finish")
      .forEach((sf, idx) =>
        rows.push({
          id: `${msg.id}:stepfinish:${idx}`,
          role: "assistant",
          label: "Step Complete",
          time: fmt(msg.time.created),
          body: sf.reason,
          stepFinish: { reason: sf.reason, cost: sf.cost, tokens: { input: sf.tokens.input, output: sf.tokens.output } },
        }),
      )
    // Agent parts
    parts
      .filter((p): p is Extract<Part, { type: "agent" }> => p.type === "agent")
      .forEach((ap, idx) =>
        rows.push({
          id: `${msg.id}:agent:${idx}`,
          role: "assistant",
          label: ap.name,
          time: fmt(msg.time.created),
          body: "",
          agent: { name: ap.name },
        }),
      )
    // Plan card (rendered before final assistant text)
    if (parsedPlan.plan) {
      rows.push({
        id: `${msg.id}:plan`,
        role: "assistant",
        label: "Plan",
        time: fmt(msg.time.created),
        body: "",
        plan: parsedPlan.plan,
      })
    }
    // Assistant's final reply — rendered last so it appears at the end of the turn,
    // after thinking, tool calls, reasoning, files, patches, subtasks, etc.
    if (parsedPlan.text) {
      rows.push({
        id: `${msg.id}:assistant`,
        role: "assistant",
        label: "Assistant",
        time: fmt(msg.time.created),
        body: parsedPlan.text,
      })
    }
  }
  return rows
}

let workflowPanelComposing = false

const currentNode = (snap: WorkflowSnapshot) => {
  const pick = [snap.runtime.active_node_id, snap.workflow.selected_node_id, snap.workflow.current_node_id].find(Boolean)
  if (pick) {
    const node = snap.nodes.find((item) => item.id === pick)
    if (node) return node
  }
  return sortNodes(snap.nodes).find((item) => live(item.status)) ?? sortNodes(snap.nodes)[0]
}

const agentRows = (snap: WorkflowSnapshot) => {
  const map = new Map<string, WorkflowNode>()
  sortNodes(snap.nodes).forEach((node) => {
    if (!map.has(node.agent)) map.set(node.agent, node)
  })
  return [...map.values()]
}

function Glyph(props: { status: string }) {
  const value = () => tone(props.status)
  const spin = () => value() === "running"
  return (
    <div class={`flex size-8 items-center justify-center rounded-lg ${value() === "running" ? "bg-blue-500/10" : value() === "completed" ? "bg-emerald-500/10" : value() === "failed" ? "bg-red-500/10" : "bg-muted/30"}`}>
      <svg class={`size-4 ${value() === "running" ? "text-blue-500" : value() === "completed" ? "text-emerald-500" : value() === "failed" ? "text-red-500" : "text-muted-foreground"} ${spin() ? "animate-spin" : ""}`} viewBox="0 0 20 20" fill="none">
        <Show when={value() === "completed"}>
          <path d="M5 10.5L8.2 13.5L15 6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </Show>
        <Show when={value() === "failed"}>
          <path d="M6 6L14 14" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          <path d="M14 6L6 14" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </Show>
        <Show when={value() === "pending"}>
          <circle cx="10" cy="10" r="6.5" stroke="currentColor" stroke-width="2" />
        </Show>
        <Show when={value() === "running"}>
          <>
            <circle cx="10" cy="10" r="6.5" stroke="currentColor" stroke-width="2" opacity="0.2" />
            <path d="M10 3.5A6.5 6.5 0 0 1 16.5 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </>
        </Show>
      </svg>
    </div>
  )
}

function Pill(props: { status: string; text?: string }) {
  const value = () => tone(props.status)
  return (
    <span class={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs ${value() === "running" ? "bg-blue-500/10 text-blue-500" : value() === "completed" ? "bg-emerald-500/10 text-emerald-500" : value() === "failed" ? "bg-red-500/10 text-red-500" : "bg-muted/30 text-muted-foreground"}`}>
      <span class={`size-1.5 rounded-full ${value() === "running" ? "bg-blue-500" : value() === "completed" ? "bg-emerald-500" : value() === "failed" ? "bg-red-500" : "bg-muted-foreground"}`} />
      {props.text ?? cap(props.status)}
    </span>
  )
}

function Mark(props: { role: Row["role"] }) {
  return (
    <svg class={`size-3.5 ${roleTone[props.role].label}`} viewBox="0 0 20 20" fill="none">
      <Show when={props.role === "system"}>
        <>
          <path d="M4 6H16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          <path d="M6 10H14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          <path d="M8 14H12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </>
      </Show>
      <Show when={props.role === "assistant"}>
        <>
          <rect x="5" y="5" width="10" height="10" rx="3" stroke="currentColor" stroke-width="1.8" />
          <circle cx="8" cy="10" r="1" fill="currentColor" />
          <circle cx="12" cy="10" r="1" fill="currentColor" />
        </>
      </Show>
      <Show when={props.role === "user"}>
        <>
          <circle cx="10" cy="7.5" r="3" stroke="currentColor" stroke-width="1.8" />
          <path d="M5.5 15C6.6 12.9 8.1 12 10 12C11.9 12 13.4 12.9 14.5 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </>
      </Show>
      <Show when={props.role === "tool"}>
        <>
          <path d="M7 5.5L5.5 7L8 9.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M13 5.5L14.5 7L12 9.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M8.5 14H11.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </>
      </Show>
    </svg>
  )
}

function SessionModal(props: {
  open: boolean
  rows: Row[]
  title: string
  subtitle: string
  onClose: () => void
}) {
  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-40 flex items-center justify-center bg-black/35 px-6 py-8 backdrop-blur-sm">
        <div class="flex h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border/50 bg-background shadow-2xl">
          <div class="border-b border-border/50 px-6 py-4">
            <div class="text-lg font-medium text-foreground">Session Conversation</div>
            <div class="pt-1 text-sm text-muted-foreground">{props.title}</div>
            <div class="text-xs text-muted-foreground">{props.subtitle}</div>
          </div>
          <div class="min-h-0 flex-1 overflow-auto px-6 py-4">
            <div class="space-y-4">
              <For each={props.rows}>
                {(row) => (
                  <div class="flex gap-3 rounded-lg border border-border/50 bg-background/60 p-4">
                    <div class={`flex size-8 shrink-0 items-center justify-center rounded-lg ${roleTone[row.role].box}`}>
                      <Mark role={row.role} />
                    </div>
                    <div class="min-w-0 flex-1">
                      <div class="mb-2 flex items-center gap-2">
                        <span class={`text-xs font-medium ${roleTone[row.role].label}`}>{row.label}</span>
                        <span class="text-xs text-muted-foreground">{row.time}</span>
                      </div>
                      <p class="whitespace-pre-wrap text-sm text-foreground">{row.body}</p>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>
          <div class="border-t border-border/50 px-6 py-3">
            <button
              class="rounded-lg border border-border/50 px-4 py-2 text-sm text-foreground transition-colors hover:bg-muted/20"
              onClick={props.onClose}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}

function Canvas(props: {
  nodes: WorkflowNode[]
  pick?: string
  current?: string
  onPick: (id: string) => void
}) {
  return (
    <div class="relative h-full overflow-auto">
      <div class="min-h-full p-8">
        <div class="mx-auto flex max-w-2xl flex-col gap-6">
          <For each={sortNodes(props.nodes)}>
            {(node, idx) => {
              const pick = () => props.pick === node.id
              const run = () => props.current === node.id && tone(node.status) === "running"
              return (
                <div class="relative">
                  <button
                    class={`relative w-full cursor-pointer rounded-xl p-4 text-left transition-all duration-200 ${pick() ? "bg-background shadow-lg" : "bg-background/60 shadow-md hover:shadow-lg"} ${run() ? "ring-2 ring-blue-500/50" : ""}`}
                    style={{ "backdrop-filter": "blur(8px)" }}
                    onClick={() => props.onPick(node.id)}
                  >
                    <Show when={run()}>
                      <div class="pointer-events-none absolute inset-0 rounded-xl bg-[linear-gradient(90deg,transparent,rgba(59,130,246,0.1),transparent)]" />
                    </Show>
                    <div class="relative z-10 flex items-start gap-3">
                      <Glyph status={node.status} />
                      <div class="min-w-0 flex-1">
                        <div class="truncate text-sm font-medium text-foreground">{node.title}</div>
                        <div class="mt-1 flex items-center gap-2">
                          <span class="font-mono text-xs text-muted-foreground">{nodeKind(node)}</span>
                          <span class="text-xs text-muted-foreground">•</span>
                          <span class={`font-mono text-xs ${tone(node.status) === "running" ? "text-blue-500" : tone(node.status) === "completed" ? "text-emerald-500" : tone(node.status) === "failed" ? "text-red-500" : "text-muted-foreground"}`}>{node.status}</span>
                        </div>
                      </div>
                    </div>
                  </button>
                  <Show when={idx() < props.nodes.length - 1}>
                    <div class="my-4 flex justify-center">
                      <svg width="24" height="32" viewBox="0 0 24 32" fill="none">
                        <path d="M12 0L12 28M12 28L8 24M12 28L16 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground/30" />
                      </svg>
                    </div>
                  </Show>
                </div>
              )
            }}
          </For>
        </div>
      </div>
    </div>
  )
}

function Inspector(props: {
  snap: WorkflowSnapshot
  node?: WorkflowNode
  pending: number
  control?: WorkflowEvent
  pull?: WorkflowEvent
  update?: WorkflowEvent
}) {
  const state = createMemo(() => tone(props.snap.workflow.status))
  return (
    <div class="h-full overflow-auto">
      <div class="space-y-6 p-6">
        <div class="space-y-4">
          <div class="flex items-center gap-2">
            <h2 class="text-sm font-medium uppercase tracking-wider text-foreground">Workflow Context</h2>
          </div>
          <div class={`rounded-xl border p-4 ${state() === "running" ? "border-blue-500/20 bg-blue-500/10" : state() === "completed" ? "border-emerald-500/20 bg-emerald-500/10" : state() === "failed" ? "border-red-500/20 bg-red-500/10" : "border-border/30 bg-muted/20"}`}>
            <div class="mb-3 flex items-center gap-3">
              <Glyph status={props.snap.workflow.status} />
              <div>
                <div class="text-xs text-muted-foreground">Status</div>
                <div class={`text-sm font-medium ${state() === "running" ? "text-blue-400" : state() === "completed" ? "text-emerald-400" : state() === "failed" ? "text-red-400" : "text-muted-foreground"}`}>
                  {cap(props.snap.workflow.status)}
                </div>
              </div>
            </div>
            <div class="space-y-2">
              <div>
                <div class="mb-1 text-xs text-muted-foreground">Current Phase</div>
                <div class="text-sm font-medium text-foreground">{cap(props.snap.runtime.phase)}</div>
              </div>
              <div>
                <div class="mb-1 text-xs text-muted-foreground">Goal</div>
                <div class="text-sm leading-relaxed text-foreground/90">{goal(props.snap)}</div>
              </div>
            </div>
          </div>
        </div>

        <div class="space-y-4">
          <h3 class="text-sm font-medium uppercase tracking-wider text-foreground">Agents</h3>
          <div class="space-y-2">
            <For each={agentRows(props.snap)}>
              {(item) => (
                <div class="rounded-lg border border-border/30 bg-muted/20 p-3 transition-colors hover:bg-muted/30">
                  <div class="flex items-start gap-3">
                    <div class="flex size-8 items-center justify-center rounded-lg bg-violet-500/10">
                      <svg class="size-4 text-violet-400" viewBox="0 0 20 20" fill="none">
                        <path d="M10 4C13.3 4 16 6.6 16 9.8C16 13 13.3 15.6 10 15.6C6.7 15.6 4 13 4 9.8C4 6.6 6.7 4 10 4Z" stroke="currentColor" stroke-width="1.6" />
                        <path d="M7.6 9.5H8.4M11.6 9.5H12.4M8 12.1C8.6 12.6 9.2 12.8 10 12.8C10.8 12.8 11.4 12.6 12 12.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                      </svg>
                    </div>
                    <div class="min-w-0 flex-1">
                      <div class="mb-0.5 text-sm font-medium text-foreground">{item.agent}</div>
                      <div class="mb-2 text-xs text-muted-foreground">{item.title}</div>
                      <div class="flex items-center gap-2">
                        <span class="text-xs text-muted-foreground">Model:</span>
                        <span class="rounded bg-background/60 px-2 py-0.5 font-mono text-xs text-foreground">{modelLabel(item)}</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>

        <Show
          when={props.node}
          fallback={
            <>
              <div class="h-px bg-border/30" />
              <div class="flex items-center justify-center py-12">
                <p class="text-sm text-muted-foreground">Select a node to view details</p>
              </div>
            </>
          }
        >
          <div class="h-px bg-border/30" />
          <div class="space-y-4">
            <div>
              <div class="mb-2 text-xs uppercase tracking-wider text-muted-foreground">Selected Node</div>
              <h2 class="text-base font-medium text-foreground">{props.node!.title}</h2>
              <div class="mt-2 flex items-center gap-2">
                <span class="font-mono text-xs text-muted-foreground">{nodeKind(props.node!)}</span>
                <span class="text-xs text-muted-foreground">•</span>
                <span class={`font-mono text-xs ${tone(props.node!.status) === "running" ? "text-blue-400" : tone(props.node!.status) === "completed" ? "text-emerald-400" : tone(props.node!.status) === "failed" ? "text-red-400" : "text-muted-foreground"}`}>{props.node!.status}</span>
              </div>
            </div>

            <div class="space-y-3">
              <h3 class="text-xs uppercase tracking-wider text-muted-foreground">Overview</h3>
              <div class="grid grid-cols-2 gap-3">
                <div class="rounded-lg border border-border/30 bg-muted/20 p-3">
                  <div class="mb-1 text-xs text-muted-foreground">Result</div>
                  <div class="text-sm font-medium text-foreground">{cap(props.node!.result_status)}</div>
                </div>
                <div class="rounded-lg border border-border/30 bg-muted/20 p-3">
                  <div class="mb-1 text-xs text-muted-foreground">Model</div>
                  <div class="text-sm font-medium text-foreground">{modelLabel(props.node!)}</div>
                </div>
              </div>
            </div>

            <div class="space-y-3">
              <h3 class="text-xs uppercase tracking-wider text-muted-foreground">Execution</h3>
              <div class="grid grid-cols-2 gap-3">
                <div class="rounded-lg border border-border/30 bg-muted/20 p-3">
                  <div class="mb-1 text-xs text-muted-foreground">Attempt</div>
                  <div class="text-sm font-medium text-foreground">{props.node!.attempt}/{props.node!.max_attempts}</div>
                </div>
                <div class="rounded-lg border border-border/30 bg-muted/20 p-3">
                  <div class="mb-1 text-xs text-muted-foreground">Actions</div>
                  <div class="text-sm font-medium text-foreground">{props.node!.action_count}/{props.node!.max_actions}</div>
                </div>
                <div class="rounded-lg border border-border/30 bg-muted/20 p-3">
                  <div class="mb-1 text-xs text-muted-foreground">Pending</div>
                  <div class="text-sm font-medium text-foreground">{props.pending}</div>
                </div>
                <div class="rounded-lg border border-border/30 bg-muted/20 p-3">
                  <div class="mb-1 text-xs text-muted-foreground">Last Update</div>
                  <div class="text-sm font-medium text-foreground">{props.update ? `#${props.update.id}` : "none"}</div>
                </div>
              </div>
              <div class="grid grid-cols-1 gap-3">
                <div class="rounded-lg border border-border/30 bg-muted/20 p-3">
                  <div class="mb-1 text-xs text-muted-foreground">Session</div>
                  <div class="truncate text-sm font-medium text-foreground">{props.node!.session_id ?? "not started"}</div>
                </div>
                <Show when={props.node!.fail_reason}>
                  <div class="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-500">{props.node!.fail_reason}</div>
                </Show>
                <Show when={props.control || props.pull}>
                  <div class="rounded-lg border border-border/30 bg-muted/20 p-3">
                    <div class="mb-1 text-xs text-muted-foreground">Signals</div>
                    <div class="space-y-1 text-sm text-foreground">
                      <div>Last control: {props.control?.payload.command ? String(props.control.payload.command) : "none"}</div>
                      <div>Last pull: {props.pull ? `#${props.pull.id}` : "none"}</div>
                    </div>
                  </div>
                </Show>
              </div>
            </div>

            <div class="space-y-3">
              <h3 class="text-xs uppercase tracking-wider text-muted-foreground">State</h3>
              <div class="overflow-auto rounded-lg border border-border/30 bg-muted/20 p-3">
                <pre class="whitespace-pre-wrap font-mono text-xs text-foreground/80">{short(props.node!.state_json ?? props.node!.result_json ?? {})}</pre>
              </div>
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}

function Chat(props: {
  rows: Row[]
  text: string
  title: string
  onText: (value: string) => void
  onSend: () => void
}) {
  return (
    <div class="flex h-80 flex-col border-t border-emerald-500/20 bg-background/95 shadow-2xl backdrop-blur-sm">
      <div class="bg-gradient-to-r from-emerald-500/5 to-transparent px-6 py-3 border-b border-border/30">
        <div class="flex items-center gap-3">
          <div class="size-2 rounded-full bg-emerald-500" />
          <h3 class="text-sm font-medium text-foreground">{props.title}</h3>
          <span class="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-xs text-muted-foreground">
            {props.rows.length} messages
          </span>
        </div>
      </div>
      <div class="min-h-0 flex-1 overflow-auto px-6 py-4">
        <div class="space-y-3">
          <For each={props.rows}>
            {(row) => (
              <div class="group flex gap-3">
                <div class={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg ${roleTone[row.role].box}`}>
                  <Mark role={row.role} />
                </div>
                <div class="min-w-0 flex-1">
                  <div class="mb-1 flex items-center gap-2">
                    <span class={`text-xs font-medium ${roleTone[row.role].label}`}>{row.label}</span>
                    <span class="text-xs text-muted-foreground">{row.time}</span>
                  </div>
                  <p class="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{row.body}</p>
                </div>
              </div>
            )}
          </For>
        </div>
      </div>
      <div class="border-t border-border/30 bg-muted/20 px-6 py-3">
        <div class="flex gap-2">
          <input
            value={props.text}
            onInput={(event) => props.onText(event.currentTarget.value)}
            onCompositionStart={() => {
              workflowPanelComposing = true
            }}
            onCompositionEnd={() => {
              workflowPanelComposing = false
            }}
            onKeyDown={(event) => {
              if (workflowPanelComposing || (event as KeyboardEvent).isComposing || (event as any).keyCode === 229) return
              if (event.key !== "Enter" || event.shiftKey) return
              event.preventDefault()
              props.onSend()
            }}
            placeholder="Send a message to the agent..."
            class="flex-1 rounded-lg border border-border/50 bg-background px-4 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-emerald-500/50"
          />
          <button
            class="rounded-lg bg-emerald-600 px-4 text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-muted-foreground/40"
            disabled={!props.text.trim()}
            onClick={props.onSend}
          >
            <svg class="size-4" viewBox="0 0 20 20" fill="none">
              <path d="M3 10L16 4L12 16L9.4 11.6L3 10Z" fill="currentColor" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}

export function createWorkflowRuntime(props?: { session?: () => string | undefined }) {
  const sdk = useSDK()
  const sync = useSync()
  const params = useParams()
  const server = useServer()
  const platform = usePlatform()
  const [store, setStore] = createStore({
    loading: false,
    ready: false,
    snapshot: undefined as WorkflowSnapshot | undefined,
    cursor: 0,
    rootDiffs: [] as FileDiff[],
    rootDiffsReady: false,
  })

  const workflow = createMemo(() => store.snapshot)
  const currentSessionID = createMemo(() => props?.session?.() ?? params.id)
  const rootSession = createMemo(() => workflow()?.workflow.session_id)
  const rootSelected = createMemo(() => !!workflow() && currentSessionID() === rootSession())

  const request = async <T,>(
    path: string,
    init?: Omit<RequestInit, "body"> & { body?: BodyInit | Record<string, unknown> },
  ) => {
    const current = server.current
    if (!current) throw new Error("Server unavailable")
    const headers: Record<string, string> = {}
    if (current.http.password) {
      headers.Authorization = `Basic ${btoa(`${current.http.username ?? "opencode"}:${current.http.password}`)}`
    }
    let body = init?.body
    if (
      body &&
      typeof body !== "string" &&
      !(body instanceof FormData) &&
      !(body instanceof Blob) &&
      !(body instanceof ArrayBuffer) &&
      !ArrayBuffer.isView(body)
    ) {
      headers["Content-Type"] = "application/json"
      body = JSON.stringify(body)
    }
    const fetcher = platform.fetch ?? fetch
    const res = await fetcher(new URL(path, current.http.url), {
      ...init,
      headers: {
        ...headers,
        ...(init?.headers ?? {}),
      },
      body,
    })
    if (!res.ok) throw new Error(`Workflow request failed: ${res.status}`)
    return (await res.json()) as T
  }

  const refresh = async () => {
    const sessionID = currentSessionID()
    if (!sessionID) {
      setStore({ loading: false, ready: true, snapshot: undefined, cursor: 0, rootDiffs: [], rootDiffsReady: false })
      return
    }

    setStore("loading", true)
    setStore("ready", false)
    await request<WorkflowSnapshot>(`/workflow/session/${sessionID}`)
      .then(async (snap) => {
        if (!snap) {
          setStore({ loading: false, ready: true, snapshot: undefined, cursor: 0, rootDiffs: [], rootDiffsReady: false })
          return
        }

        setStore("snapshot", snap)
        setStore("cursor", snap.cursor)
        for (const id of [snap.workflow.session_id, ...snap.nodes.map((node) => node.session_id).filter(Boolean)]) {
          if (!id) continue
          void sync.session.sync(id)
        }

        if (sessionID !== snap.workflow.session_id) {
          setStore("rootDiffs", [])
          setStore("rootDiffsReady", false)
          return
        }

        await request<FileDiff[]>(`/workflow/${snap.workflow.id}/diff`)
          .then((diff) => {
            setStore("rootDiffs", diff ?? [])
            setStore("rootDiffsReady", true)
          })
          .catch(() => {
            setStore("rootDiffs", [])
            setStore("rootDiffsReady", true)
          })
      })
      .catch(() => {
        setStore({ loading: false, ready: true, snapshot: undefined, cursor: 0, rootDiffs: [], rootDiffsReady: false })
      })
      .finally(() => {
        setStore("loading", false)
        setStore("ready", true)
      })
  }

  const read = async () => {
    const snap = workflow()
    if (!snap) return
    await request<WorkflowReadResult>(`/workflow/${snap.workflow.id}/read?cursor=${store.cursor}`)
      .then((data) => {
        if (!data) return
        const changed =
          !!data.workflow ||
          !!data.runtime ||
          data.nodes.length > 0 ||
          data.edges.length > 0 ||
          data.checkpoints.length > 0 ||
          data.events.length > 0 ||
          (data.edits?.length ?? 0) > 0
        if (data.workflow) setStore("snapshot", "workflow", data.workflow)
        if (data.runtime) setStore("snapshot", "runtime", data.runtime)
        if (data.nodes.length > 0) setStore("snapshot", "nodes", (list) => mergeNodes(list ?? [], data.nodes))
        if (data.edges.length > 0) setStore("snapshot", "edges", data.edges)
        if (data.checkpoints.length > 0) setStore("snapshot", "checkpoints", data.checkpoints)
        if (data.events.length > 0) {
          setStore("snapshot", "events", (list) => [...(list ?? []), ...data.events].slice(-160))
        }
        // P3 — merge graph-edit deltas. Server returns the delta slice
        // (newly proposed + recently applied/rejected); we fold by id so
        // status transitions from `pending → applied` overwrite cleanly.
        if (data.edits && data.edits.length > 0) {
          setStore("snapshot", "edits", (list) => {
            const map = new Map((list ?? []).map((edit) => [edit.id, edit] as const))
            for (const edit of data.edits!) map.set(edit.id, edit)
            // Cap retained edits to keep the queue bounded — applied/rejected
            // entries older than the most recent 60 are dropped (they remain
            // on the server for audit; the panel just doesn't need them).
            return [...map.values()]
              .sort((a, b) => b.time.created - a.time.created)
              .slice(0, 60)
          })
        }
        setStore("cursor", data.cursor)
        return changed
      })
      .then(async (changed) => {
        if (!changed || !rootSelected()) return
        await request<FileDiff[]>(`/workflow/${snap.workflow.id}/diff`)
          .then((diff) => {
            setStore("rootDiffs", diff ?? [])
            setStore("rootDiffsReady", true)
          })
          .catch(() => {})
      })
      .catch(() => {})
  }

  createEffect(
    on(currentSessionID, () => {
      void refresh()
    }),
  )

  createEffect(() => {
    const snap = workflow()
    if (!snap) return
    const ms = done(snap.workflow.status) ? 30000 : 15000
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return
      void read()
    }, ms)
    onCleanup(() => clearInterval(timer))
  })

  const stop = sdk.event.listen((e) => {
    const snap = workflow()
    const event = e.details as WorkflowBusEvent
    if (!event.type.startsWith("workflow.")) return
    if (!snap) {
      void refresh()
      return
    }
    if (workflowIDFromEvent(event) !== snap.workflow.id) return
    void read()
  })

  onCleanup(stop)

  return {
    loading: () => store.loading,
    ready: () => store.ready,
    snapshot: workflow,
    rootSelected,
    rootDiffs: () => store.rootDiffs,
    rootDiffsReady: () => store.rootDiffsReady,
  }
}

export function WorkflowSessionStrip(props: {
  snapshot: WorkflowSnapshot
  currentSessionID?: string
  rootView: "graph" | "session"
  onSelectRootView: (view: "graph" | "session") => void
  onSelectSession: (sessionID: string) => void
}) {
  const sync = useSync()
  const nodes = createMemo(() => sortNodes(props.snapshot.nodes))
  const cards = createMemo(() => [
    {
      key: `${props.snapshot.workflow.session_id}:graph`,
      title: "Execution Map",
      note: "workflow",
      sessionID: props.snapshot.workflow.session_id,
      graph: true,
      status: props.snapshot.workflow.status,
    },
    {
      key: props.snapshot.workflow.session_id,
      title: "Orchestrator",
      note: "root session",
      sessionID: props.snapshot.workflow.session_id,
      graph: false,
      status: props.snapshot.workflow.status,
    },
    ...nodes().map((node) => ({
      key: node.session_id ?? node.id,
      title: node.title,
      note: node.agent,
      sessionID: node.session_id,
      graph: false,
      status: node.status,
    })),
  ])

  return (
    <div class="overflow-x-auto px-4 pt-4">
      <div class="flex min-w-max gap-2 rounded-[22px] border border-white/70 bg-[linear-gradient(180deg,rgba(255,255,255,0.92),rgba(248,250,252,0.86))] p-2 shadow-[0_16px_40px_rgba(15,23,42,0.06)]">
        <For each={cards()}>
          {(card) => {
            const active = () =>
              card.graph
                ? props.currentSessionID === props.snapshot.workflow.session_id && props.rootView === "graph"
                : !!card.sessionID &&
                  props.currentSessionID === card.sessionID &&
                  (card.sessionID !== props.snapshot.workflow.session_id || props.rootView === "session")
            const title = () => (card.graph || card.sessionID === props.snapshot.workflow.session_id ? card.title : sync.session.get(card.sessionID!)?.title ?? card.title)
            return (
              <button
                class="min-w-[140px] rounded-[18px] border px-3 py-3 text-left transition-all duration-200"
                classList={{
                  "border-sky-200 bg-sky-50/90 shadow-[0_12px_28px_rgba(56,189,248,0.12)]": active(),
                  "border-transparent bg-white/72 hover:border-slate-200 hover:bg-white": !active() && (card.graph || !!card.sessionID),
                  "cursor-not-allowed border-transparent bg-slate-100/70 opacity-65": !active() && !card.graph && !card.sessionID,
                }}
                disabled={!card.graph && !card.sessionID}
                onClick={() => {
                  if (card.graph) {
                    props.onSelectRootView("graph")
                    props.onSelectSession(props.snapshot.workflow.session_id)
                    return
                  }
                  if (!card.sessionID) return
                  if (card.sessionID === props.snapshot.workflow.session_id) props.onSelectRootView("session")
                  props.onSelectSession(card.sessionID)
                }}
              >
                <div class="flex items-center gap-2">
                  <span class={`size-2 rounded-full ${dot[tone(card.status)].split(" ").at(-1)}`} />
                  <span class="truncate text-[12px] font-semibold text-slate-950">{title()}</span>
                </div>
                <div class="truncate pt-1 text-[11px] text-slate-500">{card.note}</div>
              </button>
            )
          }}
        </For>
      </div>
    </div>
  )
}

export function WorkflowContextBar(props: { snapshot: WorkflowSnapshot; currentSessionID?: string }) {
  const params = useParams()
  const node = createMemo(() => props.snapshot.nodes.find((item) => item.session_id === props.currentSessionID))
  const refinerHref = createMemo(() => {
    const sessionID = props.currentSessionID ?? props.snapshot.workflow.session_id
    if (!params.dir || !sessionID) return undefined
    return `/${params.dir}/session/${sessionID}/refiner`
  })
  // P3 — count pending graph edits so the master can see proposals queued by
  // peers (or by itself before commit) without expanding the runtime panel.
  const pendingEdits = createMemo(
    () => (props.snapshot.edits ?? []).filter((edit) => edit.status === "pending").length,
  )
  // P1/P5 — show graph_rev and any terminal status when the workflow is no
  // longer active. Both are silent when not applicable (graph_rev undefined
  // on legacy data; status === "active" is the implicit norm).
  const graphRev = createMemo(() => props.snapshot.workflow.graph_rev)
  const wfStatus = createMemo(() => props.snapshot.workflow.status)
  return (
    <div class="px-4 pt-3">
      <div class="rounded-[22px] border border-white/70 bg-white/78 px-4 py-4 shadow-[0_16px_40px_rgba(15,23,42,0.05)]">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <Pill status={node()?.status ?? wfStatus()} />
            <div class="text-[16px] font-semibold tracking-[-0.02em] text-slate-950">
              {node()?.title ?? props.snapshot.workflow.title}
            </div>
            <Show when={typeof graphRev() === "number"}>
              <span
                title="Workflow graph revision (bumps on every applied topology change)"
                class="inline-flex h-6 items-center rounded-full border border-slate-200 bg-slate-50 px-2 font-mono text-[11px] text-slate-600"
              >
                rev #{graphRev()}
              </span>
            </Show>
            <Show when={pendingEdits() > 0}>
              <span
                title="Pending graph-edit proposals awaiting apply / reject"
                class="inline-flex h-6 items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 text-[11px] font-medium text-amber-700"
              >
                <span class="size-1.5 rounded-full bg-amber-500" />
                {pendingEdits()} pending edit{pendingEdits() === 1 ? "" : "s"}
              </span>
            </Show>
            <Show when={["completed", "failed", "cancelled"].includes(wfStatus())}>
              <span
                title="Workflow finalized — further graph writes are rejected"
                class="inline-flex h-6 items-center rounded-full border border-slate-300 bg-white px-2 text-[11px] font-medium text-slate-600"
              >
                finalized · {wfStatus()}
              </span>
            </Show>
          </div>
          <Show when={refinerHref()}>
            {(href) => (
              <a
                href={href()}
                class="inline-flex h-8 items-center rounded-full border border-slate-200 bg-white px-3 text-[12px] font-medium text-slate-700 transition hover:border-sky-300 hover:text-sky-700"
              >
                Refiner
              </a>
            )}
          </Show>
        </div>
        <div class="pt-2 text-[12px] text-slate-500">
          {node() ? `${node()!.agent} session` : goal(props.snapshot)}
        </div>
      </div>
    </div>
  )
}

export function WorkflowRuntimePanel(props: {
  snapshot: WorkflowSnapshot
  currentSessionID?: string
  onSelectSession: (sessionID: string) => void
  onSelectRootView?: (view: "graph" | "session") => void
  onWorkspaceClick?: () => void
  onNewTask?: () => void
  onDeleteTask?: (taskID: string) => void
  tasks?: WorkflowAppProps["tasks"]
  activeTaskId?: string
  onTaskSelect?: (taskID: string) => void
  /** Design-spec workflow tab from the unified shell substrip:
   *  canvas / chat / events. Default canvas. Dynamic node / sand-table
   *  tabs use the form `node:<id>` / `sand:<id>` — those values pass
   *  through here untouched and are interpreted downstream in WorkflowApp. */
  workflowTab?: string
}) {
  const sync = useSync()
  const dialog = useDialog()
  const providers = useProviders()
  const local = useLocal()
  const sdk = useSDK()
  const server = useServer()
  const platform = usePlatform()
  const navigate = useNavigate()
  const params = useParams()
  const [state, setState] = createStore({
    diff: {} as Record<string, FileDiff[] | undefined>,
    sand: {} as Record<string, SandTableDiscussion | undefined>,
  })
  let el: HTMLDivElement | undefined
  let root: Root | undefined

  const nodes = createMemo(() => sortNodes(props.snapshot.nodes))
  const now = createMemo(() => currentNode(props.snapshot))
  const pick = createMemo(
    () => props.snapshot.nodes.find((node) => node.session_id === props.currentSessionID)?.id ?? now()?.id,
  )
  const rootID = createMemo(() => props.snapshot.workflow.session_id)
  const status = createMemo<WorkflowAppProps["status"]>(() => {
    if (
      props.snapshot.runtime.active_node_id ||
      props.snapshot.runtime.waiting_node_ids.length > 0 ||
      props.snapshot.nodes.some((node) => tone(node.status) === "running")
    ) {
      return "running"
    }
    if (props.snapshot.nodes.some((node) => tone(node.status) === "failed")) return "failed"
    const value = tone(props.snapshot.workflow.status)
    if (value === "pending") return "idle"
    return value
  })
  const env = createMemo(() => {
    const vals = [
      now()?.state_json?.target_device,
      now()?.state_json?.target,
      now()?.state_json?.environment,
      props.snapshot.workflow.summary?.objective,
    ]
    for (const item of vals) {
      if (typeof item !== "string") continue
      if (/arm linux/i.test(item)) return "ARM Linux"
      if (/linux/i.test(item)) return "Linux"
      if (/ttys0/i.test(item)) return "ttyS0"
      if (item.trim()) return clip(item.trim(), 32)
    }
    return "Workflow"
  })
  const request = async <T,>(
    path: string,
    init?: Omit<RequestInit, "body"> & { body?: BodyInit | Record<string, unknown> },
  ) => {
    const current = server.current
    if (!current) throw new Error("Server unavailable")
    const headers: Record<string, string> = {}
    if (current.http.password) {
      headers.Authorization = `Basic ${btoa(`${current.http.username ?? "opencode"}:${current.http.password}`)}`
    }
    let body = init?.body
    if (
      body &&
      typeof body !== "string" &&
      !(body instanceof FormData) &&
      !(body instanceof Blob) &&
      !(body instanceof ArrayBuffer) &&
      !ArrayBuffer.isView(body)
    ) {
      headers["Content-Type"] = "application/json"
      body = JSON.stringify(body)
    }
    const fetcher = platform.fetch ?? fetch
    const res = await fetcher(new URL(path, current.http.url), {
      ...init,
      headers: {
        ...headers,
        ...(init?.headers ?? {}),
      },
      body,
    })
    if (!res.ok) throw new Error(`Workflow request failed: ${res.status}`)
    return (await res.json()) as T
  }
  const chats = createMemo<WorkflowAppProps["chats"]>(() => {
    // Collect every session id that the React workflow side might want to
    // render: root + every workflow node + every sand-table participant
    // (planner / evaluator). Participants live OUTSIDE the workflow node
    // graph, so the iteration over `nodes()` alone misses their chat —
    // the right-pane InnerStreamPane needs `chats[plannerSessionID]` to
    // populate the planner / evaluator stream views (#6 traceability).
    const ids = new Set<string>([rootID()])
    for (const node of nodes()) {
      if (node?.session_id) ids.add(node.session_id)
    }
    for (const sand of Object.values(state.sand)) {
      for (const part of sand?.participants ?? []) {
        if (part.sessionID) ids.add(part.sessionID)
      }
    }
    const nodeBySession = new Map<string, WorkflowNode>()
    for (const node of nodes()) {
      if (node?.session_id) nodeBySession.set(node.session_id, node)
    }
    return Object.fromEntries(
      [...ids].map((id) => {
        const node = nodeBySession.get(id)
        return [
          id,
          buildRows({
            dir: sdk.directory,
            messages: sync.data.message[id] ?? [],
            parts: sync.data.part,
            snap: props.snapshot,
            node,
          }).map((row) => ({
            id: row.id,
            role: row.role,
            content: row.body,
            timestamp: row.time,
            thinking: row.thinking,
            toolCall: row.toolCall,
            reasoning: row.reasoning,
            file: row.file,
            patch: row.patch,
            subtask: row.subtask,
            stepFinish: row.stepFinish,
            retry: row.retry,
            agent: row.agent,
            plan: row.plan,
            sandTable: row.sandTable as Msg["sandTable"],
            question: row.question as Msg["question"],
            permission: row.permission as Msg["permission"],
          })),
        ] as const
      }),
    )
  })
  const choices = createMemo(() =>
    local.model
      .list()
      .filter((item) => local.model.visible({ providerID: item.provider.id, modelID: item.id }))
      .map((item) => ({
        key: `${item.provider.id}/${item.id}`,
        label: `${item.provider.name} / ${item.name.replace("(latest)", "").trim()}`,
      })),
  )
  const currentModel = createMemo(() => {
    const item = local.model.current()
    if (!item) return undefined
    const key = `${item.provider.id}/${item.id}`
    return choices().find((entry) => entry.key === key)?.label ?? `${item.provider.name} / ${item.name.replace("(latest)", "").trim()}`
  })
  // Primary (non-subagent, non-hidden) agents the user can drive the
  // root session with. Surfaced to the chat panel so the header
  // renders an agent picker — before this, the root session was
  // hard-wired to orchestrator, which blocked the "I just want a
  // quick one-off task, not a long-chain workflow" use case.
  const rootAgents = createMemo(() => {
    return local.agent
      .list()
      .filter((item) => item.mode !== "subagent")
      .map((item) => item.name)
  })
  // Preferred default when no agent is active yet. Orchestrator wins
  // when it exists (now always, since it's shipped as a built-in
  // native agent) so workflows keep their out-of-the-box experience;
  // fall back to the first primary agent when the user has
  // explicitly disabled orchestrator in config.
  const preferredRootAgent = createMemo(() => {
    const items = local.agent.list()
    return (
      items.find((item) => item.name === "orchestrator" && item.mode !== "subagent")?.name ??
      items.find((item) => item.mode !== "subagent")?.name ??
      items[0]?.name
    )
  })
  // Seed the root agent only when the current selection is missing
  // or points at an agent that no longer exists. Previously this
  // effect force-snapped `local.agent` back to the preferred value
  // every tick, which made the header picker useless — any user
  // choice was immediately clobbered on the next memo re-evaluation.
  createEffect(() => {
    const primaries = rootAgents()
    const current = local.agent.current()?.name
    if (current && primaries.includes(current)) return
    const next = preferredRootAgent()
    if (!next) return
    local.agent.set(next)
  })
  createEffect(
    on(
      () => rootID(),
      () => {
        const id = rootID()
        if (!id) return
        const msg = [...(sync.data.message[id] ?? [])].reverse().find((item) => item.role === "user")
        if (!msg?.model?.providerID || !msg.model.modelID) return
        const current = local.model.current()
        if (current?.provider.id === msg.model.providerID && current.id === msg.model.modelID) return
        local.model.set({
          providerID: msg.model.providerID,
          modelID: msg.model.modelID,
        })
        if (msg.model.variant) local.model.variant.set(msg.model.variant)
      },
    ),
  )
  createEffect(() => {
    nodes().forEach((node) => {
      if (state.diff[node.id] !== undefined) return
      void request<FileDiff[]>(`/workflow/node/${node.id}/code_changes`)
        .then((diff) => {
          setState("diff", node.id, diff ?? [])
        })
        .catch(() => {
          setState("diff", node.id, [])
        })
    })
  })
  const details = createMemo<WorkflowAppProps["details"]>(() =>
    Object.fromEntries(
      nodes().map((node) => {
        const control = props.snapshot.events
          .filter((event) => event.kind === "node.control" && event.target_node_id === node.id)
          .toReversed()[0]
        const pull = props.snapshot.events
          .filter((event) => event.kind === "node.pulled" && event.node_id === node.id)
          .toReversed()[0]
        const update = props.snapshot.events
          .filter((event) => event.node_id === node.id && (event.kind === "node.updated" || event.source === "node"))
          .toReversed()[0]
        const pending = props.snapshot.events.filter(
          (event) => event.target_node_id === node.id && event.kind === "node.control" && event.id > (pull?.id ?? 0),
        ).length
        const executionLog = props.snapshot.events
          .filter((event) => event.node_id === node.id || event.target_node_id === node.id)
          .filter((event) => !event.kind.startsWith("workflow.orchestrator_wake"))
          .slice(-10)
          .map((event) => eventNote(event))
        return [
          node.id,
          {
            id: node.id,
            title: node.title,
            type: nodeKind(node),
            status: node.status,
            result: cap(node.result_status),
            model: modelLabel(node),
            attempt: `${node.attempt}/${node.max_attempts}`,
            actions: `${node.action_count}/${node.max_actions}`,
            sessionId: node.session_id ?? "not started",
            pendingCommands: pending,
            lastControl: control?.payload.command ? String(control.payload.command) : "none",
            lastPull: pull ? `#${pull.id}` : "none",
            lastUpdate: update ? `#${update.id}` : "none",
            stateJson: (node.state_json ?? node.result_json ?? {}) as Record<string, unknown>,
            codeChanges: state.diff[node.id] ?? [],
            executionLog,
          },
        ] as const
      }),
    ),
  )
  // The plan is derived from the master session's `sand_table` tool call.
  // During context compaction, history pagination, or transient sync windows
  // (e.g. brief moments while messages are re-fetched), `sandTableSummary`
  // can return `undefined` even though a plan still logically exists for
  // this root — the user reported "plan节点莫名消失" (plan node mysteriously
  // disappearing). To absorb those flickers, hold onto the last seen plan
  // keyed by rootID and surface it again whenever the live derivation
  // briefly drops to undefined. We invalidate the cache when the rootID
  // changes (so it never leaks across task switches).
  let sandPlanCache: { rootID: string; value: ReturnType<typeof sandTableSummary> } | undefined
  const sandPlan = createMemo(() => {
    const root = rootID()
    const fresh = sandTableSummary(sync.data.message[root] ?? [], sync.data.part)
    if (fresh) {
      sandPlanCache = { rootID: root, value: fresh }
      return fresh
    }
    if (sandPlanCache && sandPlanCache.rootID === root) return sandPlanCache.value
    return undefined
  })

  // Token stats for the root (master) session. We reuse the same helper
  // the per-session Context tab uses so numbers line up everywhere. The
  // metric is anchored to the *last* assistant message that reported
  // tokens — that's the live "context window so far" the orchestrator
  // is running against, which is what the topbar ring visualises.
  const tokenStats = createMemo<WorkflowAppProps["tokenStats"]>(() => {
    const msgs = sync.data.message[rootID()] ?? []
    if (!msgs.length) return undefined
    const metrics = getSessionContextMetrics(msgs, providers.all() as any)
    const ctx = metrics.context
    if (!ctx) return undefined
    return {
      totalTokens: ctx.total,
      inputTokens: ctx.input,
      outputTokens: ctx.output,
      contextLength: ctx.limit,
    }
  })
  const fetchSandTable = async (discussionID: string) => {
    const result = await request<SandTableDiscussion>(`/workflow/sand_table/${discussionID}`)
    setState("sand", discussionID, result)
    // The planner / evaluator sub-sessions live OUTSIDE the workflow node
    // graph (they're spawned by the orchestrator's `sand_table` tool, not
    // registered as workflow nodes), so the regular per-node sync sweep
    // doesn't pull their messages into `sync.data.message`. Poke each
    // participant's session into the sync store now that we know its id —
    // otherwise the InnerStreamPane is stuck on "Waiting for planner to
    // start thinking…" forever, even after planner has produced output.
    for (const part of result?.participants ?? []) {
      if (part.sessionID) void sync.session.sync(part.sessionID).catch(() => undefined)
    }
    return result
  }
  createEffect(() => {
    const plan = sandPlan()
    if (!plan?.id) return
    // Always fetch once on plan identity change — covers the "user just
    // opened the plan node" case so the view is not stuck on the fallback
    // object while waiting for the next poll tick.
    void fetchSandTable(plan.id).catch(() => undefined)
    if (plan.status !== "running") return
    // While the discussion is live, poll aggressively. The server is local
    // and the payload is small, so 1s keeps planner/evaluator bubbles
    // showing up nearly as soon as they post without waiting for the user
    // to exit and re-enter the node.
    const timer = setInterval(() => {
      void fetchSandTable(plan.id).catch(() => undefined)
    }, 1000)
    onCleanup(() => clearInterval(timer))
  })
  const chainData = createMemo<WorkflowAppProps["chains"] | undefined>(() => {
    type ChainNode = NonNullable<WorkflowAppProps["chains"]>[number]["nodes"][number]
    const wfRev = props.snapshot.workflow.graph_rev
    const allNodes = nodes()
    const plan = sandPlan()
    if (!plan && allNodes.length === 0) return undefined

    // Index events by node_id so each node card can show its latest
    // slave-agent activity in the bottom marquee. We pick the most
    // recent event and project a short status string from it.
    const liveStatusByNode = new Map<string, string>()
    const allEvents = props.snapshot.events ?? []
    const sorted = [...allEvents].sort((a, b) => b.time_created - a.time_created)
    for (const ev of sorted) {
      if (!ev.node_id) continue
      if (liveStatusByNode.has(ev.node_id)) continue
      const p = (ev.payload ?? {}) as Record<string, unknown>
      const txt =
        (typeof p["status"] === "string" && (p["status"] as string)) ||
        (typeof p["message"] === "string" && (p["message"] as string)) ||
        (typeof p["reason"] === "string" && (p["reason"] as string)) ||
        ev.kind
      liveStatusByNode.set(ev.node_id, `${ev.kind} · ${txt}`)
    }

    const renderable = (node: WorkflowNode): ChainNode => {
      const startRev = node.graph_rev_at_start
      const stale =
        typeof startRev === "number" && typeof wfRev === "number" && startRev < wfRev
      return {
        id: node.id,
        title: node.title,
        type: nodeKind(node) === "build" ? "build-flash" : (nodeKind(node) as "coding" | "debug" | "deploy"),
        status: tone(node.status),
        // Don't fall back to the root session id when a node hasn't
        // started yet — that lookup chain caused NodeSessionView to render
        // the MASTER session's messages for unstarted child nodes (the
        // user reported clicking a not-yet-running node and seeing the
        // orchestrator's chat). When session is undefined, the chat
        // panel renders an empty state, which is the correct UX.
        session: node.session_id ?? undefined,
        liveStatus: liveStatusByNode.get(node.id),
        stale,
      }
    }
    const planNode = (): ChainNode | undefined =>
      plan
        ? {
            id: `sand-table:${plan.id}`,
            title: plan.title,
            type: "plan",
            status: plan.status,
            session: rootID(),
            summary: sandPlanBadges(plan),
          }
        : undefined

    // Plan-only (no execution nodes yet): single chain so the planning header
    // doesn't get marooned inside the multi-lane layout.
    if (allNodes.length === 0) {
      return [
        {
          id: "workflow",
          label: props.snapshot.workflow.title || "Workflow",
          color: "#7578c5",
          nodes: [planNode()!],
        },
      ]
    }

    const edges = props.snapshot.edges ?? []

    // No edges → no DAG to decompose. Preserve historical single-chain
    // behaviour for legacy workflows that just declare a flat node list.
    if (edges.length === 0) {
      const merged: ChainNode[] = []
      const head = planNode()
      if (head) merged.push(head)
      for (const node of allNodes) merged.push(renderable(node))
      return [
        {
          id: "workflow",
          label: props.snapshot.workflow.title || "Workflow",
          color: "#7578c5",
          nodes: merged,
        },
      ]
    }

    // Topological lane decomposition (option B from the discussion).
    //
    // The canvas already supports multi-lane rendering (`isMulti` branch in
    // workflow-canvas.tsx — flex `wf-lanes` row with junction diamond + measured
    // crossbar). What was missing was producing > 1 chain when the underlying
    // graph actually has parallel branches. The master agent has been creating
    // proper DAGs (fan-out from a planning node into independent sub-tasks),
    // but `chainData` was flattening them all into a single linear chain
    // sorted by `position`, hiding the parallelism from the user.
    //
    // Algorithm:
    //   1. Build adjacency from edges; compute in-degree per node.
    //   2. Roots = nodes with in-degree 0 (sorted by position so left-to-right
    //      lane order matches creation order).
    //   3. Walk DFS from each root. At each step, pick the first unvisited
    //      child to continue the current lane and queue any remaining
    //      unvisited children as new lane heads. Each node is visited at most
    //      once globally (fan-in nodes appear in the lane of their first
    //      visiting parent only; this is the standard trade-off when
    //      projecting a DAG onto linear lanes).
    //   4. The plan (sand_table) header — when present — is prepended to the
    //      first lane only. Putting it in its own dedicated lane wastes a
    //      column; prepending matches the existing single-lane behaviour for
    //      lane 0 and keeps lanes 1..N visually parallel.
    const out = new Map<string, string[]>()
    const inDegree = new Map<string, number>()
    const positionOf = new Map<string, number>()
    allNodes.forEach((node, i) => {
      out.set(node.id, [])
      inDegree.set(node.id, 0)
      positionOf.set(node.id, i)
    })
    for (const edge of edges) {
      const from = out.get(edge.from_node_id)
      if (!from || !inDegree.has(edge.to_node_id)) continue
      from.push(edge.to_node_id)
      inDegree.set(edge.to_node_id, (inDegree.get(edge.to_node_id) ?? 0) + 1)
    }
    // Stable child ordering by position so lane spawn order matches the order
    // the master agent created the children in.
    for (const arr of out.values()) {
      arr.sort((a, b) => (positionOf.get(a) ?? 0) - (positionOf.get(b) ?? 0))
    }

    const nodeMap = new Map(allNodes.map((n) => [n.id, n] as const))
    const visited = new Set<string>()
    const lanes: WorkflowNode[][] = []
    const stack: string[] = allNodes
      .filter((n) => (inDegree.get(n.id) ?? 0) === 0)
      .map((n) => n.id)

    while (stack.length) {
      const startID = stack.shift()!
      if (visited.has(startID)) continue
      const lane: WorkflowNode[] = []
      let cursor: string | undefined = startID
      while (cursor && !visited.has(cursor)) {
        visited.add(cursor)
        const node = nodeMap.get(cursor)
        if (!node) break
        lane.push(node)
        const children: string[] = (out.get(cursor) ?? []).filter(
          (id) => !visited.has(id),
        )
        if (children.length === 0) {
          cursor = undefined
          break
        }
        const first: string = children[0]
        const rest: string[] = children.slice(1)
        // Push spawned lanes in reverse so popping (from front) preserves
        // left-to-right order on the next outer iteration.
        for (const id of rest.slice().reverse()) stack.unshift(id)
        cursor = first
      }
      if (lane.length > 0) lanes.push(lane)
    }

    // Defensive fallback: if a cycle slipped past P2's invariants and left
    // some nodes unvisited, append them as a single trailing lane so they
    // don't silently disappear.
    const orphans = allNodes.filter((n) => !visited.has(n.id))
    if (orphans.length > 0) lanes.push(orphans)
    // Empty result (shouldn't happen given the early guards) → single chain.
    // We include the plan head in this fallback too — without it, the
    // user reported "plan节点莫名消失" (plan node mysteriously disappears)
    // because hitting this branch (e.g. a malformed graph with all nodes
    // self-cycling) would render the canvas with execution nodes but no
    // planning header, even though `sandPlan()` was still populated.
    if (lanes.length === 0) {
      const head = planNode()
      const all: ChainNode[] = []
      if (head) all.push(head)
      for (const n of allNodes) all.push(renderable(n))
      return [
        {
          id: "workflow",
          label: props.snapshot.workflow.title || "Workflow",
          color: "#7578c5",
          nodes: all,
        },
      ]
    }

    // Tail merge detection. The LLM frequently produces DAGs where multiple
    // parallel branches converge into a single follow-up node (e.g. plan ->
    // [build, test, lint] -> deploy). The topological lane-decomposition
    // above places that fan-in node in the *first* visiting parent's lane
    // only, leaving sibling lanes ending mid-air with no visual indication
    // that they re-converge. The user reported this as "多节点是否会merge
    // 到同一个头/尾节点上" — they expect to see the tail.
    //
    // Heuristic: find a node that
    //   (a) has incoming edges from parents living in >= 2 different lanes
    //       (so it really IS a multi-lane merge, not just a serial join),
    //   (b) has no outgoing edge to any other node (so it's a true tail —
    //       avoids accidentally yanking a mid-graph join out of place).
    // If such a node exists, pull it out of its host lane and surface it as
    // a separate tail card. The canvas renders a mirror of the top
    // `BranchConnector` between the lanes and the tail card.
    const laneOf = new Map<string, number>()
    lanes.forEach((lane, i) => lane.forEach((n) => laneOf.set(n.id, i)))
    const incomingByID = new Map<string, string[]>()
    const hasOutgoing = new Set<string>()
    for (const edge of edges) {
      hasOutgoing.add(edge.from_node_id)
      const list = incomingByID.get(edge.to_node_id)
      if (list) list.push(edge.from_node_id)
      else incomingByID.set(edge.to_node_id, [edge.from_node_id])
    }

    let tailNode: WorkflowNode | undefined
    if (lanes.length > 1) {
      for (const node of allNodes) {
        if (hasOutgoing.has(node.id)) continue
        const parents = incomingByID.get(node.id) ?? []
        if (parents.length < 2) continue
        const distinctLanes = new Set<number>()
        for (const p of parents) {
          const li = laneOf.get(p)
          if (li !== undefined) distinctLanes.add(li)
        }
        if (distinctLanes.size >= 2) {
          tailNode = node
          break
        }
      }
    }

    // Strip the tail from whichever lane it currently lives in (it was put
    // there by the topological walk under "first visiting parent" rules).
    if (tailNode) {
      const id = tailNode.id
      for (let i = 0; i < lanes.length; i++) {
        const idx = lanes[i].findIndex((n) => n.id === id)
        if (idx !== -1) lanes[i].splice(idx, 1)
      }
    }

    const chains = lanes
      .filter((lane) => lane.length > 0)
      .map((lane, i, kept) => ({
        id: `lane-${i}-${lane[0].id}`,
        // The chain label only shows in multi-lane layout; fall back to the
        // workflow title if there's only one lane (single-lane keeps existing
        // header-hidden behaviour).
        label: kept.length > 1 ? lane[0].title : props.snapshot.workflow.title || "Workflow",
        // Let the canvas pick the lane color from its `laneColors` palette via
        // `colorIdx={i}`; leaving `color` undefined avoids forcing one tint
        // across all lanes.
        color: kept.length === 1 ? "#7578c5" : undefined,
        nodes: lane.map(renderable),
        // Tag the lane that fed the tail so consumers (canvas / debug) can
        // optionally surface "merges into …" hinting later. Cheap to attach;
        // ignored by the current canvas renderer.
        ...(tailNode && lane.some((n) => (incomingByID.get(tailNode!.id) ?? []).includes(n.id))
          ? { mergesInto: tailNode.id }
          : {}),
      }))

    const head = planNode()
    if (head && chains[0]) chains[0].nodes.unshift(head)

    // Attach the merge tail as a sibling field on the array via a tagged
    // property. We deliberately avoid changing `WorkflowAppProps["chains"]`
    // shape because the canvas already consumes a plain `Chain[]`; instead
    // the tail is plumbed through a separate `chainTail` prop on
    // `WorkflowApp` (see `chainTail` memo below).
    return chains
  })

  // Sibling memo to chainData(). Re-runs the same topological walk just to
  // emit the merge-tail node (or undefined). Cheap because the inputs are the
  // same memoised reactive sources.
  const chainTail = createMemo<WorkflowAppProps["chainTail"] | undefined>(() => {
    const allNodes = nodes()
    const edges = props.snapshot.edges ?? []
    if (allNodes.length < 2 || edges.length === 0) return undefined

    // Re-derive the lane assignment so we know which parents belong to
    // which lane. Sharing memoised state across two memos is awkward in
    // SolidJS so we just pay the linear-time cost twice.
    const out = new Map<string, string[]>()
    const inDegree = new Map<string, number>()
    const positionOf = new Map<string, number>()
    allNodes.forEach((node, i) => {
      out.set(node.id, [])
      inDegree.set(node.id, 0)
      positionOf.set(node.id, i)
    })
    for (const edge of edges) {
      const from = out.get(edge.from_node_id)
      if (!from || !inDegree.has(edge.to_node_id)) continue
      from.push(edge.to_node_id)
      inDegree.set(edge.to_node_id, (inDegree.get(edge.to_node_id) ?? 0) + 1)
    }
    for (const arr of out.values()) {
      arr.sort((a, b) => (positionOf.get(a) ?? 0) - (positionOf.get(b) ?? 0))
    }

    const visited = new Set<string>()
    const lanes: WorkflowNode[][] = []
    const stack: string[] = allNodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0).map((n) => n.id)
    while (stack.length) {
      const startID = stack.shift()!
      if (visited.has(startID)) continue
      const lane: WorkflowNode[] = []
      let cursor: string | undefined = startID
      while (cursor && !visited.has(cursor)) {
        visited.add(cursor)
        const node = allNodes.find((n) => n.id === cursor)
        if (!node) break
        lane.push(node)
        const children: string[] = (out.get(cursor) ?? []).filter((id) => !visited.has(id))
        if (children.length === 0) {
          cursor = undefined
          break
        }
        const first: string = children[0]
        const rest: string[] = children.slice(1)
        for (const id of rest.slice().reverse()) stack.unshift(id)
        cursor = first
      }
      if (lane.length > 0) lanes.push(lane)
    }
    if (lanes.length < 2) return undefined

    const laneOf = new Map<string, number>()
    lanes.forEach((lane, i) => lane.forEach((n) => laneOf.set(n.id, i)))
    const incomingByID = new Map<string, string[]>()
    const hasOutgoing = new Set<string>()
    for (const edge of edges) {
      hasOutgoing.add(edge.from_node_id)
      const list = incomingByID.get(edge.to_node_id)
      if (list) list.push(edge.from_node_id)
      else incomingByID.set(edge.to_node_id, [edge.from_node_id])
    }

    const wfRev = props.snapshot.workflow.graph_rev
    for (const node of allNodes) {
      if (hasOutgoing.has(node.id)) continue
      const parents = incomingByID.get(node.id) ?? []
      if (parents.length < 2) continue
      const distinctLanes = new Set<number>()
      for (const p of parents) {
        const li = laneOf.get(p)
        if (li !== undefined) distinctLanes.add(li)
      }
      if (distinctLanes.size < 2) continue
      const startRev = node.graph_rev_at_start
      const stale = typeof startRev === "number" && typeof wfRev === "number" && startRev < wfRev
      return {
        id: node.id,
        title: node.title,
        type: nodeKind(node) === "build" ? "build-flash" : (nodeKind(node) as "coding" | "debug" | "deploy"),
        status: tone(node.status),
        // Don't fall back to the root session id when a node hasn't
        // started yet — that lookup chain caused NodeSessionView to render
        // the MASTER session's messages for unstarted child nodes (the
        // user reported clicking a not-yet-running node and seeing the
        // orchestrator's chat). When session is undefined, the chat
        // panel renders an empty state, which is the correct UX.
        session: node.session_id ?? undefined,
        stale,
      }
    }
    return undefined
  })
  const detailsWithPlan = createMemo<WorkflowAppProps["details"]>(() => {
    const base = details()
    const plan = sandPlan()
    if (!plan) return base
    return {
      ...base,
      [`sand-table:${plan.id}`]: {
        id: `sand-table:${plan.id}`,
        title: plan.title,
        type: "plan",
        status: plan.status,
        result:
          plan.status === "completed"
            ? plan.finalPlan
              ? "Plan ready"
              : "Discussion complete"
            : plan.status === "failed"
              ? "Planning failed"
              : "Planning in progress",
        model:
          [...new Set(plan.history.map((item) => item.model).filter((item): item is string => !!item))]
            .slice(0, 2)
            .join(" / ") || "multi-agent",
        // Pull the first-seen planner / evaluator model out of the
        // discussion history so the Inspector can surface them as two
        // distinct chips. Before, the Inspector collapsed both into a
        // single "X / Y" Model chip and users couldn't tell which model
        // was drafting vs critiquing without opening the Plan view.
        plannerModel: plan.history.find((item) => item.role === "planner" && !!item.model)?.model ?? undefined,
        evaluatorModel: plan.history.find((item) => item.role === "evaluator" && !!item.model)?.model ?? undefined,
        attempt: `${Math.max(plan.rounds, 0)}`,
        actions: `${plan.history.length} messages`,
        sessionId: plan.sessionID,
        pendingCommands: 0,
        lastControl: "n/a",
        lastPull: "n/a",
        lastUpdate: "n/a",
        stateJson: {
          sand_table_id: plan.id,
          topic: plan.topic,
          rounds: plan.rounds,
          status: plan.status,
          final_plan: plan.finalPlan,
          last_evaluation: plan.lastEvaluation,
        },
        executionLog: plan.history.map((item) => {
          const role = item.role ? cap(item.role) : "Message"
          return `${role}${item.round ? ` · round ${item.round}` : ""} · ${clip(item.content ?? "", 140)}`
        }),
      },
    }
  })
  const sandTables = createMemo<WorkflowAppProps["sandTables"]>(() => {
    const plan = sandPlan()
    if (!plan) return {}
    return {
      [`sand-table:${plan.id}`]: state.sand[plan.id] ?? {
        id: plan.id,
        topic: plan.topic,
        context: "",
        round: plan.rounds,
        max_rounds: Math.max(plan.rounds, 3),
        status: (plan.status === "pending" ? "running" : plan.status) as SandTableDiscussion["status"],
        participants: [],
        current_plan: plan.finalPlan,
        last_evaluation: plan.lastEvaluation,
        messages: plan.history.map((item) => ({
          role: (item.role === "planner" || item.role === "evaluator" || item.role === "orchestrator"
            ? item.role
            : "orchestrator") as "planner" | "evaluator" | "orchestrator",
          model: item.model ?? "",
          content: item.content ?? "",
          round: item.round ?? 1,
          timestamp: Date.now(),
        })),
      },
    }
  })
  const flow = createMemo<WorkflowAppProps["flow"]>(() => ({
    goal: goal(props.snapshot),
    phase: cap(props.snapshot.runtime.phase),
    overallStatus: status(),
  }))
  const agents = createMemo<WorkflowAppProps["agents"]>(() => {
    const byAgent = new Map<string, WorkflowNode[]>()
    sortNodes(props.snapshot.nodes).forEach((node) => {
      const list = byAgent.get(node.agent)
      if (list) list.push(node)
      else byAgent.set(node.agent, [node])
    })
    return agentRows(props.snapshot).map((node) => ({
      name: node.agent,
      model: modelLabel(node),
      role: node.title,
      nodeIDs: (byAgent.get(node.agent) ?? [node]).map((n) => n.id),
    }))
  })
  const canvas = createMemo<WorkflowAppProps["nodes"]>(() => {
    const wfRev = props.snapshot.workflow.graph_rev
    return nodes().map((node) => {
      // P5 — a node is "stale" when it started against an older graph_rev than
      // the workflow's current revision. A subsequent edit may have invalidated
      // its inputs, so we surface a small badge in the canvas.
      const startRev = node.graph_rev_at_start
      const stale =
        typeof startRev === "number" && typeof wfRev === "number" && startRev < wfRev
      return {
        id: node.id,
        title: node.title,
        type: nodeKind(node) === "build" ? "build-flash" : (nodeKind(node) as "coding" | "debug" | "deploy"),
        status: tone(node.status),
        // Don't fall back to the root session id when a node hasn't
        // started yet — that lookup chain caused NodeSessionView to render
        // the MASTER session's messages for unstarted child nodes (the
        // user reported clicking a not-yet-running node and seeing the
        // orchestrator's chat). When session is undefined, the chat
        // panel renders an empty state, which is the correct UX.
        session: node.session_id ?? undefined,
        summary: modelReady(node) ? [modelLabel(node)] : ["route model"],
        stale,
      }
    })
  })

  const unroutedNodes = createMemo(() => nodes().filter((node) => !modelReady(node)))

  // Target nodeIDs that should receive the model the user picks from the native dialog.
  // Set when the user clicks a specific agent's model pill, consumed after local.model changes.
  let pendingRouteTargets: string[] | null = null

  // Snapshot of the chat-session model captured before opening a NODE-SCOPED picker.
  // Restored after `forceRouteNodes` so picking a model for a workflow node never
  // hijacks the user's active session model. Tristate:
  //   `null`     — no node-scoped pick in flight (don't restore on next effect tick)
  //   `undefined`— save was made but the user had no model active before
  //   {...}      — save was made; restore this ModelKey after routing
  type ModelKeySave = { providerID: string; modelID: string } | undefined
  let savedModelKey: ModelKeySave | null = null

  const pickModel = (targetNodeIDs?: string[]) => {
    pendingRouteTargets = targetNodeIDs && targetNodeIDs.length > 0 ? [...targetNodeIDs] : null
    if (pendingRouteTargets) {
      const m = local.model.current()
      savedModelKey = m ? { providerID: m.provider.id, modelID: m.id } : undefined
    } else {
      savedModelKey = null
    }
    // Clear pending targets AFTER the reactive effect for `local.model` has a chance to
    // consume them. Without this, a later non-node-scoped model change (e.g. chat panel
    // picker) would accidentally re-route stale targets.
    // Deferred via double-microtask/setTimeout so it runs after SolidJS's effect queue.
    const onClose = () => {
      setTimeout(() => {
        pendingRouteTargets = null
        // If the user closed the dialog without picking a different model, the effect
        // never fired — drop the saved snapshot to avoid restoring on a later pick.
        savedModelKey = null
      }, 0)
    }
    if (providers.connected().length > 0) {
      dialog.show(() => <DialogSelectModel />, onClose)
      return
    }
    dialog.show(() => <DialogSelectProvider />, onClose)
  }

  // Force-route specific nodes to the current local.model (unlike routeNodesToCurrentModel,
  // this overwrites already-routed nodes too — used for user-driven re-routing via the agent pill).
  const forceRouteNodes = async (nodeIDs: string[]) => {
    const current = local.model.current()
    if (!current || nodeIDs.length === 0) return
    const variant = local.model.variant.selected() ?? undefined
    await Promise.all(
      nodeIDs.map((id) =>
        request<WorkflowNode>(`/workflow/node/${id}`, {
          method: "PATCH",
          body: {
            source: "ui",
            patch: {
              model: {
                providerID: current.provider.id,
                modelID: current.id,
                variant,
              },
            },
            event: {
              kind: "node.routed",
              payload: {
                providerID: current.provider.id,
                modelID: current.id,
                variant,
                source: "workflow_panel",
              },
            },
          },
        }),
      ),
    )
  }

  // When the user picks a model from the native dialog, route the pending target nodes.
  // For node-scoped picks we ALSO restore the pre-pick chat-session model afterwards so the
  // user's active session model isn't hijacked by the node-routing flow.
  createEffect(
    on(
      () => {
        const m = local.model.current()
        return m ? `${m.provider.id}/${m.id}` : null
      },
      (_key, prev) => {
        if (prev === undefined) return // skip initial run
        const targets = pendingRouteTargets
        if (!targets) return
        pendingRouteTargets = null
        const restoreKey = savedModelKey
        savedModelKey = null
        void forceRouteNodes(targets)
          .catch(() => undefined)
          .finally(() => {
            // Only restore if we actually captured a snapshot for this pick.
            // `null` means non-node-scoped pick — leave the user's selection intact.
            if (restoreKey === null) return
            // `{ recent: false }` so we don't pollute the recent-models list with the
            // restore. The createEffect WILL fire again, but pendingRouteTargets is
            // already null at that point, so the early-exit guard prevents recursion.
            local.model.set(restoreKey, { recent: false })
          })
      },
    ),
  )

  const sessionID = (node?: string) =>
    props.snapshot.nodes.find((item) => item.id === node)?.session_id ?? rootID()

  const openSession = (node?: string) => {
    if (!node) {
      openRootSession()
      return
    }
    const id = sessionID(node)
    props.onSelectSession(id)
  }

  const openRefiner = (node?: string) => {
    const id = sessionID(node)
    const dir = sdk.directory ? base64Encode(sdk.directory) : params.dir
    if (!id || !dir) return
    // SPA navigation preserves history so the user's "back" button returns to
    // the workflow view. Previous code used `window.location.assign` which
    // triggered a full page load and broke the SPA history stack — going back
    // would surface the legacy opencode shell instead of the new workflow.
    navigate(`/${dir}/session/${id}/refiner`)
  }

  const openRetrieve = (node?: string) => {
    const id = sessionID(node)
    const dir = sdk.directory ? base64Encode(sdk.directory) : params.dir
    if (!id || !dir) return
    // See `openRefiner` above — keep this on the SPA navigator for the same
    // reason (back-button history preservation).
    navigate(`/${dir}/session/${id}/retrieve`)
  }

  const send = (text: string, node?: string) => {
    const body = text.trim()
    const id = sessionID(node)
    const info = node ? props.snapshot.nodes.find((item) => item.id === node) : undefined
    const agent = info?.agent ?? local.agent.current()?.name ?? preferredRootAgent()
    const rootModel = local.model.current()
    const rootVariant = local.model.variant.selected() ?? undefined
    const model = info?.model?.providerID && info?.model?.modelID
      ? {
          providerID: info.model.providerID,
          modelID: info.model.modelID,
        }
      : rootModel
        ? {
            providerID: rootModel.provider.id,
            modelID: rootModel.id,
          }
        : undefined
    const variant = info?.model?.variant ?? rootVariant
    if (!body || !id || !agent) return

    // Mirror the legacy chat composer (`packages/app/src/components/prompt-input/submit.ts`,
    // slash-command branch around line 455): if the user typed a `/foo …` that
    // matches a configured custom command (`sync.data.command`), dispatch via
    // `client.session.command(...)` instead of `promptAsync(...)`. Without this
    // the workflow panel's `send` would post the literal "/foo …" as plain
    // user text and the server would never expand it as a command.
    if (body.startsWith("/")) {
      const [cmdName, ...args] = body.split(" ")
      const commandName = cmdName.slice(1)
      const customCommand = sync.data.command.find((c) => c.name === commandName)
      if (customCommand) {
        const modelString = model ? `${model.providerID}/${model.modelID}` : undefined
        if (!modelString) return
        void sdk.client.session
          .command({
            sessionID: id,
            directory: sdk.directory,
            command: commandName,
            arguments: args.join(" "),
            agent,
            model: modelString,
            variant,
          })
          .then(() => {
            void sync.session.sync(id, { force: true })
          })
          .catch(() => undefined)
        return
      }
    }

    const msg = Identifier.ascending("message")
    const part = Identifier.ascending("part")
    const run = async () => {
      sync.session.optimistic.add({
        directory: sdk.directory,
        sessionID: id,
        message: {
          id: msg,
          sessionID: id,
          role: "user",
          time: { created: Date.now() },
          agent,
          model: {
            ...(model ?? {
              providerID: "opencode",
              modelID: "workflow",
            }),
            ...(variant !== undefined ? { variant } : {}),
          },
        },
        parts: [
          {
            id: part,
            type: "text",
            text: body,
            sessionID: id,
            messageID: msg,
          },
        ],
      })
      await sdk.client.session.promptAsync({
        sessionID: id,
        directory: sdk.directory,
        agent,
        model,
        messageID: msg,
        parts: [{ type: "text", text: body }],
        variant,
      })
      void sync.session.sync(id, { force: true })
    }
    void run().catch(() => {
      sync.session.optimistic.remove({
        directory: sdk.directory,
        sessionID: id,
        messageID: msg,
      })
    })
  }

  const control = (kind: keyof typeof controlText, opts?: { abort?: boolean }) => {
    const agent = local.agent.current()?.name ?? preferredRootAgent()
    const model = local.model.current()
    const variant = local.model.variant.selected() ?? undefined
    if (!agent) return
    const run = async () => {
      if (opts?.abort) {
        // Abort root session + all child node sessions in parallel
        const abortTargets = [
          rootID(),
          ...props.snapshot.nodes
            .map((n) => n.session_id)
            .filter((id): id is string => !!id && id !== rootID()),
        ]
        await Promise.all(
          abortTargets.map((id) =>
            sdk.client.session.abort({ sessionID: id, directory: sdk.directory }).catch(() => undefined),
          ),
        )
      }
      await sdk.client.session.promptAsync({
        sessionID: rootID(),
        directory: sdk.directory,
        agent,
        model: model
          ? {
              providerID: model.provider.id,
              modelID: model.id,
            }
          : undefined,
        parts: [{ type: "text", text: controlText[kind] }],
        variant,
      })
      void sync.session.sync(rootID(), { force: true })
    }
    void run()
  }

  const hardControl = (kind: "pause" | "abort") => {
    const run = async () => {
      await sdk.client.session.abort({ sessionID: rootID(), directory: sdk.directory }).catch(() => undefined)

      const targets = props.snapshot.nodes.filter((node) => {
        if (kind === "pause") {
          return !!node.session_id && ["running", "waiting", "interrupted"].includes(node.status)
        }
        return !["completed", "failed", "cancelled"].includes(node.status)
      })

      await Promise.all(
        targets.map((node) =>
          request<WorkflowNode>(`/workflow/node/${node.id}/${kind}`, {
            method: "POST",
            body: {
              reason: kind === "pause" ? "paused_from_workflow_panel" : "aborted_from_workflow_panel",
            },
          }).catch(() => undefined),
        ),
      )

      void sync.session.sync(rootID(), { force: true })
      for (const id of targets.map((node) => node.session_id).filter(Boolean)) {
        void sync.session.sync(id!, { force: true })
      }
    }
    void run()
  }

  const openRootSession = () => {
    if (props.onSelectRootView) {
      props.onSelectRootView("session")
      return
    }
    props.onSelectSession(props.snapshot.workflow.session_id)
  }

  const changeModel = (label: string) => {
    const picked = choices().find((item) => item.label === label)
    if (!picked) return
    const [providerID, modelID] = picked.key.split("/")
    if (!providerID || !modelID) return
    local.model.set(
      {
        providerID,
        modelID,
      },
      { recent: true },
    )
  }

  const runApprovedPlan = (plan: WorkflowPlan) => {
    const payload = JSON.stringify({ plan }, null, 2)
    send(
      [
        "The user approved this workflow plan for graph creation.",
        "Create or update the workflow runtime from this exact approved plan.",
        "Do not invent a new plan or skip graph creation.",
        "Materialize workflow nodes, edges, and checkpoints from the JSON below.",
        "Do not call workflow_node_start yet.",
        "Do not create child execution sessions yet.",
        "Leave node models unset unless the plan explicitly includes routing.",
        "After the graph is created, stop and wait for the user to confirm model routing before execution.",
        "",
        "```json",
        payload,
        "```",
      ].join("\n"),
    )
  }

  const routeNodesToCurrentModel = async (nodeIDs?: string[]) => {
    const current = local.model.current()
    if (!current) {
      pickModel()
      return false
    }
    const variant = local.model.variant.selected() ?? undefined
    const targets = (nodeIDs?.length
      ? nodes().filter((node) => nodeIDs.includes(node.id) && !modelReady(node))
      : unroutedNodes())
    if (targets.length === 0) return true
    await Promise.all(
      targets.map((node) =>
        request<WorkflowNode>(`/workflow/node/${node.id}`, {
          method: "PATCH",
          body: {
            source: "ui",
            patch: {
              model: {
                providerID: current.provider.id,
                modelID: current.id,
                variant,
              },
            },
            event: {
              kind: "node.routed",
              payload: {
                providerID: current.provider.id,
                modelID: current.id,
                variant,
                source: "workflow_panel",
              },
            },
          },
        }),
      ),
    )
    return true
  }

  const executeWorkflow = (nodeID?: string) => {
    const run = async () => {
      if (!nodeID && nodes().length === 0) {
        send(
          [
            "Create the workflow graph from the latest approved plan first.",
            "Do not start execution yet.",
            "After graph creation, wait for user model routing confirmation before calling workflow_node_start.",
          ].join("\n"),
        )
        return
      }
      const routed = await routeNodesToCurrentModel(nodeID ? [nodeID] : undefined)
      if (!routed) return
      if (nodeID) {
        const node = nodes().find((item) => item.id === nodeID)
        if (!node) return
        send(
          [
            `Execution routing is confirmed for workflow node ${node.title} (${node.id}).`,
            "Use the workflow runtime as the source of truth.",
            "Do not rebuild the graph.",
            "Start only this node when its providerID and modelID are configured, and leave all other nodes unchanged unless dependencies require action.",
          ].join("\n"),
        )
        return
      }
      send(controlText.run)
    }
    void run().catch(() => undefined)
  }

  const revisePlanWithContext = (context: string) => {
    const extra = context.trim()
    if (!extra) return
    send(
      `Revise the current workflow plan using this additional context before execution:\n\n${extra}`,
    )
  }
  const sendSandTable = async (nodeID: string, text: string) => {
    const detail = detailsWithPlan()[nodeID]
    const discussionID =
      typeof detail?.stateJson?.sand_table_id === "string" ? detail.stateJson.sand_table_id : undefined
    const body = text.trim()
    if (!discussionID || !body) return
    const result = await request<SandTableDiscussion>(`/workflow/sand_table/${discussionID}/message`, {
      method: "POST",
      body: {
        content: body,
        role: "orchestrator",
      },
    })
    setState("sand", discussionID, result)
  }

  // ── Question & Permission polling ──────────────────────────────────

  const [pendingQuestions, setPendingQuestions] = createStore<any[]>([])
  const [pendingPermissions, setPendingPermissions] = createStore<any[]>([])

  const pollQuestionsAndPermissions = async () => {
    try {
      const [questions, permissions] = await Promise.all([
        request<any[]>("/question").catch(() => []),
        request<any[]>("/permission").catch(() => []),
      ])
      setPendingQuestions(questions ?? [])
      setPendingPermissions(permissions ?? [])
    } catch {
      // Ignore polling errors
    }
  }

  // Poll every 2s when running
  createEffect(() => {
    if (status() !== "running") return
    void pollQuestionsAndPermissions()
    const timer = setInterval(pollQuestionsAndPermissions, 2000)
    onCleanup(() => clearInterval(timer))
  })

  // Inject pending questions/permissions into root chat as virtual messages
  // Server-side custom slash commands surfaced into the chat-panel palette.
  // The `sync.data.command` array is populated by `Config.command` from
  // `{command,commands}/**/*.md` files (see `packages/opencode/src/config/command.ts`).
  // Without this wiring users see only the built-ins (`/undo`, `/redo`, ...)
  // and project-defined commands like `/tmp`, `/notrack` are invisible.
  const chatExtraCommands = createMemo<WorkflowAppProps["chatExtraCommands"]>(() =>
    (sync.data.command ?? []).map((cmd) => ({
      id: `srv-${cmd.name}`,
      trigger: cmd.name,
      title: `/${cmd.name}`,
      description: cmd.description ?? "",
      category: "session" as const,
      // Server-defined commands (notrack, tmp, …) are typically prefixes
      // for a user-supplied message — picking them from the popover should
      // *insert* `/<cmd> ` into the input so the user can keep typing,
      // not auto-send a bare `/<cmd>`. The actual server-side dispatch
      // happens later when the user presses Enter and `send()` recognises
      // the leading slash via `client.session.command(...)`.
      action: "insert" as const,
    })),
  )

  const chatsWithDialogs = createMemo<WorkflowAppProps["chats"]>(() => {
    const base = chats()
    const rid = rootID()
    const rootMsgs = [...(base[rid] ?? [])]

    // Append pending questions as virtual messages
    for (const q of pendingQuestions) {
      if (!q?.id) continue
      rootMsgs.push({
        id: `question:${q.id}`,
        role: "assistant" as const,
        content: "",
        timestamp: fmt(Date.now()),
        question: {
          id: q.id,
          sessionID: q.sessionID ?? rid,
          questions: q.questions ?? [],
        },
      })
    }

    // Append pending permissions as virtual messages
    for (const p of pendingPermissions) {
      if (!p?.id) continue
      rootMsgs.push({
        id: `permission:${p.id}`,
        role: "assistant" as const,
        content: "",
        timestamp: fmt(Date.now()),
        permission: {
          id: p.id,
          sessionID: p.sessionID ?? rid,
          permission: p.permission ?? "",
          patterns: p.patterns ?? [],
          metadata: p.metadata ?? {},
        },
      })
    }

    return { ...base, [rid]: rootMsgs }
  })

  const replyQuestion = async (requestID: string, answers: string[][]) => {
    try {
      const current = server.current
      if (!current) return
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (current.http.password) {
        headers.Authorization = `Basic ${btoa(`${current.http.username ?? "opencode"}:${current.http.password}`)}`
      }
      const fetcher = platform.fetch ?? fetch
      await fetcher(new URL(`/question/${requestID}/reply`, current.http.url), {
        method: "POST",
        headers,
        body: JSON.stringify({ answers }),
      })
      setPendingQuestions((prev) => prev.filter((q) => q.id !== requestID))
    } catch (err) {
      console.error("question reply failed", err)
    }
  }

  const rejectQuestion = async (requestID: string) => {
    try {
      const current = server.current
      if (!current) return
      const headers: Record<string, string> = {}
      if (current.http.password) {
        headers.Authorization = `Basic ${btoa(`${current.http.username ?? "opencode"}:${current.http.password}`)}`
      }
      const fetcher = platform.fetch ?? fetch
      await fetcher(new URL(`/question/${requestID}/reject`, current.http.url), {
        method: "POST",
        headers,
      })
      setPendingQuestions((prev) => prev.filter((q) => q.id !== requestID))
    } catch (err) {
      console.error("question reject failed", err)
    }
  }

  const replyPermission = async (requestID: string, reply: string, message?: string) => {
    try {
      const current = server.current
      if (!current) return
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (current.http.password) {
        headers.Authorization = `Basic ${btoa(`${current.http.username ?? "opencode"}:${current.http.password}`)}`
      }
      const fetcher = platform.fetch ?? fetch
      await fetcher(new URL(`/permission/${requestID}/reply`, current.http.url), {
        method: "POST",
        headers,
        body: JSON.stringify({ reply, message }),
      })
      setPendingPermissions((prev) => prev.filter((p) => p.id !== requestID))
    } catch (err) {
      console.error("permission reply failed", err)
    }
  }

  createEffect(() => {
    if (!el) return
    root ??= createRoot(el)
    root.render(
      createElement(WorkflowApp, {
        root: props.snapshot.workflow.session_id,
        title: props.snapshot.workflow.title,
        status: status(),
        env: env(),
        // Design-spec sub-tab from the unified shell substrip. Dynamic
        // tabs (node:<id> / sand:<id>) pass through; WorkflowApp treats
        // any non-fixed value as "canvas" + sets sessionNode internally.
        view: ((props.workflowTab ?? "canvas") as "canvas" | "chat" | "events"),
        model: currentModel(),
        models: choices().map((item) => item.label),
        workspace: sdk.directory,
        tasks: props.tasks,
        activeTaskId: props.activeTaskId,
        pick: pick(),
        nodes: canvas(),
        chains: chainData(),
        chainTail: chainTail(),
        details: detailsWithPlan(),
        flow: flow(),
        agents: agents(),
        tokenStats: tokenStats(),
        // Pre-project workflow events for the timeline tab — sort happens
        // in the React side; here we just pick the right fields and join
        // with the node title so each row can deep-link.
        workflowEvents: (props.snapshot.events ?? []).map((ev) => {
          const node = ev.node_id
            ? props.snapshot.nodes.find((n) => n.id === ev.node_id)
            : undefined
          // Build a human-readable summary from the payload — the kind
          // alone is too terse, but the full payload is too noisy. Pick
          // a few common fields if present.
          const p = (ev.payload ?? {}) as Record<string, unknown>
          const summaryBits: string[] = []
          for (const k of ["status", "reason", "message", "result", "error"]) {
            const v = p[k]
            if (typeof v === "string" && v.length > 0) {
              summaryBits.push(`${k}=${v.length > 60 ? v.slice(0, 60) + "…" : v}`)
            }
          }
          return {
            id: ev.id,
            kind: ev.kind,
            source: ev.source,
            nodeID: ev.node_id ?? undefined,
            nodeTitle: node?.title,
            summary: summaryBits.length > 0 ? summaryBits.join(" · ") : ev.kind,
            time: ev.time_created,
          }
        }),
        chats: chatsWithDialogs(),
        chatExtraCommands: chatExtraCommands(),
        sandTables: sandTables(),
        onSession: openSession,
        onRefiner: openRefiner,
        onRetrieve: openRetrieve,
        onTaskSelect: props.onTaskSelect,
        onModel: pickModel,
        onModelChange: changeModel,
        onWorkspaceClick: props.onWorkspaceClick,
        onNewTask: props.onNewTask,
        onDeleteTask: props.onDeleteTask,
        onRun: (nodeID) => executeWorkflow(nodeID),
        onRestart: () => control("restart"),
        onStop: () => hardControl("abort"),
        onPause: () => hardControl("pause"),
        // Narrow "interrupt orchestrator only" path for the chat-panel
        // send→stop button. Unlike hardControl("abort"), this does not
        // touch child node sessions — the user is just cancelling a
        // reply, not killing the workflow.
        onStopMaster: () => {
          void sdk.client.session
            .abort({ sessionID: rootID(), directory: sdk.directory })
            .catch(() => undefined)
            .then(() => {
              void sync.session.sync(rootID(), { force: true })
            })
        },
        // Root-session agent: surfaced to the chat header so the user
        // can switch away from orchestrator for quick one-off tasks.
        rootAgent: local.agent.current()?.name,
        rootAgents: rootAgents(),
        onRootAgentChange: (name) => local.agent.set(name),
        onSend: send,
        onPlanRun: runApprovedPlan,
        onPlanEdit: revisePlanWithContext,
        onQuestionReply: replyQuestion,
        onQuestionReject: rejectQuestion,
        onPermissionReply: replyPermission,
        onSandTableSend: (nodeID, text) => {
          void sendSandTable(nodeID, text).catch(() => undefined)
        },
        // History pagination for the master (root) session. Without these
        // the ChatPanel "Load earlier messages" button runs out of
        // in-memory groups at 80 messages and the earliest turns are
        // unreachable. `more()` returns true when there's still a
        // server-side cursor; `loadMore` triggers a prepend fetch.
        historyHasMore: sync.session.history.more(rootID()),
        historyLoading: sync.session.history.loading(rootID()),
        onLoadMoreHistory: () => {
          void sync.session.history.loadMore(rootID()).catch(() => undefined)
        },
        // P1/P3/P5 — dynamic-graph wire-up. We forward the raw edits list
        // (the React app will filter to `pending` for the chip count) plus
        // the workflow-level rev / finalised status. Action callbacks hit
        // the new HTTP routes added in P3-P5; they're best-effort and
        // surface failures to the console — the panel's polling loop will
        // re-sync the edit row's status on the next read() tick anyway.
        graphRev: props.snapshot.workflow.graph_rev,
        pendingEdits: props.snapshot.edits as WorkflowAppProps["pendingEdits"],
        finalizedStatus: (["completed", "failed", "cancelled"] as const).includes(
          props.snapshot.workflow.status as "completed",
        )
          ? (props.snapshot.workflow.status as "completed" | "failed" | "cancelled")
          : undefined,
        // The runtime's bus listener auto-fires `read()` on `workflow.*`
        // events (which `proposeEdit / applyEdit / rejectEdit / finalize`
        // all emit), so we don't need to manually re-poll here — the
        // panel state catches up within a tick of the server commit.
        onApplyEdit: (editID: string) => {
          void request(`/workflow/edits/${editID}/apply`, { method: "POST" }).catch((err) =>
            console.error("apply edit failed", err),
          )
        },
        onRejectEdit: (editID: string, reason: string) => {
          void request(`/workflow/edits/${editID}/reject`, {
            method: "POST",
            body: { reject_reason: reason },
          }).catch((err) => console.error("reject edit failed", err))
        },
        onFinalize: (status, failReason) => {
          void request(`/workflow/${props.snapshot.workflow.id}/finalize`, {
            method: "POST",
            body: { status, fail_reason: failReason },
          }).catch((err) => console.error("finalize workflow failed", err))
        },
        // Plumb the live opencode HTTP server through React context so
        // plugins (currently the serial monitor) can reach `/serial/*` and
        // open the per-session websocket without re-discovering the URL.
        runtime: (() => {
          const current = server.current
          if (!current) return null
          const auth = current.http.password
            ? `Basic ${btoa(`${current.http.username ?? "opencode"}:${current.http.password}`)}`
            : undefined
          return { apiBase: current.http.url, authHeader: auth }
        })(),
      }),
    )
  })

  onCleanup(() => root?.unmount())

  return <div ref={el} class="size-full" />
}
