/** @jsxImportSource react */
import { useState, useCallback } from 'react'
import { ShieldAlert, Check, X, Lock } from 'lucide-react'

export interface PermissionRequest {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
}

export type PermissionReply = 'once' | 'always' | 'reject'

interface Props {
  request: PermissionRequest
  onReply: (requestID: string, reply: PermissionReply, message?: string) => void
}

/** Human-friendly descriptions for common permission types */
const permissionLabels: Record<string, { title: string; desc: string }> = {
  'file.read':   { title: 'Read File',        desc: 'The agent wants to read a file' },
  'file.write':  { title: 'Write File',        desc: 'The agent wants to write or modify a file' },
  'file.edit':   { title: 'Edit File',          desc: 'The agent wants to edit a file' },
  'bash':        { title: 'Run Command',        desc: 'The agent wants to execute a shell command' },
  'edit':        { title: 'Edit File',           desc: 'The agent wants to modify a file' },
  'write':       { title: 'Write File',          desc: 'The agent wants to create or overwrite a file' },
  'read':        { title: 'Read File',           desc: 'The agent wants to read a file' },
  'task':        { title: 'Spawn Subagent',      desc: 'The agent wants to create a subagent task' },
  'sand_table':  { title: 'Sand Table',          desc: 'The agent wants to run a planning discussion' },
}

function getPermissionLabel(perm: string) {
  return permissionLabels[perm] ?? {
    title: perm.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    desc: `The agent is requesting "${perm}" permission`,
  }
}

export function PermissionDialog({ request, onReply }: Props) {
  const [sending, setSending] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedback, setFeedback] = useState('')

  const label = getPermissionLabel(request.permission)

  const handle = useCallback((reply: PermissionReply) => {
    setSending(true)
    if (reply === 'reject' && feedback.trim()) {
      onReply(request.id, reply, feedback.trim())
    } else {
      onReply(request.id, reply)
    }
  }, [request.id, onReply, feedback])

  return (
    <div className="wf-permission-card">
      <div className="wf-permission-header">
        <div className="wf-permission-icon">
          <ShieldAlert className="h-4 w-4" strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="wf-permission-title">Permission Required</div>
          <div className="wf-permission-subtitle">{label.title}</div>
        </div>
      </div>

      <div className="wf-permission-body">
        <p className="wf-permission-desc">{label.desc}</p>

        {request.patterns.length > 0 && (
          <div className="wf-permission-patterns">
            {request.patterns.map((p, i) => (
              <code key={i} className="wf-permission-pattern">{p}</code>
            ))}
          </div>
        )}

        {/* Show metadata if there's useful context */}
        {request.metadata?.command && (
          <div className="wf-permission-meta">
            <Lock className="h-3 w-3 flex-shrink-0" strokeWidth={2} />
            <code className="wf-permission-command">{String(request.metadata.command)}</code>
          </div>
        )}
      </div>

      {feedbackOpen && (
        <div className="wf-permission-feedback">
          <textarea
            className="wf-permission-feedback-input"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Explain why you're denying (optional)..."
            rows={2}
            autoFocus
          />
        </div>
      )}

      <div className="wf-permission-footer">
        <button
          className="wf-permission-btn wf-permission-btn--deny"
          onClick={() => {
            if (!feedbackOpen) {
              setFeedbackOpen(true)
            } else {
              handle('reject')
            }
          }}
          disabled={sending}
        >
          <X className="h-3 w-3" strokeWidth={2} />
          Deny
        </button>
        <div className="flex items-center gap-1.5">
          <button
            className="wf-permission-btn wf-permission-btn--always"
            onClick={() => handle('always')}
            disabled={sending}
          >
            <Check className="h-3 w-3" strokeWidth={2} />
            Always Allow
          </button>
          <button
            className="wf-permission-btn wf-permission-btn--once"
            onClick={() => handle('once')}
            disabled={sending}
          >
            Allow Once
          </button>
        </div>
      </div>
    </div>
  )
}
