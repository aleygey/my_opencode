import type { Event, Part, ToolPart } from "@opencode-ai/sdk/v2"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"

const MAX = 1200
const MAX_QUESTIONS = 160
const MAX_SESSIONS = 48

export const WORKFLOW_LANES = ["think", "tool", "wait", "output", "final"] as const
export type WorkflowLane = (typeof WORKFLOW_LANES)[number]

export type WorkflowState = "running" | "done" | "wait" | "error" | "retry"

export type WorkflowNode = {
  id: string
  key: string
  seq: number
  at: number
  sessionID: string
  lane: WorkflowLane
  state: WorkflowState
  title: string
  detail?: string
  taskID?: string
  taskTitle?: string
  taskKind?: "todo"
}

export type WorkflowQuestion = {
  messageID: string
  at: number
  text: string
}

export type WorkflowSubtask = {
  sessionID: string
  parentID: string
  at: number
  agent: string
  title: string
  toolPartID: string
}

export type WorkflowTask = {
  id: string
  sessionID: string
  revision: number
  at: number
  kind: "todo"
  index: number
  title: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
  superseded?: boolean
}

type Runtime = {
  last: number
  seq: number
  index: Record<string, number>
  think: Record<string, string>
  tool: Record<string, string>
  output: Record<string, string>
  message_role: Record<string, string>
  question_mode: "plan" | "investigate" | "synthesize"
  user_time: Record<string, number>
  task_revision: number
  current_task?: string
  last_user_message?: string
  question?: string
}

function clip(input: string, size: number) {
  const text = input.replace(/\s+/g, " ").trim()
  if (text.length <= size) return text
  return `${text.slice(0, size - 1)}…`
}

function middle(input: string, size: number) {
  const text = input.replace(/\s+/g, " ").trim()
  if (text.length <= size) return text
  const keep = Math.max(4, Math.floor((size - 1) / 2))
  return `${text.slice(0, keep)}…${text.slice(-keep)}`
}

function ms(input: number) {
  if (input < 1000) return `${input}ms`
  return `${(input / 1000).toFixed(1)}s`
}

function toolLabel(name: string) {
  const key = name.toLowerCase()
  if (key === "read") return "Read file"
  if (key === "grep") return "Search code"
  if (key === "glob") return "Match files"
  if (key === "list") return "List dir"
  if (key === "bash") return "Run command"
  if (key === "edit") return "Edit code"
  if (key === "write") return "Write file"
  if (key === "apply_patch") return "Apply patch"
  if (key === "task") return "Run subtask"
  if (key === "todowrite") return "Update plan"
  if (key === "todoread") return "Read plan"
  return "Run tool"
}

function toolDetail(part: ToolPart) {
  const state = part.state
  const input = state.input
  if (part.tool === "read") return input.filePath ? middle(String(input.filePath), 32) : "workspace context"
  if (part.tool === "grep") {
    const pattern = input.pattern ? clip(String(input.pattern), 20) : "pattern"
    const scope = input.path ? ` in ${middle(String(input.path), 14)}` : ""
    return `${pattern}${scope}`
  }
  if (part.tool === "glob") {
    const pattern = input.pattern ? clip(String(input.pattern), 20) : "glob"
    const scope = input.path ? ` in ${middle(String(input.path), 14)}` : ""
    return `${pattern}${scope}`
  }
  if (part.tool === "list") return input.path ? middle(String(input.path), 32) : "workspace root"
  if (part.tool === "bash") return input.command ? clip(String(input.command), 34) : "shell command"
  if (part.tool === "edit" || part.tool === "write") {
    if (input.filePath) return middle(String(input.filePath), 32)
    return "target file"
  }
  if (part.tool === "apply_patch") return "patch hunks"
  if (part.tool === "task") {
    const desc = (input.description as string | undefined) ?? (input.prompt as string | undefined)
    return desc ? clip(desc, 32) : "delegated task"
  }
  if (part.tool === "todowrite") return "todo items"
  if (part.tool === "todoread") return "todo items"
  return clip(part.tool, 32)
}

function topic(input?: string) {
  if (!input) return "current request"
  return clip(input, 34)
}

function summarize(input: string, size: number) {
  const text = input
    .replace(/\s+/g, " ")
    .replace(/[`*_>#-]+/g, "")
    .trim()
  if (!text) return ""
  const stop = text.search(/[.?!;。！？；]/)
  if (stop > 12) return clip(text.slice(0, stop), size)
  return clip(text, size)
}

function reindex(input: Runtime, list: WorkflowNode[]) {
  input.index = {}
  for (let idx = 0; idx < list.length; idx += 1) {
    const node = list[idx]
    input.index[node.key] = idx
  }
}

export const { use: useWorkflow, provider: WorkflowProvider } = createSimpleContext({
  name: "Workflow",
  init: () => {
    const sdk = useSDK()
    const [store, setStore] = createStore<{
      nodes: Record<string, WorkflowNode[]>
      question: Record<string, string>
      questions: Record<string, WorkflowQuestion[]>
      subtask: Record<string, WorkflowSubtask>
      task: Record<string, WorkflowTask[]>
    }>({
      nodes: {},
      question: {},
      questions: {},
      subtask: {},
      task: {},
    })
    const rt = new Map<string, Runtime>()

    function touch(sessionID: string) {
      const runtime = rt.get(sessionID)
      if (!runtime) return
      runtime.last = Date.now()
    }

    function evict() {
      if (rt.size <= MAX_SESSIONS) return
      const oldest = [...rt.entries()].sort((a, b) => a[1].last - b[1].last)[0]
      if (!oldest) return
      const sessionID = oldest[0]
      rt.delete(sessionID)
      setStore("nodes", sessionID, [])
      setStore("question", sessionID, "")
      setStore("questions", sessionID, [])
      setStore("task", sessionID, [])
      setStore(
        "subtask",
        produce((draft) => {
          delete draft[sessionID]
        }),
      )
    }

    function run(sessionID: string) {
      const cached = rt.get(sessionID)
      if (cached) {
        touch(sessionID)
        return cached
      }
      const created: Runtime = {
        last: Date.now(),
        seq: 0,
        index: {},
        think: {},
        tool: {},
        output: {},
        message_role: {},
        question_mode: "plan",
        user_time: {},
        task_revision: 0,
      }
      rt.set(sessionID, created)
      evict()
      return created
    }

    function taskByID(sessionID: string, id?: string) {
      if (!id) return undefined
      return (store.task[sessionID] ?? []).find((item) => item.id === id)
    }

    function applyTodo(sessionID: string, todos: Array<{ content: string; status: string }>) {
      const runtime = run(sessionID)
      runtime.task_revision += 1
      const revision = runtime.task_revision
      const at = Date.now()

      if (!store.task[sessionID]) setStore("task", sessionID, [])

      setStore(
        "task",
        sessionID,
        produce((draft) => {
          for (const item of draft) {
            if (item.kind === "todo" && !item.superseded) item.superseded = true
          }
          for (let i = 0; i < todos.length; i += 1) {
            const todo = todos[i]
            const status =
              todo.status === "completed" || todo.status === "in_progress" || todo.status === "cancelled"
                ? todo.status
                : "pending"
            draft.push({
              id: `todo:${sessionID}:${revision}:${i + 1}`,
              sessionID,
              revision,
              at,
              kind: "todo",
              index: i + 1,
              title: clip(todo.content, 56),
              status,
            })
          }
        }),
      )

      if (todos.length === 0) {
        runtime.current_task = undefined
        return
      }

      const list = store.task[sessionID] ?? []
      const active =
        list.find((item) => item.kind === "todo" && item.revision === revision && item.status === "in_progress") ??
        list.find((item) => item.kind === "todo" && item.revision === revision && item.status === "pending") ??
        list.find((item) => item.kind === "todo" && item.revision === revision)
      runtime.current_task = active?.id
    }

    function ensureNode(input: {
      sessionID: string
      key: string
      lane: WorkflowLane
      state: WorkflowState
      title: string
      detail?: string
      at?: number
      taskID?: string
    }) {
      const runtime = run(input.sessionID)
      const list = store.nodes[input.sessionID] ?? []
      const idx = runtime.index[input.key]
      if (idx !== undefined && list[idx]) {
        setStore(
          "nodes",
          input.sessionID,
          idx,
          produce((draft) => {
            draft.state = input.state
            draft.title = clip(input.title, 30)
            draft.detail = input.detail ? clip(input.detail, 36) : undefined
            draft.at = input.at ?? draft.at
            const taskID = input.taskID ?? runtime.current_task
            draft.taskID = taskID
            draft.taskTitle = taskByID(input.sessionID, taskID)?.title
            draft.taskKind = taskByID(input.sessionID, taskID)?.kind
          }),
        )
        return
      }

      const node = {
        id: `${input.sessionID}-${runtime.seq + 1}`,
        key: input.key,
        seq: runtime.seq + 1,
        at: input.at ?? Date.now(),
        sessionID: input.sessionID,
        lane: input.lane,
        state: input.state,
        title: clip(input.title, 30),
        detail: input.detail ? clip(input.detail, 36) : undefined,
        taskID: input.taskID ?? runtime.current_task,
        taskTitle: taskByID(input.sessionID, input.taskID ?? runtime.current_task)?.title,
        taskKind: taskByID(input.sessionID, input.taskID ?? runtime.current_task)?.kind,
      } satisfies WorkflowNode
      runtime.seq += 1

      if (!store.nodes[input.sessionID]) {
        setStore("nodes", input.sessionID, [node])
        runtime.index[input.key] = 0
        return
      }

      setStore(
        "nodes",
        input.sessionID,
        produce((draft) => {
          draft.push(node)
          if (draft.length > MAX) draft.splice(0, draft.length - MAX)
          reindex(runtime, draft)
        }),
      )
    }

    function upsertTool(part: ToolPart) {
      if (part.tool === "plan_enter" && part.state.status === "completed") {
        ensureNode({
          sessionID: part.sessionID,
          key: `plan:${part.id}`,
          lane: "think",
          state: "running",
          title: "Plan approach",
          detail: "building execution plan",
        })
        return
      }
      if (part.tool === "plan_exit" && part.state.status === "completed") {
        ensureNode({
          sessionID: part.sessionID,
          key: `plan:${part.id}`,
          lane: "think",
          state: "done",
          title: "Plan ready",
          detail: "switching to execution",
        })
        return
      }

      const runtime = run(part.sessionID)
      runtime.question_mode = "investigate"
      const key = runtime.tool[part.id] ?? `tool:${part.id}`
      runtime.tool[part.id] = key
      const label = toolLabel(part.tool)
      const detail = toolDetail(part)

      if (part.tool === "task") {
        const input = part.state.input as Record<string, unknown>
        const metadata = (part.state as any).metadata as Record<string, unknown> | undefined
        const child = typeof metadata?.sessionId === "string" ? metadata.sessionId : undefined
        if (child) {
          const agent = typeof input.subagent_type === "string" ? input.subagent_type : "subagent"
          const desc = typeof input.description === "string" ? input.description : typeof input.prompt === "string" ? input.prompt : `@${agent}`
          const at =
            part.state.status === "pending"
              ? Date.now()
              : part.state.status === "running"
                ? part.state.time.start
                : part.state.time.end
          const prev = store.subtask[child]
          setStore("subtask", child, {
            sessionID: child,
            parentID: part.sessionID,
            at: prev ? Math.min(prev.at, at) : at,
            agent: prev?.agent ?? agent,
            title: prev?.title ?? clip(desc, 56),
            toolPartID: part.id,
          })
          if (part.state.status === "completed" || part.state.status === "error") {
            const spent = part.state.time.end - part.state.time.start
            ensureNode({
              sessionID: child,
              key: `subtask:final:${part.id}`,
              lane: "final",
              state: part.state.status === "error" ? "error" : "done",
              title: part.state.status === "error" ? "Subagent failed" : "Subagent done",
              detail: `${clip(desc, 24)} · ${ms(spent)}`,
              at: part.state.time.end,
            })
          }
        }
      }

      if (part.state.status === "pending") {
        ensureNode({
          sessionID: part.sessionID,
          key,
          lane: "tool",
          state: "running",
          title: label,
          detail,
        })
        return
      }

      if (part.state.status === "running") {
        ensureNode({
          sessionID: part.sessionID,
          key,
          lane: "tool",
          state: "running",
          title: label,
          detail,
        })
        return
      }

      if (part.state.status === "completed") {
        const spent = part.state.time.end - part.state.time.start
        ensureNode({
          sessionID: part.sessionID,
          key,
          lane: "tool",
          state: "done",
          title: label,
          detail: `${detail} · ${ms(spent)}`,
          at: part.state.time.end,
        })
        return
      }

      const spent = part.state.time.end - part.state.time.start
      ensureNode({
        sessionID: part.sessionID,
        key,
        lane: "tool",
        state: "error",
        title: label,
        detail: `${detail} · ${ms(spent)}`,
        at: part.state.time.end,
      })
    }

    function upsertReasoning(part: Extract<Part, { type: "reasoning" }>) {
      const runtime = run(part.sessionID)
      const key = runtime.think[part.id] ?? `think:${part.id}`
      runtime.think[part.id] = key
      const related = topic(runtime.question)
      const brief = summarize(part.text, 52)
      const title =
        runtime.question_mode === "plan"
          ? "Plan approach"
          : runtime.question_mode === "investigate"
            ? "Reason findings"
            : "Compose response"
      const prefix =
        runtime.question_mode === "plan"
          ? "for"
          : runtime.question_mode === "investigate"
            ? "from"
            : "for"
      if (!part.time.end) {
        ensureNode({
          sessionID: part.sessionID,
          key,
          lane: "think",
          state: "running",
          title,
          detail: brief || `${prefix} ${related}`,
          at: part.time.start,
        })
        return
      }
      ensureNode({
        sessionID: part.sessionID,
        key,
        lane: "think",
        state: "done",
        title,
        detail: `${brief || `${prefix} ${related}`} · ${ms(part.time.end - part.time.start)}`,
        at: part.time.end,
      })
    }

    function updateQuestion(sessionID: string, messageID: string, text: string, at: number) {
      const runtime = run(sessionID)
      runtime.question = clip(text, 72)
      runtime.question_mode = "plan"
      setStore("question", sessionID, runtime.question)
      if (!store.questions[sessionID]) {
        setStore("questions", sessionID, [])
      }
      setStore(
        "questions",
        sessionID,
        produce((draft) => {
          const idx = draft.findIndex((item) => item.messageID === messageID)
          if (idx >= 0) {
            draft[idx].text = runtime.question!
            draft[idx].at = at
            return
          }
          draft.push({
            messageID,
            at,
            text: runtime.question!,
          })
          if (draft.length > MAX_QUESTIONS) draft.splice(0, draft.length - MAX_QUESTIONS)
        }),
      )
    }

    sdk.event.listen((payload) => {
      const event = payload.details as Event

      if (event.type === "server.instance.disposed") {
        return
      }

      if (event.type === "message.updated") {
        const info = event.properties.info
        const runtime = run(info.sessionID)
        runtime.message_role[info.id] = info.role

        if (info.role === "user") {
          runtime.last_user_message = info.id
          runtime.user_time[info.id] = info.time.created
          runtime.question_mode = "plan"
          return
        }

        if (!info.time.completed) {
          return
        }

        const outputKey = runtime.output[info.id]
        if (outputKey) {
          const start = store.nodes[info.sessionID]?.[runtime.index[outputKey]]?.at ?? info.time.created
          const related = topic(runtime.question)
          runtime.question_mode = "synthesize"
          ensureNode({
            sessionID: info.sessionID,
            key: outputKey,
            lane: "output",
            state: info.error ? "error" : "done",
            title: info.error ? "Answer failed" : "Answer ready",
            detail: `for ${related} · ${ms(Math.max(0, info.time.completed - start))}`,
            at: info.time.completed,
          })
        }
        ensureNode({
          sessionID: info.sessionID,
          key: `final:${info.id}`,
          lane: "final",
          state: info.error ? "error" : "done",
          title: info.error ? "Turn failed" : "Turn complete",
          detail: info.finish ? clip(info.finish, 24) : undefined,
          at: info.time.completed,
        })
        return
      }

      if (event.type === "message.part.updated") {
        const part = event.properties.part

        if (part.type === "text" && !part.synthetic && !part.ignored) {
          const runtime = run(part.sessionID)
          const role = runtime.message_role[part.messageID]
          if (role === "user" && runtime.last_user_message === part.messageID) {
            const created = runtime.user_time[part.messageID] ?? Date.now()
            updateQuestion(part.sessionID, part.messageID, part.text, created)
            return
          }

          if (role === "assistant" && part.text.trim()) {
            const key = runtime.output[part.messageID] ?? `output:${part.messageID}`
            runtime.output[part.messageID] = key
            runtime.question_mode = "synthesize"
            const related = topic(runtime.question)
            const start = part.time?.start ?? Date.now()
            const end = part.time?.end
            if (!end) {
              ensureNode({
                sessionID: part.sessionID,
                key,
                lane: "output",
                state: "running",
                title: "Draft answer",
                detail: `for ${related}`,
                at: start,
              })
              return
            }
            ensureNode({
              sessionID: part.sessionID,
              key,
              lane: "output",
              state: "done",
              title: "Answer ready",
              detail: `for ${related} · ${ms(end - start)}`,
              at: end,
            })
          }
          return
        }

        if (part.type === "reasoning") {
          upsertReasoning(part)
          return
        }

        if (part.type === "tool") {
          upsertTool(part)
          return
        }

        if (part.type === "step-start") {
          return
        }

        if (part.type === "step-finish") {
          return
        }

        if (part.type === "retry") {
          ensureNode({
            sessionID: part.sessionID,
            key: `retry:${part.id}`,
            lane: "final",
            state: "retry",
            title: `Retry #${part.attempt}`,
            at: part.time.created,
          })
        }
        return
      }

      if (event.type === "todo.updated") {
        const open = event.properties.todos.filter((item) => item.status === "pending" || item.status === "in_progress").length
        const runtime = run(event.properties.sessionID)
        runtime.question_mode = "plan"
        applyTodo(event.properties.sessionID, event.properties.todos)
        ensureNode({
          sessionID: event.properties.sessionID,
          key: `plan:todo:${event.properties.sessionID}:${runtime.task_revision}`,
          lane: "think",
          state: open > 0 ? "running" : "done",
          title: "Plan tasks",
          detail: `${open} open item${open === 1 ? "" : "s"}`,
        })
        return
      }

      if (event.type === "permission.asked") {
        ensureNode({
          sessionID: event.properties.sessionID,
          key: `wait:permission:${event.properties.id}`,
          lane: "wait",
          state: "wait",
          title: "Permission needed",
          detail: clip(event.properties.permission, 24),
        })
        return
      }

      if (event.type === "permission.replied") {
        ensureNode({
          sessionID: event.properties.sessionID,
          key: `wait:permission:${event.properties.requestID}`,
          lane: "wait",
          state: event.properties.reply === "reject" ? "error" : "done",
          title: event.properties.reply === "reject" ? "Permission denied" : "Permission granted",
          detail: event.properties.reply,
        })
        return
      }

      if (event.type === "question.asked") {
        ensureNode({
          sessionID: event.properties.sessionID,
          key: `wait:question:${event.properties.id}`,
          lane: "wait",
          state: "wait",
          title: "Question asked",
          detail: clip(event.properties.questions[0]?.header ?? "need your input", 24),
        })
        return
      }

      if (event.type === "question.replied") {
        ensureNode({
          sessionID: event.properties.sessionID,
          key: `wait:question:${event.properties.requestID}`,
          lane: "wait",
          state: "done",
          title: "Question answered",
        })
        return
      }

      if (event.type === "question.rejected") {
        ensureNode({
          sessionID: event.properties.sessionID,
          key: `wait:question:${event.properties.requestID}`,
          lane: "wait",
          state: "error",
          title: "Question rejected",
        })
        return
      }

      if (event.type === "session.status" && event.properties.status.type === "retry") {
        ensureNode({
          sessionID: event.properties.sessionID,
          key: `retry:status:${event.properties.status.attempt}`,
          lane: "final",
          state: "retry",
          title: `Retry #${event.properties.status.attempt}`,
          detail: clip(event.properties.status.message, 28),
        })
      }
    })

    return {
      data: store,
      lanes: WORKFLOW_LANES,
      nodes(sessionID: string) {
        return store.nodes[sessionID] ?? []
      },
      question(sessionID: string) {
        return store.question[sessionID]
      },
      questions(sessionID: string) {
        return store.questions[sessionID] ?? []
      },
      tasks(sessionID: string) {
        return store.task[sessionID] ?? []
      },
      subtask(sessionID: string) {
        return store.subtask[sessionID]
      },
      clear(sessionID?: string) {
        if (sessionID) {
          rt.delete(sessionID)
          setStore("nodes", sessionID, [])
          setStore("question", sessionID, "")
          setStore("questions", sessionID, [])
          setStore("task", sessionID, [])
          setStore(
            "subtask",
            produce((draft) => {
              delete draft[sessionID]
            }),
          )
          return
        }
        rt.clear()
        setStore("nodes", {})
        setStore("question", {})
        setStore("questions", {})
        setStore("task", {})
        setStore("subtask", {})
      },
    }
  },
})
