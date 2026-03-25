import type { FileDiff } from "@opencode-ai/sdk/v2/client"
import "../../../vendor/elkjs/lib/elk.bundled.js"
import g6URL from "../../../vendor/g6/g6.min.js?url"
import { createMemo, createEffect, For, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useServer } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { useLocal } from "@/context/local"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogSelectModel } from "@/components/dialog-select-model"
import { DialogSelectProvider } from "@/components/dialog-select-provider"
import { useProviders } from "@/hooks/use-providers"

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

export type WorkflowSnapshot = {
  workflow: WorkflowInfo
  runtime: WorkflowRuntime
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  checkpoints: WorkflowCheckpoint[]
  events: WorkflowEvent[]
  cursor: number
}

export type WorkflowCheckpoint = {
  id: string
  workflow_id: string
  node_id: string
  label: string
  status: string
}

type WorkflowReadResult = {
  workflow?: WorkflowInfo
  runtime?: WorkflowRuntime
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  checkpoints: WorkflowSnapshot["checkpoints"]
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

type LayoutNode = {
  node: WorkflowNode
  level: number
  row: number
  x: number
  y: number
}

type LayoutLane = {
  level: number
  x: number
  y: number
  w: number
  h: number
}

type LayoutGraph = {
  nodes: LayoutNode[]
  lanes: LayoutLane[]
  width: number
  height: number
  cardW: number
  cardH: number
  rootW: number
  rootH: number
  orchestrator_x: number
  orchestrator_y: number
}

type ElkNode = {
  id: string
  width?: number
  height?: number
  x?: number
  y?: number
}

type ElkGraph = {
  id: string
  layoutOptions?: Record<string, string>
  children?: ElkNode[]
  edges?: Array<{
    id: string
    sources: string[]
    targets: string[]
  }>
}

type ElkEngine = {
  layout: (graph: ElkGraph) => Promise<{
    children?: ElkNode[]
  }>
}

type ElkCtor = new () => ElkEngine

type G6Item = {
  getID: () => string
}

type G6Event = {
  item?: G6Item
}

type G6GraphData = {
  nodes: Record<string, unknown>[]
  edges: Record<string, unknown>[]
}

type G6Graph = {
  data: (data: G6GraphData) => void
  render: () => void
  changeData: (data: G6GraphData) => void
  destroy: () => void
  changeSize?: (width: number, height: number) => void
  fitView?: (padding?: number | number[]) => void
  on: (name: string, cb: (event: G6Event) => void) => void
}

type G6Shape = {
  animate?: (cfg: Record<string, unknown>, opts: Record<string, unknown>) => void
}

type G6Group = {
  addShape: (kind: string, cfg: { attrs: Record<string, unknown>; name?: string }) => G6Shape
}

type G6NodeSpec = {
  draw: (cfg: Record<string, unknown>, group: G6Group) => unknown
}

type G6Ctor = {
  Graph: new (cfg: Record<string, unknown>) => G6Graph
  registerNode?: (name: string, spec: G6NodeSpec, extend?: string) => void
  __workflow?: boolean
}

declare global {
  var ELK: ElkCtor | undefined
  var G6: G6Ctor | undefined
}

const cardW = 272
const cardH = 202
const rootW = 228
const rootH = 124
const gapX = 96
const gapY = 42
const padX = 68
const padY = 64
const laneTop = 84
const lanePad = 34
const rootGap = 92

type State = "neutral" | "ready" | "running" | "completed" | "failed" | "paused"

const ui = {
  gap: {
    4: "4px",
    8: "8px",
    12: "12px",
    16: "16px",
    20: "20px",
    24: "24px",
    32: "32px",
  },
  rad: {
    sm: "rounded-[12px]",
    md: "rounded-[18px]",
    lg: "rounded-[24px]",
    xl: "rounded-[34px]",
    pill: "rounded-full",
  },
  text: {
    title: "text-[22px] font-semibold tracking-[-0.03em] text-slate-950",
    head: "text-[16px] font-semibold tracking-[-0.02em] text-slate-950",
    sub: "text-[12px] leading-6 text-slate-600",
    body: "text-[11px] text-slate-600",
    meta: "text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500",
    chip: "text-[10px] font-semibold uppercase tracking-[0.12em]",
  },
  surf: {
    page: "bg-[radial-gradient(circle_at_top,rgba(37,99,235,0.08),transparent_30%),linear-gradient(180deg,#f5f7fb_0%,#eaf0f8_100%)]",
    pane:
      "border border-slate-200/70 bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(244,247,251,0.92))] shadow-[0_20px_52px_rgba(15,23,42,0.06)] backdrop-blur",
    box: "border border-slate-200/70 bg-white/82 shadow-[inset_0_1px_0_rgba(255,255,255,0.92)]",
    canvas:
      "border border-slate-200/70 bg-[radial-gradient(circle_at_top,rgba(37,99,235,0.08),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.96),rgba(245,247,251,0.96))] shadow-[inset_0_1px_0_rgba(255,255,255,0.95)]",
    code: "border border-slate-200 bg-slate-900 text-slate-100",
  },
  shadow: {
    pick: "shadow-[0_18px_40px_rgba(37,99,235,0.12)]",
    lift: "shadow-[0_18px_48px_rgba(15,23,42,0.08)]",
    soft: "shadow-[0_14px_30px_rgba(15,23,42,0.06)]",
  },
  motion: {
    fast: 180,
    base: 220,
    slow: 280,
  },
  state: {
    neutral: {
      tone: "neutral",
      fill: "#ffffff",
      stroke: "#cbd5e1",
      band: "#94a3b8",
      glow: "rgba(15,23,42,0.08)",
      chip: "border-slate-200 bg-white text-slate-700",
      badge: "bg-slate-100 text-slate-700 border-slate-200",
      tint: "from-slate-50 via-white to-slate-50/30",
      orb: "bg-slate-300/28",
    },
    ready: {
      tone: "warning",
      fill: "#fffbeb",
      stroke: "#fcd34d",
      band: "#f59e0b",
      glow: "rgba(245,158,11,0.16)",
      chip: "border-amber-200 bg-amber-50 text-amber-700",
      badge: "bg-amber-50 text-amber-700 border-amber-200",
      tint: "from-amber-50 via-white to-amber-50/30",
      orb: "bg-amber-300/35",
    },
    running: {
      tone: "info",
      fill: "#f0f9ff",
      stroke: "#7dd3fc",
      band: "#0ea5e9",
      glow: "rgba(14,165,233,0.2)",
      chip: "border-sky-200 bg-sky-50 text-sky-700",
      badge: "bg-sky-50 text-sky-700 border-sky-200",
      tint: "from-sky-50 via-white to-cyan-50/30",
      orb: "bg-sky-300/35",
    },
    completed: {
      tone: "success",
      fill: "#f0fdf4",
      stroke: "#6ee7b7",
      band: "#10b981",
      glow: "rgba(16,185,129,0.18)",
      chip: "border-emerald-200 bg-emerald-50 text-emerald-700",
      badge: "bg-emerald-50 text-emerald-700 border-emerald-200",
      tint: "from-emerald-50 via-white to-emerald-50/30",
      orb: "bg-emerald-300/35",
    },
    failed: {
      tone: "error",
      fill: "#fff1f2",
      stroke: "#fda4af",
      band: "#f43f5e",
      glow: "rgba(244,63,94,0.18)",
      chip: "border-rose-200 bg-rose-50 text-rose-700",
      badge: "bg-rose-50 text-rose-700 border-rose-200",
      tint: "from-rose-50 via-white to-rose-50/30",
      orb: "bg-rose-300/35",
    },
    paused: {
      tone: "warning",
      fill: "#fffbeb",
      stroke: "#fcd34d",
      band: "#f59e0b",
      glow: "rgba(245,158,11,0.16)",
      chip: "border-amber-200 bg-amber-50 text-amber-700",
      badge: "bg-amber-50 text-amber-700 border-amber-200",
      tint: "from-amber-50 via-white to-amber-50/30",
      orb: "bg-amber-300/35",
    },
  },
} as const

const kind = (status: string): State => {
  if (status === "completed") return "completed"
  if (status === "passed") return "completed"
  if (status === "failed" || status === "cancelled") return "failed"
  if (status === "interrupted" || status === "paused") return "paused"
  if (status === "running" || status === "waiting") return "running"
  if (status === "ready") return "ready"
  return "neutral"
}

const skin = (status: string) => ui.state[kind(status)]
const reduce = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches

const statusTone = (status: string) => {
  return skin(status).tone
}

const checkpointTone = (status: string) => {
  if (status === "passed") return "success"
  if (status === "failed") return "error"
  if (status === "skipped") return "neutral"
  return "warning"
}

const modelLabel = (node: Pick<WorkflowNode, "model">) => {
  if (!node.model?.modelID) return "model pending"
  if (!node.model.providerID) return node.model.modelID
  return `${node.model.providerID}/${node.model.modelID}`
}

const nodeTone = (status: string) => {
  return skin(status).tone
}

const terminal = (status: string) => ["completed", "failed", "cancelled"].includes(status)

const statusDot = (status: string) => {
  if (kind(status) === "completed") return "bg-emerald-500"
  if (kind(status) === "failed") return "bg-red-500"
  if (kind(status) === "paused" || kind(status) === "ready") return "bg-amber-500"
  if (kind(status) === "running") return "bg-sky-500 animate-pulse motion-reduce:animate-none"
  return "bg-zinc-400"
}

const live = (status: string) => status === "running" || status === "waiting"

const laneFill = (level: number) => {
  if (level % 3 === 0) return "from-sky-100/70 via-white/52 to-cyan-100/50"
  if (level % 3 === 1) return "from-emerald-100/60 via-white/46 to-lime-100/44"
  return "from-violet-100/55 via-white/44 to-amber-100/42"
}

const modelShell = (status: string) => {
  const item = skin(status)
  return `${item.chip} bg-white/82`
}

const orb = (status: string) => {
  return skin(status).orb
}

const bandHex = (status: string) => {
  return skin(status).band
}

const fillHex = (status: string, selected: boolean) => {
  if (selected) return "#eff6ff"
  return skin(status).fill
}

const strokeHex = (status: string, selected: boolean, current: boolean) => {
  if (selected) return "#3b82f6"
  if (current) return "#94a3b8"
  return skin(status).stroke
}

const shadowHex = (status: string, selected: boolean, current: boolean) => {
  if (selected) return "rgba(37,99,235,0.22)"
  if (current) return "rgba(15,23,42,0.14)"
  return skin(status).glow
}

const nodeBorder = (status: string, selected: boolean) => {
  if (selected) return "border-sky-500/70"
  if (status === "running" || status === "waiting") return "border-sky-500/55"
  if (status === "completed") return "border-emerald-500/35"
  if (status === "failed" || status === "cancelled") return "border-red-500/35"
  return "border-slate-200"
}

const nodeBg = (status: string, selected: boolean) => {
  if (selected) return "bg-sky-50/90"
  if (status === "running" || status === "waiting") return "bg-sky-50/65"
  if (status === "completed") return "bg-emerald-50/65"
  if (status === "failed" || status === "cancelled") return "bg-red-50/65"
  return "bg-white"
}

const nodeIcon = (status: string) => {
  if (kind(status) === "completed") return "bg-emerald-500/10 text-emerald-700"
  if (kind(status) === "failed") return "bg-red-500/10 text-red-700"
  if (kind(status) === "running") return "bg-sky-500/10 text-sky-700"
  if (kind(status) === "ready" || kind(status) === "paused") return "bg-amber-500/10 text-amber-700"
  return "bg-slate-100 text-slate-600"
}

const card = (status: string) => {
  return skin(status).tint
}

const frame = (status: string, selected: boolean, current: boolean) => {
  if (selected) return "border-sky-500/70 shadow-[0_28px_80px_rgba(37,99,235,0.18)]"
  if (status === "completed") return "border-emerald-300/80 shadow-[0_22px_50px_rgba(16,185,129,0.12)]"
  if (status === "failed" || status === "cancelled") return "border-rose-300/80 shadow-[0_22px_50px_rgba(244,63,94,0.12)]"
  if (status === "interrupted" || status === "paused" || status === "ready")
    return "border-amber-300/80 shadow-[0_22px_50px_rgba(245,158,11,0.1)]"
  if (status === "running" || status === "waiting") return "border-sky-300/80 shadow-[0_24px_60px_rgba(14,165,233,0.14)]"
  if (current) return "border-slate-300/90 shadow-[0_22px_50px_rgba(15,23,42,0.1)]"
  return "border-slate-200/90 shadow-[0_16px_36px_rgba(15,23,42,0.08)]"
}

const band = (status: string) => {
  if (status === "completed") return "from-emerald-500 to-lime-400"
  if (status === "failed" || status === "cancelled") return "from-rose-500 to-orange-400"
  if (status === "interrupted" || status === "paused" || status === "ready") return "from-amber-500 to-yellow-400"
  if (status === "running" || status === "waiting") return "from-sky-500 to-cyan-400"
  return "from-slate-400 to-slate-300"
}

const eventSummary = (event: WorkflowEvent) => {
  if (event.payload.fail_reason) return String(event.payload.fail_reason)
  if (event.payload.command) return `command: ${String(event.payload.command)}`
  if (event.payload.tool) return `tool: ${String(event.payload.tool)}`
  if (event.payload.status) return `status: ${String(event.payload.status)}`
  if (event.payload.result_status) return `result: ${String(event.payload.result_status)}`
  return "state change persisted on runtime bus"
}

const pretty = (value: unknown) => JSON.stringify(value, null, 2)

const short = (value: unknown) => {
  if (!value) return ""
  const json = pretty(value)
  return json.length > 320 ? `${json.slice(0, 317)}...` : json
}

const clock = (value?: number) => {
  if (!value) return "n/a"
  return new Date(value).toLocaleTimeString(undefined, { timeStyle: "short" })
}

const ago = (value?: number) => {
  if (!value) return "no activity"
  const diff = Math.max(0, Date.now() - value)
  const min = Math.floor(diff / 60000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

const pct = (value: number, total: number) => {
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)))
}

const eventTone = (event: WorkflowEvent) => {
  if (event.kind.includes("failed") || event.payload.fail_reason) return "error"
  if (event.kind.includes("stalled") || event.kind.includes("blocked") || event.kind.includes("pending")) return "warning"
  if (event.kind.includes("completed") || event.kind.includes("passed")) return "success"
  if (event.kind.includes("started") || event.kind.includes("control") || event.kind.includes("woken")) return "info"
  return "neutral"
}

function Badge(props: { tone: string; children: string | number }) {
  return (
    <span
      class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
      classList={{
        "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300": props.tone === "success",
        "bg-red-500/12 text-red-700 dark:text-red-300": props.tone === "error",
        "bg-amber-500/12 text-amber-700 dark:text-amber-300": props.tone === "warning",
        "bg-sky-500/12 text-sky-700 dark:text-sky-300": props.tone === "info",
        "bg-zinc-500/12 text-zinc-700 dark:text-zinc-300": props.tone === "neutral",
      }}
    >
      {props.children}
    </span>
  )
}

function StatusBadge(props: { status: string; text?: string }) {
  const item = skin(props.status)
  return (
    <span class={`inline-flex items-center rounded-full border px-2.5 py-1 ${ui.text.chip} ${item.badge}`}>
      {props.text ?? props.status}
    </span>
  )
}

function FilterChips(props: { items: { label: string; tone?: string; active?: boolean; mute?: boolean }[] }) {
  return (
    <div class="flex flex-wrap items-center gap-2 text-[11px]">
      <For each={props.items}>
        {(item) => (
          <span
            class={`inline-flex items-center gap-2 ${ui.rad.pill} border px-2.5 py-1 ${ui.text.chip} transition-colors duration-[220ms] motion-reduce:transition-none`}
            classList={{
              "border-slate-200/80 bg-white/86 text-slate-600": !item.tone,
              "border-sky-200 bg-sky-50 text-sky-700": item.tone === "running",
              "border-emerald-200 bg-emerald-50 text-emerald-700": item.tone === "completed",
              "border-amber-200 bg-amber-50 text-amber-700": item.tone === "ready" || item.tone === "paused",
              "border-rose-200 bg-rose-50 text-rose-700": item.tone === "failed",
              "opacity-55": item.mute,
              "shadow-[0_10px_22px_rgba(15,23,42,0.04)]": item.active,
            }}
          >
            {item.label}
          </span>
        )}
      </For>
    </div>
  )
}

const sortNodes = (nodes: WorkflowNode[]) => [...nodes].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))

const workflowIDFromEvent = (event: WorkflowBusEvent) => {
  if (event.type === "workflow.created" || event.type === "workflow.updated") return event.properties.info.id
  if (event.type === "workflow.node.created" || event.type === "workflow.node.updated") return event.properties.info.workflow_id
  if (event.type === "workflow.edge.created") return event.properties.info.workflow_id
  if (event.type === "workflow.checkpoint.updated") return event.properties.info.workflow_id
  if (event.type === "workflow.event.created") return event.properties.info.workflow_id
}

const mergeNodes = (current: WorkflowNode[], next: WorkflowNode[]) => {
  const map = new Map(current.map((item) => [item.id, item]))
  for (const item of next) map.set(item.id, item)
  return sortNodes([...map.values()])
}

function WorkflowStats(props: {
  progress: number
  settled: number
  total: number
  wait: number
  ready: number
  failed: number
  gates: number
  last?: WorkflowEvent
}) {
  return (
    <div class="grid gap-3">
      <div class={`rounded-[24px] px-4 py-4 ${ui.surf.box}`}>
        <div class="flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          <span>completion</span>
          <span>{`${props.progress}%`}</span>
        </div>
        <div class="mt-3 h-2 overflow-hidden rounded-full bg-slate-200/80">
          <div
            class="h-full rounded-full bg-[linear-gradient(90deg,#0f172a_0%,#2563eb_55%,#38bdf8_100%)] transition-[width] duration-[220ms] motion-reduce:transition-none"
            style={{ width: `${props.progress}%` }}
          />
        </div>
        <div class="mt-3 flex items-center justify-between text-[11px] text-slate-500">
          <span>{`${props.settled} of ${props.total} settled`}</span>
          <span>{props.last ? `last ${clock(props.last.time_created)}` : "awaiting events"}</span>
        </div>
      </div>
      <div class="grid min-w-[280px] grid-cols-2 gap-2.5 text-[11px] text-slate-500 sm:grid-cols-3 xl:grid-cols-5">
        <div class={`rounded-[22px] px-3 py-3 ${ui.surf.box}`}>
          <div class={ui.text.chip}>settled</div>
          <div class="mt-1 text-[15px] font-semibold text-slate-950">{`${props.settled}/${props.total}`}</div>
        </div>
        <div class={`rounded-[22px] px-3 py-3 ${ui.surf.box}`}>
          <div class={ui.text.chip}>active</div>
          <div class="mt-1 text-[15px] font-semibold text-slate-950">{props.wait}</div>
        </div>
        <div class={`rounded-[22px] px-3 py-3 ${ui.surf.box}`}>
          <div class={ui.text.chip}>ready</div>
          <div class="mt-1 text-[15px] font-semibold text-slate-950">{props.ready}</div>
        </div>
        <div class={`rounded-[22px] px-3 py-3 ${ui.surf.box}`}>
          <div class={ui.text.chip}>failed</div>
          <div class="mt-1 text-[15px] font-semibold text-slate-950">{props.failed}</div>
        </div>
        <div class={`rounded-[22px] px-3 py-3 ${ui.surf.box}`}>
          <div class={ui.text.chip}>gates</div>
          <div class="mt-1 text-[15px] font-semibold text-slate-950">{props.gates}</div>
        </div>
      </div>
    </div>
  )
}

function WorkflowHeader(props: {
  snapshot: WorkflowSnapshot
  node?: WorkflowNode
  progress: number
  settled: number
  total: number
  wait: number
  ready: number
  failed: number
  last?: WorkflowEvent
}) {
  return (
    <div class={`${ui.rad.xl} px-5 py-5 ${ui.surf.pane}`}>
      <div class="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <span class={`px-2.5 py-1 ${ui.rad.pill} ${ui.text.meta} border border-white/70 bg-white/82 shadow-[0_8px_18px_rgba(15,23,42,0.04)]`}>
              workflow monitor
            </span>
            <span class={ui.text.title}>{props.snapshot.workflow.title}</span>
            <StatusBadge status={props.snapshot.workflow.status} />
            <Show when={props.node}>
              <StatusBadge status={props.node!.status} text={props.node!.title} />
            </Show>
          </div>
          <div class="mt-3 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div class="max-w-3xl text-[13px] leading-7 text-slate-600 lg:max-w-none lg:pr-4 xl:col-span-2">
              {props.snapshot.workflow.summary?.objective ??
                "Track orchestration, gates, and handoffs from one execution map."}
            </div>
          </div>
        </div>
        <WorkflowStats
          progress={props.progress}
          settled={props.settled}
          total={props.total}
          wait={props.wait}
          ready={props.ready}
          failed={props.failed}
          gates={props.snapshot.checkpoints.length}
          last={props.last}
        />
      </div>
    </div>
  )
}

function WorkflowEdgeLabel(props: { label?: string }) {
  if (!props.label) return {}
  return {
    label: props.label,
    labelCfg: {
      autoRotate: false,
      refY: -18,
      style: {
        fill: "#475569",
        fontSize: 10,
        fontWeight: 600,
        background: {
          fill: "rgba(255,255,255,0.96)",
          stroke: "rgba(148,163,184,0.32)",
          radius: 999,
          padding: [4, 8],
        },
      },
    },
  }
}

function WorkflowNodeCard(props: {
  node?: WorkflowNode
  root?: boolean
  x: number
  y: number
  w: number
  h: number
  pick: boolean
  live: boolean
  phase: string
  settled: number
  total: number
  flow: WorkflowInfo
}) {
  if (props.root) {
    return {
      id: "__workflow_root__",
      type: "workflow-card",
      x: props.x,
      y: props.y,
      width: props.w,
      height: props.h,
      fill: "#e0f2fe",
      stroke: live(props.flow.status) ? "#38bdf8" : "#93c5fd",
      shadow: "rgba(14,165,233,0.22)",
      band: "#2563eb",
      title: "Orchestrator",
      meta: "ROOT",
      sub: "workflow runtime",
      stats: `${props.settled}/${props.total} settled`,
      foot: props.phase,
      badge: `v${props.flow.version}`,
      ring: true,
      spin: live(props.flow.status),
      anchorPoints: [
        [0, 0.5],
        [1, 0.5],
        [0.5, 0],
        [0.5, 1],
      ],
    }
  }

  const node = props.node!
  return {
    id: node.id,
    type: "workflow-card",
    x: props.x,
    y: props.y,
    width: props.w,
    height: props.h,
    fill: fillHex(node.status, props.pick),
    stroke: strokeHex(node.status, props.pick, props.live),
    shadow: shadowHex(node.status, props.pick, props.live),
    band: bandHex(node.status),
    title: node.title,
    meta: `STEP ${String(node.position + 1).padStart(2, "0")}`,
    sub: node.agent,
    stats: `${node.action_count}/${node.max_actions} actions`,
    foot: `${node.status} · ${node.attempt}/${node.max_attempts} attempts`,
    badge: node.result_status === "pending" ? node.status.toUpperCase() : node.result_status.toUpperCase(),
    ring: props.pick,
    spin: live(node.status),
    anchorPoints: [
      [0, 0.5],
      [1, 0.5],
      [0.5, 0],
      [0.5, 1],
    ],
  }
}

function EventFlowList(props: { events: WorkflowEvent[]; nodes: Map<string, string> }) {
  return (
    <div class="mt-4 grid max-h-full gap-2 overflow-auto">
      <For each={props.events}>
        {(event) => (
          <div
            class={`rounded-[22px] border px-3 py-3 transition-colors duration-[220ms] motion-reduce:transition-none`}
            classList={{
              "border-emerald-200 bg-emerald-50/85": eventTone(event) === "success",
              "border-red-200 bg-red-50/85": eventTone(event) === "error",
              "border-amber-200 bg-amber-50/85": eventTone(event) === "warning",
              "border-sky-200 bg-sky-50/85": eventTone(event) === "info",
              "border-white/70 bg-white/76": eventTone(event) === "neutral",
            }}
          >
            <div class="flex items-center justify-between gap-3">
              <div class="flex min-w-0 items-center gap-2">
                <span
                  class="size-2.5 rounded-full"
                  classList={{
                    "bg-emerald-400": eventTone(event) === "success",
                    "bg-red-400": eventTone(event) === "error",
                    "bg-amber-400": eventTone(event) === "warning",
                    "bg-sky-400": eventTone(event) === "info",
                    "bg-slate-300": eventTone(event) === "neutral",
                  }}
                />
                <div class="truncate text-[11px] font-medium text-slate-950">{event.kind}</div>
              </div>
              <div class="text-[10px] text-slate-500">{clock(event.time_created)}</div>
            </div>
            <div class="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
              <span class={`px-2 py-0.5 ${ui.rad.pill} ${ui.surf.box}`}>{event.source}</span>
              <Show when={event.node_id}>
                <span class={`px-2 py-0.5 ${ui.rad.pill} ${ui.surf.box}`}>
                  {props.nodes.get(event.node_id!) ?? event.node_id}
                </span>
              </Show>
              <Show when={event.target_node_id}>
                <span class={`px-2 py-0.5 ${ui.rad.pill} ${ui.surf.box}`}>
                  {`target ${props.nodes.get(event.target_node_id!) ?? event.target_node_id}`}
                </span>
              </Show>
            </div>
            <div class="mt-2 text-[11px] leading-6 text-slate-600">{eventSummary(event)}</div>
          </div>
        )}
      </For>
    </div>
  )
}

const topology = (snapshot: WorkflowSnapshot) =>
  JSON.stringify({
    nodes: sortNodes(snapshot.nodes).map((node) => [node.id, node.position]),
    edges: [...snapshot.edges]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((edge) => [edge.id, edge.from_node_id, edge.to_node_id]),
  })

const rank = (snapshot: WorkflowSnapshot) => {
  const nodes = sortNodes(snapshot.nodes)
  const parents = new Map<string, string[]>()
  for (const edge of snapshot.edges) {
    const list = parents.get(edge.to_node_id)
    if (list) list.push(edge.from_node_id)
    else parents.set(edge.to_node_id, [edge.from_node_id])
  }

  const level = new Map<string, number>()
  const calc = (id: string): number => {
    const cached = level.get(id)
    if (cached !== undefined) return cached
    const deps = parents.get(id) ?? []
    if (deps.length === 0) {
      level.set(id, 0)
      return 0
    }
    const next = Math.max(...deps.map(calc)) + 1
    level.set(id, next)
    return next
  }

  const groups = new Map<number, WorkflowNode[]>()
  for (const node of nodes) {
    const value = calc(node.id)
    const list = groups.get(value)
    if (list) list.push(node)
    else groups.set(value, [node])
  }

  return {
    nodes,
    level,
    groups,
  }
}

function fallbackLayout(snapshot: WorkflowSnapshot) {
  const orchestrator_x = padX
  const ranked = rank(snapshot)
  const levels = [...ranked.groups.keys()].sort((a, b) => a - b)
  const rows = Math.max(1, ...levels.map((value) => ranked.groups.get(value)?.length ?? 0))
  const laneH = Math.max(rootH + 80, rows * cardH + Math.max(0, rows - 1) * gapY + lanePad * 2)
  const orchestrator_y = laneTop + Math.round((laneH - rootH) / 2)
  const laneX = orchestrator_x + rootW + rootGap

  const placed = new Map<string, LayoutNode>()
  for (const [value, group] of ranked.groups) {
    for (const [row, node] of sortNodes(group).entries()) {
      placed.set(node.id, {
        node,
        level: value,
        row,
        x: 0,
        y: 0,
      })
    }
  }

  const lanes = levels.map((value, idx) => ({
    level: value,
    x: laneX + idx * (cardW + gapX) - 24,
    y: laneTop,
    w: cardW + 48,
    h: laneH,
  }))

  for (const item of placed.values()) {
    const lane = lanes.find((entry) => entry.level === item.level)
    const count = ranked.groups.get(item.level)?.length ?? 1
    const stack = count * cardH + Math.max(0, count - 1) * gapY
    item.x = (lane?.x ?? laneX) + 24
    item.y = laneTop + Math.round((laneH - stack) / 2) + item.row * (cardH + gapY)
  }

  const items = [...placed.values()]
  const last = lanes.at(-1)
  const width = (last ? last.x + last.w : orchestrator_x + rootW) + padX + 84
  const height = laneTop + laneH + padY
  return {
    nodes: items,
    lanes,
    width,
    height,
    cardW,
    cardH,
    rootW,
    rootH,
    orchestrator_x,
    orchestrator_y,
  }
}

const layout = (snapshot: WorkflowSnapshot) => {
  const base = fallbackLayout(snapshot)
  const ranked = rank(snapshot)
  const levels = [...ranked.groups.keys()].sort((a, b) => a - b)
  if (ranked.nodes.length === 0 || levels.length === 0) return Promise.resolve(base)
  const Elk = globalThis.ELK
  if (!Elk) return Promise.resolve(base)

  return new Elk()
    .layout({
      id: snapshot.workflow.id,
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.edgeRouting": "SPLINES",
        "elk.spacing.nodeNode": String(gapY),
        "elk.layered.spacing.nodeNodeBetweenLayers": String(gapX),
        "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      },
      children: ranked.nodes.map((node) => ({
        id: node.id,
        width: cardW,
        height: cardH,
      })),
      edges: snapshot.edges.map((edge) => ({
        id: edge.id,
        sources: [edge.from_node_id],
        targets: [edge.to_node_id],
      })),
    })
    .then((data) => {
      const list = data.children ?? []
      if (list.length === 0) return base

      const x0 = Math.min(...list.map((item) => item.x ?? 0))
      const y0 = Math.min(...list.map((item) => item.y ?? 0))
      const x1 = Math.max(...list.map((item) => (item.x ?? 0) + (item.width ?? cardW)))
      const y1 = Math.max(...list.map((item) => (item.y ?? 0) + (item.height ?? cardH)))
      const shiftX = padX + rootW + rootGap - x0
      const shiftY = laneTop + lanePad - y0
      const laneH = Math.max(rootH + 80, y1 - y0 + lanePad * 2)
      const orchestrator_y = laneTop + Math.round((laneH - rootH) / 2)
      const rows = new Map<number, { id: string; y: number }[]>()

      const nodes = ranked.nodes.flatMap((node) => {
        const item = list.find((entry) => entry.id === node.id)
        if (!item) return []
        const level = ranked.level.get(node.id) ?? 0
        const row = rows.get(level)
        if (row) row.push({ id: node.id, y: item.y ?? 0 })
        else rows.set(level, [{ id: node.id, y: item.y ?? 0 }])
        return [
          {
            node,
            level,
            row: 0,
            x: (item.x ?? 0) + shiftX,
            y: (item.y ?? 0) + shiftY,
          },
        ]
      })

      for (const item of nodes) {
        item.row =
          rows
            .get(item.level)
            ?.sort((a, b) => a.y - b.y)
            .findIndex((entry) => entry.id === item.node.id) ?? 0
      }

      const lanes = levels.flatMap((level) => {
        const nodesInLane = nodes.filter((item) => item.level === level)
        if (nodesInLane.length === 0) return []
        const left = Math.min(...nodesInLane.map((item) => item.x))
        const right = Math.max(...nodesInLane.map((item) => item.x + cardW))
        return [
          {
            level,
            x: left - 24,
            y: laneTop,
            w: right - left + 48,
            h: laneH,
          },
        ]
      })

      return {
        nodes,
        lanes,
        width: Math.max(base.width, x1 + shiftX + padX + 84),
        height: Math.max(base.height, laneTop + laneH + padY),
        cardW,
        cardH,
        rootW,
        rootH,
        orchestrator_x: padX,
        orchestrator_y,
      }
    })
    .catch(() => base)
}

let g6Load: Promise<G6Ctor | undefined> | undefined

const loadG6 = () => {
  if (globalThis.G6) return Promise.resolve(globalThis.G6)
  if (typeof document === "undefined") return Promise.resolve(undefined)
  if (g6Load) return g6Load

  g6Load = new Promise((resolve, reject) => {
    const tag = document.createElement("script")
    tag.src = g6URL
    tag.async = true
    tag.onload = () => resolve(globalThis.G6)
    tag.onerror = () => reject(new Error("G6 load failed"))
    document.head.append(tag)
  })

  return g6Load
}

const bootG6 = () => {
  const g6 = globalThis.G6
  if (!g6 || !g6.registerNode || g6.__workflow) return g6

  g6.registerNode(
    "workflow-card",
    {
      draw: (cfg, group) => {
        const w = Number(cfg.width ?? cardW)
        const h = Number(cfg.height ?? cardH)
        const fill = String(cfg.fill ?? "#ffffff")
        const stroke = String(cfg.stroke ?? "#cbd5e1")
        const shadow = String(cfg.shadow ?? "rgba(15,23,42,0.08)")
        const band = String(cfg.band ?? "#94a3b8")
        const title = String(cfg.title ?? "")
        const meta = String(cfg.meta ?? "")
        const stats = String(cfg.stats ?? "")
        const foot = String(cfg.foot ?? "")
        const sub = String(cfg.sub ?? "")
        const ring = Boolean(cfg.ring)
        const spin = Boolean(cfg.spin)
        const statY = sub ? -h / 2 + 126 : -h / 2 + 94
        const badge = String(cfg.badge ?? "")

        const box = group.addShape("rect", {
          name: "box",
          attrs: {
            x: -w / 2,
            y: -h / 2,
            width: w,
            height: h,
            radius: 24,
            fill,
            stroke,
            lineWidth: ring ? 2.2 : 1.2,
            shadowBlur: ring ? 28 : 18,
            shadowColor: shadow,
            shadowOffsetY: 10,
          },
        })

        group.addShape("rect", {
          name: "band",
          attrs: {
            x: -w / 2,
            y: -h / 2,
            width: w,
            height: 8,
            radius: [24, 24, 0, 0],
            fill: band,
          },
        })

        group.addShape("circle", {
          name: "orb",
          attrs: {
            x: w / 2 - 34,
            y: -h / 2 + 26,
            r: 22,
            fill: band,
            opacity: 0.14,
          },
        })

        group.addShape("text", {
          name: "meta",
          attrs: {
            x: -w / 2 + 22,
            y: -h / 2 + 28,
            text: meta,
            fill: "#64748b",
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: 1.1,
          },
        })

        group.addShape("text", {
          name: "title",
          attrs: {
            x: -w / 2 + 22,
            y: -h / 2 + 62,
            text: title,
            fill: "#0f172a",
            fontSize: 15,
            fontWeight: 700,
          },
        })

        if (sub) {
          group.addShape("text", {
            name: "label",
            attrs: {
              x: -w / 2 + 22,
              y: -h / 2 + 88,
              text: sub,
              fill: "#475569",
              fontSize: 10,
              fontWeight: 500,
            },
          })
        }

        group.addShape("text", {
          name: "stats",
          attrs: {
            x: -w / 2 + 22,
            y: statY,
            text: stats,
            fill: "#0f172a",
            fontSize: 11,
            fontWeight: 600,
          },
        })

        if (foot) {
          group.addShape("text", {
            name: "foot",
            attrs: {
              x: -w / 2 + 22,
              y: h / 2 - 22,
              text: foot,
              fill: "#64748b",
              fontSize: 9,
            },
          })
        }

        group.addShape("text", {
          name: "status",
          attrs: {
            x: w / 2 - 24,
            y: -h / 2 + 31,
            text: badge,
            textAlign: "right",
            fill: ring ? "#0f172a" : "#475569",
            fontSize: 9,
            fontWeight: 700,
          },
        })

        if (spin && !reduce()) {
          const icon = group.addShape("circle", {
            name: "spin",
            attrs: {
              x: w / 2 - 28,
              y: h / 2 - 26,
              r: 7,
              stroke: band,
              lineWidth: 2.2,
              lineDash: [10, 6],
            },
          })
          icon.animate?.(
            { rotate: Math.PI * 2 },
            {
              repeat: true,
              duration: 1200,
            },
          )
        }

        return box
      },
    },
    "rect",
  )

  g6.__workflow = true
  return g6
}

export function createWorkflowRuntime() {
  const sdk = useSDK()
  const sync = useSync()
  const params = useParams()
  const server = useServer()
  const platform = usePlatform()
  const [store, setStore] = createStore({
    loading: false,
    snapshot: undefined as WorkflowSnapshot | undefined,
    cursor: 0,
    rootDiffs: [] as FileDiff[],
    rootDiffsReady: false,
  })

  const workflow = createMemo(() => store.snapshot)
  const currentSessionID = createMemo(() => params.id)
  const rootSession = createMemo(() => workflow()?.workflow.session_id)
  const rootSelected = createMemo(() => !!workflow() && currentSessionID() === rootSession())

  const request = async <T,>(path: string) => {
    const current = server.current
    if (!current) throw new Error("Server unavailable")
    const headers: Record<string, string> = {}
    if (current.http.password) {
      headers.Authorization = `Basic ${btoa(`${current.http.username ?? "opencode"}:${current.http.password}`)}`
    }
    const fetcher = platform.fetch ?? fetch
    const res = await fetcher(new URL(path, current.http.url), { headers })
    if (!res.ok) throw new Error(`Workflow request failed: ${res.status}`)
    return (await res.json()) as T
  }

  const refresh = async () => {
    const sessionID = currentSessionID()
    if (!sessionID) {
      setStore({ loading: false, snapshot: undefined, cursor: 0, rootDiffs: [], rootDiffsReady: false })
      return
    }

    setStore("loading", true)
    await request<WorkflowSnapshot>(`/workflow/session/${sessionID}`)
      .then(async (snapshot) => {
        if (!snapshot) {
          setStore({ loading: false, snapshot: undefined, cursor: 0, rootDiffs: [], rootDiffsReady: false })
          return
        }

        setStore("snapshot", snapshot)
        setStore("cursor", snapshot.cursor)
        for (const id of [snapshot.workflow.session_id, ...snapshot.nodes.map((node) => node.session_id).filter(Boolean)]) {
          if (!id) continue
          void sync.session.sync(id)
        }

        if (sessionID !== snapshot.workflow.session_id) {
          setStore("rootDiffs", [])
          setStore("rootDiffsReady", false)
          return
        }

        await request<FileDiff[]>(`/workflow/${snapshot.workflow.id}/diff`)
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
        setStore({ loading: false, snapshot: undefined, cursor: 0, rootDiffs: [], rootDiffsReady: false })
      })
      .finally(() => {
        setStore("loading", false)
      })
  }

  const read = async () => {
    const snapshot = workflow()
    if (!snapshot) return
    await request<WorkflowReadResult>(`/workflow/${snapshot.workflow.id}/read?cursor=${store.cursor}`)
      .then((data) => {
        if (!data) return
        const changed =
          !!data.workflow ||
          data.nodes.length > 0 ||
          data.edges.length > 0 ||
          data.checkpoints.length > 0 ||
          data.events.length > 0
        if (data.workflow) {
          setStore("snapshot", "workflow", data.workflow)
        }
        if (data.runtime) {
          setStore("snapshot", "runtime", data.runtime)
        }
        if (data.nodes.length > 0) {
          setStore("snapshot", "nodes", (current) => mergeNodes(current ?? [], data.nodes))
        }
        if (data.edges.length > 0) {
          setStore("snapshot", "edges", data.edges)
        }
        if (data.checkpoints.length > 0) {
          setStore("snapshot", "checkpoints", data.checkpoints)
        }
        if (data.events.length > 0) {
          setStore("snapshot", "events", (current) => [...(current ?? []), ...data.events].slice(-100))
        }
        setStore("cursor", data.cursor)
        return changed
      })
      .then(async (changed) => {
        if (!changed) return
        if (!rootSelected()) return
        await request<FileDiff[]>(`/workflow/${snapshot.workflow.id}/diff`)
          .then((diff) => {
            setStore("rootDiffs", diff ?? [])
            setStore("rootDiffsReady", true)
          })
          .catch(() => {})
      })
      .catch(() => {})
  }

  createEffect(
    on(
      currentSessionID,
      () => {
        void refresh()
      },
    ),
  )

  createEffect(() => {
    const snapshot = workflow()
    if (!snapshot) return
    const fast = terminal(snapshot.workflow.status) ? 30000 : 15000
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return
      void read()
    }, fast)
    onCleanup(() => clearInterval(timer))
  })

  const stop = sdk.event.listen((e) => {
    const snapshot = workflow()
    const event = e.details as WorkflowBusEvent
    if (!event.type.startsWith("workflow.")) return
    if (!snapshot) {
      void refresh()
      return
    }
    if (workflowIDFromEvent(event) !== snapshot.workflow.id) return
    void read()
  })

  onCleanup(stop)

  return {
    loading: () => store.loading,
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
  const done = createMemo(() => terminal(props.snapshot.workflow.status))
  const cards = createMemo(() => [
    {
      key: `${props.snapshot.workflow.session_id}:graph`,
      title: props.snapshot.workflow.title,
      subtitle: done() ? "plan" : "workflow",
      status: props.snapshot.workflow.status,
      type: "graph" as const,
      note: done() ? "plan" : "run",
    },
    {
      key: props.snapshot.workflow.session_id,
      sessionID: props.snapshot.workflow.session_id,
      title: "Orchestrator",
      subtitle: "root session",
      status: props.snapshot.workflow.status,
      type: "root" as const,
      note: "root",
    },
    ...(done()
      ? []
      : sortNodes(props.snapshot.nodes))
      .filter(
        (node) =>
          !!node.session_id ||
          props.snapshot.events.some((event) => event.node_id === node.id || event.target_node_id === node.id) ||
          !["pending", "ready"].includes(node.status),
      )
      .map((node, index) => ({
        key: node.session_id ?? node.id,
        sessionID: node.session_id,
        title: node.title,
        subtitle: node.agent,
        status: node.status,
        type: "node" as const,
        note: `n${index + 1}`,
      })),
  ])

  return (
    <div class="overflow-x-auto px-3 pt-3">
      <div class={`flex min-w-max items-stretch gap-2 p-2.5 ${ui.rad.xl} ${ui.surf.pane}`}>
        <For each={cards()}>
          {(card) => {
            const session = createMemo(() => (card.sessionID ? sync.session.get(card.sessionID) : undefined))
            const active = () =>
              card.type === "graph"
                ? props.currentSessionID === props.snapshot.workflow.session_id && props.rootView === "graph"
                : !!card.sessionID &&
                  props.currentSessionID === card.sessionID &&
                  (card.type !== "root" || props.rootView === "session")
            return (
              <button
                disabled={!card.sessionID && card.type !== "graph"}
                class={`inline-flex min-w-0 items-center gap-3 px-3.5 py-3 text-left transition-all duration-[220ms] motion-reduce:transition-none ${ui.rad.lg}`}
                classList={{
                  "border border-sky-300/80 bg-[linear-gradient(180deg,rgba(219,234,254,0.92),rgba(255,255,255,0.98))] shadow-[0_14px_34px_rgba(37,99,235,0.12)] -translate-y-0.5":
                    active(),
                  "border border-white/70 bg-white/72 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] hover:border-slate-200 hover:shadow-[0_12px_28px_rgba(15,23,42,0.06)]":
                    !active() && (!!card.sessionID || card.type === "graph"),
                  "border border-white/60 bg-slate-100/76 opacity-75": !active() && !card.sessionID,
                }}
                onClick={() => {
                  if (card.type === "graph") {
                    props.onSelectRootView("graph")
                    return
                  }
                  if (!card.sessionID) return
                  if (card.type === "root") props.onSelectRootView("session")
                  props.onSelectSession(card.sessionID)
                }}
              >
                <span
                  class={`size-2.5 shrink-0 rounded-full ${card.type === "graph" || card.type === "root" ? "bg-sky-500" : statusDot(card.status)}`}
                />
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <span class={`px-1.5 py-0.5 ${ui.rad.pill} border border-slate-200 bg-white/80 text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-500`}>
                      {card.note}
                    </span>
                    <span class="max-w-44 truncate text-[12px] font-semibold tracking-[-0.01em] text-slate-900">
                      {session()?.title ?? card.title}
                    </span>
                  </div>
                  <div class="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
                    <span class="truncate">{card.subtitle}</span>
                    <Show when={!card.sessionID}>
                      <span class="rounded-full bg-amber-500/12 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                        no session
                      </span>
                    </Show>
                  </div>
                </div>
              </button>
            )
          }}
        </For>
      </div>
    </div>
  )
}

export function WorkflowContextBar(props: {
  snapshot: WorkflowSnapshot
  currentSessionID?: string
}) {
  const dialog = useDialog()
  const local = useLocal()
  const providers = useProviders()
  const node = createMemo(() => props.snapshot.nodes.find((item) => item.session_id === props.currentSessionID))
  const model = createMemo(() => {
    const current = local.model.current()
    if (!current) return node() ? modelLabel(node()!) : "model pending"
    return `${current.provider.id}/${current.id}`
  })
  const status = createMemo(() => node()?.status ?? props.snapshot.workflow.status)
  const result = createMemo(() => node()?.result_status ?? "workflow aggregate")

  return (
    <div class="px-4 pt-3">
      <div class={`${ui.rad.xl} px-4 py-4 ${ui.surf.pane}`}>
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <span class={`px-2.5 py-1 ${ui.rad.pill} ${ui.text.meta} border border-white/70 bg-white/82 text-sky-700`}>
                {node() ? "node session" : "workflow root"}
              </span>
              <span class="text-[18px] font-semibold tracking-[-0.02em] text-slate-950">
                {node()?.title ?? props.snapshot.workflow.title}
              </span>
              <StatusBadge status={status()} />
              <StatusBadge status={result()} text={result()} />
            </div>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <FilterChips
                items={[
                  { label: node()?.agent ?? "orchestrator" },
                  { label: model() },
                  ...(node() ? [{ label: `attempt ${node()!.attempt}/${node()!.max_attempts}` }] : []),
                  ...(node() ? [{ label: `actions ${node()!.action_count}/${node()!.max_actions}` }] : []),
                  ...(!node() ? [{ label: `cursor ${props.snapshot.cursor}` }] : []),
                ]}
              />
            </div>
            <div class="mt-3 max-w-3xl text-[12px] leading-6 text-slate-600">
              {node()
                ? `Focused on ${node()!.title}. Status and controls below reflect the live subagent session.`
                : props.snapshot.workflow.summary?.objective ??
                  "The root session owns orchestration, review, and the execution map for all subagents."}
            </div>
          </div>
          <div class="flex items-center gap-2">
            <button
              class="rounded-xl border border-slate-900 bg-slate-900 px-3 py-2 text-12-medium text-white shadow-[0_10px_24px_rgba(15,23,42,0.18)] transition-transform duration-200 hover:-translate-y-0.5"
              onClick={() =>
                providers.connected().length > 0
                  ? dialog.show(() => <DialogSelectModel />)
                  : dialog.show(() => <DialogSelectProvider />)
              }
            >
              {providers.connected().length > 0 ? "Select model" : "Connect provider"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function RuntimeCanvas(props: {
  graph: LayoutGraph
  folded: boolean
  snapshot: WorkflowSnapshot
  host: (el: HTMLDivElement) => void
  progress: number
  total: number
  done: number
  failed: number
  wait: number
  onOpen: () => void
}) {
  return (
    <div class={`${ui.rad.xl} min-h-0 min-w-0 overflow-hidden ${ui.surf.pane}`}>
      <div class="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div>
          <div class={ui.text.meta}>execution map</div>
          <div class={ui.text.head}>Runtime topology and node flow</div>
        </div>
        <FilterChips items={[{ label: "orchestrator" }, { label: "active path", tone: "running" }]} />
      </div>
      <div class="min-h-0 flex-1 overflow-auto px-5 pb-5">
        <Show
          when={!props.folded}
          fallback={
            <div class="flex h-full min-h-[320px] items-start justify-center">
              <div class={`${ui.rad.xl} w-full max-w-[760px] p-6 ${ui.surf.pane}`}>
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <div class={ui.text.meta}>plan snapshot</div>
                    <div class="mt-2 text-[24px] font-semibold tracking-[-0.03em] text-slate-950">
                      {props.snapshot.workflow.title}
                    </div>
                    <div class="mt-2 max-w-xl text-[12px] leading-6 text-slate-600">
                      {props.snapshot.workflow.summary?.objective ??
                        "The workflow has reached a terminal state. Reopen the graph only when you need node-by-node execution history."}
                    </div>
                  </div>
                  <StatusBadge status={props.snapshot.workflow.status} />
                </div>
                <div class="mt-5 h-2 overflow-hidden rounded-full bg-slate-200/80">
                  <div
                    class="h-full rounded-full bg-[linear-gradient(90deg,#38bdf8_0%,#60a5fa_55%,#34d399_100%)]"
                    style={{ width: `${props.progress}%` }}
                  />
                </div>
                <div class="mt-5 grid grid-cols-2 gap-3 text-[11px] text-slate-500 md:grid-cols-4">
                  <div class={`${ui.rad.md} px-3 py-3 ${ui.surf.box}`}>
                    <div class={ui.text.chip}>nodes</div>
                    <div class="mt-2 text-[18px] font-semibold text-slate-950">{props.total}</div>
                  </div>
                  <div class={`${ui.rad.md} px-3 py-3 ${ui.surf.box}`}>
                    <div class={ui.text.chip}>done</div>
                    <div class="mt-2 text-[18px] font-semibold text-slate-950">{props.done}</div>
                  </div>
                  <div class={`${ui.rad.md} px-3 py-3 ${ui.surf.box}`}>
                    <div class={ui.text.chip}>failed</div>
                    <div class="mt-2 text-[18px] font-semibold text-slate-950">{props.failed}</div>
                  </div>
                  <div class={`${ui.rad.md} px-3 py-3 ${ui.surf.box}`}>
                    <div class={ui.text.chip}>active</div>
                    <div class="mt-2 text-[18px] font-semibold text-slate-950">{props.wait}</div>
                  </div>
                </div>
                <div class="mt-4 flex items-center justify-between gap-3">
                  <div class="text-[12px] leading-6 text-slate-600">
                    Node sessions stay folded once the run is over, keeping the surface focused on outcome instead of process noise.
                  </div>
                  <button
                    class="rounded-xl border border-slate-200 bg-white px-3 py-2 text-12-medium text-slate-900 transition-colors hover:border-slate-300"
                    onClick={props.onOpen}
                  >
                    Reopen execution map
                  </button>
                </div>
              </div>
            </div>
          }
        >
          <div
            class={`${ui.rad.lg} relative w-full overflow-hidden ${ui.surf.canvas}`}
            style={{ height: `${Math.max(props.graph.height, 420)}px` }}
          >
            <div
              class="absolute inset-0 opacity-45"
              style={{
                "background-image":
                  "linear-gradient(rgba(148,163,184,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.08) 1px, transparent 1px)",
                "background-size": "56px 56px",
              }}
            />
            <div class="pointer-events-none absolute inset-x-6 top-5 z-10 flex flex-wrap items-center gap-2">
              <FilterChips
                items={[
                  { label: "runtime graph" },
                  { label: "active", tone: "running" },
                  { label: "success", tone: "completed" },
                  { label: "failed", tone: "failed" },
                  { label: "paused", tone: "paused" },
                ]}
              />
            </div>
            <div ref={props.host} class="absolute inset-0" />
          </div>
        </Show>
      </div>
    </div>
  )
}

function InspectorPanel(props: {
  node?: WorkflowNode
  current?: WorkflowNode
  snapshot: WorkflowSnapshot
  eventNodes: Map<string, string>
  pending: number
  lastControl?: WorkflowEvent
  lastPull?: WorkflowEvent
  lastUpdate?: WorkflowEvent
  checkpoints: WorkflowCheckpoint[]
  events: WorkflowEvent[]
  finished: boolean
  folded: boolean
  onToggle: () => void
  onSelectSession: (id: string) => void
}) {
  return (
    <div class="flex min-h-0 flex-col gap-4">
      <div class={`${ui.rad.xl} min-h-0 overflow-auto p-5 ${ui.surf.pane}`}>
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class={ui.text.meta}>inspector</div>
            <div class={ui.text.head}>{props.node?.title ?? "Select a node"}</div>
          </div>
          <Show when={props.finished}>
            <button
              class="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-medium text-slate-700 transition-colors hover:border-slate-300"
              onClick={props.onToggle}
            >
              {props.folded ? "Expand map" : "Collapse map"}
            </button>
          </Show>
        </div>
        <Show when={props.node} fallback={<div class="mt-4 text-[12px] text-slate-500">Select a node in the graph to inspect its runtime state.</div>}>
          <div class={`relative mt-4 overflow-hidden ${ui.rad.lg} border bg-gradient-to-br ${card(props.node!.status)} ${frame(props.node!.status, true, props.current?.id === props.node!.id)} p-4 text-slate-900 transition-[border-color,box-shadow,background] duration-[220ms] motion-reduce:transition-none`}>
            <div class={`absolute right-[-28px] top-[-24px] size-28 rounded-full blur-3xl ${orb(props.node!.status)}`} />
            <div class="flex items-start gap-3">
              <div class={`flex size-12 items-center justify-center rounded-2xl text-sm font-semibold ${nodeIcon(props.node!.status)}`}>
                {String(props.node!.position + 1).padStart(2, "0")}
              </div>
              <div class="min-w-0 flex-1">
                <div class="truncate text-[17px] font-semibold tracking-[-0.02em] text-slate-950">{props.node!.title}</div>
                <div class="mt-1 text-[10px] uppercase tracking-[0.14em] text-slate-500">{props.node!.agent}</div>
                <div class="mt-3 flex flex-wrap items-center gap-2">
                  <StatusBadge status={props.node!.status} />
                  <StatusBadge status={props.node!.result_status} text={props.node!.result_status} />
                  <Show when={live(props.node!.status)}>
                    <span class="inline-flex items-center gap-2 rounded-full border border-sky-200/90 bg-white/82 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-sky-700">
                      <span class="size-3 rounded-full border-2 border-sky-500/25 border-t-sky-500 animate-spin motion-reduce:animate-none" />
                      live
                    </span>
                  </Show>
                </div>
              </div>
            </div>
            <div class="mt-4 grid gap-2 text-[11px] text-slate-600">
              <div class={`${ui.rad.md} px-3 py-3 ${modelShell(props.node!.status)} border shadow-[inset_0_1px_0_rgba(255,255,255,0.72)]`}>
                <div class={ui.text.chip}>model</div>
                <div class="mt-1 text-[12px] leading-5 text-slate-950">{modelLabel(props.node!)}</div>
              </div>
              <div class={`${ui.rad.md} px-3 py-3 ${ui.surf.box}`}>
                <div class={ui.text.chip}>session</div>
                <div class="mt-1 text-[12px] leading-5 text-slate-950">{props.node!.session_id ?? "not started"}</div>
              </div>
              <div class="grid grid-cols-2 gap-2">
                <div class={`${ui.rad.md} px-3 py-3 ${ui.surf.box}`}>
                  <div class={ui.text.chip}>attempt</div>
                  <div class="mt-1 text-slate-950">{`${props.node!.attempt}/${props.node!.max_attempts}`}</div>
                </div>
                <div class={`${ui.rad.md} px-3 py-3 ${ui.surf.box}`}>
                  <div class={ui.text.chip}>progress</div>
                  <div class="mt-1 text-slate-950">{`${props.node!.action_count}/${props.node!.max_actions} actions`}</div>
                </div>
              </div>
            </div>
          </div>

          <Show when={props.node!.fail_reason}>
            <div class="mt-4 rounded-[22px] border border-red-200 bg-red-50 px-4 py-3 text-[11px] leading-6 text-red-700">
              {props.node!.fail_reason}
            </div>
          </Show>

          <div class="mt-4 grid gap-3">
            <div class={`${ui.rad.lg} p-4 ${ui.surf.box}`}>
              <div class={ui.text.meta}>diagnostics</div>
              <div class="mt-3 grid grid-cols-2 gap-2 text-[11px] text-slate-500">
                <div class={`${ui.rad.md} px-3 py-3 ${ui.surf.box}`}>
                  <div class={ui.text.chip}>phase</div>
                  <div class="mt-1 text-slate-950">{props.snapshot.runtime.phase}</div>
                </div>
                <div class={`${ui.rad.md} px-3 py-3 ${ui.surf.box}`}>
                  <div class={ui.text.chip}>active node</div>
                  <div class="mt-1 text-slate-950">{props.eventNodes.get(props.snapshot.runtime.active_node_id ?? "") ?? props.snapshot.runtime.active_node_id ?? "none"}</div>
                </div>
                <div class={`${ui.rad.md} px-3 py-3 ${ui.surf.box}`}>
                  <div class={ui.text.chip}>commands</div>
                  <div class="mt-1 text-slate-950">{props.snapshot.runtime.command_count}</div>
                </div>
                <div class={`${ui.rad.md} px-3 py-3 ${ui.surf.box}`}>
                  <div class={ui.text.chip}>pending</div>
                  <div class="mt-1 text-slate-950">{props.pending}</div>
                </div>
              </div>
            </div>

            <div class={`${ui.rad.lg} p-4 ${ui.surf.box}`}>
              <div class={ui.text.meta}>meta actions</div>
              <div class="mt-3 grid gap-2 text-[11px] text-slate-500">
                <div class={`${ui.rad.md} px-3 py-3 ${ui.surf.box}`}>
                  <div class={ui.text.chip}>last control</div>
                  <div class="mt-1 text-slate-950">{props.lastControl?.payload.command ? String(props.lastControl.payload.command) : "none"}</div>
                </div>
                <div class={`${ui.rad.md} px-3 py-3 ${ui.surf.box}`}>
                  <div class={ui.text.chip}>pull / update</div>
                  <div class="mt-1 text-slate-950">
                    {props.lastPull ? `pull #${props.lastPull.id}` : "pull none"} · {props.lastUpdate ? `update #${props.lastUpdate.id}` : "update none"}
                  </div>
                </div>
                <Show when={props.checkpoints.length > 0}>
                  <div class="flex flex-wrap gap-1.5">
                    <For each={props.checkpoints}>
                      {(mark) => <StatusBadge status={mark.status} text={`${mark.label} · ${mark.status}`} />}
                    </For>
                  </div>
                </Show>
                <Show when={props.node!.session_id}>
                  <button
                    class="rounded-[22px] border border-slate-900 bg-slate-900 px-3 py-2.5 text-12-medium text-white shadow-[0_14px_28px_rgba(15,23,42,0.14)] transition-transform duration-[220ms] hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
                    onClick={() => props.onSelectSession(props.node!.session_id!)}
                  >
                    Open subagent session
                  </button>
                </Show>
              </div>
            </div>

            <Show when={props.node!.state_json || props.node!.result_json}>
              <div class={`${ui.rad.lg} p-4 ${ui.surf.box}`}>
                <div class={ui.text.meta}>payloads</div>
                <Show when={props.node!.state_json}>
                  <div class="mt-3">
                    <div class={ui.text.chip}>state</div>
                    <pre class={`mt-2 overflow-auto ${ui.rad.lg} p-3 text-[10px] leading-5 ${ui.surf.code}`}>{short(props.node!.state_json)}</pre>
                  </div>
                </Show>
                <Show when={props.node!.result_json}>
                  <div class="mt-3">
                    <div class={ui.text.chip}>result</div>
                    <pre class={`mt-2 overflow-auto ${ui.rad.lg} p-3 text-[10px] leading-5 ${ui.surf.code}`}>{short(props.node!.result_json)}</pre>
                  </div>
                </Show>
              </div>
            </Show>
          </div>
        </Show>
      </div>

      <div class={`${ui.rad.xl} h-[260px] overflow-hidden p-5 ${ui.surf.pane}`}>
        <div class="flex items-center justify-between gap-2">
          <div>
            <div class={ui.text.meta}>event flow</div>
            <div class={ui.text.head}>{props.node?.title ?? "runtime"} signals</div>
          </div>
          <div class="text-[11px] text-slate-500">latest six events</div>
        </div>
        <EventFlowList events={props.events} nodes={props.eventNodes} />
      </div>
    </div>
  )
}

export function WorkflowRuntimePanel(props: {
  snapshot: WorkflowSnapshot
  currentSessionID?: string
  onSelectSession: (sessionID: string) => void
}) {
  let host: HTMLDivElement | undefined
  let view: G6Graph | undefined
  let topo = ""
  const [store, setStore] = createStore({
    node: undefined as string | undefined,
    folded: false,
    graph: fallbackLayout(props.snapshot),
    run: 0,
  })
  const graph = createMemo(() => store.graph)
  const currentNode = createMemo(() => {
    const active = props.snapshot.runtime.active_node_id
    if (active) {
      const direct = props.snapshot.nodes.find((node) => node.id === active)
      if (direct) return direct
    }
    const selected = props.snapshot.workflow.selected_node_id
    if (selected) {
      const direct = props.snapshot.nodes.find((node) => node.id === selected)
      if (direct) return direct
    }
    const current = props.snapshot.workflow.current_node_id
    if (current) {
      const direct = props.snapshot.nodes.find((node) => node.id === current)
      if (direct) return direct
    }
    return props.snapshot.nodes.find((node) => node.status === "running" || node.status === "waiting")
  })
  const roots = createMemo(() => {
    const targets = new Set(props.snapshot.edges.map((edge) => edge.to_node_id))
    return sortNodes(props.snapshot.nodes).filter((node) => !targets.has(node.id))
  })
  const checkpointMap = createMemo(() => {
    const map = new Map<string, WorkflowCheckpoint[]>()
    for (const checkpoint of props.snapshot.checkpoints) {
      const list = map.get(checkpoint.node_id)
      if (list) list.push(checkpoint)
      else map.set(checkpoint.node_id, [checkpoint])
    }
    return map
  })
  const lastEvent = createMemo(() => props.snapshot.events.at(-1))
  const eventNodes = createMemo(() => {
    const map = new Map(props.snapshot.nodes.map((node) => [node.id, node.title]))
    return map
  })
  createEffect(() => {
    const picked = props.snapshot.nodes.find((node) => node.session_id === props.currentSessionID)?.id
    if (picked && picked !== store.node) {
      setStore("node", picked)
      return
    }
    if (store.node && props.snapshot.nodes.some((node) => node.id === store.node)) return
    if (currentNode()?.id) setStore("node", currentNode()!.id)
  })
  createEffect(
    on(
      () => topology(props.snapshot),
      () => {
        const graph = fallbackLayout(props.snapshot)
        const run = store.run + 1
        setStore("graph", graph)
        setStore("run", run)
        void layout(props.snapshot).then((next) => {
          if (store.run !== run) return
          setStore("graph", next)
        })
      },
    ),
  )
  const selectedNode = createMemo(() => props.snapshot.nodes.find((node) => node.id === store.node) ?? currentNode())
  const focusedNodeID = createMemo(() => selectedNode()?.id)
  const controls = createMemo(() =>
    props.snapshot.events
      .filter((event) => event.kind === "node.control" && event.target_node_id === focusedNodeID())
      .toReversed(),
  )
  const pulls = createMemo(() =>
    props.snapshot.events
      .filter((event) => event.kind === "node.pulled" && event.node_id === focusedNodeID())
      .toReversed(),
  )
  const updates = createMemo(() =>
    props.snapshot.events
      .filter((event) => event.node_id === focusedNodeID() && (event.kind === "node.updated" || event.source === "node"))
      .toReversed(),
  )
  const lastPull = createMemo(() => pulls()[0])
  const lastControl = createMemo(() => controls()[0])
  const lastUpdate = createMemo(() => updates()[0])
  const pending = createMemo(() =>
    focusedNodeID()
      ? props.snapshot.events.filter(
          (event) =>
            event.target_node_id === focusedNodeID() &&
            event.kind === "node.control" &&
            event.id > (lastPull()?.id ?? 0),
        ).length
      : 0,
  )
  const focusedEvents = createMemo(() =>
    props.snapshot.events
      .filter(
        (event) =>
          !focusedNodeID() ||
          event.node_id === focusedNodeID() ||
          event.target_node_id === focusedNodeID() ||
          (event.source === "orchestrator" && event.target_node_id === focusedNodeID()),
      )
      .slice(-6)
      .reverse(),
  )
  const focusedCheckpoints = createMemo(() => checkpointMap().get(focusedNodeID() ?? "") ?? [])
  const activeRootIDs = createMemo(() => {
    const node = currentNode()
    if (!node) return new Set<string>()
    return new Set(roots().filter((item) => item.id === node.id).map((item) => item.id))
  })
  const activeEdgeIDs = createMemo(() => {
    const node = currentNode()
    if (!node) return new Set<string>()
    return new Set(props.snapshot.edges.filter((edge) => edge.to_node_id === node.id).map((edge) => edge.id))
  })
  const doneEdgeIDs = createMemo(() =>
    new Set(
      props.snapshot.edges
        .filter((edge) => {
          const to = props.snapshot.nodes.find((node) => node.id === edge.to_node_id)
          if (!to) return false
          return !["pending"].includes(to.status)
        })
        .map((edge) => edge.id),
    ),
  )
  const chart = createMemo<G6GraphData>(() => {
    const now = currentNode()?.id
    const pick = focusedNodeID()
    const map = graph()
    const settled = props.snapshot.nodes.filter((node) => ["completed", "failed", "cancelled"].includes(node.status)).length
    const pos = new Map(map.nodes.map((item) => [item.node.id, item]))
    const nodes = [
      WorkflowNodeCard({
        root: true,
        x: map.orchestrator_x + map.rootW / 2,
        y: map.orchestrator_y + map.rootH / 2,
        w: map.rootW,
        h: map.rootH,
        pick: true,
        live: false,
        phase: props.snapshot.runtime.phase,
        settled,
        total: props.snapshot.nodes.length,
        flow: props.snapshot.workflow,
      }),
      ...map.nodes.map((item) =>
        WorkflowNodeCard({
          node: item.node,
          x: item.x + map.cardW / 2,
          y: item.y + map.cardH / 2,
          w: map.cardW,
          h: map.cardH,
          pick: pick === item.node.id,
          live: now === item.node.id,
          phase: props.snapshot.runtime.phase,
          settled,
          total: props.snapshot.nodes.length,
          flow: props.snapshot.workflow,
        }),
      ),
    ]
    const edges = [
      ...roots().map((node) => ({
        id: `root:${node.id}`,
        source: "__workflow_root__",
        target: node.id,
        sourceAnchor: 1,
        targetAnchor: 0,
        type: "cubic-horizontal",
        style: {
          stroke: activeRootIDs().has(node.id) ? "#0ea5e9" : "#94a3b8",
          lineWidth: activeRootIDs().has(node.id) ? 3 : 1.6,
          opacity: activeRootIDs().has(node.id) ? 0.92 : 0.46,
          lineDash: activeRootIDs().has(node.id) ? [10, 8] : undefined,
          endArrow: {
            path: "M 0,0 L 8,4 L 0,8 Z",
            d: 8,
            fill: activeRootIDs().has(node.id) ? "#0ea5e9" : "#94a3b8",
          },
        },
      })),
      ...props.snapshot.edges.map((edge) => {
        const from = pos.get(edge.from_node_id)
        const to = pos.get(edge.to_node_id)
        const right = (from?.x ?? 0) <= (to?.x ?? 0)
        return {
          id: edge.id,
          source: edge.from_node_id,
          target: edge.to_node_id,
          sourceAnchor: right ? 1 : 0,
          targetAnchor: right ? 0 : 1,
          type: "cubic-horizontal",
          ...WorkflowEdgeLabel({ label: edge.label }),
          style: {
            stroke: activeEdgeIDs().has(edge.id) ? "#0ea5e9" : doneEdgeIDs().has(edge.id) ? "#334155" : "#cbd5e1",
            lineWidth: activeEdgeIDs().has(edge.id) ? 3 : doneEdgeIDs().has(edge.id) ? 2.1 : 1.4,
            opacity: activeEdgeIDs().has(edge.id) ? 0.96 : doneEdgeIDs().has(edge.id) ? 0.72 : 0.52,
            lineDash: activeEdgeIDs().has(edge.id) ? [10, 8] : doneEdgeIDs().has(edge.id) ? undefined : [8, 8],
            endArrow: {
              path: "M 0,0 L 8,4 L 0,8 Z",
              d: 8,
              fill: activeEdgeIDs().has(edge.id) ? "#0ea5e9" : doneEdgeIDs().has(edge.id) ? "#334155" : "#94a3b8",
            },
          },
        }
      }),
    ]
    return { nodes, edges }
  })
  createEffect(() => {
    const data = chart()
    const next = topology(props.snapshot)
    void loadG6()
      .then((lib) => {
        const g6 = bootG6() ?? lib
        if (!host || !g6) return
        const w = host.clientWidth || graph().width
        const h = host.clientHeight || Math.max(graph().height, 420)
        if (!view) {
          view = new g6.Graph({
            container: host,
            width: w,
            height: h,
            fitView: true,
            fitViewPadding: 28,
            modes: {
              default: ["drag-canvas", "zoom-canvas"],
            },
            animate: true,
            defaultNode: {
              type: "workflow-card",
            },
            defaultEdge: {
              type: "cubic-horizontal",
              labelCfg: {
                autoRotate: false,
                style: {
                  fill: "#94a3b8",
                  fontSize: 10,
                  fontWeight: 600,
                },
              },
            },
          })
          view.on("node:click", (event) => {
            const id = event.item?.getID()
            if (!id || id === "__workflow_root__") return
            setStore("node", id)
          })
          view.data(data)
          view.render()
          view.fitView?.(28)
          topo = next
          return
        }
        view.changeSize?.(w, h)
        view.changeData(data)
        if (topo === next) return
        view.fitView?.(28)
        topo = next
      })
      .catch(() => {})
  })
  onCleanup(() => view?.destroy())
  const total = createMemo(() => props.snapshot.nodes.length)
  const done = createMemo(() => props.snapshot.nodes.filter((node) => node.status === "completed").length)
  const failed = createMemo(() => props.snapshot.nodes.filter((node) => node.status === "failed").length)
  const waiting = createMemo(() => props.snapshot.nodes.filter((node) => node.status === "waiting").length)
  const blocked = createMemo(() => props.snapshot.nodes.filter((node) => node.status === "ready").length)
  const settled = createMemo(() =>
    props.snapshot.nodes.filter((node) => ["completed", "failed", "cancelled"].includes(node.status)).length,
  )
  const progress = createMemo(() => pct(settled(), total()))
  const finished = createMemo(() => terminal(props.snapshot.workflow.status))
  createEffect(() => {
    if (!finished()) return
    if (store.folded) return
    setStore("folded", true)
  })

  return (
    <div class={`flex h-full min-h-0 flex-col px-4 pb-4 pt-3 ${ui.surf.page}`}>
      <WorkflowHeader
        snapshot={props.snapshot}
        node={currentNode()}
        progress={progress()}
        settled={settled()}
        total={total()}
        wait={waiting()}
        ready={blocked()}
        failed={failed()}
        last={lastEvent()}
      />
      <div class="grid min-h-0 flex-1 grid-cols-1 gap-4 pt-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <RuntimeCanvas
          graph={graph()}
          folded={store.folded}
          snapshot={props.snapshot}
          host={(el) => {
            host = el
          }}
          progress={progress()}
          total={total()}
          done={done()}
          failed={failed()}
          wait={waiting()}
          onOpen={() => setStore("folded", false)}
        />
        <InspectorPanel
          node={selectedNode()}
          current={currentNode()}
          snapshot={props.snapshot}
          eventNodes={eventNodes()}
          pending={pending()}
          lastControl={lastControl()}
          lastPull={lastPull()}
          lastUpdate={lastUpdate()}
          checkpoints={focusedCheckpoints()}
          events={focusedEvents()}
          finished={finished()}
          folded={store.folded}
          onToggle={() => setStore("folded", (value) => !value)}
          onSelectSession={props.onSelectSession}
        />
      </div>
    </div>
  )
}
