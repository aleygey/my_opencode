/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react"
import type { FileDiff } from "@opencode-ai/sdk/v2/client"
import { TopBar } from "./components/top-bar"
import { WorkflowCanvas } from "./components/workflow-canvas"
import { EnhancedInspectorPanel } from "./components/enhanced-inspector-panel"
import { ChatPanel } from "./components/chat-panel"
import { TaskSidebar, type Task } from "./components/task-sidebar"
import { NodeSessionView } from "./components/node-session-view"
import { SplitBar, useSplit } from "./components/split"
import { ChevronUp } from "lucide-react"
import "./styles/theme.css"

type State = "running" | "completed" | "failed" | "idle"
type Role = "system" | "assistant" | "user" | "tool"
type Kind = "coding" | "build-flash" | "debug" | "deploy"
export type Status = "pending" | "running" | "completed" | "failed" | "paused"

export type Node = {
  id: string
  title: string
  type: Kind
  status: Status
  session: string
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
}

type Agent = {
  name: string
  model: string
  role: string
}

type Flow = {
  goal: string
  phase: string
  overallStatus: State
}

type ToolCallStatus = 'running' | 'completed' | 'failed'

type ToolCall = {
  name: string
  status: ToolCallStatus
  duration?: string
  progress?: number
}

type Msg = {
  id: string
  role: Role
  content: string
  timestamp: string
  thinking?: {
    status: 'running' | 'completed'
  }
  toolCall?: ToolCall
  plan?: unknown
  sandTable?: unknown
  question?: unknown
  permission?: unknown
  reasoning?: { text: string; time?: { start: number; end?: number } }
  file?: { mime: string; filename?: string; url: string }
  patch?: { hash: string; files: string[] }
  subtask?: { description: string; agent: string; prompt: string }
  stepFinish?: { reason: string; cost: number; tokens: { input: number; output: number } }
  retry?: { attempt: number; error: string }
  agent?: { name: string }
}

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
  workspace?: string
  nodes: Node[]
  chains?: Chain[]
  tasks?: Task[]
  activeTaskId?: string
  details: Record<string, Detail>
  flow: Flow
  agents: Agent[]
  chats: Record<string, Msg[]>
  tokenStats?: TokenStats
  onSession: (node?: string) => void
  onTaskSelect?: (task: string) => void
  onModel: () => void
  onModelChange?: (model: string) => void
  onWorkspaceClick?: () => void
  onNewTask?: () => void
  onDeleteTask?: (taskId: string) => void
  onRun: (node?: string) => void
  onRestart: (node?: string) => void
  onStop: (node?: string) => void
  onPause: (node?: string) => void
  onSend: (text: string, node?: string) => void
  // Slash command callbacks
  onNewSession?: () => void
  onModelPickerOpen?: () => void
  // Plan card callbacks
  onPlanRun?: () => void
  onPlanEdit?: (context: string) => void
  // Question/Permission callbacks
  onQuestionReply?: (requestID: string, answers: string[][]) => void
  onQuestionReject?: (requestID: string) => void
  onPermissionReply?: (requestID: string, reply: 'once' | 'always' | 'reject', message?: string) => void
}

export function WorkflowApp(props: WorkflowAppProps) {
  const [pick, setPick] = useState<string | null>(props.pick ?? props.nodes[0]?.id ?? null)
  const [sidebar, setSidebar] = useState(false)
  const [sessionNode, setSessionNode] = useState<string | null>(null)
  const side = useSplit({ axis: "x", size: 640, min: 520, max: 920, dir: -1 })
  const chat = useSplit({ axis: "y", size: 520, min: 0, max: 700, dir: -1 })
  const [chatHeight, setChatHeight] = useState<'tall' | 'short' | 'hidden'>('tall')
  const prevChatSize = useRef(520)
  const handleSizeToggle = () => {
    setChatHeight((prev) => {
      if (prev === 'tall') { prevChatSize.current = chat.size; chat.setSize(220); return 'short' }
      chat.setSize(prevChatSize.current || 520); return 'tall'
    })
  }
  const handleHide = () => {
    prevChatSize.current = chat.size
    chat.setSize(0)
    setChatHeight('hidden')
  }
  const handleRestore = () => {
    chat.setSize(prevChatSize.current || 520)
    setChatHeight(prevChatSize.current > 300 ? 'tall' : 'short')
  }

  // Dynamic chat panel height: tall when idle/paused, short when running
  const isRunning = props.status === "running"
  const prevRunning = useRef(isRunning)
  const [chatAnimating, setChatAnimating] = useState(false)
  useEffect(() => {
    if (prevRunning.current === isRunning) return
    prevRunning.current = isRunning
    if (chatHeight === 'hidden') return
    setChatAnimating(true)
    if (isRunning) {
      chat.setSize(220)
      setChatHeight('short')
    } else {
      chat.setSize(520)
      setChatHeight('tall')
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
          progress: typeof props.details[n.id]?.stateJson?.progress === 'number'
            ? (props.details[n.id].stateJson.progress as number)
            : undefined,
        })),
      }))
    }
    // Default: wrap flat nodes into a single chain
    return [{
      id: 'default',
      label: 'Main',
      nodes: props.nodes.map((n) => ({
        ...n,
        progress: typeof props.details[n.id]?.stateJson?.progress === 'number'
          ? (props.details[n.id].stateJson.progress as number)
          : undefined,
      })),
    }]
  }, [props.chains, props.nodes, props.details])

  useEffect(() => {
    const first = allNodes[0]?.id ?? null
    const next = props.pick ?? first
    setPick(next)
  }, [props.pick, allNodes])

  const node = useMemo(() => allNodes.find((item) => item.id === pick) ?? null, [pick, allNodes])
  const detail = useMemo(() => (pick ? props.details[pick] ?? null : null), [props.details, pick])
  const rows = props.chats[props.root] ?? []

  // Node session view (Page 2)
  if (sessionNode) {
    const sNode = allNodes.find((n) => n.id === sessionNode) ?? null
    const sDetail = props.details[sessionNode] ?? null
    const sMessages = props.chats[sNode?.session ?? ""] ?? []

    return (
      <div className="workflow-make h-full w-full overflow-hidden">
        <NodeSessionView
          nodeId={sessionNode}
          nodeTitle={sNode?.title ?? "Session"}
          nodeStatus={sNode?.status ?? "pending"}
          messages={sMessages}
          detail={sDetail}
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
          onDetailClick={() => {
            if (!pick) return
            setSessionNode(pick)
          }}
          onSessionClick={() => props.onSession()}
          onModelClick={props.onModel}
          onRunClick={() => props.onRun(node?.id)}
          onRestartClick={() => props.onRestart(node?.id)}
          onStopClick={() => props.onStop(node?.id)}
          onPauseClick={() => props.onPause(node?.id)}
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
                selectedNodeId={pick}
                onNodeSelect={(id) => {
                  if (pick === id) {
                    props.onSession(id)
                    return
                  }
                  setPick(id)
                }}
                onNodeOpen={(id) => {
                  setPick(id)
                  props.onSession(id)
                }}
                onRootClick={() => props.onSession()}
              />
            </div>
            {chatHeight !== 'hidden' && <SplitBar axis="y" {...chat.bind} />}
            {chatHeight === 'hidden' ? (
              <div className="wf-chat-restore-zone" onMouseEnter={(e) => {
                const bar = e.currentTarget.querySelector('.wf-chat-restore-bar') as HTMLElement
                if (bar) bar.classList.add('wf-chat-restore-bar--visible')
              }} onMouseLeave={(e) => {
                const bar = e.currentTarget.querySelector('.wf-chat-restore-bar') as HTMLElement
                if (bar) bar.classList.remove('wf-chat-restore-bar--visible')
              }}>
                <div className="wf-chat-restore-bar">
                  <button className="wf-chat-restore-btn" onClick={handleRestore}>
                    <ChevronUp className="h-3.5 w-3.5" strokeWidth={2.5} />
                    <span>Show Chat</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex-shrink-0" style={{
                height: chat.size,
                transition: chatAnimating ? 'height 450ms cubic-bezier(0.16, 1, 0.3, 1)' : 'none',
              }}>
                <ChatPanel
                  messages={rows}
                  model={props.model}
                  models={props.models}
                  workspace={props.workspace}
                  onSendMessage={(text) => props.onSend(text)}
                  onModelChange={props.onModelChange}
                  onWorkspaceClick={props.onWorkspaceClick}
                  onNewSession={props.onNewSession}
                  onModelPickerOpen={props.onModelPickerOpen ?? props.onModel}
                  onPlanRun={props.onPlanRun}
                  onPlanEdit={props.onPlanEdit}
                  isRunning={props.status === 'running'}
                  onStop={() => props.onStop()}
                  onQuestionReply={props.onQuestionReply}
                  onQuestionReject={props.onQuestionReject}
                  onPermissionReply={props.onPermissionReply}
                  chatHeight={chatHeight}
                  onSizeToggle={handleSizeToggle}
                  onHide={handleHide}
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
          tasks={props.tasks ?? [{
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
          }]}
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
      </div>
    </div>
  )
}
