import { Locale } from "@/util/locale"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import {
  WORKFLOW_LANES,
  useWorkflow,
  type WorkflowLane,
  type WorkflowNode,
  type WorkflowQuestion,
  type WorkflowSubtask,
  type WorkflowTask,
} from "@tui/context/workflow"
import { RGBA } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

type Mark = WorkflowQuestion & { sessionID: string }

type Pick =
  | { type: "node"; id: string }
  | { type: "question"; id: string }
  | { type: "subtask"; id: string }
  | { type: "task"; id: string }
  | { type: "summary"; id: string }

type QuestionSummary = {
  id: string
  mark: Mark
  ready: boolean
  todo: string
  update: string
  updates: string[]
  outcome: string
  subagent: string
}

type Row =
  | {
      kind: "question"
      y: number
      id: string
      mark: Mark
    }
  | {
      kind: "subtask"
      y: number
      id: string
      subtask: WorkflowSubtask
    }
  | {
      kind: "task"
      y: number
      id: string
      task: WorkflowTask
    }
  | {
      kind: "node"
      y: number
      id: string
      node: WorkflowNode
    }
  | {
      kind: "summary"
      y: number
      id: string
      summary: QuestionSummary
    }

type TaskDigest = {
  intent?: string
  actions: string[]
}

export function WorkflowView(props: {
  sessionID: string
  width: number
  onPause: () => void
  onAppend: () => void
  onRevise: () => void
  onFocusInput: () => void
}) {
  const { theme } = useTheme()
  const sync = useSync()
  const flow = useWorkflow()
  const [tick, setTick] = createSignal(0)
  const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>({})
  const [selected, setSelected] = createSignal<Pick>()
  const timer = setInterval(() => {
    setTick((value) => value + 1)
  }, 120)
  onCleanup(() => clearInterval(timer))

  const rootID = createMemo(() => {
    let current = props.sessionID
    while (true) {
      const session = sync.session.get(current)
      if (!session?.parentID) return current
      current = session.parentID
    }
  })

  const sessions = createMemo(() => {
    const root = rootID()
    const known = new Set<string>([root])
    let changed = true
    while (changed) {
      changed = false
      for (const session of sync.data.session) {
        if (!session.parentID) continue
        if (!known.has(session.parentID)) continue
        if (known.has(session.id)) continue
        known.add(session.id)
        changed = true
      }
    }
    return [...known].toSorted()
  })

  const nodes = createMemo(() => {
    return sessions()
      .flatMap((sessionID) => flow.nodes(sessionID))
      .toSorted((a, b) => {
        if (a.at === b.at && a.sessionID === b.sessionID) return a.seq - b.seq
        if (a.at === b.at) return a.sessionID.localeCompare(b.sessionID)
        return a.at - b.at
      })
  })

  const questions = createMemo(() => {
    return sessions()
      .flatMap((sessionID) => flow.questions(sessionID).map((item) => ({ ...item, sessionID })))
      .toSorted((a, b) => {
        if (a.at === b.at && a.sessionID === b.sessionID) return a.messageID.localeCompare(b.messageID)
        if (a.at === b.at) return a.sessionID.localeCompare(b.sessionID)
        return a.at - b.at
      })
  })

  const tasks = createMemo(() => {
    return sessions()
      .flatMap((sessionID) => flow.tasks(sessionID))
      .toSorted((a, b) => {
        if (a.at === b.at && a.sessionID === b.sessionID) return a.index - b.index
        if (a.at === b.at) return a.sessionID.localeCompare(b.sessionID)
        return a.at - b.at
      })
  })

  const taskMap = createMemo(() => {
    const map: Record<string, WorkflowTask> = {}
    for (const item of tasks()) map[item.id] = item
    return map
  })

  const taskStats = createMemo(() => {
    const map: Record<string, { total: number; running: number; wait: number; error: number }> = {}
    for (const node of nodes()) {
      if (!node.taskID) continue
      const row =
        map[node.taskID] ??
        (map[node.taskID] = {
          total: 0,
          running: 0,
          wait: 0,
          error: 0,
        })
      row.total += 1
      if (node.state === "running") row.running += 1
      if (node.state === "wait") row.wait += 1
      if (node.state === "error") row.error += 1
    }
    return map
  })

  const taskNodes = createMemo(() => {
    const map: Record<string, WorkflowNode[]> = {}
    for (const node of nodes()) {
      if (!node.taskID) continue
      if (!map[node.taskID]) map[node.taskID] = []
      map[node.taskID]!.push(node)
    }
    return map
  })

  const taskDigest = createMemo(() => {
    const map: Record<string, TaskDigest> = {}
    for (const task of tasks()) {
      const nodes = taskNodes()[task.id] ?? []
      let intent = ""
      const actions: string[] = []
      for (const node of nodes) {
        if (node.lane === "think") {
          const text = clean(node.detail)
          if (text) intent = text
          continue
        }
        if (node.lane !== "tool") continue
        const base = clean(node.detail)
        const action = base ? `${node.title}: ${base}` : node.title
        if (!actions.includes(action)) actions.push(action)
      }
      map[task.id] = {
        intent: intent || undefined,
        actions: actions.slice(-3),
      }
    }
    return map
  })

  const reasoning = createMemo(() => {
    const map: Record<string, string> = {}
    for (const sessionID of sessions()) {
      for (const message of sync.data.message[sessionID] ?? []) {
        for (const part of sync.data.part[message.id] ?? []) {
          if (part.type !== "reasoning") continue
          const text = part.text.replace(/\s+/g, " ").trim()
          if (!text) continue
          map[`${sessionID}:${part.id}`] = text
        }
      }
    }
    return map
  })

  const summaries = createMemo(() => {
    const marks = questions()
    const result: Record<string, QuestionSummary> = {}
    if (marks.length === 0) return result
    const textMap = reasoning()

    const markSession: Record<string, Mark[]> = {}
    for (const mark of marks) {
      if (!markSession[mark.sessionID]) markSession[mark.sessionID] = []
      markSession[mark.sessionID]!.push(mark)
    }

    const nodeSession: Record<string, WorkflowNode[]> = {}
    for (const node of nodes()) {
      if (!nodeSession[node.sessionID]) nodeSession[node.sessionID] = []
      nodeSession[node.sessionID]!.push(node)
    }

    const taskSession: Record<string, WorkflowTask[]> = {}
    for (const task of tasks()) {
      if (!taskSession[task.sessionID]) taskSession[task.sessionID] = []
      taskSession[task.sessionID]!.push(task)
    }

    for (const [sessionID, list] of Object.entries(markSession)) {
      const nodeList = nodeSession[sessionID] ?? []
      const taskList = taskSession[sessionID] ?? []
      for (let i = 0; i < list.length; i += 1) {
        const mark = list[i]!
        const next = list[i + 1]?.at ?? Number.POSITIVE_INFINITY
        const n1 = lower(nodeList, mark.at)
        const n2 = Number.isFinite(next) ? lower(nodeList, next) : nodeList.length
        const t1 = lower(taskList, mark.at)
        const t2 = Number.isFinite(next) ? lower(taskList, next) : taskList.length
        const nodePart = nodeList.slice(n1, n2)
        const taskPart = taskList.slice(t1, t2)

        let waits = 0
        let errors = 0
        let retries = 0
        let final = ""
        let subStart = 0
        let subDone = 0
        let subFailed = 0
        let turnDone = false
        let subtaskDone = false
        const updates: string[] = []

        for (const node of nodePart) {
          if (node.lane === "think") {
            const text =
              node.key.startsWith("think:") && textMap[`${node.sessionID}:${node.key.slice(6)}`]
                ? textMap[`${node.sessionID}:${node.key.slice(6)}`]!
                : clean(node.detail)
            if (text) updates.push(`${node.title}: ${text}`)
          }
          if (node.lane === "tool" && node.title === "Run subtask") {
            subStart += 1
            if (node.state === "done") subDone += 1
            if (node.state === "error") subFailed += 1
          }
          if (node.lane === "final") {
            final = node.title
            if (node.title === "Turn complete" || node.title === "Turn failed") turnDone = true
            if (node.state === "retry") retries += 1
            if (node.title === "Subagent done") {
              subDone += 1
              subtaskDone = true
            }
            if (node.title === "Subagent failed") {
              subFailed += 1
              subtaskDone = true
            }
          }
          if (node.state === "wait") waits += 1
          if (node.state === "error") errors += 1
        }

        const rev: Record<number, WorkflowTask[]> = {}
        for (const task of taskPart) {
          if (!rev[task.revision]) rev[task.revision] = []
          rev[task.revision]!.push(task)
        }
        const revs = Object.keys(rev)
          .map((item) => Number(item))
          .toSorted((a, b) => a - b)
        for (const item of revs) {
          const rows = (rev[item] ?? []).toSorted((a, b) => a.index - b.index)
          updates.push(`Todo update r${item}:`)
          for (const task of rows) updates.push(`- [${todoState(task.status)}] ${task.title}`)
        }

        const latest = revs.at(-1)
        const latestRows = latest === undefined ? [] : rev[latest] ?? []
        const done = latestRows.filter((item) => item.status === "completed").length
        const cancelled = latestRows.filter((item) => item.status === "cancelled").length
        const open = latestRows.filter((item) => item.status === "pending" || item.status === "in_progress").length
        const todo =
          latestRows.length === 0
            ? "Todo: none"
            : `Todo: ${latestRows.length} tasks · ${done} done · ${open} open${cancelled > 0 ? ` · ${cancelled} cancelled` : ""}`
        const update =
          updates.length === 0
            ? "Updates: none"
            : `Updates: ${updates.length} · ${short(updates[0]!, 28)}${updates.length > 1 ? ` (+${updates.length - 1})` : ""}`
        const outcome =
          final || errors > 0 || waits > 0 || retries > 0
            ? `Outcome: ${final || "in progress"}${errors > 0 ? ` · ${errors} error` : ""}${waits > 0 ? ` · ${waits} wait` : ""}${retries > 0 ? ` · ${retries} retry` : ""}`
            : "Outcome: in progress"
        const subagent =
          subStart === 0 && subDone === 0 && subFailed === 0
            ? "Subagent: none"
            : `Subagent: ${subStart} started · ${subDone} done · ${subFailed} failed`
        const session = sync.session.get(mark.sessionID)
        const child = !!flow.subtask(mark.sessionID) || !!session?.parentID
        const id = `${mark.sessionID}:${mark.messageID}`
        result[id] = {
          id,
          mark,
          ready: turnDone && subStart <= subDone + subFailed && (!child || subtaskDone),
          todo,
          update,
          updates,
          outcome,
          subagent,
        }
      }
    }

    return result
  })

  const stats = createMemo(() => {
    const result: Record<string, { total: number; running: number; wait: number; error: number }> = {}
    for (const item of nodes()) {
      const subtask = flow.subtask(item.sessionID)
      if (!subtask) continue
      const entry =
        result[item.sessionID] ??
        (result[item.sessionID] = {
          total: 0,
          running: 0,
          wait: 0,
          error: 0,
        })
      entry.total += 1
      if (item.state === "running") entry.running += 1
      if (item.state === "wait") entry.wait += 1
      if (item.state === "error") entry.error += 1
    }
    return result
  })

  const inner = createMemo(() => Math.max(56, props.width - 6))
  const overlap = createMemo(() => Math.max(3, Math.min(9, Math.floor(inner() / 10))))
  const nodeW = createMemo(() => {
    const raw = Math.floor((inner() + overlap() * (WORKFLOW_LANES.length - 1)) / WORKFLOW_LANES.length)
    const odd = raw % 2 === 0 ? raw - 1 : raw
    return Math.max(15, odd)
  })
  const laneStep = createMemo(() => Math.max(9, nodeW() - overlap()))
  const chartW = createMemo(() => Math.min(inner(), laneStep() * (WORKFLOW_LANES.length - 1) + nodeW()))
  const textW = createMemo(() => Math.max(6, nodeW() - 4))
  const headW = createMemo(() => Math.max(4, textW() - 2))
  const nodeH = 4
  const rowH = 7
  const questionH = 4
  const summaryH = 6
  const sectionH = 3
  const taskH = 5
  const topPad = 1

  function laneX(lane: WorkflowLane) {
    const index = WORKFLOW_LANES.indexOf(lane)
    return index * laneStep()
  }

  function laneCenter(lane: WorkflowLane) {
    return laneX(lane) + Math.floor((nodeW() - 1) / 2)
  }

  function short(input: string, size: number) {
    if (size <= 1) return "…"
    if (Bun.stringWidth(input) <= size) return input
    let out = ""
    for (const ch of input) {
      if (Bun.stringWidth(`${out}${ch}…`) > size) break
      out += ch
    }
    if (!out) return "…"
    return `${out}…`
  }

  function wrap(input: string, size: number, max: number) {
    const lines: string[] = []
    let rest = input.replace(/\s+/g, " ").trim()
    while (rest && lines.length < max) {
      if (Bun.stringWidth(rest) <= size) {
        lines.push(rest)
        rest = ""
        break
      }
      let cut = ""
      for (const ch of rest) {
        if (Bun.stringWidth(`${cut}${ch}`) > size) break
        cut += ch
      }
      if (!cut) break
      lines.push(cut)
      rest = rest.slice(cut.length).trimStart()
    }
    if (rest && lines.length > 0) {
      const last = lines[lines.length - 1]!
      lines[lines.length - 1] = short(last, size - 1)
    }
    return lines
  }

  function wrapAll(input: string, size: number) {
    const lines: string[] = []
    let rest = input.replace(/\s+/g, " ").trim()
    while (rest) {
      if (Bun.stringWidth(rest) <= size) {
        lines.push(rest)
        rest = ""
        continue
      }
      let cut = ""
      for (const ch of rest) {
        if (Bun.stringWidth(`${cut}${ch}`) > size) break
        cut += ch
      }
      if (!cut) break
      lines.push(cut)
      rest = rest.slice(cut.length).trimStart()
    }
    if (lines.length === 0) return [""]
    return lines
  }

  function clean(input?: string) {
    if (!input) return ""
    return input
      .replace(/\s·\s\d+(?:\.\d+)?s$/, "")
      .replace(/\s·\s\d+ms$/, "")
      .trim()
  }

  function lower<T extends { at: number }>(list: T[], at: number) {
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      if ((list[mid]?.at ?? 0) < at) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  function todoState(status: WorkflowTask["status"]) {
    if (status === "completed") return "done"
    if (status === "in_progress") return "running"
    if (status === "cancelled") return "cancelled"
    return "pending"
  }

  function hash(sessionID: string) {
    let value = 0
    for (const ch of sessionID) value = (value * 31 + ch.charCodeAt(0)) >>> 0
    return value
  }

  function sessionColor(sessionID: string) {
    const colors = [theme.primary, theme.secondary, theme.accent, theme.info, theme.warning, theme.success]
    return colors[hash(sessionID) % colors.length]
  }

  function sessionBadge(sessionID: string) {
    const subtask = flow.subtask(sessionID)
    if (subtask) {
      return {
        text: `SUB @${subtask.agent}`,
        fg: theme.info,
      }
    }
    if (sessionID === rootID()) {
      return {
        text: "MAIN",
        fg: theme.success,
      }
    }
    return {
      text: "THREAD",
      fg: theme.textMuted,
    }
  }

  function laneLabel(lane: WorkflowLane) {
    if (lane === "think") return "THINK"
    if (lane === "tool") return "TOOL"
    if (lane === "wait") return "WAIT"
    if (lane === "output") return "OUTPUT"
    return "FINAL"
  }

  function laneColor(item: WorkflowNode) {
    if (item.state === "error") return theme.error
    if (item.state === "wait") return theme.warning
    if (item.state === "retry") return theme.warning
    if (item.lane === "think") return theme.secondary
    if (item.lane === "tool") return theme.info
    if (item.lane === "wait") return theme.warning
    if (item.lane === "output") return theme.success
    return theme.textMuted
  }

  function tone(base: RGBA) {
    return RGBA.fromValues(base.r, base.g, base.b, 0.16)
  }

  function border(item: WorkflowNode) {
    const base = laneColor(item)
    if (item.state !== "running") return base
    return tick() % 2 === 0 ? base : theme.borderActive
  }

  function icon(item: WorkflowNode) {
    if (item.state === "running") return SPIN[tick() % SPIN.length] ?? "•"
    if (item.state === "done") return "✓"
    if (item.state === "wait") return "!"
    if (item.state === "error") return "✕"
    return "↻"
  }

  function draw(input: { width: number; chars: Record<number, string> }) {
    return Array.from({ length: input.width })
      .map((_, index) => input.chars[index] ?? " ")
      .join("")
      .slice(0, input.width)
  }

  const layout = createMemo(() => {
    const rows: Row[] = []
    const marks = questions()
    const list = nodes()
    const task = taskMap()
    const summary = summaries()
    const seen = new Set<string>()
    const summaryShown = new Set<string>()
    const active: Record<string, string> = {}
    let y = topPad
    let q = 0
    let lastTask = ""

    function flushSummary(id: string) {
      if (!id || summaryShown.has(id)) return
      const card = summary[id]
      if (!card) return
      if (!card.ready) return
      rows.push({
        kind: "summary",
        y,
        id: `${id}:summary`,
        summary: card,
      })
      y += summaryH
      summaryShown.add(id)
    }

    for (const node of list) {
      while (q < marks.length && marks[q] && marks[q].at <= node.at) {
        const item = marks[q]!
        const id = `${item.sessionID}:${item.messageID}`
        const prev = active[item.sessionID]
        if (prev && prev !== id) flushSummary(prev)
        rows.push({
          kind: "question",
          y,
          id,
          mark: item,
        })
        active[item.sessionID] = id
        y += questionH
        q += 1
      }

      const subtask = flow.subtask(node.sessionID)
      if (subtask) {
        if (!seen.has(subtask.sessionID)) {
          rows.push({
            kind: "subtask",
            y,
            id: subtask.sessionID,
            subtask,
          })
          y += sectionH
          seen.add(subtask.sessionID)
        }
        if (collapsed()[subtask.sessionID]) continue
      }

      const item = node.taskID ? task[node.taskID] : undefined
      if (item && item.id !== lastTask) {
        rows.push({
          kind: "task",
          y,
          id: item.id,
          task: item,
        })
        y += taskH
        lastTask = item.id
      }
      if (item && collapsed()[item.id]) continue

      rows.push({
        kind: "node",
        y,
        id: node.id,
        node,
      })
      y += rowH
    }

    while (q < marks.length && marks[q]) {
      const item = marks[q]!
      const id = `${item.sessionID}:${item.messageID}`
      const prev = active[item.sessionID]
      if (prev && prev !== id) flushSummary(prev)
      rows.push({
        kind: "question",
        y,
        id,
        mark: item,
      })
      active[item.sessionID] = id
      y += questionH
      q += 1
    }

    for (const id of Object.values(active).toSorted((a, b) => (summary[b]?.mark.at ?? 0) - (summary[a]?.mark.at ?? 0))) {
      flushSummary(id)
    }

    if (rows.length === 0) y += 3

    return {
      rows,
      height: y + 2,
    }
  })

  createEffect(() => {
    const list = tasks()
    if (list.length === 0) return
    setCollapsed((prev) => {
      const next = { ...prev }
      const open = new Set(
        list.filter((item) => item.status === "in_progress" || item.status === "pending").map((item) => item.id),
      )
      const dense = list.length > 4
      for (const item of list) {
        if (item.id in next) continue
        if (open.has(item.id)) {
          next[item.id] = false
          continue
        }
        next[item.id] = dense && item.status === "completed"
      }
      return next
    })
  })

  const nodeRows = createMemo(() => {
    return layout().rows.flatMap((row) => (row.kind === "node" ? [row] : []))
  })

  const questionRows = createMemo(() => {
    return layout().rows.flatMap((row) => (row.kind === "question" ? [row] : []))
  })

  const summaryRows = createMemo(() => {
    return layout().rows.flatMap((row) => (row.kind === "summary" ? [row] : []))
  })

  const subtaskRows = createMemo(() => {
    return layout().rows.flatMap((row) => (row.kind === "subtask" ? [row] : []))
  })

  const taskRows = createMemo(() => {
    return layout().rows.flatMap((row) => (row.kind === "task" ? [row] : []))
  })

  const links = createMemo(() => {
    const rows = layout().rows
    const result: { y: number; text: string }[] = []
    let prev: Extract<Row, { kind: "node" }> | undefined

    for (const row of rows) {
      if (row.kind !== "node") {
        prev = undefined
        continue
      }

      if (!prev) {
        prev = row
        continue
      }

      const from = laneCenter(prev.node.lane)
      const to = laneCenter(row.node.lane)
      result.push({
        y: row.y - 2,
        text: draw({
          width: chartW(),
          chars: {
            [from]: "│",
          },
        }),
      })

      if (from === to) {
        result.push({
          y: row.y - 1,
          text: draw({
            width: chartW(),
            chars: {
              [to]: "↓",
            },
          }),
        })
        prev = row
        continue
      }

      const start = Math.min(from, to)
      const end = Math.max(from, to)
      const chars: Record<number, string> = {}
      for (let cursor = start; cursor <= end; cursor += 1) {
        chars[cursor] = "─"
      }
      chars[from] = from < to ? "└" : "┘"
      chars[to] = from < to ? "→" : "←"
      result.push({
        y: row.y - 1,
        text: draw({
          width: chartW(),
          chars,
        }),
      })

      prev = row
    }

    return result
  })

  createEffect(() => {
    const rows = nodeRows()
    if (rows.length === 0) {
      setSelected(undefined)
      return
    }
    const current = selected()
    if (!current) return
    if (current.type !== "node") return
    if (rows.some((row) => row.id === current.id)) return
    setSelected({
      type: "node",
      id: rows.at(-1)!.id,
    })
  })

  const selectedNode = createMemo(() => {
    const current = selected()
    if (current?.type !== "node") return
    return nodeRows().find((row) => row.id === current.id)?.node
  })

  const selectedQuestion = createMemo(() => {
    const current = selected()
    if (current?.type !== "question") return
    return questionRows().find((row) => row.id === current.id)?.mark
  })

  const selectedSummary = createMemo(() => {
    const current = selected()
    if (current?.type !== "summary") return
    return summaryRows().find((row) => row.id === current.id)?.summary
  })

  const selectedSubtask = createMemo(() => {
    const current = selected()
    if (current?.type !== "subtask") return
    return subtaskRows().find((row) => row.id === current.id)?.subtask
  })

  const selectedTask = createMemo(() => {
    const current = selected()
    if (current?.type !== "task") return
    return taskRows().find((row) => row.id === current.id)?.task
  })

  function pick(next: Pick) {
    const current = selected()
    if (current?.type === next.type && current.id === next.id) {
      setSelected(undefined)
      props.onFocusInput()
      return
    }
    setSelected(next)
    props.onFocusInput()
  }

  function findPart(sessionID: string, partID: string) {
    const messages = sync.data.message[sessionID] ?? []
    for (const message of messages) {
      const found = (sync.data.part[message.id] ?? []).find((part) => part.id === partID)
      if (found) return found
    }
    return undefined
  }

  const detail = createMemo(() => {
    const node = selectedNode()
    if (!node) return undefined

    const key = node.key
    const partID = key.startsWith("tool:") ? key.slice(5) : key.startsWith("think:") ? key.slice(6) : undefined
    const part = partID ? findPart(node.sessionID, partID) : undefined
    const session = sessionBadge(node.sessionID)

    const result = {
      title: `${laneLabel(node.lane)} · ${node.title}`,
      lines: [
        `State: ${node.state}`,
        `Session: ${session.text} · ${node.sessionID.slice(0, 8)}`,
        `Time: ${Locale.time(node.at)}`,
      ],
    }

    if (node.taskTitle) result.lines.push(`Task: ${node.taskTitle}`)

    if (node.lane === "think") {
      if (part?.type === "reasoning" && part.text.trim()) {
        const text = part.text.replace(/\s+/g, " ").trim()
        result.lines.push("Reasoning:")
        for (const line of wrap(text, Math.max(18, props.width - 12), 6)) {
          result.lines.push(line)
        }
      } else if (node.detail) {
        result.lines.push(`Summary: ${clean(node.detail)}`)
      }
      return result
    }

    if (node.lane === "tool" && part?.type === "tool") {
      const input = JSON.stringify(part.state.input)
      result.lines.push(`Tool: ${part.tool}`)
      result.lines.push(`Input: ${short(input, 72)}`)
      if (part.state.status === "error") result.lines.push(`Error: ${short(String(part.state.error), 72)}`)
      return result
    }

    if (key.startsWith("output:") || key.startsWith("final:")) {
      const messageID = key.split(":")[1]
      const info = (sync.data.message[node.sessionID] ?? []).find((item) => item.id === messageID)
      if (info) {
        result.lines.push(`Agent: ${info.agent}`)
        if (info.role === "assistant") result.lines.push(`Model: ${info.providerID}/${info.modelID}`)
      }
      return result
    }

    if (part) {
      result.lines.push(`Part: ${part.type}`)
    }

    return result
  })

  function sectionStatus(sessionID: string) {
    const item = stats()[sessionID]
    if (!item) return { icon: "•", fg: theme.textMuted }
    if (item.error > 0) return { icon: "✕", fg: theme.error }
    if (item.running > 0) return { icon: SPIN[tick() % SPIN.length] ?? "•", fg: theme.info }
    if (item.wait > 0) return { icon: "!", fg: theme.warning }
    return { icon: "✓", fg: theme.success }
  }

  function taskStatus(task: WorkflowTask) {
    const stat = taskStats()[task.id]
    if (task.status === "completed") return { icon: "✓", fg: theme.success }
    if (task.status === "cancelled") return { icon: "✕", fg: theme.textMuted }
    if (task.status === "pending") return { icon: "•", fg: theme.textMuted }
    if (stat?.error && stat.error > 0) return { icon: "✕", fg: theme.error }
    if (stat?.wait && stat.wait > 0) return { icon: "!", fg: theme.warning }
    if (stat?.running && stat.running > 0) return { icon: SPIN[tick() % SPIN.length] ?? "•", fg: theme.info }
    return { icon: SPIN[tick() % SPIN.length] ?? "•", fg: theme.info }
  }

  return (
    <box
      width={props.width}
      height="100%"
      backgroundColor={theme.backgroundPanel}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      gap={1}
    >
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text}>
          <b>Workflow</b>
        </text>
        <box flexDirection="row" gap={1}>
          <text fg={theme.warning} onMouseUp={props.onPause}>
            Pause
          </text>
          <text fg={theme.text} onMouseUp={props.onAppend}>
            Prompt
          </text>
          <text fg={theme.accent} onMouseUp={props.onRevise}>
            Plan
          </text>
        </box>
      </box>

      <scrollbox
        flexGrow={1}
        focusable={false}
        stickyScroll={true}
        stickyStart="bottom"
        verticalScrollbarOptions={{
          trackOptions: {
            backgroundColor: theme.background,
            foregroundColor: theme.borderActive,
          },
        }}
      >
        <box minHeight={layout().height} width={chartW()} position="relative">
          <For each={links()}>
            {(line) => (
              <text position="absolute" top={line.y} left={0} fg={theme.borderSubtle}>
                {line.text}
              </text>
            )}
          </For>

          <For each={questionRows()}>
            {(row) => {
              const badge = sessionBadge(row.mark.sessionID)
              const isSelected = () => selected()?.type === "question" && selected()?.id === row.id
              return (
                <box
                  position="absolute"
                  top={row.y}
                  left={0}
                  width={chartW()}
                  height={questionH}
                  border={["top", "bottom", "left", "right"]}
                  borderColor={isSelected() ? theme.borderActive : theme.borderSubtle}
                  backgroundColor={theme.backgroundElement}
                  paddingLeft={1}
                  paddingRight={1}
                  overflow="hidden"
                  onMouseUp={() => {
                    pick({
                      type: "question",
                      id: row.id,
                    })
                  }}
                >
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={theme.textMuted}>Question</text>
                    <box flexDirection="row" gap={1}>
                      <text fg={badge.fg}>{badge.text}</text>
                      <text fg={sessionColor(row.mark.sessionID)}>{short(Locale.time(row.mark.at), 10)}</text>
                    </box>
                  </box>
                  <text fg={theme.text}>{short(row.mark.text, Math.max(12, chartW() - 4))}</text>
                </box>
              )
            }}
          </For>

          <For each={summaryRows()}>
            {(row) => {
              const badge = sessionBadge(row.summary.mark.sessionID)
              const isSelected = () => selected()?.type === "summary" && selected()?.id === row.id
              return (
                <box
                  position="absolute"
                  top={row.y}
                  left={0}
                  width={chartW()}
                  height={summaryH}
                  border={["top", "bottom", "left", "right"]}
                  borderColor={isSelected() ? theme.borderActive : theme.borderSubtle}
                  backgroundColor={RGBA.fromValues(theme.success.r, theme.success.g, theme.success.b, 0.1)}
                  paddingLeft={1}
                  paddingRight={1}
                  overflow="hidden"
                  onMouseUp={() => {
                    pick({
                      type: "summary",
                      id: row.id,
                    })
                  }}
                >
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={theme.success}>Summary</text>
                    <text fg={badge.fg}>{badge.text}</text>
                  </box>
                  <text fg={theme.textMuted}>{short(row.summary.todo, Math.max(12, chartW() - 4))}</text>
                  <text fg={theme.textMuted}>{short(row.summary.update, Math.max(12, chartW() - 4))}</text>
                  <text fg={theme.textMuted}>{short(row.summary.outcome, Math.max(12, chartW() - 4))}</text>
                  <text fg={theme.textMuted}>{short(row.summary.subagent, Math.max(12, chartW() - 4))}</text>
                </box>
              )
            }}
          </For>

          <For each={subtaskRows()}>
            {(row) => {
              const st = sectionStatus(row.subtask.sessionID)
              const folded = () => !!collapsed()[row.subtask.sessionID]
              const count = () => stats()[row.subtask.sessionID]?.total ?? 0
              const isSelected = () => selected()?.type === "subtask" && selected()?.id === row.id
              return (
                <box
                  position="absolute"
                  top={row.y}
                  left={0}
                  width={chartW()}
                  height={sectionH}
                  border={["top", "bottom", "left", "right"]}
                  borderColor={isSelected() ? theme.borderActive : theme.borderSubtle}
                  backgroundColor={RGBA.fromValues(theme.info.r, theme.info.g, theme.info.b, 0.12)}
                  paddingLeft={1}
                  paddingRight={1}
                  overflow="hidden"
                  onMouseUp={() => {
                    setCollapsed((prev) => ({
                      ...prev,
                      [row.subtask.sessionID]: !prev[row.subtask.sessionID],
                    }))
                    pick({
                      type: "subtask",
                      id: row.id,
                    })
                  }}
                >
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={theme.info}>
                      {folded() ? "▶" : "▼"} Subtask @{row.subtask.agent} · {short(row.subtask.title, Math.max(8, chartW() - 28))}
                    </text>
                    <text fg={st.fg}>
                      {st.icon} {count()}
                    </text>
                  </box>
                </box>
              )
            }}
          </For>

          <For each={taskRows()}>
            {(row) => {
              const st = taskStatus(row.task)
              const folded = () => !!collapsed()[row.task.id]
              const count = () => taskStats()[row.task.id]?.total ?? 0
              const digest = () => taskDigest()[row.task.id]
              const intent = () => digest()?.intent ?? "working on this task"
              const actions = () => {
                const list = digest()?.actions ?? []
                if (list.length === 0) return "Actions: no tool activity yet"
                return `Actions: ${list.map((item) => short(item, 24)).join(" · ")}`
              }
              const isSelected = () => selected()?.type === "task" && selected()?.id === row.id
              return (
                <box
                  position="absolute"
                  top={row.y}
                  left={0}
                  width={chartW()}
                  height={taskH}
                  border={["top", "bottom", "left", "right"]}
                  borderColor={isSelected() ? theme.borderActive : theme.borderSubtle}
                  backgroundColor={RGBA.fromValues(theme.secondary.r, theme.secondary.g, theme.secondary.b, 0.1)}
                  paddingLeft={1}
                  paddingRight={1}
                  overflow="hidden"
                  onMouseUp={() => {
                    setCollapsed((prev) => ({
                      ...prev,
                      [row.task.id]: !prev[row.task.id],
                    }))
                    pick({
                      type: "task",
                      id: row.id,
                    })
                  }}
                >
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={theme.secondary}>
                      {folded() ? "▶" : "▼"} Task {row.task.index} · {short(row.task.title, Math.max(8, chartW() - 28))}
                    </text>
                    <text fg={st.fg}>
                      {st.icon} {count()}
                    </text>
                  </box>
                  <text fg={theme.textMuted}>{short(`Intent: ${intent()}`, Math.max(8, chartW() - 4))}</text>
                  <text fg={theme.textMuted}>{short(actions(), Math.max(8, chartW() - 4))}</text>
                </box>
              )
            }}
          </For>

          <For each={nodeRows()}>
            {(row) => {
              const x = laneX(row.node.lane)
              const edge = border(row.node)
              const fill = tone(laneColor(row.node))
              const isSelected = () => selected()?.type === "node" && selected()?.id === row.id
              return (
                <box
                  position="absolute"
                  top={row.y}
                  left={x}
                  width={nodeW()}
                  height={nodeH}
                  border={["top", "bottom", "left", "right"]}
                  borderColor={isSelected() ? theme.borderActive : edge}
                  backgroundColor={fill}
                  paddingLeft={1}
                  paddingRight={1}
                  overflow="hidden"
                  onMouseUp={() => {
                    pick({
                      type: "node",
                      id: row.id,
                    })
                  }}
                >
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={edge}>{short(laneLabel(row.node.lane), headW())}</text>
                    <text fg={edge}>{icon(row.node)}</text>
                  </box>
                  <text fg={theme.text}>{short(row.node.title, textW())}</text>
                  <text fg={theme.textMuted}>{short(row.node.detail ?? row.node.state, textW())}</text>
                </box>
              )
            }}
          </For>

          <For each={nodeRows()}>
            {(row) => {
              const y = row.y + nodeH
              const x = laneX(row.node.lane)
              return (
                <text position="absolute" top={y} left={x} fg={sessionColor(row.node.sessionID)}>
                  {short(`${Locale.time(row.node.at)} ${row.node.sessionID.slice(0, 6)}`, textW())}
                </text>
              )
            }}
          </For>

          <For each={nodeRows()}>
            {(row, idx) => {
              if (idx() !== nodeRows().length - 1) return <></>
              if (row.node.state !== "wait") return <></>
              return (
                <text position="absolute" top={row.y + nodeH + 1} left={laneX(row.node.lane)} fg={theme.warning}>
                  {short("Waiting for user action", textW())}
                </text>
              )
            }}
          </For>
        </box>
      </scrollbox>

      <Show when={selected()}>
        <box
          border={["top", "bottom", "left", "right"]}
          borderColor={theme.borderSubtle}
          backgroundColor={theme.backgroundElement}
          height={13}
          paddingLeft={1}
          paddingRight={1}
          overflow="hidden"
        >
          <text fg={theme.textMuted}>Details</text>
          <scrollbox
            flexGrow={1}
            focusable={false}
            verticalScrollbarOptions={{
              trackOptions: {
                backgroundColor: theme.backgroundElement,
                foregroundColor: theme.borderSubtle,
              },
            }}
          >
            <box flexDirection="column">
              <Switch>
                <Match when={detail()}>
                  {(value) => (
                    <>
                      <text fg={theme.text}>{short(value().title, Math.max(12, props.width - 8))}</text>
                      <For each={value().lines}>
                        {(line) => <text fg={theme.textMuted}>{short(line, Math.max(12, props.width - 8))}</text>}
                      </For>
                    </>
                  )}
                </Match>
                <Match when={selectedQuestion()}>
                  {(value) => {
                    const badge = sessionBadge(value().sessionID)
                    return (
                      <>
                        <text fg={badge.fg}>Question · {badge.text}</text>
                        <text fg={theme.text}>{short(value().text, Math.max(12, props.width - 8))}</text>
                        <text fg={theme.textMuted}>
                          Session {value().sessionID.slice(0, 8)} · {Locale.time(value().at)}
                        </text>
                      </>
                    )
                  }}
                </Match>
                <Match when={selectedSummary()}>
                  {(value) => {
                    const badge = sessionBadge(value().mark.sessionID)
                    const width = Math.max(12, props.width - 8)
                    return (
                      <>
                        <text fg={badge.fg}>Question Summary · {badge.text}</text>
                        <text fg={theme.textMuted}>
                          Session {value().mark.sessionID.slice(0, 8)} · {Locale.time(value().mark.at)}
                        </text>
                        <text fg={theme.textMuted}>{value().todo}</text>
                        <text fg={theme.textMuted}>{value().outcome}</text>
                        <text fg={theme.textMuted}>{value().subagent}</text>
                        <text fg={theme.textMuted}>Updates:</text>
                        <Show when={value().updates.length === 0}>
                          <text fg={theme.textMuted}>none</text>
                        </Show>
                        <For each={value().updates}>
                          {(line) => (
                            <For each={wrapAll(line, width)}>
                              {(segment) => <text fg={theme.textMuted}>{segment}</text>}
                            </For>
                          )}
                        </For>
                      </>
                    )
                  }}
                </Match>
                <Match when={selectedTask()}>
                  {(value) => {
                    const st = taskStatus(value())
                    const cnt = taskStats()[value().id]?.total ?? 0
                    const digest = taskDigest()[value().id]
                    return (
                      <>
                        <text fg={theme.secondary}>
                          Task {value().index} · {st.icon}
                        </text>
                        <text fg={theme.text}>{short(value().title, Math.max(12, props.width - 8))}</text>
                        <text fg={theme.textMuted}>
                          {value().kind.toUpperCase()} · {value().status} · {cnt} node{cnt === 1 ? "" : "s"}
                        </text>
                        <text fg={theme.textMuted}>
                          Session {value().sessionID.slice(0, 8)} · Rev {value().revision}
                        </text>
                        <Show when={digest?.intent}>
                          <text fg={theme.textMuted}>{short(`Intent: ${digest?.intent ?? ""}`, Math.max(12, props.width - 8))}</text>
                        </Show>
                        <Show when={(digest?.actions.length ?? 0) > 0}>
                          <text fg={theme.textMuted}>
                            {short(`Actions: ${(digest?.actions ?? []).join(" · ")}`, Math.max(12, props.width - 8))}
                          </text>
                        </Show>
                      </>
                    )
                  }}
                </Match>
                <Match when={selectedSubtask()}>
                  {(value) => {
                    const st = sectionStatus(value().sessionID)
                    const count = stats()[value().sessionID]?.total ?? 0
                    return (
                      <>
                        <text fg={theme.info}>
                          Subtask @{value().agent} · {st.icon}
                        </text>
                        <text fg={theme.text}>{short(value().title, Math.max(12, props.width - 8))}</text>
                        <text fg={theme.textMuted}>Session {value().sessionID.slice(0, 8)} · Parent {value().parentID.slice(0, 8)}</text>
                        <text fg={theme.textMuted}>{count} workflow node{count === 1 ? "" : "s"}</text>
                      </>
                    )
                  }}
                </Match>
              </Switch>
            </box>
          </scrollbox>
        </box>
      </Show>
    </box>
  )
}
