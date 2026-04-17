/** @jsxImportSource react */
import { useState, useEffect, useMemo } from "react"
import {
  Activity,
  Zap,
  Timer,
  CheckCircle2,
  XCircle,
  Play,
  Square,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  Cpu,
  Rocket,
  Loader2,
  Clock,
  Gauge,
  List,
  Pause,
  SkipForward,
} from "lucide-react"
import type { ToolPlugin, PluginContext, ToolData } from "./types"
import type { Detail } from "../app"
import { Spin } from "../components/spin"

interface ExecStep {
  id: string
  name: string
  status: "pending" | "running" | "completed" | "failed" | "skipped"
  duration?: number
  startedAt?: string
  completedAt?: string
  message?: string
  children?: ExecStep[]
}

interface ExecMetrics {
  totalSteps: number
  completedSteps: number
  failedSteps: number
  currentStep: string
  elapsedMs: number
  estimatedMs?: number
  throughput?: number
}

function StepRow({ step, depth = 0 }: { step: ExecStep; depth?: number }) {
  const [expanded, setExpanded] = useState(depth === 0)
  const hasChildren = step.children && step.children.length > 0

  const statusConfig: Record<ExecStep["status"], { icon: typeof CheckCircle2; color: string; bg: string }> = {
    pending: { icon: Clock, color: "var(--wf-dim)", bg: "var(--wf-chip)" },
    running: { icon: Loader2, color: "var(--wf-ok)", bg: "var(--wf-ok-soft)" },
    completed: { icon: CheckCircle2, color: "var(--wf-ok)", bg: "var(--wf-ok-soft)" },
    failed: { icon: XCircle, color: "var(--wf-bad)", bg: "rgba(239,68,68,0.08)" },
    skipped: { icon: SkipForward, color: "var(--wf-warn)", bg: "rgba(234,179,8,0.08)" },
  }

  const cfg = statusConfig[step.status]
  const Icon = cfg.icon

  return (
    <div className="wf-exec-step" style={{ paddingLeft: depth * 16 }}>
      <div className="wf-exec-step-row">
        {hasChildren && (
          <button className="wf-exec-expand" onClick={() => setExpanded((v) => !v)}>
            {expanded ? (
              <ChevronDown className="h-3 w-3" strokeWidth={2} />
            ) : (
              <ChevronRight className="h-3 w-3" strokeWidth={2} />
            )}
          </button>
        )}
        {!hasChildren && <div className="wf-exec-expand-placeholder" />}
        <div className={`wf-exec-step-icon wf-exec-step-icon--${step.status}`} style={{ background: cfg.bg }}>
          {step.status === "running" ? (
            <Spin size={14} tone={cfg.color} line={1.5} />
          ) : (
            <Icon className="h-3.5 w-3.5" style={{ color: cfg.color }} strokeWidth={2} />
          )}
        </div>
        <span className={`wf-exec-step-name ${step.status === "running" ? "wf-exec-step-name--running" : ""}`}>
          {step.name}
        </span>
        {step.duration !== undefined && <span className="wf-exec-step-time">{step.duration}ms</span>}
        {step.status === "running" && (
          <span className="wf-exec-step-live">
            <Activity className="h-3 w-3" strokeWidth={2} />
            live
          </span>
        )}
      </div>
      {step.message && <div className="wf-exec-step-msg">{step.message}</div>}
      {expanded && hasChildren && step.children && (
        <div className="wf-exec-step-children">
          {step.children.map((child) => (
            <StepRow key={child.id} step={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

function ExecutionTool({ nodeId, nodeStatus, data, detail, onAction }: PluginContext) {
  const [metrics, setMetrics] = useState<ExecMetrics>({
    totalSteps: 0,
    completedSteps: 0,
    failedSteps: 0,
    currentStep: "",
    elapsedMs: 0,
  })
  const [started, setStarted] = useState<string | null>(null)
  const run = nodeStatus === "running"
  const d = detail as Detail | null

  const mockSteps: ExecStep[] = useMemo(
    () => [
      {
        id: "1",
        name: "Environment Setup",
        status: "completed",
        duration: 320,
        message: "Initialized build environment",
        children: [
          { id: "1.1", name: "Load config", status: "completed", duration: 50 },
          { id: "1.2", name: "Validate dependencies", status: "completed", duration: 180 },
          { id: "1.3", name: "Prepare workspace", status: "completed", duration: 90 },
        ],
      },
      {
        id: "2",
        name: "Compilation",
        status: run ? "running" : "completed",
        duration: run ? undefined : 1240,
        startedAt: run ? new Date().toISOString() : undefined,
        message: run ? "Compiling source files..." : "All sources compiled successfully",
        children: [
          { id: "2.1", name: "Parse AST", status: "completed", duration: 120 },
          { id: "2.2", name: "Type checking", status: "completed", duration: 340 },
          {
            id: "2.3",
            name: "Code generation",
            status: run ? "running" : "completed",
            duration: run ? undefined : 580,
          },
          { id: "2.4", name: "Optimization", status: "pending" },
        ],
      },
      {
        id: "3",
        name: "Packaging",
        status: "pending",
        children: [
          { id: "3.1", name: "Bundle assets", status: "pending" },
          { id: "3.2", name: "Generate manifest", status: "pending" },
        ],
      },
      {
        id: "4",
        name: "Deployment",
        status: "pending",
        message: "Awaiting compilation completion",
      },
    ],
    [run],
  )

  useEffect(() => {
    if (!started && run) {
      setStarted(new Date().toISOString())
    }
    const completed = mockSteps.filter((s) => s.status === "completed").length
    const failed = mockSteps.filter((s) => s.status === "failed").length
    const runningStep = mockSteps.find((s) => s.status === "running")
    setMetrics({
      totalSteps: mockSteps.length,
      completedSteps: completed,
      failedSteps: failed,
      currentStep: runningStep?.name ?? "",
      elapsedMs: run
        ? Math.floor((Date.now() - (started ? new Date(started).getTime() : Date.now())) / 1000) * 1000
        : 1560,
      estimatedMs: 3500,
      throughput: 85,
    })
  }, [mockSteps, run, started])

  const progress = metrics.totalSteps > 0 ? Math.round((metrics.completedSteps / metrics.totalSteps) * 100) : 0
  const elapsedSec = Math.floor(metrics.elapsedMs / 1000)
  const estimatedSec = metrics.estimatedMs ? Math.floor(metrics.estimatedMs / 1000) : undefined

  return (
    <div className="wf-detail-code">
      <div className="wf-detail-panel-header">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Rocket className="h-3.5 w-3.5 text-[var(--wf-dim)]" strokeWidth={1.8} />
            <span className="text-[11px] font-bold uppercase tracking-[0.07em] text-[var(--wf-dim)]">
              Execution Pipeline
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`wf-exec-status wf-exec-status--${run ? "running" : nodeStatus}`}>
              {run ? (
                <Spin size={12} tone="var(--wf-ok)" line={1.5} />
              ) : nodeStatus === "completed" ? (
                <CheckCircle2 className="h-3 w-3" strokeWidth={2} />
              ) : (
                <Pause className="h-3 w-3" strokeWidth={2} />
              )}
              {run ? "Running" : nodeStatus}
            </span>
          </div>
        </div>
      </div>

      <div className="wf-exec-metrics">
        <div className="wf-exec-metric">
          <Gauge className="h-3 w-3 text-[var(--wf-dim)]" strokeWidth={1.8} />
          <span className="wf-exec-metric-value">{progress}%</span>
          <span className="wf-exec-metric-label">Progress</span>
        </div>
        <div className="wf-exec-metric">
          <CheckCircle2 className="h-3 w-3 text-[var(--wf-ok)]" strokeWidth={1.8} />
          <span className="wf-exec-metric-value text-[var(--wf-ok)]">{metrics.completedSteps}</span>
          <span className="wf-exec-metric-label">Done</span>
        </div>
        <div className="wf-exec-metric">
          <XCircle className="h-3 w-3 text-[var(--wf-bad)]" strokeWidth={1.8} />
          <span className="wf-exec-metric-value text-[var(--wf-bad)]">{metrics.failedSteps}</span>
          <span className="wf-exec-metric-label">Failed</span>
        </div>
        <div className="wf-exec-metric">
          <Timer className="h-3 w-3 text-[var(--wf-dim)]" strokeWidth={1.8} />
          <span className="wf-exec-metric-value">{elapsedSec}s</span>
          {estimatedSec && <span className="wf-exec-metric-est">/ {estimatedSec}s</span>}
          <span className="wf-exec-metric-label">Elapsed</span>
        </div>
      </div>

      <div className="flex items-center gap-2 border-b border-[var(--wf-line)] bg-[var(--wf-bg)] px-5 py-2">
        <Zap className="h-3 w-3 text-[var(--wf-dim)]" strokeWidth={1.8} />
        <span className="font-mono text-[11px] text-[var(--wf-dim)]">{metrics.currentStep || "No active step"}</span>
        {run && metrics.throughput !== undefined && (
          <>
            <span className="text-[var(--wf-line-strong)]">·</span>
            <span className="text-[11px] text-[var(--wf-ok)]">{metrics.throughput}% throughput</span>
          </>
        )}
      </div>

      <div className="wf-detail-diff wf-exec-steps">
        {mockSteps.length === 0 ? (
          <div className="px-5 py-6 text-[12px] text-[var(--wf-dim)]">No execution steps yet.</div>
        ) : (
          mockSteps.map((step) => <StepRow key={step.id} step={step} />)
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-[var(--wf-line)] bg-[var(--wf-bg)] px-5 py-2.5">
        {run ? (
          <>
            <button onClick={() => onAction?.("pause")} className="wf-exec-btn wf-exec-btn--pause">
              <Pause className="h-3 w-3" strokeWidth={2} />
              Pause
            </button>
            <button onClick={() => onAction?.("stop")} className="wf-exec-btn wf-exec-btn--stop">
              <Square className="h-3 w-3" strokeWidth={2} fill="currentColor" />
              Abort
            </button>
          </>
        ) : (
          <>
            <button onClick={() => onAction?.("start")} className="wf-exec-btn wf-exec-btn--start">
              <Play className="h-3 w-3" strokeWidth={2} fill="currentColor" />
              Run
            </button>
            <button onClick={() => onAction?.("restart")} className="wf-exec-btn">
              <RotateCcw className="h-3 w-3" strokeWidth={1.8} />
              Restart
            </button>
          </>
        )}
        <div className="ml-auto flex items-center gap-3 text-[11px] text-[var(--wf-dim)]">
          <span className="flex items-center gap-1">
            <List className="h-3 w-3" strokeWidth={1.8} />
            {metrics.totalSteps} steps
          </span>
        </div>
      </div>
    </div>
  )
}

export const executionToolPlugin: ToolPlugin = {
  id: "execution-tool",
  name: "Execution Pipeline",
  icon: Rocket,
  supportedTypes: ["deploy", "debug"],
  priority: 80,
  component: ExecutionTool,
  getData: (detail: unknown): ToolData => {
    const d = detail as Detail | null
    const logs = d?.executionLog ?? []
    return {
      status: logs.length > 0 ? "running" : "idle",
      progress: logs.length,
      rawData: logs,
    }
  },
  matches: (nodeType: string, detail: unknown): boolean => {
    return nodeType === "deploy" || nodeType === "debug"
  },
}
