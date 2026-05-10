/** @jsxImportSource react */
import { BrainCircuit, Check, Code2, Compass, Cpu, FlaskConical, Pause, Rocket, X } from 'lucide-react'
import { Spin } from './spin'

/** Distill a noisy planner-emitted title down to a clean short label.
 *
 * Backend `node.title` often arrives shaped like
 *   "Plan · ## Goal 在本地 opencode 中实现…\n\n## Core req\n…"
 * because the planner LLM doesn't follow a strict {title, body}
 * schema and the workflow runtime ends up using the whole prompt as
 * the title. We strip:
 *   1. a leading `Plan · ` / `Coding · ` / `Build · ` etc. prefix
 *      (the kind label is already shown as a chip);
 *   2. any markdown header marks (`#`, `##`, `###`);
 *   3. anything past the first non-blank line.
 * Then truncate to ~28 chars with an ellipsis. The full text stays
 * available via the cell's `title=` tooltip and the inspector. */
function distillTitle(raw: string): string {
  if (!raw) return ""
  // Walk lines; skip blanks; on the first content line, trim and
  // strip markdown leading markers.
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    let s = t
    // Drop `Plan · ` / `Code · ` / `Build · ` style prefix.
    s = s.replace(/^(?:Plan|Code|Coding|Build|Debug|Deploy|Explore|计划|编码|构建|调试|部署|探索)\s*[·:：-]\s*/u, "")
    // Drop markdown header markers + a trailing colon.
    s = s.replace(/^#+\s*/u, "").replace(/[：:]\s*$/u, "")
    if (!s) continue
    return s.length > 28 ? s.slice(0, 26).trimEnd() + "…" : s
  }
  return raw.length > 28 ? raw.slice(0, 26).trimEnd() + "…" : raw
}

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
      {/* 1px top progress shimmer — only visible when this node is the
        * running one (CSS keys it off `.is-running`). Replaces the old
        * outer halo pulse that made the whole canvas feel restless. */}
      {run && <span className="wf-node-runbar" aria-hidden />}
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
        {/* Card title — distilled into a clean short form because the
          * planner LLM often dumps a whole markdown body into
          * `title` (e.g. "Plan · ## Goal 在本地 opencode 中执行…"),
          * which the user called out as ugly. We strip the leading
          * `Plan · ` prefix when present, then take the first
          * non-blank line and trim any markdown header markers (`#`,
          * `##`). The full text is still available in the inspector
          * and as the title attr for hover. */}
        <div className="wf-node-name" title={title}>{distillTitle(title)}</div>
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
      {/* Live status footer — vertical-rise animation only when the
        * status text actually changes. `key={statusLine}` makes React
        * remount the inner span, which re-fires the CSS keyframe so
        * new lines slide in from below. No background tint; tone is
        * carried by the text colour alone. */}
      <div className="wf-node-live" data-tone={
        status === 'completed' ? 'ok'
        : status === 'failed' ? 'err'
        : status === 'paused' ? 'warn'
        : run ? 'run'
        : 'idle'
      } aria-live="polite">
        <span key={statusLine} className="wf-node-live-text" title={statusLine}>
          {statusLine}
        </span>
      </div>
    </button>
  )
}
