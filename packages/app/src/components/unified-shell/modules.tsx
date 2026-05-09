/**
 * Module interior components — Trace / Knowledge / Workflow Inspector.
 *
 * These are the visual layer per the design template. Each accepts
 * pre-fetched real data via props (the page wrapper does the fetch +
 * action wiring). Visual structure mirrors trace.css / knowledge.css /
 * workflow.css from the design source — see modules.css for the
 * matching style sheet.
 *
 * Components exported:
 *   <TraceRecall>    — Recall main + retrieve-session aside
 *   <KnowledgeList>  — Experience list (cards, click → ExpDetailModal)
 *   <KnowledgeGraph> — Radial graph view
 *   <ExpDetailModal> — Modal popup with full experience detail
 *   <WorkflowInspector> — Right-aside Inspector (Selected node + LLM route)
 *
 * All selectors are scoped under .rune-shell so styles do not leak.
 */

import { Icon } from "@opencode-ai/ui/icon"
import {
  createMemo,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import "./modules.css"

/* ──────────────────────────────────────────────────────
   Shared atoms
   ────────────────────────────────────────────────────── */

function Chev(props: { size?: number; rotate?: number }) {
  return (
    <svg
      width={props.size ?? 11}
      height={props.size ?? 11}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      style={{
        transform: props.rotate ? `rotate(${props.rotate}deg)` : undefined,
        transition: "transform 180ms ease",
      }}
    >
      <path d="M5 6l3 3 3-3" />
    </svg>
  )
}

function CloseX(props: { size?: number }) {
  return (
    <svg
      width={props.size ?? 13}
      height={props.size ?? 13}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}

/* ──────────────────────────────────────────────────────
   TraceRecall — Recall main + retrieve-session aside
   ────────────────────────────────────────────────────── */

export type TraceHit = {
  index: string
  cat?: string
  catLabel?: string
  code?: string
  title: string
  body?: string
  /** Similarity score in [0, 1]. When set, renders a right-side score
   * column (number + bar), matching the design template. */
  score?: number
}

export type TraceRecallEntry = {
  id: string
  /** Display time, e.g. "21:48:25". */
  time: string
  /** Short timestamp for the aside chip. */
  shortTime?: string
  /** Turn index. */
  turn: number
  /** User-readable query / triggering text. */
  query?: string
  /** Optional one-line agent intent, derived from agent_name etc. */
  intent?: string
  /** Number of hits surfaced. */
  hitCount: number
  /** ms duration. */
  durationMs: number
  /** "session" / "workspace" etc. */
  source?: string
  hits: TraceHit[]
  llmUsed?: boolean
}

export function TraceRecall(props: {
  entries: TraceRecallEntry[]
  activeId?: string
  onPick: (id: string) => void
  /** Optional empty-state message. */
  emptyText?: string
  /** Optional substring of the model id, shown in the section meta. */
  modelTag?: string
}) {
  const active = createMemo(() => props.entries.find((e) => e.id === props.activeId) ?? props.entries[0])
  return (
    <div class="rt-grid">
      <section class="rt-main-pane">
        <Show
          when={active()}
          fallback={
            <div class="rt-recall">
              <div class="rt-hit-empty">{props.emptyText ?? "暂无召回记录"}</div>
            </div>
          }
        >
          {(entry) => (
            <div class="rt-recall">
              <div class="rt-recall-q">
                <div class="rt-recall-q-meta">
                  <span class="rune-chip" data-tone="ac">
                    Turn {entry().turn}
                  </span>
                  <span>↳ retrieve hook</span>
                  <span class="rune-grow" />
                  <span class="rune-mono">{entry().time}</span>
                </div>
                <div class="rt-recall-q-text">
                  {entry().query || <em style={{ color: "var(--rune-fg-faint)" }}>（无 query 文本）</em>}
                </div>
              </div>

              <div>
                <div class="rt-recall-sec-hd">
                  <b>Hits</b>
                  <span class="rt-recall-sec-count">
                    {entry().hits.length}
                    <span> / {entry().hitCount}</span>
                  </span>
                  <div class="rt-recall-sec-meta">
                    <Show when={entry().llmUsed} fallback={<span>heuristic</span>}>
                      <span>llm</span>
                    </Show>
                    <Show when={props.modelTag}>
                      <span class="rt-recall-sec-sep" />
                      <span>{props.modelTag}</span>
                    </Show>
                    <span class="rt-recall-sec-sep" />
                    <span>{entry().durationMs}ms</span>
                  </div>
                </div>

                <Show
                  when={entry().hits.length > 0}
                  fallback={<div class="rt-hit-empty">该轮未触发 retrieve</div>}
                >
                  <div class="rt-hits">
                    <For each={entry().hits}>
                      {(h) => (
                        <button
                          type="button"
                          class="rt-hit"
                          data-has-score={h.score !== undefined ? "true" : "false"}
                        >
                          <span class="rt-hit-i">{h.index}</span>
                          <div class="rt-hit-main">
                            <div class="rt-hit-row1">
                              <Show when={h.cat}>
                                <span class="rt-hit-cat">{h.catLabel ?? h.cat}</span>
                              </Show>
                              <span class="rt-hit-title">{h.title}</span>
                              <Show when={h.code}>
                                <span class="rt-hit-code">{h.code}</span>
                              </Show>
                            </div>
                            <Show when={h.body}>
                              <div class="rt-hit-body">{h.body}</div>
                            </Show>
                          </div>
                          <Show when={h.score !== undefined}>
                            <div class="rt-hit-score">
                              <span class="rt-hit-score-num">
                                {(h.score! * 100).toFixed(0)}
                              </span>
                              <span class="rt-hit-score-bar" aria-hidden>
                                <i style={{ width: `${Math.min(100, Math.max(0, h.score! * 100))}%` }} />
                              </span>
                            </div>
                          </Show>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </div>
          )}
        </Show>
      </section>

      <aside class="rt-aside-pane">
        <div class="rt-aside-hd">
          <span class="rt-aside-title">Retrieve agent · session</span>
          <span class="rune-grow" />
          <span class="rt-aside-count">{props.entries.length}</span>
        </div>
        <div class="rt-aside-bd">
          <Show
            when={props.entries.length > 0}
            fallback={<div class="rt-hit-empty">尚无记录</div>}
          >
            <For each={props.entries}>
              {(r) => (
                <button
                  type="button"
                  class="rt-rsess"
                  classList={{ "is-on": r.id === active()?.id }}
                  onClick={() => props.onPick(r.id)}
                >
                  <div class="rt-rsess-head">
                    <span class="rt-rsess-t">{r.shortTime ?? r.time}</span>
                    <span class="rt-rsess-turn">turn {r.turn}</span>
                    <span class="rune-grow" />
                    <span class="rt-rsess-ms">{r.durationMs}ms</span>
                  </div>
                  <Show when={r.query}>
                    <div class="rt-rsess-msg rt-rsess-msg-user">
                      <span class="rt-rsess-msg-role">user</span>
                      <span class="rt-rsess-msg-text">{r.query}</span>
                    </div>
                  </Show>
                  <Show when={r.intent}>
                    <div class="rt-rsess-msg rt-rsess-msg-agent">
                      <span class="rt-rsess-msg-role">agent</span>
                      <span class="rt-rsess-msg-text">{r.intent}</span>
                    </div>
                  </Show>
                  <div class="rt-rsess-foot">
                    <span class="rt-rsess-chip">{r.hitCount} hits</span>
                    <Show when={r.source}>
                      <span class="rt-rsess-chip is-mute">{r.source}</span>
                    </Show>
                    <span class="rune-grow" />
                    <Show when={r.llmUsed === false}>
                      <span class="rt-rsess-chip is-mute">heur</span>
                    </Show>
                  </div>
                </button>
              )}
            </For>
          </Show>
        </div>
      </aside>
    </div>
  )
}

/* ──────────────────────────────────────────────────────
   Knowledge List (cards)
   ────────────────────────────────────────────────────── */

export type KnowledgeExp = {
  id: string
  cat: string
  /** Display label for the cat e.g. "流程规则". */
  catLabel?: string
  title: string
  body: string
  /** "workspace" / "project" / "repo" etc. */
  scope?: string
  /** "pending" / "rejected" / undefined if approved. */
  flag?: "pending" | "rejected"
  /** Time-ago string, e.g. "7d". */
  ago?: string
  /** Optional observation count. */
  obs?: number
  /** Optional tags. */
  tags?: string[]
  /** Machine-readable rule, optional. */
  statement?: string
}

export function KnowledgeList(props: {
  experiences: KnowledgeExp[]
  pickedId?: string
  /** Click handler. Receives modifier-key state so the caller can
   *  implement multi-select for the merge action (shift-click /
   *  cmd-click). Without modifiers, it's a normal "open detail". */
  onPick: (id: string, modifiers?: { shift?: boolean; meta?: boolean }) => void
  /** Click a #tag chip on a card to filter the list to that tag. */
  onPickTag?: (tag: string) => void
  /** Currently active tag filter — bolds the matching chip on cards. */
  activeTag?: string
  /** Set of currently multi-selected ids — used to highlight selected
   *  rows differently from the single "open" row. */
  selectedIds?: Set<string>
  emptyText?: string
}) {
  return (
    <div class="kw-grid">
      <section class="kw-main-pane">
        <div class="kw-list">
          <Show
            when={props.experiences.length > 0}
            fallback={<div class="kw-exp-empty">{props.emptyText ?? "暂无 experience"}</div>}
          >
            <For each={props.experiences}>
              {(e) => (
                <button
                  type="button"
                  class="kw-exp"
                  classList={{
                    "is-on": e.id === props.pickedId,
                    "is-selected": props.selectedIds?.has(e.id),
                  }}
                  data-flag={e.flag ?? ""}
                  onClick={(ev) => props.onPick(e.id, { shift: ev.shiftKey, meta: ev.metaKey || ev.ctrlKey })}
                >
                  <Show when={e.flag === "pending"}>
                    <span class="kw-exp-pending-pulse" aria-hidden />
                  </Show>
                  <div class="kw-exp-row1">
                    <span class="kw-exp-cat" data-kind={e.cat}>{e.catLabel ?? e.cat}</span>
                    <span class="kw-exp-title">{e.title}</span>
                    <Show when={e.ago}>
                      <span class="kw-exp-ago">{e.ago}</span>
                    </Show>
                  </div>
                  <div class="kw-exp-body">{e.body}</div>
                  <div class="kw-exp-row3">
                    <Show when={e.scope}>
                      <span class="rune-chip">{e.scope}</span>
                    </Show>
                    <Show when={e.tags && e.tags.length > 0}>
                      <For each={e.tags!.slice(0, 4)}>{(t) => (
                        <button
                          type="button"
                          class="rune-chip kw-tag-chip"
                          classList={{ "is-active": t === props.activeTag }}
                          onClick={(ev) => {
                            ev.stopPropagation()
                            props.onPickTag?.(t)
                          }}
                          title={`Filter by #${t}`}
                        >
                          #{t}
                        </button>
                      )}</For>
                    </Show>
                    <Show when={e.flag}>
                      <span class="kw-exp-flag" classList={{ [`f-${e.flag}`]: true }}>
                        {e.flag}
                      </span>
                    </Show>
                    <Show when={e.obs !== undefined}>
                      <span class="kw-exp-obs">obs · {e.obs}</span>
                    </Show>
                  </div>
                </button>
              )}
            </For>
          </Show>
        </div>
      </section>
    </div>
  )
}

/* ──────────────────────────────────────────────────────
   Knowledge Graph (radial)
   ────────────────────────────────────────────────────── */

export type KnowledgeEdge = {
  a: string
  b: string
  /** "pre" / "refine" / "support" / "related". */
  kind?: string
}

export function KnowledgeGraph(props: {
  experiences: KnowledgeExp[]
  edges: KnowledgeEdge[]
  pickedId?: string
  onPick: (id: string) => void
}) {
  // Radial layout: rings by category index, evenly distributed within.
  const layout = createMemo(() => {
    const cx = 460
    const cy = 240
    const cats = [...new Set(props.experiences.map((e) => e.cat))]
    const positioned = props.experiences.map((e) => {
      const ci = Math.max(0, cats.indexOf(e.cat))
      const ring = 80 + ci * 60
      const same = props.experiences.filter((x) => x.cat === e.cat)
      const idx = same.indexOf(e)
      const angle = (idx / Math.max(1, same.length)) * Math.PI * 2 + ci * 0.2
      return {
        ...e,
        gx: cx + Math.cos(angle) * ring,
        gy: cy + Math.sin(angle) * ring,
      }
    })
    const nodeMap = new Map(positioned.map((n) => [n.id, n]))
    return { positioned, nodeMap }
  })

  return (
    <div class="kw-grid">
      <section class="kw-main-pane">
        <div class="kw-graph">
          <svg viewBox="0 0 920 480" preserveAspectRatio="xMidYMid meet">
            <For each={props.edges}>
              {(e) => {
                const a = layout().nodeMap.get(e.a)
                const b = layout().nodeMap.get(e.b)
                if (!a || !b) return null
                return (
                  <line
                    x1={a.gx}
                    y1={a.gy}
                    x2={b.gx}
                    y2={b.gy}
                    class={`kw-gedge ${e.kind ?? ""}`}
                  />
                )
              }}
            </For>
            <For each={layout().positioned}>
              {(n) => (
                <g style={{ cursor: "pointer" }} onClick={() => props.onPick(n.id)}>
                  <circle
                    cx={n.gx}
                    cy={n.gy}
                    r={props.pickedId === n.id ? 8 : 5}
                    class="kw-gnode"
                    classList={{ "is-on": props.pickedId === n.id }}
                  />
                  <text x={n.gx + 10} y={n.gy + 4} class="kw-gnode-label">
                    {n.title.slice(0, 14)}
                  </text>
                </g>
              )}
            </For>
          </svg>
          <div class="kw-graph-legend">
            <div class="kw-graph-legend-row">
              <span class="swatch" style={{ background: "var(--rune-line-strong)" }} /> related
            </div>
            <div class="kw-graph-legend-row">
              <span
                class="swatch"
                style={{ background: "var(--rune-ac)", "border-top": "1px dashed var(--rune-ac)" }}
              />{" "}
              refines / supports
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

/* ──────────────────────────────────────────────────────
   ExpDetailModal — opens on knowledge card click
   ────────────────────────────────────────────────────── */

export function ExpDetailModal(props: {
  exp?: KnowledgeExp
  onClose: () => void
  /** Optional extra detail block (sources, related ids, refinement history). */
  children?: JSX.Element
  /** Optional action row (refine / archive / merge / etc.). */
  actions?: JSX.Element
}) {
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose()
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => document.removeEventListener("keydown", onKey))
  })
  return (
    <Show when={props.exp}>
      {(exp) => (
        <div class="kw-modal" onClick={props.onClose}>
          <div class="kw-modal-panel" onClick={(e) => e.stopPropagation()}>
            <header class="kw-modal-hd">
              <span class="kw-exp-cat" data-kind={exp().cat}>{exp().catLabel ?? exp().cat}</span>
              <span
                class="rune-mono"
                style={{ "font-size": "var(--rune-fs-xs)", color: "var(--rune-fg-faint)" }}
              >
                <Show when={exp().obs !== undefined}>obs {exp().obs} · </Show>
                <Show when={exp().ago}>{exp().ago}</Show>
              </span>
              <span class="rune-grow" />
              {props.actions}
              <button
                type="button"
                class="rune-btn"
                data-variant="ghost"
                data-icon="true"
                data-size="xs"
                onClick={props.onClose}
                title="Close"
              >
                <CloseX />
              </button>
            </header>
            <div class="kw-modal-bd">
              <h3>{exp().title}</h3>
              <p>{exp().body}</p>
              <Show when={exp().tags && exp().tags!.length > 0}>
                <div class="kw-modal-row">
                  <For each={exp().tags!}>{(t) => <span class="kw-tag">#{t}</span>}</For>
                </div>
              </Show>
              <Show when={exp().statement}>
                <div class="kw-modal-divider" />
                <span class="kw-modal-sec-label">Statement</span>
                <code class="kw-modal-stmt">{exp().statement}</code>
              </Show>
              {props.children}
            </div>
          </div>
        </div>
      )}
    </Show>
  )
}

/* ──────────────────────────────────────────────────────
   Workflow Inspector aside
   ────────────────────────────────────────────────────── */

export type AgentRoute = {
  id: string
  role: string
  model: string
  state?: "active" | "idle"
  calls?: number
}

export type SelectedNode = {
  id: string
  label: string
  kind?: string
  state?: "ok" | "run" | "warn" | "idle" | "err" | "running" | "done"
  meta?: string
}

export function WorkflowInspector(props: {
  open: boolean
  onToggle: () => void
  node?: SelectedNode
  agents?: AgentRoute[]
  onPickAgent?: (id: string) => void
}) {
  const stateDot = (s: SelectedNode["state"]) =>
    s === "running" ? "run" : s === "done" ? "ok" : s === "ok" ? "ok" : s ?? "idle"
  return (
    <div class="wf-grid" data-aside={props.open ? "open" : "closed"}>
      <div class="wf-center"></div>
      <aside class="wf-aside">
        <button
          type="button"
          class="wf-aside-toggle"
          onClick={props.onToggle}
          title={props.open ? "Collapse panel" : "Expand panel"}
        >
          <Show
            when={props.open}
            fallback={
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M10 4l-4 4 4 4" />
              </svg>
            }
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M6 4l4 4-4 4" />
            </svg>
          </Show>
        </button>
        <div class="wf-insp">
          <div class="wf-insp-head">
            <span class="wf-insp-title">
              <Show when={props.node} fallback="Inspector">
                {(n) => `Node · ${n().label}`}
              </Show>
            </span>
            <span class="rune-grow" />
            <button
              type="button"
              class="rune-btn"
              data-variant="ghost"
              data-icon="true"
              data-size="xs"
              title="Pop out"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
                <path d="M6 3h7v7" />
                <path d="M13 3L6 10" />
                <path d="M11 8.5V13H3V5h4.5" />
              </svg>
            </button>
          </div>
          <div class="wf-insp-body">
            <Show when={props.node}>
              {(n) => (
                <section class="wf-insp-section">
                  <header class="wf-insp-section-hd">Selected node</header>
                  <div class="wf-insp-section-bd">
                    <dl class="wf-kv">
                      <dt>id</dt>
                      <dd>{n().id}</dd>
                      <Show when={n().kind}>
                        <dt>kind</dt>
                        <dd>{n().kind}</dd>
                      </Show>
                      <Show when={n().state}>
                        <dt>state</dt>
                        <dd>
                          <span class="rune-dot" data-st={stateDot(n().state)} /> {n().state}
                        </dd>
                      </Show>
                      <Show when={n().meta}>
                        <dt>meta</dt>
                        <dd>{n().meta}</dd>
                      </Show>
                    </dl>
                  </div>
                </section>
              )}
            </Show>
            <Show
              when={props.agents && props.agents.length > 0}
              fallback={
                <Show when={!props.node}>
                  <div class="wf-insp-empty">No node selected. Pick a node in the canvas to inspect.</div>
                </Show>
              }
            >
              <section class="wf-insp-section">
                <header class="wf-insp-section-hd">
                  <span>LLM route · {props.agents!.length}</span>
                  <span class="wf-insp-section-hint">click to reroute</span>
                </header>
                <div class="wf-insp-section-bd">
                  <For each={props.agents!}>
                    {(a) => (
                      <button
                        type="button"
                        class="wf-arow"
                        title={`Configure model for ${a.role}`}
                        onClick={() => props.onPickAgent?.(a.id)}
                      >
                        <span class="rune-dot" data-st={a.state === "active" ? "run" : "idle"} />
                        <span class="wf-arow-role">{a.role}</span>
                        <span class="wf-arow-model">{a.model}</span>
                        <Show when={a.calls !== undefined}>
                          <span class="wf-arow-calls">{a.calls}</span>
                        </Show>
                        <span class="wf-arow-chev">
                          <Chev size={10} />
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              </section>
            </Show>
          </div>
        </div>
      </aside>
    </div>
  )
}

/* Re-export Icon convenience for module consumers. */
export { Icon }
