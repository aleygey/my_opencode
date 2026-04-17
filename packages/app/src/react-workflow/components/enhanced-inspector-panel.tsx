/** @jsxImportSource react */
import { useState } from 'react'
import { Pencil, BrainCircuit, Activity, Crosshair, Timer, Cpu, Terminal, Layers, Sparkles } from 'lucide-react'
import type { Detail } from '../app'
import { Spin } from './spin'

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
  const unset = !item.model || item.model === 'route required' || item.model === 'No model configured'
  const label = item.model || 'No model configured'
  const openPicker = () => onModelClick?.(item.nodeIDs)

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
          </div>

          {/* Model pill — clicking opens the native model picker directly */}
          <div
            role="button"
            tabIndex={0}
            onClick={openPicker}
            onKeyDown={(e) => { if (e.key === 'Enter') openPicker() }}
            className="wf-model-trigger"
            data-unset={unset ? 'true' : 'false'}
            title="Select model"
          >
            <Cpu className="h-3 w-3 flex-shrink-0 text-[var(--wf-dim)]" strokeWidth={1.8} />
            <span
              className="min-w-0 flex-1 truncate font-mono font-medium"
              style={{ color: unset ? 'var(--wf-bad, #c96b6b)' : 'var(--wf-ink-soft)' }}
            >
              {label}
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
      {/* ─── Sticky header ─── */}
      <div className="wf-inspector-header">
        <div className="flex items-center gap-2.5">
          <Layers className="h-4 w-4 text-[var(--wf-dim)]" strokeWidth={1.8} />
          <span className="text-[13px] font-bold tracking-[-0.01em] text-[var(--wf-ink)]">Inspector</span>
        </div>
        {d && (
          <div className="flex items-center gap-1.5 rounded-lg bg-[var(--wf-chip)] px-2.5 py-1">
            <span className="max-w-[280px] break-all text-[11px] font-medium text-[var(--wf-ink-soft)]">{d.title}</span>
          </div>
        )}
      </div>

      {/* ─── Scrollable body ─── */}
      <div className="wf-inspector-body">
        <div className="space-y-4 px-4 py-4">

          {/* ── Workflow Context ── */}
          <section className="space-y-2 wf-slide-up" style={{ animationDelay: '0ms' }}>
            <SectionLabel>Workflow</SectionLabel>

            <div className="wf-inspector-context-card">
              {/* Accent bar */}
              <div className={`absolute left-0 top-2.5 bottom-2.5 w-[2px] rounded-r-full ${
                run ? 'bg-[var(--wf-ok)] wf-pulse' :
                props.workflowContext.overallStatus === 'completed' ? 'bg-[var(--wf-ok)]' :
                props.workflowContext.overallStatus === 'failed' ? 'bg-[var(--wf-bad)]' :
                'bg-[var(--wf-dim)]'
              }`} />

              <div className="flex items-start gap-2.5 pl-2.5">
                <StatusIndicator status={props.workflowContext.overallStatus} />
                <div className="min-w-0 flex-1 pt-px">
                  <div className="flex items-center gap-2">
                    <span className="text-[12.5px] font-bold tracking-[-0.01em] text-[var(--wf-ink)]">{statusLabel}</span>
                    {run && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--wf-ok-soft)] px-1.5 py-[1px] text-[9px] font-bold uppercase tracking-[0.05em] text-[var(--wf-ok-strong)]">
                        <Sparkles className="h-2.5 w-2.5" strokeWidth={2} />
                        live
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[11px] text-[var(--wf-ink-soft)]">{props.workflowContext.phase}</div>
                </div>
              </div>

              <div className="mt-2 border-t border-dashed border-[var(--wf-line)] pl-2.5 pt-2">
                <p className="text-[11.5px] leading-[1.55] text-[var(--wf-ink-soft)] line-clamp-3">{props.workflowContext.goal}</p>
              </div>
            </div>
          </section>

          <Divider />

          {/* ── Agents ── */}
          <section className="space-y-2 wf-slide-up" style={{ animationDelay: '50ms' }}>
            <SectionLabel count={props.agents.length}>Agents</SectionLabel>
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

          {/* ── Selected Node ── */}
          {d && (
            <>
              <Divider />

              <section className="space-y-3 wf-slide-up" style={{ animationDelay: '100ms' }}>
                <SectionLabel>Node Detail</SectionLabel>

                {/* Node header */}
                <div className="wf-inspector-node-header">
                  <div className="flex items-center gap-2">
                    <div className={`h-2 w-2 flex-shrink-0 rounded-full ${
                      d.status === 'completed' ? 'bg-[var(--wf-ok)]' :
                      d.status === 'running' ? 'bg-[var(--wf-ok)] wf-pulse' :
                      d.status === 'failed' ? 'bg-[var(--wf-bad)]' :
                      'bg-[var(--wf-dim)]'
                    }`} />
                    <span className="truncate text-[12.5px] font-bold tracking-[-0.01em] text-[var(--wf-ink)]">{d.title}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-4">
                    <span data-wf-badge="">{d.type}</span>
                    <span data-wf-badge="" className="capitalize">{d.status}</span>
                    {d.duration && (
                      <span data-wf-badge="">
                        <Timer className="h-3 w-3" strokeWidth={1.8} />
                        {d.duration}
                      </span>
                    )}
                  </div>
                </div>

                {/* Metrics grid */}
                <div className="grid grid-cols-2 gap-1.5">
                  <Metric
                    icon={Crosshair}
                    label="Result"
                    value={d.result}
                    accent={d.result === 'Success' || d.result === 'completed'}
                  />
                  <Metric icon={Cpu} label="Model" value={d.model} />
                  <Metric icon={Activity} label="Attempt" value={d.attempt} />
                  <Metric icon={Terminal} label="Actions" value={d.actions} />
                </div>

                {/* Execution log — humanised event list */}
                {d.executionLog && d.executionLog.length > 0 && (
                  <div className="space-y-2">
                    <SectionLabel count={d.executionLog.length}>Recent Events</SectionLabel>
                    <div className="wf-inspector-events">
                      {d.executionLog.map((line, i) => (
                        <EventRow key={i} text={line.replace(/^\[\d+\]\s*/, '')} index={i} />
                      ))}
                    </div>
                  </div>
                )}

                {/* State — readable key/value list with Raw JSON toggle */}
                {d.stateJson && Object.keys(d.stateJson).length > 0 && (
                  <div className="space-y-2">
                    <SectionLabel>State</SectionLabel>
                    <StatePanel json={d.stateJson} />
                  </div>
                )}
              </section>
            </>
          )}

          {/* Bottom breathing room */}
          <div className="h-4" />
        </div>
      </div>
    </div>
  )
}
