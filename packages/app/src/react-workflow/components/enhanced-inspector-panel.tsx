/** @jsxImportSource react */
import { useState } from 'react'
import { Check, ChevronDown, BrainCircuit, Activity, Crosshair, Timer, Cpu, Terminal, Layers, Sparkles } from 'lucide-react'
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
}

interface Props {
  nodeDetails: Detail | null
  workflowContext: Flow
  agents: Agent[]
  onModelClick?: () => void
}

const models = [
  'GPT-5.4',
  'GPT-5.4-turbo',
  'GPT-4',
  'GPT-4-turbo',
  'Claude-3.5-Sonnet',
  'Claude-3-Opus',
  'Gemini-Pro',
]

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
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 text-[var(--wf-dim)] transition group-hover:text-[var(--wf-ink-soft)]" strokeWidth={1.6} />
        <span className="text-[11px] font-medium uppercase tracking-[0.05em] text-[var(--wf-dim)]">{label}</span>
      </div>
      <div className={`mt-2 break-words text-[15px] font-semibold tabular-nums tracking-[-0.02em] ${accent ? 'text-[var(--wf-ok)]' : 'text-[var(--wf-ink)]'}`}>
        {value}
      </div>
    </div>
  )
}

/* ── Agent card ── */
function AgentCard({ item, index, onModelClick }: { item: Agent; index: number; onModelClick?: () => void }) {
  const [open, setOpen] = useState(false)
  const [pick, setPick] = useState(item.model)
  const color = agentColors[index % agentColors.length]

  return (
    <div className="wf-inspector-agent group relative overflow-visible">
      <div className="flex items-start gap-3.5">
        {/* Colored avatar */}
        <div
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[10px] transition group-hover:scale-[1.04]"
          style={{ background: color.bg, boxShadow: `0 0 0 1px ${color.ring}` }}
        >
          <BrainCircuit className="h-4 w-4" strokeWidth={1.7} style={{ color: color.icon }} />
        </div>

        <div className="min-w-0 flex-1">
          <span className="text-[13px] font-semibold tracking-[-0.01em] text-[var(--wf-ink)]">{item.name}</span>
          <div className="mt-1 text-[11px] leading-[1.55] text-[var(--wf-dim)]">{item.role}</div>

          {/* Model selector — uses inline padding to bypass button reset */}
          <div
            role="button"
            tabIndex={0}
            onClick={() => setOpen((v) => !v)}
            onKeyDown={(e) => { if (e.key === 'Enter') setOpen((v) => !v) }}
            className="wf-model-trigger"
          >
            <Cpu className="h-3 w-3 flex-shrink-0 text-[var(--wf-dim)]" strokeWidth={1.8} />
            <span className="min-w-0 flex-1 break-all font-mono font-medium text-[var(--wf-ink-soft)]">{pick}</span>
            <ChevronDown className={`h-3 w-3 flex-shrink-0 text-[var(--wf-dim)] transition-transform duration-200 ${open ? 'rotate-180' : ''}`} strokeWidth={2} />
          </div>
        </div>
      </div>

      {/* Dropdown */}
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="wf-model-dropdown wf-fade-in"
            style={{ position: 'absolute', left: 0, right: 0, top: '100%', marginTop: 6, zIndex: 50 }}
          >
            <div style={{ padding: '8px 16px 4px' }}>
              <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--wf-dim)' }}>Select model</span>
            </div>
            {models.map((m) => (
              <div
                key={m}
                role="button"
                tabIndex={0}
                onClick={() => { setPick(m); setOpen(false); onModelClick?.() }}
                onKeyDown={(e) => { if (e.key === 'Enter') { setPick(m); setOpen(false); onModelClick?.() } }}
                className="wf-model-item"
                style={{
                  padding: '10px 20px',
                  background: pick === m ? 'var(--wf-ok-soft)' : undefined,
                  color: pick === m ? 'var(--wf-ok-strong)' : 'var(--wf-ink)',
                }}
              >
                <span className="font-mono" style={{ fontSize: 12.5, fontWeight: 500 }}>{m}</span>
                {pick === m && <Check className="h-3.5 w-3.5 text-[var(--wf-ok)]" strokeWidth={2.5} />}
              </div>
            ))}
          </div>
        </>
      )}
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
      <div className="relative flex h-10 w-10 flex-shrink-0 items-center justify-center">
        <div className="absolute inset-0 rounded-xl bg-[var(--wf-ok-soft)] wf-pulse" />
        <Spin size={22} tone="var(--wf-ok)" line={2} />
      </div>
    )
  }

  return (
    <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl ${
      done ? 'bg-[var(--wf-ok-soft)]' :
      fail ? 'bg-[rgba(239,68,68,0.08)]' :
      'bg-[var(--wf-chip)]'
    }`}>
      <div className={`h-2.5 w-2.5 rounded-full ${
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
        <div className="space-y-6 p-5">

          {/* ── Workflow Context ── */}
          <section className="space-y-3 wf-slide-up" style={{ animationDelay: '0ms' }}>
            <SectionLabel>Workflow</SectionLabel>

            <div className="wf-inspector-context-card">
              {/* Accent bar */}
              <div className={`absolute left-0 top-4 bottom-4 w-[3px] rounded-r-full ${
                run ? 'bg-[var(--wf-ok)] wf-pulse' :
                props.workflowContext.overallStatus === 'completed' ? 'bg-[var(--wf-ok)]' :
                props.workflowContext.overallStatus === 'failed' ? 'bg-[var(--wf-bad)]' :
                'bg-[var(--wf-dim)]'
              }`} />

              <div className="flex items-start gap-3.5 pl-3">
                <StatusIndicator status={props.workflowContext.overallStatus} />
                <div className="min-w-0 flex-1 pt-0.5">
                  <div className="flex items-center gap-2.5">
                    <span className="text-[14px] font-bold tracking-[-0.02em] text-[var(--wf-ink)]">{statusLabel}</span>
                    {run && (
                      <span className="inline-flex items-center gap-2 rounded-full bg-[var(--wf-ok-soft)] px-4 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.05em] text-[var(--wf-ok-strong)]">
                        <Sparkles className="h-3 w-3" strokeWidth={2} />
                        live
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-[12px] font-medium text-[var(--wf-ink-soft)]">{props.workflowContext.phase}</div>
                </div>
              </div>

              <div className="mt-4 border-t border-dashed border-[var(--wf-line)] pl-3 pt-3.5">
                <p className="text-[12px] leading-[1.7] text-[var(--wf-ink-soft)]">{props.workflowContext.goal}</p>
              </div>
            </div>
          </section>

          <Divider />

          {/* ── Agents ── */}
          <section className="space-y-3 wf-slide-up" style={{ animationDelay: '50ms' }}>
            <SectionLabel count={props.agents.length}>Agents</SectionLabel>
            <div className="space-y-1">
              {props.agents.map((item, i) => (
                <AgentCard key={item.name} item={item} index={i} onModelClick={props.onModelClick} />
              ))}
            </div>
          </section>

          {/* ── Selected Node ── */}
          {d && (
            <>
              <Divider />

              <section className="space-y-4 wf-slide-up" style={{ animationDelay: '100ms' }}>
                <SectionLabel>Node Detail</SectionLabel>

                {/* Node header */}
                <div className="wf-inspector-node-header">
                  <div className="flex items-center gap-3">
                    <div className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${
                      d.status === 'completed' ? 'bg-[var(--wf-ok)]' :
                      d.status === 'running' ? 'bg-[var(--wf-ok)] wf-pulse' :
                      d.status === 'failed' ? 'bg-[var(--wf-bad)]' :
                      'bg-[var(--wf-dim)]'
                    }`} />
                    <span className="text-[14px] font-bold tracking-[-0.02em] text-[var(--wf-ink)]">{d.title}</span>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2.5 pl-[22px]">
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
                <div className="grid grid-cols-2 gap-2.5">
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

                {/* Execution log */}
                {d.executionLog && d.executionLog.length > 0 && (
                  <div className="space-y-2.5">
                    <SectionLabel count={d.executionLog.length}>Execution Log</SectionLabel>
                    <div className="wf-inspector-terminal">
                      {d.executionLog.map((line, i) => (
                        <div key={i} className="wf-inspector-log-line">
                          <span className="wf-inspector-log-num">{String(i + 1).padStart(2, '0')}</span>
                          <span className="wf-inspector-log-text">{line.replace(/^\[\d+\]\s*/, '')}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* State JSON */}
                {d.stateJson && Object.keys(d.stateJson).length > 0 && (
                  <div className="space-y-2.5">
                    <SectionLabel>State</SectionLabel>
                    <div className="wf-inspector-code">
                      <pre>{JSON.stringify(d.stateJson, null, 2)}</pre>
                    </div>
                  </div>
                )}
              </section>
            </>
          )}

          {/* Bottom breathing room */}
          <div className="h-6" />
        </div>
      </div>
    </div>
  )
}
