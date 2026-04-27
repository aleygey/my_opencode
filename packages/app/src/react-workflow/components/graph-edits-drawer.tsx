/** @jsxImportSource react */
import { useState, useCallback, useMemo } from 'react'
import { Check, X, GitBranch, Flag, Clock, AlertTriangle } from 'lucide-react'
import type { WorkflowGraphEdit } from '../app'

/**
 * P5 — Graph Edits drawer.
 *
 * Surfaces the workflow's pending graph edits (proposed by sub-agents via the
 * `propose` route) and lets the operator either apply or reject each one.
 * Also exposes a "finalize workflow" action that locks the graph at one of
 * the three terminal statuses (completed / failed / cancelled).
 *
 * The drawer is intentionally a side panel (not a modal) so the canvas stays
 * visible while the operator is reviewing edits — they can cross-reference the
 * affected nodes without dismissing the queue.
 */

interface Props {
  open: boolean
  onClose: () => void
  graphRev?: number
  edits: WorkflowGraphEdit[]
  finalizedStatus?: 'completed' | 'failed' | 'cancelled'
  onApply?: (editID: string) => void
  onReject?: (editID: string, reason: string) => void
  onFinalize?: (status: 'completed' | 'failed' | 'cancelled', failReason?: string) => void
}

const statusTone: Record<WorkflowGraphEdit['status'], { label: string; color: string }> = {
  pending:    { label: 'pending',    color: 'var(--wf-warn)' },
  applied:    { label: 'applied',    color: 'var(--wf-ok)'   },
  rejected:   { label: 'rejected',   color: 'var(--wf-bad)'  },
  superseded: { label: 'superseded', color: 'var(--wf-dim)'  },
}

function relTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 0) return 'just now'
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

function describeOp(op: { kind: string } & Record<string, unknown>): string {
  // Shape varies by op kind — render a one-line summary covering the most
  // common patches without leaking the full JSON unless the operator opens
  // the inline detail view.
  switch (op.kind) {
    case 'add_node':
      return `add_node ${(op as { id?: string }).id ?? '?'}`
    case 'remove_node':
      return `remove_node ${(op as { id?: string }).id ?? '?'}`
    case 'patch_node': {
      const id = (op as { id?: string }).id ?? '?'
      const fields = Object.keys((op as { patch?: Record<string, unknown> }).patch ?? {})
      return `patch_node ${id}${fields.length ? ` · ${fields.join(', ')}` : ''}`
    }
    case 'add_edge':
    case 'remove_edge': {
      const from = (op as { from?: string }).from ?? '?'
      const to = (op as { to?: string }).to ?? '?'
      return `${op.kind} ${from} → ${to}`
    }
    default:
      return op.kind
  }
}

export function GraphEditsDrawer({
  open,
  onClose,
  graphRev,
  edits,
  finalizedStatus,
  onApply,
  onReject,
  onFinalize,
}: Props) {
  const [rejectingID, setRejectingID] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [finalizeOpen, setFinalizeOpen] = useState(false)
  const [finalizeStatus, setFinalizeStatus] = useState<'completed' | 'failed' | 'cancelled'>('completed')
  const [finalizeReason, setFinalizeReason] = useState('')
  const [busyID, setBusyID] = useState<string | null>(null)
  const [busyFinalize, setBusyFinalize] = useState(false)

  // Pending edits float to the top because they're the only ones still
  // actionable. After that, sort by created-time desc so the most recent
  // applied/rejected entries appear next.
  const sortedEdits = useMemo(() => {
    const score = (e: WorkflowGraphEdit) => (e.status === 'pending' ? 0 : 1)
    return [...edits].sort((a, b) => {
      const diff = score(a) - score(b)
      if (diff !== 0) return diff
      return b.time.created - a.time.created
    })
  }, [edits])

  const pendingCount = useMemo(
    () => edits.filter((e) => e.status === 'pending').length,
    [edits],
  )

  const handleApply = useCallback(
    (id: string) => {
      if (!onApply) return
      setBusyID(id)
      onApply(id)
      // The bus listener will re-poll and remove the pending row from the
      // list within a tick or two; clearing busy after a short timeout keeps
      // the button from looking stuck if the network round-trip is slow.
      setTimeout(() => setBusyID((cur) => (cur === id ? null : cur)), 1500)
    },
    [onApply],
  )

  const handleRejectConfirm = useCallback(() => {
    if (!rejectingID || !onReject) return
    const reason = rejectReason.trim()
    if (!reason) return
    setBusyID(rejectingID)
    onReject(rejectingID, reason)
    setRejectingID(null)
    setRejectReason('')
    setTimeout(() => setBusyID(null), 1500)
  }, [rejectingID, rejectReason, onReject])

  const handleFinalize = useCallback(() => {
    if (!onFinalize) return
    const reason = finalizeStatus === 'failed' ? finalizeReason.trim() || 'finalized via UI' : undefined
    setBusyFinalize(true)
    onFinalize(finalizeStatus, reason)
    setFinalizeOpen(false)
    setFinalizeReason('')
    setTimeout(() => setBusyFinalize(false), 1500)
  }, [finalizeStatus, finalizeReason, onFinalize])

  if (!open) return null

  const finalized = !!finalizedStatus

  return (
    <>
      {/* Backdrop — click to dismiss without affecting the canvas underneath */}
      <div
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'color-mix(in srgb, var(--wf-ink) 18%, transparent)',
          zIndex: 40,
        }}
      />
      <aside
        role="dialog"
        aria-label="Graph edits"
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: 380,
          maxWidth: '100%',
          background: 'var(--wf-surface)',
          borderLeft: '1px solid var(--wf-line)',
          boxShadow: 'var(--wf-shadow-lg, 0 10px 30px rgba(0,0,0,.18))',
          zIndex: 41,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-2 px-4 py-3"
          style={{ borderBottom: '1px solid var(--wf-line)' }}
        >
          <GitBranch className="h-3.5 w-3.5 text-[var(--wf-dim)]" strokeWidth={1.8} />
          <div className="flex-1">
            <div className="text-[12px] font-semibold tracking-tight text-[var(--wf-ink)]">
              Graph edits
            </div>
            <div className="text-[10.5px] text-[var(--wf-dim)]">
              {typeof graphRev === 'number' ? <>rev #{graphRev} · </> : null}
              {pendingCount} pending · {edits.length} total
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-[var(--wf-chip)]"
            aria-label="Close"
          >
            <X className="h-3.5 w-3.5 text-[var(--wf-dim)]" strokeWidth={2} />
          </button>
        </div>

        {/* Edits list */}
        <div className="flex-1 overflow-y-auto px-3 py-3">
          {sortedEdits.length === 0 ? (
            <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-[var(--wf-dim)]">
              No graph edits yet. Sub-agents that scan repository state can
              propose changes here for your review.
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {sortedEdits.map((edit) => {
                const tone = statusTone[edit.status]
                const isPending = edit.status === 'pending'
                const isRejecting = rejectingID === edit.id
                const isBusy = busyID === edit.id
                return (
                  <li
                    key={edit.id}
                    className="rounded-md border p-2.5"
                    style={{
                      borderColor: 'var(--wf-line)',
                      background: 'var(--wf-surface)',
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-flex items-center rounded-full px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide"
                        style={{
                          background: `color-mix(in srgb, ${tone.color} 16%, transparent)`,
                          color: tone.color,
                        }}
                      >
                        {tone.label}
                      </span>
                      <span className="font-mono text-[10.5px] text-[var(--wf-dim)]">
                        rev {edit.graph_rev_before}
                        {typeof edit.graph_rev_after === 'number' ? ` → ${edit.graph_rev_after}` : ''}
                      </span>
                      <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-[var(--wf-dim)]">
                        <Clock className="h-2.5 w-2.5" strokeWidth={2} />
                        {relTime(edit.time.created)}
                      </span>
                    </div>

                    {edit.reason && (
                      <p className="mt-1.5 text-[11px] leading-snug text-[var(--wf-ink-soft)]">
                        {edit.reason}
                      </p>
                    )}

                    {edit.ops.length > 0 && (
                      <ul className="mt-1.5 flex flex-col gap-0.5">
                        {edit.ops.slice(0, 5).map((op, i) => (
                          <li
                            key={i}
                            className="font-mono text-[10.5px] text-[var(--wf-ink)]"
                          >
                            · {describeOp(op)}
                          </li>
                        ))}
                        {edit.ops.length > 5 && (
                          <li className="text-[10px] text-[var(--wf-dim)]">
                            +{edit.ops.length - 5} more
                          </li>
                        )}
                      </ul>
                    )}

                    {edit.reject_reason && (
                      <p className="mt-1.5 inline-flex items-start gap-1 text-[10.5px] text-[var(--wf-bad)]">
                        <AlertTriangle className="mt-0.5 h-2.5 w-2.5 flex-shrink-0" strokeWidth={2} />
                        <span>{edit.reject_reason}</span>
                      </p>
                    )}

                    {/* Actions */}
                    {isPending && !finalized && (isRejecting ? (
                      <div className="mt-2 flex flex-col gap-1.5">
                        <textarea
                          autoFocus
                          rows={2}
                          value={rejectReason}
                          onChange={(e) => setRejectReason(e.target.value)}
                          placeholder="Why reject this edit?"
                          className="w-full rounded border bg-transparent px-2 py-1 text-[11px] text-[var(--wf-ink)]"
                          style={{ borderColor: 'var(--wf-line)' }}
                        />
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={handleRejectConfirm}
                            disabled={!rejectReason.trim() || isBusy}
                            className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10.5px] font-medium disabled:opacity-50"
                            style={{
                              background: 'var(--wf-bad)',
                              color: 'white',
                            }}
                          >
                            <X className="h-2.5 w-2.5" strokeWidth={2.5} /> Confirm reject
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setRejectingID(null)
                              setRejectReason('')
                            }}
                            className="rounded px-2 py-1 text-[10.5px] text-[var(--wf-dim)] hover:bg-[var(--wf-chip)]"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-2 flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleApply(edit.id)}
                          disabled={isBusy || !onApply}
                          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10.5px] font-medium disabled:opacity-50"
                          style={{
                            background: 'var(--wf-ok)',
                            color: 'white',
                          }}
                        >
                          <Check className="h-2.5 w-2.5" strokeWidth={2.5} /> Apply
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setRejectingID(edit.id)
                            setRejectReason('')
                          }}
                          disabled={isBusy || !onReject}
                          className="inline-flex items-center gap-1 rounded border px-2 py-1 text-[10.5px] font-medium text-[var(--wf-bad)] disabled:opacity-50"
                          style={{ borderColor: 'var(--wf-bad)' }}
                        >
                          <X className="h-2.5 w-2.5" strokeWidth={2.5} /> Reject
                        </button>
                      </div>
                    ))}
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* Finalize footer — hidden once the workflow has already been
            finalized so the operator can't double-finalize. */}
        <div
          className="px-3 py-3"
          style={{ borderTop: '1px solid var(--wf-line)' }}
        >
          {finalized ? (
            <div className="flex items-center gap-2 text-[11px] text-[var(--wf-dim)]">
              <Flag className="h-3 w-3" strokeWidth={1.8} />
              Finalized · <span className="font-medium text-[var(--wf-ink)]">{finalizedStatus}</span>
            </div>
          ) : finalizeOpen ? (
            <div className="flex flex-col gap-2">
              <div className="text-[11px] font-semibold text-[var(--wf-ink)]">
                Finalize workflow
              </div>
              <div className="flex items-center gap-1.5">
                {(['completed', 'failed', 'cancelled'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setFinalizeStatus(s)}
                    className="rounded px-2 py-1 text-[10.5px] font-medium"
                    style={{
                      background:
                        finalizeStatus === s
                          ? s === 'completed'
                            ? 'var(--wf-ok)'
                            : s === 'failed'
                              ? 'var(--wf-bad)'
                              : 'var(--wf-warn)'
                          : 'var(--wf-chip)',
                      color: finalizeStatus === s ? 'white' : 'var(--wf-ink)',
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
              {finalizeStatus === 'failed' && (
                <textarea
                  rows={2}
                  value={finalizeReason}
                  onChange={(e) => setFinalizeReason(e.target.value)}
                  placeholder="Failure reason (optional)"
                  className="w-full rounded border bg-transparent px-2 py-1 text-[11px] text-[var(--wf-ink)]"
                  style={{ borderColor: 'var(--wf-line)' }}
                />
              )}
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleFinalize}
                  disabled={busyFinalize}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10.5px] font-medium disabled:opacity-50"
                  style={{ background: 'var(--wf-ink)', color: 'var(--wf-surface)' }}
                >
                  <Flag className="h-2.5 w-2.5" strokeWidth={2.5} /> Confirm finalize
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setFinalizeOpen(false)
                    setFinalizeReason('')
                  }}
                  className="rounded px-2 py-1 text-[10.5px] text-[var(--wf-dim)] hover:bg-[var(--wf-chip)]"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setFinalizeOpen(true)}
              disabled={!onFinalize || pendingCount > 0}
              title={pendingCount > 0 ? 'Resolve pending edits before finalizing' : undefined}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded border px-2.5 py-1.5 text-[11px] font-medium text-[var(--wf-ink)] disabled:opacity-50"
              style={{ borderColor: 'var(--wf-line)' }}
            >
              <Flag className="h-3 w-3" strokeWidth={1.8} /> Finalize workflow…
            </button>
          )}
        </div>
      </aside>
    </>
  )
}
