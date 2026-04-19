/** @jsxImportSource react */
import { Check, Code2, Cpu, FlaskConical, Pause, Rocket, X } from 'lucide-react'
import { Spin } from './spin'

export type NodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'paused'
export type NodeType = 'coding' | 'build-flash' | 'debug' | 'deploy'

interface WorkflowNodeProps {
  id: string
  title: string
  type: NodeType
  status: NodeStatus
  session: string
  progress?: number
  isSelected: boolean
  onClick: () => void
  onDoubleClick?: () => void
  onArrowClick?: () => void
}

const typeConfig: Record<NodeType, { label: string; icon: typeof Code2; color: string }> = {
  coding:        { label: 'Code',   icon: Code2,       color: '#7578c5' },
  'build-flash': { label: 'Build',  icon: Cpu,         color: '#c9943e' },
  debug:         { label: 'Test',   icon: FlaskConical, color: '#6088c1' },
  deploy:        { label: 'Deploy', icon: Rocket,      color: '#4d9e8a' },
}

const statusAccent: Record<NodeStatus, string> = {
  pending:   'var(--wf-line-strong)',
  running:   'var(--wf-ok)',
  completed: 'var(--wf-ok)',
  failed:    'var(--wf-bad)',
  paused:    'var(--wf-warn)',
}

export function WorkflowNode({ title, type, status, progress, isSelected, onClick, onDoubleClick, onArrowClick }: WorkflowNodeProps) {
  const run = status === 'running'
  const done = status === 'completed'
  const fail = status === 'failed'
  const pause = status === 'paused'
  const cfg = typeConfig[type]
  const TypeIcon = cfg.icon

  return (
    <button
      data-wf-card=""
      data-wf-type={type}
      data-wf-status={status}
      className="group w-full text-left wf-node"
      style={{
        ['--wf-node-type-color' as any]: cfg.color,
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

      <div className="flex items-center gap-3">
        {/* Type icon (compact, color-coded) */}
        <div
          className="wf-node-icon"
          style={{ background: `${cfg.color}0d`, color: cfg.color }}
        >
          <TypeIcon className="h-3.5 w-3.5" strokeWidth={1.8} />
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[12.5px] font-semibold leading-5 tracking-[-0.01em] text-[var(--wf-ink)]">{title}</h3>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[10.5px]">
            <span
              className="wf-node-type-chip font-mono"
              style={{ color: cfg.color, background: `${cfg.color}14`, borderColor: `${cfg.color}33` }}
            >
              {cfg.label}
            </span>
            <span className="text-[var(--wf-line-strong)]">&middot;</span>
            {/* Status with inline indicator */}
            <span className="inline-flex items-center gap-1.5">
              {done ? (
                <Check className="h-2.5 w-2.5 text-[var(--wf-ok)]" strokeWidth={3} />
              ) : run ? (
                <Spin size={10} tone="var(--wf-ok)" line={1.5} />
              ) : fail ? (
                <X className="h-2.5 w-2.5 text-[var(--wf-bad)]" strokeWidth={3} />
              ) : pause ? (
                <Pause className="h-2.5 w-2.5 text-[var(--wf-warn)]" strokeWidth={2.5} />
              ) : (
                <div className="h-[5px] w-[5px] rounded-full bg-[var(--wf-dim)] opacity-50" />
              )}
              <span className={[
                'font-mono font-medium capitalize',
                done ? 'text-[var(--wf-ok)]' :
                run ? 'text-[var(--wf-ink)]' :
                fail ? 'text-[var(--wf-bad)]' :
                pause ? 'text-[var(--wf-warn)]' :
                'text-[var(--wf-dim)]',
              ].join(' ')}>
                {status}
              </span>
            </span>
          </div>
        </div>

        {/* Progress (compact inline) */}
        {run && (
          <div className="flex items-center gap-2">
            <div className="wf-node-progress-track">
              <div
                className="wf-progress-fill"
                data-animated=""
                style={{ width: `${progress ?? 65}%` }}
              />
            </div>
            <span className="font-mono text-[10px] font-semibold tabular-nums text-[var(--wf-ok)]">{progress ?? 65}%</span>
          </div>
        )}

        {/* Arrow — clickable, opens session */}
        <div
          role="button"
          tabIndex={0}
          onClick={(e) => { e.stopPropagation(); onArrowClick?.() }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onArrowClick?.() } }}
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md opacity-0 transition group-hover:opacity-100 hover:!bg-[var(--wf-chip)] cursor-pointer"
        >
          <svg className="h-3.5 w-3.5 text-[var(--wf-dim)]" viewBox="0 0 16 16" fill="none">
            <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </div>
    </button>
  )
}
