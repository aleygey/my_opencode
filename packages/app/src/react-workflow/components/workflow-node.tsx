/** @jsxImportSource react */
import { BrainCircuit, Check, Code2, Compass, Cpu, FlaskConical, Pause, Rocket, X } from 'lucide-react'
import { Spin } from './spin'

export type NodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'paused'
export type NodeType = 'coding' | 'build-flash' | 'debug' | 'deploy' | 'plan' | 'explore'

interface WorkflowNodeProps {
  id: string
  title: string
  type: NodeType
  status: NodeStatus
  /** Session id once node has started (undefined for unstarted nodes). */
  session?: string
  progress?: number
  summary?: string[]
  /**
   * True when the node was launched against an older graph revision than the
   * current workflow.graph_rev — a downstream edit may have invalidated its
   * inputs. Surfaced as a small "stale" badge.
   */
  stale?: boolean
  /** Live slave-agent status — most recent reasoning / tool / event line.
   *  Renders as a marquee-scrolling footer on running nodes so the user
   *  can watch what the agent is doing without opening its session. */
  liveStatus?: string
  isSelected: boolean
  onClick: () => void
  onDoubleClick?: () => void
  onArrowClick?: () => void
}

const typeConfig: Record<NodeType, { label: string; icon: typeof Code2; color: string }> = {
  coding:        { label: 'Code',    icon: Code2,        color: '#7578c5' },
  'build-flash': { label: 'Build',   icon: Cpu,          color: '#c9943e' },
  debug:         { label: 'Test',    icon: FlaskConical,  color: '#6088c1' },
  deploy:        { label: 'Deploy',  icon: Rocket,       color: '#4d9e8a' },
  plan:          { label: 'Plan',    icon: BrainCircuit,  color: '#8b6ad9' },
  explore:       { label: 'Explore', icon: Compass,      color: '#a8b46d' },
}

const statusAccent: Record<NodeStatus, string> = {
  pending:   'var(--wf-line-strong)',
  running:   'var(--wf-ok)',
  completed: 'var(--wf-ok)',
  failed:    'var(--wf-bad)',
  paused:    'var(--wf-warn)',
}

export function WorkflowNode({ id, title, type, status, summary, stale, liveStatus, isSelected, onClick, onDoubleClick, onArrowClick }: WorkflowNodeProps) {
  /* Compact design-spec node card:
   *   Header: status dot + kind icon + KIND chip (no session id; the user
   *           said the long uuid was visual noise)
   *   Body  : title (truncated, single line)
   *   Footer: scrolling marquee of the node's CURRENT activity — for
   *           sand-table this is "plan ..." / "evaluate ..."; for coding
   *           it's "read ..." / "edit ..."; otherwise the workflow status.
   *           Always rendered (even on idle) so users always know what
   *           the node is doing or waiting for.
   */
  const run = status === 'running'
  const cfg = typeConfig[type]
  const TypeIcon = cfg.icon
  const stateClass =
    status === 'completed' ? 'is-done'
    : status === 'failed' ? 'is-err'
    : status === 'paused' ? 'is-warn'
    : run ? 'is-running'
    : ''
  // Status line shown in the bottom marquee. Priority:
  //   1. live event line forwarded by workflow-panel.tsx (latest agent
  //      reasoning / tool call)
  //   2. first summary line (e.g. command for shell nodes)
  //   3. workflow status verb (running / completed / pending / …)
  const statusLine =
    liveStatus
    ?? summary?.[0]
    ?? (run ? `running · ${cfg.label.toLowerCase()}`
       : status === 'completed' ? `completed · ${cfg.label.toLowerCase()}`
       : status === 'failed' ? `failed · ${cfg.label.toLowerCase()}`
       : status === 'paused' ? `paused · ${cfg.label.toLowerCase()}`
       : `pending · ${cfg.label.toLowerCase()}`)
  // Avoid suppressing id usage warning — id is intentionally not rendered.
  void id
  return (
    <button
      data-wf-card=""
      className={`wf-node ${stateClass} ${isSelected ? 'is-on' : ''}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <div className="wf-node-hd">
        <span
          className="wf-node-hd-dot"
          data-tone={
            status === 'completed' ? 'ok'
            : status === 'failed' ? 'err'
            : status === 'paused' ? 'warn'
            : run ? 'run'
            : 'idle'
          }
          aria-hidden
        />
        <TypeIcon className="wf-node-hd-icon" strokeWidth={1.6} />
        <span className="wf-node-hd-kind">{cfg.label}</span>
      </div>
      <div className="wf-node-bd">
        <div className="wf-node-name" title={title}>{title}</div>
      </div>
      {stale && (
        <span className="wf-node-stale" title="Graph was edited after this node started — inputs may be out of date.">stale</span>
      )}
      {/* Drill-in arrow — opens this node's session in a substrip tab. */}
      <button
        type="button"
        className="wf-node-open"
        title="Open node session"
        aria-label="Open node session"
        onClick={(e) => { e.stopPropagation(); onArrowClick?.() }}
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
          <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {/* Status icon, top-right corner overlay (only when not idle). */}
      {(status === 'completed' || status === 'failed' || status === 'paused') && (
        <span className="wf-node-status-icon">
          {status === 'completed' && <Check className="h-3 w-3" strokeWidth={2.5} />}
          {status === 'failed' && <X className="h-3 w-3" strokeWidth={2.5} />}
          {status === 'paused' && <Pause className="h-3 w-3" strokeWidth={2} />}
        </span>
      )}
      {run && (
        <span className="wf-node-spin">
          <Spin size={10} tone="var(--wf-ok)" line={1.5} />
        </span>
      )}
      {/* Always-visible scrolling status footer. The text duplicates so
        * the marquee loops seamlessly; CSS handles the wrap-around. */}
      <div className="wf-node-live" data-tone={
        status === 'completed' ? 'ok'
        : status === 'failed' ? 'err'
        : status === 'paused' ? 'warn'
        : run ? 'run'
        : 'idle'
      } aria-live="polite">
        <span className="wf-node-live-marquee" data-text={statusLine}>
          <span className="wf-node-live-track">{statusLine}　·　{statusLine}　·　</span>
        </span>
      </div>
      {/* Edge dot ports (for edge connection rendering). */}
      <span className="wf-node-port wf-node-port-left" aria-hidden />
      <span className="wf-node-port wf-node-port-right" aria-hidden />
    </button>
  )
}
