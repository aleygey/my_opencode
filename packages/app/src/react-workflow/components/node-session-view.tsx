/** @jsxImportSource react */
import { useLayoutEffect, useMemo, useRef, useState } from "react"

import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  Clock,
  Cpu,
  Layers,
  ListOrdered,
  Play,
  Radio,
  RotateCcw,
  Sparkles,
  Square,
  StepForward,
  Zap,
  Hash,
} from "lucide-react"
import type { Detail, Status } from "../app"
import { ChatPanel } from "./chat-panel"
import type { Msg } from "./chat-panel"
import type { WorkflowPlan } from "./plan-card"
import type { PermissionReply } from "./permission-dialog"
import { SplitBar, useSplit } from "./split"
import { PluginSlot } from "./plugin-slot"
import { Spin } from "./spin"

type Kind = "coding" | "build-flash" | "debug" | "deploy" | "plan" | "explore"

export interface NodeSessionViewProps {
  nodeId: string
  nodeTitle: string
  nodeType: Kind
  nodeStatus: Status
  messages: Msg[]
  detail: Detail | null
  /** Chat panel passthrough props — match those used on the root workflow page */
  model?: string
  models?: string[]
  workspace?: string
  onModelChange?: (model: string) => void
  onWorkspaceClick?: () => void
  onNewSession?: () => void
  onModelPickerOpen?: () => void
  onPlanRun?: (plan: WorkflowPlan) => void
  onPlanEdit?: (context: string) => void
  onQuestionReply?: (requestID: string, answers: string[][]) => void
  onQuestionReject?: (requestID: string) => void
  onPermissionReply?: (requestID: string, reply: PermissionReply, message?: string) => void
  onBack: () => void
  onStop?: () => void
  onRestart?: () => void
  onStep?: () => void
  onRun?: () => void
  onSend: (text: string) => void
}

/* ── Humanise a raw backend event kind for display ── */
function humaniseEventKind(kind: string): string {
  const map: Record<string, string> = {
    "node.created": "Created",
    "node.started": "Started",
    "node.completed": "Completed",
    "node.failed": "Failed",
    "node.paused": "Paused",
    "node.resumed": "Resumed",
    "node.routed": "Model routed",
    "node.updated": "Updated",
    "node.control": "Control",
    "node.pulled": "Pulled",
    "workflow.started": "Workflow started",
    "workflow.completed": "Workflow completed",
    "workflow.failed": "Workflow failed",
  }
  return (
    map[kind] ??
    kind.replace(/^[a-z]+\./, "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  )
}

function prettyKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function isRenderableValue(v: unknown): boolean {
  if (v == null || v === "") return false
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return true
  if (Array.isArray(v))
    return (
      v.length > 0 &&
      v.every((x) => typeof x === "string" || typeof x === "number" || typeof x === "boolean")
    )
  return false
}

function formatValue(v: unknown): string {
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  if (Array.isArray(v)) return v.join(", ")
  return ""
}

/* ── A single metric chip in the status strip ── */
function StatusChip({
  icon: Icon,
  label,
  value,
  accent,
  tone,
}: {
  icon?: React.ElementType
  label: string
  value: React.ReactNode
  accent?: boolean
  tone?: "ok" | "warn" | "bad"
}) {
  const color =
    tone === "ok"
      ? "var(--wf-ok)"
      : tone === "warn"
        ? "var(--wf-warn, var(--wf-ok))"
        : tone === "bad"
          ? "var(--wf-bad)"
          : undefined
  return (
    <div className="wf-node-status-chip" data-accent={accent ? "true" : undefined}>
      {Icon && <Icon className="h-3 w-3 flex-shrink-0 text-[var(--wf-dim)]" strokeWidth={1.8} />}
      <span className="wf-node-status-chip-label">{label}</span>
      <span className="wf-node-status-chip-value" style={color ? { color } : undefined}>
        {value}
      </span>
    </div>
  )
}

/* ── Expand toggle button inside status strip ── */
function StripToggle({
  icon: Icon,
  label,
  count,
  open,
  onClick,
}: {
  icon: React.ElementType
  label: string
  count?: number
  open: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="wf-node-status-toggle"
      data-open={open ? "true" : "false"}
      onClick={onClick}
    >
      <Icon className="h-3 w-3" strokeWidth={1.8} />
      <span>{label}</span>
      {count !== undefined && (
        <span className="wf-node-status-toggle-count">{count}</span>
      )}
      <ChevronDown
        className="h-3 w-3 transition-transform"
        style={{ transform: open ? "rotate(180deg)" : undefined }}
        strokeWidth={2}
      />
    </button>
  )
}

/* ── Event row (reused pattern from inspector) ── */
function EventRow({ text, index }: { text: string; index: number }) {
  const sep = text.indexOf(" · ")
  const kind = sep >= 0 ? text.slice(0, sep) : text
  const summary = sep >= 0 ? text.slice(sep + 3) : ""
  const label = humaniseEventKind(kind)
  const tone =
    kind.endsWith(".failed")
      ? "bad"
      : kind.endsWith(".completed")
        ? "ok"
        : kind.endsWith(".started") || kind.endsWith(".resumed")
          ? "active"
          : "dim"

  return (
    <div className="wf-inspector-event">
      <span className={`wf-inspector-event-dot wf-inspector-event-dot--${tone}`} />
      <span className="wf-inspector-event-num">{String(index + 1).padStart(2, "0")}</span>
      <span className="wf-inspector-event-label">{label}</span>
      {summary && <span className="wf-inspector-event-summary">{summary}</span>}
    </div>
  )
}

/* ── State KV + raw JSON toggle (reused pattern from inspector) ── */
function StatePanel({ json }: { json: Record<string, unknown> }) {
  const [raw, setRaw] = useState(false)
  const entries = Object.entries(json).filter(([, v]) => isRenderableValue(v))

  if (entries.length === 0 && !raw) {
    return (
      <div className="flex items-center justify-between">
        <span className="text-[11px] italic text-[var(--wf-dim)]">No readable state fields</span>
        <button className="wf-inspector-raw-toggle" onClick={() => setRaw(true)}>
          Raw JSON
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end">
        <button className="wf-inspector-raw-toggle" onClick={() => setRaw((v) => !v)}>
          {raw ? "Formatted" : "Raw JSON"}
        </button>
      </div>
      {raw ? (
        <div className="wf-inspector-code">
          <pre>{JSON.stringify(json, null, 2)}</pre>
        </div>
      ) : (
        <div className="wf-inspector-kv">
          {entries.map(([k, v]) => (
            <div key={k} className="wf-inspector-kv-row">
              <span className="wf-inspector-kv-key">{prettyKey(k)}</span>
              <span className="wf-inspector-kv-val">{formatValue(v)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function NodeSessionView(props: NodeSessionViewProps) {
  // Default to a 50/50 split — the previous 420px initial value pushed the
  // chat into a narrow column that didn't match typical screen sizes. We
  // measure the container on first layout and set size to half its width;
  // user drags afterwards are preserved by the hook's internal state.
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const initialSize = typeof window !== "undefined" ? Math.round(window.innerWidth / 2) : 560
  const left = useSplit({ axis: "x", size: initialSize, min: 320, max: 2000 })
  const didSyncRef = useRef(false)
  // Sync exactly once on mount — after the user drags the splitter, we
  // respect their chosen size (useSplit owns state from that point on).
  useLayoutEffect(() => {
    if (didSyncRef.current) return
    const el = bodyRef.current
    if (!el) return
    const width = el.getBoundingClientRect().width
    if (width > 0) {
      left.setSize(Math.round(width / 2))
      didSyncRef.current = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [openPanel, setOpenPanel] = useState<"events" | "state" | null>(null)

  const run = props.nodeStatus === "running"
  const d = props.detail
  const logs = d?.executionLog ?? []
  const hasState = !!d?.stateJson && Object.keys(d.stateJson).length > 0

  const nodeRunning = useMemo(
    () =>
      run ||
      props.messages.some(
        (m) => m.thinking?.status === "running" || m.toolCall?.status === "running",
      ),
    [run, props.messages],
  )

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
              <span className="text-[10px] font-medium text-[var(--wf-dim)] capitalize">{d?.type ?? props.nodeType}</span>
            </div>
          </div>

          <div className="wf-topbar-sep" />

          {/* Status pill */}
          <div className={["wf-topbar-status", run ? "wf-topbar-status--running" : ""].join(" ")}>
            {run ? (
              <Spin size={13} tone="var(--wf-ok)" line={1.5} />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5 text-[var(--wf-ok)]" strokeWidth={2} />
            )}
            <span className="text-[11px] font-semibold capitalize">{run ? "Running" : props.nodeStatus}</span>
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

      {/* ─── Status strip (replaces right-hand state panel) ─── */}
      <div className="wf-node-status-strip">
        <div className="wf-node-status-chips">
          {d?.model && <StatusChip icon={Cpu} label="Model" value={d.model} />}
          {d?.attempt && <StatusChip icon={Activity} label="Attempt" value={d.attempt} />}
          {d?.actions && <StatusChip icon={Zap} label="Actions" value={d.actions} />}
          {d?.duration && (
            <StatusChip icon={Clock} label="Duration" value={d.duration} accent />
          )}
          {(d?.pendingCommands ?? 0) > 0 && (
            <StatusChip
              icon={Radio}
              label="Pending"
              tone="warn"
              value={d?.pendingCommands ?? 0}
            />
          )}
          {d?.lastControl && d.lastControl !== "none" && (
            <StatusChip label="Control" value={d.lastControl} tone="ok" />
          )}
          {d?.lastPull && d.lastPull !== "—" && d.lastPull !== "none" && (
            <StatusChip label="Pull" value={d.lastPull} />
          )}
        </div>

        <div className="wf-node-status-toggles">
          {logs.length > 0 && (
            <StripToggle
              icon={ListOrdered}
              label="Events"
              count={logs.length}
              open={openPanel === "events"}
              onClick={() => setOpenPanel(openPanel === "events" ? null : "events")}
            />
          )}
          {hasState && (
            <StripToggle
              icon={Hash}
              label="State"
              open={openPanel === "state"}
              onClick={() => setOpenPanel(openPanel === "state" ? null : "state")}
            />
          )}
        </div>
      </div>

      {/* ─── Collapsible detail drawer (events / state) ─── */}
      {openPanel === "events" && logs.length > 0 && (
        <div className="wf-node-drawer wf-slide-up">
          <div className="wf-node-drawer-body">
            <div className="wf-inspector-events">
              {logs.map((line, i) => (
                <EventRow key={i} text={line.replace(/^\[\d+\]\s*/, "")} index={i} />
              ))}
            </div>
          </div>
        </div>
      )}
      {openPanel === "state" && hasState && (
        <div className="wf-node-drawer wf-slide-up">
          <div className="wf-node-drawer-body">
            <StatePanel json={d.stateJson} />
          </div>
        </div>
      )}

      {/* ─── 2-column body: chat | plugin slot (plugin fills remaining width) ─── */}
      <div ref={bodyRef} className="flex min-h-0 flex-1">
        {/* ── Left: Chat (shared ChatPanel — identical to root page) ── */}
        <div className="flex min-h-0 flex-shrink-0 flex-col" style={{ width: left.size }}>
          <ChatPanel
            messages={props.messages}
            model={props.model ?? props.detail?.model}
            models={props.models}
            workspace={props.workspace}
            onSendMessage={(text) => props.onSend(text)}
            onModelChange={props.onModelChange}
            onWorkspaceClick={props.onWorkspaceClick}
            onNewSession={props.onNewSession}
            onModelPickerOpen={props.onModelPickerOpen}
            onPlanRun={props.onPlanRun}
            onPlanEdit={props.onPlanEdit}
            isRunning={nodeRunning}
            onStop={props.onStop}
            onQuestionReply={props.onQuestionReply}
            onQuestionReject={props.onQuestionReject}
            onPermissionReply={props.onPermissionReply}
          />
        </div>

        <SplitBar axis="x" {...left.bind} />

        {/* ── Right: Plugin slot occupies all remaining width ── */}
        <div className="flex min-w-0 flex-1 flex-col">
          <PluginSlot
            nodeId={props.nodeId}
            nodeType={props.nodeType}
            nodeStatus={props.nodeStatus}
            detail={props.detail}
          />
        </div>
      </div>

    </div>
  )
}
