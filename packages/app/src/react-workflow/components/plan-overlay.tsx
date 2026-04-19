/** @jsxImportSource react */
import { useEffect } from 'react'
import { X, Minimize2 } from 'lucide-react'
import { PlanCard, type WorkflowPlan } from './plan-card'

interface PlanOverlayProps {
  plan: WorkflowPlan
  /** Called when user clicks the X — removes the modal entirely (plan
   * message still lives in chat history and can be re-opened from the
   * minimized chip). */
  onClose: () => void
  /** Called when user clicks minimize — collapses to the in-chat chip
   * so the modal backdrop clears but the plan stays reachable. */
  onMinimize: () => void
  /** Forwarded through to the inner PlanCard. */
  onRun?: (plan: WorkflowPlan) => void
  onEdit?: (context: string) => void
}

/**
 * Full-viewport overlay that surfaces an approved (or pending) workflow
 * plan at read-friendly size. Backdrop blurs everything behind it so
 * the plan feels like the current focus of attention rather than yet
 * another chat bubble. Esc or the X closes it; the minimize icon
 * preserves it in the chat as a compact re-openable chip.
 */
export function PlanOverlay({ plan, onClose, onMinimize, onRun, onEdit }: PlanOverlayProps) {
  // Esc to dismiss. We attach on the document so the overlay catches
  // the key even when focus is inside the PlanCard's text inputs.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onMinimize()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onMinimize])

  // Lock body scroll while the modal is open so the canvas behind
  // doesn't shift when the user scrolls the plan content.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  return (
    <div className="wf-plan-overlay" role="dialog" aria-modal="true" aria-label="Workflow plan">
      <div className="wf-plan-overlay__backdrop" onClick={onMinimize} />
      <div className="wf-plan-overlay__panel">
        <div className="wf-plan-overlay__header">
          <div className="wf-plan-overlay__title">
            <span className="wf-plan-overlay__dot" />
            <span>Workflow Plan</span>
            <span className="wf-plan-overlay__hint">Esc to minimize</span>
          </div>
          <div className="wf-plan-overlay__actions">
            <button
              className="wf-plan-overlay__icon-btn"
              onClick={onMinimize}
              title="Minimize to chat"
              aria-label="Minimize plan"
            >
              <Minimize2 className="h-3.5 w-3.5" strokeWidth={1.8} />
            </button>
            <button
              className="wf-plan-overlay__icon-btn"
              onClick={onClose}
              title="Close"
              aria-label="Close plan"
            >
              <X className="h-4 w-4" strokeWidth={1.8} />
            </button>
          </div>
        </div>
        <div className="wf-plan-overlay__body">
          <PlanCard plan={plan} onRun={onRun} onEdit={onEdit} />
        </div>
      </div>
    </div>
  )
}
