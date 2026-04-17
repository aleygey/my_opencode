/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowLeft,
  Bot,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileText,
  Layers,
  MessageSquarePlus,
  ScrollText,
  Send,
  Sparkles,
  Square,
  Target,
  User,
} from "lucide-react"
import { Markdown } from "./markdown"
import { SplitBar, useSplit } from "./split"
import { Spin } from "./spin"

type Status = "pending" | "running" | "completed" | "failed" | "paused"
type Role = "planner" | "evaluator" | "orchestrator"

export type SandTableMessage = {
  role: Role
  model: string
  content: string
  round: number
  timestamp: number
}

export type SandTableDiscussion = {
  id: string
  topic: string
  context: string
  round: number
  max_rounds: number
  status: "running" | "approved" | "completed" | "failed"
  participants: Array<{
    role: "planner" | "evaluator"
    sessionID: string
    model: {
      providerID: string
      modelID: string
    }
  }>
  current_plan?: string
  last_evaluation?: string
  messages: SandTableMessage[]
}

type Props = {
  nodeId: string
  nodeTitle: string
  nodeStatus: Status
  discussion: SandTableDiscussion
  onBack: () => void
  onStop?: () => void
  onSend: (text: string) => void
}

const roleTitle: Record<Role, string> = {
  planner: "Planner",
  evaluator: "Evaluator",
  orchestrator: "You",
}

const roleTone: Record<Role, { accent: string; bg: string; text: string; icon: typeof Bot; bubble: string; bubbleBorder: string }> = {
  planner: {
    accent: "#8b6ad9",
    bg: "rgba(139,106,217,0.10)",
    text: "#8b6ad9",
    icon: Bot,
    bubble: "rgba(139,106,217,0.06)",
    bubbleBorder: "rgba(139,106,217,0.28)",
  },
  evaluator: {
    accent: "#2f8fb2",
    bg: "rgba(47,143,178,0.10)",
    text: "#2f8fb2",
    icon: BrainCircuit,
    bubble: "rgba(47,143,178,0.06)",
    bubbleBorder: "rgba(47,143,178,0.28)",
  },
  orchestrator: {
    accent: "var(--wf-ok)",
    bg: "var(--wf-ok-soft)",
    text: "var(--wf-ok)",
    icon: User,
    bubble: "var(--wf-ok-soft)",
    bubbleBorder: "var(--wf-ok)",
  },
}

const stamp = (time: number) =>
  new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

/* ── Status chip (shared pattern with node-session-view) ── */
function StatusChip({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon?: React.ElementType
  label: string
  value: React.ReactNode
  accent?: boolean
}) {
  return (
    <div className="wf-node-status-chip" data-accent={accent ? "true" : undefined}>
      {Icon && <Icon className="h-3 w-3 flex-shrink-0 text-[var(--wf-dim)]" strokeWidth={1.8} />}
      <span className="wf-node-status-chip-label">{label}</span>
      <span className="wf-node-status-chip-value">{value}</span>
    </div>
  )
}

/* ── Round progress visual ── */
function RoundsIndicator({ round, max }: { round: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (round / max) * 100)) : 0
  return (
    <div className="wf-sand-rounds">
      <span className="wf-sand-rounds-label">Rounds</span>
      <div className="wf-sand-rounds-track">
        <div className="wf-sand-rounds-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="wf-sand-rounds-value">
        {round}
        <span className="text-[var(--wf-dim)]">/{max}</span>
      </span>
    </div>
  )
}

/* ── Left panel tabs ── */
type LeftTab = "plan" | "evaluation" | "context"

function LeftTabButton({
  active,
  onClick,
  icon: Icon,
  children,
  empty,
}: {
  active: boolean
  onClick: () => void
  icon: React.ElementType
  children: React.ReactNode
  empty?: boolean
}) {
  return (
    <button
      type="button"
      className="wf-sand-tab"
      data-active={active ? "true" : "false"}
      data-empty={empty ? "true" : "false"}
      onClick={onClick}
    >
      <Icon className="h-3 w-3" strokeWidth={1.8} />
      <span>{children}</span>
    </button>
  )
}

export function SandTableSessionView(props: Props) {
  const [msg, setMsg] = useState("")
  const [tab, setTab] = useState<LeftTab>("plan")

  const end = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const composingRef = useRef(false)

  const left = useSplit({ axis: "x", size: 360, min: 280, max: 560 })

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" })
  }, [props.discussion.messages.length])

  const auto = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  const send = () => {
    const body = msg.trim()
    if (!body) return
    props.onSend(body)
    setMsg("")
    if (textareaRef.current) textareaRef.current.style.height = "auto"
  }

  const run = props.nodeStatus === "running" || props.discussion.status === "running"

  const participantsByRole = useMemo(
    () =>
      Object.fromEntries(props.discussion.participants.map((p) => [p.role, p])) as Record<
        "planner" | "evaluator",
        Props["discussion"]["participants"][number] | undefined
      >,
    [props.discussion.participants],
  )

  const plannerModel =
    participantsByRole.planner &&
    `${participantsByRole.planner.model.providerID}/${participantsByRole.planner.model.modelID}`
  const evaluatorModel =
    participantsByRole.evaluator &&
    `${participantsByRole.evaluator.model.providerID}/${participantsByRole.evaluator.model.modelID}`

  const hasPlan = !!(props.discussion.current_plan && props.discussion.current_plan.trim())
  const hasEval = !!(props.discussion.last_evaluation && props.discussion.last_evaluation.trim())
  const hasContext = !!(props.discussion.context && props.discussion.context.trim())

  // Tally orchestrator injections — surface to user so they see their context landed.
  const orchestratorCount = useMemo(
    () => props.discussion.messages.filter((m) => m.role === "orchestrator").length,
    [props.discussion.messages],
  )

  return (
    <div className="workflow-make h-full w-full overflow-hidden">
      <div className="flex h-full flex-col bg-[var(--wf-bg)]">
        {/* ─── TopBar ─── */}
        <div className="wf-topbar">
          <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-[var(--wf-line-strong)] to-transparent" />

          <div className="flex items-center gap-2">
            <button onClick={props.onBack} className="wf-topbar-text-btn">
              <ArrowLeft className="h-4 w-4" strokeWidth={1.6} />
              <span>Back</span>
            </button>

            <div className="wf-topbar-sep" />

            <div>
              <div className="flex items-center gap-2.5">
                <Layers className="h-3.5 w-3.5 text-[var(--wf-dim)]" strokeWidth={1.8} />
                <h1 className="text-[14px] font-bold tracking-[-0.02em] text-[var(--wf-ink)]">
                  {props.nodeTitle}
                </h1>
              </div>
              <div className="mt-px flex items-center gap-2 pl-6">
                <span className="font-mono text-[10px] text-[var(--wf-dim)]">{props.nodeId}</span>
                <span className="text-[var(--wf-line-strong)]">&middot;</span>
                <span className="text-[10px] font-medium text-[var(--wf-dim)]">Plan discussion</span>
              </div>
            </div>

            <div className="wf-topbar-sep" />

            <div className={["wf-topbar-status", run ? "wf-topbar-status--running" : ""].join(" ")}>
              {run ? (
                <Spin size={13} tone="var(--wf-ok)" line={1.5} />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5 text-[var(--wf-ok)]" strokeWidth={2} />
              )}
              <span className="text-[11px] font-semibold capitalize">{props.discussion.status}</span>
              {run && (
                <span className="inline-flex items-center gap-1 rounded-full bg-[var(--wf-ok-soft)] px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.04em] text-[var(--wf-ok-strong)]">
                  <Sparkles className="h-2.5 w-2.5" strokeWidth={2} />
                  live
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button onClick={props.onStop} className="wf-topbar-action wf-topbar-action--stop">
              <Square className="h-3 w-3" strokeWidth={2.5} fill="currentColor" />
              Abort
            </button>
          </div>
        </div>

        {/* ─── Status strip ─── */}
        <div className="wf-node-status-strip">
          <div className="wf-node-status-chips">
            <RoundsIndicator round={props.discussion.round} max={props.discussion.max_rounds} />
            {plannerModel && <StatusChip icon={Bot} label="Planner" value={plannerModel} />}
            {evaluatorModel && (
              <StatusChip icon={BrainCircuit} label="Evaluator" value={evaluatorModel} />
            )}
            {orchestratorCount > 0 && (
              <StatusChip
                icon={MessageSquarePlus}
                label="Your context"
                value={`${orchestratorCount}`}
                accent
              />
            )}
          </div>
        </div>

        {/* ─── 2-column body: Left (topic + detail tabs) | Right (dialogue) ─── */}
        <div className="flex min-h-0 flex-1">
          {/* ── Left: Topic hero + tabbed detail ── */}
          <div
            className="flex min-h-0 flex-shrink-0 flex-col border-r border-[var(--wf-line)] bg-[var(--wf-bg)]"
            style={{ width: left.size }}
          >
            {/* Topic hero */}
            <TopicHero topic={props.discussion.topic} />


            {/* Tab bar */}
            <div className="wf-sand-tabs">
              <LeftTabButton
                active={tab === "plan"}
                onClick={() => setTab("plan")}
                icon={ScrollText}
                empty={!hasPlan}
              >
                Plan
              </LeftTabButton>
              <LeftTabButton
                active={tab === "evaluation"}
                onClick={() => setTab("evaluation")}
                icon={Sparkles}
                empty={!hasEval}
              >
                Evaluation
              </LeftTabButton>
              <LeftTabButton
                active={tab === "context"}
                onClick={() => setTab("context")}
                icon={FileText}
                empty={!hasContext}
              >
                Context
              </LeftTabButton>
            </div>

            {/* Tab body */}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {tab === "plan" && (
                hasPlan ? (
                  <div className="wf-sand-doc">
                    <Markdown>{props.discussion.current_plan!}</Markdown>
                  </div>
                ) : (
                  <EmptyHint>No plan proposed yet — waiting for the planner.</EmptyHint>
                )
              )}
              {tab === "evaluation" && (
                hasEval ? (
                  <div className="wf-sand-doc">
                    <Markdown>{props.discussion.last_evaluation!}</Markdown>
                  </div>
                ) : (
                  <EmptyHint>No evaluation yet — the evaluator will respond after the first plan.</EmptyHint>
                )
              )}
              {tab === "context" && (
                hasContext ? (
                  <div className="wf-sand-doc">
                    <Markdown>{props.discussion.context}</Markdown>
                  </div>
                ) : (
                  <EmptyHint>No context provided. Use the input on the right to add orchestrator context mid-discussion.</EmptyHint>
                )
              )}
            </div>

            {/* Participants footer */}
            {(participantsByRole.planner || participantsByRole.evaluator) && (
              <div className="wf-sand-participants-footer">
                {(["planner", "evaluator"] as const).map((role) => {
                  const p = participantsByRole[role]
                  if (!p) return null
                  const tone = roleTone[role]
                  const Icon = tone.icon
                  return (
                    <div key={role} className="wf-sand-participant-row">
                      <div
                        className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md"
                        style={{ background: tone.bg, color: tone.text }}
                      >
                        <Icon className="h-2.5 w-2.5" strokeWidth={1.8} />
                      </div>
                      <span className="text-[10.5px] font-semibold text-[var(--wf-ink)]">{roleTitle[role]}</span>
                      <span className="ml-auto truncate font-mono text-[10px] text-[var(--wf-dim)]" title={p.sessionID}>
                        {p.sessionID.slice(0, 8)}…
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <SplitBar axis="x" {...left.bind} />

          {/* ── Right: Dialogue thread + orchestrator input ── */}
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Thread header */}
            <div className="wf-sand-thread-header">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-bold uppercase tracking-[0.07em] text-[var(--wf-dim)]">
                  Discussion
                </span>
                <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--wf-chip)] px-1.5 text-[10px] font-bold tabular-nums text-[var(--wf-dim)]">
                  {props.discussion.messages.length}
                </span>
              </div>
              <div className="flex items-center gap-3 text-[10.5px] text-[var(--wf-dim)]">
                <LegendDot role="planner" />
                <LegendDot role="evaluator" />
                <LegendDot role="orchestrator" />
              </div>
            </div>

            {/* Thread body */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-[860px] px-6 py-5">
                {props.discussion.messages.length === 0 ? (
                  <EmptyHint>
                    Waiting for the planner to propose an approach. You can add context below to steer the discussion.
                  </EmptyHint>
                ) : (
                  <div className="flex flex-col gap-3">
                    {props.discussion.messages.map((item, i) => (
                      <DialogueRow key={`${item.role}:${item.round}:${item.timestamp}:${i}`} msg={item} />
                    ))}
                    <div ref={end} />
                  </div>
                )}
              </div>
            </div>

            {/* Orchestrator input */}
            <div className="wf-sand-input-bar">
              <div className="mx-auto w-full max-w-[860px]">
                <div className="mb-1.5 flex items-center gap-2 text-[10.5px] text-[var(--wf-dim)]">
                  <MessageSquarePlus className="h-3 w-3" strokeWidth={2} />
                  <span>
                    Speak as <span className="font-semibold text-[var(--wf-ink-soft)]">orchestrator</span> — your message is injected into the next round's context for both agents.
                  </span>
                </div>
                <div className="wf-sand-input">
                  <textarea
                    ref={textareaRef}
                    className="min-h-[42px] w-full resize-none bg-transparent text-[13px] leading-[1.6] text-[var(--wf-ink)] outline-none placeholder:text-[var(--wf-dim)]"
                    placeholder="Add constraints, preferences, or correct a misunderstanding…"
                    rows={1}
                    value={msg}
                    onChange={(e) => {
                      setMsg(e.target.value)
                      auto()
                    }}
                    onCompositionStart={() => {
                      composingRef.current = true
                    }}
                    onCompositionEnd={() => {
                      composingRef.current = false
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return
                      if (e.shiftKey) return
                      if ((e.nativeEvent as KeyboardEvent).isComposing) return
                      if ((e.nativeEvent as KeyboardEvent).keyCode === 229) return
                      if (composingRef.current) return
                      e.preventDefault()
                      send()
                    }}
                  />
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="text-[10px] text-[var(--wf-dim)]">⏎ to send · Shift+⏎ for newline</span>
                    <button className="wf-sand-send" disabled={!msg.trim()} onClick={send}>
                      <Send className="h-3 w-3" strokeWidth={2} />
                      Send
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── A single dialogue row — planner on the left, evaluator on the right, orchestrator centred ── */
function DialogueRow({ msg }: { msg: SandTableMessage }) {
  const tone = roleTone[msg.role]
  const Icon = tone.icon

  if (msg.role === "orchestrator") {
    // Full-width inserted banner — visually breaks the planner ↔ evaluator rhythm
    return (
      <div className="wf-sand-orchestrator-wrap">
        <div className="wf-sand-orchestrator-divider">
          <span className="wf-sand-orchestrator-divider-dot" />
          <span className="wf-sand-orchestrator-divider-text">
            You added context · Round {msg.round}
          </span>
          <span className="wf-sand-orchestrator-divider-dot" />
        </div>
        <div className="wf-sand-orchestrator-card">
          <div className="flex items-center gap-2">
            <div
              className="flex h-6 w-6 items-center justify-center rounded-md"
              style={{ background: tone.bg, color: tone.text }}
            >
              <Icon className="h-3 w-3" strokeWidth={1.8} />
            </div>
            <span className="text-[12px] font-semibold text-[var(--wf-ink)]">You</span>
            <span className="ml-auto font-mono text-[10px] text-[var(--wf-dim)]">{stamp(msg.timestamp)}</span>
          </div>
          <div className="mt-2 text-[13px] leading-[1.6] text-[var(--wf-ink-soft)]">
            <Markdown>{msg.content}</Markdown>
          </div>
        </div>
      </div>
    )
  }

  const alignRight = msg.role === "evaluator"

  return (
    <div className={`wf-sand-dialogue ${alignRight ? "wf-sand-dialogue--right" : "wf-sand-dialogue--left"}`}>
      <div
        className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full"
        style={{ background: tone.bg, color: tone.text }}
      >
        <Icon className="h-3.5 w-3.5" strokeWidth={1.8} />
      </div>

      <div className="wf-sand-bubble-wrap">
        <div className={`flex items-baseline gap-2 ${alignRight ? "flex-row-reverse" : ""}`}>
          <span className="text-[11.5px] font-semibold" style={{ color: tone.text }}>
            {roleTitle[msg.role]}
          </span>
          <span className="text-[10px] text-[var(--wf-dim)]">Round {msg.round}</span>
          {msg.model && (
            <span className="font-mono text-[10px] text-[var(--wf-dim)]">{msg.model}</span>
          )}
          <span className={`font-mono text-[10px] text-[var(--wf-dim)] ${alignRight ? "mr-auto" : "ml-auto"}`}>
            {stamp(msg.timestamp)}
          </span>
        </div>

        <div
          className="wf-sand-bubble"
          style={{
            background: tone.bubble,
            borderColor: tone.bubbleBorder,
          }}
        >
          <Markdown>{msg.content}</Markdown>
        </div>
      </div>
    </div>
  )
}

/* ── Legend dot for the thread header ── */
function LegendDot({ role }: { role: Role }) {
  const tone = roleTone[role]
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: tone.accent }}
      />
      <span>{roleTitle[role]}</span>
    </span>
  )
}

/* ── Topic hero — renders markdown, collapses long topics ── */
function TopicHero({ topic }: { topic: string }) {
  const trimmed = topic?.trim() ?? ""
  // Heuristic: treat as "long" if over 240 chars or 4+ lines. We show a
  // collapsed preview and let the user expand. Avoids eating the left column.
  const isLong = useMemo(() => {
    if (!trimmed) return false
    return trimmed.length > 240 || trimmed.split(/\r?\n/).length > 4
  }, [trimmed])
  const [expanded, setExpanded] = useState(false)

  if (!trimmed) {
    return (
      <div className="wf-sand-topic-hero">
        <div className="wf-sand-topic-hero-label">
          <Target className="h-3 w-3" strokeWidth={2} />
          Discussion topic
        </div>
        <div className="wf-sand-topic-hero-empty">No topic provided.</div>
      </div>
    )
  }

  return (
    <div className="wf-sand-topic-hero" data-expanded={expanded ? "true" : "false"}>
      <div className="wf-sand-topic-hero-label">
        <Target className="h-3 w-3" strokeWidth={2} />
        <span>Discussion topic</span>
      </div>
      <div
        className="wf-sand-topic-hero-body"
        data-clipped={isLong && !expanded ? "true" : "false"}
      >
        <Markdown>{trimmed}</Markdown>
      </div>
      {isLong && (
        <button
          type="button"
          className="wf-sand-topic-hero-toggle"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <>
              <ChevronDown className="h-3 w-3" strokeWidth={2} />
              Collapse
            </>
          ) : (
            <>
              <ChevronRight className="h-3 w-3" strokeWidth={2} />
              Show full topic
            </>
          )}
        </button>
      )}
    </div>
  )
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center rounded-lg border border-dashed border-[var(--wf-line)] bg-[var(--wf-chip)] px-4 py-5 text-center text-[11.5px] italic text-[var(--wf-dim)]">
      {children}
    </div>
  )
}
