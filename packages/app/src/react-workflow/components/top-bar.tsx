/** @jsxImportSource react */
import { useCallback, useEffect, useState } from 'react'
import { Eye, MessageSquare, Moon, PanelLeftOpen, Settings2, Square, Sun, Play, Pause, RotateCcw, Zap, Gauge, Layers3 } from 'lucide-react'
import { Spin } from './spin'
import type { TokenStats } from '../app'

type SessionStatus = 'running' | 'completed' | 'failed' | 'idle'

/* ── Format token count to compact form ── */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
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
  onTaskSidebarToggle?: () => void
  onDetailClick: () => void
  onSessionClick: () => void
  onRefinerClick?: () => void
  onModelClick?: () => void
  onRunClick?: () => void
  onRestartClick?: () => void
  onStopClick?: () => void
  onPauseClick?: () => void
}

export function TopBar({
  workflowTitle,
  sessionStatus,
  environment,
  nodeProgress,
  tokenStats,
  onTaskSidebarToggle,
  onDetailClick,
  onSessionClick,
  onRefinerClick,
  onModelClick,
  onRunClick,
  onRestartClick,
  onStopClick,
  onPauseClick,
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
        {onTaskSidebarToggle && (
          <>
            <button
              onClick={onTaskSidebarToggle}
              className="wf-topbar-icon-btn"
              aria-label="Toggle sidebar"
            >
              <PanelLeftOpen className="h-4 w-4" strokeWidth={1.6} />
            </button>
            <div className="wf-topbar-sep" />
          </>
        )}

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
      </div>

      {/* Right cluster */}
      <div className="flex items-center gap-1">
        {/* Token stats */}
        {tokenStats && tokenStats.totalTokens > 0 && (
          <>
            <div className="wf-topbar-token-stats">
              <Gauge className="h-3 w-3 text-[var(--wf-dim)]" strokeWidth={1.8} />
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
        <button onClick={onDetailClick} className="wf-topbar-text-btn">
          <Eye className="h-3.5 w-3.5" strokeWidth={1.6} />
          <span>Detail</span>
        </button>
        <button onClick={onSessionClick} className="wf-topbar-text-btn">
          <MessageSquare className="h-3.5 w-3.5" strokeWidth={1.6} />
          <span>Session</span>
        </button>
        {onRefinerClick && (
          <button onClick={onRefinerClick} className="wf-topbar-text-btn">
            <Layers3 className="h-3.5 w-3.5" strokeWidth={1.6} />
            <span>Refiner</span>
          </button>
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
