/** @jsxImportSource react */
/**
 * Events panel — node-aware redesign.
 *
 * The original Events tab was a single flat chronological list with a
 * "→ NodeTitle" deep-link chip per row. That answered "when did things
 * happen" but not "what did each node do" — the user has to scan the
 * whole list to mentally group rows by node, and there's no visual
 * sense of which node was busy when.
 *
 * This redesign keeps the chronological list as a fallback ("Timeline"
 * mode) but defaults to a node-grouped view that anchors each event to
 * its source node:
 *
 *   1. A summary strip at the top — total nodes touched, total events,
 *      time-range covered.
 *   2. A compact swimlane chart — one row per node, time on the x-axis,
 *      events as colored ticks. Lets the user spot at a glance which
 *      node is currently busy and how nodes' activity windows overlap.
 *   3. A grouped event list below the swimlane — one collapsible card
 *      per node, with a header that shows node title / kind / status /
 *      event count / duration, and an expandable list of that node's
 *      events. Events without a node go into a "System" group.
 *
 * The aim is "what did each node do, in time" rather than "what
 * happened next". The flat timeline mode remains one click away for
 * users who prefer the strict chronological scan.
 */

import { useMemo, useState } from "react"
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cog,
  PauseCircle,
  PlayCircle,
} from "lucide-react"

export type EventRow = {
  id: string | number
  kind: string
  source: string
  nodeID?: string
  nodeTitle?: string
  summary: string
  time: number
}

type NodeMeta = {
  id: string
  title: string
  type?: string
  status?: "pending" | "running" | "completed" | "failed" | "paused"
}

type Props = {
  events: EventRow[]
  /* Node metadata for the bucketing header — the events panel doesn't
   * own this, but having `kind` + `status` available lets each group
   * header read at a glance. */
  nodes?: NodeMeta[]
  /* Click handler when the user clicks a node header / swimlane row /
   * timeline-row deep-link. Surfaces the same node-pick action that
   * other panels (canvas, inspector) use. */
  onSelectNode?: (nodeID: string) => void
}

type Tone = "ok" | "err" | "warn" | "run" | "idle"

/* Event kinds the user actually wants to see on the timeline —
 * "what task ran, what was the purpose, what was done, what's the
 * result". Everything else (workflow.orchestrator_wake, node.pulled,
 * node.command_acked, graph.edit.*, etc.) is bureaucratic chrome
 * that's useful for debugging but pure noise day-to-day. We default
 * the panel to this signal set and offer a "Show chrome" toggle to
 * unfilter when the user needs the full audit view.
 *
 * `node.attempt_reported` is the most important one — the agent's
 * per-attempt summary lives in its payload.summary, and
 * workflow-panel.tsx's projection now surfaces that text as the
 * row's display summary. So a single row reads as e.g. "Implemented
 * timer schema — added cron column · success". */
const SIGNAL_KINDS = new Set<string>([
  // Per-attempt agent reports — the headline signal.
  "node.attempt_reported",
  // Terminal node states.
  "node.completed",
  "node.failed",
  "node.cancelled",
  "node.interrupted",
  // Node "needs input" / blocked states — user attention required.
  "node.waiting",
  "node.blocked",
  "node.need_opened",
  "node.need_fulfilled",
  "node.need_resolved",
  // Hard budget breaches — user should know we hit a limit.
  "node.attempt_limit_reached",
  "node.budget_exceeded",
  "node.stalled",
  // Manual review gates.
  "checkpoint.pending",
  "checkpoint.failed",
  // Workflow-level lifecycle.
  "workflow.created",
  "workflow.completed",
  "workflow.failed",
  "workflow.cancelled",
  "workflow_finalized",
])

/* Map an event kind string to a coarse tone. Mirrors the original
 * inline impl so existing user mental model survives. */
function eventTone(kind: string): Tone {
  const k = kind.toLowerCase()
  if (k.includes("error") || k.includes("fail")) return "err"
  if (k.includes("complete") || k.includes("done") || k.includes("success"))
    return "ok"
  if (k.includes("start") || k.includes("running")) return "run"
  if (k.includes("pause") || k.includes("wait")) return "warn"
  return "idle"
}

/* Pick the dominant tone for a group of events — "what state did this
 * node last reach". Used for the group header status pip. Priority:
 * err > run > warn > ok > idle. */
function dominantTone(events: EventRow[]): Tone {
  let best: Tone = "idle"
  const rank: Record<Tone, number> = { idle: 0, ok: 1, warn: 2, run: 3, err: 4 }
  for (const ev of events) {
    const t = eventTone(ev.kind)
    if (rank[t] > rank[best]) best = t
  }
  return best
}

/* Tone → icon for the group header status pill. */
function ToneIcon({ tone, className }: { tone: Tone; className?: string }) {
  if (tone === "err") return <AlertCircle className={className} strokeWidth={2.2} />
  if (tone === "ok") return <CheckCircle2 className={className} strokeWidth={2.2} />
  if (tone === "warn") return <PauseCircle className={className} strokeWidth={2.2} />
  if (tone === "run") return <PlayCircle className={className} strokeWidth={2.2} />
  return <Cog className={className} strokeWidth={2.2} />
}

/* Format a timestamp for the timeline / event row. Uses HH:MM:SS so
 * intra-second clusters are still distinguishable. */
function fmtTime(t: number): string {
  return new Date(t).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

/* Format a duration in milliseconds as "Ns" / "Nm Ns" / "Nh Nm". For
 * the group header — we want to convey roughly how long the node was
 * active without a wall of digits. */
function fmtDuration(ms: number): string {
  if (ms < 0) return "—"
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/* ── Group key: nodeID for nodes, "__system__" for everything else.
 *
 * We split system events into their own bucket because mixing them in
 * with a real node group is misleading — system events (workflow
 * created, master-session wakeups, edits proposed/applied) describe
 * the workflow shell, not what any one node did. A dedicated System
 * group keeps the per-node story clean and lets the user collapse
 * shell noise out of the view when they want to focus on node work. */
const SYSTEM_KEY = "__system__"

type Group = {
  key: string
  /** Display title — node title for real nodes, "System" otherwise. */
  title: string
  /** The first event's source if no node is associated, e.g. "master". */
  subtitle?: string
  nodeID?: string
  nodeMeta?: NodeMeta
  events: EventRow[]
  firstTime: number
  lastTime: number
}

/* ── Swimlane row ──
 *
 * Renders one node's activity on a horizontal time axis. Each event
 * lands as a dot at its proportional offset within the global window;
 * a thin connector between min/max event marks the node's "active
 * window". Hovering a dot reveals its summary, clicking a row deep-
 * links to that node tab the same way the existing chips do.
 *
 * The viz is intentionally compact (28px tall) so several lanes fit in
 * the events pane without scrolling — its job is overview, not detail.
 */
function SwimlaneRow({
  group,
  windowStart,
  windowEnd,
  onSelectNode,
}: {
  group: Group
  windowStart: number
  windowEnd: number
  onSelectNode?: (nodeID: string) => void
}) {
  const span = Math.max(1, windowEnd - windowStart)
  const tone = dominantTone(group.events)
  const startPct = ((group.firstTime - windowStart) / span) * 100
  const endPct = ((group.lastTime - windowStart) / span) * 100
  const isClickable = !!group.nodeID && !!onSelectNode

  return (
    <div
      className="wf-events-lane"
      data-tone={tone}
      data-clickable={isClickable ? "true" : "false"}
      onClick={() => isClickable && group.nodeID && onSelectNode!(group.nodeID)}
      role={isClickable ? "button" : undefined}
      tabIndex={isClickable ? 0 : undefined}
    >
      <div className="wf-events-lane-label">
        <ToneIcon tone={tone} className="wf-events-lane-label-i" />
        <span className="wf-events-lane-label-text">{group.title}</span>
        <span className="wf-events-lane-label-count">{group.events.length}</span>
      </div>
      <div className="wf-events-lane-track" aria-hidden>
        {/* Active-window connector — only draw if the node has more
         * than one event AND its window has non-zero width. */}
        {group.events.length > 1 && endPct > startPct && (
          <span
            className="wf-events-lane-window"
            style={{
              left: `${startPct}%`,
              width: `${Math.max(1, endPct - startPct)}%`,
            }}
          />
        )}
        {group.events.map((ev) => {
          const pct = ((ev.time - windowStart) / span) * 100
          const evTone = eventTone(ev.kind)
          return (
            <span
              key={String(ev.id)}
              className={`wf-events-lane-dot wf-events-lane-dot--${evTone}`}
              style={{ left: `${pct}%` }}
              title={`${fmtTime(ev.time)} · ${ev.kind} · ${ev.summary}`}
            />
          )
        })}
      </div>
    </div>
  )
}

/* ── Group card ──
 *
 * The collapsible node card. Header shows what + when + how-many at
 * one glance; expanding it reveals the node's events as a compact
 * list. The header is also the toggle button — keeps the card tight.
 */
function GroupCard({
  group,
  windowStart,
  windowEnd,
  defaultOpen,
  onSelectNode,
}: {
  group: Group
  windowStart: number
  windowEnd: number
  defaultOpen: boolean
  onSelectNode?: (nodeID: string) => void
}) {
  const [open, setOpen] = useState(defaultOpen)
  const tone = dominantTone(group.events)
  const duration = group.events.length > 0 ? group.lastTime - group.firstTime : 0
  // For the inline mini-bar inside the header — same geometry as the
  // swimlane row above but without the lane label, so the user keeps
  // a sense of "where in time this node was active" even after the
  // top swimlane scrolls out of view.
  const span = Math.max(1, windowEnd - windowStart)
  const startPct = ((group.firstTime - windowStart) / span) * 100
  const endPct = ((group.lastTime - windowStart) / span) * 100

  return (
    <section className="wf-events-grp" data-tone={tone} data-open={open ? "true" : "false"}>
      <button
        type="button"
        className="wf-events-grp-hd"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="wf-events-grp-hd-chev" aria-hidden>
          {open ? (
            <ChevronDown className="h-3 w-3" strokeWidth={2.2} />
          ) : (
            <ChevronRight className="h-3 w-3" strokeWidth={2.2} />
          )}
        </span>
        <ToneIcon tone={tone} className="wf-events-grp-hd-i" />
        <span className="wf-events-grp-hd-title">{group.title}</span>
        {group.nodeMeta?.type && (
          <span className="wf-events-grp-hd-type">{group.nodeMeta.type}</span>
        )}
        <span className="wf-events-grp-hd-count">
          {group.events.length} event{group.events.length === 1 ? "" : "s"}
        </span>
        {group.events.length > 0 && (
          <span className="wf-events-grp-hd-time">
            {fmtTime(group.firstTime)}
            {group.events.length > 1 && (
              <>
                <span className="wf-events-grp-hd-time-sep">→</span>
                {fmtTime(group.lastTime)}
                <span className="wf-events-grp-hd-time-dur">{fmtDuration(duration)}</span>
              </>
            )}
          </span>
        )}
        <span className="wf-events-grp-hd-bar" aria-hidden>
          {group.events.length > 1 && endPct > startPct && (
            <span
              className="wf-events-grp-hd-bar-fill"
              style={{
                left: `${startPct}%`,
                width: `${Math.max(1, endPct - startPct)}%`,
              }}
            />
          )}
          {group.events.map((ev) => {
            const pct = ((ev.time - windowStart) / span) * 100
            const evTone = eventTone(ev.kind)
            return (
              <span
                key={`hd-${ev.id}`}
                className={`wf-events-grp-hd-bar-tick wf-events-grp-hd-bar-tick--${evTone}`}
                style={{ left: `${pct}%` }}
              />
            )
          })}
        </span>
        {group.nodeID && onSelectNode && (
          <span
            className="wf-events-grp-hd-open"
            role="button"
            onClick={(e) => {
              e.stopPropagation()
              onSelectNode(group.nodeID!)
            }}
            title="Open node"
          >
            Open →
          </span>
        )}
      </button>
      {open && (
        <ol className="wf-events-grp-list">
          {group.events.map((ev) => {
            const tone = eventTone(ev.kind)
            return (
              <li key={String(ev.id)} className="wf-events-grp-row">
                <span className="wf-events-grp-row-time">{fmtTime(ev.time)}</span>
                <span className={`wf-events-grp-row-dot wf-events-grp-row-dot--${tone}`} aria-hidden />
                <div className="wf-events-grp-row-body">
                  <div className="wf-events-grp-row-headline">
                    <span className={`wf-events-grp-row-kind wf-events-grp-row-kind--${tone}`}>
                      {ev.kind}
                    </span>
                    <span className="wf-events-grp-row-source">{ev.source}</span>
                  </div>
                  <div className="wf-events-grp-row-summary">{ev.summary}</div>
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

/* ── Flat timeline (legacy) ──
 *
 * The original chronological view, kept as a one-click toggle for
 * users who prefer pure time-order. Same row design as before — node
 * deep-link chip on the right, kind pill + source on the left. */
function FlatTimeline({
  events,
  onSelectNode,
}: {
  events: EventRow[]
  onSelectNode?: (nodeID: string) => void
}) {
  if (events.length === 0) {
    return (
      <div className="wf-events-empty">
        No events yet — run the workflow to populate the timeline.
      </div>
    )
  }
  // Newest-first to match the user's reading direction (latest activity
  // at the top, like a feed).
  const sorted = [...events].sort((a, b) => b.time - a.time)
  return (
    <ol className="wf-timeline">
      {sorted.map((ev) => {
        const tone = eventTone(ev.kind)
        return (
          <li key={String(ev.id)} className="wf-timeline-row">
            <span className="wf-timeline-time">{fmtTime(ev.time)}</span>
            <span className="wf-timeline-spine" aria-hidden>
              <span className={`wf-timeline-dot wf-timeline-dot--${tone}`} />
            </span>
            <div className="wf-timeline-body">
              <div className="wf-timeline-headline">
                <span className={`wf-timeline-kind wf-timeline-kind--${tone}`}>
                  {ev.kind}
                </span>
                <span className="wf-timeline-source">{ev.source}</span>
                {ev.nodeTitle && ev.nodeID && (
                  <button
                    type="button"
                    className="wf-timeline-node"
                    onClick={() => onSelectNode?.(ev.nodeID!)}
                  >
                    → {ev.nodeTitle}
                  </button>
                )}
              </div>
              <div className="wf-timeline-summary">{ev.summary}</div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

export function EventsPanel({ events, nodes, onSelectNode }: Props) {
  const [mode, setMode] = useState<"by-node" | "timeline">("by-node")
  // Signal vs chrome filter. Default is `signal` — the user reported
  // the timeline was full of `workflow.orchestrator_wake` /
  // `node.pulled` / `graph.edit.*` noise and asked to see "what task
  // ran, what was done, what's the result". `SIGNAL_KINDS` defines
  // exactly that subset. Flipping to `all` brings the audit view
  // back for debugging.
  const [filterLevel, setFilterLevel] = useState<"signal" | "all">("signal")

  // Apply the signal/chrome filter BEFORE bucketing — both the
  // swimlane overview and the grouped accordion read the filtered
  // list so chrome doesn't inflate node-level event counts either.
  const visibleEvents = useMemo(() => {
    if (filterLevel === "all") return events
    return events.filter((ev) => SIGNAL_KINDS.has(ev.kind))
  }, [events, filterLevel])
  const hiddenChromeCount = events.length - visibleEvents.length

  // ── Bucketing ────────────────────────────────────────────────────
  // Build a stable, ordered list of groups: real nodes first, then
  // System. Within each group events are sorted oldest-first so the
  // group's narrative reads top-to-bottom ("started → did work →
  // completed"). The group order itself is by first-event time so the
  // groups appear in the same order the workflow activated them.
  const { groups, windowStart, windowEnd, totals } = useMemo(() => {
    if (visibleEvents.length === 0) {
      return {
        groups: [] as Group[],
        windowStart: 0,
        windowEnd: 0,
        totals: { nodes: 0, events: 0, durationMs: 0 },
      }
    }
    const nodeIndex = new Map<string, NodeMeta>()
    for (const n of nodes ?? []) nodeIndex.set(n.id, n)

    const buckets = new Map<string, EventRow[]>()
    for (const ev of visibleEvents) {
      const key = ev.nodeID ?? SYSTEM_KEY
      const arr = buckets.get(key) ?? []
      arr.push(ev)
      buckets.set(key, arr)
    }

    const built: Group[] = []
    for (const [key, evs] of buckets) {
      const sorted = [...evs].sort((a, b) => a.time - b.time)
      const meta = key === SYSTEM_KEY ? undefined : nodeIndex.get(key)
      built.push({
        key,
        title:
          key === SYSTEM_KEY
            ? "System"
            : meta?.title ??
              evs.find((e) => e.nodeTitle)?.nodeTitle ??
              key.slice(0, 8),
        subtitle: key === SYSTEM_KEY ? sorted[0]?.source : undefined,
        nodeID: key === SYSTEM_KEY ? undefined : key,
        nodeMeta: meta,
        events: sorted,
        firstTime: sorted[0].time,
        lastTime: sorted[sorted.length - 1].time,
      })
    }

    // Order: nodes by their first activity, System last.
    built.sort((a, b) => {
      if (a.key === SYSTEM_KEY) return 1
      if (b.key === SYSTEM_KEY) return -1
      return a.firstTime - b.firstTime
    })

    let lo = visibleEvents[0].time
    let hi = visibleEvents[0].time
    for (const ev of visibleEvents) {
      if (ev.time < lo) lo = ev.time
      if (ev.time > hi) hi = ev.time
    }

    const nodeCount = built.filter((g) => g.key !== SYSTEM_KEY).length
    return {
      groups: built,
      windowStart: lo,
      windowEnd: hi === lo ? lo + 1 : hi,
      totals: {
        nodes: nodeCount,
        events: visibleEvents.length,
        durationMs: hi - lo,
      },
    }
  }, [visibleEvents, nodes])

  if (events.length === 0) {
    return (
      <div className="wf-events-pane">
        <div className="wf-events-empty">
          No events yet — run the workflow to populate the timeline.
        </div>
      </div>
    )
  }

  return (
    <div className="wf-events-pane">
      {/* Top summary strip + mode toggle. The summary text is the
        * "tldr" of what's happened so far; the toggle lets users flip
        * to chronological order if the per-node grouping isn't what
        * they want for the question they're trying to answer. */}
      <div className="wf-events-bar">
        <div className="wf-events-bar-stats">
          <span className="wf-events-bar-stat">
            <span className="wf-events-bar-stat-v">{totals.nodes}</span>
            <span className="wf-events-bar-stat-l">node{totals.nodes === 1 ? "" : "s"}</span>
          </span>
          <span className="wf-events-bar-stat">
            <span className="wf-events-bar-stat-v">{totals.events}</span>
            <span className="wf-events-bar-stat-l">event{totals.events === 1 ? "" : "s"}</span>
          </span>
          <span className="wf-events-bar-stat">
            <span className="wf-events-bar-stat-v">{fmtDuration(totals.durationMs)}</span>
            <span className="wf-events-bar-stat-l">window</span>
          </span>
          <span className="wf-events-bar-range">
            {fmtTime(windowStart)} <span className="wf-events-bar-range-sep">→</span> {fmtTime(windowEnd)}
          </span>
        </div>
        <div className="wf-events-bar-toggle" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "by-node"}
            className="wf-events-bar-toggle-btn"
            data-active={mode === "by-node" ? "true" : "false"}
            onClick={() => setMode("by-node")}
          >
            By node
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "timeline"}
            className="wf-events-bar-toggle-btn"
            data-active={mode === "timeline" ? "true" : "false"}
            onClick={() => setMode("timeline")}
          >
            Timeline
          </button>
        </div>
        {/* Signal / chrome filter. Default is "signal" so the panel
          * surfaces only the events the user actually wants to read
          * ("what task ran, what was done, result"). Chrome (orch
          * wakes, command lifecycle, graph edits, pull events) is
          * one click away when debugging. The hidden count makes it
          * discoverable. */}
        <div className="wf-events-bar-toggle" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={filterLevel === "signal"}
            className="wf-events-bar-toggle-btn"
            data-active={filterLevel === "signal" ? "true" : "false"}
            onClick={() => setFilterLevel("signal")}
            title="Show only attempt reports, completions, blockers, budget breaches, and workflow lifecycle"
          >
            Signal
            {hiddenChromeCount > 0 && filterLevel === "signal" && (
              <span className="ml-1 text-[9px] opacity-60">
                ·{hiddenChromeCount}
              </span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filterLevel === "all"}
            className="wf-events-bar-toggle-btn"
            data-active={filterLevel === "all" ? "true" : "false"}
            onClick={() => setFilterLevel("all")}
            title="Include orchestrator wakes, command acks, graph edits, and other chrome events"
          >
            All
          </button>
        </div>
      </div>

      {mode === "by-node" ? (
        <>
          {/* Swimlane overview — at-a-glance "who was busy when". */}
          <div className="wf-events-swim">
            <div className="wf-events-swim-axis" aria-hidden>
              <span>{fmtTime(windowStart)}</span>
              <span>{fmtTime(windowEnd)}</span>
            </div>
            <div className="wf-events-swim-rows">
              {groups.map((g) => (
                <SwimlaneRow
                  key={`lane-${g.key}`}
                  group={g}
                  windowStart={windowStart}
                  windowEnd={windowEnd}
                  onSelectNode={onSelectNode}
                />
              ))}
            </div>
          </div>

          {/* Per-node grouped accordion. The first running / most
            * recently active group expands by default so the user
            * lands on something useful instead of a wall of headers. */}
          <div className="wf-events-grps">
            {(() => {
              // Pick the default-open group: prefer a running node,
              // otherwise the most-recently-active group, otherwise
              // the last one in the list.
              const running = groups.find(
                (g) => g.nodeMeta?.status === "running" && g.key !== SYSTEM_KEY,
              )
              const recent = [...groups]
                .filter((g) => g.key !== SYSTEM_KEY)
                .sort((a, b) => b.lastTime - a.lastTime)[0]
              const openKey = running?.key ?? recent?.key ?? groups[groups.length - 1]?.key
              return groups.map((g) => (
                <GroupCard
                  key={`grp-${g.key}`}
                  group={g}
                  windowStart={windowStart}
                  windowEnd={windowEnd}
                  defaultOpen={g.key === openKey}
                  onSelectNode={onSelectNode}
                />
              ))
            })()}
          </div>
        </>
      ) : (
        <FlatTimeline events={visibleEvents} onSelectNode={onSelectNode} />
      )}
    </div>
  )
}
