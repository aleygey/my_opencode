/** @jsxImportSource react */
import { useState } from 'react'
import { Pencil, BrainCircuit, Activity, Crosshair, Timer, Cpu, Terminal, Layers, Sparkles } from 'lucide-react'
import type { Detail } from '../app'
import { Spin } from './spin'
import { distillTitle } from '../utils/distill-title'

interface Flow {
  goal: string
  phase: string
  overallStatus: 'running' | 'completed' | 'failed' | 'idle'
}

interface Agent {
  name: string
  model: string
  role: string
  nodeIDs?: string[]
  /** True when `model` came from the orchestrator session/agent
   *  fallback rather than an explicit `node.model` assignment.
   *  Drives the "inherits" pill + neutral label colour so users
   *  don't see a red "route required" when in fact the runtime
   *  WILL auto-route the node at execute time. */
  inherited?: boolean
}

interface Props {
  nodeDetails: Detail | null
  workflowContext: Flow
  agents: Agent[]
  onModelClick?: (nodeIDs?: string[]) => void
}

const agentColors = [
  { bg: 'rgba(117, 120, 197, 0.07)', ring: 'rgba(117, 120, 197, 0.15)', icon: '#7578c5' },
  { bg: 'rgba(77, 158, 138, 0.07)', ring: 'rgba(77, 158, 138, 0.15)', icon: '#4d9e8a' },
  { bg: 'rgba(201, 148, 62, 0.07)', ring: 'rgba(201, 148, 62, 0.15)', icon: '#c9943e' },
  { bg: 'rgba(192, 110, 150, 0.07)', ring: 'rgba(192, 110, 150, 0.15)', icon: '#c06e96' },
  { bg: 'rgba(96, 136, 193, 0.07)', ring: 'rgba(96, 136, 193, 0.15)', icon: '#6088c1' },
]

/* ── Metric tile ── */
function Metric({ label, value, icon: Icon, accent }: {
  label: string
  value: string
  icon: typeof Activity
  accent?: boolean
}) {
  return (
    <div className="wf-inspector-metric group">
      <div className="flex items-center gap-1.5">
        <Icon className="h-3 w-3 text-[var(--wf-dim)] transition group-hover:text-[var(--wf-ink-soft)]" strokeWidth={1.6} />
        <span className="text-[10px] font-medium uppercase tracking-[0.05em] text-[var(--wf-dim)]">{label}</span>
      </div>
      <div className={`mt-1 break-words text-[12.5px] font-semibold tabular-nums tracking-[-0.01em] ${accent ? 'text-[var(--wf-ok)]' : 'text-[var(--wf-ink)]'}`}>
        {value}
      </div>
    </div>
  )
}

/* ── Clickable model tile ──
 *
 * Variant of Metric that opens the model picker on click. Shares the same
 * visual footprint so the metrics grid stays aligned; adds a pencil affordance
 * on hover to signal editability. */
function ClickableModelTile({ label, onClick }: { label: string; onClick: () => void }) {
  const unset = !label || label === 'route required' || label === 'No model configured'
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      className="wf-inspector-metric group cursor-pointer transition hover:bg-[var(--wf-chip)]"
      title="Click to change model"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Cpu className="h-3 w-3 text-[var(--wf-dim)] transition group-hover:text-[var(--wf-ink-soft)]" strokeWidth={1.6} />
          <span className="text-[10px] font-medium uppercase tracking-[0.05em] text-[var(--wf-dim)]">Model</span>
        </div>
        <Pencil className="h-3 w-3 opacity-0 text-[var(--wf-dim)] transition group-hover:opacity-100" strokeWidth={1.8} />
      </div>
      <div
        className="mt-1 break-words text-[12.5px] font-semibold tracking-[-0.01em]"
        style={{ color: unset ? 'var(--wf-bad, #c96b6b)' : 'var(--wf-ink)' }}
      >
        {label || 'No model configured'}
      </div>
    </div>
  )
}

/* ── Event line: humanise `kind · summary` into a friendlier row ── */
function humaniseEventKind(kind: string): string {
  const map: Record<string, string> = {
    'node.created': 'Created',
    'node.started': 'Started',
    'node.completed': 'Completed',
    'node.failed': 'Failed',
    'node.paused': 'Paused',
    'node.resumed': 'Resumed',
    'node.routed': 'Model routed',
    'node.updated': 'Updated',
    'node.control': 'Control',
    'node.pulled': 'Pulled',
    'workflow.started': 'Workflow started',
    'workflow.completed': 'Workflow completed',
    'workflow.failed': 'Workflow failed',
  }
  return map[kind] ?? kind.replace(/^[a-z]+\./, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function EventRow({ text, index }: { text: string; index: number }) {
  // `text` has the shape `kind · summary` (see workflow-panel.ts `eventNote`).
  const sep = text.indexOf(' · ')
  const kind = sep >= 0 ? text.slice(0, sep) : text
  const summary = sep >= 0 ? text.slice(sep + 3) : ''
  const label = humaniseEventKind(kind)
  const tone =
    kind.endsWith('.failed') ? 'bad' :
    kind.endsWith('.completed') ? 'ok' :
    kind.endsWith('.started') || kind.endsWith('.resumed') ? 'active' :
    'dim'

  return (
    <div className="wf-inspector-event">
      <span className={`wf-inspector-event-dot wf-inspector-event-dot--${tone}`} />
      <span className="wf-inspector-event-num">{String(index + 1).padStart(2, '0')}</span>
      <span className="wf-inspector-event-label">{label}</span>
      {summary && <span className="wf-inspector-event-summary">{summary}</span>}
    </div>
  )
}

/* ── State key-value list: only readable primitives, with raw JSON toggle ── */
function prettyKey(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function isRenderableValue(v: unknown): boolean {
  if (v == null || v === '') return false
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return true
  if (Array.isArray(v)) return v.length > 0 && v.every((x) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean')
  return false
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.join(', ')
  return ''
}

function StatePanel({ json }: { json: Record<string, unknown> }) {
  const [raw, setRaw] = useState(false)
  const entries = Object.entries(json).filter(([, v]) => isRenderableValue(v))

  if (entries.length === 0 && !raw) {
    // Nothing displayable and user hasn't opened raw view — offer just the toggle.
    return (
      <div className="flex items-center justify-between">
        <span className="text-[11px] italic text-[var(--wf-dim)]">No readable state fields</span>
        <button className="wf-inspector-raw-toggle" onClick={() => setRaw(true)}>Raw JSON</button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end">
        <button className="wf-inspector-raw-toggle" onClick={() => setRaw((v) => !v)}>
          {raw ? 'Formatted' : 'Raw JSON'}
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

/* ── Agent card ── */
function AgentCard({
  item,
  index,
  onModelClick,
}: {
  item: Agent
  index: number
  onModelClick?: (nodeIDs?: string[]) => void
}) {
  const color = agentColors[index % agentColors.length]
  // Three display states:
  //   "unset"     — no model anywhere, runtime would block on execute.
  //                 Render in red so the user knows action is needed.
  //   "inherited" — node.model is empty BUT the session has a current
  //                 model that will auto-route at execute time. Render
  //                 in neutral colour with an "inherits" hint chip so
  //                 the user sees what model will actually be used and
  //                 isn't misled into thinking nothing's configured.
  //                 Fixes the user report "配置了，但是显示还是 required".
  //   "explicit"  — node.model is set; the model is locked in.
  const unset =
    !item.model || item.model === 'route required' || item.model === 'No model configured'
  const inherited = !unset && !!item.inherited
  const label = item.model || 'No model configured'
  const openPicker = () => onModelClick?.(item.nodeIDs)
  const labelColor = unset
    ? 'var(--wf-bad, #c96b6b)'
    : inherited
      ? 'var(--wf-dim)'
      : 'var(--wf-ink-soft)'

  return (
    <div className="wf-inspector-agent group relative">
      <div className="flex items-start gap-2.5">
        {/* Colored avatar */}
        <div
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[8px] transition group-hover:scale-[1.04]"
          style={{ background: color.bg, boxShadow: `0 0 0 1px ${color.ring}` }}
        >
          <BrainCircuit className="h-[14px] w-[14px]" strokeWidth={1.7} style={{ color: color.icon }} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[12px] font-semibold tracking-[-0.01em] text-[var(--wf-ink)]">{item.name}</span>
            <span className="truncate text-[10.5px] text-[var(--wf-dim)]">{item.role}</span>
            {inherited && (
              <span
                className="ml-auto flex-shrink-0 rounded-[4px] border px-1.5 py-px text-[9.5px] font-bold uppercase tracking-[0.08em]"
                style={{
                  borderColor: 'var(--wf-warn, oklch(0.70 0.15 70))',
                  background: 'color-mix(in oklch, var(--wf-warn, oklch(0.70 0.15 70)) 12%, transparent)',
                  color: 'var(--wf-warn, oklch(0.60 0.18 70))',
                }}
                title="此节点没有自己的模型，运行时会临时使用 orchestrator session 的当前模型。点下面的模型 pill 给本节点设置独立的模型，避免和 master 共用。"
              >
                继承 master
              </span>
            )}
          </div>

          {/* Model pill — clicking opens the native model picker directly */}
          <div
            role="button"
            tabIndex={0}
            onClick={openPicker}
            onKeyDown={(e) => { if (e.key === 'Enter') openPicker() }}
            className="wf-model-trigger"
            data-unset={unset ? 'true' : 'false'}
            data-inherited={inherited ? 'true' : 'false'}
            title={
              unset
                ? 'No model assigned — pick one to route this agent'
                : inherited
                  ? '当前没有独立模型，运行时继承 master session — 点击设置本节点专属模型'
                  : 'Click to change model'
            }
          >
            <Cpu className="h-3 w-3 flex-shrink-0 text-[var(--wf-dim)]" strokeWidth={1.8} />
            <span
              className="min-w-0 flex-1 truncate font-mono font-medium"
              style={{
                color: labelColor,
                // When inherited, italicise + mute so the user can see at a
                // glance "this isn't this slave's own model, it's piggybacking
                // on master's session model". Without this, picking a new
                // master model makes every inheriting slave card display the
                // new value and the user thought "all agents changed when I
                // changed one" — when really only master changed and the
                // slaves were inheriting the whole time.
                fontStyle: inherited ? 'italic' : 'normal',
                opacity: inherited ? 0.65 : 1,
              }}
            >
              {inherited ? `${label}（继承）` : label}
            </span>
            <Pencil className="h-3 w-3 flex-shrink-0 text-[var(--wf-dim)]" strokeWidth={1.8} />
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── Section divider ── */
function Divider() {
  return (
    <div className="flex items-center gap-3 py-0.5">
      <div className="h-px flex-1 bg-[var(--wf-line)]" />
      <div className="h-1 w-1 rounded-full bg-[var(--wf-line-strong)]" />
      <div className="h-px flex-1 bg-[var(--wf-line)]" />
    </div>
  )
}

/* ── Section label ── */
function SectionLabel({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[10.5px] font-bold uppercase tracking-[0.07em] text-[var(--wf-dim)]">{children}</span>
      {count !== undefined && (
        <span className="flex h-[20px] min-w-[20px] items-center justify-center rounded-full bg-[var(--wf-chip)] px-1.5 text-[10px] font-bold tabular-nums text-[var(--wf-dim)]">
          {count}
        </span>
      )}
    </div>
  )
}

/* ── Collapsible section wrapper ──
 * Per the "Inspector visual = design, content = original, support
 * folding" instruction. State persists in localStorage per `id` so the
 * user's open/closed preference survives panel re-mounts and refreshes.
 */
const COLLAPSE_PREFIX = 'wf-inspector-collapsed:'
function readCollapsed(id: string, defaultClosed = false): boolean {
  if (typeof localStorage === 'undefined') return defaultClosed
  try {
    const v = localStorage.getItem(COLLAPSE_PREFIX + id)
    if (v === '1') return true
    if (v === '0') return false
    return defaultClosed
  } catch { return defaultClosed }
}
function writeCollapsed(id: string, closed: boolean): void {
  if (typeof localStorage === 'undefined') return
  try { localStorage.setItem(COLLAPSE_PREFIX + id, closed ? '1' : '0') } catch {}
}

function CollapsibleSection({
  id,
  title,
  count,
  hint,
  defaultClosed = false,
  children,
}: {
  id: string
  title: string
  count?: number
  hint?: string
  defaultClosed?: boolean
  children: React.ReactNode
}) {
  const [closed, setClosed] = useState<boolean>(() => readCollapsed(id, defaultClosed))
  const toggle = () => {
    setClosed((prev) => {
      const next = !prev
      writeCollapsed(id, next)
      return next
    })
  }
  return (
    <section className="space-y-2">
      <button
        type="button"
        onClick={toggle}
        className="wf-insp-collapse-hd"
        aria-expanded={!closed}
        title={closed ? 'Expand' : 'Collapse'}
      >
        <span
          className="wf-insp-collapse-caret"
          aria-hidden
          data-open={closed ? 'false' : 'true'}
        >
          ▾
        </span>
        <span className="text-[10.5px] font-bold uppercase tracking-[0.07em] text-[var(--wf-dim)]">{title}</span>
        {hint && (
          <span className="ml-1 text-[10px] font-normal normal-case tracking-normal text-[var(--wf-dim)]">{hint}</span>
        )}
        {count !== undefined && (
          <span className="ml-auto flex h-[20px] min-w-[20px] items-center justify-center rounded-full bg-[var(--wf-chip)] px-1.5 text-[10px] font-bold tabular-nums text-[var(--wf-dim)]">
            {count}
          </span>
        )}
      </button>
      {!closed && <div className="space-y-2">{children}</div>}
    </section>
  )
}

/* ── Status indicator (animated) ── */
function StatusIndicator({ status }: { status: string }) {
  const run = status === 'running'
  const done = status === 'completed'
  const fail = status === 'failed'

  if (run) {
    return (
      <div className="relative flex h-7 w-7 flex-shrink-0 items-center justify-center">
        <div className="absolute inset-0 rounded-lg bg-[var(--wf-ok-soft)] wf-pulse" />
        <Spin size={15} tone="var(--wf-ok)" line={1.8} />
      </div>
    )
  }

  return (
    <div className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg ${
      done ? 'bg-[var(--wf-ok-soft)]' :
      fail ? 'bg-[rgba(239,68,68,0.08)]' :
      'bg-[var(--wf-chip)]'
    }`}>
      <div className={`h-2 w-2 rounded-full ${
        done ? 'bg-[var(--wf-ok)]' :
        fail ? 'bg-[var(--wf-bad)]' :
        'bg-[var(--wf-dim)]'
      }`} />
    </div>
  )
}

/* ── Main panel ── */
export function EnhancedInspectorPanel(props: Props) {
  const run = props.workflowContext.overallStatus === 'running'
  const d = props.nodeDetails

  const statusLabel =
    run ? 'Executing' :
    props.workflowContext.overallStatus === 'completed' ? 'Completed' :
    props.workflowContext.overallStatus === 'failed' ? 'Failed' : 'Idle'

  return (
    <div className="wf-inspector-root">
      {/* Header — design template uses a simple "Node · <title>" line
        * with an edit pencil right side. We mirror that: when no node
        * is selected, fall back to a plain "Inspector" label. */}
      <div className="wf-inspector-header">
        <div className="flex min-w-0 items-center gap-2">
          <Layers className="h-4 w-4 flex-none text-[var(--wf-dim)]" strokeWidth={1.8} />
          <span
            className="truncate text-[13px] font-semibold tracking-[-0.01em] text-[var(--wf-ink)]"
            title={d?.title ?? "Inspector"}
          >
            {/* Distill the planner-emitted title (it's often the whole
              * prompt body, not a clean task name). Same util the
              * canvas node uses, so the two surfaces agree. Full
              * text remains in the title= tooltip. */}
            {d ? `Node · ${distillTitle(d.title, 38)}` : 'Inspector'}
          </span>
        </div>
        {d && (
          <button
            type="button"
            className="wf-insp-edit-btn"
            title="Pop out / edit"
            aria-label="Pop out"
          >
            <Pencil className="h-3 w-3" strokeWidth={1.8} />
          </button>
        )}
      </div>

      {/* Inspector body — design-spec sections only:
        *   Selected Node (KV + re-run/logs)
        *   LLM Route (clickable agent rows)
        *   Recent Events (from executionLog)
        * The legacy Workflow status card and per-section collapse
        * carets were removed per the user's "framework matches design,
        * content matches functionality" direction. */}
      <div className="wf-inspector-body">
        <div className="space-y-3 px-4 py-4">

          {/* ── Selected Node KV — primary section. Only shown when a
              node is selected; otherwise the page hints "select a node". */}
          {d ? (
            <section className="space-y-2">
              <div className="wf-insp-sec-hd">Selected node</div>
              <dl className="wf-kv">
                {/* `id` (long sand-table:UUID) was high-noise / low-signal
                  * — dropped. The id is recoverable in the URL / events
                  * tab if anyone needs it for debugging. `re-run` and
                  * `logs` action buttons also dropped: re-run isn't
                  * meaningful for a completed plan node, and logs are
                  * already exposed via the canvas Events tab + the
                  * dynamic node tab's session view. */}
                <dt>kind</dt><dd>{d.type}</dd>
                <dt>state</dt>
                <dd className="flex items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 rounded-full ${
                    d.status === 'running' ? 'bg-[var(--wf-ok)] wf-pulse' :
                    d.status === 'completed' ? 'bg-[var(--wf-ok)]' :
                    d.status === 'failed' ? 'bg-[var(--wf-bad)]' :
                    'bg-[var(--wf-dim)]'
                  }`} />
                  <span className="capitalize">{d.status}</span>
                </dd>
                {d.duration && (<><dt>dur</dt><dd>{d.duration}</dd></>)}
                {/* "result" was ambiguous (current state vs final
                  * checkpoint?). Rename to "outcome" — it's the
                  * checkpoint emitted when the node finished, not the
                  * live state (which `state` already shows). */}
                {d.result && (<><dt>outcome</dt><dd>{d.result}</dd></>)}
                <dt>model</dt>
                <dd>
                  <button
                    type="button"
                    className="wf-insp-model-link"
                    onClick={() => props.onModelClick?.([d.id])}
                    title="Reroute model for this node"
                  >
                    {d.model || <span className="italic text-[var(--wf-dim)]">—</span>}
                  </button>
                </dd>
              </dl>
            </section>
          ) : (
            <section className="wf-insp-empty">
              Select a node from the canvas to inspect its state.
            </section>
          )}

          {d && <Divider />}

          {/* ── LLM Route — design-spec: count + click-to-reroute hint right. */}
          <section className="space-y-2">
            <div className="wf-insp-sec-hd flex items-center gap-2">
              <span>LLM route</span>
              <span className="font-mono text-[var(--wf-ink)]">· {props.agents.length}</span>
              <span className="ml-auto text-[10px] font-normal tracking-normal text-[var(--wf-dim)]">
                click to reroute
              </span>
            </div>
            <div className="space-y-0.5">
              {props.agents.map((item, i) => (
                <AgentCard
                  key={item.name}
                  item={item}
                  index={i}
                  onModelClick={props.onModelClick}
                />
              ))}
            </div>
          </section>

          {/* ── Recent Events — only when present; design has no
              collapse on this either. */}
          {d && d.executionLog && d.executionLog.length > 0 && (
            <>
              <Divider />
              <section className="space-y-2">
                <div className="wf-insp-sec-hd flex items-center gap-2">
                  <span>RECENT EVENTS</span>
                  <span className="font-mono text-[var(--wf-ink)]">· {d.executionLog.length}</span>
                </div>
                <div className="wf-inspector-events">
                  {d.executionLog.map((line, i) => (
                    <EventRow key={i} text={line.replace(/^\[\d+\]\s*/, '')} index={i} />
                  ))}
                </div>
              </section>
            </>
          )}

          {/* Legacy components (StatePanel / Metric grid / CollapsibleSection
            * / etc.) are no longer rendered per the design template. They
            * remain defined above for any debugging path that might mount
            * them directly; explicit no-ops avoid unused-import lint
            * without re-introducing them in the visible tree. */}
          {void [
            statusLabel,
            run,
            Sparkles,
            BrainCircuit,
            Crosshair,
            Activity,
            Terminal,
            Timer,
            ClickableModelTile,
            Metric,
            CollapsibleSection,
            SectionLabel,
            StatusIndicator,
            StatePanel,
          ]}

          <div className="h-4" />
        </div>
      </div>
    </div>
  )
}
