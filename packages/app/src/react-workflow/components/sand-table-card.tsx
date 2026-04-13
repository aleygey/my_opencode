/** @jsxImportSource react */
import { useState } from 'react'
import { ChevronDown, ChevronRight, Layers, CheckCircle2, AlertTriangle } from 'lucide-react'

export interface SandTableMessage {
  role: 'planner' | 'evaluator' | 'orchestrator'
  model: string
  content: string
  round: number
}

export interface SandTableResult {
  id: string
  topic: string
  rounds: number
  status: 'approved' | 'completed' | 'failed'
  messages: SandTableMessage[]
  finalPlan?: string
}

const ROLE_LABELS: Record<string, string> = {
  planner: 'Planner',
  evaluator: 'Evaluator',
  orchestrator: 'Orchestrator',
}

interface SandTableCardProps {
  result: SandTableResult
}

export function SandTableCard({ result }: SandTableCardProps) {
  const [expanded, setExpanded] = useState(false)

  const statusIcon = result.status === 'approved'
    ? <CheckCircle2 className="h-3 w-3" strokeWidth={2.5} />
    : <AlertTriangle className="h-3 w-3" strokeWidth={2.5} />

  const statusColor = result.status === 'approved'
    ? 'var(--wf-ok)'
    : result.status === 'failed'
      ? 'var(--wf-bad)'
      : 'var(--wf-warn)'

  const statusLabel = result.status === 'approved'
    ? 'Approved'
    : result.status === 'failed'
      ? 'Failed'
      : 'Completed'

  // Group messages by round
  const rounds = Array.from(
    { length: result.rounds },
    (_, i) => i + 1,
  ).map((round) => ({
    round,
    messages: result.messages.filter((m) => m.round === round),
  }))

  return (
    <div className="wf-sandtable-card wf-slide-up">
      {/* Header */}
      <button
        type="button"
        className="wf-sandtable-header"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="wf-sandtable-header-left">
          <div className="wf-sandtable-header-icon">
            <Layers className="h-3.5 w-3.5" strokeWidth={2} />
          </div>
          <span className="wf-sandtable-header-title">Sand Table</span>
          <span className="wf-sandtable-rounds-badge">{result.rounds} rounds</span>
        </div>
        <div className="wf-sandtable-header-right">
          <span className="wf-sandtable-status-badge" style={{ color: statusColor }}>
            {statusIcon}
            {statusLabel}
          </span>
          {expanded
            ? <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} style={{ color: 'var(--wf-dim)' }} />
            : <ChevronRight className="h-3.5 w-3.5" strokeWidth={2} style={{ color: 'var(--wf-dim)' }} />}
        </div>
      </button>

      {/* Topic */}
      <div className="wf-sandtable-topic">
        <span className="wf-sandtable-topic-label">Topic</span>
        <span className="wf-sandtable-topic-text">{result.topic}</span>
      </div>

      {/* Expanded: round-by-round discussion */}
      {expanded && (
        <div className="wf-sandtable-rounds">
          {rounds.map(({ round, messages }) => (
            <div key={round} className="wf-sandtable-round">
              <div className="wf-sandtable-round-label">Round {round}</div>
              {messages.map((msg, i) => (
                <div key={`${round}-${msg.role}-${i}`} className="wf-sandtable-msg">
                  <div className={`wf-sandtable-msg-header wf-sandtable-role--${msg.role}`}>
                    <span className="wf-sandtable-msg-role">
                      {ROLE_LABELS[msg.role] ?? msg.role}
                    </span>
                    <span className="wf-sandtable-msg-model">{msg.model}</span>
                  </div>
                  <div className="wf-sandtable-msg-content">{msg.content}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Final plan summary (always visible) */}
      {result.finalPlan && !expanded && (
        <div className="wf-sandtable-summary">
          <span className="wf-sandtable-topic-label">Final Plan</span>
          <div className="wf-sandtable-summary-text">
            {result.finalPlan.length > 200
              ? result.finalPlan.slice(0, 200) + '...'
              : result.finalPlan}
          </div>
        </div>
      )}
    </div>
  )
}
