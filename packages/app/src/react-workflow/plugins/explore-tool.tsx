/** @jsxImportSource react */
import { useMemo, useState } from "react"
import {
  Compass,
  FileSearch,
  Search,
  ChevronRight,
  ChevronDown,
  ListTree,
  HelpCircle,
  X,
} from "lucide-react"
import type { ToolPlugin, PluginContext } from "./types"
import type { Detail } from "../app"

/**
 * Surface for the `explore` agent — a read-only research subagent the master
 * orchestrator delegates to during planning. The right-rail view shows:
 *
 * - A timeline of the explore agent's reasoning chain (each entry corresponds
 *   to one tool call: glob, grep, read, web fetch, etc.).
 * - Aggregate stats — number of files inspected, queries issued, total steps.
 *
 * Data source priority:
 *   1. `detail.executionLog` — already populated for any agent that streams
 *      step lines back into the inspector.
 *   2. Heuristic parse of `detail.stateJson.tool_calls` if the structured
 *      timeline is present.
 *   3. Fallback empty state with onboarding text — keeps the right-rail
 *      navigable even before any work has streamed in.
 */

type Step = {
  id: string
  index: number
  /** Tool the explore agent invoked, e.g. "glob", "grep", "read", "web_fetch". */
  tool: string
  /** One-line summary of the step (query, path, or first chunk of output). */
  summary: string
  /** Optional structured detail — full args / preview blob — shown on expand. */
  detail?: string
  /** ISO time or relative tag if available. */
  at?: string
}

const TOOL_ICONS: Record<string, typeof Search> = {
  glob: ListTree,
  grep: Search,
  read: FileSearch,
  search: Search,
  web_fetch: Compass,
  web_search: Compass,
}

function classifyTool(name: string): keyof typeof TOOL_ICONS | "other" {
  const k = name.toLowerCase()
  if (k.includes("glob")) return "glob"
  if (k.includes("grep") || k.includes("search")) return "grep"
  if (k.includes("read") || k.includes("file")) return "read"
  if (k.includes("fetch") || k.includes("web")) return "web_fetch"
  return "other"
}

function deriveSteps(detail: Detail | null): Step[] {
  if (!detail) return []

  // Path 1 — structured tool_calls in stateJson.
  const raw = detail.stateJson?.["tool_calls"]
  if (Array.isArray(raw)) {
    const out: Step[] = []
    raw.forEach((entry, idx) => {
      if (!entry || typeof entry !== "object") return
      const e = entry as Record<string, unknown>
      const tool = String(e.tool ?? e.name ?? "tool")
      const summary = String(e.summary ?? e.query ?? e.path ?? "")
      const dt = typeof e.detail === "string" ? e.detail : undefined
      const at = typeof e.at === "string" ? e.at : undefined
      out.push({ id: `tc-${idx}`, index: idx + 1, tool, summary, detail: dt, at })
    })
    return out
  }

  // Path 2 — fallback parse of executionLog lines like "[glob] **/*.ts".
  if (detail.executionLog?.length) {
    return detail.executionLog.map((line, idx) => {
      const m = /^\s*\[([^\]]+)\]\s*(.*)$/.exec(line)
      if (m) {
        return { id: `el-${idx}`, index: idx + 1, tool: m[1], summary: m[2] } satisfies Step
      }
      return { id: `el-${idx}`, index: idx + 1, tool: "step", summary: line } satisfies Step
    })
  }

  return []
}

function ExploreTool({ nodeStatus, detail }: PluginContext<Detail | null>) {
  const steps = useMemo(() => deriveSteps(detail), [detail])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [showHelp, setShowHelp] = useState(false)

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const stats = useMemo(() => {
    const files = new Set<string>()
    let queries = 0
    for (const s of steps) {
      const k = classifyTool(s.tool)
      if (k === "glob" || k === "grep") queries += 1
      if (k === "read") files.add(s.summary.split(/\s+/)[0] ?? "")
    }
    return { files: files.size, queries, steps: steps.length }
  }, [steps])

  return (
    <div className="wf-detail-code">
      <div className="wf-detail-panel-header">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Compass className="h-3.5 w-3.5 text-[var(--wf-dim)]" strokeWidth={1.8} />
            <span className="text-[11px] font-bold uppercase tracking-[0.07em] text-[var(--wf-dim)]">
              Reasoning Chain
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                nodeStatus === "running"
                  ? "bg-[var(--wf-warn-soft,var(--wf-chip))] text-[var(--wf-warn,var(--wf-dim))]"
                  : "bg-[var(--wf-chip)] text-[var(--wf-dim)]"
              }`}
            >
              {nodeStatus === "running" ? (
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
              ) : null}
              {nodeStatus === "running" ? "exploring" : nodeStatus}
            </span>
            <button
              className="p-1 rounded hover:bg-[var(--wf-chip)] transition"
              onClick={() => setShowHelp((v) => !v)}
              title={showHelp ? "Hide help" : "What is this panel?"}
              aria-label="Reasoning chain help"
              aria-pressed={showHelp}
            >
              <HelpCircle
                className={`h-3.5 w-3.5 ${showHelp ? "text-[var(--wf-fg,var(--wf-dim))]" : "text-[var(--wf-dim)]"}`}
                strokeWidth={1.8}
              />
            </button>
          </div>
        </div>

        {showHelp && (
          <div className="mt-3 px-3 py-2.5 rounded-lg bg-[var(--wf-panel)] border border-[var(--wf-line)] text-[11px] leading-relaxed text-[var(--wf-fg,var(--wf-dim))]">
            <div className="flex items-start justify-between gap-2 mb-1.5">
              <span className="font-semibold uppercase tracking-[0.07em] text-[var(--wf-dim)]">
                Reasoning Chain — Quick Help
              </span>
              <button
                className="p-0.5 -mt-0.5 rounded hover:bg-[var(--wf-chip)] transition"
                onClick={() => setShowHelp(false)}
                title="Close"
                aria-label="Close help"
              >
                <X className="h-3 w-3 text-[var(--wf-dim)]" strokeWidth={2} />
              </button>
            </div>
            <p className="mb-1.5 text-[var(--wf-dim)]">
              Each row is one tool call the explore agent issued while researching the task — read-only
              probes only (no file edits, no shell mutations). Click a row to see the full args/preview.
            </p>
            <ul className="space-y-0.5 list-disc pl-4 text-[var(--wf-dim)]">
              <li>
                <span className="font-semibold text-[var(--wf-fg,var(--wf-dim))]">glob / grep</span> — file
                or content search
              </li>
              <li>
                <span className="font-semibold text-[var(--wf-fg,var(--wf-dim))]">read</span> — file fetch
                (path appears in the summary)
              </li>
              <li>
                <span className="font-semibold text-[var(--wf-fg,var(--wf-dim))]">web_fetch</span> — outbound
                web doc fetch
              </li>
            </ul>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-b border-[var(--wf-line)] bg-[var(--wf-bg)] px-5 py-2 text-[11px] text-[var(--wf-dim)]">
        <span className="font-mono">{stats.steps} steps</span>
        <span className="text-[var(--wf-line-strong)]">·</span>
        <span>{stats.queries} queries</span>
        <span className="text-[var(--wf-line-strong)]">·</span>
        <span>{stats.files} files</span>
      </div>

      <div className="wf-detail-diff">
        {steps.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 py-12 text-[var(--wf-dim)]">
            <Compass className="h-8 w-8 opacity-30" strokeWidth={1.2} />
            <p className="text-[12px] text-center max-w-[28rem]">
              No reasoning steps yet. The explore agent's tool calls will appear here as it reads files,
              searches the codebase, and fetches docs.
            </p>
          </div>
        ) : (
          <ol className="flex flex-col gap-0">
            {steps.map((step) => {
              const klass = classifyTool(step.tool)
              const Icon = TOOL_ICONS[klass] ?? ChevronRight
              const isOpen = expanded.has(step.id)
              const canExpand = !!step.detail
              return (
                <li
                  key={step.id}
                  className="group border-b border-[var(--wf-line)] last:border-b-0 hover:bg-[var(--wf-chip)]/40"
                >
                  <button
                    className="flex w-full items-start gap-3 px-5 py-2 text-left"
                    onClick={() => canExpand && toggle(step.id)}
                    aria-expanded={canExpand ? isOpen : undefined}
                    disabled={!canExpand}
                  >
                    <span className="mt-0.5 font-mono text-[10px] text-[var(--wf-dim)] tabular-nums w-4 text-right">
                      {step.index}
                    </span>
                    <Icon className="h-3.5 w-3.5 mt-0.5 text-[var(--wf-dim)]" strokeWidth={1.8} />
                    <span className="flex-1 min-w-0">
                      <span className="block font-mono text-[11px] text-[var(--wf-fg,var(--wf-dim))] truncate">
                        {step.tool}
                        {step.summary ? <span className="text-[var(--wf-dim)]"> · {step.summary}</span> : null}
                      </span>
                      {step.at ? (
                        <span className="block font-mono text-[10px] text-[var(--wf-dim)] mt-0.5">
                          {step.at}
                        </span>
                      ) : null}
                    </span>
                    {canExpand ? (
                      isOpen ? (
                        <ChevronDown className="h-3.5 w-3.5 text-[var(--wf-dim)]" strokeWidth={1.8} />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 text-[var(--wf-dim)]" strokeWidth={1.8} />
                      )
                    ) : null}
                  </button>
                  {canExpand && isOpen && step.detail ? (
                    <pre className="px-5 pb-3 pl-[3.25rem] text-[11px] leading-relaxed text-[var(--wf-dim)] whitespace-pre-wrap break-words">
                      {step.detail}
                    </pre>
                  ) : null}
                </li>
              )
            })}
          </ol>
        )}
      </div>
    </div>
  )
}

export const exploreToolPlugin: ToolPlugin<Detail | null> = {
  id: "explore-tool",
  name: "Reasoning Chain",
  icon: Compass,
  // Below diff-tool (100) and execution-tool (~95?) so on coding nodes the diff
  // wins the first tab. On a pure `explore` node it's the only match anyway.
  priority: 80,
  component: ExploreTool,
  // Claim any explore node, and surface as a secondary tab on any node that has
  // emitted a structured `tool_calls` array (handy when a coding agent did a
  // research detour mid-task).
  match: (nodeType, detail) => {
    if (nodeType === "explore") return true
    const d = detail as Detail | null
    const raw = d?.stateJson?.["tool_calls"]
    return Array.isArray(raw) && raw.length > 0
  },
}
