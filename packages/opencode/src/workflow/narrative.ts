/**
 * Human-readable renderer for `Workflow.read()` results.
 *
 * Why this exists: the master orchestrator agent consumes `workflow_read`
 * output on every wake to decide what to do next. The default JSON shape
 * is built for HTTP / SDK / UI consumers and carries a lot of fields
 * that don't help an LLM decide ("session_id" UUIDs, "workflow_id"
 * back-references, "graph_rev_at_start" diagnostics, runtime counters,
 * raw UNIX timestamps, etc.). Feeding that JSON to the master burns
 * tokens on punctuation and noise without improving its reasoning.
 *
 * This module renders the same data as a compact markdown narrative
 * keyed by node-id. The schema still lives in workflow/index.ts (the
 * runtime validates / persists / diffs against it); only the master's
 * tool result is reformatted. The HTTP route and SDK / UI clients are
 * untouched.
 *
 * Design principles:
 *  - Drop UUIDs the orchestrator never references (session_id,
 *    workflow_id back-refs, message_id, command_id).
 *  - Keep IDs the orchestrator passes back to tools (node_id, edge_id,
 *    cursor, checkpoint_id, workflow_id once at the top).
 *  - Surface only load-bearing signal: status, attempt n/m, summary,
 *    needs, errors, usage, phase, waiting/failed node lists, stale,
 *    fail_reason.
 *  - Express times as relative deltas (`12s ago`, `running 8s`) — the
 *    master never does arithmetic on epochs.
 *  - Cap verbose collections (attempt_history already trimmed to last
 *    2 upstream; this renderer further caps actions / errors / needs).
 */
import type { Workflow } from "./index"

// Caps tuned for "every workflow_read should cost the master ≤ ~10 KB of
// context". Previous values (30 events, 2 attempts, 280-char summaries)
// blew past 25 KB on an active 5-node graph because each attempt_reported
// event also carried the full attempt payload — see workflow/index.ts
// where the event payload was trimmed to summary_short + counts.
const MAX_NEEDS = 5
const MAX_ERRORS = 3
const MAX_ATTEMPTS_SHOWN = 1
const MAX_ACTIONS_PER_ATTEMPT = 4
const MAX_EVENTS_SHOWN = 12
const SUMMARY_TRUNC = 160

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function relTime(now: number, ts?: number): string {
  if (!ts) return "—"
  const ms = now - ts
  if (ms < 0) return "just now"
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

function relDuration(startedAt?: number, completedAt?: number, now?: number): string {
  if (!startedAt) return "not started"
  const end = completedAt ?? now ?? Date.now()
  const ms = Math.max(0, end - startedAt)
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  if (m < 60) return rem ? `${m}m${rem}s` : `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h${m % 60}m`
}

function renderUsage(u?: Workflow.Usage): string | undefined {
  if (!u) return undefined
  const parts: string[] = []
  const inT = u.input_tokens + u.cache_read_tokens + u.cache_write_tokens
  if (inT) parts.push(`${inT} in`)
  if (u.output_tokens) parts.push(`${u.output_tokens} out`)
  if (u.reasoning_tokens) parts.push(`${u.reasoning_tokens} reason`)
  if (u.cost_usd) parts.push(`$${u.cost_usd.toFixed(4)}`)
  if (u.tool_calls) parts.push(`${u.tool_calls} tools`)
  return parts.length ? parts.join(", ") : undefined
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((v) => typeof v === "string")
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

function renderAttempt(att: Record<string, unknown>, now: number): string[] {
  const out: string[] = []
  const n = typeof att.attempt === "number" ? att.attempt : "?"
  const result = typeof att.result === "string" ? att.result : "?"
  const when = typeof att.time === "number" ? relTime(now, att.time) : ""
  out.push(`  - attempt ${n}: ${result}${when ? ` (${when})` : ""}`)
  if (typeof att.summary === "string" && att.summary.trim()) {
    out.push(`    summary: ${truncate(att.summary.trim(), SUMMARY_TRUNC)}`)
  }
  const needs = isStringArray(att.needs) ? att.needs : []
  if (needs.length) {
    const shown = needs.slice(0, MAX_NEEDS)
    out.push(`    needs:`)
    for (const n2 of shown) out.push(`      - ${truncate(n2, 160)}`)
    if (needs.length > shown.length) out.push(`      - …(+${needs.length - shown.length} more)`)
  }
  const actions = Array.isArray(att.actions) ? (att.actions as unknown[]) : []
  if (actions.length) {
    const shown = actions.slice(0, MAX_ACTIONS_PER_ATTEMPT)
    out.push(`    actions: ${actions.length}`)
    for (const a of shown) {
      const ar = rec(a)
      if (!ar) continue
      const goal = typeof ar.goal === "string" ? ar.goal : ""
      const outcome = typeof ar.outcome === "string" ? ar.outcome : "?"
      const kind = typeof ar.kind === "string" ? ar.kind : ""
      out.push(`      · [${outcome}${kind ? `/${kind}` : ""}] ${truncate(goal, 120)}`)
    }
    if (actions.length > shown.length) out.push(`      · …(+${actions.length - shown.length} more)`)
  }
  const errors = Array.isArray(att.errors) ? (att.errors as unknown[]) : []
  if (errors.length) {
    const shown = errors.slice(0, MAX_ERRORS)
    out.push(`    errors:`)
    for (const e of shown) {
      const er = rec(e)
      if (!er) continue
      const reason = typeof er.reason === "string" ? er.reason : "(no reason)"
      const src = typeof er.source === "string" ? `${er.source}: ` : ""
      const recov = er.recoverable === false ? " [unrecoverable]" : ""
      out.push(`      - ${src}${truncate(reason, 200)}${recov}`)
    }
    if (errors.length > shown.length) out.push(`      - …(+${errors.length - shown.length} more)`)
  }
  return out
}

function renderNode(node: Workflow.Node, now: number): string[] {
  const out: string[] = []
  const dur = relDuration(node.time.started, node.time.completed, now)
  const staleTag = node.stale ? " · STALE" : ""
  const failTag = node.fail_reason ? ` · fail_reason: ${truncate(node.fail_reason, 140)}` : ""
  out.push(
    `### ${node.title} (id: ${node.id}, agent: ${node.agent}) — ${node.status}/${node.result_status}, attempt ${node.attempt}/${node.max_attempts}, ${dur}${staleTag}${failTag}`,
  )
  const sj = rec(node.state_json) ?? {}
  const rj = rec(node.result_json)
  const history = Array.isArray(sj.attempt_history) ? (sj.attempt_history as unknown[]) : []
  if (history.length) {
    out.push(`  recent attempts (latest first):`)
    const recent = history.slice(-MAX_ATTEMPTS_SHOWN).reverse()
    for (const att of recent) {
      const ar = rec(att)
      if (!ar) continue
      out.push(...renderAttempt(ar, now))
    }
  }
  const openNeeds = isStringArray(sj.open_needs) ? sj.open_needs : []
  if (openNeeds.length) {
    out.push(`  open needs (blocking):`)
    for (const n of openNeeds.slice(0, MAX_NEEDS)) out.push(`    - ${truncate(n, 200)}`)
  }
  if (rj && Object.keys(rj).length) {
    const keys = Object.keys(rj).slice(0, 6)
    out.push(`  result keys: ${keys.join(", ")}${Object.keys(rj).length > keys.length ? ", …" : ""}`)
    if (typeof rj.summary === "string" && rj.summary.trim()) {
      out.push(`    result.summary: ${truncate(rj.summary.trim(), SUMMARY_TRUNC)}`)
    }
  }
  return out
}

function renderEventLine(ev: Workflow.EventInfo, now: number): string {
  const when = relTime(now, ev.time_created)
  const node = ev.node_id ? ` node:${ev.node_id.slice(0, 8)}` : ""
  // Compact one-line payload: pull a known small set of decision-relevant
  // keys, skip everything else. The slave used to bury the full attempt
  // body (summary + needs[] + actions[] + errors[]) in
  // `node.attempt_reported` payloads — that's now trimmed at the emit
  // site to `summary_short` + counts, so this renderer only needs to
  // surface those compact fields.
  const payload = ev.payload as Record<string, unknown> | undefined
  const interesting: string[] = []
  for (const k of [
    "status",
    "result_status",
    "fail_reason",
    "reason",
    "command",
    "from",
    "to",
    "attempt",
    "result",
    "summary_short",
    "needs_count",
    "errors_count",
  ] as const) {
    const v = payload?.[k]
    if (v === undefined || v === null) continue
    if (typeof v === "number" && v === 0) continue
    interesting.push(`${k}=${typeof v === "string" ? truncate(v, 100) : JSON.stringify(v)}`)
  }
  const tail = interesting.length ? ` { ${interesting.join(", ")} }` : ""
  return `- #${ev.id} ${ev.kind}${node} (${when})${tail}`
}

/**
 * Render a `Workflow.read()` result as compact markdown for the master
 * orchestrator. Returns a single string suitable as a tool result.
 */
export function renderNarrative(
  data: Workflow.ReadResult,
  opts: { now?: number } = {},
): string {
  const now = opts.now ?? Date.now()
  const lines: string[] = []

  const wf = data.workflow
  const rt = data.runtime
  if (wf) {
    lines.push(`# Workflow ${wf.title} (id: ${wf.id})`)
    const meta: string[] = [`status: ${wf.status}`]
    if (rt) {
      meta.push(`phase: ${rt.phase}`)
      if (rt.active_node_id) meta.push(`active: ${rt.active_node_id}`)
      if (rt.waiting_node_ids.length) meta.push(`waiting: ${rt.waiting_node_ids.join(",")}`)
      if (rt.failed_node_ids.length) meta.push(`failed: ${rt.failed_node_ids.join(",")}`)
    }
    lines.push(meta.join(" · "))
    const usage = renderUsage(rt?.usage)
    if (usage) lines.push(`usage: ${usage}`)
    if (rt?.limits) {
      const l: string[] = []
      if (rt.limits.max_input_tokens) l.push(`in≤${rt.limits.max_input_tokens}`)
      if (rt.limits.max_output_tokens) l.push(`out≤${rt.limits.max_output_tokens}`)
      if (rt.limits.max_cost_usd) l.push(`cost≤$${rt.limits.max_cost_usd}`)
      if (l.length) lines.push(`limits: ${l.join(", ")}`)
    }
    lines.push("")
  }

  if (data.nodes.length) {
    lines.push(`## Changed nodes (${data.nodes.length})`)
    for (const node of data.nodes) {
      lines.push(...renderNode(node, now))
      lines.push("")
    }
  }

  if (data.checkpoints.length) {
    lines.push(`## Checkpoints (${data.checkpoints.length})`)
    for (const cp of data.checkpoints) {
      const rj = rec(cp.result_json)
      const reason =
        rj && typeof rj.reason === "string" && rj.reason
          ? ` — ${truncate(rj.reason, 140)}`
          : ""
      lines.push(`- ${cp.label} (id: ${cp.id}, node: ${cp.node_id}) — ${cp.status}${reason}`)
    }
    lines.push("")
  }

  if (data.edges.length) {
    lines.push(`## Edges (${data.edges.length})`)
    for (const e of data.edges) {
      const portFrom = e.from_port ? `:${e.from_port}` : ""
      const portTo = e.to_port ? `:${e.to_port}` : ""
      const req = e.required === false ? " (optional)" : ""
      const lbl = e.label ? ` "${truncate(e.label, 60)}"` : ""
      lines.push(`- ${e.from_node_id}${portFrom} → ${e.to_node_id}${portTo}${lbl}${req}`)
    }
    lines.push("")
  }

  if (data.edits && data.edits.length) {
    lines.push(`## Recent edits (${data.edits.length})`)
    for (const ed of data.edits.slice(0, 10)) {
      const reason = ed.reason ? ` — ${truncate(ed.reason, 120)}` : ""
      const opCount = Array.isArray(ed.ops) ? ed.ops.length : 0
      lines.push(`- ${ed.status} (id: ${ed.id}, ops: ${opCount}, rev: ${ed.graph_rev_before}→${ed.graph_rev_after ?? "?"})${reason}`)
    }
    lines.push("")
  }

  if (data.events.length) {
    lines.push(`## Events (${data.events.length})`)
    const shown = data.events.slice(-MAX_EVENTS_SHOWN)
    if (data.events.length > shown.length) {
      lines.push(`  …(${data.events.length - shown.length} older events omitted; pass smaller cursor to backfill)`)
    }
    for (const ev of shown) lines.push(renderEventLine(ev, now))
    lines.push("")
  }

  lines.push(`cursor: ${data.cursor}`)

  return lines.join("\n")
}
