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
  session: string
  progress?: number
  summary?: string[]
  /**
   * True when the node was launched against an older graph revision than the
   * current workflow.graph_rev — a downstream edit may have invalidated its
   * inputs. Surfaced as a small "stale" badge.
   */
  stale?: boolean
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

export function WorkflowNode({ title, type, status, progress, stale, isSelected, onClick, onDoubleClick, onArrowClick }: WorkflowNodeProps) {
  // Slimmed per design: only essentials — type icon, single-line title,
  // status dot, optional progress bar. Summary chips and inline status
  // text are removed (they pushed the card into a 3-row, 80+px tall
  // shape; the design wants a compact single-row card).
  const run = status === 'running'
  const cfg = typeConfig[type]
  const TypeIcon = cfg.icon

  return (
    <button
      data-wf-card=""
      className="group text-left wf-node wf-node-compact"
      style={{
        borderLeftColor: statusAccent[status],
        borderLeftWidth: 3,
        boxShadow: isSelected
          ? (run ? 'var(--wf-shadow-glow)' : 'var(--wf-shadow-md)')
          : undefined,
        transform: isSelected ? 'translateY(-1px)' : undefined,
      }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {/* Running pulse overlay */}
      {run && <div className="wf-node-pulse" />}

      <div className="flex items-center gap-2.5 min-w-0">
        {/* Type icon (compact, colour-coded) */}
        <div
          className="wf-node-icon"
          style={{ background: `${cfg.color}0d`, color: cfg.color }}
        >
          <TypeIcon className="h-3 w-3" strokeWidth={1.8} />
        </div>

        {/* Title + meta — title single-line, truncated. */}
        <div className="min-w-0 flex-1">
          <h3
            title={title}
            className="text-[12.5px] font-semibold leading-tight tracking-[-0.005em] text-[var(--wf-ink)] truncate"
          >
            {title}
          </h3>
          <div className="mt-[1px] flex items-center gap-1.5 text-[10px] text-[var(--wf-dim)]">
            <span style={{ color: cfg.color, fontWeight: 500 }}>{cfg.label}</span>
            {stale && (
              <span
                title="Graph was edited after this node started — its inputs may be out of date."
                className="inline-flex items-center rounded-sm px-1 text-[8.5px] font-semibold uppercase tracking-wider"
                style={{
                  background: 'color-mix(in srgb, var(--wf-warn) 14%, transparent)',
                  color: 'var(--wf-warn)',
                }}
              >
                stale
              </span>
            )}
          </div>
        </div>

        {/* Status indicator — minimal, just a coloured dot or spinner. */}
        <div className="flex-shrink-0">
          {run ? (
            <Spin size={10} tone="var(--wf-ok)" line={1.5} />
          ) : status === 'completed' ? (
            <Check className="h-2.5 w-2.5 text-[var(--wf-ok)]" strokeWidth={3} />
          ) : status === 'failed' ? (
            <X className="h-2.5 w-2.5 text-[var(--wf-bad)]" strokeWidth={3} />
          ) : status === 'paused' ? (
            <Pause className="h-2.5 w-2.5 text-[var(--wf-warn)]" strokeWidth={2.5} />
          ) : (
            <div className="h-[5px] w-[5px] rounded-full bg-[var(--wf-dim)] opacity-60" />
          )}
        </div>

        {/* Arrow — opens node detail view, dim until hover. */}
        <div
          role="button"
          tabIndex={0}
          title="Open node detail"
          onClick={(e) => { e.stopPropagation(); onArrowClick?.() }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onArrowClick?.() } }}
          className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-md opacity-40 transition group-hover:opacity-90 hover:!bg-[var(--wf-chip)] cursor-pointer"
        >
          <svg className="h-2.5 w-2.5 text-[var(--wf-dim)]" viewBox="0 0 16 16" fill="none">
            <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </div>

      {/* Progress bar — slim, full-width strip beneath the row, only on running nodes
          with a real number. Replaces the previous inline progress chip + percent. */}
      {run && typeof progress === 'number' && (
        <div className="wf-node-progress-strip">
          <div
            className="wf-progress-fill"
            data-animated=""
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </button>
  )
}
