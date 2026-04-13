/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp, Bot, Terminal, User, Wrench, ChevronDown, ChevronRight, ChevronUp, Check,
  FolderOpen, Cpu, Cog, CheckCircle2, XCircle, Loader2, Eye, MessageCircle,
  Maximize2, Minimize2, X, FileText, GitBranch, RotateCcw, Brain, Zap, Square,
} from 'lucide-react'
import { Spin } from './spin'
import { SlashPopover } from './slash-popover'
import { PlanCard, type WorkflowPlan } from './plan-card'
import { SandTableCard, type SandTableResult } from './sand-table-card'
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

interface Msg {
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
  /** When present, renders a sand table discussion card */
  sandTable?: SandTableResult
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
  onPlanRun?: () => void
  onPlanEdit?: (context: string) => void
  /** Session control */
  isRunning?: boolean
  onStop?: () => void
  /** Height controls */
  chatHeight?: 'tall' | 'short' | 'hidden'
  onSizeToggle?: () => void   // toggle tall ↔ short
  onHide?: () => void          // collapse to hidden
  onRestore?: () => void       // restore from hidden
  /** Question/Permission callbacks */
  onQuestionReply?: (requestID: string, answers: string[][]) => void
  onQuestionReject?: (requestID: string) => void
  onPermissionReply?: (requestID: string, reply: PermissionReply, message?: string) => void
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

/* ── Tool call card ── */
export function ToolCallCard({ tool, content, onDetail }: { tool: ToolCall; content: string; onDetail?: (sessionId: string) => void }) {
  const display = useMemo(() => formatToolContent(tool.name, content), [tool.name, content])
  const isTask = tool.name === 'task'
  const taskDesc = isTask && tool.input?.description ? String(tool.input.description) : undefined
  const taskAgent = isTask && tool.input?.subagent_type ? String(tool.input.subagent_type) : undefined

  return (
    <div className={`wf-tool-call wf-tool-call--${tool.status} ${isTask ? 'wf-tool-call--task' : ''}`}>
      <div className="wf-tool-call-header">
        <div className={`wf-tool-call-icon wf-tool-call-icon--${tool.status}`}>
          {tool.status === 'running' ? (
            <div className="wf-breathing-spinner">
              {isTask ? <Bot className="h-3.5 w-3.5" strokeWidth={2} /> : <Cog className="h-3.5 w-3.5" strokeWidth={2} />}
            </div>
          ) : tool.status === 'completed' ? (
            <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2} />
          ) : (
            <XCircle className="h-3.5 w-3.5" strokeWidth={2} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="wf-tool-call-name">
            {isTask ? (taskDesc ?? 'Subagent Task') : tool.name}
          </div>
          <div className="wf-tool-call-meta">
            {isTask && taskAgent && <span className="wf-tool-call-agent">@{taskAgent}</span>}
            {tool.status === 'running' ? (isTask ? 'Agent working...' : 'Executing...') :
             tool.status === 'completed' ? `Done${tool.duration ? ` · ${tool.duration}` : ''}` :
             'Failed'}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isTask && tool.sessionId && onDetail && (
            <button
              className="wf-tool-call-detail-btn"
              onClick={() => onDetail(tool.sessionId!)}
              title="View subagent session"
            >
              <Eye className="h-3 w-3" strokeWidth={2} />
              Detail
            </button>
          )}
          <div className={`wf-tool-call-status wf-tool-call-status--${tool.status}`}>
            {tool.status === 'running' && <Spin size={12} tone={isTask ? 'var(--wf-ok)' : '#b07a2e'} line={1.5} />}
            {tool.status === 'running' ? 'Running' :
             tool.status === 'completed' ? 'Done' : 'Error'}
          </div>
        </div>
      </div>

      {display && (
        <div className="wf-tool-call-output whitespace-pre-wrap break-all">{display}</div>
      )}
    </div>
  )
}

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

export function ThinkingCard(props: { content: string; status: 'running' | 'completed'; timestamp: string }) {
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
}

/* ── Reasoning card ── */
function ReasoningCard({ text, time }: { text: string; time?: { start: number; end?: number } }) {
  const duration = time?.end && time?.start ? `${((time.end - time.start) / 1000).toFixed(1)}s` : undefined
  return (
    <div className="wf-tool-call wf-tool-call--completed">
      <div className="wf-tool-call-header">
        <div className="wf-tool-call-icon wf-tool-call-icon--completed" style={{ background: 'rgba(138,116,193,0.08)', color: '#8a74c1' }}>
          <Brain className="h-3.5 w-3.5" strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="wf-tool-call-name">Reasoning</div>
          <div className="wf-tool-call-meta">{duration ? `${duration}` : 'Internal reasoning'}</div>
        </div>
      </div>
      <div className="wf-tool-call-output whitespace-pre-wrap break-all">{text}</div>
    </div>
  )
}

/* ── File card ── */
function FileCard({ mime, filename, url }: { mime: string; filename?: string; url: string }) {
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
}

/* ── Patch card ── */
function PatchCard({ files }: { files: string[] }) {
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
}

/* ── Retry card ── */
function RetryCard({ attempt, error }: { attempt: number; error: string }) {
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
}

/* ── Step finish card ── */
function StepFinishCard({ reason, cost, tokens }: { reason: string; cost: number; tokens: { input: number; output: number } }) {
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
}

/* ── Collapsed tool call group ── */
function ToolCallGroup({ items, onDetail }: { items: Msg[]; onDetail?: (sessionId: string) => void }) {
  const [open, setOpen] = useState(false)
  const completed = items.filter(m => m.toolCall?.status === 'completed').length
  const failed = items.filter(m => m.toolCall?.status === 'failed').length
  const toolNames = items.map(m => m.toolCall?.name ?? '').filter(Boolean)
  const uniqueNames = [...new Set(toolNames)]
  const preview = uniqueNames.slice(0, 3).join(', ') + (uniqueNames.length > 3 ? ` +${uniqueNames.length - 3}` : '')

  return (
    <div className="wf-tool-group">
      <button
        className="wf-tool-group-header"
        onClick={() => setOpen(v => !v)}
      >
        <div className="wf-tool-group-icon">
          <Wrench className="h-3.5 w-3.5" strokeWidth={1.8} />
        </div>
        <div className="min-w-0 flex-1">
          <span className="wf-tool-group-title">
            {items.length} tool calls
          </span>
          <span className="wf-tool-group-summary">{preview}</span>
        </div>
        <div className="wf-tool-group-badges">
          {completed > 0 && (
            <span className="wf-tool-group-badge wf-tool-group-badge--ok">
              <CheckCircle2 className="h-3 w-3" strokeWidth={2} />
              {completed}
            </span>
          )}
          {failed > 0 && (
            <span className="wf-tool-group-badge wf-tool-group-badge--bad">
              <XCircle className="h-3 w-3" strokeWidth={2} />
              {failed}
            </span>
          )}
        </div>
        {open
          ? <ChevronDown className="h-3.5 w-3.5 text-[var(--wf-dim)] flex-shrink-0" strokeWidth={2} />
          : <ChevronRight className="h-3.5 w-3.5 text-[var(--wf-dim)] flex-shrink-0" strokeWidth={2} />
        }
      </button>
      {open && (
        <div className="wf-tool-group-body wf-fade-in">
          {items.map(item => (
            <ToolCallCard key={item.id} tool={item.toolCall!} content={item.content} onDetail={onDetail} />
          ))}
        </div>
      )}
    </div>
  )
}

/* ── Group consecutive completed tool calls ── */
type GroupedItem =
  | { type: 'msg'; item: Msg }
  | { type: 'tool-group'; items: Msg[] }

function groupMessages(messages: Msg[]): GroupedItem[] {
  const result: GroupedItem[] = []
  let toolBuf: Msg[] = []

  const flushTools = () => {
    if (toolBuf.length === 0) return
    if (toolBuf.length >= 3 && toolBuf.every(m => m.toolCall?.status !== 'running')) {
      result.push({ type: 'tool-group', items: [...toolBuf] })
    } else {
      toolBuf.forEach(item => result.push({ type: 'msg', item }))
    }
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

export function ChatPanel(props: Props) {
  const [msg, setMsg] = useState('')
  const [modelOpen, setModelOpen] = useState(false)
  const [visibleCount, setVisibleCount] = useState(MSG_PAGE_SIZE)
  const end = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const prevMsgCount = useRef(0)
  const initialMount = useRef(true)

  const slash = useSlashCommands({
    callbacks: {
      onSendMessage: props.onSendMessage,
      onNewSession: props.onNewSession,
      onModelPickerOpen: props.onModelPickerOpen,
    },
    extraCommands: props.extraCommands,
  })

  const autoResize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [])

  // Scroll: instant on first render or bulk load, smooth on incremental new messages
  // Only trigger when message count actually changes (not on reference changes)
  useEffect(() => {
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
  }, [props.messages.length])

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

  return (
    <div className="wf-chat-root">
      {/* Accent top line */}
      <div className="absolute left-0 right-0 top-0 z-10 h-px bg-gradient-to-r from-transparent via-[var(--wf-ok)] to-transparent opacity-30" />

      {/* Header */}
      <div className="wf-chat-header">
        <div className="flex items-center gap-2.5">
          <div className="relative flex h-5 w-5 items-center justify-center">
            <div className="absolute inset-0 rounded-full bg-[var(--wf-ok)] opacity-15 wf-pulse" />
            <div className="h-[6px] w-[6px] rounded-full bg-[var(--wf-ok)]" />
          </div>
          <span className="text-[14px] font-bold tracking-[-0.01em] text-[var(--wf-ink)]">Agent Chat</span>

          {/* Model selector — in header */}
          <div style={{ position: 'relative' }} ref={dropRef}>
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
              <div className="wf-chat-model-dropdown wf-fade-in" style={{ top: '100%', marginTop: 4 }}>
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
          {/* Stop button — visible when running */}
          {props.isRunning && props.onStop && (
            <button
              className="wf-chat-stop-btn"
              onClick={props.onStop}
              title="Stop agent"
            >
              <Square className="h-2.5 w-2.5" strokeWidth={0} fill="currentColor" />
              <span>Stop</span>
            </button>
          )}
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

      {/* Messages */}
      <div className="wf-chat-messages" ref={messagesRef}>
        {(() => {
          const allGroups = groupMessages(props.messages)
          const truncated = allGroups.length > visibleCount
          const groups = truncated ? allGroups.slice(-visibleCount) : allGroups
          return (<>
            {truncated && (
              <button
                className="wf-load-earlier"
                onClick={() => setVisibleCount((v) => v + MSG_PAGE_SIZE)}
              >
                Load {Math.min(MSG_PAGE_SIZE, allGroups.length - visibleCount)} earlier messages
              </button>
            )}
            {groups.map((group, i) => {
          // ── Tool group (collapsed) — left ──
          if (group.type === 'tool-group') {
            return (
              <div key={`tg-${i}`} className="wf-msg-row wf-msg-row--left wf-slide-up" style={{ animationDelay: `${i * 30}ms` }}>
                <div className="wf-msg-left-content">
                  <ToolCallGroup items={group.items} onDetail={props.onTaskDetail} />
                </div>
              </div>
            )
          }
          const item = group.item

          // ── Sand table card — left ──
          if (item.sandTable) {
            return (
              <div key={item.id} className="wf-msg-row wf-msg-row--left wf-slide-up" style={{ animationDelay: `${i * 30}ms` }}>
                <div className="wf-msg-left-content">
                  <SandTableCard result={item.sandTable} />
                </div>
              </div>
            )
          }

          // ── Question dialog — left ──
          if (item.question) {
            return (
              <div key={item.id} className="wf-msg-row wf-msg-row--left wf-slide-up" style={{ animationDelay: `${i * 30}ms` }}>
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
              <div key={item.id} className="wf-msg-row wf-msg-row--left wf-slide-up" style={{ animationDelay: `${i * 30}ms` }}>
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
          if (item.plan) {
            return (
              <div key={item.id} className="wf-msg-row wf-msg-row--left wf-slide-up" style={{ animationDelay: `${i * 30}ms` }}>
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
              <div key={item.id} className="wf-msg-row wf-msg-row--left wf-slide-up" style={{ animationDelay: `${i * 30}ms` }}>
                <div className="wf-msg-left-content">
                  <ReasoningCard text={item.reasoning.text} time={item.reasoning.time} />
                </div>
              </div>
            )
          }

          // ── File — left ──
          if (item.file) {
            return (
              <div key={item.id} className="wf-msg-row wf-msg-row--left wf-slide-up" style={{ animationDelay: `${i * 30}ms` }}>
                <div className="wf-msg-left-content">
                  <FileCard mime={item.file.mime} filename={item.file.filename} url={item.file.url} />
                </div>
              </div>
            )
          }

          // ── Patch (code changes) — left ──
          if (item.patch) {
            return (
              <div key={item.id} className="wf-msg-row wf-msg-row--left wf-slide-up" style={{ animationDelay: `${i * 30}ms` }}>
                <div className="wf-msg-left-content">
                  <PatchCard files={item.patch.files} />
                </div>
              </div>
            )
          }

          // ── Retry — left ──
          if (item.retry) {
            return (
              <div key={item.id} className="wf-msg-row wf-msg-row--left wf-slide-up" style={{ animationDelay: `${i * 30}ms` }}>
                <div className="wf-msg-left-content">
                  <RetryCard attempt={item.retry.attempt} error={item.retry.error} />
                </div>
              </div>
            )
          }

          // ── Step finish — left ──
          if (item.stepFinish) {
            return (
              <div key={item.id} className="wf-msg-row wf-msg-row--left wf-slide-up" style={{ animationDelay: `${i * 30}ms` }}>
                <div className="wf-msg-left-content">
                  <StepFinishCard reason={item.stepFinish.reason} cost={item.stepFinish.cost} tokens={item.stepFinish.tokens} />
                </div>
              </div>
            )
          }

          // ── Agent switch — left (minimal) ──
          if (item.agent) {
            return (
              <div key={item.id} className="wf-msg-row wf-msg-row--left wf-slide-up" style={{ animationDelay: `${i * 30}ms` }}>
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
              <div key={item.id} className="wf-msg-row wf-msg-row--left wf-slide-up" style={{ animationDelay: `${i * 30}ms` }}>
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
              <div key={item.id} className="wf-msg-row wf-msg-row--left wf-slide-up" style={{ animationDelay: `${i * 30}ms` }}>
                <div className="wf-msg-left-content">
                  <ThinkingCard content={item.content} status={item.thinking.status} timestamp={item.timestamp} />
                </div>
              </div>
            )
          }

          // ── Tool call — left ──
          if (item.role === 'tool' && item.toolCall) {
            return (
              <div key={item.id} className="wf-msg-row wf-msg-row--left wf-slide-up" style={{ animationDelay: `${i * 30}ms` }}>
                <div className="wf-msg-left-content">
                  <ToolCallCard tool={item.toolCall} content={item.content} onDetail={props.onTaskDetail} />
                </div>
              </div>
            )
          }

          // ── User message — right ──
          if (item.role === 'user') {
            return (
              <div key={item.id} className="wf-msg-row wf-msg-row--right wf-slide-up" style={{ animationDelay: `${i * 30}ms` }}>
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
            <div key={item.id} className="wf-msg-row wf-msg-row--left wf-slide-up" style={{ animationDelay: `${i * 30}ms` }}>
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
        <div className="wf-chat-input-wrap" style={{ position: 'relative' }}>
          {/* Slash popover — floats above the input bar */}
          <SlashPopover
            open={slash.popoverOpen}
            commands={slash.filtered}
            activeId={slash.activeId}
            onSelect={(cmd) => {
              slash.executeCommand(cmd)
              setMsg('')
              if (textareaRef.current) {
                textareaRef.current.style.height = 'auto'
                textareaRef.current.focus()
              }
            }}
            onHover={slash.setActiveId}
          />

          <textarea
            ref={textareaRef}
            value={msg}
            rows={1}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onBlur={() => {
              // Delay so click on slash popover item fires before blur closes it
              setTimeout(() => slash.closePopover(), 150)
            }}
            placeholder="Message the agent... (/ for commands)"
            className="wf-chat-input"
          />
          <button
            onClick={send}
            disabled={!msg.trim()}
            className="wf-chat-send"
          >
            <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.5} />
          </button>
        </div>
      </div>
    </div>
  )
}
