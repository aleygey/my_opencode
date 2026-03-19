import type { FileDiff } from "@opencode-ai/sdk/v2/client"
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
  current_node_id?: string
  selected_node_id?: string
  version: number
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

type LayoutGraph = {
  nodes: LayoutNode[]
  width: number
  height: number
  rootW: number
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

const nodeTone = (status: string) => {
  if (status === "completed") return "success"
  if (status === "failed" || status === "cancelled") return "error"
  if (status === "running" || status === "waiting") return "info"
  return "neutral"
}

const terminal = (status: string) => ["completed", "failed", "cancelled"].includes(status)

const statusDot = (status: string) => {
  if (status === "completed") return "bg-emerald-500"
  if (status === "failed" || status === "cancelled") return "bg-red-500"
  if (status === "interrupted" || status === "paused") return "bg-amber-500"
  if (status === "running" || status === "waiting") return "bg-sky-500 animate-pulse"
  return "bg-zinc-400"
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
  if (status === "completed") return "bg-emerald-500/10 text-emerald-700"
  if (status === "failed" || status === "cancelled") return "bg-red-500/10 text-red-700"
  if (status === "running" || status === "waiting") return "bg-sky-500/10 text-sky-700"
  return "bg-slate-100 text-slate-600"
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
  const cardW = 264
  const cardH = 148
  const rootW = 220
  const orchestrator_x = 40
  const orchestrator_y = 96
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
        x: 360 + value * 316,
        y: 96 + row * 188,
      })
    }
  }

  const items = [...placed.values()]
  const width = Math.max(...items.map((item) => item.x), 0) + cardW + 72
  const height = Math.max(...items.map((item) => item.y), 0) + cardH + 96
  return {
    nodes: items,
    width,
    height,
    rootW,
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

  createEffect(() => {
    const snapshot = workflow()
    if (!snapshot) return
    const fast = terminal(snapshot.workflow.status) ? 8000 : 2500
    const timer = setInterval(() => {
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
    <div class="border-b border-border-weak-base bg-background-stronger px-3 py-2 overflow-x-auto">
      <div class="flex items-center gap-1.5 min-w-max">
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
                class="inline-flex h-8 min-w-0 items-center gap-2 rounded-full border px-3 text-left transition-all"
                classList={{
                  "border-sky-500/45 bg-sky-500/8 shadow-xs": active(),
                  "border-border-weak-base bg-background-base hover:border-border-strong":
                    !active() && (!!card.sessionID || card.type === "graph"),
                  "border-border-weak-base bg-background-panel/70 opacity-80": !active() && !card.sessionID,
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
                  class={`size-2 shrink-0 rounded-full ${card.type === "graph" || card.type === "root" ? "bg-sky-500" : statusDot(card.status)}`}
                />
                <span class="rounded-full border border-border-weak-base px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-text-weak">
                  {card.note}
                </span>
                <span class="max-w-40 truncate text-12-medium text-text-strong">{session()?.title ?? card.title}</span>
                <span class="truncate text-[11px] text-text-weak">{card.subtitle}</span>
                <Show when={!card.sessionID}>
                  <span class="rounded-full bg-amber-500/12 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                    no session
                  </span>
                </Show>
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
  const [store, setStore] = createStore({
    node: undefined as string | undefined,
    folded: false,
  })
  const graph = createMemo(() => layout(props.snapshot))
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
  const rootPath = (target: LayoutNode) =>
    `M ${graph().orchestrator_x + graph().rootW} ${graph().orchestrator_y + 70} C ${graph().orchestrator_x + graph().rootW + 48} ${graph().orchestrator_y + 70}, ${target.x - 48} ${target.y + 70}, ${target.x} ${target.y + 70}`
  const edgePath = (from: LayoutNode, to: LayoutNode) =>
    `M ${from.x + 264} ${from.y + 70} C ${from.x + 312} ${from.y + 70}, ${to.x - 48} ${to.y + 70}, ${to.x} ${to.y + 70}`
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
  const checkpointPins = createMemo(() =>
    props.snapshot.checkpoints
      .map((checkpoint) => {
        const target = graph().nodes.find((item) => item.node.id === checkpoint.node_id)
        if (!target) return
        return {
          checkpoint,
          x: target.x + 18,
          y: target.y - 16,
        }
      })
      .filter(Boolean) as Array<{ checkpoint: WorkflowCheckpoint; x: number; y: number }>,
  )
  const total = createMemo(() => props.snapshot.nodes.length)
  const done = createMemo(() => props.snapshot.nodes.filter((node) => node.status === "completed").length)
  const failed = createMemo(() => props.snapshot.nodes.filter((node) => node.status === "failed").length)
  const waiting = createMemo(() => props.snapshot.nodes.filter((node) => node.status === "waiting").length)
  const finished = createMemo(() => terminal(props.snapshot.workflow.status))
  createEffect(() => {
    if (!finished()) return
    if (store.folded) return
    setStore("folded", true)
  })

  return (
    <div class="flex h-full min-h-0 flex-col bg-[#f6f7fb]">
      <div class="border-b border-border-weak-base bg-background-base px-4 py-3">
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="truncate text-15-medium text-text-strong">{props.snapshot.workflow.title}</div>
          </div>
          <div class="flex items-center gap-2">
            <Badge tone={statusTone(props.snapshot.workflow.status)}>{props.snapshot.workflow.status}</Badge>
            <Show when={currentNode()}>
              <Badge tone="info">{currentNode()!.title}</Badge>
            </Show>
          </div>
        </div>
      </div>

      <div class="flex min-h-0 flex-1 gap-4 p-4">
        <div class="min-w-0 flex-1 overflow-auto rounded-2xl border border-slate-200 bg-[#f4f6f8] p-4">
          <Show
            when={!store.folded}
            fallback={
              <div class="flex h-full min-h-[320px] items-start justify-center">
                <div class="w-full max-w-[720px] rounded-2xl border border-slate-200 bg-white p-5">
                  <div class="flex items-center justify-between gap-3">
                    <div>
                      <div class="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-weak">plan</div>
                      <div class="mt-1 text-15-medium text-text-strong">{props.snapshot.workflow.title}</div>
                    </div>
                    <Badge tone={statusTone(props.snapshot.workflow.status)}>{props.snapshot.workflow.status}</Badge>
                  </div>
                  <div class="mt-4 grid grid-cols-4 gap-3 text-11-regular text-text-weak">
                    <div class="rounded-xl border border-slate-200 bg-[#fafbfc] px-3 py-2">
                      <div class="text-[10px] uppercase tracking-[0.08em]">nodes</div>
                      <div class="mt-1 text-text-strong">{total()}</div>
                    </div>
                    <div class="rounded-xl border border-slate-200 bg-[#fafbfc] px-3 py-2">
                      <div class="text-[10px] uppercase tracking-[0.08em]">done</div>
                      <div class="mt-1 text-text-strong">{done()}</div>
                    </div>
                    <div class="rounded-xl border border-slate-200 bg-[#fafbfc] px-3 py-2">
                      <div class="text-[10px] uppercase tracking-[0.08em]">failed</div>
                      <div class="mt-1 text-text-strong">{failed()}</div>
                    </div>
                    <div class="rounded-xl border border-slate-200 bg-[#fafbfc] px-3 py-2">
                      <div class="text-[10px] uppercase tracking-[0.08em]">waiting</div>
                      <div class="mt-1 text-text-strong">{waiting()}</div>
                    </div>
                  </div>
                  <div class="mt-4 flex items-center justify-between gap-3">
                    <div class="text-11-regular text-text-weak">
                      The workflow is finished. Node sessions are hidden from the strip by default; open details only if you need history.
                    </div>
                    <button
                      class="rounded-xl border border-slate-200 bg-[#fafbfc] px-3 py-2 text-12-medium text-text-strong transition-colors hover:border-slate-300"
                      onClick={() => setStore("folded", false)}
                    >
                      Show graph
                    </button>
                  </div>
                </div>
              </div>
            }
          >
            <div
              class="relative min-w-max rounded-[20px]"
              style={{
                width: `${graph().width}px`,
                height: `${graph().height}px`,
                "background-image":
                  "linear-gradient(rgba(148,163,184,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.08) 1px, transparent 1px)",
                "background-size": "28px 28px",
              }}
            >
            <button
              class="absolute w-[220px] rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left"
              style={{ left: `${graph().orchestrator_x}px`, top: `${graph().orchestrator_y}px` }}
            >
              <div class="flex items-center gap-3">
                <div class="flex size-9 items-center justify-center rounded-xl bg-slate-900 text-xs font-semibold text-white">O</div>
                <div class="min-w-0 flex-1">
                  <div class="truncate text-13-medium text-text-strong">Orchestrator</div>
                  <div class="mt-1 text-[10px] text-text-weak">plan · supervise · control</div>
                </div>
                <span class={`size-2 shrink-0 rounded-full ${statusDot(props.snapshot.workflow.status)}`} />
              </div>
            </button>

            <svg class="absolute inset-0 size-full" viewBox={`0 0 ${graph().width} ${graph().height}`}>
            <defs>
              <marker id={`workflow-arrow-${props.snapshot.workflow.id}`} markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#2563eb" />
              </marker>
            </defs>
            <For each={roots()}>
              {(node) => {
                const target = createMemo(() => graph().nodes.find((item) => item.node.id === node.id))
                const path = createMemo(() => (target() ? rootPath(target()!) : ""))
                const active = createMemo(() => activeRootIDs().has(node.id))
                return (
                  <Show when={target()}>
                    <>
                      <path
                        d={path()}
                        fill="none"
                        stroke={active() ? "#2563eb" : "#cbd5e1"}
                        stroke-width={active() ? "2.5" : "1.5"}
                        marker-end={`url(#workflow-arrow-${props.snapshot.workflow.id})`}
                      />
                      <Show when={active()}>
                        <circle r="4" fill="#2563eb">
                          <animateMotion dur="2s" repeatCount="indefinite" path={path()} />
                        </circle>
                      </Show>
                    </>
                  </Show>
                )
              }}
            </For>
            <For each={props.snapshot.edges}>
              {(edge) => {
                const from = createMemo(() => graph().nodes.find((item) => item.node.id === edge.from_node_id))
                const to = createMemo(() => graph().nodes.find((item) => item.node.id === edge.to_node_id))
                const path = createMemo(() => (from() && to() ? edgePath(from()!, to()!) : ""))
                const active = createMemo(() => activeEdgeIDs().has(edge.id))
                const done = createMemo(() => doneEdgeIDs().has(edge.id))
                return (
                  <Show when={from() && to()}>
                    <>
                      <path
                        d={path()}
                        fill="none"
                        stroke={active() || done() ? "#2563eb" : "#cbd5e1"}
                        stroke-width={active() ? "2.5" : done() ? "2" : "1.5"}
                        opacity={active() ? "1" : done() ? "0.78" : "0.92"}
                        marker-end={`url(#workflow-arrow-${props.snapshot.workflow.id})`}
                      />
                      <Show when={active()}>
                        <circle r="4" fill="#2563eb">
                          <animateMotion dur="2s" repeatCount="indefinite" path={path()} />
                        </circle>
                      </Show>
                      <Show when={edge.label}>
                        <text
                          x={(from()!.x + to()!.x + 264) / 2}
                          y={to()!.y + 32}
                          text-anchor="middle"
                          fill="currentColor"
                          class="fill-slate-400 text-[10px]"
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
                  class="absolute z-10 rounded-full border bg-white px-2 py-0.5 text-[10px] font-medium"
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
                const selected = () => focusedNodeID() === item.node.id
                const current = () => currentNode()?.id === item.node.id
                return (
                  <button
                    class={`absolute w-[264px] rounded-2xl border px-4 py-3 text-left transition-all ${nodeBorder(item.node.status, selected())} ${nodeBg(item.node.status, selected())}`}
                    style={{ left: `${item.x}px`, top: `${item.y}px` }}
                    onClick={() => setStore("node", item.node.id)}
                  >
                    <Show when={current() && (item.node.status === "running" || item.node.status === "waiting")}>
                      <span class="absolute inset-[-6px] rounded-[22px] border border-sky-500/20 animate-pulse" />
                    </Show>
                    <div class="flex items-center gap-3">
                      <div class={`relative flex size-9 items-center justify-center rounded-xl text-xs font-semibold ${nodeIcon(item.node.status)}`}>
                        <span class="relative">{item.node.agent.slice(0, 1).toUpperCase()}</span>
                      </div>
                      <div class="min-w-0 flex-1">
                        <div class="truncate text-13-medium text-text-strong">{item.node.title}</div>
                        <div class="mt-1 flex items-center gap-2 text-[10px] text-text-weak">
                          <span>{item.node.agent}</span>
                          <span>•</span>
                          <span>{item.node.status}</span>
                          <Show when={item.node.session_id}>
                            <>
                              <span>•</span>
                              <span>session</span>
                            </>
                          </Show>
                        </div>
                      </div>
                      <div class="flex flex-col items-end gap-2">
                        <span class={`size-2 shrink-0 rounded-full ${statusDot(item.node.status)}`} />
                        <Show when={item.node.result_status !== "unknown"}>
                          <span
                            class="rounded-full px-1.5 py-0.5 text-[9px] font-medium"
                            classList={{
                              "bg-emerald-500/10 text-emerald-700": nodeTone(item.node.result_status) === "success",
                              "bg-red-500/10 text-red-700": nodeTone(item.node.result_status) === "error",
                              "bg-sky-500/10 text-sky-700": nodeTone(item.node.result_status) === "info",
                              "bg-slate-200 text-slate-600": nodeTone(item.node.result_status) === "neutral",
                            }}
                          >
                            {item.node.result_status}
                          </span>
                        </Show>
                      </div>
                    </div>
                  </button>
                )
              }}
            </For>
            </div>
          </Show>
        </div>

        <div class="flex w-[340px] shrink-0 flex-col gap-4">
          <div class="rounded-2xl border border-slate-200 bg-white p-4">
            <div class="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-weak">selected node</div>
            <Show
              when={selectedNode()}
              fallback={
                <div class="mt-3 text-12-regular text-text-weak">Select a node in the graph to inspect its runtime state.</div>
              }
            >
              <div class="mt-3 flex items-center gap-3">
                <div class={`flex size-10 items-center justify-center rounded-xl text-sm font-semibold ${nodeIcon(selectedNode()!.status)}`}>
                  {selectedNode()!.agent.slice(0, 1).toUpperCase()}
                </div>
                <div class="min-w-0 flex-1">
                  <div class="truncate text-14-medium text-text-strong">{selectedNode()!.title}</div>
                  <div class="mt-1 text-11-regular text-text-weak">{selectedNode()!.agent}</div>
                </div>
                <Badge tone={statusTone(selectedNode()!.status)}>{selectedNode()!.status}</Badge>
              </div>
              <div class="mt-4 grid grid-cols-2 gap-2 text-11-regular text-text-weak">
                <div class="rounded-xl border border-border-weak-base bg-background-panel px-3 py-2">
                  <div class="text-[10px] uppercase tracking-[0.08em]">result</div>
                  <div class="mt-1 text-text-strong">{selectedNode()!.result_status}</div>
                </div>
                <div class="rounded-xl border border-border-weak-base bg-background-panel px-3 py-2">
                  <div class="text-[10px] uppercase tracking-[0.08em]">model</div>
                  <div class="mt-1 truncate text-text-strong">{modelLabel(selectedNode()!)}</div>
                </div>
                <div class="rounded-xl border border-border-weak-base bg-background-panel px-3 py-2">
                  <div class="text-[10px] uppercase tracking-[0.08em]">attempt</div>
                  <div class="mt-1 text-text-strong">{`${selectedNode()!.attempt}/${selectedNode()!.max_attempts}`}</div>
                </div>
                <div class="rounded-xl border border-border-weak-base bg-background-panel px-3 py-2">
                  <div class="text-[10px] uppercase tracking-[0.08em]">actions</div>
                  <div class="mt-1 text-text-strong">{`${selectedNode()!.action_count}/${selectedNode()!.max_actions}`}</div>
                </div>
                <div class="rounded-xl border border-border-weak-base bg-background-panel px-3 py-2">
                  <div class="text-[10px] uppercase tracking-[0.08em]">session</div>
                  <div class="mt-1 truncate text-text-strong">{selectedNode()!.session_id ?? "not started"}</div>
                </div>
                <div class="rounded-xl border border-border-weak-base bg-background-panel px-3 py-2">
                  <div class="text-[10px] uppercase tracking-[0.08em]">pending commands</div>
                  <div class="mt-1 text-text-strong">{pending()}</div>
                </div>
              </div>
              <Show when={selectedNode()!.fail_reason}>
                <div class="mt-3 rounded-xl border border-red-500/20 bg-red-500/6 px-3 py-2 text-11-regular text-red-700 dark:text-red-300">
                  {selectedNode()!.fail_reason}
                </div>
              </Show>
              <div class="mt-4 space-y-3 text-11-regular text-text-weak">
                <div>
                  <div class="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-weak">communication</div>
                  <div class="mt-2 grid gap-2">
                    <div class="rounded-xl border border-border-weak-base bg-background-panel px-3 py-2">
                      <div class="text-[10px] uppercase tracking-[0.08em]">last control</div>
                      <div class="mt-1 text-text-strong">{lastControl()?.payload.command ? String(lastControl()!.payload.command) : "none"}</div>
                    </div>
                    <div class="rounded-xl border border-border-weak-base bg-background-panel px-3 py-2">
                      <div class="text-[10px] uppercase tracking-[0.08em]">last pull</div>
                      <div class="mt-1 text-text-strong">{lastPull() ? `event #${lastPull()!.id}` : "none"}</div>
                    </div>
                    <div class="rounded-xl border border-border-weak-base bg-background-panel px-3 py-2">
                      <div class="text-[10px] uppercase tracking-[0.08em]">last update</div>
                      <div class="mt-1 text-text-strong">{lastUpdate() ? `event #${lastUpdate()!.id}` : "none"}</div>
                    </div>
                  </div>
                </div>
                <Show when={selectedNode()!.state_json}>
                  <div>
                    <div class="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-weak">state_json</div>
                    <pre class="mt-2 overflow-auto rounded-xl border border-border-weak-base bg-background-panel p-3 text-[10px] leading-5 text-text-weak">{short(selectedNode()!.state_json)}</pre>
                  </div>
                </Show>
                <Show when={selectedNode()!.result_json}>
                  <div>
                    <div class="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-weak">result_json</div>
                    <pre class="mt-2 overflow-auto rounded-xl border border-border-weak-base bg-background-panel p-3 text-[10px] leading-5 text-text-weak">{short(selectedNode()!.result_json)}</pre>
                  </div>
                </Show>
              </div>
              <Show when={focusedCheckpoints().length > 0}>
                <div class="mt-3 flex flex-wrap gap-1.5">
                  <For each={focusedCheckpoints()}>
                    {(checkpoint) => (
                      <span
                        class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                        classList={{
                          "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300": checkpointTone(checkpoint.status) === "success",
                          "bg-red-500/12 text-red-700 dark:text-red-300": checkpointTone(checkpoint.status) === "error",
                          "bg-zinc-500/12 text-zinc-700 dark:text-zinc-300": checkpointTone(checkpoint.status) === "neutral",
                          "bg-amber-500/12 text-amber-700 dark:text-amber-300": checkpointTone(checkpoint.status) === "warning",
                        }}
                      >
                        {checkpoint.label}
                      </span>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={selectedNode()!.session_id}>
                <button
                  class="mt-4 w-full rounded-xl border border-border-weak-base bg-background-panel px-3 py-2 text-12-medium text-text-strong transition-colors hover:border-border-strong"
                  onClick={() => props.onSelectSession(selectedNode()!.session_id!)}
                >
                  Open subagent session
                </button>
              </Show>
            </Show>
          </div>
          <div class="rounded-2xl border border-slate-200 bg-white p-4">
            <div class="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-weak">runtime</div>
            <div class="mt-3 grid gap-2 text-11-regular text-text-weak">
              <div class="rounded-xl border border-border-weak-base bg-background-panel px-3 py-2">
                <div class="text-[10px] uppercase tracking-[0.08em]">phase</div>
                <div class="mt-1 text-text-strong">{props.snapshot.runtime.phase}</div>
              </div>
              <div class="rounded-xl border border-border-weak-base bg-background-panel px-3 py-2">
                <div class="text-[10px] uppercase tracking-[0.08em]">active node</div>
                <div class="mt-1 text-text-strong">{eventNodes().get(props.snapshot.runtime.active_node_id ?? "") ?? props.snapshot.runtime.active_node_id ?? "none"}</div>
              </div>
              <div class="grid grid-cols-3 gap-2">
                <div class="rounded-xl border border-border-weak-base bg-background-panel px-3 py-2">
                  <div class="text-[10px] uppercase tracking-[0.08em]">commands</div>
                  <div class="mt-1 text-text-strong">{props.snapshot.runtime.command_count}</div>
                </div>
                <div class="rounded-xl border border-border-weak-base bg-background-panel px-3 py-2">
                  <div class="text-[10px] uppercase tracking-[0.08em]">pulls</div>
                  <div class="mt-1 text-text-strong">{props.snapshot.runtime.pull_count}</div>
                </div>
                <div class="rounded-xl border border-border-weak-base bg-background-panel px-3 py-2">
                  <div class="text-[10px] uppercase tracking-[0.08em]">updates</div>
                  <div class="mt-1 text-text-strong">{props.snapshot.runtime.update_count}</div>
                </div>
              </div>
              <Show when={lastEvent()}>
                <div class="rounded-xl border border-border-weak-base bg-background-panel px-3 py-2">
                  <div class="text-[10px] uppercase tracking-[0.08em]">latest event</div>
                  <div class="mt-1 text-text-strong">{lastEvent()!.kind}</div>
                </div>
              </Show>
              <Show when={finished()}>
                <button
                  class="rounded-xl border border-slate-200 bg-[#fafbfc] px-3 py-2 text-left text-12-medium text-text-strong transition-colors hover:border-slate-300"
                  onClick={() => setStore("folded", (value) => !value)}
                >
                  {store.folded ? "Expand graph" : "Collapse to plan card"}
                </button>
              </Show>
            </div>
          </div>
        </div>
      </div>

      <div class="border-t border-slate-200 bg-white px-4 py-3">
        <div class="flex items-center justify-between gap-2">
          <div class="text-12-medium text-text-strong">{selectedNode()?.title ?? "runtime"} logs</div>
          <div class="text-11-regular text-text-weak">latest execution events</div>
        </div>
        <div class="mt-3 grid max-h-40 gap-2 overflow-auto">
          <For each={focusedEvents()}>
            {(event) => (
              <div class="rounded-xl border border-slate-200 bg-[#fafbfc] px-3 py-2">
                <div class="flex items-center justify-between gap-3">
                  <div class="truncate text-11-medium text-text-strong">{event.kind}</div>
                  <div class="text-[10px] text-text-weak">{event.source}</div>
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
