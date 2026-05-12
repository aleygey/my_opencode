/** @jsxImportSource react */
/**
 * Workflow canvas — graph layout (replaces the lane-based view).
 *
 * The previous implementation projected the DAG into vertical "lanes"
 * (one chain per lane), with a top horizontal `BranchConnector`
 * trunk and an optional `MergeConnector` for a single fan-in tail.
 * That worked for ~3-lane plans, but as the user noted it breaks down
 * the moment a real plan has multiple intermediate fan-ins / fan-outs:
 * lanes can't show convergence mid-graph, and the visual reads as a
 * forest of unrelated columns instead of one DAG.
 *
 * The new design (matched to the Workflow Runtime design hand-off)
 * lays the DAG out as a layered graph:
 *
 *   1. Topological column assignment — each node's column is the
 *      longest path from any root, so all "ready at the same depth"
 *      nodes line up vertically.
 *   2. Within-column row assignment — sorted by avg parent row to
 *      minimise edge crossings (a cheap approximation; works well for
 *      <50 nodes which is our target scale).
 *   3. Edges drawn as smooth horizontal bezier curves from
 *      source.right → target.left. Multiple edges into one node
 *      naturally show as fan-in (no synthetic merge node needed).
 *      Edges with `kind === 'support'` (cross-stage / secondary
 *      dependencies) are drawn dashed so they don't compete with
 *      the primary flow.
 *   4. The active edge (the live "this just kicked off" arrow) gets
 *      an animated dashed flow overlay + accent colour so users can
 *      track execution at a glance.
 *
 * The pan/zoom + dotted-grid background + HUD chip cluster are kept
 * from the prior canvas; the rest is reworked.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BrainCircuit, GitBranch, Locate, Sparkles } from 'lucide-react'
import { WorkflowNode, type NodeStatus, type NodeType } from './workflow-node'
import { Spin } from './spin'

interface Node {
  id: string
  title: string
  type: NodeType
  status: NodeStatus
  session?: string
  liveStatus?: string
  progress?: number
  summary?: string[]
  stale?: boolean
}

export interface CanvasEdge {
  /** Source node id (out-edge end). */
  from: string
  /** Target node id (in-edge end). */
  to: string
  /** Edge kind. `flow` (default) is a primary dependency rendered
   *  solid. `support` is a secondary / cross-cluster dep rendered
   *  dashed so it visually defers to the primary flow. */
  kind?: 'flow' | 'support'
}

export interface RootAgent {
  title: string
  status: 'running' | 'completed' | 'failed' | 'idle'
  phase: string
  goal: string
  model?: string
  nodeCount: number
  completedCount: number
}

/** A checkpoint hangs off its owning node and gates that node's
 *  completion (the runtime blocks `node.status -> completed` while a
 *  checkpoint is still `pending` or `failed`). Rendered as a small
 *  satellite chip docked below the node card so the user can see "this
 *  node has a manual confirmation gate" at a glance. */
export interface CanvasCheckpoint {
  id: string
  nodeId: string
  label: string
  status: 'pending' | 'passed' | 'failed' | 'skipped'
  reason?: string
}

interface WorkflowCanvasProps {
  root?: RootAgent
  nodes: Node[]
  edges: CanvasEdge[]
  checkpoints?: CanvasCheckpoint[]
  selectedNodeId: string | null
  onNodeSelect: (id: string) => void
  onNodeOpen?: (id: string) => void
  onRootClick?: () => void
}

/* ── Layout constants — keep in sync with `.wf-r2-node` CSS. The
 * layout engine reads NODE_W/H to compute edge endpoints and the
 * total canvas viewport size. */
const NODE_W = 200
const NODE_H = 70
const COL_GAP = 88
const ROW_GAP = 28

/* ── Layered DAG layout ──
 *
 * Returns each node augmented with `{x, y, col, row}` positions plus
 * the bounding box `(width, height)` for the SVG/edges layer. Designed
 * for read-only DAGs of up to ~100 nodes — for bigger graphs we'd
 * want a proper sweep algorithm (barycenter / median) but the simple
 * avg-parent-row sort below covers our current workflow scale and
 * stays linear-ish in node count. */
type Positioned = Node & { x: number; y: number; col: number; row: number }

function layoutGraph(nodes: Node[], edges: CanvasEdge[]): {
  positioned: Positioned[]
  width: number
  height: number
} {
  if (nodes.length === 0) {
    return { positioned: [], width: 0, height: 0 }
  }
  const inDeg = new Map<string, number>()
  const outAdj = new Map<string, string[]>()
  const inAdj = new Map<string, string[]>()
  for (const n of nodes) {
    inDeg.set(n.id, 0)
    outAdj.set(n.id, [])
    inAdj.set(n.id, [])
  }
  for (const e of edges) {
    if (!inDeg.has(e.to) || !outAdj.has(e.from)) continue
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1)
    outAdj.get(e.from)!.push(e.to)
    inAdj.get(e.to)!.push(e.from)
  }

  // Kahn's topological pass — assign each node a column equal to the
  // longest path length from any root. This guarantees parents are
  // always to the left of children.
  const col = new Map<string, number>()
  const indeg = new Map(inDeg)
  const queue: string[] = []
  for (const n of nodes) {
    if ((indeg.get(n.id) ?? 0) === 0) {
      queue.push(n.id)
      col.set(n.id, 0)
    }
  }
  while (queue.length > 0) {
    const id = queue.shift()!
    const c = col.get(id) ?? 0
    for (const next of outAdj.get(id) ?? []) {
      const nc = c + 1
      if ((col.get(next) ?? -1) < nc) col.set(next, nc)
      const d = (indeg.get(next) ?? 0) - 1
      indeg.set(next, d)
      if (d === 0) queue.push(next)
    }
  }
  // Cycle remnants (shouldn't happen in a DAG but be defensive) →
  // park at column 0 so we don't crash the render.
  for (const n of nodes) if (!col.has(n.id)) col.set(n.id, 0)

  // Group by column so we can lay nodes out within a column.
  const byCol = new Map<number, string[]>()
  for (const n of nodes) {
    const c = col.get(n.id) ?? 0
    const arr = byCol.get(c) ?? []
    arr.push(n.id)
    byCol.set(c, arr)
  }

  // Within-column row assignment — sort by avg parent row. Nodes in
  // column 0 (roots) keep stable insertion order. Subsequent columns
  // sort children by where their parents sit, which keeps edges
  // mostly-horizontal and minimises crossings without a full sweep.
  const row = new Map<string, number>()
  const sortedCols = [...byCol.keys()].sort((a, b) => a - b)
  for (const c of sortedCols) {
    const ids = byCol.get(c)!
    if (c === 0) {
      ids.forEach((id, i) => row.set(id, i))
      continue
    }
    const scored = ids.map((id) => {
      const parents = inAdj.get(id) ?? []
      // Only count parents from earlier columns (skip backedges).
      const scores = parents
        .filter((p) => (col.get(p) ?? 0) < c)
        .map((p) => row.get(p) ?? 0)
      const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 999
      return { id, avg }
    })
    // Stable sort by parent-row average.
    scored.sort((a, b) => a.avg - b.avg)
    scored.forEach((it, i) => row.set(it.id, i))
  }

  // Final {x, y} pass.
  const positioned: Positioned[] = nodes.map((n) => {
    const c = col.get(n.id) ?? 0
    const r = row.get(n.id) ?? 0
    return {
      ...n,
      col: c,
      row: r,
      x: c * (NODE_W + COL_GAP),
      y: r * (NODE_H + ROW_GAP),
    }
  })

  const maxCol = positioned.reduce((m, p) => Math.max(m, p.col), 0)
  const maxRow = positioned.reduce((m, p) => Math.max(m, p.row), 0)
  const width = (maxCol + 1) * NODE_W + maxCol * COL_GAP
  const height = (maxRow + 1) * NODE_H + maxRow * ROW_GAP

  return { positioned, width, height }
}

/* Smooth horizontal bezier from source.right → target.left. Mirrors
 * the design template — control points sit at the midpoint x with
 * the source/target y, giving a clean S-curve that stays axis-aligned
 * at both endpoints (so it looks like it "docks" into the cards). */
function bezierPath(a: Positioned, b: Positioned): string {
  const ax = a.x + NODE_W
  const ay = a.y + NODE_H / 2
  const bx = b.x
  const by = b.y + NODE_H / 2
  const mx = (ax + bx) / 2
  return `M${ax} ${ay} C ${mx} ${ay}, ${mx} ${by}, ${bx} ${by}`
}

/* Active = the edge represents a transition that just fired or is
 * about to: source completed and target running, or source running
 * and target pending. Drives the accent-coloured flow overlay. */
function isEdgeActive(a: Positioned, b: Positioned): boolean {
  if (a.status === 'completed' && b.status === 'running') return true
  if (a.status === 'running' && b.status === 'pending') return true
  return false
}

/* ── Pan & zoom hook ── */
function useCanvas() {
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [animating, setAnimating] = useState(false)
  const dragging = useRef(false)
  const last = useRef({ x: 0, y: 0 })
  const moved = useRef(false)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (animating) return
    const target = e.target as HTMLElement
    if (target.closest('button, [role="button"], .wf-r2-controls, [data-wf-card], [data-wf-root]')) return
    dragging.current = true
    moved.current = false
    last.current = { x: e.clientX, y: e.clientY }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    e.preventDefault()
  }, [animating])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return
    const dx = e.clientX - last.current.x
    const dy = e.clientY - last.current.y
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved.current = true
    setOffset((prev) => ({ x: prev.x + dx, y: prev.y + dy }))
    last.current = { x: e.clientX, y: e.clientY }
  }, [])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (dragging.current) {
      dragging.current = false
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    }
  }, [])

  const onWheel = useCallback((e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const delta = -e.deltaY * 0.002
      setZoom((prev) => Math.min(1.5, Math.max(0.5, prev + delta)))
    } else {
      setOffset((prev) => ({ x: prev.x - e.deltaX, y: prev.y - e.deltaY }))
    }
  }, [])

  const reset = useCallback(() => {
    setAnimating(true)
    setOffset({ x: 0, y: 0 })
    setZoom(1)
    setTimeout(() => setAnimating(false), 500)
  }, [])
  const zoomIn = useCallback(() => setZoom((p) => Math.min(1.5, p + 0.1)), [])
  const zoomOut = useCallback(() => setZoom((p) => Math.max(0.5, p - 0.1)), [])

  const isPanned = offset.x !== 0 || offset.y !== 0 || zoom !== 1
  return { offset, zoom, animating, isPanned, moved, onPointerDown, onPointerMove, onPointerUp, onWheel, reset, zoomIn, zoomOut }
}

/* ── Root agent card (kept from previous design — sits above the
 * graph as the workflow's "owner" badge). Compact horizontal pill
 * showing title + phase + model + node progress. */
function RootAgentCard({
  root,
  nodeCount,
  onClick,
}: {
  root: RootAgent
  nodeCount: number
  onClick?: () => void
}) {
  const run = root.status === 'running'
  const done = root.status === 'completed'
  const fail = root.status === 'failed'
  const progress = root.nodeCount > 0 ? Math.round((root.completedCount / root.nodeCount) * 100) : 0
  return (
    <div
      data-wf-root=""
      className="wf-root-agent group"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onClick?.()
      }}
    >
      {run && <div className="wf-root-agent-glow" />}
      <div
        className="absolute inset-x-0 top-0 h-[2px] rounded-t-[inherit]"
        style={{
          background: run || done
            ? 'linear-gradient(90deg, transparent, var(--wf-ok), transparent)'
            : fail
              ? 'linear-gradient(90deg, transparent, var(--wf-bad), transparent)'
              : 'linear-gradient(90deg, transparent, var(--wf-line-strong), transparent)',
        }}
      />
      <div className="relative flex items-center gap-2.5" style={{ padding: '8px 12px' }}>
        <div className="wf-root-agent-icon">
          {run ? (
            <Spin size={14} tone="white" line={1.8} />
          ) : (
            <BrainCircuit className="h-[14px] w-[14px] text-white" strokeWidth={1.8} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[12px] font-bold tracking-[-0.02em] text-[var(--wf-ink)]">{root.title}</span>
            {run && (
              <span className="wf-root-agent-live">
                <Sparkles className="h-2 w-2" strokeWidth={2} />
                LIVE
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-[10px]">
            <span className="font-medium text-[var(--wf-ink-soft)]">{root.phase}</span>
            {root.model && (
              <>
                <span className="text-[var(--wf-line-strong)]">&middot;</span>
                <span className="font-mono text-[9.5px] text-[var(--wf-dim)]">{root.model}</span>
              </>
            )}
            <span className="text-[var(--wf-line-strong)]">&middot;</span>
            <span className="inline-flex items-center gap-1 text-[var(--wf-dim)]">
              <GitBranch className="h-2 w-2" strokeWidth={2} />
              {nodeCount}
            </span>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <div className="wf-root-agent-progress" style={{ width: 48 }}>
            <div className="wf-progress-fill" data-animated={run ? '' : undefined} style={{ width: `${progress}%` }} />
          </div>
          <span className="text-[9.5px] font-bold tabular-nums text-[var(--wf-dim)]">
            {root.completedCount}/{root.nodeCount}
          </span>
        </div>
      </div>
    </div>
  )
}

export function WorkflowCanvas({
  root,
  nodes,
  edges,
  checkpoints = [],
  selectedNodeId,
  onNodeSelect,
  onNodeOpen,
  onRootClick,
}: WorkflowCanvasProps) {
  const canvas = useCanvas()
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e: WheelEvent) => canvas.onWheel(e)
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [canvas.onWheel])

  const layout = useMemo(() => layoutGraph(nodes, edges), [nodes, edges])
  const positionedById = useMemo(() => {
    const m = new Map<string, Positioned>()
    for (const p of layout.positioned) m.set(p.id, p)
    return m
  }, [layout.positioned])

  // Group checkpoints by their owning node. The runtime model is 1:N
  // (one node can have multiple gate checkpoints), so we accumulate a
  // list rather than picking one. Order: pending/failed first so the
  // user's eye lands on the blockers; passed/skipped pile after.
  const checkpointsByNode = useMemo(() => {
    const m = new Map<string, CanvasCheckpoint[]>()
    for (const cp of checkpoints) {
      if (!m.has(cp.nodeId)) m.set(cp.nodeId, [])
      m.get(cp.nodeId)!.push(cp)
    }
    const rank = (s: CanvasCheckpoint['status']) =>
      s === 'failed' ? 0 : s === 'pending' ? 1 : s === 'passed' ? 2 : 3
    for (const arr of m.values()) arr.sort((a, b) => rank(a.status) - rank(b.status))
    return m
  }, [checkpoints])

  const zoomPct = Math.round(canvas.zoom * 100)
  const runningCount = nodes.filter((n) => n.status === 'running').length
  const doneCount = nodes.filter((n) => n.status === 'completed').length

  return (
    <div
      ref={containerRef}
      className="wf-r2-canvas"
      style={{ cursor: 'grab' }}
      onPointerDown={canvas.onPointerDown}
      onPointerMove={canvas.onPointerMove}
      onPointerUp={canvas.onPointerUp}
    >
      {/* Dotted grid background — design template uses a 28px
        * radial-dot grid that gives the canvas a "blueprint" feel
        * without being noisy. */}
      <div className="wf-r2-canvas-grid pointer-events-none absolute inset-0" />

      {/* HUD top-left — quick read of workflow state (running / done
        * counts, node total). Pointer-events allow clicking through
        * empty parts of the HUD. */}
      <div className="wf-r2-hud">
        <span className="wf-r2-chip">
          <span
            className={`wf-r2-dot wf-r2-dot--${runningCount > 0 ? 'run' : doneCount === nodes.length && nodes.length > 0 ? 'ok' : 'idle'}`}
          />
          {runningCount > 0
            ? `RUN · ${doneCount}/${nodes.length}`
            : nodes.length > 0 && doneCount === nodes.length
              ? `DONE · ${doneCount}/${nodes.length}`
              : `IDLE · ${doneCount}/${nodes.length}`}
        </span>
        <span className="wf-r2-chip">
          graph · {nodes.length} node{nodes.length === 1 ? '' : 's'} · {edges.length} edge{edges.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* Zoom controls top-right — design template positioning. */}
      <div className="wf-r2-controls">
        <button
          onClick={(e) => {
            e.stopPropagation()
            canvas.zoomOut()
          }}
          className="wf-r2-controls-btn"
          title="Zoom out"
          aria-label="Zoom out"
        >
          −
        </button>
        <span
          className="wf-r2-controls-pct"
          onClick={(e) => {
            e.stopPropagation()
            canvas.reset()
          }}
          title="Click to reset zoom to 100%"
          role="button"
          tabIndex={0}
        >
          {zoomPct}%
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation()
            canvas.zoomIn()
          }}
          className="wf-r2-controls-btn"
          title="Zoom in"
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation()
            canvas.reset()
          }}
          className={`wf-r2-controls-btn ${canvas.isPanned ? 'is-active' : ''}`}
          title="Fit / reset"
          aria-label="Fit"
        >
          <Locate className="h-3 w-3" strokeWidth={1.8} />
        </button>
      </div>

      {/* Pan/zoom transform wrapper. */}
      <div
        className="relative flex min-h-full w-full justify-center px-6 py-8"
        style={{
          transform: `translate(${canvas.offset.x}px, ${canvas.offset.y}px) scale(${canvas.zoom})`,
          transformOrigin: '50% 0%',
          transition: canvas.animating ? 'transform 450ms cubic-bezier(0.16, 1, 0.3, 1)' : 'none',
          willChange: 'transform',
        }}
      >
        <div className="flex flex-col items-center gap-6">
          {root && (
            <RootAgentCard root={root} nodeCount={nodes.length} onClick={onRootClick} />
          )}

          {/* Graph viewport — fixed-size layer that holds both the SVG
            * edges and the abs-positioned node cards. Width/height come
            * from the layered layout so the inner box matches content
            * exactly (the outer flex centers it horizontally). */}
          {nodes.length > 0 ? (
            <div
              className="wf-r2-graph"
              style={{
                width: layout.width,
                height: layout.height,
              }}
            >
              <svg
                className="wf-r2-edges"
                width={layout.width}
                height={layout.height}
                viewBox={`0 0 ${layout.width} ${layout.height}`}
              >
                <defs>
                  <marker id="wf-r2-arrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                    <path d="M1 1 L6 4 L1 7" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                  </marker>
                  <marker id="wf-r2-arrow-ac" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                    <path d="M1 1 L6 4 L1 7" fill="none" stroke="var(--wf-ok)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </marker>
                </defs>
                {edges.map((e, i) => {
                  const a = positionedById.get(e.from)
                  const b = positionedById.get(e.to)
                  if (!a || !b) return null
                  const d = bezierPath(a, b)
                  const active = isEdgeActive(a, b)
                  const support = e.kind === 'support'
                  return (
                    <g
                      key={`${e.from}->${e.to}-${i}`}
                      className={`wf-r2-edge ${support ? 'wf-r2-edge--support' : 'wf-r2-edge--flow'}${active ? ' is-active' : ''}`}
                    >
                      <path d={d} className="wf-r2-edge-base" markerEnd={active ? 'url(#wf-r2-arrow-ac)' : 'url(#wf-r2-arrow)'} />
                      {active && <path d={d} className="wf-r2-edge-flow" />}
                    </g>
                  )
                })}
              </svg>
              {layout.positioned.map((n) => {
                const cps = checkpointsByNode.get(n.id) ?? []
                return (
                  <div
                    key={n.id}
                    className="wf-r2-node-wrap"
                    style={{
                      position: 'absolute',
                      left: n.x,
                      top: n.y,
                      width: NODE_W,
                    }}
                  >
                    <WorkflowNode
                      {...n}
                      isSelected={selectedNodeId === n.id}
                      onClick={() => onNodeSelect(n.id)}
                      onDoubleClick={() => onNodeOpen?.(n.id)}
                      onArrowClick={() => onNodeOpen?.(n.id)}
                    />
                    {cps.length > 0 && (
                      <div className="wf-r2-cp-stack" aria-label="Checkpoints">
                        {cps.map((cp) => (
                          <div
                            key={cp.id}
                            className="wf-r2-cp-chip"
                            data-status={cp.status}
                            title={
                              (cp.reason ? `${cp.label} — ${cp.reason}` : cp.label) +
                              ` (${cp.status})`
                            }
                          >
                            <span className="wf-r2-cp-chip-dot" />
                            <span className="wf-r2-cp-chip-label">{cp.label}</span>
                            <span className="wf-r2-cp-chip-status">{cp.status}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="flex h-32 items-center justify-center text-[12px] text-[var(--wf-dim)]">
              Workflow graph is empty — confirm a plan to populate nodes.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
