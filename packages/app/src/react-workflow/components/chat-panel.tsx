/** @jsxImportSource react */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp, Bot, Terminal, User, Wrench, ChevronDown, ChevronRight, ChevronUp, Check,
  FolderOpen, Cpu, Cog, CheckCircle2, XCircle, Loader2, Eye, MessageCircle,
  Maximize2, Minimize2, X, FileText, GitBranch, RotateCcw, Brain, Zap, Square,
} from 'lucide-react'
import { Spin } from './spin'
import { SlashPopover } from './slash-popover'
import { PlanCard, type WorkflowPlan } from './plan-card'
import { Markdown } from './markdown'
import { QuestionDialog, type QuestionRequest } from './question-dialog'
import { PermissionDialog, type PermissionRequest, type PermissionReply } from './permission-dialog'
import { useSlashCommands } from '../use-slash-commands'
import type { SlashCommand } from '../commands'

type Role = 'system' | 'assistant' | 'user' | 'tool'

export type ToolCallStatus = 'running' | 'completed' | 'failed'

export interface ToolCall {
  name: string
  status: ToolCallStatus
  duration?: string
  progress?: number
  sessionId?: string
  input?: Record<string, unknown>
}

export interface Msg {
  id: string
  role: Role
  content: string
  timestamp: string
  thinking?: {
    status: 'running' | 'completed'
  }
  toolCall?: ToolCall
  /** When present, renders a structured plan card instead of normal text */
  plan?: WorkflowPlan
  /** When present, renders a question dialog */
  question?: QuestionRequest
  /** When present, renders a permission dialog */
  permission?: PermissionRequest
  /** Structured part types from backend */
  reasoning?: { text: string; time?: { start: number; end?: number } }
  file?: { mime: string; filename?: string; url: string }
  patch?: { hash: string; files: string[] }
  subtask?: { description: string; agent: string; prompt: string }
  stepFinish?: { reason: string; cost: number; tokens: { input: number; output: number } }
  retry?: { attempt: number; error: string }
  agent?: { name: string }
}

interface Props {
  messages: Msg[]
  model?: string
  models?: string[]
  /** Currently selected root-session agent name. When the master page
   * originally hard-coded "orchestrator" as the sole root agent, users
   * had no way to run a quick one-off task without firing up the full
   * long-chain workflow. Exposing the current agent here lets the
   * header render a picker so any primary (non-subagent) agent can
   * drive the root session instead. */
  agent?: string
  /** Candidate agents for the root-session picker. Typically all
   * non-subagent, non-hidden agents advertised by the backend. When
   * empty or undefined the agent chip is hidden. */
  agents?: string[]
  /** Fired when the user picks a different root-session agent. The
   * parent page persists the choice into `local.agent` so follow-up
   * prompts are routed to that agent. */
  onAgentChange?: (agent: string) => void
  workspace?: string
  waitingForInput?: boolean
  onSendMessage?: (msg: string) => void
  onModelChange?: (model: string) => void
  onWorkspaceClick?: () => void
  onTaskDetail?: (sessionId: string) => void
  /** Slash command extensions */
  extraCommands?: SlashCommand[]
  onNewSession?: () => void
  onModelPickerOpen?: () => void
  /** Plan card callbacks */
  onPlanRun?: (plan: WorkflowPlan) => void
  onPlanEdit?: (context: string) => void
  /** When true, plan messages render as a compact chip instead of the
   * full PlanCard. The parent owns the full-size overlay modal; the
   * chip is the in-chat "re-open" affordance. */
  renderPlanAsChip?: boolean
  /** Fired when the user clicks the chip — the parent opens the
   * overlay for the given plan message id. */
  onPlanOpen?: (msgId: string) => void
  /** Session control */
  isRunning?: boolean
  onStop?: () => void
  /** Height controls */
  chatHeight?: 'tall' | 'short' | 'input-only' | 'hidden'
  /** Latest master-agent monitor content — a short "what the agent is
   * thinking right now" stream surfaced above the input when we're in
   * input-only mode. Rendered as plain text; the container scrolls.
   * When empty the monitor section hides itself. */
  monitorText?: string
  monitorLabel?: string
  /** When set, the monitor header surfaces a small "Plan" chip that
   * re-opens the overlay for this plan message. Safety net for the
   * case where the user closed the overlay in input-only mode and
   * can't find the in-chat chip because the messages scrolled off. */
  monitorPlanMsgId?: string
  onSizeToggle?: () => void   // toggle tall ↔ short
  onHide?: () => void          // collapse to hidden
  onRestore?: () => void       // restore from hidden
  /** Question/Permission callbacks */
  onQuestionReply?: (requestID: string, answers: string[][]) => void
  onQuestionReject?: (requestID: string) => void
  onPermissionReply?: (requestID: string, reply: PermissionReply, message?: string) => void
  /** Server-side history pagination for long master sessions. The chat
   * panel keeps its own client-side page window (50 groups) but the
   * underlying message store only hydrates the first 80 messages; older
   * turns require a cursor-based fetch. When `historyHasMore` is true
   * and the user has already revealed every in-memory group, the
   * "Load earlier messages" button calls `onLoadMoreHistory` to request
   * the next page from the server instead of being a no-op. */
  historyHasMore?: boolean
  historyLoading?: boolean
  onLoadMoreHistory?: () => void
}

const icons: Record<Role, React.ElementType> = {
  system: Terminal,
  assistant: Bot,
  user: User,
  tool: Wrench,
}

const names: Record<Role, string> = {
  system: 'System',
  assistant: 'Agent',
  user: 'You',
  tool: 'Tool',
}

/* Left-border accent + icon tint per role */
const roleStyle: Record<Role, { border: string; iconBg: string; iconColor: string }> = {
  system:    { border: '#8a74c1', iconBg: 'rgba(138,116,193,0.08)', iconColor: '#8a74c1' },
  assistant: { border: 'var(--wf-ok)', iconBg: 'var(--wf-ok-soft)', iconColor: 'var(--wf-ok)' },
  user:      { border: '#6088c1', iconBg: 'rgba(96,136,193,0.08)', iconColor: '#6088c1' },
  tool:      { border: '#c9943e', iconBg: 'rgba(201,148,62,0.08)', iconColor: '#c9943e' },
}

/* ── Format tool content: extract key info, avoid raw JSON ── */
/* ── Tool one-liner ──
 *
 * Turns a (name, input) pair into a single short human line — the
 * "what is this tool actually doing?" view. The chat-panel renders
 * one of these per tool inside the collapsed `ToolStrip`. Format
 * choice mirrors what the user would have typed in a terminal /
 * editor whenever possible (e.g. `$ ls -la`, `read app.tsx`,
 * `grep "foo" src/`), because the user said they don't want to look
 * at JSON schemas — they want to know *what was done*.
 *
 * Falls back to `name(<first-string-arg>)` so a never-seen-before
 * tool still gets a readable line. */
function toolOneLiner(name: string, input?: Record<string, unknown>): string {
  const args = (input ?? {}) as Record<string, unknown>
  const str = (k: string) => {
    const v = args[k]
    return typeof v === "string" ? v : undefined
  }
  const trim = (s: string, n = 80) =>
    s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s
  const file = str("filePath") ?? str("file_path") ?? str("path") ?? str("file")
  switch (name) {
    case "bash":
    case "shell": {
      const cmd = str("command") ?? str("cmd") ?? ""
      return cmd ? `$ ${trim(cmd)}` : "$ (command)"
    }
    case "read":
      return file ? `read ${trim(file, 60)}` : "read"
    case "write":
      return file ? `write ${trim(file, 60)}` : "write"
    case "edit":
    case "str_replace_editor":
      return file ? `edit ${trim(file, 60)}` : "edit"
    case "grep": {
      const pattern = str("pattern") ?? ""
      const where = str("path") ?? str("include") ?? ""
      return `grep ${pattern ? `"${trim(pattern, 40)}"` : ""}${where ? ` ${trim(where, 40)}` : ""}`.trim() || "grep"
    }
    case "glob": {
      const pattern = str("pattern") ?? ""
      return pattern ? `glob ${trim(pattern, 60)}` : "glob"
    }
    case "list":
    case "ls":
      return file ? `ls ${trim(file, 60)}` : "ls"
    case "task": {
      const desc = str("description") ?? str("subagent_type") ?? ""
      return desc ? `task: ${trim(desc, 50)}` : "task"
    }
    case "webfetch":
    case "web_fetch":
    case "fetch": {
      const url = str("url") ?? ""
      return url ? `fetch ${trim(url, 50)}` : "fetch"
    }
    case "websearch":
    case "web_search":
      return `search ${trim(str("query") ?? "", 60)}`.trim()
    default: {
      // Workflow tools — strip the prefix and use the verb.
      if (name.startsWith("workflow_")) {
        const verb = name.slice("workflow_".length)
        const node = str("node_id") ?? str("nodeId") ?? str("id") ?? ""
        return node ? `${verb} ${trim(node, 24)}` : verb
      }
      // Refiner / retrieve / serial / scheduler tools
      if (name.startsWith("refiner_") || name.startsWith("retrieve_") || name.startsWith("serial_") || name.startsWith("scheduler_") || name.startsWith("knowledge_")) {
        const verb = name.replace(/^[^_]+_/, "")
        const target =
          str("port") ?? str("path") ?? str("query") ?? str("id") ?? str("text") ?? ""
        return target ? `${verb} ${trim(target, 40)}` : verb
      }
      // Generic — first string arg.
      for (const v of Object.values(args)) {
        if (typeof v === "string" && v.trim()) {
          return `${name} ${trim(v, 50)}`
        }
      }
      return name
    }
  }
}

function formatToolContent(name: string, raw: string): string {
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) {
      const meaningful: string[] = []
      if (parsed.result) meaningful.push(typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result))
      if (parsed.output) meaningful.push(typeof parsed.output === 'string' ? parsed.output : JSON.stringify(parsed.output))
      if (parsed.message) meaningful.push(parsed.message)
      if (parsed.summary) meaningful.push(parsed.summary)
      if (parsed.content) meaningful.push(typeof parsed.content === 'string' ? parsed.content : JSON.stringify(parsed.content))
      if (parsed.error) meaningful.push(`Error: ${parsed.error}`)
      if (parsed.path || parsed.file) meaningful.push(`File: ${parsed.path || parsed.file}`)
      if (parsed.command) meaningful.push(`$ ${parsed.command}`)
      if (parsed.stdout) meaningful.push(parsed.stdout)
      if (parsed.stderr) meaningful.push(`stderr: ${parsed.stderr}`)
      if (meaningful.length > 0) return meaningful.join('\n')
      return Object.entries(parsed)
        .filter(([, v]) => v != null && v !== '' && typeof v !== 'object')
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n') || raw
    }
  } catch {
    // Not JSON — return as-is
  }
  return raw
}

/* ── Format message content: extract readable text from possible JSON ── */
export function FormattedContent({ text }: { text: string }) {
  const trimmed = text.trim()
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const parsed = JSON.parse(trimmed)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const readable: string[] = []
        const keys = ['thinking', 'thought', 'plan', 'reasoning', 'analysis', 'summary', 'message',
                      'content', 'text', 'description', 'next_step', 'nextStep', 'result', 'output',
                      'explanation', 'answer', 'response', 'instructions']
        for (const key of keys) {
          if (parsed[key]) {
            const val = parsed[key]
            readable.push(typeof val === 'string' ? val : JSON.stringify(val, null, 2))
          }
        }
        if (readable.length > 0) return <>{readable.join('\n\n')}</>
        const flat = Object.entries(parsed)
          .filter(([, v]) => v != null && v !== '')
          .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'string' ? v : typeof v === 'object' ? '...' : String(v)}`)
          .join('\n')
        if (flat) return <>{flat}</>
      }
    } catch {
      // Not valid JSON
    }
  }
  return <>{text}</>
}

/* ── Tool call card (expanded detail row inside ToolStrip) ──
 *
 * Two stacked rows:
 *   1. Header — name + one-liner (the same line shown in the strip,
 *      so the user can match strip-rows to detail-rows by eye) +
 *      duration + status chip.
 *   2. Output — the actual return / stdout, shown as a monospace
 *      block. Truncated to a max-height; when content is long, click
 *      the row to toggle full output. Empty for tools that haven't
 *      produced output yet.
 *
 * The big visual change vs the previous layout: no big tinted icon
 * box, no JSON dump for the input — input is rendered inline as a
 * one-liner so the user sees the actual *intent* of the call, not
 * its schema. */
export const ToolCallCard = memo(function ToolCallCard({ tool, content, onDetail }: { tool: ToolCall; content: string; onDetail?: (sessionId: string) => void }) {
  const [outOpen, setOutOpen] = useState(false)
  const display = useMemo(() => formatToolContent(tool.name, content), [tool.name, content])
  const oneLiner = useMemo(() => toolOneLiner(tool.name, tool.input), [tool.name, tool.input])
  const isTask = tool.name === "task"
  const taskAgent = isTask && tool.input?.subagent_type ? String(tool.input.subagent_type) : undefined
  return (
    <div className={`wf-tool-row wf-tool-row--${tool.status}`}>
      <button
        type="button"
        className="wf-tool-row-head"
        onClick={() => setOutOpen((v) => !v)}
        title={display ? (outOpen ? "收起输出" : "查看实际输出") : undefined}
      >
        <span className="wf-tool-row-name">{tool.name}</span>
        <span className="wf-tool-row-line">{oneLiner}</span>
        {isTask && taskAgent && <span className="wf-tool-row-agent">@{taskAgent}</span>}
        <span className="wf-tool-row-spacer" />
        <span className="wf-tool-row-meta">
          {tool.status === "running" ? (
            <>
              <Spin size={9} tone="var(--wf-dim)" line={1.4} />
              <span>running</span>
            </>
          ) : tool.status === "failed" ? (
            <span className="wf-tool-row-meta-fail">failed</span>
          ) : (
            <>
              <Check className="h-2.5 w-2.5" strokeWidth={2.4} />
              <span>{tool.duration ?? "done"}</span>
            </>
          )}
        </span>
        {isTask && tool.sessionId && onDetail && (
          <button
            type="button"
            className="wf-tool-row-detail"
            onClick={(ev) => {
              ev.stopPropagation()
              onDetail(tool.sessionId!)
            }}
            title="View subagent session"
          >
            <Eye className="h-2.5 w-2.5" strokeWidth={2} />
            session
          </button>
        )}
      </button>
      {outOpen && display && (
        <pre className="wf-tool-row-output whitespace-pre-wrap break-all">{display}</pre>
      )}
    </div>
  )
})

/* ── Parse thinking content for human-readable display ── */
function formatThinkingContent(raw: string): string {
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) {
      const parts: string[] = []
      if (parsed.thinking || parsed.thought) parts.push(parsed.thinking || parsed.thought)
      if (parsed.plan) parts.push(`Plan: ${typeof parsed.plan === 'string' ? parsed.plan : JSON.stringify(parsed.plan, null, 2)}`)
      if (parsed.reasoning) parts.push(parsed.reasoning)
      if (parsed.analysis) parts.push(parsed.analysis)
      if (parsed.summary) parts.push(parsed.summary)
      if (parsed.next_step || parsed.nextStep) parts.push(`Next: ${parsed.next_step || parsed.nextStep}`)
      if (parts.length > 0) return parts.join('\n\n')
      return Object.entries(parsed)
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('\n')
    }
  } catch {
    // Not JSON, return as-is
  }
  return raw
}

// `memo` wrap: chat-panel re-renders on every new message tick, and every
// re-render previously rebuilt the entire conversation tree (each tool /
// thinking / reasoning card with it). The user reported tool cards
// "flashing" on every new message — that's React doing a no-op re-render
// of the card with identical props. `memo` short-circuits the re-render
// when props are shallow-equal. Same fix applied to every card below.
export const ThinkingCard = memo(function ThinkingCard(props: { content: string; status: 'running' | 'completed'; timestamp: string }) {
  const done = props.status === 'completed'
  const display = useMemo(() => formatThinkingContent(props.content), [props.content])

  return (
    <div className={`wf-tool-call ${done ? 'wf-tool-call--completed' : 'wf-tool-call--running'}`}>
      <div className="wf-tool-call-header">
        <div className={`wf-tool-call-icon ${done ? 'wf-tool-call-icon--completed' : 'wf-tool-call-icon--running'}`}>
          {done ? (
            <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2} />
          ) : (
            <div className="wf-breathing-spinner">
              <Cog className="h-3.5 w-3.5" strokeWidth={2} />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="wf-tool-call-name">Agent Thinking</div>
          <div className="wf-tool-call-meta">
            {done ? `Thought complete · ${props.timestamp}` : `Thinking... · ${props.timestamp}`}
          </div>
        </div>
        <div className={`wf-tool-call-status ${done ? 'wf-tool-call-status--completed' : 'wf-tool-call-status--running'}`}>
          {done ? <Check className="h-3.5 w-3.5" strokeWidth={2.2} /> : <Spin size={12} tone="#b07a2e" line={1.5} />}
          {done ? 'Done' : 'Thinking'}
        </div>
      </div>
      <div className="wf-tool-call-output wf-thinking-content whitespace-pre-wrap break-all">{display}</div>
    </div>
  )
})

/* ── Reasoning row ──
 *
 * Compact bar (icon · "reasoning" · duration · chevron) followed by
 * the body. Default is OPEN — the user said reasoning is the part
 * they actually want to see by default; tool calls can stay
 * collapsed because they're loud.
 *
 * Visual distinction from the tool strip: a subtle violet left
 * accent + brain icon. The whole component still uses the shell's
 * ink/dim tokens for typography, so it harmonises — it's just a
 * thin coloured bar that says "this is the model's chain-of-
 * thought" at a glance. No italic — italic was hurting CJK
 * readability. */
const ReasoningCard = memo(function ReasoningCard({ text, time }: { text: string; time?: { start: number; end?: number } }) {
  const duration = time?.end && time?.start ? `${((time.end - time.start) / 1000).toFixed(1)}s` : undefined
  const [open, setOpen] = useState(true)
  return (
    <div className={`wf-reasoning ${open ? "wf-reasoning--open" : ""}`}>
      <button
        type="button"
        className="wf-reasoning-head"
        onClick={() => setOpen((v) => !v)}
      >
        <Brain className="h-3 w-3 wf-reasoning-icon" strokeWidth={1.8} aria-hidden />
        <span className="wf-reasoning-label">reasoning</span>
        {duration && <span className="wf-reasoning-dur">{duration}</span>}
        <span className="wf-reasoning-spacer" />
        {open ? (
          <ChevronDown className="h-3 w-3 wf-reasoning-caret" strokeWidth={2} />
        ) : (
          <ChevronRight className="h-3 w-3 wf-reasoning-caret" strokeWidth={2} />
        )}
      </button>
      {/* Body — render through `Markdown` so reasoning that contains
        * lists, code blocks, headers etc. shows real structure instead
        * of a wall of plain text. The component already lives in this
        * file's imports for the agent bubble. */}
      {open && (
        <div className="wf-reasoning-body wf-reasoning-md break-words">
          <Markdown>{text}</Markdown>
        </div>
      )}
    </div>
  )
})

/* ── File card ── */
const FileCard = memo(function FileCard({ mime, filename, url }: { mime: string; filename?: string; url: string }) {
  const isImage = mime.startsWith('image/')
  return (
    <div className="wf-tool-call wf-tool-call--completed">
      <div className="wf-tool-call-header">
        <div className="wf-tool-call-icon wf-tool-call-icon--completed" style={{ background: 'rgba(96,136,193,0.08)', color: '#6088c1' }}>
          <FileText className="h-3.5 w-3.5" strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="wf-tool-call-name">{filename ?? 'File'}</div>
          <div className="wf-tool-call-meta">{mime}</div>
        </div>
      </div>
      {isImage && <div className="p-2"><img src={url} alt={filename} className="max-w-full rounded" style={{ maxHeight: 200 }} /></div>}
    </div>
  )
})

/* ── Patch card ── */
const PatchCard = memo(function PatchCard({ files }: { files: string[] }) {
  return (
    <div className="wf-tool-call wf-tool-call--completed">
      <div className="wf-tool-call-header">
        <div className="wf-tool-call-icon wf-tool-call-icon--completed" style={{ background: 'rgba(77,158,138,0.08)', color: 'var(--wf-ok)' }}>
          <GitBranch className="h-3.5 w-3.5" strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="wf-tool-call-name">Code Changes</div>
          <div className="wf-tool-call-meta">{files.length} file{files.length !== 1 ? 's' : ''} modified</div>
        </div>
      </div>
      <div className="wf-tool-call-output" style={{ fontFamily: '"Fira Code", monospace', fontSize: 11 }}>
        {files.map((f) => <div key={f}>{f}</div>)}
      </div>
    </div>
  )
})

/* ── Retry card ── */
const RetryCard = memo(function RetryCard({ attempt, error }: { attempt: number; error: string }) {
  return (
    <div className="wf-tool-call wf-tool-call--failed">
      <div className="wf-tool-call-header">
        <div className="wf-tool-call-icon wf-tool-call-icon--failed">
          <RotateCcw className="h-3.5 w-3.5" strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="wf-tool-call-name">Retry (attempt {attempt})</div>
          <div className="wf-tool-call-meta">{error}</div>
        </div>
      </div>
    </div>
  )
})

/* ── Step finish card ── */
const StepFinishCard = memo(function StepFinishCard({ reason, cost, tokens }: { reason: string; cost: number; tokens: { input: number; output: number } }) {
  return (
    <div className="wf-tool-call wf-tool-call--completed">
      <div className="wf-tool-call-header">
        <div className="wf-tool-call-icon wf-tool-call-icon--completed">
          <Zap className="h-3.5 w-3.5" strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="wf-tool-call-name">Step Complete</div>
          <div className="wf-tool-call-meta">
            {reason}{cost > 0 ? ` · $${cost.toFixed(4)}` : ''} · {tokens.input + tokens.output} tokens
          </div>
        </div>
      </div>
    </div>
  )
})

/* ── Collapsed tool strip ──
 *
 * Replaces the old card-per-tool layout for runs of consecutive tool
 * calls. The user explicitly asked for a "single line under thinking"
 * with a marquee-style view that doesn't flood the conversation, plus
 * an expand affordance to inspect each tool's actual command + result.
 *
 * Layout:
 *   [⚙] $ ls -la · read app.tsx · grep "foo" …          [3] [▸]
 *
 * The lane shows recent one-liners separated by ` · `; on overflow it
 * scrolls horizontally so the latest stays visible (auto-scroll-right
 * effect via scrollLeft on update). Click the chevron to expand into
 * a vertical list of compact `ToolCallCard`s, where each tool shows
 * its formatted input (command, file, …) and a preview of the actual
 * output (server return / bash stdout / etc.) — that's the "保留观察
 * 的入口" the user asked for. */
const ToolStrip = memo(function ToolStrip({ items, onDetail }: { items: Msg[]; onDetail?: (sessionId: string) => void }) {
  const [open, setOpen] = useState(false)
  const laneRef = useRef<HTMLDivElement>(null)
  const completed = items.filter((m) => m.toolCall?.status === "completed").length
  const failed = items.filter((m) => m.toolCall?.status === "failed").length
  const running = items.filter((m) => m.toolCall?.status === "running").length
  const total = items.length

  // Auto-scroll the lane to the right whenever a new tool one-liner
  // is appended, so the most recent action is always visible.
  useEffect(() => {
    const el = laneRef.current
    if (!el) return
    el.scrollLeft = el.scrollWidth
  }, [items.length, items[items.length - 1]?.toolCall?.status])

  return (
    <div
      className={`wf-tool-strip ${open ? "wf-tool-strip--open" : ""} ${running > 0 ? "wf-tool-strip--running" : ""}`}
      data-state={running > 0 ? "running" : failed > 0 ? "failed" : "completed"}
    >
      <button
        type="button"
        className="wf-tool-strip-head"
        onClick={() => setOpen((v) => !v)}
        title={open ? "收起工具调用" : "展开查看每次工具调用的实际命令与结果"}
      >
        <span className="wf-tool-strip-icon" aria-hidden>
          {running > 0 ? (
            <div className="wf-breathing-spinner">
              <Wrench className="h-3 w-3" strokeWidth={1.8} />
            </div>
          ) : failed > 0 ? (
            <XCircle className="h-3 w-3" strokeWidth={1.8} />
          ) : (
            <Wrench className="h-3 w-3" strokeWidth={1.8} />
          )}
        </span>
        <span className="wf-tool-strip-label">tools</span>
        <div className="wf-tool-strip-lane" ref={laneRef}>
          <div className="wf-tool-strip-track">
            {items.map((m, idx) => {
              const tc = m.toolCall!
              const line = toolOneLiner(tc.name, tc.input)
              return (
                <span
                  key={m.id}
                  className="wf-tool-strip-item"
                  data-status={tc.status}
                >
                  <span className="wf-tool-strip-item-text">{line}</span>
                  {idx < items.length - 1 && (
                    <span className="wf-tool-strip-sep" aria-hidden> · </span>
                  )}
                </span>
              )
            })}
          </div>
        </div>
        <span className="wf-tool-strip-count">
          {running > 0 && <span className="wf-tool-strip-count-dot" data-tone="run" aria-hidden />}
          {completed > 0 && <span>{completed}</span>}
          {failed > 0 && (
            <span className="wf-tool-strip-count-fail">×{failed}</span>
          )}
          <span className="wf-tool-strip-count-total">/{total}</span>
        </span>
        <span className="wf-tool-strip-caret" aria-hidden>
          {open ? <ChevronDown className="h-3 w-3" strokeWidth={2} /> : <ChevronRight className="h-3 w-3" strokeWidth={2} />}
        </span>
      </button>
      {open && (
        <div className="wf-tool-strip-body wf-fade-in">
          {items.map((item) => (
            <ToolCallCard
              key={item.id}
              tool={item.toolCall!}
              content={item.content}
              onDetail={onDetail}
            />
          ))}
        </div>
      )}
    </div>
  )
})

/* ── Group consecutive completed tool calls ── */
type GroupedItem =
  | { type: 'msg'; item: Msg }
  | { type: 'tool-group'; items: Msg[] }

function groupMessages(messages: Msg[]): GroupedItem[] {
  const result: GroupedItem[] = []
  let toolBuf: Msg[] = []

  // Always group consecutive tool calls into a strip — even one-tool
  // runs become a one-liner row instead of a full card. The user
  // doesn't want the chat to keep being flooded by tool boxes; the
  // strip preserves the observation entry-point via its expand button.
  const flushTools = () => {
    if (toolBuf.length === 0) return
    result.push({ type: 'tool-group', items: [...toolBuf] })
    toolBuf = []
  }

  for (const msg of messages) {
    if (msg.role === 'tool' && msg.toolCall) {
      toolBuf.push(msg)
    } else {
      flushTools()
      result.push({ type: 'msg', item: msg })
    }
  }
  flushTools()
  return result
}

/* ── Shortened path display ── */
function shortenPath(path: string): string {
  const parts = path.replace(/^\//, '').split('/')
  if (parts.length <= 3) return path
  return `.../${parts.slice(-2).join('/')}`
}

const MSG_PAGE_SIZE = 50

// Pre-computed, referentially stable inline-style objects for the
// staggered slide-up entrance animation. The first dozen rows fade in
// in sequence; older rows get `undefined` (handled at the call site)
// so React skips style reconciliation entirely on those nodes.
const rowAnimDelayStyles: ReadonlyArray<React.CSSProperties> = Array.from(
  { length: 12 },
  (_, i) => ({ animationDelay: `${i * 30}ms` }),
)

export function ChatPanel(props: Props) {
  const [msg, setMsg] = useState('')
  const [modelOpen, setModelOpen] = useState(false)
  // Separate dropdown state for the agent chip so model and agent
  // pickers don't fight for the same "open" flag. Previously the
  // master page only had a model chip; adding agent switching would
  // break keyboard-open semantics if both shared one flag.
  const [agentOpen, setAgentOpen] = useState(false)
  const [visibleCount, setVisibleCount] = useState(MSG_PAGE_SIZE)
  const composingRef = useRef(false)
  const end = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const agentDropRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const prevMsgCount = useRef(0)
  const initialMount = useRef(true)
  // Snapshot of scroll state right before a "Load earlier" action.
  // After the DOM re-lays-out (either via visibleCount bump or a
  // history prepend from the server), we restore scrollTop so the user
  // stays anchored on whatever they were reading — otherwise the list
  // would jerk to the top and the auto-scroll effect below would
  // mis-fire as if new messages had just arrived at the bottom.
  const pendingScrollRef = useRef<{ height: number; top: number } | null>(null)

  const slash = useSlashCommands({
    callbacks: {
      onSendMessage: props.onSendMessage,
      onNewSession: props.onNewSession,
      onModelPickerOpen: props.onModelPickerOpen,
      // Insert-action handler — fills the input with the command prefix
      // and lets the user keep typing. The popover onSelect below skips
      // its `setMsg('')` clear when the chosen command was an insert
      // command, so the prefix survives until the user hits Enter.
      onInsertText: (text) => {
        setMsg(text)
        // Defer focus + caret-to-end so React commits the value first.
        requestAnimationFrame(() => {
          const el = textareaRef.current
          if (!el) return
          el.style.height = 'auto'
          el.style.height = `${Math.min(el.scrollHeight, 120)}px`
          el.focus()
          el.setSelectionRange(text.length, text.length)
        })
      },
    },
    extraCommands: props.extraCommands,
  })

  const autoResize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [])

  /* Re-run autoResize ONLY when the textarea's parent WIDTH changes
   * (the inspector splitbar drag changes width; the canvas/chat splitbar
   * drag changes height — height changes must not trigger autoResize
   * because that creates a feedback loop where the composer appears to
   * "lift" / bounce. Watching the parent (not the textarea itself) avoids
   * the self-triggered loop. */
  useEffect(() => {
    const el = textareaRef.current
    const parent = el?.parentElement?.parentElement // .composer__field → .composer
    if (!el || !parent || typeof ResizeObserver === 'undefined') return
    let lastWidth = parent.clientWidth
    const ro = new ResizeObserver(() => {
      const w = parent.clientWidth
      if (w === lastWidth) return // height-only change → ignore
      lastWidth = w
      autoResize()
    })
    ro.observe(parent)
    return () => ro.disconnect()
  }, [autoResize])

  // Scroll: instant on first render or bulk load, smooth on incremental new messages
  // Only trigger when message count actually changes (not on reference changes)
  useEffect(() => {
    // Anchor-preserve path: the user asked for earlier messages, so
    // either the client window grew or the server returned a prepended
    // page. Both cases add DOM above the current viewport; without
    // restoring scrollTop the reader snaps to the top of the freshly
    // added block and the isBulk heuristic below would also wrongly
    // yank them to the bottom.
    const pending = pendingScrollRef.current
    if (pending) {
      pendingScrollRef.current = null
      const el = messagesRef.current
      if (el) {
        el.scrollTop = pending.top + (el.scrollHeight - pending.height)
      }
      prevMsgCount.current = props.messages.length
      initialMount.current = false
      return
    }

    const count = props.messages.length
    const prev = prevMsgCount.current
    const isInitial = initialMount.current

    if (count === prev && !isInitial) return // no new messages — don't touch scroll

    const isBulk = count - prev > 3
    prevMsgCount.current = count

    if (isInitial || isBulk) {
      // Jump instantly to bottom — no slow scroll through history
      initialMount.current = false
      messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight })
    } else if (count > prev) {
      // Smooth scroll only for genuinely new messages
      end.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [props.messages.length, visibleCount])

  // Close model dropdown on outside click
  useEffect(() => {
    if (!modelOpen) return
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as HTMLElement)) {
        setModelOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [modelOpen])

  // Close agent dropdown on outside click. Same pattern as the model
  // dropdown — separate handler so each chip only responds to its own
  // container. A shared handler would close one when the user clicked
  // into the other, losing focus mid-pick.
  useEffect(() => {
    if (!agentOpen) return
    const handler = (e: MouseEvent) => {
      if (agentDropRef.current && !agentDropRef.current.contains(e.target as HTMLElement)) {
        setAgentOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [agentOpen])

  const send = () => {
    if (!msg.trim()) return
    props.onSendMessage?.(msg)
    setMsg('')
    slash.closePopover()
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setMsg(val)
    autoResize()
    slash.handleInputChange(val)
    // If slash popover opens, close model dropdown
    if (val.startsWith('/')) setModelOpen(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const native = e.nativeEvent as KeyboardEvent & { isComposing?: boolean; keyCode?: number }
    if (composingRef.current || native.isComposing || native.keyCode === 229) {
      return
    }
    if (slash.popoverOpen) {
      const consumed = slash.handleKeyDown(e.key)
      if (consumed) {
        e.preventDefault()
        // Clear input after command is selected via keyboard
        if (e.key === 'Enter' || e.key === 'Tab') {
          setMsg('')
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto'
            textareaRef.current.focus()
          }
        }
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
      requestAnimationFrame(autoResize)
    }
  }

  const currentModel = props.model ?? props.models?.[0] ?? 'GPT-5.4'
  const modelList = props.models ?? ['GPT-5.4', 'GPT-5.4-turbo', 'Claude-3.5-Sonnet', 'Claude-3-Opus']
  // Agent picker resolves only when the parent actually provides a
  // non-empty candidate list. We intentionally don't seed a fallback
  // here (unlike the model chip) — in environments where no agents
  // list is threaded in, the chip stays hidden rather than shipping
  // fake values that would fail server-side as "agent not found".
  const agentList = props.agents && props.agents.length > 0 ? props.agents : undefined
  const currentAgent = props.agent ?? agentList?.[0]
  // Always show the chip when we know the current agent — it doubles
  // as a "what agent am I talking to right now" readout per the
  // product ask, even when only one agent is available. The dropdown
  // still opens in the single-agent case; users see the one option
  // and understand nothing is switchable yet.
  const showAgentChip = !!currentAgent

  return (
    <div className="wf-chat-root">
      {/* Accent top line */}
      <div className="absolute left-0 right-0 top-0 z-10 h-px bg-gradient-to-r from-transparent via-[var(--wf-ok)] to-transparent opacity-30" />

      {/* Header */}
      <div className="wf-chat-header">
        <div className="flex items-center gap-2.5">
          {/* Liveness indicator. The halo ring pulses only while the
            * LLM is actively producing a reply, so the dot reads as
            * "the agent is thinking right now" vs. "idle, waiting for
            * input". Previously the halo always pulsed, which made it
            * impossible to tell from the header whether the current
            * turn was still in flight — the user had to infer from
            * streamed tokens or the send-button icon swap. */}
          <div
            className="relative flex h-5 w-5 items-center justify-center"
            title={props.isRunning ? 'Agent is thinking…' : 'Idle'}
          >
            {props.isRunning && (
              <div className="absolute inset-0 rounded-full bg-[var(--wf-ok)] opacity-20 wf-pulse" />
            )}
            <div
              className="h-[6px] w-[6px] rounded-full"
              style={{
                background: props.isRunning ? 'var(--wf-ok)' : 'var(--wf-dim)',
                transition: 'background-color 160ms ease',
              }}
            />
          </div>
          <span className="text-[14px] font-bold tracking-[-0.01em] text-[var(--wf-ink)]">Agent Chat</span>

          {/* Active-loop badge. Explicit "Thinking" label with a spinner
            * gives a second redundant signal — useful because the dot
            * alone is easy to miss, and backends occasionally stall
            * mid-stream with no token output for 10s+. When the user
            * sees the badge they know the request is still in flight
            * and not silently dropped. Matches the pattern the v2
            * session page uses for its own status strip. */}
          {props.isRunning && (
            <div
              className="flex items-center gap-1.5 rounded-full border border-[color:var(--wf-ok)]/25 bg-[color:var(--wf-ok-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--wf-ok-strong)] wf-fade-in"
              role="status"
              aria-live="polite"
            >
              <Spin size={10} line={1.6} tone="var(--wf-ok-strong)" />
              <span>Thinking</span>
            </div>
          )}

          {/* Model selector — in header */}
          <div style={{ position: 'relative', zIndex: 70 }} ref={dropRef}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => setModelOpen((v) => !v)}
              onKeyDown={(e) => { if (e.key === 'Enter') setModelOpen((v) => !v) }}
              className={`wf-chat-model-chip ${modelOpen ? 'wf-chat-model-chip--open' : ''}`}
            >
              <Cpu className="h-3 w-3 flex-shrink-0" strokeWidth={1.8} />
              <span>{currentModel}</span>
              <ChevronDown className={`h-2.5 w-2.5 flex-shrink-0 transition-transform duration-200 ${modelOpen ? 'rotate-180' : ''}`} strokeWidth={2.5} />
            </div>
            {modelOpen && (
              <div className="wf-chat-model-dropdown wf-fade-in">
                {modelList.map((m) => (
                  <div
                    key={m}
                    role="button"
                    tabIndex={0}
                    onClick={() => { props.onModelChange?.(m); setModelOpen(false) }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { props.onModelChange?.(m); setModelOpen(false) } }}
                    className={`wf-chat-model-option ${m === currentModel ? 'wf-chat-model-option--active' : ''}`}
                  >
                    <span>{m}</span>
                    {m === currentModel && <Check className="h-3.5 w-3.5" strokeWidth={2.5} />}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Agent selector — in header, mirrors the model chip pattern.
            *
            * Why this exists: the master-agent page used to always route
            * the root session to `orchestrator`, which was appropriate
            * for long-chain workflow planning but wrong for the common
            * "just run a quick task" case. Exposing the agent here lets
            * the user pick any primary agent (e.g. `build` or a custom
            * agent) without leaving the workflow view.
            *
            * The chip also doubles as a live readout of which agent is
            * currently handling the root session, which was previously
            * invisible from the UI. */}
          {showAgentChip && (
            <div style={{ position: 'relative', zIndex: 70 }} ref={agentDropRef}>
              <div
                role="button"
                tabIndex={0}
                onClick={() => {
                  if (!agentList || !props.onAgentChange) return
                  setAgentOpen((v) => !v)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && agentList && props.onAgentChange) setAgentOpen((v) => !v)
                }}
                className={`wf-chat-model-chip ${agentOpen ? 'wf-chat-model-chip--open' : ''}`}
                title={
                  !props.onAgentChange
                    ? `Active agent: ${currentAgent}`
                    : !agentList || agentList.length <= 1
                      ? `Active agent: ${currentAgent} (no alternatives available)`
                      : `Switch root-session agent (currently ${currentAgent})`
                }
              >
                <Bot className="h-3 w-3 flex-shrink-0" strokeWidth={1.8} />
                <span>{currentAgent}</span>
                {agentList && agentList.length > 1 && props.onAgentChange && (
                  <ChevronDown
                    className={`h-2.5 w-2.5 flex-shrink-0 transition-transform duration-200 ${agentOpen ? 'rotate-180' : ''}`}
                    strokeWidth={2.5}
                  />
                )}
              </div>
              {agentOpen && agentList && props.onAgentChange && (
                <div className="wf-chat-model-dropdown wf-fade-in">
                  {agentList.map((a) => (
                    <div
                      key={a}
                      role="button"
                      tabIndex={0}
                      onClick={() => { props.onAgentChange?.(a); setAgentOpen(false) }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { props.onAgentChange?.(a); setAgentOpen(false) } }}
                      className={`wf-chat-model-option ${a === currentAgent ? 'wf-chat-model-option--active' : ''}`}
                    >
                      <span>{a}</span>
                      {a === currentAgent && <Check className="h-3.5 w-3.5" strokeWidth={2.5} />}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {props.workspace && (
            <div
              role="button"
              tabIndex={0}
              onClick={props.onWorkspaceClick}
              onKeyDown={(e) => { if (e.key === 'Enter') props.onWorkspaceClick?.() }}
              className="wf-chat-workspace"
            >
              <FolderOpen className="h-3 w-3 flex-shrink-0" strokeWidth={1.8} />
              <span>{shortenPath(props.workspace)}</span>
            </div>
          )}
          <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--wf-chip)] px-1.5 text-[10px] font-bold tabular-nums text-[var(--wf-dim)]">
            {props.messages.length}
          </span>
          {/* Header Stop removed — that action was a duplicate of the
           * top-bar Abort button (both went through hardControl("abort")).
           * The master-agent interrupt now lives on the input's send
           * button, which flips to a Stop icon while the agent is
           * running so the user can cancel the orchestrator mid-reply
           * without tearing down the whole workflow. */}
          {props.onSizeToggle && (
            <button
              className="wf-chat-height-toggle"
              onClick={props.onSizeToggle}
              title={props.chatHeight === 'tall' ? 'Shrink panel' : 'Expand panel'}
            >
              {props.chatHeight === 'tall'
                ? <Minimize2 className="h-3 w-3" strokeWidth={2} />
                : <Maximize2 className="h-3 w-3" strokeWidth={2} />}
            </button>
          )}
          {props.onHide && (
            <button
              className="wf-chat-height-toggle"
              onClick={props.onHide}
              title="Hide chat panel"
            >
              <X className="h-3 w-3" strokeWidth={2} />
            </button>
          )}
        </div>
      </div>

      {/* Waiting for input banner */}
      {props.waitingForInput && (
        <div className="wf-chat-waiting-banner wf-slide-up">
          <div className="wf-chat-waiting-icon">
            <MessageCircle className="h-4 w-4" strokeWidth={2} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-[var(--wf-ink)]">Waiting for your response</div>
            <div className="text-[11.5px] text-[var(--wf-dim)] mt-0.5">The agent needs your input to continue. Check the latest message and reply below.</div>
          </div>
        </div>
      )}

      {/* Input-only mode surfaces a compact monitor where the message
       * list normally lives, so the user sees the master agent's most
       * recent reasoning without the full chat taking over the
       * viewport. Hidden when there's nothing to monitor yet. */}
      {props.chatHeight === 'input-only' && (
        <div className="wf-chat-monitor">
          <div className="wf-chat-monitor__header">
            <span className="wf-chat-monitor__dot" />
            <span className="wf-chat-monitor__label">
              {props.monitorLabel ?? 'Master agent · latest thought'}
            </span>
            <span className="wf-chat-monitor__hint">history visible below</span>
            {props.monitorPlanMsgId && props.onPlanOpen && (
              <button
                className="wf-chat-monitor__plan-btn"
                onClick={() => props.onPlanOpen?.(props.monitorPlanMsgId!)}
                title="Re-open the current workflow plan"
              >
                <GitBranch className="h-3 w-3" strokeWidth={2} />
                <span>Plan</span>
              </button>
            )}
          </div>
          <div className="wf-chat-monitor__body">
            {props.monitorText?.trim()
              ? <pre className="wf-chat-monitor__text">{props.monitorText}</pre>
              : <div className="wf-chat-monitor__empty">Waiting for first agent output…</div>}
          </div>
        </div>
      )}

      {/* Messages — always visible. Previous builds hid the list
       * entirely in input-only mode, but that made the user's own
       * message and the master's reply disappear the moment the
       * workflow flipped to running, which the user experienced as
       * "I sent something and the agent never responded". In
       * input-only mode we now just rely on the shorter chat height
       * (188px) to keep the canvas the primary focus while still
       * letting recent messages stay scroll-visible. */}
      <div
        className="wf-chat-messages"
        ref={messagesRef}
      >
        {(() => {
          // Hide internal orchestration prompts from the chat. These are
          // long JSON+prompt blobs that workflow-panel.tsx generates when
          // the user clicks "Create graph", "Run", or approves a plan —
          // they're necessary instructions to the LLM but render as
          // confusing user text in chat. We detect them by the canonical
          // first-line markers used by `runApprovedPlan` / `executeWorkflow`
          // / `revisePlanWithContext` (workflow-panel.tsx). Add a new
          // marker here when a new internal-send call is added.
          const INTERNAL_PROMPT_MARKERS = [
            'The user approved this workflow plan',
            'Create the workflow graph from the latest approved plan',
            'Execution routing is confirmed for workflow node',
            'Revise the current workflow plan using this additional context',
          ]
          const visibleMessages = props.messages.filter((m) => {
            if (m.role !== 'user') return true
            const head = (m.content ?? '').split('\n', 1)[0] ?? ''
            return !INTERNAL_PROMPT_MARKERS.some((p) => head.startsWith(p))
          })
          const allGroups = groupMessages(visibleMessages)
          const truncated = allGroups.length > visibleCount
          const groups = truncated ? allGroups.slice(-visibleCount) : allGroups
          // The button serves two staged purposes:
          //   1. Reveal more of what's already in memory (client-side window
          //      bump) — fast, no network.
          //   2. Once every in-memory group is visible and the server still
          //      has older turns, fetch the next page via onLoadMoreHistory.
          // Without (2), long master sessions stopped at 80 messages and the
          // user couldn't scroll back to the start of the conversation.
          const canReveal = truncated
          const canFetchMore = !truncated && !!props.historyHasMore
          const loading = !!props.historyLoading
          const showButton = canReveal || canFetchMore || loading
          const handleLoad = () => {
            // Snapshot scroll state before the expansion / fetch so the
            // useEffect can restore the viewport anchor after re-layout.
            const el = messagesRef.current
            if (el) pendingScrollRef.current = { height: el.scrollHeight, top: el.scrollTop }
            if (canReveal) {
              setVisibleCount((v) => v + MSG_PAGE_SIZE)
              return
            }
            if (canFetchMore) props.onLoadMoreHistory?.()
          }
          return (<>
            {showButton && (
              <button
                className="wf-load-earlier"
                onClick={handleLoad}
                disabled={loading}
              >
                {loading
                  ? 'Loading earlier messages…'
                  : canReveal
                    ? `Load ${Math.min(MSG_PAGE_SIZE, allGroups.length - visibleCount)} earlier messages`
                    : 'Load earlier messages from server'}
              </button>
            )}
            {groups.map((group, i) => {
          // Cap the entrance-animation stagger to the first dozen rows.
          // After that, returning `undefined` keeps the style prop
          // referentially stable so React skips the style-diff work on
          // every keystroke / scroll re-render.
          const delayStyle = i < 12 ? rowAnimDelayStyles[i] : undefined
          // ── Tool strip (collapsed marquee) — left ──
          if (group.type === 'tool-group') {
            // Anchor the key on the first message ID instead of the
            // positional index — otherwise inserting a single new
            // message above shifts every group's key and forces React
            // to re-mount the ToolStrip subtree (and lose its
            // open/scroll state).
            const tgKey = group.items[0]?.id ?? `tg-${i}`
            return (
              <div key={tgKey} className="wf-msg-row wf-msg-row--left wf-slide-up" style={delayStyle}>
                <div className="wf-msg-left-content">
                  <ToolStrip items={group.items} onDetail={props.onTaskDetail} />
                </div>
              </div>
            )
          }
          const item = group.item

          // ── Question dialog — left ──
          if (item.question) {
            return (
              <div key={item.id} className="wf-msg-row wf-msg-row--left wf-slide-up" style={delayStyle}>
                <div className="wf-msg-left-content">
                  <QuestionDialog
                    request={item.question}
                    onReply={props.onQuestionReply ?? (() => {})}
                    onReject={props.onQuestionReject ?? (() => {})}
                  />
                </div>
              </div>
            )
          }

          // ── Permission dialog — left ──
          if (item.permission) {
            return (
              <div key={item.id} className="wf-msg-row wf-msg-row--left wf-slide-up" style={delayStyle}>
                <div className="wf-msg-left-content">
                  <PermissionDialog
                    request={item.permission}
                    onReply={props.onPermissionReply ?? (() => {})}
                  />
                </div>
              </div>
            )
          }

          // ── Plan card — left ──
          // When `renderPlanAsChip` is set, the parent owns a modal
          // overlay for the full plan view and we render only a
          // compact chip in the chat stream. Clicking the chip asks
          // the parent to re-open the overlay for this plan. This
          // keeps the scrolling chat readable even after several
          // revisions of the plan accumulate.
          if (item.plan) {
            if (props.renderPlanAsChip) {
              return (
                <div key={item.id} className="wf-msg-row wf-msg-row--left wf-slide-up" style={delayStyle}>
                  <div className="wf-msg-left-content">
                    <button
                      className="wf-plan-chip"
                      onClick={() => props.onPlanOpen?.(item.id)}
                      title="Re-open workflow plan"
                    >
                      <GitBranch className="h-3.5 w-3.5" strokeWidth={1.8} />
                      <span className="wf-plan-chip__label">Workflow Plan</span>
                      <span className="wf-plan-chip__meta">
                        {item.plan.nodes.length} nodes · {item.plan.checkpoints.length} checkpoints
                      </span>
                      <span className="wf-plan-chip__cta">Open</span>
                    </button>
                  </div>
                </div>
              )
            }
            return (
              <div key={item.id} className="wf-msg-row wf-msg-row--left wf-slide-up" style={delayStyle}>
                <div className="wf-msg-left-content">
                  <PlanCard
                    plan={item.plan}
                    onRun={props.onPlanRun}
                    onEdit={(context) => props.onPlanEdit?.(context)}
                  />
                </div>
              </div>
            )
          }

          // ── Reasoning — left ──
          if (item.reasoning) {
            return (
              <div key={item.id} className="wf-msg-row wf-msg-row--left wf-slide-up" style={delayStyle}>
                <div className="wf-msg-left-content">
                  <ReasoningCard text={item.reasoning.text} time={item.reasoning.time} />
                </div>
              </div>
            )
          }

          // ── File — left ──
          if (item.file) {
            return (
              <div key={item.id} className="wf-msg-row wf-msg-row--left wf-slide-up" style={delayStyle}>
                <div className="wf-msg-left-content">
                  <FileCard mime={item.file.mime} filename={item.file.filename} url={item.file.url} />
                </div>
              </div>
            )
          }

          // ── Patch (code changes) — left ──
          if (item.patch) {
            return (
              <div key={item.id} className="wf-msg-row wf-msg-row--left wf-slide-up" style={delayStyle}>
                <div className="wf-msg-left-content">
                  <PatchCard files={item.patch.files} />
                </div>
              </div>
            )
          }

          // ── Retry — left ──
          if (item.retry) {
            return (
              <div key={item.id} className="wf-msg-row wf-msg-row--left wf-slide-up" style={delayStyle}>
                <div className="wf-msg-left-content">
                  <RetryCard attempt={item.retry.attempt} error={item.retry.error} />
                </div>
              </div>
            )
          }

          // ── Step finish — left ──
          if (item.stepFinish) {
            return (
              <div key={item.id} className="wf-msg-row wf-msg-row--left wf-slide-up" style={delayStyle}>
                <div className="wf-msg-left-content">
                  <StepFinishCard reason={item.stepFinish.reason} cost={item.stepFinish.cost} tokens={item.stepFinish.tokens} />
                </div>
              </div>
            )
          }

          // ── Agent switch — left (minimal) ──
          if (item.agent) {
            return (
              <div key={item.id} className="wf-msg-row wf-msg-row--left wf-slide-up" style={delayStyle}>
                <div className="wf-msg-left-content">
                  <div className="flex items-center gap-2 px-2 py-1 text-[11px] text-[var(--wf-dim)]">
                    <Bot className="h-3 w-3" strokeWidth={2} />
                    <span>Agent switched to <strong className="text-[var(--wf-ink-soft)]">@{item.agent.name}</strong></span>
                  </div>
                </div>
              </div>
            )
          }

          // ── Subtask — left ──
          if (item.subtask) {
            return (
              <div key={item.id} className="wf-msg-row wf-msg-row--left wf-slide-up" style={delayStyle}>
                <div className="wf-msg-left-content">
                  <div className="wf-tool-call wf-tool-call--running wf-tool-call--task">
                    <div className="wf-tool-call-header">
                      <div className="wf-tool-call-icon wf-tool-call-icon--running">
                        <div className="wf-breathing-spinner"><Bot className="h-3.5 w-3.5" strokeWidth={2} /></div>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="wf-tool-call-name">{item.subtask.description}</div>
                        <div className="wf-tool-call-meta">
                          <span className="wf-tool-call-agent">@{item.subtask.agent}</span>
                          Subtask
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )
          }

          // ── Thinking — left ──
          if (item.role === 'assistant' && item.thinking) {
            return (
              <div key={item.id} className="wf-msg-row wf-msg-row--left wf-slide-up" style={delayStyle}>
                <div className="wf-msg-left-content">
                  <ThinkingCard content={item.content} status={item.thinking.status} timestamp={item.timestamp} />
                </div>
              </div>
            )
          }

          // ── Tool call — left ──
          if (item.role === 'tool' && item.toolCall) {
            return (
              <div key={item.id} className="wf-msg-row wf-msg-row--left wf-slide-up" style={delayStyle}>
                <div className="wf-msg-left-content">
                  <ToolCallCard tool={item.toolCall} content={item.content} onDetail={props.onTaskDetail} />
                </div>
              </div>
            )
          }

          // ── User message — right ──
          if (item.role === 'user') {
            return (
              <div key={item.id} className="wf-msg-row wf-msg-row--right wf-slide-up" style={delayStyle}>
                <div className="wf-msg-meta wf-msg-meta--right">
                  <span className="wf-msg-time">{item.timestamp}</span>
                  <span className="wf-msg-name">You</span>
                </div>
                <div className="wf-msg-bubble wf-msg-bubble--user">
                  <p className="whitespace-pre-wrap break-words">
                    <FormattedContent text={item.content} />
                  </p>
                </div>
              </div>
            )
          }

          // ── Assistant / system — left ──
          const isSystem = item.role === 'system'
          return (
            <div key={item.id} className="wf-msg-row wf-msg-row--left wf-slide-up" style={delayStyle}>
              <div className="wf-msg-avatar" style={{ background: roleStyle[item.role].iconBg }}>
                {(() => { const Icon = icons[item.role]; return <Icon className="h-3.5 w-3.5" strokeWidth={1.8} style={{ color: roleStyle[item.role].iconColor }} /> })()}
              </div>
              <div className="wf-msg-body">
                <div className="wf-msg-meta wf-msg-meta--left">
                  <span className="wf-msg-name" style={{ color: roleStyle[item.role].iconColor }}>{names[item.role]}</span>
                  <span className="wf-msg-time">{item.timestamp}</span>
                </div>
                <div className={`wf-msg-bubble wf-msg-bubble--agent${isSystem ? ' wf-msg-bubble--system' : ''}`}>
                  <Markdown>{item.content}</Markdown>
                </div>
              </div>
            </div>
          )
        })}
        </>)
        })()}
        <div ref={end} />
      </div>

      {/* Input */}
      <div className="wf-chat-input-bar">
        {/* Composer chips — real built-in slash commands surfaced as
          * one-click chips so the user doesn't need to type `/`. Each
          * chip inserts its trigger into the textarea and focuses it;
          * the existing slash-command popover handles resolution from
          * there.
          *
          * The design template's prototype chips were /plan, /retrieve,
          * /tool, attach — those weren't backed by real commands in this
          * runtime. We now show the actual server-registered commands
          * (compact / fork / new / model / undo / redo) plus /notrack
          * as the privacy opt-out, capped to 4 to keep the row tidy. */}
        <div className="wf-chat-chips" aria-label="Quick commands">
          {(['compact', 'fork', 'notrack', 'model'] as const).map((cmd) => (
            <button
              key={cmd}
              type="button"
              className="wf-chat-chip"
              onClick={() => {
                setMsg('/' + cmd + ' ')
                if (textareaRef.current) {
                  textareaRef.current.focus()
                  textareaRef.current.style.height = 'auto'
                  textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`
                }
              }}
              title={
                cmd === 'compact' ? 'Compact: summarise + compress this conversation'
                : cmd === 'fork' ? 'Fork this session into a new branch'
                : cmd === 'notrack' ? 'Send this turn without recording it to the experience library'
                : 'Open the model picker'
              }
            >
              /{cmd}
            </button>
          ))}
        </div>
        <div className="wf-chat-input-wrap" style={{ position: 'relative' }}>
          {/* Slash popover — floats above the input bar */}
          <SlashPopover
            open={slash.popoverOpen}
            commands={slash.filtered}
            activeId={slash.activeId}
            onSelect={(cmd) => {
              slash.executeCommand(cmd)
              // For 'insert' commands, executeCommand has already populated
              // the input via onInsertText — clearing it here would undo
              // that. Only clear for send / local commands.
              if (cmd.action !== 'insert') {
                setMsg('')
                if (textareaRef.current) {
                  textareaRef.current.style.height = 'auto'
                  textareaRef.current.focus()
                }
              }
            }}
            onHover={slash.setActiveId}
          />

          <textarea
            ref={textareaRef}
            value={msg}
            rows={1}
            onChange={handleChange}
            onCompositionStart={() => {
              composingRef.current = true
            }}
            onCompositionEnd={() => {
              composingRef.current = false
            }}
            onKeyDown={handleKeyDown}
            onBlur={() => {
              // Delay so click on slash popover item fires before blur closes it
              setTimeout(() => slash.closePopover(), 150)
            }}
            placeholder="Message the agent... (/ for commands)"
            className="wf-chat-input"
          />
          {props.isRunning && props.onStop ? (
            // While the master agent is running, the right-side button
            // becomes a Stop control: tapping it aborts only the root
            // (orchestrator) session so the user can interrupt a reply
            // without tearing down child node executions. The top-bar
            // Abort button is still the escape hatch for the full
            // workflow.
            <button
              onClick={props.onStop}
              className="wf-chat-send wf-chat-send--stop"
              title="Stop master agent"
              aria-label="Stop master agent"
            >
              <Square className="h-3 w-3" strokeWidth={0} fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={send}
              disabled={!msg.trim()}
              className="wf-chat-send"
              aria-label="Send message"
            >
              <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
