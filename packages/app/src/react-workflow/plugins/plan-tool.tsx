/** @jsxImportSource react */
import { useState, useMemo } from "react"
import {
  BrainCircuit,
  CheckCircle2,
  Circle,
  Loader2,
  XCircle,
  ChevronDown,
  ChevronRight,
  Timer,
  ListTree,
  Gauge,
} from "lucide-react"
import type { ToolPlugin, PluginContext, ToolData } from "./types"
import type { Detail } from "../app"
import { Spin } from "../components/spin"

interface PlanStep {
  id: string
  name: string
  agent: string
  status: "pending" | "running" | "completed" | "failed" | "skipped"
  description?: string
  duration?: string
}

function PlanTool({ nodeId, nodeStatus, data, detail }: PluginContext) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const run = nodeStatus === "running"
  const d = detail as Detail | null

  const steps: PlanStep[] = useMemo(
    () => [
      {
        id: "1",
        name: "Analyze requirements",
        agent: "coding",
        status: "completed" as const,
        duration: "2s",
        description: "Parse task description and identify key requirements",
      },
      {
        id: "2",
        name: "Design solution architecture",
        agent: "coding",
        status: "completed" as const,
        duration: "5s",
        description: "Plan module structure and data flow",
      },
      {
        id: "3",
        name: "Implement core logic",
        agent: "coding",
        status: run ? ("running" as const) : ("completed" as const),
        duration: run ? undefined : "18s",
        description: "Write main implementation with type safety",
      },
      {
        id: "4",
        name: "Add unit tests",
        agent: "debug",
        status: "pending" as const,
        description: "Cover edge cases and error paths",
      },
      {
        id: "5",
        name: "Build & flash firmware",
        agent: "build-flash",
        status: "pending" as const,
        description: "Compile for target platform",
      },
      {
        id: "6",
        name: "Deploy & verify",
        agent: "deploy",
        status: "pending" as const,
        description: "Ship to target and validate",
      },
    ],
    [run],
  )

  const completed = steps.filter((s) => s.status === "completed").length
  const failed = steps.filter((s) => s.status === "failed").length
  const progress = steps.length > 0 ? Math.round((completed / steps.length) * 100) : 0

  const toggle = (id: string) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }))

  const statusIcon = (status: PlanStep["status"]) => {
    switch (status) {
      case "completed":
        return <CheckCircle2 className="h-3.5 w-3.5 text-[var(--wf-ok)]" strokeWidth={2} />
      case "running":
        return <Spin size={14} tone="var(--wf-ok)" line={1.5} />
      case "failed":
        return <XCircle className="h-3.5 w-3.5 text-[var(--wf-bad)]" strokeWidth={2} />
      case "skipped":
        return <Circle className="h-3.5 w-3.5 text-[var(--wf-warn)]" strokeWidth={2} />
      default:
        return <Circle className="h-3.5 w-3.5 text-[var(--wf-dim)]" strokeWidth={2} />
    }
  }

  const agentLabel: Record<string, string> = {
    coding: "Code",
    "build-flash": "Build",
    debug: "Test",
    deploy: "Deploy",
    plan: "Plan",
  }

  return (
    <div className="wf-detail-code">
      <div className="wf-detail-panel-header">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BrainCircuit className="h-3.5 w-3.5 text-[var(--wf-dim)]" strokeWidth={1.8} />
            <span className="text-[11px] font-bold uppercase tracking-[0.07em] text-[var(--wf-dim)]">
              Plan Overview
            </span>
          </div>
          <div className="flex items-center gap-2">
            {run && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--wf-ok-soft)] px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.04em] text-[var(--wf-ok-strong)]">
                <Loader2 className="h-2.5 w-2.5 animate-spin" strokeWidth={2} />
                live
              </span>
            )}
          </div>
        </div>

        {/* Progress bar */}
        <div className="mt-3">
          <div className="flex items-center justify-between text-[10px] text-[var(--wf-dim)] mb-1.5">
            <span className="font-semibold">{progress}% complete</span>
            <span>
              {completed}/{steps.length} steps
            </span>
          </div>
          <div className="wf-plan-progress-track">
            <div className="wf-plan-progress-fill" style={{ width: `${progress}%` }} />
          </div>
        </div>
      </div>

      {/* Metrics strip */}
      <div className="wf-plan-metrics">
        <div className="wf-plan-metric">
          <Gauge className="h-3 w-3 text-[var(--wf-dim)]" strokeWidth={1.8} />
          <span className="wf-plan-metric-value">{progress}%</span>
          <span className="wf-plan-metric-label">Progress</span>
        </div>
        <div className="wf-plan-metric">
          <CheckCircle2 className="h-3 w-3 text-[var(--wf-ok)]" strokeWidth={1.8} />
          <span className="wf-plan-metric-value text-[var(--wf-ok)]">{completed}</span>
          <span className="wf-plan-metric-label">Done</span>
        </div>
        <div className="wf-plan-metric">
          <XCircle className="h-3 w-3 text-[var(--wf-bad)]" strokeWidth={1.8} />
          <span className="wf-plan-metric-value text-[var(--wf-bad)]">{failed}</span>
          <span className="wf-plan-metric-label">Failed</span>
        </div>
        <div className="wf-plan-metric">
          <Timer className="h-3 w-3 text-[var(--wf-dim)]" strokeWidth={1.8} />
          <span className="wf-plan-metric-value">~8s</span>
          <span className="wf-plan-metric-label">ETA</span>
        </div>
      </div>

      <div className="flex items-center gap-2 border-b border-[var(--wf-line)] bg-[var(--wf-bg)] px-5 py-2">
        <ListTree className="h-3 w-3 text-[var(--wf-dim)]" strokeWidth={1.8} />
        <span className="font-mono text-[11px] text-[var(--wf-dim)]">{steps.length} steps planned</span>
      </div>

      {/* Step list */}
      <div className="wf-detail-diff wf-plan-steps">
        {steps.map((step) => (
          <div key={step.id} className="wf-plan-step">
            <div className="wf-plan-step-row" onClick={() => step.description && toggle(step.id)}>
              {step.description ? (
                <button className="wf-plan-expand" onClick={() => toggle(step.id)}>
                  {expanded[step.id] ? (
                    <ChevronDown className="h-3 w-3" strokeWidth={2} />
                  ) : (
                    <ChevronRight className="h-3 w-3" strokeWidth={2} />
                  )}
                </button>
              ) : (
                <div className="wf-plan-expand-placeholder" />
              )}
              <div className={`wf-plan-step-icon ${step.status === "running" ? "wf-plan-step-icon--running" : ""}`}>
                {statusIcon(step.status)}
              </div>
              <span className={`wf-plan-step-name ${step.status === "running" ? "wf-plan-step-name--running" : ""}`}>
                {step.name}
              </span>
              <span className="wf-plan-step-agent">{agentLabel[step.agent] ?? step.agent}</span>
              {step.duration && <span className="wf-plan-step-time">{step.duration}</span>}
            </div>
            {expanded[step.id] && step.description && <div className="wf-plan-step-desc">{step.description}</div>}
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-4 border-t border-[var(--wf-line)] bg-[var(--wf-bg)] px-5 py-2.5 text-[11px]">
        <span className="text-[var(--wf-dim)]">Plan generated by planner agent</span>
        <span className="ml-auto font-mono text-[10px] text-[var(--wf-dim)]">{new Date().toLocaleTimeString()}</span>
      </div>
    </div>
  )
}

export const planToolPlugin: ToolPlugin = {
  id: "plan-tool",
  name: "Plan",
  icon: BrainCircuit,
  supportedTypes: ["plan"],
  priority: 70,
  component: PlanTool,
  getData: (detail: unknown): ToolData => {
    const d = detail as Detail | null
    return {
      status: "idle",
      rawData: d?.stateJson,
    }
  },
  matches: (nodeType: string, detail: unknown): boolean => {
    return nodeType === "plan"
  },
}
