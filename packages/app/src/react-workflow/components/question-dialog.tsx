/** @jsxImportSource react */
import { useState, useCallback } from 'react'
import { HelpCircle, Check, X, ChevronLeft, ChevronRight } from 'lucide-react'

export interface QuestionOption {
  label: string
  description: string
}

export interface QuestionInfo {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}

export interface QuestionRequest {
  id: string
  sessionID: string
  questions: QuestionInfo[]
}

interface Props {
  request: QuestionRequest
  onReply: (requestID: string, answers: string[][]) => void
  onReject: (requestID: string) => void
}

export function QuestionDialog({ request, onReply, onReject }: Props) {
  const [qIndex, setQIndex] = useState(0)
  const [answers, setAnswers] = useState<string[][]>(() =>
    request.questions.map(() => []),
  )
  const [customText, setCustomText] = useState<string[]>(() =>
    request.questions.map(() => ''),
  )
  const [customOn, setCustomOn] = useState<boolean[]>(() =>
    request.questions.map(() => false),
  )
  const [sending, setSending] = useState(false)

  const q = request.questions[qIndex]
  const isLast = qIndex === request.questions.length - 1
  const isFirst = qIndex === 0
  const multi = q?.multiple ?? false
  const allowCustom = q?.custom !== false

  const toggleOption = useCallback((label: string) => {
    setAnswers((prev) => {
      const next = [...prev]
      const cur = next[qIndex]
      if (multi) {
        next[qIndex] = cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label]
      } else {
        next[qIndex] = cur[0] === label ? [] : [label]
        // Turn off custom when selecting a normal option
        setCustomOn((p) => { const n = [...p]; n[qIndex] = false; return n })
      }
      return next
    })
  }, [qIndex, multi])

  const toggleCustom = useCallback(() => {
    setCustomOn((prev) => {
      const next = [...prev]
      next[qIndex] = !next[qIndex]
      if (!next[qIndex]) {
        // Clear custom text when turning off
        setCustomText((p) => { const n = [...p]; n[qIndex] = ''; return n })
      }
      if (!multi && next[qIndex]) {
        // In single mode, deselect options when custom is on
        setAnswers((p) => { const n = [...p]; n[qIndex] = []; return n })
      }
      return next
    })
  }, [qIndex, multi])

  const handleSubmit = useCallback(async () => {
    setSending(true)
    // Merge custom text into answers
    const finalAnswers = answers.map((ans, i) => {
      if (customOn[i] && customText[i].trim()) {
        return [...ans, customText[i].trim()]
      }
      return ans
    })
    onReply(request.id, finalAnswers)
  }, [answers, customOn, customText, request.id, onReply])

  const handleReject = useCallback(() => {
    setSending(true)
    onReject(request.id)
  }, [request.id, onReject])

  if (!q) return null

  const hasAnswer = answers[qIndex].length > 0 || (customOn[qIndex] && customText[qIndex].trim())

  return (
    <div className="wf-question-card">
      <div className="wf-question-header">
        <div className="wf-question-icon">
          <HelpCircle className="h-4 w-4" strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="wf-question-title">{q.header || 'Question'}</div>
          {request.questions.length > 1 && (
            <div className="wf-question-progress">
              {request.questions.map((_, i) => (
                <button
                  key={i}
                  className={`wf-question-dot ${i === qIndex ? 'wf-question-dot--active' : ''} ${answers[i].length > 0 || (customOn[i] && customText[i].trim()) ? 'wf-question-dot--done' : ''}`}
                  onClick={() => setQIndex(i)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="wf-question-body">
        <p className="wf-question-text">{q.question}</p>
        {q.options.length > 0 && (
          <div className="wf-question-hint">
            {multi ? 'Select one or more options' : 'Select one option'}
          </div>
        )}

        <div className="wf-question-options">
          {q.options.map((opt) => {
            const selected = answers[qIndex].includes(opt.label)
            return (
              <button
                key={opt.label}
                className={`wf-question-option ${selected ? 'wf-question-option--selected' : ''}`}
                onClick={() => toggleOption(opt.label)}
                disabled={sending}
              >
                <div className={`wf-question-check ${selected ? 'wf-question-check--on' : ''}`}>
                  {selected && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="wf-question-option-label">{opt.label}</div>
                  {opt.description && (
                    <div className="wf-question-option-desc">{opt.description}</div>
                  )}
                </div>
              </button>
            )
          })}

          {allowCustom && (
            <>
              <button
                className={`wf-question-option ${customOn[qIndex] ? 'wf-question-option--selected' : ''}`}
                onClick={toggleCustom}
                disabled={sending}
              >
                <div className={`wf-question-check ${customOn[qIndex] ? 'wf-question-check--on' : ''}`}>
                  {customOn[qIndex] && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                </div>
                <div className="wf-question-option-label">Custom answer</div>
              </button>
              {customOn[qIndex] && (
                <textarea
                  className="wf-question-custom-input"
                  value={customText[qIndex]}
                  onChange={(e) => setCustomText((p) => {
                    const n = [...p]; n[qIndex] = e.target.value; return n
                  })}
                  placeholder="Type your answer..."
                  rows={2}
                  autoFocus
                  disabled={sending}
                />
              )}
            </>
          )}
        </div>
      </div>

      <div className="wf-question-footer">
        <button
          className="wf-question-btn wf-question-btn--ghost"
          onClick={handleReject}
          disabled={sending}
        >
          <X className="h-3 w-3" strokeWidth={2} />
          Dismiss
        </button>
        <div className="flex items-center gap-1.5">
          {!isFirst && (
            <button
              className="wf-question-btn wf-question-btn--ghost"
              onClick={() => setQIndex((i) => i - 1)}
              disabled={sending}
            >
              <ChevronLeft className="h-3 w-3" strokeWidth={2} />
              Back
            </button>
          )}
          {isLast ? (
            <button
              className="wf-question-btn wf-question-btn--primary"
              onClick={handleSubmit}
              disabled={sending || !hasAnswer}
            >
              Submit
            </button>
          ) : (
            <button
              className="wf-question-btn wf-question-btn--primary"
              onClick={() => setQIndex((i) => i + 1)}
              disabled={!hasAnswer}
            >
              Next
              <ChevronRight className="h-3 w-3" strokeWidth={2} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
