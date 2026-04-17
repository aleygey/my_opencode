/** @jsxImportSource react */
import { useState } from 'react'
import { GitFork, CheckSquare, ChevronRight, Zap, Play, Edit3 } from 'lucide-react'

export interface WorkflowPlanNode {
  id: string
  title: string
  /** Agent type: "coding" | "build-flash" | "debug" | "deploy" or custom */
  agent: string
  description?: string
  /** IDs of nodes this one depends on (for DAG display) */
  depends_on?: string[]
}

export interface WorkflowPlanCheckpoint {
  id: string
  label: string
  /** If set, the checkpoint is displayed on the associated node card */
  node_id?: string
  description?: string
}

export interface WorkflowPlan {
  objective: string
  nodes: WorkflowPlanNode[]
  checkpoints: WorkflowPlanCheckpoint[]
  notes?: string
  estimated_complexity?: 'low' | 'medium' | 'high'
}

const AGENT_COLORS: Record<string, string> = {
  coding: 'var(--wf-accent)',
  'build-flash': 'var(--wf-warn)',
  debug: 'var(--wf-bad)',
  deploy: 'var(--wf-ok)',
}

const COMPLEXITY_LABEL: Record<string, string> = {
  low: 'Low complexity',
  medium: 'Medium complexity',
  high: 'High complexity',
}

const COMPLEXITY_COLOR: Record<string, string> = {
  low: 'var(--wf-ok)',
  medium: 'var(--wf-warn)',
  high: 'var(--wf-bad)',
}

function agentColor(agent: string): string {
  return AGENT_COLORS[agent] ?? 'var(--wf-dim)'
}

interface PlanCardProps {
  plan: WorkflowPlan
  onRun?: (plan: WorkflowPlan) => void
  onEdit?: (context: string) => void
}

export function PlanCard({ plan, onRun, onEdit }: PlanCardProps) {
  const [editMode, setEditMode] = useState(false)
  const [editText, setEditText] = useState('')

  const globalCheckpoints = plan.checkpoints.filter((cp) => !cp.node_id)

  const handleEditClick = () => {
    if (editMode) {
      if (editText.trim()) {
        onEdit?.(editText.trim())
        setEditText('')
      }
      setEditMode(false)
    } else {
      setEditMode(true)
    }
  }

  return (
    <div className="wf-plan-card wf-slide-up">
      {/* ── Header ── */}
      <div className="wf-plan-header">
        <div className="wf-plan-header-left">
          <div className="wf-plan-header-icon">
            <GitFork className="h-3.5 w-3.5" strokeWidth={2} />
          </div>
          <span className="wf-plan-header-title">Workflow Plan</span>
        </div>
        {plan.estimated_complexity && (
          <span
            className="wf-plan-complexity-badge"
            style={{ color: COMPLEXITY_COLOR[plan.estimated_complexity] }}
          >
            <Zap className="h-2.5 w-2.5" strokeWidth={2.5} />
            {COMPLEXITY_LABEL[plan.estimated_complexity]}
          </span>
        )}
      </div>

      {/* ── Objective ── */}
      <div className="wf-plan-objective">
        <span className="wf-plan-section-label">Objective</span>
        <p className="wf-plan-objective-text">{plan.objective}</p>
      </div>

      {/* ── Node workflow ── */}
      {plan.nodes.length > 0 && (
        <div className="wf-plan-section">
          <span className="wf-plan-section-label">Agent Workflow</span>
          <div className="wf-plan-workflow">
            {plan.nodes.map((node, i) => {
              const nodeCheckpoints = plan.checkpoints.filter((cp) => cp.node_id === node.id)
              const color = agentColor(node.agent)
              return (
                <div key={node.id} className="wf-plan-flow-item">
                  {i > 0 && (
                    <div className="wf-plan-arrow">
                      <ChevronRight className="h-3.5 w-3.5" strokeWidth={2} style={{ color: 'var(--wf-dim)' }} />
                    </div>
                  )}
                  <div className="wf-plan-node" data-agent={node.agent} style={{ borderColor: color }}>
                    <div className="wf-plan-node-agent" style={{ color }}>
                      @{node.agent}
                    </div>
                    <div className="wf-plan-node-title">{node.title}</div>
                    {node.description && (
                      <div className="wf-plan-node-desc">{node.description}</div>
                    )}
                    {nodeCheckpoints.map((cp) => (
                      <div key={cp.id} className="wf-plan-cp-badge">
                        <CheckSquare className="h-2.5 w-2.5" strokeWidth={2} />
                        {cp.label}
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Global checkpoints ── */}
      {globalCheckpoints.length > 0 && (
        <div className="wf-plan-section">
          <span className="wf-plan-section-label">Checkpoints</span>
          <div className="wf-plan-checkpoints">
            {globalCheckpoints.map((cp) => (
              <div key={cp.id} className="wf-plan-cp-item">
                <div className="wf-plan-cp-dot" />
                <div className="min-w-0 flex-1">
                  <span className="wf-plan-cp-label">{cp.label}</span>
                  {cp.description && (
                    <span className="wf-plan-cp-desc">{cp.description}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Notes ── */}
      {plan.notes && (
        <div className="wf-plan-notes">{plan.notes}</div>
      )}

      {/* ── Edit input ── */}
      {editMode && (
        <textarea
          className="wf-plan-edit-input"
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          placeholder="Add context or adjustments for the agent..."
          rows={3}
          autoFocus
        />
      )}

      {/* ── Actions ── */}
      <div className="wf-plan-actions">
        <button
          type="button"
          className={`wf-plan-btn wf-plan-btn--edit${editMode ? ' wf-plan-btn--edit-active' : ''}`}
          onClick={handleEditClick}
        >
          <Edit3 className="h-3.5 w-3.5" strokeWidth={2} />
          {editMode ? (editText.trim() ? 'Submit Edit' : 'Cancel') : 'Edit / Add Context'}
        </button>
        <button
          type="button"
          className="wf-plan-btn wf-plan-btn--run"
          onClick={() => onRun?.(plan)}
        >
          <Play className="h-3.5 w-3.5" strokeWidth={2} style={{ fill: 'currentColor' }} />
          Create Graph
        </button>
      </div>
    </div>
  )
}
