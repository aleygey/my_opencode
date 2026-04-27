/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react"
import type { SnapshotFileDiff as FileDiff } from "@opencode-ai/sdk/v2/client"
import { TopBar } from "./components/top-bar"
import { WorkflowCanvas } from "./components/workflow-canvas"
import { EnhancedInspectorPanel } from "./components/enhanced-inspector-panel"
import { ChatPanel } from "./components/chat-panel"
import type { Msg as ChatMsg } from "./components/chat-panel"
import type { SlashCommand } from "./commands"
import { TaskSidebar, type Task } from "./components/task-sidebar"
import { NodeSessionView } from "./components/node-session-view"
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
  session: string
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
  const [sidebar, setSidebar] = useState(false)
  const [sessionNode, setSessionNode] = useState<string | null>(null)
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
  const side = useSplit({ axis: "x", size: 640, min: 520, max: 920, dir: -1 })
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

  // Node session view (Page 2)
  if (sessionNode) {
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
    <div className="workflow-make h-full w-full overflow-hidden">
      <div className="relative flex h-full flex-col">
        <TopBar
          workflowTitle={props.title}
          sessionStatus={props.status}
          environment={props.env}
          nodeProgress={nodeProgress}
          tokenStats={props.tokenStats}
          onTaskSidebarToggle={() => setSidebar((v) => !v)}
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
          {/* Left column: Canvas + Chat */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1">
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
                  // Arrow click: drill into the node's detail view in-place.
                  // Both plan nodes (SandTableSessionView) and regular nodes
                  // (NodeSessionView) render inside the workflow canvas — this
                  // keeps navigation contextual to the workflow rather than
                  // punting the user to the old session page. The previous
                  // behaviour (non-plan → props.onSession(id)) caused the UI
                  // to jump out of the workflow view, which required users to
                  // click a separate "Detail" button to get back in.
                  setPick(id)
                  setSessionNode(id)
                }}
                onRootClick={() => props.onSession()}
              />
            </div>
            {chatHeight !== "hidden" && <SplitBar axis="y" {...chat.bind} />}
            {chatHeight === "hidden" ? (
              <div
                className="wf-chat-restore-zone"
                onMouseEnter={(e) => {
                  const bar = e.currentTarget.querySelector(".wf-chat-restore-bar") as HTMLElement
                  if (bar) bar.classList.add("wf-chat-restore-bar--visible")
                }}
                onMouseLeave={(e) => {
                  const bar = e.currentTarget.querySelector(".wf-chat-restore-bar") as HTMLElement
                  if (bar) bar.classList.remove("wf-chat-restore-bar--visible")
                }}
              >
                <div className="wf-chat-restore-bar">
                  <button className="wf-chat-restore-btn" onClick={handleRestore}>
                    <ChevronUp className="h-3.5 w-3.5" strokeWidth={2.5} />
                    <span>Show Chat</span>
                  </button>
                </div>
              </div>
            ) : (
              <div
                className="flex-shrink-0"
                style={{
                  height: chat.size,
                  transition: chatAnimating ? "height 450ms cubic-bezier(0.16, 1, 0.3, 1)" : "none",
                }}
              >
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
                  chatHeight={chatHeight}
                  onSizeToggle={handleSizeToggle}
                  onHide={handleHide}
                  monitorText={monitorText}
                  monitorPlanMsgId={latestPlanMsgId}
                  historyHasMore={props.historyHasMore}
                  historyLoading={props.historyLoading}
                  onLoadMoreHistory={props.onLoadMoreHistory}
                  // Plan routing: the message list renders a compact
                  // chip for every plan so the full card is reserved
                  // for the modal overlay. Clicking the chip re-opens
                  // the overlay for that specific plan.
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
          </div>

          {/* Right column: Inspector (full height) */}
          <SplitBar axis="x" {...side.bind} />
          <div className="flex-shrink-0" style={{ width: side.size }}>
            <EnhancedInspectorPanel
              nodeDetails={detail}
              workflowContext={props.flow}
              agents={props.agents}
              onModelClick={props.onModel}
            />
          </div>
        </div>

        <TaskSidebar
          open={sidebar}
          tasks={
            props.tasks ?? [
              {
                id: props.root,
                title: props.title,
                status: props.status,
                nodes: allNodes.map((n) => ({
                  id: n.id,
                  title: n.title,
                  type: n.type,
                  status: n.status,
                  session: n.session,
                })),
                duration: props.flow.phase,
              },
            ]
          }
          activeTaskId={props.activeTaskId ?? props.root}
          activeNodeId={pick ?? undefined}
          onClose={() => setSidebar(false)}
          onSelectTask={(id) => {
            props.onTaskSelect?.(id)
          }}
          onSelectNode={(id) => {
            setPick(id)
            setSidebar(false)
          }}
          onOpenNode={(id) => {
            setPick(id)
            const next = allNodes.find((item) => item.id === id)
            if (next?.type === "plan") {
              setSessionNode(id)
              setSidebar(false)
              return
            }
            props.onSession(id)
            setSidebar(false)
          }}
          onNewTask={() => {
            props.onNewTask?.()
            setSidebar(false)
          }}
          onDeleteTask={(id) => {
            props.onDeleteTask?.(id)
          }}
        />

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
          onRun={props.onPlanRun}
          onEdit={props.onPlanEdit}
        />
      )}
    </div>
  )
}
