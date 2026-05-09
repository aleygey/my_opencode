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
  /** Per-role inner-session messages — the planner/evaluator agents
   *  each run their own inner session with reasoning + tool calls
   *  before posting back to the sand-table thread. The bottom-left
   *  stream pane renders these live so the user can watch the
   *  current agent think. Keyed by role; missing key means no
   *  inner session yet. */
  innerMessages?: {
    planner?: Array<{ id: string; role: string; text?: string; tool?: string; out?: string; t?: string; dur?: string; stream?: boolean }>
    evaluator?: Array<{ id: string; role: string; text?: string; tool?: string; out?: string; t?: string; dur?: string; stream?: boolean }>
  }
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

/* ── Inner-session live stream pane (bottom-left) ──
 * Shows the current planner or evaluator agent's INNER session in
 * real time — including reasoning, tool calls, and streamed text — so
 * the user can watch the agent think before its output lands in the
 * main discussion thread. Switches between planner / evaluator via
 * a two-button segmented bar at the top. */
function InnerStreamPane({
  participants,
  innerMessages,
  activeRole,
}: {
  participants: {
    planner?: { sessionID: string; model: string }
    evaluator?: { sessionID: string; model: string }
  }
  innerMessages?: Props["innerMessages"]
  activeRole: "planner" | "evaluator"
}) {
  const [role, setRole] = useState<"planner" | "evaluator">(activeRole)
  // Auto-follow: when the externally-active role changes (e.g. evaluator
  // takes over from planner mid-round), switch the stream view to it
  // so the user always sees the freshest agent.
  const lastActive = useRef(activeRole)
  useEffect(() => {
    if (activeRole !== lastActive.current) {
      setRole(activeRole)
      lastActive.current = activeRole
    }
  }, [activeRole])
  const messages = role === "planner"
    ? (innerMessages?.planner ?? [])
    : (innerMessages?.evaluator ?? [])
  const part = participants[role]
  const tone = roleTone[role]
  const RoleIcon = tone.icon
  const end = useRef<HTMLDivElement>(null)
  // Auto-scroll on new messages.
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [messages.length, role])

  return (
    <div className="wf-sand-inner-stream">
      <div className="wf-sand-inner-stream-tabs" role="tablist">
        {(["planner", "evaluator"] as const).map((r) => {
          const p = participants[r]
          if (!p) return null
          const t = roleTone[r]
          const Icon = t.icon
          return (
            <button
              key={r}
              type="button"
              role="tab"
              aria-selected={role === r}
              className="wf-sand-inner-stream-tab"
              data-active={role === r ? "true" : "false"}
              onClick={() => setRole(r)}
            >
              <span
                className="flex h-4 w-4 items-center justify-center rounded-md"
                style={{ background: t.bg, color: t.text }}
              >
                <Icon className="h-2.5 w-2.5" strokeWidth={1.8} />
              </span>
              {roleTitle[r]}
            </button>
          )
        })}
      </div>
      <div className="wf-sand-inner-stream-meta" title={part?.sessionID}>
        <RoleIcon className="h-3 w-3" strokeWidth={1.8} style={{ color: tone.text }} />
        <span className="font-mono">{part?.model ?? "—"}</span>
        <span className="ml-auto font-mono text-[10px]">
          {part ? `${part.sessionID.slice(0, 8)}…` : "—"}
        </span>
      </div>
      <div className="wf-sand-inner-stream-body">
        {messages.length === 0 ? (
          <div className="wf-sand-inner-stream-empty">
            <Spin size={11} line={1.6} tone={tone.text} />
            <span>Waiting for {roleTitle[role].toLowerCase()} to start thinking…</span>
          </div>
        ) : (
          <>
            {messages.map((m) => (
              <InnerStreamMessage key={m.id} m={m} tone={tone} />
            ))}
            <div ref={end} />
          </>
        )}
      </div>
    </div>
  )
}

type InnerMsg = {
  id: string
  role: string
  text?: string
  tool?: string
  out?: string
  t?: string
  dur?: string
  stream?: boolean
}

function InnerStreamMessage({
  m,
  tone,
}: {
  m: InnerMsg
  tone: { text: string; bubble: string; bubbleBorder: string }
}) {
  if (m.role === "tool") {
    return (
      <div className="wf-sand-inner-row">
        <span className="wf-sand-inner-role wf-sand-inner-role-tool">tool</span>
        <span className="wf-sand-inner-tool-cmd">{m.tool ?? "(?)"}</span>
        {m.dur && <span className="wf-sand-inner-meta">{m.dur}</span>}
        {m.t && <span className="wf-sand-inner-meta">{m.t}</span>}
        {m.out && (
          <pre className="wf-sand-inner-tool-out">{m.out.slice(0, 300)}</pre>
        )}
      </div>
    )
  }
  if (m.role === "reason" || m.role === "thinking") {
    return (
      <div className="wf-sand-inner-row">
        <span className="wf-sand-inner-role wf-sand-inner-role-reason">thinking</span>
        {m.dur && <span className="wf-sand-inner-meta">{m.dur}</span>}
        <div className="wf-sand-inner-reason">{m.text}</div>
      </div>
    )
  }
  // agent / system / default
  return (
    <div className="wf-sand-inner-row">
      <span
        className="wf-sand-inner-role wf-sand-inner-role-agent"
        style={{ color: tone.text }}
      >
        {m.role === "system" ? "system" : "agent"}
      </span>
      {m.t && <span className="wf-sand-inner-meta">{m.t}</span>}
      <div className="wf-sand-inner-agent">
        {m.text}
        {m.stream && <span className="wf-sand-inner-caret" />}
      </div>
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

  // Staggered reveal for incoming messages.
  //
  // The backend publishes a message only after the participant finishes
  // writing — so our polling sees messages arrive as discrete atomic drops.
  // When the user opens a running discussion after being away, two or three
  // messages can appear in the same poll tick, which reads like a batched
  // dump rather than a back-and-forth. We smooth that out by keeping an
  // internal "revealed" counter: the first render after mount shows every
  // already-known message immediately (so history isn't delayed), but any
  // message that arrives later is revealed one-at-a-time with a short
  // delay, letting the thinking bubble flip between roles between drops.
  const [revealed, setRevealed] = useState(props.discussion.messages.length)
  useEffect(() => {
    const total = props.discussion.messages.length
    if (revealed >= total) {
      // Incoming batch shrank (e.g. discussion reset) — snap to current.
      if (revealed !== total) setRevealed(total)
      return
    }
    // Reveal one more message per tick until caught up.
    const t = setTimeout(() => setRevealed((n) => Math.min(n + 1, total)), 450)
    return () => clearTimeout(t)
  }, [props.discussion.messages.length, revealed])

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" })
    // Include status + revealed in deps so that when the thinking bubble
    // appears/disappears (round completes) or a new message is revealed by
    // the stagger, the thread scrolls to keep the latest activity in view.
  }, [revealed, props.discussion.status])

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

  // The Plan / Evaluation tabs should reflect whatever the corresponding
  // agent has already said, even if the backend hasn't yet folded that output
  // into the structured `current_plan` / `last_evaluation` fields. Without
  // this fallback there's a race window (right after planner posts) where
  // `current_plan` is still empty but `thinkingRole` has already flipped to
  // "evaluator" — leading the Plan tab to render the evaluator's thinking
  // panel, which is semantically wrong for that tab.
  const latestPlannerText = useMemo(() => {
    for (let i = props.discussion.messages.length - 1; i >= 0; i--) {
      const m = props.discussion.messages[i]
      if (m.role === "planner" && m.content.trim()) return m.content.trim()
    }
    return ""
  }, [props.discussion.messages])
  const latestEvaluatorText = useMemo(() => {
    for (let i = props.discussion.messages.length - 1; i >= 0; i--) {
      const m = props.discussion.messages[i]
      if (m.role === "evaluator" && m.content.trim()) return m.content.trim()
    }
    return ""
  }, [props.discussion.messages])

  const planText = props.discussion.current_plan?.trim() || latestPlannerText
  const evalText = props.discussion.last_evaluation?.trim() || latestEvaluatorText
  const hasPlan = !!planText
  const hasEval = !!evalText
  const hasContext = !!(props.discussion.context && props.discussion.context.trim())

  // Tally orchestrator injections — surface to user so they see their context landed.
  const orchestratorCount = useMemo(
    () => props.discussion.messages.filter((m) => m.role === "orchestrator").length,
    [props.discussion.messages],
  )

  // Which role is currently "thinking" — i.e. expected to post next but
  // hasn't in this round yet. Drives the placeholder bubble at the end of
  // the thread so users aren't staring at a silent panel between rounds.
  //
  // Model: each round runs planner → evaluator. So given the last non-
  // orchestrator message's role, we know who's up:
  //   - last was evaluator (or no message yet) → planner is thinking
  //   - last was planner → evaluator is thinking
  // When the discussion is not running, nobody is thinking.
  //
  // Derived from the *revealed* slice (not the full messages array) so that
  // during staggered reveal of a batch, the thinking bubble flips roles
  // between drops — reinforcing the "planner → evaluator → planner" cadence
  // visually even though the backend delivered both messages at once.
  const revealedMessages = useMemo(
    () => props.discussion.messages.slice(0, revealed),
    [props.discussion.messages, revealed],
  )
  const thinkingRole = useMemo<Role | null>(() => {
    if (props.discussion.status !== "running") return null
    // Still catching up on a batched reveal — whoever is next in the pipeline
    // is the one the user should perceive as "working".
    const source = revealedMessages
    const pipelineMessages = source.filter(
      (m) => m.role === "planner" || m.role === "evaluator",
    )
    const last = pipelineMessages[pipelineMessages.length - 1]
    if (!last) return "planner"
    return last.role === "planner" ? "evaluator" : "planner"
  }, [revealedMessages, props.discussion.status])

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
                    <Markdown>{planText}</Markdown>
                  </div>
                ) : thinkingRole === "planner" ? (
                  // Planner is composing and hasn't posted yet. Mirror its
                  // activity here so the Plan tab isn't empty during round 1.
                  // Note: we explicitly do NOT render the evaluator's thinking
                  // panel here — the Plan tab is about the planner's artifact.
                  <AgentThinkingPanel
                    role="planner"
                    round={props.discussion.round || 1}
                    model={plannerModel}
                  />
                ) : (
                  <EmptyHint>暂无计划 — 等待 planner 开始草拟。</EmptyHint>
                )
              )}
              {tab === "evaluation" && (
                hasEval ? (
                  <div className="wf-sand-doc">
                    <Markdown>{evalText}</Markdown>
                  </div>
                ) : thinkingRole === "evaluator" ? (
                  <AgentThinkingPanel
                    role="evaluator"
                    round={props.discussion.round || 1}
                    model={evaluatorModel}
                  />
                ) : (
                  <EmptyHint>暂无评估 — evaluator 会在首轮计划出现后响应。</EmptyHint>
                )
              )}
              {tab === "context" && (
                <ContextTabBody
                  initial={props.discussion.context}
                  orchestratorMessages={props.discussion.messages.filter((m) => m.role === "orchestrator")}
                />
              )}
            </div>

            {/* Inner-session live stream — replaces the static participants
              * footer. Switches between planner / evaluator inner sessions
              * via two-tab segmented; renders reasoning, agent text and
              * tool calls inline so the user can watch the current agent
              * think in real time. */}
            {(participantsByRole.planner || participantsByRole.evaluator) && (
              <InnerStreamPane
                participants={{
                  planner: participantsByRole.planner ? {
                    sessionID: participantsByRole.planner.sessionID,
                    model: `${participantsByRole.planner.model.providerID}/${participantsByRole.planner.model.modelID}`,
                  } : undefined,
                  evaluator: participantsByRole.evaluator ? {
                    sessionID: participantsByRole.evaluator.sessionID,
                    model: `${participantsByRole.evaluator.model.providerID}/${participantsByRole.evaluator.model.modelID}`,
                  } : undefined,
                }}
                innerMessages={props.innerMessages}
                activeRole={thinkingRole === "evaluator" ? "evaluator" : "planner"}
              />
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
              <div className="mx-auto w-full max-w-[1160px] px-4 py-4">
                {revealedMessages.length === 0 && !thinkingRole ? (
                  <EmptyHint>
                    Waiting for the planner to propose an approach. You can add context below to steer the discussion.
                  </EmptyHint>
                ) : (
                  <div className="flex flex-col gap-3">
                    {revealedMessages.map((item, i) => (
                      <DialogueRow
                        key={`${item.role}:${item.round}:${item.timestamp}:${i}`}
                        msg={item}
                      />
                    ))}
                    {thinkingRole && (
                      <ThinkingBubble
                        role={thinkingRole}
                        round={props.discussion.round || 1}
                        model={
                          thinkingRole === "planner"
                            ? plannerModel
                            : thinkingRole === "evaluator"
                              ? evaluatorModel
                              : undefined
                        }
                      />
                    )}
                    <div ref={end} />
                  </div>
                )}
              </div>
            </div>

            {/* Orchestrator input */}
            <div className="wf-sand-input-bar">
              <div className="mx-auto w-full max-w-[1160px]">
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
                      // Shift+Enter: always a plain newline. Also used to
                      // "exit" an ordered list — we let the browser insert
                      // the break without auto-continuing the marker.
                      if (e.shiftKey) return
                      if ((e.nativeEvent as KeyboardEvent).isComposing) return
                      if ((e.nativeEvent as KeyboardEvent).keyCode === 229) return
                      if (composingRef.current) return

                      // Ordered-list autocomplete. Inspect the line containing
                      // the caret. If it starts with "N. " we either (a)
                      // continue to "N+1. " on the next line, or (b) clear
                      // the empty marker and drop to a blank line, which
                      // ends the list — mirroring most rich-text editors.
                      const ta = e.currentTarget
                      const { selectionStart, selectionEnd, value } = ta
                      if (selectionStart === selectionEnd) {
                        const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1
                        const lineEnd = value.indexOf("\n", selectionStart)
                        const line = value.slice(lineStart, lineEnd === -1 ? value.length : lineEnd)
                        const match = line.match(/^(\s*)(\d+)\.\s(.*)$/)
                        if (match) {
                          const [, indent, numStr, rest] = match
                          if (rest.trim().length === 0) {
                            // Empty item → exit list: delete the marker,
                            // leaving a plain newline.
                            e.preventDefault()
                            const before = value.slice(0, lineStart)
                            const after = value.slice(lineEnd === -1 ? value.length : lineEnd)
                            const next = before + indent + after
                            setMsg(next)
                            requestAnimationFrame(() => {
                              const pos = (before + indent).length
                              ta.setSelectionRange(pos, pos)
                              auto()
                            })
                            return
                          }
                          // Continue list at N+1.
                          e.preventDefault()
                          const nextNum = Number(numStr) + 1
                          const insert = `\n${indent}${nextNum}. `
                          const before = value.slice(0, selectionStart)
                          const after = value.slice(selectionEnd)
                          const next = before + insert + after
                          setMsg(next)
                          requestAnimationFrame(() => {
                            const pos = before.length + insert.length
                            ta.setSelectionRange(pos, pos)
                            auto()
                          })
                          return
                        }
                      }

                      e.preventDefault()
                      send()
                    }}
                  />
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="text-[10px] text-[var(--wf-dim)]">⏎ send · Shift+⏎ newline · "1. " ⏎ continues list</span>
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

/* ── A single dialogue row ──
 *
 * Alignment rule (post-cleanup): both planner and evaluator are agents, so
 * they share the LEFT column; user-injected context (role="orchestrator")
 * sits on the RIGHT like a user message in a chat UI. The previous layout
 * split planner-left / evaluator-right, which blurred the distinction
 * between "agents discussing" and "user steering". */
function DialogueRow({ msg }: { msg: SandTableMessage }) {
  const tone = roleTone[msg.role]
  const Icon = tone.icon

  // User-injected context — right-aligned bubble, mirrors chat-app convention.
  const alignRight = msg.role === "orchestrator"

  return (
    <div
      className={`wf-sand-dialogue wf-sand-dialogue--enter ${alignRight ? "wf-sand-dialogue--right" : "wf-sand-dialogue--left"}`}
    >
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

/* ── Placeholder bubble shown while planner/evaluator is composing ──
 *
 * Mirrors DialogueRow's layout so when the real message arrives it
 * replaces this bubble in-place. Three animated dots telegraph the
 * "agent is working" state without requiring a separate pane. */
function ThinkingBubble({
  role,
  round,
  model,
}: {
  role: Role
  round: number
  model?: string
}) {
  const tone = roleTone[role]
  const Icon = tone.icon
  // Agents (planner, evaluator) share the left column; only user-injected
  // orchestrator messages render on the right. The thinking bubble is only
  // ever shown for planner/evaluator so this collapses to always-left.
  const alignRight = role === "orchestrator"

  return (
    <div
      className={`wf-sand-dialogue wf-sand-dialogue--enter ${alignRight ? "wf-sand-dialogue--right" : "wf-sand-dialogue--left"}`}
      aria-live="polite"
    >
      <div
        className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full"
        style={{ background: tone.bg, color: tone.text }}
      >
        <Icon className="h-3.5 w-3.5" strokeWidth={1.8} />
      </div>

      <div className="wf-sand-bubble-wrap">
        <div className={`flex items-baseline gap-2 ${alignRight ? "flex-row-reverse" : ""}`}>
          <span className="text-[11.5px] font-semibold" style={{ color: tone.text }}>
            {roleTitle[role]}
          </span>
          <span className="text-[10px] text-[var(--wf-dim)]">Round {round}</span>
          {model && <span className="font-mono text-[10px] text-[var(--wf-dim)]">{model}</span>}
          <span className={`text-[10px] font-medium italic text-[var(--wf-dim)] ${alignRight ? "mr-auto" : "ml-auto"}`}>
            thinking…
          </span>
        </div>

        <div
          className="wf-sand-bubble wf-sand-bubble--thinking"
          style={{ background: tone.bubble, borderColor: tone.bubbleBorder }}
        >
          <span className="wf-sand-thinking-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
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

/* ── Topic hero — renders markdown, collapses long topics ──
 *
 * If the orchestrator already passed Markdown (headings, bullets), we render
 * it verbatim. But the master agent often flattens topics into a single
 * run-on sentence ("…核心功能：1）…；2）…；3）…"). `structureTopic` detects
 * those patterns and lifts them into a proper bullet list so the panel stays
 * scannable without requiring the master agent to emit perfect Markdown.
 */
function structureTopic(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ""
  // If the topic already contains Markdown structure (headings, list markers,
  // code fences, >50% line-breaks), leave it alone.
  const looksStructured =
    /^#{1,6}\s/m.test(trimmed) ||
    /^[-*]\s/m.test(trimmed) ||
    /^\d+\.\s/m.test(trimmed) ||
    /^```/m.test(trimmed) ||
    trimmed.split(/\r?\n/).filter((l) => l.trim()).length >= 3

  if (looksStructured) return trimmed

  // Split on a "header：" prefix if present ("核心功能：1）a；2）b；3）c").
  const headerMatch = trimmed.match(/^(.{0,40}?[：:])\s*(.+)$/s)
  const header = headerMatch?.[1]?.trim() ?? ""
  const body = headerMatch?.[2]?.trim() ?? trimmed

  // Split on enumerated fragments: "1）…", "1) …", "2、…" etc.
  const enumerated = body
    .split(/\s*(?:\d+[)）、.]\s+|；|;\s+)/)
    .map((s) => s.trim())
    .filter(Boolean)

  if (enumerated.length >= 2) {
    const bullets = enumerated.map((item) => `- ${item.replace(/[。.；;]\s*$/, "")}`).join("\n")
    return header ? `**${header}**\n\n${bullets}` : bullets
  }

  // Otherwise split on sentence-terminator punctuation — still better than one blob.
  const sentences = body
    .split(/(?<=[。.！!？?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)

  if (sentences.length >= 3) {
    const bullets = sentences.map((s) => `- ${s}`).join("\n")
    return header ? `**${header}**\n\n${bullets}` : bullets
  }

  return trimmed
}

function TopicHero({ topic }: { topic: string }) {
  const trimmed = topic?.trim() ?? ""
  const structured = useMemo(() => structureTopic(trimmed), [trimmed])
  // Heuristic: treat as "long" if over 240 chars or 4+ lines. We show a
  // collapsed preview and let the user expand. Avoids eating the left column.
  const isLong = useMemo(() => {
    if (!structured) return false
    return structured.length > 240 || structured.split(/\r?\n/).length > 4
  }, [structured])
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
        <Markdown>{structured}</Markdown>
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

/* ── Thinking panel ──
 *
 * Fills the Plan/Evaluation tab when the corresponding artifact hasn't been
 * produced yet but the discussion is live. Without this the user would see
 * "No plan proposed yet" for the entire first round, which feels stuck. We
 * echo the role's color + the animated Spin so the left column confirms
 * activity mirrors what's happening in the dialogue on the right. */
function AgentThinkingPanel({
  role,
  round,
  model,
}: {
  role: Role
  round: number
  model?: string
}) {
  const tone = roleTone[role]
  const label = role === "planner" ? "Planner" : role === "evaluator" ? "Evaluator" : "Orchestrator"
  const zhLabel = role === "planner" ? "Planner 正在草拟计划" : role === "evaluator" ? "Evaluator 正在评估" : "Orchestrator 正在输入"
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-dashed border-[var(--wf-line-strong)] bg-[var(--wf-chip)] px-4 py-5">
      <div className="flex items-center gap-2">
        <div
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full"
          style={{ background: tone.bg, color: tone.text }}
        >
          <Spin size={14} tone={tone.text} line={1.8} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[12px] font-bold" style={{ color: tone.text }}>{label}</span>
            <span className="text-[10px] text-[var(--wf-dim)]">Round {round}</span>
          </div>
          <div className="mt-0.5 text-[11px] font-medium italic text-[var(--wf-ink-soft)]">{zhLabel}…</div>
        </div>
      </div>
      {model && (
        <div className="ml-9 flex items-center gap-1.5 text-[10.5px] text-[var(--wf-dim)]">
          <span className="font-mono">{model}</span>
        </div>
      )}
      <div className="ml-9 flex items-center gap-1.5">
        <span className="wf-sand-thinking-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      </div>
    </div>
  )
}

/* ── Context tab body ──
 *
 * Historically this panel showed only the initial `context` field passed when
 * sand_table was invoked. But orchestrator supplements (user-typed messages
 * mid-discussion) ARE context for the next round — the backend concatenates
 * them into each agent's prompt — so leaving them out of the Context tab was
 * misleading. We now show initial context on top and all user supplements
 * below, annotated with round so it's obvious when each one landed. */
function ContextTabBody({
  initial,
  orchestratorMessages,
}: {
  initial: string
  orchestratorMessages: SandTableMessage[]
}) {
  const hasInitial = !!initial?.trim()
  const hasSupp = orchestratorMessages.length > 0

  if (!hasInitial && !hasSupp) {
    return <EmptyHint>暂无背景信息 —— 可在右侧输入框以 orchestrator 身份补充上下文。</EmptyHint>
  }

  return (
    <div className="flex flex-col gap-4">
      {hasInitial && (
        <section className="space-y-1.5">
          <div className="text-[10.5px] font-bold uppercase tracking-[0.07em] text-[var(--wf-dim)]">初始上下文</div>
          <div className="wf-sand-doc">
            <Markdown>{initial}</Markdown>
          </div>
        </section>
      )}
      {hasSupp && (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10.5px] font-bold uppercase tracking-[0.07em] text-[var(--wf-dim)]">用户补充</span>
            <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--wf-chip)] px-1.5 text-[10px] font-bold tabular-nums text-[var(--wf-dim)]">
              {orchestratorMessages.length}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {orchestratorMessages.map((msg, i) => (
              <div
                key={`supp-${i}-${msg.timestamp}`}
                className="rounded-lg border border-[var(--wf-line)] bg-[var(--wf-card)] px-3 py-2"
              >
                <div className="mb-1 flex items-center gap-2 text-[10px] text-[var(--wf-dim)]">
                  <span className="font-semibold uppercase tracking-[0.05em]">Round {msg.round}</span>
                  <span>·</span>
                  <span className="font-mono">{stamp(msg.timestamp)}</span>
                </div>
                <div className="wf-sand-doc text-[12px]">
                  <Markdown>{msg.content}</Markdown>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
