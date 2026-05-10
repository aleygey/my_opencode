/** @jsxImportSource react */
/**
 * Node card — Workflow Runtime design.
 *
 * Compact 200×70 card consumed by the new layered-DAG canvas. Visual
 * spec mirrors the design hand-off:
 *
 *   ┌─────────────────────────┐
 *   │ ▇  KIND        STATE    │   header — kind icon + state pill
 *   │ ▇  Title here          ›│   body — distilled title (font-medium)
 *   │ ▇  meta line · meta    │   meta — single line of mono detail
 *   └─────────────────────────┘
 *     ▲
 *     2px state-tinted left bar (done / running / error / idle)
 *
 * Running state adds:
 *   - 1px shimmer bar on the top edge
 *   - small spinner next to the STATE pill
 *
 * Selected state adds an accent border + 1px ring.
 *
 * The "open in tab" arrow stays in the top-right corner so users can
 * drill into a node's session without selecting it first. Stale and
 * status-icon overlays carry forward from the previous design — both
 * are in the corners so they don't compete with the body text.
 */

import { BrainCircuit, Check, Code2, Compass, Cpu, FlaskConical, Pause, Rocket, X } from 'lucide-react'
import { Spin } from './spin'
import { distillTitle } from '../utils/distill-title'

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
  /** Flag set when the node started against an older graph_rev — a
   *  later edit may have invalidated its inputs. Surfaced as a small
   *  amber chip in the corner. */
  stale?: boolean
  /** Live agent status — most recent reasoning / tool / event line.
   *  Becomes the meta line below the title for running nodes; gives
   *  users a sense of "what's the agent doing right now" without
   *  drilling into the session view. */
  liveStatus?: string
  isSelected: boolean
  onClick: () => void
  onDoubleClick?: () => void
  onArrowClick?: () => void
}

const typeConfig: Record<NodeType, { label: string; icon: typeof Code2 }> = {
  coding:        { label: 'Code',    icon: Code2 },
  'build-flash': { label: 'Build',   icon: Cpu },
  debug:         { label: 'Test',    icon: FlaskConical },
  deploy:        { label: 'Deploy',  icon: Rocket },
  plan:          { label: 'Plan',    icon: BrainCircuit },
  explore:       { label: 'Explore', icon: Compass },
}

const stateLabel: Record<NodeStatus, string> = {
  pending:   'IDLE',
  running:   'RUN',
  completed: 'DONE',
  failed:    'FAIL',
  paused:    'WAIT',
}

export function WorkflowNode({
  id,
  title,
  type,
  status,
  summary,
  stale,
  liveStatus,
  isSelected,
  onClick,
  onDoubleClick,
  onArrowClick,
}: WorkflowNodeProps) {
  const run = status === 'running'
  const cfg = typeConfig[type]
  const TypeIcon = cfg.icon
  // The single-line "what is this node doing right now" — priority:
  //   1. live agent status forwarded via the workflow snapshot
  //   2. first summary item (e.g. shell command)
  //   3. fall back to a verb derived from kind + state
  const meta =
    liveStatus
    ?? summary?.[0]
    ?? `${status} · ${cfg.label.toLowerCase()}`
  // id is intentionally not rendered (visual noise) but keep it in
  // props because the workflow data layer keys on it.
  void id
  return (
    <button
      data-wf-card=""
      data-status={status}
      className={`wf-r2-node${isSelected ? ' is-on' : ''}${run ? ' is-running' : ''}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {run && <span className="wf-r2-node-runbar" aria-hidden />}
      <div className="wf-r2-node-hd">
        <TypeIcon className="wf-r2-node-hd-icon" strokeWidth={1.7} />
        <span className="wf-r2-node-hd-kind">{cfg.label}</span>
        <span className="grow" />
        <span className="wf-r2-node-hd-state">
          {run && <span className="wf-r2-node-hd-spin"><Spin size={9} tone="var(--wf-ok)" line={1.5} /></span>}
          {stateLabel[status]}
        </span>
      </div>
      <div className="wf-r2-node-bd">
        <div className="wf-r2-node-name" title={title}>{distillTitle(title)}</div>
        <div className="wf-r2-node-meta" title={meta}>{meta}</div>
      </div>

      {/* Drill-in arrow — opens this node's session in a substrip tab. */}
      <button
        type="button"
        className="wf-r2-node-open"
        title="Open node session"
        aria-label="Open node session"
        onClick={(e) => {
          e.stopPropagation()
          onArrowClick?.()
        }}
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
          <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* Status icon overlay (top-right, below the open arrow). Hidden
        * on idle / running because the state pill already telegraphs
        * those — overlays would just stack visual noise. */}
      {(status === 'completed' || status === 'failed' || status === 'paused') && (
        <span className="wf-r2-node-status-icon" data-status={status}>
          {status === 'completed' && <Check className="h-3 w-3" strokeWidth={2.5} />}
          {status === 'failed' && <X className="h-3 w-3" strokeWidth={2.5} />}
          {status === 'paused' && <Pause className="h-3 w-3" strokeWidth={2} />}
        </span>
      )}

      {stale && (
        <span
          className="wf-r2-node-stale"
          title="Graph was edited after this node started — inputs may be out of date."
        >
          stale
        </span>
      )}
    </button>
  )
}
