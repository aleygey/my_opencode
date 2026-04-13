/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState } from 'react'
import { diffLines } from 'diff'
import {
  ArrowLeft, ArrowUp, Bot, Cpu, Activity, Timer, Play, RotateCcw,
  Square, StepForward, Terminal, User, Wrench, CheckCircle2,
  FileCode2, Layers, Sparkles, Radio, Clock, Zap, Hash,
} from 'lucide-react'
import type { Detail, Status } from '../app'
import { ThinkingCard, ToolCallCard, FormattedContent, type ToolCall } from './chat-panel'
import { SplitBar, useSplit } from './split'
import { Spin } from './spin'

type Role = 'system' | 'assistant' | 'user' | 'tool'

interface Msg {
  id: string
  role: Role
  content: string
  timestamp: string
  thinking?: {
    status: 'running' | 'completed'
  }
  toolCall?: ToolCall
}

export interface NodeSessionViewProps {
  nodeId: string
  nodeTitle: string
  nodeStatus: Status
  messages: Msg[]
  detail: Detail | null
  onBack: () => void
  onStop?: () => void
  onRestart?: () => void
  onStep?: () => void
  onRun?: () => void
  onSend: (text: string) => void
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

const roleStyle: Record<Role, { border: string; iconBg: string; iconColor: string }> = {
  system:    { border: '#8a74c1', iconBg: 'rgba(138,116,193,0.08)', iconColor: '#8a74c1' },
  assistant: { border: 'var(--wf-ok)', iconBg: 'var(--wf-ok-soft)', iconColor: 'var(--wf-ok)' },
  user:      { border: '#6088c1', iconBg: 'rgba(96,136,193,0.08)', iconColor: '#6088c1' },
  tool:      { border: '#c9943e', iconBg: 'rgba(201,148,62,0.08)', iconColor: '#c9943e' },
}

type Change = NonNullable<Detail["codeChanges"]>[number]

const diffRows = (item?: Change) => {
  if (!item) return []
  let before = 1
  let after = 1
  return diffLines(item.before, item.after).flatMap((change) => {
    const rows = change.value.split("\n")
    if (rows.at(-1) === "") rows.pop()
    return rows.map((text) => {
      if (change.added) {
        const line = { before: "", after: String(after), sign: "+", text, mode: "added" as const }
        after += 1
        return line
      }
      if (change.removed) {
        const line = { before: String(before), after: "", sign: "-", text, mode: "removed" as const }
        before += 1
        return line
      }
      const line = { before: String(before), after: String(after), sign: " ", text, mode: "plain" as const }
      before += 1
      after += 1
      return line
    })
  })
}

/* ── Section label (matches inspector) ── */
function SectionLabel({ children, icon: Icon, count }: {
  children: React.ReactNode
  icon?: typeof Terminal
  count?: number
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        {Icon && <Icon className="h-3.5 w-3.5 text-[var(--wf-dim)]" strokeWidth={1.8} />}
        <span className="text-[11px] font-bold uppercase tracking-[0.07em] text-[var(--wf-dim)]">{children}</span>
      </div>
      {count !== undefined && (
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--wf-chip)] px-1.5 text-[10px] font-bold tabular-nums text-[var(--wf-dim)]">
          {count}
        </span>
      )}
    </div>
  )
}

/* ── State section: human-readable + raw JSON toggle ── */
function StateSection({ json }: { json: Record<string, unknown> }) {
  const [raw, setRaw] = useState(false)
  const entries = Object.entries(json).filter(([, v]) => v != null && v !== '')

  const formatValue = (v: unknown): string => {
    if (typeof v === 'string') return v
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    if (Array.isArray(v)) return v.map(formatValue).join(', ')
    return JSON.stringify(v, null, 2)
  }

  return (
    <div className="wf-state-section wf-slide-up" style={{ animationDelay: '160ms' }}>
      <div className="wf-state-section-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <SectionLabel icon={Hash}>State</SectionLabel>
        <button
          className="text-[10px] font-medium text-[var(--wf-dim)] hover:text-[var(--wf-ink-soft)] transition-colors"
          onClick={() => setRaw(v => !v)}
        >
          {raw ? 'Formatted' : 'Raw JSON'}
        </button>
      </div>
      {raw ? (
        <div className="wf-state-json">
          <pre>{JSON.stringify(json, null, 2)}</pre>
        </div>
      ) : (
        <div className="wf-state-kv">
          {entries.map(([key, val]) => (
            <div key={key} className="wf-state-kv-row">
              <span className="wf-state-kv-key">{key.replace(/_/g, ' ')}</span>
              <span className="wf-state-kv-val">{formatValue(val)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function NodeSessionView(props: NodeSessionViewProps) {
  const [msg, setMsg] = useState('')
  const [tab, setTab] = useState(0)
  const end = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const autoResize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [])
  const left = useSplit({ axis: 'x', size: 380, min: 280, max: 640 })
  const right = useSplit({ axis: 'x', size: 400, min: 340, max: 540, dir: -1 })

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth' })
  }, [props.messages])

  const run = props.nodeStatus === 'running'
  const d = props.detail
  const files = d?.codeChanges ?? []
  const active = files[tab] ?? files[0]
  const changes = diffRows(active)
  const logs = d?.executionLog ?? [
    '[1] Starting cross-compilation process...',
    '[2] Target architecture: ARM (Linux)',
    '[3] Toolchain: gcc-arm-linux-gnueabihf',
    '[4] Compiler flags: -O2 -Wall -Wextra',
    '[5] Compiling hello_fancy.c...',
    '[6] Linking binary...',
    '[7] Binary size: 8.4 KB',
    '[8] Stripping debug symbols...',
    '[9] Final binary: 6.2 KB',
    '[10] Compilation successful',
  ]

  const send = () => {
    if (!msg.trim()) return
    props.onSend(msg)
    setMsg('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  useEffect(() => {
    setTab(0)
  }, [props.nodeId, files.length])

  return (
    <div className="flex h-full flex-col bg-[var(--wf-bg)]">
      {/* ─── TopBar (glass, matches main page) ─── */}
      <div className="wf-topbar">
        <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-[var(--wf-line-strong)] to-transparent" />

        <div className="flex items-center gap-2">
          <button onClick={props.onBack} className="wf-topbar-text-btn">
            <ArrowLeft className="h-4 w-4" strokeWidth={1.6} />
            <span>Back</span>
          </button>

          <div className="wf-topbar-sep" />

          <div>
            <div className="flex items-center gap-2.5">
              <Layers className="h-3.5 w-3.5 text-[var(--wf-dim)]" strokeWidth={1.8} />
              <h1 className="text-[14px] font-bold tracking-[-0.02em] text-[var(--wf-ink)]">{props.nodeTitle}</h1>
            </div>
            <div className="mt-px flex items-center gap-2 pl-6">
              <span className="font-mono text-[10px] text-[var(--wf-dim)]">{props.nodeId}</span>
              <span className="text-[var(--wf-line-strong)]">&middot;</span>
              <span className="text-[10px] font-medium text-[var(--wf-dim)] capitalize">{d?.type ?? 'build'}</span>
            </div>
          </div>

          <div className="wf-topbar-sep" />

          {/* Status pill */}
          <div className={['wf-topbar-status', run ? 'wf-topbar-status--running' : ''].join(' ')}>
            {run ? (
              <Spin size={13} tone="var(--wf-ok)" line={1.5} />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5 text-[var(--wf-ok)]" strokeWidth={2} />
            )}
            <span className="text-[11px] font-semibold">{run ? 'Running' : props.nodeStatus}</span>
            {run && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--wf-ok-soft)] px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.04em] text-[var(--wf-ok-strong)]">
                <Sparkles className="h-2.5 w-2.5" strokeWidth={2} />
                live
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button onClick={props.onStop} className="wf-topbar-action wf-topbar-action--stop">
            <Square className="h-3 w-3" strokeWidth={2.5} fill="currentColor" />
            Abort
          </button>
          <button onClick={props.onRestart} className="wf-topbar-text-btn">
            <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.6} />
            <span>Restart</span>
          </button>
          <button onClick={props.onStep} className="wf-topbar-text-btn">
            <StepForward className="h-3.5 w-3.5" strokeWidth={1.6} />
            <span>Pause</span>
          </button>
          <div className="wf-topbar-sep mx-0.5" />
          <button onClick={props.onRun} className="wf-topbar-action wf-topbar-action--run">
            <Play className="h-3 w-3" strokeWidth={2.5} fill="currentColor" />
            Run
          </button>
        </div>
      </div>

      {/* ─── 3-panel body ─── */}
      <div className="flex min-h-0 flex-1">

        {/* ── Left: Chat (editorial style) ── */}
        <div className="wf-detail-chat" style={{ width: left.size }}>
          <div className="wf-detail-panel-header">
            <SectionLabel icon={Bot} count={props.messages.length}>Chat Session</SectionLabel>
          </div>

          <div className="wf-detail-chat-messages">
            {props.messages.map((item, i) => {
              if (item.role === 'assistant' && item.thinking) {
                return (
                  <div
                    key={item.id}
                    className="wf-slide-up"
                    style={{ animationDelay: `${i * 30}ms`, padding: '2px 0' }}
                  >
                    <ThinkingCard content={item.content} status={item.thinking.status} timestamp={item.timestamp} />
                  </div>
                )
              }
              // Tool call with animated card
              if (item.role === 'tool' && item.toolCall) {
                return (
                  <div
                    key={item.id}
                    className="wf-slide-up"
                    style={{ animationDelay: `${i * 30}ms`, padding: '2px 0' }}
                  >
                    <ToolCallCard tool={item.toolCall} content={item.content} />
                  </div>
                )
              }

              const Icon = icons[item.role]
              const style = roleStyle[item.role]
              return (
                <div
                  key={item.id}
                  className="wf-chat-msg wf-slide-up"
                  style={{ borderLeftColor: style.border, animationDelay: `${i * 30}ms` }}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md"
                      style={{ background: style.iconBg }}
                    >
                      <Icon className="h-3 w-3" strokeWidth={1.8} style={{ color: style.iconColor }} />
                    </div>
                    <div className="min-w-0 flex-1 pt-px">
                      <div className="flex items-center gap-2">
                        <span className="text-[14px] font-semibold text-[var(--wf-ink)]">{names[item.role]}</span>
                        <span className="font-mono text-[11px] tabular-nums text-[var(--wf-dim)]">{item.timestamp}</span>
                      </div>
                      <p className="mt-0.5 whitespace-pre-wrap break-all text-[14px] leading-[1.7] text-[var(--wf-ink-soft)]">
                        <FormattedContent text={item.content} />
                      </p>
                    </div>
                  </div>
                </div>
              )
            })}
            <div ref={end} />
          </div>

          {/* Input (unified pill) */}
          <div className="wf-chat-input-bar">
            <div className="wf-chat-input-wrap">
              <textarea
                ref={textareaRef}
                value={msg}
                rows={1}
                onChange={(e) => { setMsg(e.target.value); autoResize() }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); requestAnimationFrame(autoResize) } }}
                placeholder="Message the agent..."
                className="wf-chat-input"
              />
              <button onClick={send} disabled={!msg.trim()} className="wf-chat-send">
                <ArrowUp className="h-3 w-3" strokeWidth={2.5} />
              </button>
            </div>
          </div>
        </div>

        <SplitBar axis="x" {...left.bind} />

        {/* ── Center: Code diff (dark terminal) ── */}
        <div className="wf-detail-code">
          <div className="wf-detail-panel-header">
            <SectionLabel icon={FileCode2}>Code Changes</SectionLabel>
            <div className="mt-3 flex flex-wrap gap-2">
              {files.length > 0 ? files.map((item, idx) => (
                <button
                  key={item.file}
                  className={`wf-detail-file-tab ${idx === tab ? 'wf-detail-file-tab--active' : ''}`}
                  onClick={() => setTab(idx)}
                >
                  <FileCode2 className="h-3 w-3" strokeWidth={1.8} />
                  {item.file.split("/").at(-1)}
                  <span className="text-[var(--wf-ok)]">+{item.additions}</span>
                </button>
              )) : (
                <div className="wf-detail-file-tab wf-detail-file-tab--active">
                  <FileCode2 className="h-3 w-3" strokeWidth={1.8} />
                  No changes yet
                </div>
              )}
            </div>
          </div>

          {/* File path */}
          <div className="flex items-center gap-2 border-b border-[var(--wf-line)] bg-[var(--wf-bg)] px-5 py-2">
            <span className="font-mono text-[11px] text-[var(--wf-dim)]">{active?.file ?? "No file selected"}</span>
          </div>

          {/* Diff content */}
          <div className="wf-detail-diff">
            {active ? (
              <>
                <div className="wf-detail-diff-hunk">{`@@ ${active.status ?? "modified"} ${active.file} @@`}</div>
                {changes.map((line, i) => (
                  <div key={`${active.file}:${i}`} className="wf-detail-diff-line">
                    <span className="wf-detail-diff-num">{line.after || line.before || "·"}</span>
                    <span className="wf-detail-diff-sign">{line.sign}</span>
                    <span
                      className={`wf-detail-diff-text ${
                        line.mode === 'added'
                          ? 'wf-detail-diff-text--added'
                          : line.mode === 'removed'
                            ? 'text-rose-300'
                            : ''
                      }`}
                    >
                      {line.text || ' '}
                    </span>
                  </div>
                ))}
              </>
            ) : (
              <div className="px-5 py-6 text-[12px] text-[var(--wf-dim)]">No file changes for this node yet.</div>
            )}
          </div>

          {/* Footer stats */}
          <div className="flex items-center gap-4 border-t border-[var(--wf-line)] bg-[var(--wf-bg)] px-5 py-2.5 text-[11px]">
            <span className="font-semibold text-[var(--wf-ok)]">+{active?.additions ?? 0} additions</span>
            <span className="text-[var(--wf-dim)]">{active?.deletions ?? 0} deletions</span>
            <span className="ml-auto font-mono text-[10px] text-[var(--wf-dim)]">{changes.length} lines</span>
          </div>
        </div>

        <SplitBar axis="x" {...right.bind} />

        {/* ── Right: Node state (precision instrument panel) ── */}
        <div className="wf-detail-state" style={{ width: right.size }}>

          {/* Hero — node identity */}
          <div className="wf-state-hero wf-slide-up" style={{ animationDelay: '0ms' }}>
            <div
              className="wf-state-hero-accent"
              style={{
                background: run ? 'var(--wf-ok)' :
                  props.nodeStatus === 'completed' ? 'var(--wf-ok)' :
                  props.nodeStatus === 'failed' ? 'var(--wf-bad)' :
                  'var(--wf-dim)',
              }}
            />
            <div className="flex items-start gap-3 pl-2">
              {/* Animated status indicator */}
              <div className="relative mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center">
                {run ? (
                  <>
                    <div className="absolute inset-0 rounded-lg bg-[var(--wf-ok-soft)] wf-pulse" />
                    <Spin size={18} tone="var(--wf-ok)" line={1.8} />
                  </>
                ) : (
                  <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${
                    props.nodeStatus === 'completed' ? 'bg-[var(--wf-ok-soft)]' :
                    props.nodeStatus === 'failed' ? 'bg-[rgba(239,68,68,0.08)]' :
                    'bg-[var(--wf-chip)]'
                  }`}>
                    <div className={`h-2 w-2 rounded-full ${
                      props.nodeStatus === 'completed' ? 'bg-[var(--wf-ok)]' :
                      props.nodeStatus === 'failed' ? 'bg-[var(--wf-bad)]' :
                      'bg-[var(--wf-dim)]'
                    }`} />
                  </div>
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div className="wf-state-hero-title">{props.nodeTitle}</div>
                <div className="wf-state-hero-id">{d?.sessionId ?? props.nodeId}</div>

                <div className="wf-state-hero-tags">
                  <span data-wf-badge="">{d?.type ?? 'build-flash'}</span>
                  <span data-wf-badge="" className="capitalize">{d?.status ?? props.nodeStatus}</span>
                  {d?.duration && (
                    <span data-wf-badge="">
                      <Timer className="h-3 w-3" strokeWidth={1.8} />
                      {d.duration}
                    </span>
                  )}
                  {run && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--wf-ok-soft)] px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.04em] text-[var(--wf-ok-strong)]">
                      <Sparkles className="h-2.5 w-2.5" strokeWidth={2} />
                      live
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Vitals grid — 2×2 key metrics */}
          <div className="wf-state-vitals wf-slide-up" style={{ animationDelay: '40ms' }}>
            <div className="wf-state-vital">
              <div className="wf-state-vital-label">
                <Cpu className="h-3 w-3" strokeWidth={1.8} />
                Model
              </div>
              <div className="wf-state-vital-value wf-state-vital-value--mono">{d?.model ?? 'GPT-5.4'}</div>
            </div>
            <div className="wf-state-vital">
              <div className="wf-state-vital-label">
                <Activity className="h-3 w-3" strokeWidth={1.8} />
                Attempt
              </div>
              <div className="wf-state-vital-value">{d?.attempt ?? '2/3'}</div>
            </div>
            <div className="wf-state-vital">
              <div className="wf-state-vital-label">
                <Zap className="h-3 w-3" strokeWidth={1.8} />
                Actions
              </div>
              <div className="wf-state-vital-value">{d?.actions ?? '15/30'}</div>
            </div>
            <div className="wf-state-vital">
              <div className="wf-state-vital-label">
                <Clock className="h-3 w-3" strokeWidth={1.8} />
                Duration
              </div>
              <div className="wf-state-vital-value wf-state-vital-value--accent">{d?.duration ?? '—'}</div>
            </div>
          </div>

          {/* Session control strip */}
          <div className="wf-state-controls wf-slide-up" style={{ animationDelay: '80ms' }}>
            <div className="wf-state-control">
              <span className="wf-state-control-label">Pending</span>
              <span className={`wf-state-pending ${(d?.pendingCommands ?? 0) > 0 ? 'wf-state-pending--active' : 'wf-state-pending--idle'}`}>
                {(d?.pendingCommands ?? 0) > 0 && <Radio className="h-2.5 w-2.5" strokeWidth={2.5} />}
                {d?.pendingCommands ?? 0}
              </span>
            </div>
            <div className="wf-state-control">
              <span className="wf-state-control-label">Control</span>
              <span className={`wf-state-control-value ${d?.lastControl !== 'none' ? 'wf-state-control-value--active' : ''}`}>
                {d?.lastControl ?? 'none'}
              </span>
            </div>
            <div className="wf-state-control">
              <span className="wf-state-control-label">Pull</span>
              <span className="wf-state-control-value">{d?.lastPull ?? '—'}</span>
            </div>
            <div className="wf-state-control">
              <span className="wf-state-control-label">Update</span>
              <span className="wf-state-control-value">{d?.lastUpdate ?? '—'}</span>
            </div>
          </div>

          {/* Scrollable sections */}
          <div className="wf-state-sections">

            {/* Execution Logs */}
            <div className="wf-state-section wf-slide-up" style={{ animationDelay: '120ms' }}>
              <div className="wf-state-section-header">
                <SectionLabel icon={Terminal} count={logs.length}>Execution Log</SectionLabel>
              </div>
              <div className="wf-state-terminal">
                {logs.map((line, i) => {
                  const isRecent = i >= logs.length - 3
                  return (
                    <div key={i} className={`wf-state-log ${isRecent ? 'wf-state-log--recent' : ''}`}>
                      <span className="wf-state-log-num">{String(i + 1).padStart(2, '0')}</span>
                      <span className="wf-state-log-text">{line.replace(/^\[\d+\]\s*/, '')}</span>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* State — human-readable key-value + raw JSON toggle */}
            {d?.stateJson && Object.keys(d.stateJson).length > 0 && (
              <StateSection json={d.stateJson} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
