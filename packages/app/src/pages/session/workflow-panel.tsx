import type { FileDiff, Message, Part, TextPart, ToolPart } from "@opencode-ai/sdk/v2/client"
import { createEffect, createMemo, For, on, onCleanup, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams } from "@solidjs/router"
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
  cursor: number
}

type WorkflowReadResult = {
  workflow?: WorkflowInfo
  runtime?: WorkflowRuntime
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  checkpoints: WorkflowCheckpoint[]
  events: WorkflowEvent[]
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
  const rows: Row[] = [
    {
      id: "sys",
      role: "system",
      label: "System",
      time: fmt(input.snap.workflow.time?.updated),
      body: `${cap(input.snap.workflow.status)} · ${cap(input.snap.runtime.phase)}${input.node ? ` · ${input.node.title}` : ""}`,
    },
  ]
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
                          <span class="text-xs text-muted-foreground">{nodeKind(node)}</span>
                          <span class="text-xs text-muted-foreground">•</span>
                          <span class={`text-xs ${tone(node.status) === "running" ? "text-blue-500" : tone(node.status) === "completed" ? "text-emerald-500" : tone(node.status) === "failed" ? "text-red-500" : "text-muted-foreground"}`}>{node.status}</span>
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
                <span class="text-xs text-muted-foreground">{nodeKind(props.node!)}</span>
                <span class="text-xs text-muted-foreground">•</span>
                <span class={`text-xs ${tone(props.node!.status) === "running" ? "text-blue-400" : tone(props.node!.status) === "completed" ? "text-emerald-400" : tone(props.node!.status) === "failed" ? "text-red-400" : "text-muted-foreground"}`}>{props.node!.status}</span>
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
          data.events.length > 0
        if (data.workflow) setStore("snapshot", "workflow", data.workflow)
        if (data.runtime) setStore("snapshot", "runtime", data.runtime)
        if (data.nodes.length > 0) setStore("snapshot", "nodes", (list) => mergeNodes(list ?? [], data.nodes))
        if (data.edges.length > 0) setStore("snapshot", "edges", data.edges)
        if (data.checkpoints.length > 0) setStore("snapshot", "checkpoints", data.checkpoints)
        if (data.events.length > 0) {
          setStore("snapshot", "events", (list) => [...(list ?? []), ...data.events].slice(-160))
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
  const node = createMemo(() => props.snapshot.nodes.find((item) => item.session_id === props.currentSessionID))
  return (
    <div class="px-4 pt-3">
      <div class="rounded-[22px] border border-white/70 bg-white/78 px-4 py-4 shadow-[0_16px_40px_rgba(15,23,42,0.05)]">
        <div class="flex flex-wrap items-center gap-2">
          <Pill status={node()?.status ?? props.snapshot.workflow.status} />
          <div class="text-[16px] font-semibold tracking-[-0.02em] text-slate-950">
            {node()?.title ?? props.snapshot.workflow.title}
          </div>
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
}) {
  const sync = useSync()
  const dialog = useDialog()
  const providers = useProviders()
  const local = useLocal()
  const sdk = useSDK()
  const server = useServer()
  const platform = usePlatform()
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
    return Object.fromEntries(
      [undefined as WorkflowNode | undefined, ...nodes()].map((node) => {
        const id = node?.session_id ?? rootID()
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
            sandTable: row.sandTable,
            question: row.question,
            permission: row.permission,
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
  const rootAgent = createMemo(() => {
    const items = local.agent.list()
    return (
      items.find((item) => item.name === "orchestrator" && item.mode !== "subagent")?.name ??
      items.find((item) => item.mode !== "subagent")?.name ??
      items[0]?.name
    )
  })
  createEffect(() => {
    const next = rootAgent()
    if (!next) return
    if (local.agent.current()?.name === next) return
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
        if (msg.variant) local.model.variant.set(msg.variant)
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
  const sandPlan = createMemo(() => sandTableSummary(sync.data.message[rootID()] ?? [], sync.data.part))

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
    const execution = nodes().map((node) => ({
      id: node.id,
      title: node.title,
      type: nodeKind(node) === "build" ? "build-flash" : (nodeKind(node) as "coding" | "debug" | "deploy"),
      status: tone(node.status),
      session: node.session_id ?? props.snapshot.workflow.session_id,
    }))
    const plan = sandPlan()
    if (!plan && execution.length === 0) return undefined
    // Plan and execution belong to a single task — render them as ONE chain so
    // the canvas shows a linear "plan → first node → …" flow instead of
    // awkwardly splitting into two lanes. The plan node sits at position 0
    // when present; it's visually distinct (color + icon already encode it).
    const merged: WorkflowAppProps["chains"][number]["nodes"] = []
    if (plan) {
      merged.push({
        id: `sand-table:${plan.id}`,
        title: plan.title,
        type: "plan",
        status: plan.status,
        session: rootID(),
        summary: sandPlanBadges(plan),
      })
    }
    for (const node of execution) merged.push(node)
    return [
      {
        id: "workflow",
        // Chain label only shows when there are multiple chains — with the
        // unified plan+execution layout the header is hidden. Still, prefer the
        // workflow's own title over a hardcoded "Workflow" placeholder so that
        // any future multi-chain view reflects the task subject.
        label: props.snapshot.workflow.title || "Workflow",
        color: "#7578c5",
        nodes: merged,
      },
    ]
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
        status: plan.status,
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
  const canvas = createMemo<WorkflowAppProps["nodes"]>(() =>
    nodes().map((node) => ({
      id: node.id,
      title: node.title,
      type: nodeKind(node) === "build" ? "build-flash" : (nodeKind(node) as "coding" | "debug" | "deploy"),
      status: tone(node.status),
      session: node.session_id ?? props.snapshot.workflow.session_id,
      summary: modelReady(node) ? [modelLabel(node)] : ["route model"],
    })),
  )

  const unroutedNodes = createMemo(() => nodes().filter((node) => !modelReady(node)))

  // Target nodeIDs that should receive the model the user picks from the native dialog.
  // Set when the user clicks a specific agent's model pill, consumed after local.model changes.
  let pendingRouteTargets: string[] | null = null

  const pickModel = (targetNodeIDs?: string[]) => {
    pendingRouteTargets = targetNodeIDs && targetNodeIDs.length > 0 ? [...targetNodeIDs] : null
    // Clear pending targets AFTER the reactive effect for `local.model` has a chance to
    // consume them. Without this, a later non-node-scoped model change (e.g. chat panel
    // picker) would accidentally re-route stale targets.
    // Deferred via double-microtask/setTimeout so it runs after SolidJS's effect queue.
    const onClose = () => {
      setTimeout(() => {
        pendingRouteTargets = null
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
        void forceRouteNodes(targets).catch(() => undefined)
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

  const send = (text: string, node?: string) => {
    const body = text.trim()
    const id = sessionID(node)
    const info = node ? props.snapshot.nodes.find((item) => item.id === node) : undefined
    const agent = info?.agent ?? rootAgent() ?? local.agent.current()?.name
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
          model: model ?? {
            providerID: "opencode",
            modelID: "workflow",
          },
          variant,
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
    const agent = rootAgent() ?? local.agent.current()?.name
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
        model: currentModel(),
        models: choices().map((item) => item.label),
        workspace: sdk.directory,
        tasks: props.tasks,
        activeTaskId: props.activeTaskId,
        pick: pick(),
        nodes: canvas(),
        chains: chainData(),
        details: detailsWithPlan(),
        flow: flow(),
        agents: agents(),
        tokenStats: tokenStats(),
        chats: chatsWithDialogs(),
        sandTables: sandTables(),
        onSession: openSession,
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
      }),
    )
  })

  onCleanup(() => root?.unmount())

  return <div ref={el} class="size-full" />
}
