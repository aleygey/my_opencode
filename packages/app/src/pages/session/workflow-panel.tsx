import type { FileDiff } from "@opencode-ai/sdk/v2/client"
import { createMemo, createEffect, For, Match, on, onCleanup, Show, Switch } from "solid-js"
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
  current_node_id?: string
  selected_node_id?: string
  version: number
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

type LayoutGraph = {
  nodes: LayoutNode[]
  width: number
  height: number
  bus_x: number
  bus_y: number
  bus_h: number
  orchestrator_x: number
  orchestrator_y: number
}

const statusTone = (status: string) => {
  if (status === "completed") return "success"
  if (status === "failed" || status === "cancelled") return "error"
  if (status === "interrupted" || status === "paused") return "warning"
  if (status === "running" || status === "waiting") return "info"
  return "neutral"
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

const statusDot = (status: string) => {
  if (status === "completed") return "bg-emerald-500"
  if (status === "failed" || status === "cancelled") return "bg-red-500"
  if (status === "interrupted" || status === "paused") return "bg-amber-500"
  if (status === "running" || status === "waiting") return "bg-sky-500 animate-pulse"
  return "bg-zinc-400"
}

const eventSummary = (event: WorkflowEvent) => {
  if (event.payload.fail_reason) return String(event.payload.fail_reason)
  if (event.payload.command) return `command: ${String(event.payload.command)}`
  if (event.payload.tool) return `tool: ${String(event.payload.tool)}`
  if (event.payload.status) return `status: ${String(event.payload.status)}`
  if (event.payload.result_status) return `result: ${String(event.payload.result_status)}`
  return "state change persisted on runtime bus"
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

function layout(snapshot: WorkflowSnapshot) {
  const cardW = 188
  const cardH = 132
  const orchestrator_x = 32
  const orchestrator_y = 70
  const bus_x = 236
  const bus_y = 30
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

  const placed = new Map<string, LayoutNode>()
  for (const [value, group] of groups) {
    for (const [row, node] of sortNodes(group).entries()) {
      placed.set(node.id, {
        node,
        level: value,
        row,
        x: 332 + value * 224,
        y: 62 + row * 168,
      })
    }
  }

  const items = [...placed.values()]
  const width = Math.max(...items.map((item) => item.x), 0) + cardW + 40
  const height = Math.max(...items.map((item) => item.y), 0) + cardH + 72
  return {
    nodes: items,
    width,
    height,
    bus_x,
    bus_y,
    bus_h: height - 52,
    orchestrator_x,
    orchestrator_y,
  }
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
        if (data.workflow) {
          setStore("snapshot", "workflow", data.workflow)
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
      })
      .catch(() => {})

    if (!rootSelected()) return
    await request<FileDiff[]>(`/workflow/${snapshot.workflow.id}/diff`)
      .then((diff) => {
        setStore("rootDiffs", diff ?? [])
        setStore("rootDiffsReady", true)
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
  onSelectSession: (sessionID: string) => void
}) {
  const sync = useSync()
  const root = createMemo(() => props.snapshot.workflow.session_id)
  const visible = createMemo(() =>
    sortNodes(props.snapshot.nodes).filter(
      (node) =>
        !!node.session_id &&
        (node.session_id === props.currentSessionID ||
          props.snapshot.events.some((event) => event.node_id === node.id || event.session_id === node.session_id) ||
          !["pending", "ready"].includes(node.status)),
    ),
  )
  const cards = createMemo(() => [
    {
      id: props.snapshot.workflow.session_id,
      title: props.snapshot.workflow.title,
      subtitle: "orchestrator",
      status: props.snapshot.workflow.status,
      type: "root" as const,
    },
    ...visible()
      .map((node, index) => ({
        id: node.session_id!,
        title: node.title,
        subtitle: node.agent,
        status: node.status,
        type: "node" as const,
        model: modelLabel(node),
        note: `n${index + 1}`,
      })),
  ])

  return (
    <div class="border-b border-border-weak-base bg-background-stronger px-3 py-2 overflow-x-auto">
      <div class="flex items-center gap-2 min-w-max">
        <For each={cards()}>
          {(card) => {
            const session = createMemo(() => sync.session.get(card.id))
            const active = () => props.currentSessionID === card.id
            return (
              <button
                class="inline-flex h-10 min-w-0 items-center gap-2 rounded-lg border px-3 text-left transition-all"
                classList={{
                  "border-sky-500/45 bg-sky-500/8 shadow-xs": active() && card.type === "root",
                  "border-emerald-500/25 bg-background-base shadow-xs": active() && card.type !== "root",
                  "border-border-weak-base bg-background-panel hover:border-border-strong": !active(),
                }}
                onClick={() => props.onSelectSession(card.id)}
              >
                <span class={`size-2 shrink-0 rounded-full ${card.type === "root" ? "bg-sky-500" : statusDot(card.status)}`} />
                <span class="rounded-full border border-border-weak-base px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-text-weak">
                  {card.id === root() ? "root" : card.type === "node" ? card.note : "root"}
                </span>
                <span class="max-w-40 truncate text-12-medium text-text-strong">{session()?.title ?? card.title}</span>
                <span class="truncate text-[11px] text-text-weak">{card.subtitle}</span>
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
    <div class="border-b border-border-weak-base bg-background-base px-4 py-2">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <span class="rounded-full border border-sky-500/25 bg-sky-500/8 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-sky-700 dark:text-sky-300">
              {node() ? "node session" : "workflow root"}
            </span>
            <span class="text-13-medium text-text-strong">{node()?.title ?? props.snapshot.workflow.title}</span>
            <Badge tone={statusTone(status())}>{status()}</Badge>
            <Badge tone={statusTone(result())}>{result()}</Badge>
          </div>
          <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-11-regular text-text-weak">
            <span>{node()?.agent ?? "orchestrator"}</span>
            <span>{model()}</span>
            <Show when={node()}>
              <span>{`attempt ${node()!.attempt}/${node()!.max_attempts}`}</span>
            </Show>
            <Show when={node()}>
              <span>{`action ${node()!.action_count}/${node()!.max_actions}`}</span>
            </Show>
            <Show when={!node()}>
              <span>{`cursor ${props.snapshot.cursor}`}</span>
            </Show>
          </div>
        </div>

        <div class="flex items-center gap-2">
          <button
            class="rounded-lg border border-border-weak-base bg-background-panel px-3 py-1.5 text-12-medium text-text-strong transition-colors hover:border-border-strong"
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
      <div class="mt-2 text-[11px] text-text-weak">
        {node()
          ? "Messages and tool calls now target this subagent session. Model changes apply to the current node composer."
          : providers.connected().length > 0
            ? "The root session owns orchestration and aggregated review. Runtime state below reflects node deltas, checkpoints and bus events."
            : "No provider is connected in this workspace yet. Connect one first if you want to send prompts from the current session."}
      </div>
    </div>
  )
}

export function WorkflowRuntimePanel(props: {
  snapshot: WorkflowSnapshot
  currentSessionID?: string
  onSelectSession: (sessionID: string) => void
}) {
  const graph = createMemo(() => layout(props.snapshot))
  const selectedNode = createMemo(() => {
    const direct = props.snapshot.nodes.find((node) => node.session_id === props.currentSessionID)
    if (direct) return direct
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
  const summary = createMemo(() => {
    const total = props.snapshot.nodes.length
    const running = props.snapshot.nodes.filter((node) => node.status === "running" || node.status === "waiting").length
    const waiting = props.snapshot.nodes.filter((node) => node.status === "waiting").length
    const done = props.snapshot.nodes.filter((node) => node.status === "completed").length
    const failed = props.snapshot.nodes.filter((node) => node.status === "failed").length
    return { total, running, waiting, done, failed }
  })
  const eventNodes = createMemo(() => {
    const map = new Map(props.snapshot.nodes.map((node) => [node.id, node.title]))
    return map
  })
  const focusedNodeID = createMemo(() => selectedNode()?.id)
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
  const checkpointPins = createMemo(() =>
    props.snapshot.checkpoints
      .map((checkpoint) => {
        const target = graph().nodes.find((item) => item.node.id === checkpoint.node_id)
        if (!target) return
        return {
          checkpoint,
          x: target.x - 20,
          y: target.y + 72,
        }
      })
      .filter(Boolean) as Array<{ checkpoint: WorkflowCheckpoint; x: number; y: number }>,
  )

  return (
    <div class="flex h-full min-h-0 flex-col bg-background-stronger">
      <div class="border-b border-border-weak-base px-4 py-3">
        <div class="flex flex-wrap items-center gap-2">
          <div class="text-15-medium text-text-strong">{props.snapshot.workflow.title}</div>
          <Badge tone={statusTone(props.snapshot.workflow.status)}>{props.snapshot.workflow.status}</Badge>
          <Badge tone="info">{`current ${selectedNode()?.title ?? "idle"}`}</Badge>
          <Badge tone="neutral">{`${summary().running} active`}</Badge>
          <Badge tone="warning">{`${summary().waiting} waiting`}</Badge>
          <Badge tone="success">{`${props.snapshot.cursor} cursor`}</Badge>
        </div>
        <div class="mt-2 text-11-regular text-text-weak">
          Root orchestrator drives the runtime bus. Highlighted node is the live execution target; arrows are dependencies and checkpoint pills gate the next edge.
        </div>
        <Show when={lastEvent()}>
          <div class="mt-3 rounded-xl border border-border-weak-base bg-background-base px-3 py-2 text-11-regular text-text-weak">
            Latest runtime event: <span class="text-text-strong">{lastEvent()!.kind}</span> from{" "}
            <span class="text-text-strong">{lastEvent()!.source}</span>
          </div>
        </Show>
      </div>

      <div class="flex-1 min-h-0 overflow-auto px-4 py-4">
        <div
          class="relative rounded-2xl border border-border-weak-base bg-background-panel/70"
          style={{
            width: `${graph().width}px`,
            height: `${graph().height}px`,
            "background-image":
              "linear-gradient(to right, rgba(148,163,184,0.08) 1px, transparent 1px), linear-gradient(to bottom, rgba(148,163,184,0.08) 1px, transparent 1px)",
              "background-size": "24px 24px",
          }}
        >
          <div class="absolute right-4 top-4 z-10 rounded-xl border border-border-weak-base bg-background-base/95 px-3 py-2 text-[11px] text-text-weak shadow-xs">
            <div class="font-medium text-text-strong">Runtime snapshot</div>
            <div class="mt-1">{`${props.snapshot.edges.length} edges · ${props.snapshot.checkpoints.length} checkpoints · ${props.snapshot.events.length} events`}</div>
            <div class="mt-1">{selectedNode() ? `${selectedNode()!.agent} is ${selectedNode()!.status}` : "waiting for orchestrator"}</div>
          </div>

          <div
            class="absolute rounded-2xl border border-sky-500/25 bg-sky-500/10 px-4 py-3 shadow-xs"
            style={{ left: `${graph().orchestrator_x}px`, top: `${graph().orchestrator_y}px`, width: "156px" }}
          >
            <div class="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-sky-700 dark:text-sky-300">
              <span class="size-2 rounded-full bg-sky-500" />
              orchestrator
            </div>
            <div class="mt-2 text-13-medium text-text-strong">{props.snapshot.workflow.title}</div>
            <div class="mt-1 text-11-regular text-text-weak">Plan, control, replan</div>
          </div>

          <div
            class="absolute rounded-[22px] border border-border-weak-base bg-background-base/90 px-3 py-3"
            style={{ left: `${graph().bus_x}px`, top: `${graph().bus_y}px`, width: "72px", height: `${graph().bus_h}px` }}
          >
            <div class="text-center text-[10px] font-semibold uppercase tracking-[0.08em] text-text-weak">runtime</div>
            <div class="mt-2 flex h-full flex-col items-center justify-between pb-3">
              <div class="grid gap-2">
                <span class="size-2 rounded-full bg-sky-500 animate-pulse" />
                <span class="size-2 rounded-full bg-sky-500/70 animate-pulse [animation-delay:150ms]" />
                <span class="size-2 rounded-full bg-sky-500/40 animate-pulse [animation-delay:300ms]" />
              </div>
              <div class="text-[10px] text-text-weak">{`${props.snapshot.cursor}`}</div>
            </div>
          </div>

          <svg class="absolute inset-0 size-full" viewBox={`0 0 ${graph().width} ${graph().height}`}>
            <defs>
              <marker id="workflow-arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-border-strong)" />
              </marker>
            </defs>
            <path
              d={`M ${graph().orchestrator_x + 176} ${graph().orchestrator_y + 38} C ${graph().orchestrator_x + 210} ${graph().orchestrator_y + 38}, ${graph().bus_x - 20} ${graph().orchestrator_y + 38}, ${graph().bus_x} ${graph().orchestrator_y + 38}`}
              fill="none"
              stroke="var(--color-border-strong)"
              stroke-width="2"
              marker-end="url(#workflow-arrow)"
            />
            <For each={roots()}>
              {(node) => {
                const target = createMemo(() => graph().nodes.find((item) => item.node.id === node.id))
                return (
                  <Show when={target()}>
                    <path
                      d={`M ${graph().bus_x + 72} ${target()!.y + 42} C ${graph().bus_x + 116} ${target()!.y + 42}, ${target()!.x - 24} ${target()!.y + 42}, ${target()!.x} ${target()!.y + 42}`}
                      fill="none"
                      stroke="var(--color-border-strong)"
                      stroke-width="2"
                      stroke-dasharray="7 7"
                      marker-end="url(#workflow-arrow)"
                    />
                  </Show>
                )
              }}
            </For>
            <For each={props.snapshot.edges}>
              {(edge) => {
                const from = createMemo(() => graph().nodes.find((item) => item.node.id === edge.from_node_id))
                const to = createMemo(() => graph().nodes.find((item) => item.node.id === edge.to_node_id))
                return (
                  <Show when={from() && to()}>
                    <>
                      <path
                        d={`M ${from()!.x + 188} ${from()!.y + 42} C ${from()!.x + 220} ${from()!.y + 42}, ${to()!.x - 24} ${to()!.y + 42}, ${to()!.x} ${to()!.y + 42}`}
                        fill="none"
                        stroke="var(--color-border-strong)"
                        stroke-width="2"
                        opacity="0.8"
                        stroke-dasharray={edge.label ? "0" : "6 6"}
                        marker-end="url(#workflow-arrow)"
                      />
                      <Show when={edge.label}>
                        <text
                          x={(from()!.x + to()!.x + 188) / 2}
                          y={to()!.y + 24}
                          text-anchor="middle"
                          fill="currentColor"
                          class="fill-text-weak text-[10px]"
                        >
                          {edge.label}
                        </text>
                      </Show>
                    </>
                  </Show>
                )
              }}
            </For>
          </svg>

          <For each={checkpointPins()}>
            {(pin) => (
              <div
                class="absolute z-10 rounded-full border bg-background-base px-2 py-1 text-[10px] font-medium shadow-xs"
                classList={{
                  "border-emerald-500/30 text-emerald-700 dark:text-emerald-300": checkpointTone(pin.checkpoint.status) === "success",
                  "border-red-500/30 text-red-700 dark:text-red-300": checkpointTone(pin.checkpoint.status) === "error",
                  "border-zinc-500/30 text-zinc-700 dark:text-zinc-300": checkpointTone(pin.checkpoint.status) === "neutral",
                  "border-amber-500/30 text-amber-700 dark:text-amber-300": checkpointTone(pin.checkpoint.status) === "warning",
                }}
                style={{ left: `${pin.x}px`, top: `${pin.y}px`, "max-width": "160px" }}
              >
                {`${pin.checkpoint.label} · ${pin.checkpoint.status}`}
              </div>
            )}
          </For>

          <For each={graph().nodes}>
            {(item) => {
              const active = () => item.node.session_id === props.currentSessionID
              const checkpoints = createMemo(() => checkpointMap().get(item.node.id) ?? [])
              return (
                <button
                  class="absolute w-[188px] rounded-[18px] border px-3 py-3 text-left shadow-xs transition-all"
                  classList={{
                    "border-sky-500/50 bg-background-base ring-2 ring-sky-500/20": active(),
                    "border-emerald-500/30 bg-background-base": item.node.status === "completed" && !active(),
                    "border-sky-500/30 bg-background-base shadow-[0_0_0_1px_rgba(14,165,233,0.08)]": (item.node.status === "running" || item.node.status === "waiting") && !active(),
                    "border-border-weak-base bg-background-base/95 hover:border-border-strong": !active(),
                  }}
                  style={{ left: `${item.x}px`, top: `${item.y}px` }}
                  onClick={() => item.node.session_id && props.onSelectSession(item.node.session_id)}
                >
                  <div class="flex items-start justify-between gap-2">
                    <div class="min-w-0">
                      <div class="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.08em] text-text-weak">
                        <span class={`size-2 rounded-full ${statusDot(item.node.status)}`} />
                        subagent
                      </div>
                      <div class="truncate text-13-medium text-text-strong">{item.node.title}</div>
                      <div class="mt-1 truncate text-12-regular text-text-weak">{item.node.agent}</div>
                      <div class="mt-1 truncate text-[10px] text-text-weak">{modelLabel(item.node)}</div>
                    </div>
                    <Badge tone={statusTone(item.node.status)}>{item.node.status}</Badge>
                  </div>

                  <div class="mt-3 grid grid-cols-2 gap-2 text-[10px] text-text-weak">
                    <div>attempt {item.node.attempt}/{item.node.max_attempts}</div>
                    <div>action {item.node.action_count}/{item.node.max_actions}</div>
                    <div class="truncate">result {item.node.result_status}</div>
                    <div class="truncate">{item.node.session_id ? "session linked" : "no session"}</div>
                  </div>

                  <Show when={item.node.fail_reason}>
                    <div class="mt-3 line-clamp-2 text-11-regular text-danger-base">{item.node.fail_reason}</div>
                  </Show>

                  <Show when={checkpoints().length > 0}>
                    <div class="mt-3 flex flex-wrap gap-1">
                      <For each={checkpoints()}>
                        {(checkpoint) => (
                          <span class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                            classList={{
                              "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300": checkpointTone(checkpoint.status) === "success",
                              "bg-red-500/12 text-red-700 dark:text-red-300": checkpointTone(checkpoint.status) === "error",
                              "bg-zinc-500/12 text-zinc-700 dark:text-zinc-300": checkpointTone(checkpoint.status) === "neutral",
                              "bg-amber-500/12 text-amber-700 dark:text-amber-300": checkpointTone(checkpoint.status) === "warning",
                            }}
                          >
                            {checkpoint.label}: {checkpoint.status}
                          </span>
                        )}
                      </For>
                    </div>
                  </Show>
                </button>
              )
            }}
          </For>
        </div>
      </div>

      <div class="border-t border-border-weak-base px-4 py-3">
        <div class="flex items-center justify-between gap-2">
          <div class="text-12-medium text-text-strong">
            {focusedNodeID() ? `${selectedNode()?.title ?? "Current node"} events` : "Runtime events"}
          </div>
          <div class="text-11-regular text-text-weak">current execution node only</div>
        </div>
        <div class="mt-2 grid gap-2 md:grid-cols-2">
          <For each={focusedEvents()}>
            {(event) => (
              <div class="rounded-xl border border-border-weak-base bg-background-base px-3 py-2">
                <div class="flex items-center justify-between gap-2">
                  <div class="truncate text-12-medium text-text-strong">{event.kind}</div>
                  <div class="text-11-regular text-text-weak">{event.source}</div>
                </div>
                <div class="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-text-weak">
                  <Show when={event.node_id}>
                    <span class="rounded-full border border-border-weak-base px-2 py-0.5">
                      {eventNodes().get(event.node_id!) ?? event.node_id}
                    </span>
                  </Show>
                  <Show when={event.target_node_id}>
                    <span class="rounded-full border border-border-weak-base px-2 py-0.5">
                      target {eventNodes().get(event.target_node_id!) ?? event.target_node_id}
                    </span>
                  </Show>
                </div>
                <div class="mt-2 text-11-regular text-text-weak">{eventSummary(event)}</div>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  )
}
