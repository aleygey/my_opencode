/** @jsxImportSource react */
import { useCallback, useEffect, useState } from 'react'
import { Layers3, Moon, Settings2, Square, Sun, Play, Pause, RotateCcw, Zap, Gauge } from 'lucide-react'
import { Spin } from './spin'
import type { TokenStats } from '../app'

type SessionStatus = 'running' | 'completed' | 'failed' | 'idle'

/* ── Format token count to compact form ── */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/**
 * Circular progress ring showing what fraction of the model's context
 * window the current master session has consumed. Rendered inline
 * beside the numeric token readout so the user can gauge "how much
 * headroom do I have before compaction" at a glance without doing
 * arithmetic. Colour ramps amber past 70%, red past 90% so looming
 * overflows are obvious without a popover.
 */
function TokenRing({ pct, size = 18, stroke = 2.5 }: { pct: number; size?: number; stroke?: number }) {
  const clamped = Math.max(0, Math.min(100, pct))
  const r = (size - stroke) / 2
  const c = size / 2
  const circumference = 2 * Math.PI * r
  const offset = circumference * (1 - clamped / 100)
  const tone =
    clamped >= 90
      ? 'var(--wf-bad)'
      : clamped >= 70
        ? '#d1a23a'
        : 'var(--wf-ok)'
  return (
    <div
      className="wf-topbar-token-ring"
      role="img"
      aria-label={`${Math.round(clamped)}% context used`}
      title={`Context window · ${Math.round(clamped)}% used`}
    >
      <svg width={size} height={size}>
        <circle
          cx={c}
          cy={c}
          r={r}
          fill="none"
          stroke="var(--wf-line)"
          strokeWidth={stroke}
          opacity={0.45}
        />
        <circle
          cx={c}
          cy={c}
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${c} ${c})`}
          style={{ transition: 'stroke-dashoffset 350ms ease-out, stroke 200ms ease-out' }}
        />
      </svg>
      <span className="wf-topbar-token-ring-pct" style={{ color: tone }}>
        {Math.round(clamped)}
      </span>
    </div>
  )
}

/* ── Theme toggle with localStorage persistence ── */
function useTheme() {
  const [dark, setDark] = useState(() => {
    if (typeof window === 'undefined') return false
    const stored = localStorage.getItem('wf-theme')
    if (stored) return stored === 'dark'
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  useEffect(() => {
    const root = document.querySelector('.workflow-make')
    if (!root) return
    if (dark) {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }
    localStorage.setItem('wf-theme', dark ? 'dark' : 'light')
  }, [dark])

  const toggle = useCallback(() => setDark(v => !v), [])
  return { dark, toggle }
}

interface TopBarProps {
  workflowTitle: string
  sessionStatus: SessionStatus
  environment: string
  nodeProgress?: { done: number; total: number }
  tokenStats?: TokenStats
  /** Deprecated: retained for prop-shape compatibility but no longer used —
   *  the legacy task drawer was removed; tasks live in the unified shell rail. */
  onTaskSidebarToggle?: () => void
  // Detail / Session buttons removed in favour of clicking the card arrow
  // (which now opens the per-node session view in-place). They were redundant
  // and the Session button was a near-noop — see removal in commit history.
  onModelClick?: () => void
  onRefinerClick?: () => void
  onRetrieveClick?: () => void
  onRunClick?: () => void
  onRestartClick?: () => void
  onStopClick?: () => void
  onPauseClick?: () => void
  /** P1 — current dynamic-graph revision (server-side `workflow.graph_rev`).
   *  Surfaced as a small mono `rev #N` chip so the user can spot in-flight
   *  topology churn at a glance and reason about edit base_rev mismatches. */
  graphRev?: number
  /** P3 — number of `workflow_edit` rows in `pending` status. When > 0
   *  the TopBar shows an amber chip; clicking it fires `onShowEdits`. */
  pendingEditsCount?: number
  /** P5 — terminal status when the workflow has been finalised. */
  finalizedStatus?: "completed" | "failed" | "cancelled"
  /** P3 — open the pending-edits drawer (apply / reject / inspect). */
  onShowEdits?: () => void
}

export function TopBar({
  workflowTitle,
  sessionStatus,
  environment,
  nodeProgress,
  tokenStats,
  onModelClick,
  onRefinerClick,
  onRetrieveClick,
  onRunClick,
  onRestartClick,
  onStopClick,
  onPauseClick,
  graphRev,
  pendingEditsCount,
  finalizedStatus,
  onShowEdits,
}: TopBarProps) {
  const theme = useTheme()
  const isRunning = sessionStatus === 'running'

  const statusLabel =
    sessionStatus === 'running' ? 'Running' :
    sessionStatus === 'completed' ? 'Complete' :
    sessionStatus === 'failed' ? 'Failed' : 'Idle'

  return (
    <div className="wf-topbar">
      {/* Bottom accent line */}
      <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-[var(--wf-line-strong)] to-transparent" />

      {/* Left cluster */}
      <div className="flex items-center gap-2">
        {/* (Sidebar toggle removed — tasks live in the unified shell rail.) */}

        {/* Brand mark + title */}
        <div className="flex items-center gap-3">
          <div className="wf-topbar-brand">
            <Zap className="h-3.5 w-3.5 text-white" strokeWidth={2.5} fill="white" />
          </div>
          <div>
            <h1 className="text-[14px] font-bold tracking-[-0.02em] text-[var(--wf-ink)]">{workflowTitle}</h1>
            {/* Environment + progress inline under title */}
            <div className="flex items-center gap-2 mt-px">
              {environment && (
                <span className="text-[10px] font-semibold tracking-[0.02em] text-[var(--wf-accent)]">{environment}</span>
              )}
              {environment && nodeProgress && (
                <span className="text-[var(--wf-line-strong)]">&middot;</span>
              )}
              {nodeProgress && (
                <span className="text-[10px] font-medium tabular-nums text-[var(--wf-dim)]">
                  {nodeProgress.done} of {nodeProgress.total} tasks
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="wf-topbar-sep" />

        {/* Status pill */}
        <div className={[
          'wf-topbar-status',
          isRunning ? 'wf-topbar-status--running' : '',
        ].join(' ')}>
          {isRunning ? (
            <Spin size={13} tone="var(--wf-ok)" line={1.5} />
          ) : (
            <span className={`h-[6px] w-[6px] rounded-full ${
              sessionStatus === 'completed' ? 'bg-[var(--wf-ok)]' :
              sessionStatus === 'failed' ? 'bg-[var(--wf-bad)]' :
              'bg-[var(--wf-dim)]'
            }`} />
          )}
          <span className="text-[11px] font-semibold">{statusLabel}</span>
          {isRunning && nodeProgress && (
            <>
              <div className="wf-topbar-progress-track">
                <div
                  className="wf-topbar-progress-fill"
                  style={{ width: `${nodeProgress.total > 0 ? (nodeProgress.done / nodeProgress.total) * 100 : 0}%` }}
                />
              </div>
              <span className="text-[10px] font-bold tabular-nums text-[var(--wf-ok)]">
                {Math.round(nodeProgress.total > 0 ? (nodeProgress.done / nodeProgress.total) * 100 : 0)}%
              </span>
            </>
          )}
        </div>

        {/* P1/P3/P5 — dynamic-graph chips. graph_rev shows the live
         * topology revision; pending-edits is a clickable amber chip
         * that opens the edits drawer; finalized appears once the
         * workflow has been moved to a terminal status. All three are
         * silent when not applicable, so legacy workflows pre-P1 stay
         * visually identical to before. */}
        {typeof graphRev === "number" && (
          <span
            title="Workflow graph revision (bumps on each applied topology edit)"
            className="ml-1 inline-flex h-6 items-center rounded-full border border-[var(--wf-line)] bg-[var(--wf-surface)] px-2 font-mono text-[10px] text-[var(--wf-dim)]"
          >
            rev #{graphRev}
          </span>
        )}
        {typeof pendingEditsCount === "number" && pendingEditsCount > 0 && (
          <button
            type="button"
            onClick={onShowEdits}
            title="Pending graph-edit proposals — click to review / apply / reject"
            className="ml-1 inline-flex h-6 items-center gap-1 rounded-full border border-amber-300/70 bg-amber-100/70 px-2 text-[10px] font-semibold text-amber-800 transition hover:bg-amber-200/70 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200 dark:hover:bg-amber-500/25"
          >
            <span className="size-1.5 rounded-full bg-amber-500" />
            {pendingEditsCount} pending edit{pendingEditsCount === 1 ? "" : "s"}
          </button>
        )}
        {finalizedStatus && (
          <span
            title="Workflow finalised — further graph writes are server-side rejected"
            className="ml-1 inline-flex h-6 items-center rounded-full border border-[var(--wf-line)] bg-[var(--wf-surface)] px-2 text-[10px] font-medium text-[var(--wf-dim)]"
          >
            finalized · {finalizedStatus}
          </span>
        )}
      </div>

      {/* Right cluster */}
      <div className="flex items-center gap-1">
        {/* Token stats — ring visualises context-window usage so the
         * user can eyeball remaining headroom without mental math. The
         * numeric breakdown stays for absolute values. */}
        {tokenStats && tokenStats.totalTokens > 0 && (
          <>
            <div className="wf-topbar-token-stats">
              {tokenStats.contextLength != null && tokenStats.contextLength > 0 ? (
                <TokenRing pct={(tokenStats.totalTokens / tokenStats.contextLength) * 100} />
              ) : (
                <Gauge className="h-3 w-3 text-[var(--wf-dim)]" strokeWidth={1.8} />
              )}
              <span className="wf-topbar-token-label">
                {fmtTokens(tokenStats.totalTokens)}
              </span>
              <span className="wf-topbar-token-detail">
                ↑{fmtTokens(tokenStats.inputTokens)} ↓{fmtTokens(tokenStats.outputTokens)}
              </span>
              {tokenStats.contextLength != null && tokenStats.contextLength > 0 && (
                <>
                  <span className="wf-topbar-token-sep">·</span>
                  <span className="wf-topbar-token-ctx">
                    ctx {fmtTokens(tokenStats.contextLength)}
                  </span>
                </>
              )}
            </div>
            <div className="wf-topbar-sep mx-0.5" />
          </>
        )}
        <button onClick={onModelClick} className="wf-topbar-icon-btn">
          <Settings2 className="h-3.5 w-3.5" strokeWidth={1.6} />
        </button>

        {/* Theme toggle */}
        <button onClick={theme.toggle} className="wf-theme-toggle" aria-label="Toggle theme">
          {theme.dark ? (
            <Sun className="h-3.5 w-3.5" strokeWidth={1.8} />
          ) : (
            <Moon className="h-3.5 w-3.5" strokeWidth={1.8} />
          )}
        </button>

        <div className="wf-topbar-sep mx-1" />

        {onRefinerClick && (
          <button onClick={onRefinerClick} className="wf-topbar-text-btn">
            <Layers3 className="h-3.5 w-3.5" strokeWidth={1.6} />
            <span>Refiner</span>
          </button>
        )}

        {onRetrieveClick && (
          <button onClick={onRetrieveClick} className="wf-topbar-text-btn">
            <Zap className="h-3.5 w-3.5" strokeWidth={1.6} />
            <span>Retrieve</span>
          </button>
        )}

        <button onClick={onRestartClick} className="wf-topbar-text-btn">
          <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.6} />
          <span>Restart</span>
        </button>

        {isRunning ? (
          <>
            <button onClick={onPauseClick} className="wf-topbar-text-btn">
              <Pause className="h-3.5 w-3.5" strokeWidth={1.8} />
              <span>Pause</span>
            </button>
            <button onClick={onStopClick} className="wf-topbar-action wf-topbar-action--stop">
              <Square className="h-3 w-3" strokeWidth={2.5} fill="currentColor" />
              Abort
            </button>
          </>
        ) : (
          <button onClick={onRunClick} className="wf-topbar-action wf-topbar-action--run">
            <Play className="h-3 w-3" strokeWidth={2.5} fill="currentColor" />
            Run
          </button>
        )}
      </div>
    </div>
  )
}
