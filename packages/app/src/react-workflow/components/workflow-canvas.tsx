/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState } from 'react'
import { BrainCircuit, ChevronDown, GitBranch, Locate, Sparkles } from 'lucide-react'
import { WorkflowNode, type NodeStatus, type NodeType } from './workflow-node'
import { Spin } from './spin'

interface Node {
  id: string
  title: string
  type: NodeType
  status: NodeStatus
  session: string
  progress?: number
  summary?: string[]
  stale?: boolean
}

interface CanvasChain {
  id: string
  label: string
  color?: string
  nodes: Node[]
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

interface WorkflowCanvasProps {
  root?: RootAgent
  chains: CanvasChain[]
  /** Optional merge-tail node — rendered after the lanes with a converging
   * connector. Surfaced when the underlying graph fans multiple lanes back
   * into a single follow-up node (e.g. plan → [build, test, lint] → deploy).
   * Without this, sibling lanes ended mid-air with no visual cue that they
   * actually re-converge in the workflow logic. */
  tail?: Node
  selectedNodeId: string | null
  onNodeSelect: (id: string) => void
  onNodeOpen?: (id: string) => void
  onRootClick?: () => void
}

/* Lane accent colors */
const laneColors = [
  { accent: '#7578c5', soft: 'rgba(117, 120, 197, 0.08)', label: 'rgba(117, 120, 197, 0.6)' },
  { accent: '#4d9e8a', soft: 'rgba(77, 158, 138, 0.08)', label: 'rgba(77, 158, 138, 0.6)' },
  { accent: '#c9943e', soft: 'rgba(201, 148, 62, 0.08)', label: 'rgba(201, 148, 62, 0.6)' },
  { accent: '#c06e96', soft: 'rgba(192, 110, 150, 0.08)', label: 'rgba(192, 110, 150, 0.6)' },
  { accent: '#6088c1', soft: 'rgba(96, 136, 193, 0.08)', label: 'rgba(96, 136, 193, 0.6)' },
]

/* ── Pan & zoom hook with animated reset ── */
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
    // Don't start drag if clicking on interactive elements
    if (target.closest('button, [role="button"], .wf-canvas-controls, .wf-lane-header')) return
    if (e.button === 1 || (e.button === 0 && target.closest('[data-wf-card], [data-wf-root]') === null)) {
      dragging.current = true
      moved.current = false
      last.current = { x: e.clientX, y: e.clientY }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      e.preventDefault()
    }
  }, [animating])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return
    const dx = e.clientX - last.current.x
    const dy = e.clientY - last.current.y
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved.current = true
    setOffset(prev => ({ x: prev.x + dx, y: prev.y + dy }))
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
      setZoom(prev => Math.min(1.5, Math.max(0.5, prev + delta)))
    } else {
      setOffset(prev => ({
        x: prev.x - e.deltaX,
        y: prev.y - e.deltaY,
      }))
    }
  }, [])

  // Animated smooth reset — CSS transition handles the interpolation
  const reset = useCallback(() => {
    setAnimating(true)
    setOffset({ x: 0, y: 0 })
    setZoom(1)
    // Clear animating flag after transition completes
    setTimeout(() => setAnimating(false), 500)
  }, [])

  const isPanned = offset.x !== 0 || offset.y !== 0 || zoom !== 1

  return { offset, zoom, animating, isPanned, moved, onPointerDown, onPointerMove, onPointerUp, onWheel, reset }
}

/* ── Animated edge line (subtle S-curve bezier, vertical) ──
 *
 * A straight rule looks too rigid between cards, so we draw a gentle
 * cubic-bezier from top to bottom that bows out slightly. The path stays
 * axis-aligned at its endpoints (so it looks like it "enters" each card
 * cleanly), while the middle pinches in a hand-drawn wobble. When the edge
 * is inactive (not yet reached), we draw the same path dashed.
 */
function EdgeLine({ active, flowing, height = 32, glow = false }: { active: boolean; flowing: boolean; height?: number; glow?: boolean }) {
  const sw = active ? 2 : 1
  // Straight vertical line between two cards in a single chain. We used to
  // draw a subtle S-curve here (cubic bezier with control points pulled off
  // axis), but the curve made the connector look unstable and — when paired
  // with the animateMotion particles — rendered the travelling dots visibly
  // off-centre, giving the impression of a stray floating node beside the
  // card. Branch topology (multiple children) is handled by `BranchConnector`
  // below with orthogonal straight lines; curves are not needed here.
  const cx = 3
  const path = `M${cx},0 L${cx},${height}`

  return (
    <div className="wf-edge" style={{ height }}>
      <svg width="6" height="100%" viewBox={`0 0 6 ${height}`} preserveAspectRatio="none" fill="none">
        {active && glow && (
          <path d={path} stroke="var(--wf-ok)" strokeWidth="4" opacity="0.08" fill="none" />
        )}
        <path d={path}
          stroke={active ? 'var(--wf-ok)' : 'var(--wf-line-strong)'}
          strokeWidth={sw}
          strokeDasharray={active ? 'none' : '4 5'}
          strokeLinecap="round"
          fill="none" />
      </svg>
      {flowing && (
        <svg className="absolute inset-0 pointer-events-none" width="6" height="100%" viewBox={`0 0 6 ${height}`} preserveAspectRatio="none" fill="none">
          <path d={path} stroke="var(--wf-ok)" strokeWidth="6" opacity="0.06" fill="none" />
          <circle r="2.5" fill="var(--wf-ok)" opacity="0.9">
            <animateMotion dur="1.2s" repeatCount="indefinite" path={path} />
          </circle>
          <circle r="5" fill="var(--wf-ok)" opacity="0.15">
            <animateMotion dur="1.2s" repeatCount="indefinite" path={path} />
          </circle>
        </svg>
      )}
    </div>
  )
}

/* ── Root agent orchestrator card ── */
function RootAgentCard({ root, chainCount, onClick }: { root: RootAgent; chainCount: number; onClick?: () => void }) {
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
      onKeyDown={(e) => { if (e.key === 'Enter') onClick?.() }}
    >
      {/* Running state: a static halo (not pulsing) — motion already conveyed
       * by the Spin spinner, the LIVE badge, and the animated progress bar.
       * Stacking a pulsing glow on top of those made the card feel restless. */}
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
              {chainCount}
            </span>
          </div>
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          <div className="wf-root-agent-progress" style={{ width: 48 }}>
            <div
              className="wf-progress-fill"
              data-animated={run ? '' : undefined}
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-[9.5px] font-bold tabular-nums text-[var(--wf-dim)]">
            {root.completedCount}/{root.nodeCount}
          </span>
        </div>
      </div>
    </div>
  )
}

/* ── Branch connector: root → multiple lanes (layout-aligned) ── */
function BranchConnector({ count, status }: { count: number; status: 'running' | 'completed' | 'failed' | 'idle' }) {
  const active = status === 'running' || status === 'completed'
  const flowing = status === 'running'
  const dropsRef = useRef<HTMLDivElement>(null)
  const [barGeom, setBarGeom] = useState<{ left: number; width: number; centers: number[] } | null>(null)

  // Measure the actual flex-laid-out drop positions to draw a perfectly aligned horizontal bar
  useEffect(() => {
    const el = dropsRef.current
    if (!el || count < 2) return
    const measure = () => {
      const items = Array.from(el.querySelectorAll<HTMLElement>('.wf-branch-drop'))
      if (items.length < 2) return
      const parentRect = el.getBoundingClientRect()
      const centers = items.map(item => item.getBoundingClientRect().left + item.getBoundingClientRect().width / 2 - parentRect.left)
      setBarGeom({ left: centers[0], width: centers[centers.length - 1] - centers[0], centers })
    }
    measure()
    const obs = new ResizeObserver(measure)
    obs.observe(el)
    return () => obs.disconnect()
  }, [count])

  if (count <= 1) {
    return <EdgeLine active={active} flowing={flowing} height={40} glow={flowing} />
  }

  const trunkH = 28
  const dropH = 24
  const stroke = active ? 'var(--wf-ok)' : 'var(--wf-line-strong)'
  const sw = active ? 2 : 1
  const dashStyle = active ? 'none' : '4 5'

  return (
    <div className="wf-branch-system">
      {/* ① Vertical trunk from root center */}
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <div className="wf-edge" style={{ height: trunkH }}>
          <svg width="6" height={trunkH} fill="none">
            {active && <line x1="3" y1="0" x2="3" y2={trunkH} stroke="var(--wf-ok)" strokeWidth="4" opacity="0.06" />}
            <line x1="3" y1="0" x2="3" y2={trunkH} stroke={stroke} strokeWidth={sw} strokeDasharray={dashStyle} strokeLinecap="round" />
          </svg>
          {flowing && (
            <svg className="absolute inset-0 pointer-events-none" width="6" height={trunkH} fill="none">
              <circle r="2.5" fill="var(--wf-ok)" opacity="0.85">
                <animateMotion dur="0.7s" repeatCount="indefinite" path={`M3,0 L3,${trunkH}`} />
              </circle>
              <circle r="5" fill="var(--wf-ok)" opacity="0.12">
                <animateMotion dur="0.7s" repeatCount="indefinite" path={`M3,0 L3,${trunkH}`} />
              </circle>
            </svg>
          )}
        </div>
      </div>

      {/* ② Junction diamond at the branch point */}
      <div style={{ display: 'flex', justifyContent: 'center', height: 0, position: 'relative', zIndex: 3 }}>
        <div className={`wf-junction-diamond ${flowing ? 'wf-junction-diamond--active' : ''}`}
          style={{
            width: 10, height: 10,
            background: active ? 'var(--wf-ok)' : 'var(--wf-line-strong)',
            transform: 'translateY(-5px) rotate(45deg)',
            borderRadius: 2,
            boxShadow: active ? '0 0 10px rgba(77,158,138,0.35), 0 0 20px rgba(77,158,138,0.12)' : 'none',
          }}
        />
      </div>

      {/* ③ Horizontal bar + vertical drops — uses SAME flex layout as .wf-lanes */}
      <div ref={dropsRef} className="wf-branch-drops" style={{ display: 'flex', gap: 16, position: 'relative' }}>
        {/* Measured horizontal crossbar */}
        {barGeom && (
          <>
            {/* Glow behind bar */}
            {active && (
              <div style={{
                position: 'absolute', top: -1, zIndex: 1,
                left: barGeom.left - 1, width: barGeom.width + 2, height: 4,
                background: 'var(--wf-ok)', opacity: 0.06, borderRadius: 2,
              }} />
            )}
            {/* The bar itself */}
            <svg style={{
              position: 'absolute', top: 0, left: barGeom.left, zIndex: 2,
              width: barGeom.width, height: 2, overflow: 'visible',
            }} fill="none">
              <line x1="0" y1="1" x2={barGeom.width} y2="1"
                stroke={stroke} strokeWidth={sw} strokeDasharray={dashStyle} strokeLinecap="round" />
              {/* Horizontal flowing particle */}
              {flowing && (
                <>
                  <circle r="2.5" fill="var(--wf-ok)" opacity="0.85">
                    <animateMotion dur="1s" repeatCount="indefinite" path={`M0,1 L${barGeom.width},1`} />
                  </circle>
                  <circle r="5" fill="var(--wf-ok)" opacity="0.12">
                    <animateMotion dur="1s" repeatCount="indefinite" path={`M0,1 L${barGeom.width},1`} />
                  </circle>
                </>
              )}
            </svg>
            {/* Endpoint dots at each branch drop */}
            {barGeom.centers.map((cx, i) => (
              <div key={`dot-${i}`} style={{
                position: 'absolute', top: -3, left: cx - 3.5, zIndex: 3,
                width: 7, height: 7, borderRadius: '50%',
                background: active ? 'var(--wf-ok)' : 'var(--wf-line-strong)',
                boxShadow: active ? '0 0 8px rgba(77,158,138,0.35)' : 'none',
                transition: 'box-shadow 0.3s ease',
              }} />
            ))}
          </>
        )}

        {/* Per-lane vertical drops — flex:1 matches .wf-lane flex:1 */}
        {Array.from({ length: count }).map((_, i) => (
          <div key={i} className="wf-branch-drop" style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
            <div className="wf-edge" style={{ height: dropH }}>
              <svg width="6" height={dropH} fill="none">
                {active && <line x1="3" y1="0" x2="3" y2={dropH} stroke="var(--wf-ok)" strokeWidth="4" opacity="0.06" />}
                <line x1="3" y1="0" x2="3" y2={dropH} stroke={stroke} strokeWidth={sw} strokeDasharray={dashStyle} strokeLinecap="round" />
              </svg>
              {flowing && (
                <svg className="absolute inset-0 pointer-events-none" width="6" height={dropH} fill="none">
                  <circle r="2" fill="var(--wf-ok)" opacity="0.8">
                    <animateMotion dur="0.5s" repeatCount="indefinite" begin={`${0.6 + i * 0.2}s`} path={`M3,0 L3,${dropH}`} />
                  </circle>
                  <circle r="4" fill="var(--wf-ok)" opacity="0.1">
                    <animateMotion dur="0.5s" repeatCount="indefinite" begin={`${0.6 + i * 0.2}s`} path={`M3,0 L3,${dropH}`} />
                  </circle>
                </svg>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ── Merge connector: multiple lanes → one tail node (mirror of BranchConnector) ── */
function MergeConnector({ count, status }: { count: number; status: NodeStatus }) {
  const active = status === 'completed' || status === 'running'
  const flowing = status === 'running'
  const upsRef = useRef<HTMLDivElement>(null)
  const [barGeom, setBarGeom] = useState<{ left: number; width: number; centers: number[] } | null>(null)

  useEffect(() => {
    const el = upsRef.current
    if (!el || count < 2) return
    const measure = () => {
      const items = Array.from(el.querySelectorAll<HTMLElement>('.wf-branch-drop'))
      if (items.length < 2) return
      const parentRect = el.getBoundingClientRect()
      const centers = items.map((item) => item.getBoundingClientRect().left + item.getBoundingClientRect().width / 2 - parentRect.left)
      setBarGeom({ left: centers[0], width: centers[centers.length - 1] - centers[0], centers })
    }
    measure()
    const obs = new ResizeObserver(measure)
    obs.observe(el)
    return () => obs.disconnect()
  }, [count])

  if (count <= 1) {
    return <EdgeLine active={active} flowing={flowing} height={40} glow={flowing} />
  }

  const upH = 24
  const trunkH = 28
  const stroke = active ? 'var(--wf-ok)' : 'var(--wf-line-strong)'
  const sw = active ? 2 : 1
  const dashStyle = active ? 'none' : '4 5'

  return (
    <div className="wf-branch-system">
      {/* ① Per-lane vertical drops going UP from each lane tail (visually identical
            to BranchConnector ③ but rendered first so the geometry funnels in). */}
      <div ref={upsRef} className="wf-branch-drops" style={{ display: 'flex', gap: 16, position: 'relative' }}>
        {barGeom && (
          <>
            {active && (
              <div
                style={{
                  position: 'absolute',
                  bottom: -1,
                  zIndex: 1,
                  left: barGeom.left - 1,
                  width: barGeom.width + 2,
                  height: 4,
                  background: 'var(--wf-ok)',
                  opacity: 0.06,
                  borderRadius: 2,
                }}
              />
            )}
            <svg
              style={{
                position: 'absolute',
                bottom: 0,
                left: barGeom.left,
                zIndex: 2,
                width: barGeom.width,
                height: 2,
                overflow: 'visible',
              }}
              fill="none"
            >
              <line
                x1="0"
                y1="1"
                x2={barGeom.width}
                y2="1"
                stroke={stroke}
                strokeWidth={sw}
                strokeDasharray={dashStyle}
                strokeLinecap="round"
              />
              {flowing && (
                <>
                  <circle r="2.5" fill="var(--wf-ok)" opacity="0.85">
                    <animateMotion dur="1s" repeatCount="indefinite" path={`M0,1 L${barGeom.width},1`} />
                  </circle>
                </>
              )}
            </svg>
            {barGeom.centers.map((cx, i) => (
              <div
                key={`mdot-${i}`}
                style={{
                  position: 'absolute',
                  bottom: -3,
                  left: cx - 3.5,
                  zIndex: 3,
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: active ? 'var(--wf-ok)' : 'var(--wf-line-strong)',
                  boxShadow: active ? '0 0 8px rgba(77,158,138,0.35)' : 'none',
                  transition: 'box-shadow 0.3s ease',
                }}
              />
            ))}
          </>
        )}
        {Array.from({ length: count }).map((_, i) => (
          <div key={i} className="wf-branch-drop" style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
            <div className="wf-edge" style={{ height: upH }}>
              <svg width="6" height={upH} fill="none">
                {active && <line x1="3" y1="0" x2="3" y2={upH} stroke="var(--wf-ok)" strokeWidth="4" opacity="0.06" />}
                <line
                  x1="3"
                  y1="0"
                  x2="3"
                  y2={upH}
                  stroke={stroke}
                  strokeWidth={sw}
                  strokeDasharray={dashStyle}
                  strokeLinecap="round"
                />
              </svg>
              {flowing && (
                <svg className="absolute inset-0 pointer-events-none" width="6" height={upH} fill="none">
                  <circle r="2" fill="var(--wf-ok)" opacity="0.8">
                    <animateMotion dur="0.5s" repeatCount="indefinite" path={`M3,${upH} L3,0`} />
                  </circle>
                </svg>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* ② Junction diamond at the merge point. */}
      <div style={{ display: 'flex', justifyContent: 'center', height: 0, position: 'relative', zIndex: 3 }}>
        <div
          className={`wf-junction-diamond ${flowing ? 'wf-junction-diamond--active' : ''}`}
          style={{
            width: 10,
            height: 10,
            background: active ? 'var(--wf-ok)' : 'var(--wf-line-strong)',
            transform: 'translateY(-5px) rotate(45deg)',
            borderRadius: 2,
            boxShadow: active ? '0 0 10px rgba(77,158,138,0.35), 0 0 20px rgba(77,158,138,0.12)' : 'none',
          }}
        />
      </div>

      {/* ③ Vertical trunk from junction down to the tail node. */}
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <div className="wf-edge" style={{ height: trunkH, position: 'relative' }}>
          <svg width="6" height={trunkH} fill="none">
            {active && <line x1="3" y1="0" x2="3" y2={trunkH} stroke="var(--wf-ok)" strokeWidth="4" opacity="0.06" />}
            <line
              x1="3"
              y1="0"
              x2="3"
              y2={trunkH}
              stroke={stroke}
              strokeWidth={sw}
              strokeDasharray={dashStyle}
              strokeLinecap="round"
            />
          </svg>
          {flowing && (
            <svg className="absolute inset-0 pointer-events-none" width="6" height={trunkH} fill="none">
              <circle r="2.5" fill="var(--wf-ok)" opacity="0.85">
                <animateMotion dur="0.7s" repeatCount="indefinite" path={`M3,0 L3,${trunkH}`} />
              </circle>
            </svg>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── Connector between sub-nodes ── */
function Connector({ from, to }: { from: NodeStatus; to: NodeStatus }) {
  const done = from === 'completed'
  const flowing = from === 'completed' && to === 'running'

  return (
    <EdgeLine active={done} flowing={flowing} height={32} glow={flowing} />
  )
}

/* ── Single lane of nodes (collapsible) ── */
function ChainLane({
  chain,
  colorIdx,
  selectedNodeId,
  onNodeSelect,
  onNodeOpen,
  isOnly,
}: {
  chain: CanvasChain
  colorIdx: number
  selectedNodeId: string | null
  onNodeSelect: (id: string) => void
  onNodeOpen?: (id: string) => void
  isOnly: boolean
}) {
  const [collapsed, setCollapsed] = useState(false)
  const color = laneColors[colorIdx % laneColors.length]
  const completedCount = chain.nodes.filter(n => n.status === 'completed').length
  const runningCount = chain.nodes.filter(n => n.status === 'running').length

  return (
    <div className={`wf-lane ${isOnly ? 'wf-lane--single' : ''}`}>
      {/* Lane header — clickable to toggle collapse */}
      {!isOnly && (
        <button
          className="wf-lane-header wf-slide-up"
          onClick={() => setCollapsed(v => !v)}
        >
          <div className="wf-lane-dot" style={{ background: color.accent }} />
          <span className="wf-lane-label">{chain.label}</span>
          <span className="wf-lane-count">
            {completedCount}/{chain.nodes.length}
          </span>
          {runningCount > 0 && (
            <Spin size={10} tone={color.accent} line={1.5} />
          )}
          <ChevronDown
            className="wf-lane-chevron"
            style={{ transform: collapsed ? 'rotate(-90deg)' : undefined }}
            strokeWidth={2}
          />
        </button>
      )}

      {/* Nodes — collapsible */}
      {!collapsed && (
        <>
          {chain.nodes.map((node, i) => (
            <div
              key={node.id}
              className="wf-canvas-row wf-slide-up"
              style={{ animationDelay: `${(i + 1) * 70}ms` }}
            >
              <WorkflowNode
                {...node}
                isSelected={selectedNodeId === node.id}
                onClick={() => onNodeSelect(node.id)}
                onDoubleClick={() => onNodeOpen?.(node.id)}
                onArrowClick={() => onNodeOpen?.(node.id)}
              />

              {i < chain.nodes.length - 1 && (
                <div className="wf-canvas-connector-wrap">
                  <Connector from={node.status} to={chain.nodes[i + 1].status} />
                </div>
              )}
            </div>
          ))}

          {chain.nodes.length === 0 && (
            <div className="flex h-24 items-center justify-center">
              <span className="text-[11px] text-[var(--wf-dim)]">No nodes</span>
            </div>
          )}
        </>
      )}

      {/* Collapsed summary */}
      {collapsed && (
        <div className="wf-lane-collapsed wf-fade-in">
          <div className="wf-lane-collapsed-bar" style={{ background: color.accent }} />
          <span className="wf-lane-collapsed-text">
            {completedCount}/{chain.nodes.length} completed
          </span>
          {runningCount > 0 && (
            <span className="wf-lane-collapsed-running" style={{ color: color.accent }}>
              {runningCount} running
            </span>
          )}
        </div>
      )}
    </div>
  )
}

export function WorkflowCanvas({ root, chains, tail, selectedNodeId, onNodeSelect, onNodeOpen, onRootClick }: WorkflowCanvasProps) {
  const canvas = useCanvas()
  const containerRef = useRef<HTMLDivElement>(null)
  const isMulti = chains.length > 1

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e: WheelEvent) => canvas.onWheel(e)
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [canvas.onWheel])

  const zoomPct = Math.round(canvas.zoom * 100)

  return (
    <div
      ref={containerRef}
      className="wf-canvas"
      style={{ cursor: 'grab' }}
      onPointerDown={canvas.onPointerDown}
      onPointerMove={canvas.onPointerMove}
      onPointerUp={canvas.onPointerUp}
    >
      {/* Background */}
      <div className="wf-canvas-grid pointer-events-none absolute inset-0" />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: [
            'radial-gradient(ellipse 700px 500px at 50% 35%, rgba(77, 158, 138, 0.04) 0%, transparent 70%)',
            'radial-gradient(ellipse 400px 300px at 30% 60%, rgba(117, 120, 197, 0.025) 0%, transparent 70%)',
          ].join(', '),
        }}
      />

      {/* Vignette — subtle fade so edges feel soft without eating real estate */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-[var(--wf-bg)] to-transparent z-[2]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-[var(--wf-bg)] to-transparent z-[2]" />
      <div className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-[var(--wf-bg)] to-transparent z-[2]" />
      <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-[var(--wf-bg)] to-transparent z-[2]" />

      {/* Pannable + zoomable content */}
      <div
        className="relative flex min-h-full w-full justify-center px-4 py-6"
        style={{
          transform: `translate(${canvas.offset.x}px, ${canvas.offset.y}px) scale(${canvas.zoom})`,
          transformOrigin: '50% 20%',
          transition: canvas.animating ? 'transform 450ms cubic-bezier(0.16, 1, 0.3, 1)' : 'none',
          willChange: 'transform',
        }}
      >
        <div className={isMulti ? 'w-full max-w-[760px]' : 'w-full max-w-[420px]'}>
          {/* Root agent orchestrator */}
          {root && (
            <>
              <RootAgentCard root={root} chainCount={chains.length} onClick={onRootClick} />
              <BranchConnector count={chains.length} status={root.status} />
            </>
          )}

          {/* Chain lanes */}
          {isMulti ? (
            <div className="wf-lanes">
              {chains.map((chain, i) => (
                <ChainLane
                  key={chain.id}
                  chain={chain}
                  colorIdx={i}
                  selectedNodeId={selectedNodeId}
                  onNodeSelect={onNodeSelect}
                  onNodeOpen={onNodeOpen}
                  isOnly={false}
                />
              ))}
            </div>
          ) : (
            chains[0] && (
              <ChainLane
                chain={chains[0]}
                colorIdx={0}
                selectedNodeId={selectedNodeId}
                onNodeSelect={onNodeSelect}
                onNodeOpen={onNodeOpen}
                isOnly={true}
              />
            )
          )}

          {/* Merge tail — single node downstream of all lanes (e.g. a "deploy"
              that depends on every parallel "build/test/lint" branch). When
              present, render a converging connector between the lanes and
              this card so the user can see the fan-in. */}
          {tail && isMulti && (
            <>
              <MergeConnector count={chains.length} status={tail.status} />
              <div className="wf-canvas-row wf-slide-up">
                <WorkflowNode
                  {...tail}
                  isSelected={selectedNodeId === tail.id}
                  onClick={() => onNodeSelect(tail.id)}
                  onDoubleClick={() => onNodeOpen?.(tail.id)}
                  onArrowClick={() => onNodeOpen?.(tail.id)}
                />
              </div>
            </>
          )}
        </div>
      </div>

      {/* Canvas controls — always visible */}
      <div className="wf-canvas-controls">
        {/* Zoom level */}
        <span className="text-[10px] font-bold tabular-nums text-[var(--wf-dim)]">{zoomPct}%</span>

        {/* Reset / Locate root button */}
        <button
          onClick={(e) => { e.stopPropagation(); canvas.reset() }}
          className={`wf-canvas-locate-btn ${canvas.isPanned ? 'wf-canvas-locate-btn--active' : ''}`}
          title="Center on root agent"
        >
          <Locate className="h-3.5 w-3.5" strokeWidth={1.8} />
        </button>
      </div>
    </div>
  )
}
