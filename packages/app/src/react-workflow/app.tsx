/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react"
import type { SnapshotFileDiff as FileDiff } from "@opencode-ai/sdk/v2/client"
import { TopBar } from "./components/top-bar"
import { WorkflowCanvas } from "./components/workflow-canvas"
import { EnhancedInspectorPanel } from "./components/enhanced-inspector-panel"
import { ChatPanel } from "./components/chat-panel"
import type { Msg as ChatMsg } from "./components/chat-panel"
import type { SlashCommand } from "./commands"
import type { Task } from "./components/task-sidebar"
import { NodeSessionView } from "./components/node-session-view"
import { EventsPanel } from "./components/events-panel"
import {
  SandTableSessionView,
  type SandTableDiscussion,
} from "./components/sand-table-session-view"
import { SplitBar, useSplit } from "./components/split"
import type { WorkflowPlan } from "./components/plan-card"
import { PlanOverlay } from "./components/plan-overlay"
import { GraphEditsDrawer } from "./components/graph-edits-drawer"
import type { SandTableResult } from "./components/sand-table-card"
import { ChevronUp } from "lucide-react"
import { initPlugins } from "./plugins"
import { WorkflowRuntimeProvider, type WorkflowRuntime } from "./runtime-context"
import "./styles/theme.css"

// Register the built-in middle-column plugins once at module load. This is a
// small, idempotent side effect (the registry clears itself first); keeping
// it next to the component tree means `react-workflow` is self-bootstrapping
// and callers don't need to remember to wire it up.
initPlugins()

type State = "running" | "completed" | "failed" | "idle"
type Role = "system" | "assistant" | "user" | "tool"
type Kind = "coding" | "build-flash" | "debug" | "deploy" | "plan" | "explore"
export type Status = "pending" | "running" | "completed" | "failed" | "paused"

export type Node = {
  id: string
  title: string
  type: Kind
  status: Status
  /** Backing session id once the node has started executing. Undefined
   *  before first execution — chat lookups must NOT fall back to the
   *  root session for unstarted nodes (would leak orchestrator chat). */
  session?: string
  /** Live slave-agent status — most recent reasoning / tool / event line
   *  for this node. Renders as a marquee at the bottom of running cards. */
  liveStatus?: string
  summary?: string[]
  /**
   * True when this node started against an older graph_rev than the current
   * workflow.graph_rev — surfaced as a "stale" badge so users notice that a
   * downstream edit may have invalidated its inputs.
   */
  stale?: boolean
}

export type Chain = {
  id: string
  label: string
  color?: string
  nodes: Node[]
}

export type Detail = {
  id: string
  title: string
  type: string
  status: string
  result: string
  model: string
  attempt: string
  actions: string
  duration?: string
  sessionId: string
  pendingCommands: number
  lastControl: string
  lastPull: string
  lastUpdate: string
  stateJson: Record<string, unknown>
  codeChanges?: FileDiff[]
  executionLog?: string[]
  /** Plan-node only: the two sub-agent models contributing to a sand_table
   * discussion. Surfaced in the Inspector so users can see which model
   * drafted the plan and which one critiqued it without drilling into the
   * full Plan view. */
  plannerModel?: string
  evaluatorModel?: string
}

type Agent = {
  name: string
  model: string
  role: string
  nodeIDs?: string[]
}

type Flow = {
  goal: string
  phase: string
  overallStatus: State
}

// Reuse the ChatPanel Msg shape so all callers share a single structural type.
type Msg = ChatMsg

export type TokenStats = {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  contextLength?: number
}

export type WorkflowAppProps = {
  root: string
  title: string
  status: State
  env: string
  /** Design-spec body sub-tab — Canvas / Chat / Events fixed tabs OR
   *  dynamic node / sand-table tabs in `node:<id>` / `sand:<id>` form.
   *  Default canvas. */
  view?: string
  /** Workflow event timeline (Events tab). Pre-projected for ergonomic
   *  rendering — kind/source for icon, time for timestamp column,
   *  summary for message text, and node link if applicable. */
  workflowEvents?: Array<{
    id: string | number
    kind: string
    source: string
    nodeID?: string
    nodeTitle?: string
    summary: string
    time: number
  }>
  pick?: string
  model?: string
  models?: string[]
  /** Root-session agent name. When provided, the chat panel header
   * renders a picker so the user can route the master session to a
   * different primary agent (e.g. `build` for a quick one-off task
   * instead of the full `orchestrator` planning loop). */
  rootAgent?: string
  /** Candidate root-session agents — typically all non-subagent,
   * non-hidden agents advertised by the backend. */
  rootAgents?: string[]
  /** Called when the user picks a different root-session agent. */
  onRootAgentChange?: (agent: string) => void
  workspace?: string
  nodes: Node[]
  chains?: Chain[]
  /** Optional merge-tail node — a single node downstream of multiple lanes
   * that the canvas should render *after* the lanes with a converging
   * connector (mirror of the top fan-out `BranchConnector`). When the
   * graph has no fan-in (or only a single lane), this is undefined and
   * the canvas falls back to plain lane rendering. */
  chainTail?: Node
  tasks?: Task[]
  activeTaskId?: string
  details: Record<string, Detail>
  flow: Flow
  agents: Agent[]
  chats: Record<string, Msg[]>
  tokenStats?: TokenStats
  sandTables?: Record<string, SandTableDiscussion | undefined>
  onSession: (node?: string) => void
  onRefiner?: (node?: string) => void
  onRetrieve?: (node?: string) => void
  onTaskSelect?: (task: string) => void
  onModel: (nodeIDs?: string[]) => void
  onModelChange?: (model: string) => void
  onWorkspaceClick?: () => void
  onNewTask?: () => void
  onDeleteTask?: (taskId: string) => void
  onRun: (node?: string) => void
  onRestart: (node?: string) => void
  onStop: (node?: string) => void
  onPause: (node?: string) => void
  /** Interrupt ONLY the master (orchestrator) session — leaves child
   * node executions alone. Wired to the chat-panel send→stop button so
   * the user can cancel a reply mid-thought without nuking the whole
   * workflow. The top-bar Abort remains the "kill everything" path. */
  onStopMaster?: () => void
  onSend: (text: string, node?: string) => void
  // Slash command callbacks
  onNewSession?: () => void
  onModelPickerOpen?: () => void
  /** Server-side custom slash commands (from `sync.data.command`). When
   * provided, these are merged into the chat-panel command palette
   * alongside the built-ins (`/undo`, `/redo`, `/compact`, `/fork`,
   * `/new`, `/model`). Without this wiring the user cannot discover
   * project-defined commands like `/tmp`, `/notrack`, etc. — and even
   * if they type the trigger by hand, the autocomplete won't match.
   * The actual dispatch (when `action: "send"`) flows through
   * `onSendMessage` / `onSend` which then routes to
   * `client.session.command(...)` in `workflow-panel.tsx#send`. */
  chatExtraCommands?: SlashCommand[]
  // Plan card callbacks
  onPlanRun?: (plan: WorkflowPlan) => void
  onPlanEdit?: (context: string) => void
  // Question/Permission callbacks
  onQuestionReply?: (requestID: string, answers: string[][]) => void
  onQuestionReject?: (requestID: string) => void
  onPermissionReply?: (requestID: string, reply: "once" | "always" | "reject", message?: string) => void
  onSandTableSend?: (nodeID: string, text: string) => void
  /* Confirms a sand_table discussion that is parked in
   * `awaiting_start` (set when `experimental.sand_table.confirm_before_start`
   * is enabled). Parent posts `POST /workflow/sand_table/:id/start` with
   * the user-chosen agent / model overrides; backend resolves the
   * parked promise and the rounds begin. */
  onSandTableStart?: (
    nodeID: string,
    overrides: {
      planner_model?: { providerID: string; modelID: string }
      evaluator_model?: { providerID: string; modelID: string }
      planner_agent?: string
      evaluator_agent?: string
    },
  ) => void
  /** Master-session chat history pagination — the underlying sync store
   * only hydrates the first page of messages (80) on session mount. For
   * conversations longer than that, the ChatPanel "Load earlier messages"
   * button needs to trigger a server-side fetch; without this wiring the
   * button would run out of in-memory groups and appear to stop working,
   * leaving the earliest turns invisible. */
  historyHasMore?: boolean
  historyLoading?: boolean
  onLoadMoreHistory?: () => void
  /** P1 — current dynamic-graph revision counter. Bumped server-side on
   * every applied topology edit; surfaced in the TopBar as a small `rev #N`
   * chip so the user can spot in-flight schema churn at a glance. */
  graphRev?: number
  /** P3 — pending graph-edit transactions (proposed but not yet applied).
   * Rendered as an amber chip with the count + a click target the user can
   * use to apply / reject the queue. */
  pendingEdits?: WorkflowGraphEdit[]
  /** P5 — terminal status when the workflow has been finalised. Drives the
   * "finalized · status" chip in the TopBar; further graph writes are
   * server-side rejected. */
  finalizedStatus?: "completed" | "failed" | "cancelled"
  /** P3 — apply a single pending edit (runs the server-side reconciler). */
  onApplyEdit?: (editID: string) => void
  /** P3 — reject a pending edit with an audit reason. */
  onRejectEdit?: (editID: string, reason: string) => void
  /** P5 — finalise the workflow into a terminal state. */
  onFinalize?: (status: "completed" | "failed" | "cancelled", failReason?: string) => void
  /** Backend connection info for plugin components. The serial monitor (and
   *  any future plugin that talks to the running opencode HTTP server)
   *  reads this off React context — see `runtime-context.tsx`. The SolidJS
   *  workflow-panel passes the running server's URL + auth header here. */
  runtime?: WorkflowRuntime | null
}

/** P3 — slim FE projection of `Workflow.Edit` as seen by react-workflow.
 *  Mirrors the SolidJS `WorkflowEdit` shape but kept structurally lazy
 *  so a server-side schema tweak doesn't immediately break the panel. */
export type WorkflowGraphEdit = {
  id: string
  status: "pending" | "applied" | "rejected" | "superseded"
  ops: Array<{ kind: string } & Record<string, unknown>>
  reason?: string
  reject_reason?: string
  graph_rev_before: number
  graph_rev_after?: number
  proposer_session_id?: string
  time: { created: number; applied?: number }
}

export function WorkflowApp(props: WorkflowAppProps) {
  const [pick, setPick] = useState<string | null>(props.pick ?? props.nodes[0]?.id ?? null)
  const [sessionNode, setSessionNode] = useState<string | null>(null)
  /* Clear the inline `sessionNode` state whenever the substrip switches
   * to a fixed tab (canvas / chat / events). Without this, the inline
   * fallback overlay (set on node click as a backup) sticks around even
   * after the dynamic tab is closed via the substrip's × button — the
   * user couldn't return to the canvas without round-tripping via the
   * rail's "Workflow" module. */
  useEffect(() => {
    const v = props.view ?? 'canvas'
    if (v === 'canvas' || v === 'chat' || v === 'events') {
      setSessionNode(null)
    }
  }, [props.view])

  /* Aside (Inspector) collapse state — design template uses a single
   * toggle button instead of a draggable splitbar. Persists across
   * mount via localStorage so collapse choice survives navigation. */
  const ASIDE_KEY = 'wf-aside-open:v1'
  const [asideOpen, setAsideOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true
    try { return window.localStorage.getItem(ASIDE_KEY) !== '0' } catch { return true }
  })
  useEffect(() => {
    try { window.localStorage.setItem(ASIDE_KEY, asideOpen ? '1' : '0') } catch {}
  }, [asideOpen])

  /* Bridge for the unified shell header's Replay / Pause / Run buttons.
   * session.tsx publishes those buttons as part of the chrome and dispatches
   * `rune:wf:{run,pause,replay,search}` global events when clicked; we listen
   * here so we can call the corresponding workflow-runtime handlers without
   * cross-framework prop wiring. */
  useEffect(() => {
    const onRun = () => props.onRun(undefined)
    const onPause = () => props.onPause(undefined)
    const onReplay = () => props.onRestart(undefined)
    window.addEventListener("rune:wf:run", onRun as EventListener)
    window.addEventListener("rune:wf:pause", onPause as EventListener)
    window.addEventListener("rune:wf:replay", onReplay as EventListener)
    return () => {
      window.removeEventListener("rune:wf:run", onRun as EventListener)
      window.removeEventListener("rune:wf:pause", onPause as EventListener)
      window.removeEventListener("rune:wf:replay", onReplay as EventListener)
    }
  }, [props.onRun, props.onPause, props.onRestart])
  // P3 — graph-edit drawer visibility. Opens when the TopBar pending-edits
  // chip is clicked; renders the pending queue with apply/reject controls
  // and a finalise button when the workflow is still active.
  const [editsOpen, setEditsOpen] = useState(false)
  // ── Plan modal state ──
  // Plans live on chat messages (msg.plan). Instead of rendering them
  // inline in the chat stream, we surface them as a fullscreen overlay
  // the first time they arrive and keep a chip in the chat afterwards
  // so the user can re-open at any time. Keyed by message id.
  const [activePlanMsgId, setActivePlanMsgId] = useState<string | null>(null)
  const [minimizedPlans, setMinimizedPlans] = useState<Set<string>>(() => new Set())
  // Remember which plan ids we've already auto-opened so re-renders
  // don't keep popping the modal back up after the user minimized it.
  // We persist in localStorage so a hard refresh doesn't auto-pop the
  // same plan back in the user's face — prior builds used a React ref,
  // which was wiped on mount and retriggered the overlay every reload.
  const AUTO_OPEN_STORAGE_KEY = "wf-plan-auto-opened:v1"
  const autoOpenedPlans = useRef<Set<string>>(
    (() => {
      if (typeof window === "undefined") return new Set<string>()
      try {
        const raw = window.localStorage.getItem(AUTO_OPEN_STORAGE_KEY)
        if (!raw) return new Set<string>()
        const parsed = JSON.parse(raw)
        return new Set<string>(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [])
      } catch {
        return new Set<string>()
      }
    })(),
  )
  const markAutoOpened = (id: string) => {
    autoOpenedPlans.current.add(id)
    if (typeof window === "undefined") return
    try {
      window.localStorage.setItem(
        AUTO_OPEN_STORAGE_KEY,
        JSON.stringify(Array.from(autoOpenedPlans.current)),
      )
    } catch {
      // quota exceeded / privacy mode — ignore, worst case we re-open on refresh
    }
  }
  // Inspector width — design template uses a fixed `--aside-w: 340px`.
  // We keep the SplitBar drag for power users but anchor the default at
  // 340 so the chat tab gets the bulk of the horizontal real estate
  // (was 640 = inspector eats half the screen).
  const side = useSplit({ axis: "x", size: 340, min: 280, max: 720, dir: -1 })
  const chat = useSplit({ axis: "y", size: 520, min: 0, max: 700, dir: -1 })
  // ── Chat panel height modes ──
  // tall       full chat with long message list (idle / design mode)
  // short      compact chat, some history visible (manual toggle)
  // input-only running mode — history hidden; only input + monitor
  //            panel visible so the user can still inject context
  //            without the chat log crowding the canvas
  // hidden     fully collapsed (manual)
  const [chatHeight, setChatHeight] = useState<"tall" | "short" | "input-only" | "hidden">("tall")
  const prevChatSize = useRef(520)
  const handleSizeToggle = () => {
    setChatHeight((prev) => {
      if (prev === "tall") {
        prevChatSize.current = chat.size
        chat.setSize(220)
        return "short"
      }
      if (prev === "input-only") {
        // Going from input-only → tall restores full history; useful
        // when the user wants to scroll past chat while the workflow
        // is still running.
        chat.setSize(prevChatSize.current || 520)
        return "tall"
      }
      chat.setSize(prevChatSize.current || 520)
      return "tall"
    })
  }
  const handleHide = () => {
    prevChatSize.current = chat.size
    chat.setSize(0)
    setChatHeight("hidden")
  }
  const handleRestore = () => {
    chat.setSize(prevChatSize.current || 520)
    setChatHeight(prevChatSize.current > 300 ? "tall" : "short")
  }

  // Dynamic chat panel height: tall when idle, input-only when running
  // (previous behaviour was "short" which still showed some history —
  // that competed with the canvas for vertical space and made it hard
  // to keep the graph in view during execution).
  const isRunning = props.status === "running"
  const prevRunning = useRef(isRunning)
  const [chatAnimating, setChatAnimating] = useState(false)
  useEffect(() => {
    if (prevRunning.current === isRunning) return
    prevRunning.current = isRunning
    if (chatHeight === "hidden") return
    setChatAnimating(true)
    if (isRunning) {
      // Keep a record of the pre-run height so we can restore it
      // exactly when execution ends.
      prevChatSize.current = chat.size || prevChatSize.current || 520
      chat.setSize(188)
      setChatHeight("input-only")
    } else {
      chat.setSize(prevChatSize.current || 520)
      setChatHeight("tall")
    }
    const t = setTimeout(() => setChatAnimating(false), 500)
    return () => clearTimeout(t)
  }, [isRunning])

  const allNodes = useMemo(() => {
    if (props.chains && props.chains.length > 0) {
      return props.chains.flatMap((c) => c.nodes)
    }
    return props.nodes
  }, [props.chains, props.nodes])

  const nodeProgress = useMemo(() => {
    const done = allNodes.filter((n) => n.status === "completed").length
    return { done, total: allNodes.length }
  }, [allNodes])

  const canvasChains = useMemo(() => {
    if (props.chains && props.chains.length > 0) {
      return props.chains.map((c) => ({
        ...c,
        nodes: c.nodes.map((n) => ({
          ...n,
          progress:
            typeof props.details[n.id]?.stateJson?.progress === "number"
              ? (props.details[n.id].stateJson.progress as number)
              : undefined,
        })),
      }))
    }
    // Default: wrap flat nodes into a single chain
    return [
      {
        id: "default",
        label: "Main",
        nodes: props.nodes.map((n) => ({
          ...n,
          progress:
            typeof props.details[n.id]?.stateJson?.progress === "number"
              ? (props.details[n.id].stateJson.progress as number)
              : undefined,
        })),
      },
    ]
  }, [props.chains, props.nodes, props.details])

  useEffect(() => {
    const first = allNodes[0]?.id ?? null
    const next = props.pick ?? first
    setPick(next)
  }, [props.pick, allNodes])

  const node = useMemo(() => allNodes.find((item) => item.id === pick) ?? null, [pick, allNodes])
  const detail = useMemo(() => (pick ? (props.details[pick] ?? null) : null), [props.details, pick])
  const rows = props.chats[props.root] ?? []
  // True only when the ROOT (master) session is producing output right
  // now — i.e. it has a thinking or tool-call row still in-flight. We
  // deliberately don't fall back to `props.status === "running"` here
  // because that flag is workflow-level (any child node running counts)
  // and would keep the send→stop button stuck in Stop mode long after
  // the master itself has gone idle waiting for slaves to finish.
  const rootSessionRunning = useMemo(
    () => rows.some((item) => item.thinking?.status === "running" || item.toolCall?.status === "running"),
    [rows],
  )

  // ── Monitor text ──
  // Derives the "what is master agent thinking right now" stream from
  // the chat rows. We prefer the most recent reasoning block (model's
  // internal chain-of-thought as emitted by the backend), then fall
  // back to the most recent assistant content. This is what the
  // compact monitor panel surfaces while the workflow is running.
  const monitorText = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const m = rows[i]
      if (m.reasoning?.text?.trim()) return m.reasoning.text
      if (m.thinking?.status === "running") return "Agent is thinking…"
      if (m.role === "assistant" && m.content?.trim()) return m.content
    }
    return ""
  }, [rows])

  // ── Plan modal auto-open ──
  // Watch the chat stream for new plan messages. First time we see one
  // we pop the overlay; after the user dismisses or minimizes, the id
  // is marked as "seen" so it won't auto-open again on re-render.
  const planMessages = useMemo(() => rows.filter((m): m is ChatMsg & { plan: WorkflowPlan } => !!m.plan), [rows])
  useEffect(() => {
    if (planMessages.length === 0) return
    const latest = planMessages[planMessages.length - 1]
    if (autoOpenedPlans.current.has(latest.id)) return
    markAutoOpened(latest.id)
    setActivePlanMsgId(latest.id)
  }, [planMessages])

  // Expose the most recent plan's message id so the chat panel's
  // monitor header can render a "re-open plan" chip. This is the
  // safety net for the "I closed the overlay and now I can't get
  // back" complaint: the chat history itself still carries a chip,
  // but when the user has scrolled up or the chat is short, surfacing
  // the shortcut on the monitor header (always in view) keeps the
  // plan reachable with a single click.
  const latestPlanMsgId = planMessages.length > 0 ? planMessages[planMessages.length - 1].id : undefined

  const activePlan = useMemo(() => {
    if (!activePlanMsgId) return null
    const msg = planMessages.find((m) => m.id === activePlanMsgId)
    return msg?.plan ?? null
  }, [activePlanMsgId, planMessages])

  /* Decode dynamic tab ids surfaced from the unified shell substrip:
   *  - `node:<id>` → render NodeSessionView in the body
   *  - `sand:<id>` → render SandTableSessionView in the body
   * The legacy inline overlay (sessionNode state + early-return) is now
   * a fallback only when the parent shell isn't dispatching tabs (e.g.
   * running outside the rune-shell context). */
  const dynamicTab = (() => {
    const v = props.view ?? ""
    if (v.startsWith("node:")) return { kind: "node" as const, id: v.slice("node:".length) }
    if (v.startsWith("sand:")) return { kind: "sand" as const, id: v.slice("sand:".length) }
    return null
  })()
  const dynamicNodeId = dynamicTab?.id ?? null
  const showInline =
    sessionNode !== null && dynamicNodeId === null
  if (showInline && sessionNode) {
    const sNode = allNodes.find((n) => n.id === sessionNode) ?? null
    const sDetail = props.details[sessionNode] ?? null
    const sMessages = props.chats[sNode?.session ?? ""] ?? []
    const sSand = props.sandTables?.[sessionNode]

    if (sNode?.type === "plan" && sSand) {
      return (
        <SandTableSessionView
          nodeId={sessionNode}
          nodeTitle={sNode.title}
          nodeStatus={sNode.status}
          discussion={sSand}
          onBack={() => setSessionNode(null)}
          onStop={() => props.onStop(sessionNode)}
          onSend={(text) => props.onSandTableSend?.(sessionNode, text)}
          onStart={(overrides) => props.onSandTableStart?.(sessionNode, overrides)}
          agentOptions={props.rootAgents ?? []}
          modelOptions={props.models ?? []}
        />
      )
    }

    return (
      <div className="workflow-make h-full w-full overflow-hidden">
        <NodeSessionView
          nodeId={sessionNode}
          nodeTitle={sNode?.title ?? "Session"}
          nodeType={sNode?.type ?? "coding"}
          nodeStatus={sNode?.status ?? "pending"}
          messages={sMessages}
          detail={sDetail}
          model={props.model}
          models={props.models}
          workspace={props.workspace}
          onModelChange={props.onModelChange}
          onWorkspaceClick={props.onWorkspaceClick}
          onNewSession={props.onNewSession}
          onModelPickerOpen={
            props.onModelPickerOpen ?? (() => props.onModel(sessionNode ? [sessionNode] : undefined))
          }
          onPlanRun={props.onPlanRun}
          onPlanEdit={props.onPlanEdit}
          onQuestionReply={props.onQuestionReply}
          onQuestionReject={props.onQuestionReject}
          onPermissionReply={props.onPermissionReply}
          onBack={() => setSessionNode(null)}
          onStop={() => props.onStop(sessionNode)}
          onRestart={() => props.onRestart(sessionNode)}
          onStep={() => props.onPause(sessionNode)}
          onRun={() => props.onRun(sessionNode)}
          onSend={(text) => props.onSend(text, sessionNode)}
        />
      </div>
    )
  }

  return (
    <WorkflowRuntimeProvider value={props.runtime ?? null}>
    <div className="workflow-make h-full w-full overflow-hidden">
      <div className="relative flex h-full flex-col">
        <TopBar
          workflowTitle={props.title}
          sessionStatus={props.status}
          environment={props.env}
          nodeProgress={nodeProgress}
          tokenStats={props.tokenStats}
          onModelClick={props.onModel}
          onRefinerClick={() => props.onRefiner?.(node?.id)}
          onRetrieveClick={() => props.onRetrieve?.(node?.id)}
          onRunClick={() => props.onRun(node?.id)}
          onRestartClick={() => props.onRestart(node?.id)}
          onStopClick={() => props.onStop(node?.id)}
          onPauseClick={() => props.onPause(node?.id)}
          graphRev={props.graphRev}
          pendingEditsCount={(props.pendingEdits ?? []).filter((e) => e.status === "pending").length}
          finalizedStatus={props.finalizedStatus}
          onShowEdits={() => setEditsOpen(true)}
        />

        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Left column: Canvas / Chat / Events tab body. Per design,
            * only ONE of the three tabs renders at a time. Use conditional
            * mounting (not display:none on always-mounted divs) so flex
            * calculations stay clean — the previous approach caused the
            * chat composer to float in the middle when the messages list
            * was empty, because three flex:1 siblings + display:none on
            * two of them confused the layout engine in some browsers. */}
          <div className="flex min-w-0 flex-1 flex-col" data-wf-view={props.view ?? "canvas"}>
            {(props.view ?? "canvas") === "canvas" && (
            <div className="min-h-0 flex-1 wf-canvas-host">
              {/* Canvas HUD — top-left chip cluster (status / progress)
                * + top-right run-control cluster. Replaces the former
                * top-bar action group; keeps controls visible without
                * the redundant chrome. */}
              <div className="wf-canvas-hud" aria-label="Workflow status">
                <span
                  className="wf-canvas-hud-chip"
                  data-state={
                    props.status === "running"
                      ? "run"
                      : props.status === "completed"
                        ? "ok"
                        : props.status === "failed"
                          ? "err"
                          : "idle"
                  }
                >
                  <span className="wf-canvas-hud-dot" />
                  {props.status === "running"
                    ? `RUN · ${nodeProgress.done}/${nodeProgress.total}`
                    : props.status === "completed"
                      ? "DONE"
                      : props.status === "failed"
                        ? "FAILED"
                        : "IDLE"}
                </span>
                <span className="wf-canvas-hud-chip">
                  graph · {nodeProgress.total} nodes
                </span>
                {typeof props.graphRev === "number" && (
                  <span className="wf-canvas-hud-chip wf-canvas-hud-chip-mono">
                    rev #{props.graphRev}
                  </span>
                )}
              </div>
              {/* Per design template, Run / Pause / Replay live in the
                * unified shell header (top-right action cluster, dispatched
                * via global rune:wf:* events). The canvas no longer carries
                * a duplicate control cluster. Pending-edits chip is the
                * only floating action retained, since it's contextual to
                * graph state rather than execution. */}
              {(props.pendingEdits ?? []).filter((e) => e.status === "pending").length > 0 && (
                <div className="wf-canvas-run-cluster" aria-label="Pending edits">
                  <button
                    type="button"
                    className="wf-canvas-run-ctrl wf-canvas-run-ctrl-warn"
                    onClick={() => setEditsOpen(true)}
                    title="Pending graph edits"
                  >
                    {(props.pendingEdits ?? []).filter((e) => e.status === "pending").length} edits
                  </button>
                </div>
              )}
              <WorkflowCanvas
                root={{
                  title: props.title,
                  status: props.status,
                  phase: props.flow.phase,
                  goal: props.flow.goal,
                  model: props.agents[0]?.model,
                  nodeCount: nodeProgress.total,
                  completedCount: nodeProgress.done,
                }}
                chains={canvasChains}
                tail={props.chainTail}
                selectedNodeId={pick}
                onNodeSelect={(id) => {
                  // Selecting a node only updates the inspector — it never
                  // navigates. Navigation is reserved for the arrow button so
                  // that browsing the graph feels distinct from drilling in.
                  setPick(id)
                }}
                onNodeOpen={(id) => {
                  // Open the node in a NEW substrip tab card (browser-tab
                  // style). The previous inline NodeSessionView render is
                  // kept as a fallback when the global event listener isn't
                  // wired (e.g. running outside the unified shell).
                  setPick(id)
                  const opened = allNodes.find((n) => n.id === id)
                  const kind = opened?.type === "plan" ? "sand" : "node"
                  const title = opened?.title ?? id
                  if (typeof window !== "undefined") {
                    window.dispatchEvent(
                      new CustomEvent("rune:wf:open-node", {
                        detail: { id, kind, title },
                      }),
                    )
                  }
                  // Inline fallback in case the shell isn't listening.
                  setSessionNode(id)
                }}
                onRootClick={() => props.onSession()}
              />
            </div>
            )}
            {/* Chat tab body — full-height when active. Plan modals and
              * tool overlays still mount here, so they're only visible on
              * this tab (matches the design's tab-isolation model). */}
            {(props.view ?? "canvas") === "chat" && (
            <div className="flex min-h-0 min-w-0 w-full flex-1">
              <ChatPanel
                messages={rows}
                model={props.model}
                models={props.models}
                agent={props.rootAgent}
                agents={props.rootAgents}
                onAgentChange={props.onRootAgentChange}
                workspace={props.workspace}
                onSendMessage={(text) => props.onSend(text)}
                onModelChange={props.onModelChange}
                onWorkspaceClick={props.onWorkspaceClick}
                onNewSession={props.onNewSession}
                onModelPickerOpen={props.onModelPickerOpen ?? props.onModel}
                extraCommands={props.chatExtraCommands}
                onPlanRun={props.onPlanRun}
                onPlanEdit={props.onPlanEdit}
                isRunning={rootSessionRunning}
                onStop={() => props.onStopMaster?.()}
                onQuestionReply={props.onQuestionReply}
                onQuestionReject={props.onQuestionReject}
                onPermissionReply={props.onPermissionReply}
                chatHeight="tall"
                onSizeToggle={handleSizeToggle}
                onHide={handleHide}
                monitorText={monitorText}
                monitorPlanMsgId={latestPlanMsgId}
                historyHasMore={props.historyHasMore}
                historyLoading={props.historyLoading}
                onLoadMoreHistory={props.onLoadMoreHistory}
                renderPlanAsChip
                onPlanOpen={(msgId) => {
                  setMinimizedPlans((prev) => {
                    if (!prev.has(msgId)) return prev
                    const next = new Set(prev)
                    next.delete(msgId)
                    return next
                  })
                  setActivePlanMsgId(msgId)
                }}
              />
            </div>
            )}

            {/* Events tab body — node-aware timeline.
              *
              * Replaces the previous flat chronological list with a
              * grouped-by-node view (swimlane overview + per-node
              * collapsible cards) so the user can see WHAT EACH NODE
              * DID rather than just a wall of timestamps. The classic
              * flat timeline is one click away via the "Timeline"
              * toggle inside the panel. Legacy fallback (active
              * node's executionLog) only kicks in when no snapshot
              * events have been pre-projected; in normal use this is
              * always the snapshot-events path. */}
            {(props.view ?? "canvas") === "events" && (
              (() => {
                const events = props.workflowEvents ?? []
                if (events.length === 0) {
                  // Legacy fallback: surface the active node's
                  // executionLog when no workflow snapshot events are
                  // available (e.g. tests / minimal harnesses).
                  const log = (detail?.executionLog ?? []) as string[]
                  if (log.length > 0) {
                    return (
                      <div className="wf-events-pane">
                        <ol className="wf-timeline">
                          {log.map((line, i) => {
                            const cleaned = line.replace(/^\[\d+\]\s*/, "")
                            return (
                              <li key={i} className="wf-timeline-row">
                                <span className="wf-timeline-time">
                                  {String(i + 1).padStart(2, "0")}
                                </span>
                                <span className="wf-timeline-spine" aria-hidden>
                                  <span className="wf-timeline-dot wf-timeline-dot--idle" />
                                </span>
                                <div className="wf-timeline-body">
                                  <div className="wf-timeline-summary">{cleaned}</div>
                                </div>
                              </li>
                            )
                          })}
                        </ol>
                      </div>
                    )
                  }
                }
                return (
                  <EventsPanel
                    events={events}
                    nodes={allNodes.map((n) => ({
                      id: n.id,
                      title: n.title,
                      type: n.type,
                      status: n.status,
                    }))}
                    onSelectNode={(nodeID) => setPick(nodeID)}
                  />
                )
              })()
            )}

            {/* Dynamic node / sand-table tab body — renders inside the
              * substrip flow (the close × button is on the substrip tab
              * itself). The legacy back-button still works as a fallback
              * for inline cases. */}
            {dynamicTab && (() => {
              const id = dynamicTab.id
              const sNode = allNodes.find((n) => n.id === id) ?? null
              const sDetail = props.details[id] ?? null
              const sMessages = props.chats[sNode?.session ?? ""] ?? []
              const sSand = props.sandTables?.[id]
              if (dynamicTab.kind === "sand") {
                if (!sSand || !sNode) {
                  return (
                    <div className="wf-tab-empty">
                      Sand-table data unavailable for this node.
                    </div>
                  )
                }
                // Look up the planner / evaluator inner sessions via the
                // sand-table discussion's participant list; the inner
                // session messages live in the WorkflowApp `chats` map
                // keyed by session id. The InnerStreamPane projects them
                // into reasoning / tool / agent rows.
                const plannerPart = sSand.participants.find((p) => p.role === "planner")
                const evaluatorPart = sSand.participants.find((p) => p.role === "evaluator")
                const projectInner = (msgs: ChatMsg[] | undefined) =>
                  (msgs ?? []).map((m) => {
                    let role = m.role as string
                    if (m.toolCall) role = "tool"
                    if (m.reasoning?.text) role = "reason"
                    return {
                      id: m.id,
                      role,
                      text: m.reasoning?.text ?? m.content,
                      tool: m.toolCall ? (m.toolCall as { name?: string }).name ?? "tool" : undefined,
                      out: m.toolCall ? ((m.toolCall as { output?: string }).output ?? undefined) : undefined,
                      t: m.timestamp,
                      dur: m.thinking?.status === "running" ? "…" : undefined,
                      stream: m.thinking?.status === "running",
                    }
                  })
                const innerMessages = {
                  planner: plannerPart ? projectInner(props.chats[plannerPart.sessionID]) : undefined,
                  evaluator: evaluatorPart ? projectInner(props.chats[evaluatorPart.sessionID]) : undefined,
                }
                return (
                  <div className="flex min-h-0 flex-1">
                    <SandTableSessionView
                      nodeId={id}
                      nodeTitle={sNode.title}
                      nodeStatus={sNode.status}
                      discussion={sSand}
                      onBack={() => undefined}
                      onStop={() => props.onStop(id)}
                      onSend={(text) => props.onSandTableSend?.(id, text)}
                      onStart={(overrides) => props.onSandTableStart?.(id, overrides)}
                      agentOptions={props.rootAgents ?? []}
                      modelOptions={props.models ?? []}
                      innerMessages={innerMessages}
                    />
                  </div>
                )
              }
              return (
                <div className="flex min-h-0 flex-1">
                  <NodeSessionView
                    nodeId={id}
                    nodeTitle={sNode?.title ?? "Session"}
                    nodeType={sNode?.type ?? "coding"}
                    nodeStatus={sNode?.status ?? "pending"}
                    messages={sMessages}
                    detail={sDetail}
                    model={props.model}
                    models={props.models}
                    workspace={props.workspace}
                    onModelChange={props.onModelChange}
                    onWorkspaceClick={props.onWorkspaceClick}
                    onNewSession={props.onNewSession}
                    onModelPickerOpen={
                      props.onModelPickerOpen ?? (() => props.onModel([id]))
                    }
                    onPlanRun={props.onPlanRun}
                    onPlanEdit={props.onPlanEdit}
                    onQuestionReply={props.onQuestionReply}
                    onQuestionReject={props.onQuestionReject}
                    onPermissionReply={props.onPermissionReply}
                    onBack={() => undefined}
                    onStop={() => props.onStop(id)}
                    onRestart={() => props.onRestart(id)}
                    onStep={() => props.onPause(id)}
                    onRun={() => props.onRun(id)}
                    onSend={(text) => props.onSend(text, id)}
                  />
                </div>
              )
            })()}
          </div>

          {/* Right column: Inspector (full height). Per design template,
            * the aside is a fixed 340px column that can collapse to 0 via
            * a toggle button (no draggable splitbar). The split hook is
            * kept for backwards-compat but we drive width via an
            * asideOpen flag now. */}
          <button
            type="button"
            className="wf-rcanvas-aside-toggle"
            onClick={() => setAsideOpen((v) => !v)}
            title={asideOpen ? 'Collapse panel' : 'Expand panel'}
            aria-label="Toggle inspector"
          >
            {asideOpen ? '›' : '‹'}
          </button>
          <div
            className="flex-shrink-0 wf-aside-col"
            data-aside={asideOpen ? 'open' : 'closed'}
            style={{ width: asideOpen ? `${side.size}px` : '0px' }}
          >
            <EnhancedInspectorPanel
              nodeDetails={detail}
              workflowContext={props.flow}
              agents={props.agents}
              onModelClick={props.onModel}
            />
          </div>
        </div>

        {/* The legacy TaskSidebar drawer was removed — tasks now live in
         * the unified shell's left rail (under "Workflow") with an inline
         * "+ Add task" button. The drawer was redundant and partially
         * occluded the workflow canvas; the rail is always visible and
         * supports the same pick + create operations. */}

        {/* P5 — Graph edits drawer. Mounted inside the relative container
         * so its absolute backdrop only covers the workflow surface, not the
         * surrounding session shell. Visibility is controlled by the
         * `editsOpen` state, toggled from the TopBar pending-edits chip. */}
        <GraphEditsDrawer
          open={editsOpen}
          onClose={() => setEditsOpen(false)}
          graphRev={props.graphRev}
          edits={props.pendingEdits ?? []}
          finalizedStatus={props.finalizedStatus}
          onApply={props.onApplyEdit}
          onReject={props.onRejectEdit}
          onFinalize={props.onFinalize}
        />
      </div>
      {/* Plan overlay — rendered last so it layers above the canvas,
       * inspector, sidebar, and both header clusters. The overlay owns
       * its own backdrop blur; we just need to make sure the root div
       * isn't clipping it (already `overflow-hidden`, but the overlay
       * uses `position: fixed` so it escapes the container). */}
      {activePlan && activePlanMsgId && (
        <PlanOverlay
          plan={activePlan}
          onClose={() => {
            // Close = remove from view. The plan stays in chat as a
            // chip (thanks to renderPlanAsChip) so the user can always
            // re-open it later.
            setMinimizedPlans((prev) => new Set(prev).add(activePlanMsgId))
            setActivePlanMsgId(null)
          }}
          onMinimize={() => {
            setMinimizedPlans((prev) => new Set(prev).add(activePlanMsgId))
            setActivePlanMsgId(null)
          }}
          /* Auto-close the plan modal when the user commits via "Create
           * graph" or "Edit" — they want to land back on the workflow
           * canvas (or wherever they were) rather than continue staring
           * at the plan modal while the workflow starts running. The
           * plan stays in chat as a chip so they can re-open if needed. */
          onRun={(plan) => {
            props.onPlanRun?.(plan)
            setMinimizedPlans((prev) => new Set(prev).add(activePlanMsgId))
            setActivePlanMsgId(null)
          }}
          onEdit={(ctx) => {
            props.onPlanEdit?.(ctx)
            setMinimizedPlans((prev) => new Set(prev).add(activePlanMsgId))
            setActivePlanMsgId(null)
          }}
        />
      )}
    </div>
    </WorkflowRuntimeProvider>
  )
}
