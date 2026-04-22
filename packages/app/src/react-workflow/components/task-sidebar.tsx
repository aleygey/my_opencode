/** @jsxImportSource react */
import { useCallback, useEffect, useState } from 'react'
import {
  X, Plus, Check, ChevronDown, Code2, Cpu, FlaskConical, Rocket, BrainCircuit,
  Clock, Sparkles, Trash2, Bell, BellOff, Pin,
} from 'lucide-react'
import { Spin } from './spin'

type NodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'paused'
type NodeType = 'coding' | 'build-flash' | 'debug' | 'deploy' | 'plan'

interface TaskNode {
  id: string
  title: string
  type: NodeType
  status: NodeStatus
  session: string
}

export interface Task {
  id: string
  title: string
  status: 'running' | 'completed' | 'failed' | 'idle' | 'paused' | 'interrupted'
  nodes: TaskNode[]
  startedAt?: string
  duration?: string
}

interface TaskSidebarProps {
  open: boolean
  tasks: Task[]
  activeTaskId?: string
  activeNodeId?: string
  onClose: () => void
  onSelectTask?: (taskId: string) => void
  onSelectNode: (nodeId: string) => void
  onOpenNode?: (nodeId: string) => void
  onNewTask?: () => void
  onDeleteTask?: (taskId: string) => void
}

const typeIcons: Record<NodeType, React.ElementType> = {
  coding: Code2,
  'build-flash': Cpu,
  debug: FlaskConical,
  deploy: Rocket,
  plan: BrainCircuit,
}

const typeColors: Record<NodeType, string> = {
  coding: '#7578c5',
  'build-flash': '#c9943e',
  debug: '#6088c1',
  deploy: '#4d9e8a',
  plan: '#8b6ad9',
}

const statusAccent: Record<NodeStatus, string> = {
  pending: 'var(--wf-line-strong)',
  running: 'var(--wf-ok)',
  completed: 'var(--wf-ok)',
  failed: 'var(--wf-bad)',
  paused: 'var(--wf-warn)',
}

/* ── Mini status dot ── */
function StatusDot({ status }: { status: NodeStatus }) {
  if (status === 'running') return <Spin size={10} tone="var(--wf-ok)" line={1.5} />
  if (status === 'completed') return <Check className="h-2.5 w-2.5 text-[var(--wf-ok)]" strokeWidth={3} />

  return (
    <div className={`h-[5px] w-[5px] rounded-full ${
      status === 'failed' ? 'bg-[var(--wf-bad)]' :
      status === 'paused' ? 'bg-[var(--wf-warn)]' :
      'bg-[var(--wf-dim)] opacity-40'
    }`} />
  )
}

/* ── Notification permission button ── */
function NotificationToggle() {
  const [perm, setPerm] = useState<NotificationPermission>(
    typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'denied'
  )

  const toggle = useCallback(async () => {
    if (!('Notification' in window)) return
    if (perm === 'granted') {
      // Can't revoke programmatically, show hint
      return
    }
    const result = await Notification.requestPermission()
    setPerm(result)
  }, [perm])

  const granted = perm === 'granted'

  return (
    <button
      onClick={toggle}
      className="wf-sidebar-notify-btn"
      title={granted ? 'Notifications enabled' : 'Enable notifications'}
    >
      {granted ? (
        <Bell className="h-3 w-3" strokeWidth={2} />
      ) : (
        <BellOff className="h-3 w-3" strokeWidth={2} />
      )}
    </button>
  )
}

/* ── Delete confirmation overlay ── */
function DeleteOverlay({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="wf-sidebar-delete-overlay wf-fade-in">
      <Trash2 className="h-3.5 w-3.5 text-[var(--wf-bad)]" strokeWidth={2} />
      <span className="text-[11px] font-semibold text-[var(--wf-bad)]">Delete?</span>
      <div className="flex items-center gap-1.5">
        <button onClick={onConfirm} className="wf-sidebar-delete-confirm">Yes</button>
        <button onClick={onCancel} className="wf-sidebar-delete-cancel">No</button>
      </div>
    </div>
  )
}

/* ── Collapsible task card ── */
function TaskCard({
  task, activeTaskId, activeNodeId, defaultOpen, onSelectTask, onSelectNode, onOpenNode, onDelete,
}: {
  task: Task
  activeTaskId?: string
  activeNodeId?: string
  defaultOpen?: boolean
  onSelectTask?: (taskId: string) => void
  onSelectNode: (nodeId: string) => void
  onOpenNode?: (nodeId: string) => void
  onDelete?: (taskId: string) => void
}) {
  const [expanded, setExpanded] = useState(defaultOpen ?? false)
  const [showDelete, setShowDelete] = useState(false)
  const active = activeTaskId === task.id
  const run = task.status === 'running'
  const done = task.status === 'completed'
  const fail = task.status === 'failed'
  const pause = task.status === 'paused' || task.status === 'interrupted'
  const canDelete = true
  const completedCount = task.nodes.filter(n => n.status === 'completed').length
  const progress = task.nodes.length > 0 ? Math.round((completedCount / task.nodes.length) * 100) : 0

  useEffect(() => {
    if (active) setExpanded(true)
  }, [active])

  return (
    <div className={`wf-sidebar-task ${showDelete ? 'wf-sidebar-task--deleting' : ''}`}>
      {/* Delete confirmation overlay */}
      {showDelete && (
        <DeleteOverlay
          onConfirm={() => { onDelete?.(task.id); setShowDelete(false) }}
          onCancel={() => setShowDelete(false)}
        />
      )}

      {/* Task header (toggle) */}
      <button
        className={`wf-sidebar-task-header group ${active ? 'bg-[var(--wf-chip)]' : ''}`}
        onClick={() => {
          onSelectTask?.(task.id)
          setExpanded(v => active ? !v : true)
        }}
      >
        {/* Left accent */}
        <div
          className={`wf-sidebar-task-accent ${run ? 'wf-pulse' : ''}`}
          style={{
            background: run ? 'var(--wf-ok)' : done ? 'var(--wf-ok)' : fail ? 'var(--wf-bad)' : pause ? 'var(--wf-warn)' : 'var(--wf-line-strong)',
          }}
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {/* Pinned indicator for running tasks */}
            {run && (
              <Pin className="h-2.5 w-2.5 flex-shrink-0 text-[var(--wf-ok)]" strokeWidth={2.5} />
            )}
            <span className="truncate text-[12px] font-semibold tracking-[-0.01em] text-[var(--wf-ink)]">{task.title}</span>
            {run && (
              <span className="wf-sidebar-live-badge">
                <Sparkles className="h-2 w-2" strokeWidth={2.5} />
              </span>
            )}
          </div>

          {/* Meta row */}
          <div className="mt-1 flex items-center gap-2 text-[10px]">
            <span className="font-medium tabular-nums text-[var(--wf-dim)]">
              {completedCount}/{task.nodes.length} nodes
            </span>
            {task.duration && (
              <>
                <span className="text-[var(--wf-line-strong)]">&middot;</span>
                <span className="inline-flex items-center gap-1 text-[var(--wf-dim)]">
                  <Clock className="h-2.5 w-2.5" strokeWidth={1.8} />
                  {task.duration}
                </span>
              </>
            )}
          </div>

          {/* Progress track */}
          {run && (
            <div className="mt-2 flex items-center gap-2">
              <div className="wf-sidebar-progress-track">
                <div
                  className="wf-progress-fill"
                  data-animated=""
                  style={{ width: `${progress}%` }}
                />
              </div>
              <span className="text-[9px] font-bold tabular-nums text-[var(--wf-ok)]">{progress}%</span>
            </div>
          )}
        </div>

        {/* Action buttons on hover */}
        <div className="flex items-center gap-1">
          {/* Delete button — only for finished tasks */}
          {canDelete && (
            <div
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); setShowDelete(true) }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setShowDelete(true) } }}
              className="wf-sidebar-task-action opacity-0 group-hover:opacity-100"
              title="Delete task"
            >
              <Trash2 className="h-3 w-3" strokeWidth={2} />
            </div>
          )}

          {/* Chevron */}
          <ChevronDown
            className={`h-3 w-3 flex-shrink-0 text-[var(--wf-dim)] transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
            strokeWidth={2}
          />
        </div>
      </button>

      {/* Expandable node list */}
      {expanded && (
        <div className="wf-sidebar-node-list">
          {/* Tree line */}
          <div className="wf-sidebar-tree-line" />

          {task.nodes.map((node, i) => {
            const Icon = typeIcons[node.type]
            const color = typeColors[node.type]
            const isActive = activeNodeId === node.id
            const isLast = i === task.nodes.length - 1

            return (
              <div key={node.id} className="wf-sidebar-node-row wf-slide-up" style={{ animationDelay: `${i * 40}ms` }}>
                {/* Branch connector */}
                <div className="wf-sidebar-branch">
                  <svg width="12" height="100%" viewBox="0 0 12 32" fill="none" preserveAspectRatio="none">
                    {!isLast && <line x1="0" y1="0" x2="0" y2="32" stroke="var(--wf-line-strong)" strokeWidth="1" />}
                    <path d="M0,16 Q0,16 6,16 L12,16" stroke="var(--wf-line-strong)" strokeWidth="1" fill="none" />
                  </svg>
                </div>

                <button
                  className={`wf-sidebar-node ${isActive ? 'wf-sidebar-node--active' : ''}`}
                  style={{ borderLeftColor: statusAccent[node.status] }}
                  onClick={() => onSelectNode(node.id)}
                  onDoubleClick={() => onOpenNode?.(node.id)}
                >
                  <div
                    className="wf-sidebar-node-icon"
                    style={{ background: `${color}0d`, color }}
                  >
                    <Icon className="h-3 w-3" strokeWidth={1.8} />
                  </div>

                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] font-medium text-[var(--wf-ink)]">{node.title}</span>
                    <span className="mt-px block text-[9.5px] font-medium capitalize text-[var(--wf-dim)]">{node.type.replace('-', ' ')}</span>
                  </div>

                  <StatusDot status={node.status} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ── Sort tasks: running first, then paused/interrupted, then idle, then completed/failed ── */
function sortTasks(tasks: Task[]): Task[] {
  const order: Record<string, number> = { running: 0, paused: 1, interrupted: 1, idle: 2, completed: 3, failed: 3 }
  return [...tasks].sort((a, b) => (order[a.status] ?? 4) - (order[b.status] ?? 4))
}

/* ── Main sidebar ── */
export function TaskSidebar({
  open,
  tasks,
  activeTaskId,
  activeNodeId,
  onClose,
  onSelectTask,
  onSelectNode,
  onOpenNode,
  onNewTask,
  onDeleteTask,
}: TaskSidebarProps) {
  if (!open) return null

  const sorted = sortTasks(tasks)
  const runningCount = tasks.filter(t => t.status === 'running').length
  const finishedCount = tasks.filter(
    (t) => t.status === 'completed' || t.status === 'failed' || t.status === 'paused' || t.status === 'interrupted',
  ).length

  return (
    // Stacking: lives inside .workflow-make (isolation: isolate), above the
    // canvas/chat/inspector columns. Each of those columns is also isolated
    // (`.wf-canvas`, `.wf-chat-root`, `.wf-inspector-root` each set
    // `isolation: isolate`), so their internal z-indices (chat header z:70,
    // open agent z:80, model dropdown z:90) stay contained. That makes a
    // modest z:30 on this overlay enough to sit above all of them. The
    // scrim fills the container; the panel slides in as a child.
    <div className="absolute inset-0 z-30 flex">
      {/* Scrim — staggered fade with soft blur */}
      <div className="wf-sidebar-scrim" onClick={onClose} />

      {/* Panel — slides in after scrim settles */}
      <div className="wf-sidebar wf-sidebar-enter">
        {/* Header */}
        <div className="wf-sidebar-header">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-bold tracking-[-0.01em] text-[var(--wf-ink)]">Tasks</span>
            <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--wf-chip)] px-1.5 text-[10px] font-bold tabular-nums text-[var(--wf-dim)]">
              {tasks.length}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <NotificationToggle />
            <button
              onClick={onClose}
              className="wf-sidebar-close"
              aria-label="Close"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          </div>
        </div>

        {/* Status summary strip */}
        <div className="wf-sidebar-status-strip">
          {runningCount > 0 && (
            <div className="wf-sidebar-status-tag wf-sidebar-status-tag--running">
              <Spin size={8} tone="var(--wf-ok)" line={1} />
              <span>{runningCount} running</span>
            </div>
          )}
          {finishedCount > 0 && (
            <div className="wf-sidebar-status-tag wf-sidebar-status-tag--finished">
              <Check className="h-2.5 w-2.5" strokeWidth={2.5} />
              <span>{finishedCount} finished</span>
            </div>
          )}
        </div>

        {/* New task button */}
        <div className="wf-sidebar-new-task">
          <button onClick={onNewTask} className="wf-sidebar-new-btn">
            <Plus className="h-3.5 w-3.5" strokeWidth={2.2} />
            <span>New Task</span>
          </button>
        </div>

        {/* Task list */}
        <div className="wf-sidebar-body">
          {tasks.length === 0 && (
            <div className="flex h-32 flex-col items-center justify-center gap-2">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-dashed border-[var(--wf-line-strong)] bg-[var(--wf-chip)]">
                <span className="text-[14px] text-[var(--wf-dim)]">0</span>
              </div>
              <span className="text-[11px] font-medium text-[var(--wf-dim)]">No tasks yet</span>
            </div>
          )}

          {sorted.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              activeTaskId={activeTaskId}
              activeNodeId={activeNodeId}
              defaultOpen={task.id === activeTaskId}
              onSelectTask={onSelectTask}
              onSelectNode={onSelectNode}
              onOpenNode={onOpenNode}
              onDelete={onDeleteTask}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
