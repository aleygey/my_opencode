import type { Project, UserMessage } from "@opencode-ai/sdk/v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createQuery, skipToken, useMutation, useQueryClient } from "@tanstack/solid-query"
import {
  batch,
  onCleanup,
  Show,
  Match,
  Switch,
  createMemo,
  createEffect,
  createComputed,
  createSignal,
  on,
  onMount,
  untrack,
  createResource,
} from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useLocal } from "@/context/local"
import { selectionFromLines, useFile, type FileSelection, type SelectedLineRange } from "@/context/file"
import { createStore } from "solid-js/store"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Select } from "@opencode-ai/ui/select"
import { Tabs } from "@opencode-ai/ui/tabs"
import { createAutoScroll } from "@opencode-ai/ui/hooks"
import { previewSelectedLines } from "@opencode-ai/ui/pierre/selection-bridge"
import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode, checksum } from "@opencode-ai/shared/util/encode"
import { useNavigate, useSearchParams } from "@solidjs/router"
import { NewSessionView, SessionHeader } from "@/components/session"
import { useShellBridge } from "@/components/unified-shell/shell-bridge"
import { RuneModelPicker } from "@/components/unified-shell/model-picker"
import { RuneAgentPicker } from "@/components/unified-shell/agent-picker"
import { distillTitle } from "@/react-workflow/utils/distill-title"
import { getSessionContextMetrics } from "@/components/session/session-context-metrics"
import { useProviders } from "@/hooks/use-providers"
import { useComments } from "@/context/comments"
import { getSessionPrefetch, SESSION_PREFETCH_TTL } from "@/context/global-sync/session-prefetch"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { useTerminal } from "@/context/terminal"
import { type FollowupDraft, sendFollowupDraft } from "@/components/prompt-input/submit"
import { createSessionComposerState, SessionComposerRegion } from "@/pages/session/composer"
import { createOpenReviewFile, createSessionTabs, createSizing, focusTerminalById } from "@/pages/session/helpers"
import { MessageTimeline } from "@/pages/session/message-timeline"
import { type DiffStyle, SessionReviewTab, type SessionReviewTabProps } from "@/pages/session/review-tab"
import { useSessionLayout } from "@/pages/session/session-layout"
import { syncSessionModel } from "@/pages/session/session-model-helpers"
import { SessionSidePanel } from "@/pages/session/session-side-panel"
import { TerminalPanel } from "@/pages/session/terminal-panel"
import { useSessionCommands } from "@/pages/session/use-session-commands"
import { useSessionHashScroll } from "@/pages/session/use-session-hash-scroll"
import {
  createWorkflowRuntime,
  WorkflowRuntimePanel,
  WorkflowSessionStrip,
} from "@/pages/session/workflow-panel"
import { diffs as list } from "@/utils/diffs"
import { Identifier } from "@/utils/id"
import { Persist, persisted } from "@/utils/persist"
import { extractPromptFromParts } from "@/utils/prompt"
import { same } from "@/utils/same"
import { formatServerError } from "@/utils/server-errors"

// Mirror of `Session.isDefaultTitle` in packages/opencode/src/session/session.ts:41
// — fresh sessions get titled "Parent session - <ISO>" or "Child session - <ISO>"
// before the title-agent fires. Treat those as "no real title yet" so callers
// can fall back to a more useful display name.
const DEFAULT_SESSION_TITLE_RE =
  /^(Parent session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
function isDefaultSessionTitle(title: string | undefined | null): boolean {
  return !!title && DEFAULT_SESSION_TITLE_RE.test(title)
}

const emptyUserMessages: UserMessage[] = []
type FollowupItem = FollowupDraft & { id: string }
type FollowupEdit = Pick<FollowupItem, "id" | "prompt" | "context">
const emptyFollowups: FollowupItem[] = []

type SessionHistoryWindowInput = {
  sessionID: () => string | undefined
  messagesReady: () => boolean
  loaded: () => number
  visibleUserMessages: () => UserMessage[]
  historyMore: () => boolean
  historyLoading: () => boolean
  loadMore: (sessionID: string) => Promise<void>
  userScrolled: () => boolean
  scroller: () => HTMLDivElement | undefined
}

/**
 * Maintains the rendered history window for a session timeline.
 *
 * It keeps initial paint bounded to recent turns, reveals cached turns in
 * small batches while scrolling upward, and prefetches older history near top.
 */
function createSessionHistoryWindow(input: SessionHistoryWindowInput) {
  const turnInit = 10
  const turnBatch = 8
  const turnScrollThreshold = 200
  const turnPrefetchBuffer = 16
  const prefetchCooldownMs = 400
  const prefetchNoGrowthLimit = 2

  const [state, setState] = createStore({
    turnID: undefined as string | undefined,
    turnStart: 0,
    prefetchUntil: 0,
    prefetchNoGrowth: 0,
  })

  const initialTurnStart = (len: number) => (len > turnInit ? len - turnInit : 0)

  const turnStart = createMemo(() => {
    const id = input.sessionID()
    const len = input.visibleUserMessages().length
    if (!id || len <= 0) return 0
    if (state.turnID !== id) return initialTurnStart(len)
    if (state.turnStart <= 0) return 0
    if (state.turnStart >= len) return initialTurnStart(len)
    return state.turnStart
  })

  const setTurnStart = (start: number) => {
    const id = input.sessionID()
    const next = start > 0 ? start : 0
    if (!id) {
      setState({ turnID: undefined, turnStart: next })
      return
    }
    setState({ turnID: id, turnStart: next })
  }

  const renderedUserMessages = createMemo(
    () => {
      const msgs = input.visibleUserMessages()
      const start = turnStart()
      if (start <= 0) return msgs
      return msgs.slice(start)
    },
    emptyUserMessages,
    {
      equals: same,
    },
  )

  const preserveScroll = (fn: () => void) => {
    const el = input.scroller()
    if (!el) {
      fn()
      return
    }
    const beforeTop = el.scrollTop
    const beforeHeight = el.scrollHeight
    fn()
    requestAnimationFrame(() => {
      const delta = el.scrollHeight - beforeHeight
      if (!delta) return
      el.scrollTop = beforeTop + delta
    })
  }

  const backfillTurns = () => {
    const start = turnStart()
    if (start <= 0) return

    const next = start - turnBatch
    const nextStart = next > 0 ? next : 0

    preserveScroll(() => setTurnStart(nextStart))
  }

  /** Button path: reveal all cached turns, fetch older history, reveal one batch. */
  const loadAndReveal = async () => {
    const id = input.sessionID()
    if (!id) return

    const start = turnStart()
    const beforeVisible = input.visibleUserMessages().length
    let loaded = input.loaded()

    if (start > 0) setTurnStart(0)

    if (!input.historyMore() || input.historyLoading()) return

    let afterVisible = beforeVisible
    let added = 0

    while (true) {
      await input.loadMore(id)
      if (input.sessionID() !== id) return

      afterVisible = input.visibleUserMessages().length
      const nextLoaded = input.loaded()
      const raw = nextLoaded - loaded
      added += raw
      loaded = nextLoaded

      if (afterVisible > beforeVisible) break
      if (raw <= 0) break
      if (!input.historyMore()) break
    }

    if (added <= 0) return
    if (state.prefetchNoGrowth) setState("prefetchNoGrowth", 0)

    const growth = afterVisible - beforeVisible
    if (growth <= 0) return
    if (turnStart() !== 0) return

    const target = Math.min(afterVisible, beforeVisible + turnBatch)
    setTurnStart(Math.max(0, afterVisible - target))
  }

  /** Scroll/prefetch path: fetch older history from server. */
  const fetchOlderMessages = async (opts?: { prefetch?: boolean }) => {
    const id = input.sessionID()
    if (!id) return
    if (!input.historyMore() || input.historyLoading()) return

    if (opts?.prefetch) {
      const now = Date.now()
      if (state.prefetchUntil > now) return
      if (state.prefetchNoGrowth >= prefetchNoGrowthLimit) return
      setState("prefetchUntil", now + prefetchCooldownMs)
    }

    const start = turnStart()
    const beforeVisible = input.visibleUserMessages().length
    const beforeRendered = start <= 0 ? beforeVisible : renderedUserMessages().length
    let loaded = input.loaded()
    let added = 0
    let growth = 0

    while (true) {
      await input.loadMore(id)
      if (input.sessionID() !== id) return

      const nextLoaded = input.loaded()
      const raw = nextLoaded - loaded
      added += raw
      loaded = nextLoaded
      growth = input.visibleUserMessages().length - beforeVisible

      if (growth > 0) break
      if (raw <= 0) break
      if (opts?.prefetch) break
      if (!input.historyMore()) break
    }

    const afterVisible = input.visibleUserMessages().length

    if (opts?.prefetch) {
      setState("prefetchNoGrowth", added > 0 ? 0 : state.prefetchNoGrowth + 1)
    } else if (added > 0 && state.prefetchNoGrowth) {
      setState("prefetchNoGrowth", 0)
    }

    if (added <= 0) return
    if (growth <= 0) return
    if (turnStart() !== start) return

    const reveal = !opts?.prefetch
    const currentRendered = renderedUserMessages().length
    const base = Math.max(beforeRendered, currentRendered)
    const target = reveal ? Math.min(afterVisible, base + turnBatch) : base
    const nextStart = Math.max(0, afterVisible - target)
    preserveScroll(() => setTurnStart(nextStart))
  }

  const onScrollerScroll = () => {
    if (!input.userScrolled()) return
    const el = input.scroller()
    if (!el) return
    if (el.scrollTop >= turnScrollThreshold) return

    const start = turnStart()
    if (start > 0) {
      if (start <= turnPrefetchBuffer) {
        void fetchOlderMessages({ prefetch: true })
      }
      backfillTurns()
      return
    }

    void fetchOlderMessages()
  }

  createEffect(
    on(
      input.sessionID,
      () => {
        setState({ prefetchUntil: 0, prefetchNoGrowth: 0 })
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => [input.sessionID(), input.messagesReady()] as const,
      ([id, ready]) => {
        if (!id || !ready) return
        setTurnStart(initialTurnStart(input.visibleUserMessages().length))
      },
      { defer: true },
    ),
  )

  return {
    turnStart,
    setTurnStart,
    renderedUserMessages,
    loadAndReveal,
    onScrollerScroll,
  }
}

export default function Page() {
  const globalSync = useGlobalSync()
  const layout = useLayout()
  const local = useLocal()
  const file = useFile()
  const sync = useSync()
  const queryClient = useQueryClient()
  const dialog = useDialog()
  const language = useLanguage()
  const navigate = useNavigate()
  const sdk = useSDK()
  const settings = useSettings()
  const prompt = usePrompt()
  const comments = useComments()
  const terminal = useTerminal()
  const providers = useProviders()
  const [searchParams, setSearchParams] = useSearchParams<{ prompt?: string }>()
  const { params, sessionKey, tabs, view } = useSessionLayout()
  const workflowRuntime = createWorkflowRuntime()

  createEffect(() => {
    if (!untrack(() => prompt.ready())) return
    prompt.ready()
    untrack(() => {
      if (params.id || !prompt.ready()) return
      const text = searchParams.prompt
      if (!text) return
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      setSearchParams({ ...searchParams, prompt: undefined })
    })
  })

  const [ui, setUi] = createStore({
    git: false,
    pendingMessage: undefined as string | undefined,
    restoring: undefined as string | undefined,
    reverting: false,
    reviewSnap: false,
    scrollGesture: 0,
    scroll: {
      overflow: false,
      bottom: true,
      jump: false,
    },
  })

  const composer = createSessionComposerState()

  const workspaceKey = createMemo(() => params.dir ?? "")
  const workspaceTabs = createMemo(() => layout.tabs(workspaceKey))

  createEffect(
    on(
      () => params.id,
      (id, prev) => {
        if (!id) return
        if (prev) return

        const pending = layout.handoff.tabs()
        if (!pending) return
        if (Date.now() - pending.at > 60_000) {
          layout.handoff.clearTabs()
          return
        }

        if (pending.id !== id) return
        layout.handoff.clearTabs()
        if (pending.dir !== (params.dir ?? "")) return

        const from = workspaceTabs().tabs()
        if (from.all.length === 0 && !from.active) return

        const current = tabs().tabs()
        if (current.all.length > 0 || current.active) return

        const all = normalizeTabs(from.all)
        const active = from.active ? normalizeTab(from.active) : undefined
        tabs().setAll(all)
        tabs().setActive(active && all.includes(active) ? active : all[0])

        workspaceTabs().setAll([])
        workspaceTabs().setActive(undefined)
      },
      { defer: true },
    ),
  )

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const size = createSizing()

  function normalizeTab(tab: string) {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  function normalizeTabs(list: string[]) {
    const seen = new Set<string>()
    const next: string[] = []
    for (const item of list) {
      const value = normalizeTab(item)
      if (seen.has(value)) continue
      seen.add(value)
      next.push(value)
    }
    return next
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const isChildSession = createMemo(() => !!info()?.parentID)
  const diffs = createMemo(() => (params.id ? list(sync.data.session_diff[params.id]) : []))
  const canReview = createMemo(() => !!sync.project)
  const workflowSnapshot = createMemo(() => workflowRuntime.snapshot())
  const workflowReady = createMemo(() => workflowRuntime.ready())
  const workflowRootSelected = createMemo(() => workflowRuntime.rootSelected())
  const workflowReload = createMemo(() => (params.id ? `workflow-reload:${params.id}` : undefined))
  const resolvedDiffs = createMemo(() => (workflowRootSelected() ? workflowRuntime.rootDiffs() : diffs()))
  const reviewCount = createMemo(() => Math.max(info()?.summary?.files ?? 0, diffs().length))
  const resolvedReviewCount = createMemo(() =>
    workflowRootSelected() ? workflowRuntime.rootDiffs().length : reviewCount(),
  )
  createEffect(() => {
    if (workflowSnapshot()) {
      layout.immersive.set(true)
      return
    }
    if (workflowReady()) layout.immersive.set(false)
  })

  onCleanup(() => {
    layout.immersive.set(false)
  })

  createEffect(() => {
    const id = params.id
    const key = workflowReload()
    if (!id || !key) return
    if (workflowReady() || workflowSnapshot()) {
      sessionStorage.removeItem(key)
      return
    }
    const timer = window.setTimeout(() => {
      if (workflowReady() || workflowSnapshot()) return
      if (sessionStorage.getItem(key)) return
      sessionStorage.setItem(key, "1")
      window.location.reload()
    }, 2500)
    onCleanup(() => window.clearTimeout(timer))
  })

  const hasReview = createMemo(() => reviewCount() > 0)
  const resolvedHasReview = createMemo(() => (workflowRootSelected() ? workflowRuntime.rootDiffs().length > 0 : hasReview()))
  const reviewTab = createMemo(() => isDesktop())
  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: reviewTab,
    hasReview,
  })
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab
  const revertMessageID = createMemo(() => info()?.revert?.messageID)
  const messages = createMemo(() => (params.id ? (sync.data.message[params.id] ?? []) : []))
  const messagesReady = createMemo(() => {
    const id = params.id
    if (!id) return true
    return sync.data.message[id] !== undefined
  })
  const historyMore = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sync.session.history.more(id)
  })
  const historyLoading = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sync.session.history.loading(id)
  })

  const userMessages = createMemo(
    () => messages().filter((m) => m.role === "user") as UserMessage[],
    emptyUserMessages,
    { equals: same },
  )
  const visibleUserMessages = createMemo(
    () => {
      const revert = revertMessageID()
      if (!revert) return userMessages()
      return userMessages().filter((m) => m.id < revert)
    },
    emptyUserMessages,
    {
      equals: same,
    },
  )
  const lastUserMessage = createMemo(() => visibleUserMessages().at(-1))

  createEffect(() => {
    const tab = activeFileTab()
    if (!tab) return

    const path = file.pathFromTab(tab)
    if (path) void file.load(path)
  })

  createEffect(
    on(
      () => lastUserMessage()?.id,
      () => {
        const msg = lastUserMessage()
        if (!msg) return
        syncSessionModel(local, msg)
      },
    ),
  )

  // Preserve the user's current picker choice when the existing selection is
  // still a valid primary (non-subagent) agent. Fall back to orchestrator
  // otherwise. This prevents navigation from clobbering the agent-picker
  // selection the user made in the root-session chat panel.
  const ensureRootAgent = () => {
    const current = local.agent.current()
    if (current && current.mode !== "subagent") return
    local.agent.set("orchestrator")
  }

  const selectWorkflowSession = (sessionID: string) => {
    const snapshot = workflowSnapshot()
    if (!snapshot) return
    const slug = params.dir ?? base64Encode(sdk.directory)

    if (sessionID === snapshot.workflow.session_id) {
      ensureRootAgent()
      navigate(`/${slug}/session/${sessionID}`)
      return
    }

    const node = snapshot.nodes.find((item) => item.session_id === sessionID)
    if (!node) return
    local.agent.set(node.agent)
    if (node.model?.providerID && node.model?.modelID) {
      local.model.set(
        {
          providerID: node.model.providerID,
          modelID: node.model.modelID,
        },
        { recent: true },
      )
    }
    if (node.model?.variant) local.model.variant.set(node.model.variant)
    navigate(`/${slug}/session/${sessionID}`)
  }

  const selectWorkflowRoot = (view: "graph" | "session") => {
    const snapshot = workflowSnapshot()
    if (!snapshot) return
    setStore("workflow", view)
    selectWorkflowSession(snapshot.workflow.session_id)
  }

  // Clicking "New Task" inside the workflow task-sidebar: spin up a fresh
  // workflow root session in the current directory and jump to it, keeping
  // the user inside the react-workflow graph view instead of dropping them
  // into the legacy NewSessionView composer.
  /* Delete a workflow root session (and its workflow). Called from the
   * Rail sub-item × button or the Tasks drawer × button; the shell
   * already prompts the user for confirm before invoking this so we
   * just dispatch the delete and clean up navigation when the deleted
   * task was the active one. */
  // Track sessions the user has deleted but whose `session.deleted`
  // SSE event hasn't arrived yet. The rail filter below excludes
  // them so the X click feels instant — without this, the user
  // reported "点击 X 后 task 还在" because the rail re-rendered with
  // the stale `sync.data.session` array before SSE caught up.
  const [pendingDeletes, setPendingDeletes] = createSignal<Set<string>>(new Set())
  const deleteWorkflowTask = async (sessionId: string) => {
    // Optimistic UI removal — flip the local "hidden" set before the
    // network round-trip. If DELETE fails we restore.
    setPendingDeletes((prev) => {
      const next = new Set(prev)
      next.add(sessionId)
      return next
    })
    // Capture the navigation target now (BEFORE the deleted session
    // disappears from rail / pendingDeletes filter), so the redirect
    // below picks the right "next" task.
    const remainingForNav =
      params.id === sessionId
        ? (sync.data.session ?? []).find(
            (s) => !s.parentID && s.id !== sessionId && !pendingDeletes().has(s.id),
          )
        : null
    try {
      // The workflow service exposes DELETE /workflow/session/:id which
      // tears down the workflow + root session in one call. SDK doesn't
      // expose a typed binding for it, so we hit the route directly.
      const url = new URL(`/workflow/session/${sessionId}`, location.origin)
      const res = await fetch(url, { method: "DELETE" })
      if (!res.ok) throw new Error(`DELETE failed: ${res.status}`)
    } catch (err) {
      console.error("delete task failed", err)
      // Roll back the optimistic removal.
      setPendingDeletes((prev) => {
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })
      return
    }
    // Force a sync tick so the deleted session disappears from
    // sync.data.session immediately rather than waiting for the next
    // background poll. (SSE should also fire `session.deleted` which
    // the event-reducer handles — pendingDeletes covers the gap
    // between OK response and SSE arrival.)
    void sync.session.sync(sessionId, { force: true }).catch(() => undefined)
    // If the deleted task was the active one, navigate to the next
    // remaining root session (or the project's default).
    if (params.id === sessionId) {
      const slug = params.dir ?? base64Encode(sdk.directory)
      navigate(remainingForNav ? `/${slug}/session/${remainingForNav.id}` : `/${slug}`)
    }
  }

  const newWorkflowTask = async () => {
    try {
      // Do NOT pass an explicit title here. The backend's title agent
      // (`SessionPrompt.ensureTitle`) only generates a title when the
      // current title matches the default `"Parent session - <ISO>"`
      // format — passing `"Workflow"` permanently locks every task to
      // that literal name (the user's #7 complaint: "全是同名task").
      // Leaving title unset lets the auto-title flow run on the first
      // user message, and the user can still rename via the session
      // settings if they want.
      const session = await sdk.client.session.create({}).then((res) => res.data)
      if (!session?.id) throw new Error("Failed to create root session")
      await sdk.client.workflow.create({
        session_id: session.id,
        // Workflow object's title is separate from session.title — keep
        // a sensible default here since it shows in the canvas header
        // until the orchestrator emits a real plan title.
        title: "Workflow",
      })
      const slug = params.dir ?? base64Encode(sdk.directory)
      setStore("workflow", "graph")
      local.agent.set("orchestrator")
      // Force a fresh session+workflow sync BEFORE navigating so the
      // inspector lands on a populated snapshot. Without this the
      // inspector first renders against a stale (or absent) workflow
      // record — model/agent fields look empty until the user manually
      // switches tabs and back (the user's #2a complaint).
      await sync.session.sync(session.id, { force: true }).catch(() => undefined)
      navigate(`/${slug}/session/${session.id}`)
    } catch (err) {
      console.error("create workflow task failed", err)
    }
  }

  // Clicking "Select workspace" inside the workflow chat-panel: pick a
  // directory, then create a new workflow root session there and navigate
  // to it. Mirrors WorkflowScreen.pickWorkspace from app.tsx.
  const pickWorkspace = () => {
    void import("@/components/dialog-select-directory").then((mod) => {
      dialog.show(() => (
        <mod.DialogSelectDirectory
          title="Select workspace"
          onSelect={(result) => {
            if (typeof result !== "string" || !result) return
            dialog.close()
            void (async () => {
              try {
                const next = sdk.createClient({ directory: result, throwOnError: true })
                // See `newWorkflowTask` above — do NOT pre-set session.title,
                // it would block the title agent from auto-generating a per-task
                // title and lock every task to the same literal name.
                const session = await next.session.create({}).then((res) => res.data)
                if (!session?.id) throw new Error("Failed to create root session")
                await next.workflow.create({
                  session_id: session.id,
                  title: "Workflow",
                })
                setStore("workflow", "graph")
                local.agent.set("orchestrator")
                navigate(`/${base64Encode(result)}/session/${session.id}`)
              } catch (err) {
                console.error("switch workspace failed", err)
              }
            })()
          }}
        />
      ))
    })
  }

  createEffect(() => {
    const snapshot = workflowSnapshot()
    const sessionID = params.id
    if (!snapshot || !sessionID) return

    if (sessionID === snapshot.workflow.session_id) {
      ensureRootAgent()
      return
    }

    const node = snapshot.nodes.find((item) => item.session_id === sessionID)
    if (!node) return
    if (local.agent.current()?.name !== node.agent) local.agent.set(node.agent)
    if (node.model?.providerID && node.model?.modelID) {
      const current = local.model.current()
      if (current?.provider.id !== node.model.providerID || current.id !== node.model.modelID) {
        local.model.set({
          providerID: node.model.providerID,
          modelID: node.model.modelID,
        })
      }
    }
    if (node.model?.variant && local.model.variant.selected() !== node.model.variant) {
      local.model.variant.set(node.model.variant)
    }
  })

  createEffect(
    on(
      () => ({ dir: params.dir, id: params.id }),
      (next, prev) => {
        if (!prev) return
        if (next.dir === prev.dir && next.id === prev.id) return
        if (prev.id && !next.id) local.session.reset()
      },
      { defer: true },
    ),
  )

  const [store, setStore] = createStore({
    messageId: undefined as string | undefined,
    mobileTab: "session" as "session" | "changes",
    changes: "session" as "session" | "turn",
    workflow: "graph" as "graph" | "session",
    /* Design-spec: Workflow module body switches between Canvas / Chat
     * / Events + dynamically-added node / sand-table tabs (substrip).
     * Default to Canvas.
     *   - "canvas" / "chat" / "events" — fixed tabs
     *   - "node:<id>"                  — opened from canvas node click
     *   - "sand:<id>"                  — opened from sand-table node click
     */
    /* Default tab when entering a workflow page is Chat — the user
     * lands here to talk to the orchestrator first; Canvas is a view
     * they switch into after the graph has nodes worth inspecting. */
    workflowTab: "chat" as string,
    /** Per-session map of currently-opened node/sand-table tab lists.
     *  Was previously a flat global array (`Array<{ id, kind, title }>`),
     *  but the user reported that opening a node card under Task A
     *  and switching to Task B left A's card visible in B's view
     *  (the substrip rendered all tabs regardless of which session
     *  was active). Keying by session id makes the substrip
     *  per-task: A keeps its opened tabs, B keeps its own, and
     *  switching back to A restores what A had. The substrip render
     *  below reads `workflowOpenTabs[params.id]`. */
    workflowOpenTabs: {} as Record<
      string,
      Array<{ id: string; kind: "node" | "sand"; title: string }> | undefined
    >,
    newSessionWorktree: "main",
    deferRender: false,
  })

  const [followup, setFollowup] = persisted(
    Persist.workspace(sdk.directory, "followup", ["followup.v1"]),
    createStore<{
      items: Record<string, FollowupItem[] | undefined>
      sending: Record<string, string | undefined>
      failed: Record<string, string | undefined>
      paused: Record<string, boolean | undefined>
      edit: Record<string, FollowupEdit | undefined>
    }>({
      items: {},
      sending: {},
      failed: {},
      paused: {},
      edit: {},
    }),
  )

  const graph = createMemo(() => workflowRootSelected() && store.workflow === "graph")
  const desktopReviewOpen = createMemo(() => isDesktop() && !graph() && view().reviewPanel.opened())
  const desktopFileTreeOpen = createMemo(() => isDesktop() && !graph() && layout.fileTree.opened())
  const desktopSidePanelOpen = createMemo(() => desktopReviewOpen() || desktopFileTreeOpen())
  const sessionPanelWidth = createMemo(() => {
    if (!desktopSidePanelOpen()) return "100%"
    if (desktopReviewOpen()) return `${layout.session.width()}px`
    return `calc(100% - ${layout.fileTree.width()}px)`
  })
  const centered = createMemo(() => isDesktop() && !desktopReviewOpen())

  createComputed((prev) => {
    const key = sessionKey()
    if (key !== prev) {
      setStore("deferRender", true)
      requestAnimationFrame(() => {
        setTimeout(() => setStore("deferRender", false), 0)
      })
    }
    return key
  }, sessionKey())

  let reviewFrame: number | undefined
  let refreshFrame: number | undefined
  let refreshTimer: number | undefined
  let diffFrame: number | undefined
  let diffTimer: number | undefined

  createComputed((prev) => {
    const open = desktopReviewOpen()
    if (prev === undefined || prev === open) return open

    if (reviewFrame !== undefined) cancelAnimationFrame(reviewFrame)
    setUi("reviewSnap", true)
    reviewFrame = requestAnimationFrame(() => {
      reviewFrame = undefined
      setUi("reviewSnap", false)
    })
    return open
  }, desktopReviewOpen())

  const turnDiffs = createMemo(() => list(lastUserMessage()?.summary?.diffs))
  const reviewDiffs = createMemo(() => {
    if (workflowRootSelected()) return resolvedDiffs()
    return store.changes === "session" ? resolvedDiffs() : turnDiffs()
  })

  const newSessionWorktree = createMemo(() => {
    if (store.newSessionWorktree === "create") return "create"
    const project = sync.project
    if (project && sdk.directory !== project.worktree) return sdk.directory
    return "main"
  })

  const setActiveMessage = (message: UserMessage | undefined) => {
    messageMark = scrollMark
    setStore("messageId", message?.id)
  }

  const anchor = (id: string) => `message-${id}`

  const cursor = () => {
    const root = scroller
    if (!root) return store.messageId

    const box = root.getBoundingClientRect()
    const line = box.top + 100
    const list = [...root.querySelectorAll<HTMLElement>("[data-message-id]")]
      .map((el) => {
        const id = el.dataset.messageId
        if (!id) return

        const rect = el.getBoundingClientRect()
        return { id, top: rect.top, bottom: rect.bottom }
      })
      .filter((item): item is { id: string; top: number; bottom: number } => !!item)

    const shown = list.filter((item) => item.bottom > box.top && item.top < box.bottom)
    const hit = shown.find((item) => item.top <= line && item.bottom >= line)
    if (hit) return hit.id

    const near = [...shown].sort((a, b) => {
      const da = Math.abs(a.top - line)
      const db = Math.abs(b.top - line)
      if (da !== db) return da - db
      return a.top - b.top
    })[0]
    if (near) return near.id

    return list.filter((item) => item.top <= line).at(-1)?.id ?? list[0]?.id ?? store.messageId
  }

  function navigateMessageByOffset(offset: number) {
    const msgs = visibleUserMessages()
    if (msgs.length === 0) return

    const current = store.messageId && messageMark === scrollMark ? store.messageId : cursor()
    const base = current ? msgs.findIndex((m) => m.id === current) : msgs.length
    const currentIndex = base === -1 ? msgs.length : base
    const targetIndex = currentIndex + offset
    if (targetIndex < 0 || targetIndex > msgs.length) return

    if (targetIndex === msgs.length) {
      resumeScroll()
      return
    }

    autoScroll.pause()
    scrollToMessage(msgs[targetIndex], "auto")
  }

  const diffsReady = createMemo(() => {
    const id = params.id
    if (!id) return true
    if (!hasReview()) return true
    return sync.data.session_diff[id] !== undefined
  })
  const resolvedDiffsReady = createMemo(() =>
    workflowRootSelected() ? workflowRuntime.rootDiffsReady() : diffsReady(),
  )
  const reviewEmptyKey = createMemo(() => {
    const project = sync.project
    if (project && !project.vcs) return "session.review.noVcs"
    if (sync.data.config.snapshot === false) return "session.review.noSnapshot"
    return "session.review.empty"
  })

  function upsert(next: Project) {
    const list = globalSync.data.project
    sync.set("project", next.id)
    const idx = list.findIndex((item) => item.id === next.id)
    if (idx >= 0) {
      globalSync.set(
        "project",
        list.map((item, i) => (i === idx ? { ...item, ...next } : item)),
      )
      return
    }
    const at = list.findIndex((item) => item.id > next.id)
    if (at >= 0) {
      globalSync.set("project", [...list.slice(0, at), next, ...list.slice(at)])
      return
    }
    globalSync.set("project", [...list, next])
  }

  function initGit() {
    if (ui.git) return
    setUi("git", true)
    void sdk.client.project
      .initGit()
      .then((x) => {
        if (!x.data) return
        upsert(x.data)
      })
      .catch((err) => {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: formatServerError(err, language.t),
        })
      })
      .finally(() => {
        setUi("git", false)
      })
  }

  let inputRef!: HTMLDivElement
  let promptDock: HTMLDivElement | undefined
  let dockHeight = 0
  let scroller: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  let scrollMark = 0
  let messageMark = 0

  const scrollGestureWindowMs = 250

  const markScrollGesture = (target?: EventTarget | null) => {
    const root = scroller
    if (!root) return

    const el = target instanceof Element ? target : undefined
    const nested = el?.closest("[data-scrollable]")
    if (nested && nested !== root) return

    setUi("scrollGesture", Date.now())
  }

  const hasScrollGesture = () => Date.now() - ui.scrollGesture < scrollGestureWindowMs

  const [sessionSync] = createResource(
    () => [sdk.directory, params.id] as const,
    ([directory, id]) => {
      if (refreshFrame !== undefined) cancelAnimationFrame(refreshFrame)
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
      refreshFrame = undefined
      refreshTimer = undefined
      if (!id) return

      const cached = untrack(() => sync.data.message[id] !== undefined)
      const stale = !cached
        ? false
        : (() => {
            const info = getSessionPrefetch(directory, id)
            if (!info) return true
            return Date.now() - info.at > SESSION_PREFETCH_TTL
          })()
      const todos = untrack(() => sync.data.todo[id] !== undefined || globalSync.data.session_todo[id] !== undefined)

      untrack(() => {
        void sync.session.sync(id)
      })

      refreshFrame = requestAnimationFrame(() => {
        refreshFrame = undefined
        refreshTimer = window.setTimeout(() => {
          refreshTimer = undefined
          if (params.id !== id) return
          untrack(() => {
            if (stale) void sync.session.sync(id, { force: true })
            void sync.session.todo(id, todos ? { force: true } : undefined)
          })
        }, 0)
      })

      return sync.session.sync(id)
    },
  )

  createEffect(
    on(
      () => visibleUserMessages().at(-1)?.id,
      (lastId, prevLastId) => {
        if (lastId && prevLastId && lastId > prevLastId) {
          setStore("messageId", undefined)
        }
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      sessionKey,
      () => {
        setStore("messageId", undefined)
        setStore("changes", "session")
        setUi("pendingMessage", undefined)
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => params.dir,
      (dir) => {
        if (!dir) return
        setStore("newSessionWorktree", "main")
      },
      { defer: true },
    ),
  )

  const selectionPreview = (path: string, selection: FileSelection) => {
    const content = file.get(path)?.content?.content
    if (!content) return undefined
    return previewSelectedLines(content, { start: selection.startLine, end: selection.endLine })
  }

  const addCommentToContext = (input: {
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
    origin?: "review" | "file"
  }) => {
    const selection = selectionFromLines(input.selection)
    const preview = input.preview ?? selectionPreview(input.file, selection)
    const saved = comments.add({
      file: input.file,
      selection: input.selection,
      comment: input.comment,
    })
    prompt.context.add({
      type: "file",
      path: input.file,
      selection,
      comment: input.comment,
      commentID: saved.id,
      commentOrigin: input.origin,
      preview,
    })
  }

  const updateCommentInContext = (input: {
    id: string
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
  }) => {
    comments.update(input.file, input.id, input.comment)
    prompt.context.updateComment(input.file, input.id, {
      comment: input.comment,
      ...(input.preview ? { preview: input.preview } : {}),
    })
  }

  const removeCommentFromContext = (input: { id: string; file: string }) => {
    comments.remove(input.file, input.id)
    prompt.context.removeComment(input.file, input.id)
  }

  const reviewCommentActions = createMemo(() => ({
    moreLabel: language.t("common.moreOptions"),
    editLabel: language.t("common.edit"),
    deleteLabel: language.t("common.delete"),
    saveLabel: language.t("common.save"),
  }))

  const isEditableTarget = (target: EventTarget | null | undefined) => {
    if (!(target instanceof HTMLElement)) return false
    return /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName) || target.isContentEditable
  }

  const deepActiveElement = () => {
    let current: Element | null = document.activeElement
    while (current instanceof HTMLElement && current.shadowRoot?.activeElement) {
      current = current.shadowRoot.activeElement
    }
    return current instanceof HTMLElement ? current : undefined
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    const path = event.composedPath()
    const target = path.find((item): item is HTMLElement => item instanceof HTMLElement)
    const activeElement = deepActiveElement()

    const protectedTarget = path.some(
      (item) => item instanceof HTMLElement && item.closest("[data-prevent-autofocus]") !== null,
    )
    if (protectedTarget || isEditableTarget(target)) return

    if (activeElement) {
      const isProtected = activeElement.closest("[data-prevent-autofocus]")
      const isInput = isEditableTarget(activeElement)
      if (isProtected || isInput) return
    }
    if (dialog.active) return

    if (activeElement === inputRef) {
      if (event.key === "Escape") inputRef?.blur()
      return
    }

    // Prefer the open terminal over the composer when it can take focus
    if (view().terminal.opened()) {
      const id = terminal.active()
      if (id && focusTerminalById(id)) return
    }

    // Only treat explicit scroll keys as potential "user scroll" gestures.
    if (event.key === "PageUp" || event.key === "PageDown" || event.key === "Home" || event.key === "End") {
      markScrollGesture()
      return
    }

    if (event.key.length === 1 && event.key !== "Unidentified" && !(event.ctrlKey || event.metaKey)) {
      if (composer.blocked()) return
      inputRef?.focus()
    }
  }

  const mobileChanges = createMemo(() => !isDesktop() && store.mobileTab === "changes")

  const fileTreeTab = () => layout.fileTree.tab()
  const setFileTreeTab = (value: "changes" | "all") => layout.fileTree.setTab(value)

  const [tree, setTree] = createStore({
    reviewScroll: undefined as HTMLDivElement | undefined,
    pendingDiff: undefined as string | undefined,
    activeDiff: undefined as string | undefined,
  })

  createEffect(
    on(
      sessionKey,
      () => {
        setTree({
          reviewScroll: undefined,
          pendingDiff: undefined,
          activeDiff: undefined,
        })
      },
      { defer: true },
    ),
  )

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    setFileTreeTab("all")
  }

  const focusInput = () => inputRef?.focus()

  useSessionCommands({
    navigateMessageByOffset,
    setActiveMessage,
    focusInput,
    review: reviewTab,
  })

  const openReviewFile = createOpenReviewFile({
    showAllFiles,
    tabForPath: file.tab,
    openTab: tabs().open,
    setActive: tabs().setActive,
    loadFile: file.load,
  })

  const changesOptions = ["session", "turn"] as const
  const changesOptionsList = [...changesOptions]

  const changesTitle = () => {
    if (!resolvedHasReview()) {
      return null
    }

    if (workflowRootSelected()) {
      return (
        <div class="flex items-center gap-2">
          <span class="text-14-medium text-text-strong">Workflow review</span>
          <span class="rounded-full border border-border-weak-base px-2 py-0.5 text-[10px] font-medium text-text-weak">
            aggregated diff
          </span>
          <span class="rounded-full border border-border-weak-base px-2 py-0.5 text-[10px] font-medium text-text-weak">
            {`${resolvedReviewCount()} files`}
          </span>
        </div>
      )
    }

    return (
      <Select
        options={changesOptionsList}
        current={store.changes}
        label={(option) =>
          option === "session" ? language.t("ui.sessionReview.title") : language.t("ui.sessionReview.title.lastTurn")
        }
        onSelect={(option) => option && setStore("changes", option)}
        variant="ghost"
        size="small"
        valueClass="text-14-medium"
      />
    )
  }

  const emptyTurn = () => (
    <div class="h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6">
      <div class="text-14-regular text-text-weak max-w-56">{language.t("session.review.noChanges")}</div>
    </div>
  )

  const reviewEmpty = (input: { loadingClass: string; emptyClass: string }) => {
    if (workflowRootSelected() && !resolvedDiffsReady()) {
      return <div class={input.loadingClass}>{language.t("session.review.loadingChanges")}</div>
    }

    if (store.changes === "turn") return emptyTurn()

    if (resolvedHasReview() && !resolvedDiffsReady()) {
      return <div class={input.loadingClass}>{language.t("session.review.loadingChanges")}</div>
    }

    if (reviewEmptyKey() === "session.review.noVcs") {
      return (
        <div class={input.emptyClass}>
          <div class="flex flex-col gap-3">
            <div class="text-14-medium text-text-strong">{language.t("session.review.noVcs.createGit.title")}</div>
            <div class="text-14-regular text-text-base max-w-md" style={{ "line-height": "var(--line-height-normal)" }}>
              {language.t("session.review.noVcs.createGit.description")}
            </div>
          </div>
          <Button size="large" disabled={ui.git} onClick={initGit}>
            {ui.git
              ? language.t("session.review.noVcs.createGit.actionLoading")
              : language.t("session.review.noVcs.createGit.action")}
          </Button>
        </div>
      )
    }

    return (
      <div class={input.emptyClass}>
        <div class="text-14-regular text-text-weak max-w-56">{language.t(reviewEmptyKey())}</div>
      </div>
    )
  }

  const reviewContent = (input: {
    diffStyle: DiffStyle
    onDiffStyleChange?: (style: DiffStyle) => void
    classes?: SessionReviewTabProps["classes"]
    loadingClass: string
    emptyClass: string
  }) => (
    <Show when={!store.deferRender}>
      <SessionReviewTab
        title={changesTitle()}
        empty={reviewEmpty(input)}
        flat={workflowRootSelected()}
        diffs={reviewDiffs}
        view={view}
        diffStyle={workflowRootSelected() ? "split" : input.diffStyle}
        onDiffStyleChange={input.onDiffStyleChange}
        onScrollRef={(el) => setTree("reviewScroll", el)}
        focusedFile={tree.activeDiff}
        onLineComment={(comment) => addCommentToContext({ ...comment, origin: "review" })}
        onLineCommentUpdate={updateCommentInContext}
        onLineCommentDelete={removeCommentFromContext}
        lineCommentActions={reviewCommentActions()}
        comments={comments.all()}
        focusedComment={comments.focus()}
        onFocusedCommentChange={comments.setFocus}
        onViewFile={openReviewFile}
        classes={input.classes}
      />
    </Show>
  )

  const reviewPanel = () => (
    <div class="flex flex-col h-full overflow-hidden bg-background-stronger contain-strict">
      <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
        {reviewContent({
          diffStyle: layout.review.diffStyle(),
          onDiffStyleChange: layout.review.setDiffStyle,
          loadingClass: "px-6 py-4 text-text-weak",
          emptyClass: "h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6",
        })}
      </div>
    </div>
  )

  createEffect(
    on(
      activeFileTab,
      (active) => {
        if (!active) return
        if (fileTreeTab() !== "changes") return
        showAllFiles()
      },
      { defer: true },
    ),
  )

  const reviewDiffId = (path: string) => {
    const sum = checksum(path)
    if (!sum) return
    return `session-review-diff-${sum}`
  }

  const reviewDiffTop = (path: string) => {
    const root = tree.reviewScroll
    if (!root) return

    const id = reviewDiffId(path)
    if (!id) return

    const el = document.getElementById(id)
    if (!(el instanceof HTMLElement)) return
    if (!root.contains(el)) return

    const a = el.getBoundingClientRect()
    const b = root.getBoundingClientRect()
    return a.top - b.top + root.scrollTop
  }

  const scrollToReviewDiff = (path: string) => {
    const root = tree.reviewScroll
    if (!root) return false

    const top = reviewDiffTop(path)
    if (top === undefined) return false

    view().setScroll("review", { x: root.scrollLeft, y: top })
    root.scrollTo({ top, behavior: "auto" })
    return true
  }

  const focusReviewDiff = (path: string) => {
    openReviewPanel()
    view().review.openPath(path)
    setTree({ activeDiff: path, pendingDiff: path })
  }

  createEffect(() => {
    const pending = tree.pendingDiff
    if (!pending) return
    if (!tree.reviewScroll) return
    if (!diffsReady()) return

    const attempt = (count: number) => {
      if (tree.pendingDiff !== pending) return
      if (count > 60) {
        setTree("pendingDiff", undefined)
        return
      }

      const root = tree.reviewScroll
      if (!root) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (!scrollToReviewDiff(pending)) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      const top = reviewDiffTop(pending)
      if (top === undefined) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (Math.abs(root.scrollTop - top) <= 1) {
        setTree("pendingDiff", undefined)
        return
      }

      requestAnimationFrame(() => attempt(count + 1))
    }

    requestAnimationFrame(() => attempt(0))
  })

  createEffect(() => {
    const id = params.id
    if (!id) return

    const wants = isDesktop()
      ? desktopFileTreeOpen() || (desktopReviewOpen() && activeTab() === "review")
      : store.mobileTab === "changes"
    if (!wants) return
    if (sync.data.session_diff[id] !== undefined) return
    if (sync.status === "loading") return

    void sync.session.diff(id)
  })

  createEffect(
    on(
      () =>
        [
          sessionKey(),
          isDesktop()
            ? desktopFileTreeOpen() || (desktopReviewOpen() && activeTab() === "review")
            : store.mobileTab === "changes",
        ] as const,
      ([key, wants]) => {
        if (diffFrame !== undefined) cancelAnimationFrame(diffFrame)
        if (diffTimer !== undefined) window.clearTimeout(diffTimer)
        diffFrame = undefined
        diffTimer = undefined
        if (!wants) return

        const id = params.id
        if (!id) return
        if (!untrack(() => sync.data.session_diff[id] !== undefined)) return

        diffFrame = requestAnimationFrame(() => {
          diffFrame = undefined
          diffTimer = window.setTimeout(() => {
            diffTimer = undefined
            if (sessionKey() !== key) return
            void sync.session.diff(id, { force: true })
          }, 0)
        })
      },
      { defer: true },
    ),
  )

  let treeDir: string | undefined
  createEffect(() => {
    const dir = sdk.directory
    if (!isDesktop()) return
    if (!layout.fileTree.opened()) return
    if (sync.status === "loading") return

    fileTreeTab()
    const refresh = treeDir !== dir
    treeDir = dir
    void (refresh ? file.tree.refresh("") : file.tree.list(""))
  })

  createEffect(
    on(
      () => sdk.directory,
      () => {
        void file.tree.list("")

        const tab = activeFileTab()
        if (!tab) return
        const path = file.pathFromTab(tab)
        if (!path) return
        void file.load(path, { force: true })
      },
      { defer: true },
    ),
  )

  const autoScroll = createAutoScroll({
    working: () => true,
    overflowAnchor: "dynamic",
  })

  let scrollStateFrame: number | undefined
  let scrollStateTarget: HTMLDivElement | undefined
  let fillFrame: number | undefined

  const jumpThreshold = (el: HTMLDivElement) => Math.max(400, el.clientHeight)

  const updateScrollState = (el: HTMLDivElement) => {
    const max = el.scrollHeight - el.clientHeight
    const distance = max - el.scrollTop
    const overflow = max > 1
    const bottom = !overflow || distance <= 2
    const jump = overflow && distance > jumpThreshold(el)

    if (ui.scroll.overflow === overflow && ui.scroll.bottom === bottom && ui.scroll.jump === jump) return
    setUi("scroll", { overflow, bottom, jump })
  }

  const scheduleScrollState = (el: HTMLDivElement) => {
    scrollStateTarget = el
    if (scrollStateFrame !== undefined) return

    scrollStateFrame = requestAnimationFrame(() => {
      scrollStateFrame = undefined

      const target = scrollStateTarget
      scrollStateTarget = undefined
      if (!target) return

      updateScrollState(target)
    })
  }

  const resumeScroll = () => {
    setStore("messageId", undefined)
    autoScroll.forceScrollToBottom()
    clearMessageHash()

    const el = scroller
    if (el) scheduleScrollState(el)
  }

  // When the user returns to the bottom, treat the active message as "latest".
  createEffect(
    on(
      autoScroll.userScrolled,
      (scrolled) => {
        if (scrolled) return
        setStore("messageId", undefined)
        clearMessageHash()
      },
      { defer: true },
    ),
  )

  let fill = () => {}

  const setScrollRef = (el: HTMLDivElement | undefined) => {
    scroller = el
    autoScroll.scrollRef(el)
    if (!el) return
    scheduleScrollState(el)
    fill()
  }

  const markUserScroll = () => {
    scrollMark += 1
  }

  createResizeObserver(
    () => content,
    () => {
      const el = scroller
      if (el) scheduleScrollState(el)
      fill()
    },
  )

  const historyWindow = createSessionHistoryWindow({
    sessionID: () => params.id,
    messagesReady,
    loaded: () => messages().length,
    visibleUserMessages,
    historyMore,
    historyLoading,
    loadMore: (sessionID) => sync.session.history.loadMore(sessionID),
    userScrolled: autoScroll.userScrolled,
    scroller: () => scroller,
  })

  fill = () => {
    if (fillFrame !== undefined) return

    fillFrame = requestAnimationFrame(() => {
      fillFrame = undefined

      if (!params.id || !messagesReady()) return
      if (autoScroll.userScrolled() || historyLoading()) return

      const el = scroller
      if (!el) return
      if (el.scrollHeight > el.clientHeight + 1) return
      if (historyWindow.turnStart() <= 0 && !historyMore()) return

      void historyWindow.loadAndReveal()
    })
  }

  createEffect(
    on(
      () =>
        [
          params.id,
          messagesReady(),
          historyWindow.turnStart(),
          historyMore(),
          historyLoading(),
          autoScroll.userScrolled(),
          visibleUserMessages().length,
        ] as const,
      ([id, ready, start, more, loading, scrolled]) => {
        if (!id || !ready || loading || scrolled) return
        if (start <= 0 && !more) return
        fill()
      },
      { defer: true },
    ),
  )

  const draft = (id: string) =>
    extractPromptFromParts(sync.data.part[id] ?? [], {
      directory: sdk.directory,
      attachmentName: language.t("common.attachment"),
    })

  const line = (id: string) => {
    const text = draft(id)
      .map((part) => (part.type === "image" ? `[image:${part.filename}]` : part.content))
      .join("")
      .replace(/\s+/g, " ")
      .trim()
    if (text) return text
    return `[${language.t("common.attachment")}]`
  }

  const fail = (err: unknown) => {
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: formatServerError(err, language.t),
    })
  }

  const merge = (next: NonNullable<ReturnType<typeof info>>) =>
    sync.set("session", (list) => {
      const idx = list.findIndex((item) => item.id === next.id)
      if (idx < 0) return list
      const out = list.slice()
      out[idx] = next
      return out
    })

  const roll = (sessionID: string, next: NonNullable<ReturnType<typeof info>>["revert"]) =>
    sync.set("session", (list) => {
      const idx = list.findIndex((item) => item.id === sessionID)
      if (idx < 0) return list
      const out = list.slice()
      out[idx] = { ...out[idx], revert: next }
      return out
    })

  const busy = (sessionID: string) => {
    if ((sync.data.session_status[sessionID] ?? { type: "idle" as const }).type !== "idle") return true
    return (sync.data.message[sessionID] ?? []).some(
      (item) => item.role === "assistant" && typeof item.time.completed !== "number",
    )
  }

  const queuedFollowups = createMemo(() => {
    const id = params.id
    if (!id) return emptyFollowups
    return followup.items[id] ?? emptyFollowups
  })

  const editingFollowup = createMemo(() => {
    const id = params.id
    if (!id) return
    return followup.edit[id]
  })

  const sendingFollowup = createMemo(() => {
    const id = params.id
    if (!id) return
    return followup.sending[id]
  })

  const queueEnabled = createMemo(() => {
    const id = params.id
    if (!id) return false
    return settings.general.followup() === "queue" && busy(id) && !composer.blocked()
  })

  const followupText = (item: FollowupDraft) => {
    const text = item.prompt
      .map((part) => {
        if (part.type === "image") return `[image:${part.filename}]`
        if (part.type === "file") return `[file:${part.path}]`
        if (part.type === "agent") return `@${part.name}`
        return part.content
      })
      .join("")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => !!line)

    if (text) return text
    return `[${language.t("common.attachment")}]`
  }

  const queueFollowup = (draft: FollowupDraft) => {
    setFollowup("items", draft.sessionID, (items) => [
      ...(items ?? []),
      { id: Identifier.ascending("message"), ...draft },
    ])
    setFollowup("failed", draft.sessionID, undefined)
    setFollowup("paused", draft.sessionID, undefined)
  }

  const followupDock = createMemo(() => queuedFollowups().map((item) => ({ id: item.id, text: followupText(item) })))

  const sendFollowup = (sessionID: string, id: string, opts?: { manual?: boolean }) => {
    const item = (followup.items[sessionID] ?? []).find((entry) => entry.id === id)
    if (!item) return Promise.resolve()
    if (followup.sending[sessionID]) return Promise.resolve()

    if (opts?.manual) setFollowup("paused", sessionID, undefined)
    setFollowup("sending", sessionID, id)
    setFollowup("failed", sessionID, undefined)

    return sendFollowupDraft({
      client: sdk.client,
      sync,
      globalSync,
      draft: item,
      optimisticBusy: item.sessionDirectory === sdk.directory,
    })
      .then((ok) => {
        if (ok === false) return
        setFollowup("items", sessionID, (items) => (items ?? []).filter((entry) => entry.id !== id))
        if (opts?.manual) resumeScroll()
      })
      .catch((err) => {
        setFollowup("failed", sessionID, id)
        fail(err)
      })
      .finally(() => {
        setFollowup("sending", sessionID, (value) => (value === id ? undefined : value))
      })
  }

  const editFollowup = (id: string) => {
    const sessionID = params.id
    if (!sessionID) return
    if (followup.sending[sessionID]) return

    const item = queuedFollowups().find((entry) => entry.id === id)
    if (!item) return

    setFollowup("items", sessionID, (items) => (items ?? []).filter((entry) => entry.id !== id))
    setFollowup("failed", sessionID, (value) => (value === id ? undefined : value))
    setFollowup("edit", sessionID, {
      id: item.id,
      prompt: item.prompt,
      context: item.context,
    })
  }

  const clearFollowupEdit = () => {
    const id = params.id
    if (!id) return
    setFollowup("edit", id, undefined)
  }

  const halt = (sessionID: string) =>
    busy(sessionID) ? sdk.client.session.abort({ sessionID }).catch(() => {}) : Promise.resolve()

  const fork = (input: { sessionID: string; messageID: string }) => {
    const value = draft(input.messageID)
    const dir = base64Encode(sdk.directory)
    return sdk.client.session
      .fork(input)
      .then((result) => {
        const next = result.data
        if (!next) {
          showToast({
            variant: "error",
            title: language.t("common.requestFailed"),
          })
          return
        }
        prompt.set(value, undefined, { dir, id: next.id })
        navigate(`/${dir}/session/${next.id}`)
      })
      .catch(fail)
  }

  const revert = (input: { sessionID: string; messageID: string }) => {
    if (ui.reverting || ui.restoring) return
    const prev = prompt.current().slice()
    const last = info()?.revert
    const value = draft(input.messageID)
    batch(() => {
      setUi("reverting", true)
      roll(input.sessionID, { messageID: input.messageID })
      prompt.set(value)
    })
    return halt(input.sessionID)
      .then(() => sdk.client.session.revert(input))
      .then((result) => {
        if (result.data) merge(result.data)
      })
      .catch((err) => {
        batch(() => {
          roll(input.sessionID, last)
          prompt.set(prev)
        })
        fail(err)
      })
      .finally(() => {
        setUi("reverting", false)
      })
  }

  const restore = (id: string) => {
    const sessionID = params.id
    if (!sessionID || ui.restoring || ui.reverting) return

    const next = userMessages().find((item) => item.id > id)
    const prev = prompt.current().slice()
    const last = info()?.revert

    batch(() => {
      setUi("restoring", id)
      setUi("reverting", true)
      roll(sessionID, next ? { messageID: next.id } : undefined)
      if (next) {
        prompt.set(draft(next.id))
        return
      }
      prompt.reset()
    })

    const task = !next
      ? halt(sessionID).then(() => sdk.client.session.unrevert({ sessionID }))
      : halt(sessionID).then(() =>
          sdk.client.session.revert({
            sessionID,
            messageID: next.id,
          }),
        )

    return task
      .then((result) => {
        if (result.data) merge(result.data)
      })
      .catch((err) => {
        batch(() => {
          roll(sessionID, last)
          prompt.set(prev)
        })
        fail(err)
      })
      .finally(() => {
        batch(() => {
          setUi("restoring", (value) => (value === id ? undefined : value))
          setUi("reverting", false)
        })
      })
  }

  const rolled = createMemo(() => {
    const id = revertMessageID()
    if (!id) return []
    return userMessages()
      .filter((item) => item.id >= id)
      .map((item) => ({ id: item.id, text: line(item.id) }))
  })

  const actions = { fork, revert }

  createEffect(() => {
    const sessionID = params.id
    if (!sessionID) return

    const item = queuedFollowups()[0]
    if (!item) return
    if (followup.sending[sessionID]) return
    if (followup.failed[sessionID] === item.id) return
    if (followup.paused[sessionID]) return
    if (composer.blocked()) return
    if (busy(sessionID)) return

    void sendFollowup(sessionID, item.id)
  })

  createResizeObserver(
    () => promptDock,
    ({ height }) => {
      const next = Math.ceil(height)

      if (next === dockHeight) return

      const el = scroller
      const delta = next - dockHeight
      const stick = el
        ? !autoScroll.userScrolled() || el.scrollHeight - el.clientHeight - el.scrollTop < 10 + Math.max(0, delta)
        : false

      dockHeight = next

      if (stick) autoScroll.forceScrollToBottom()

      if (el) scheduleScrollState(el)
      fill()
    },
  )

  const { clearMessageHash, scrollToMessage } = useSessionHashScroll({
    sessionKey,
    sessionID: () => params.id,
    messagesReady,
    visibleUserMessages,
    historyMore,
    historyLoading,
    loadMore: (sessionID: string) => sync.session.history.loadMore(sessionID),
    turnStart: historyWindow.turnStart,
    currentMessageId: () => store.messageId,
    pendingMessage: () => ui.pendingMessage,
    setPendingMessage: (value) => setUi("pendingMessage", value),
    setActiveMessage,
    setTurnStart: historyWindow.setTurnStart,
    autoScroll,
    scroller: () => scroller,
    anchor,
    scheduleScrollState,
    consumePendingMessage: layout.pendingMessage.consume,
  })

  onMount(() => {
    document.addEventListener("keydown", handleKeyDown)
  })

  onCleanup(() => {
    document.removeEventListener("keydown", handleKeyDown)
    if (reviewFrame !== undefined) cancelAnimationFrame(reviewFrame)
    if (refreshFrame !== undefined) cancelAnimationFrame(refreshFrame)
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
    if (diffFrame !== undefined) cancelAnimationFrame(diffFrame)
    if (diffTimer !== undefined) window.clearTimeout(diffTimer)
    if (scrollStateFrame !== undefined) cancelAnimationFrame(scrollStateFrame)
    if (fillFrame !== undefined) cancelAnimationFrame(fillFrame)
  })

  // Publish Workflow module chrome to the parent UnifiedShell via the
  // shell bridge — header (session title), Rail sub-list (tasks under
  // Workflow), Tasks Drawer (same data, fuller card view), badge
  // (running task count), + "New task" handler.
  const shell = useShellBridge()

  // Listen for "open node in tab" events fired from the React workflow
  // canvas (when the user clicks a node's drill-in arrow). We push the
  // node into `workflowOpenTabs` (so the substrip renders a closable
  // tab card for it) and switch the active tab to that node. Idempotent:
  // re-opening an already-open node just reactivates its tab.
  onMount(() => {
    const onOpen = (ev: Event) => {
      const ce = ev as CustomEvent<{ id: string; kind: "node" | "sand"; title: string }>
      const d = ce.detail
      if (!d?.id) return
      const sid = params.id
      if (!sid) return
      const tabId = `${d.kind}:${d.id}`
      const existing = (store.workflowOpenTabs[sid] ?? []).find(
        (t) => t.id === d.id && t.kind === d.kind,
      )
      if (!existing) {
        setStore("workflowOpenTabs", sid, (prev) => [
          ...(prev ?? []),
          { id: d.id, kind: d.kind, title: d.title },
        ])
      }
      setStore("workflowTab", tabId)
    }
    window.addEventListener("rune:wf:open-node", onOpen as EventListener)
    onCleanup(() => window.removeEventListener("rune:wf:open-node", onOpen as EventListener))
  })

  /* Bridge the unified-shell substrip tab choice (`store.workflowTab`)
   * onto the legacy `store.workflow` view ("graph" | "session"). The
   * existing Match conditions at the bottom of this component still key
   * off `store.workflow`; this keeps both values in lockstep so clicking
   * "Chat" / "Canvas" in the shell drives the body switch.
   *
   * Also: if a session lacks a workflow snapshot (TUI-created session,
   * orchestrator pre-plan), force the active tab to "chat" — Canvas /
   * Events have nothing meaningful to render in that case, so leaving
   * the user stuck on "Canvas" with an empty body was confusing. */
  createEffect(() => {
    const tab = store.workflowTab
    if (tab === "chat") setStore("workflow", "session")
    else if (tab === "canvas" || tab === "events" || tab.startsWith("node:") || tab.startsWith("sand:")) {
      setStore("workflow", "graph")
    }
  })
  createEffect(() => {
    if (!params.id) return
    if (workflowReady() && !workflowSnapshot()) {
      const t = store.workflowTab
      if (t === "canvas" || t === "events") setStore("workflowTab", "chat")
    }
  })
  const rootSessions = createMemo(() => {
    const all = sync.data.session ?? []
    const hidden = pendingDeletes()
    return all
      .filter((s) => !s.parentID && !s.time?.archived && !hidden.has(s.id))
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
      .slice(0, 60)
  })
  const rootAgentOptions = createMemo(() =>
    local.agent
      .list()
      .filter((agent) => agent.mode !== "subagent")
      .map((agent) => ({
        name: agent.name,
        description: agent.description,
      })),
  )
  // Heuristic for "running": session updated within the last 60s. We don't
  // have an explicit running flag on the session record, so freshness is
  // the proxy. Stable for the rail badge signal.
  const runningCount = createMemo(() => {
    const now = Date.now()
    return rootSessions().filter((s) => (s.time?.updated ?? 0) > now - 60_000).length
  })
  createEffect(() => {
    const snap = workflowSnapshot()
    const tone = snap?.workflow.status?.toLowerCase() ?? ""
    const isRunning = tone.includes("run")
    const isPaused = tone.includes("pause") || tone.includes("wait")
    const totalNodes = snap?.nodes?.length ?? 0
    const doneNodes =
      snap?.nodes?.filter((n) => /(done|complete|success)/i.test(n.status)).length ?? 0
    const stageLabel = snap?.runtime?.phase ?? snap?.workflow.status ?? "idle"
    shell.setChrome({
      header: {
        parent: "Workflow",
        title: info()?.title ?? (params.id ? "Session" : "New session"),
        // Design-spec: STAGE / NODES meta after the breadcrumb.
        meta: [
          { k: "STAGE", v: String(stageLabel) },
          { k: "NODES", v: `${doneNodes}/${totalNodes}` },
          ...(() => {
            // Master-session token usage — same metric the per-session
            // Context tab uses, surfaced here so the user can watch
            // context fill up at a glance without leaving the workflow.
            try {
              const msgs = sync.data.message[params.id ?? ""] ?? []
              if (msgs.length === 0) return []
              const metrics = getSessionContextMetrics(msgs, providers.all() as never)
              const ctx = metrics.context
              if (!ctx) return []
              const fmt = (n: number) =>
                n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M`
                : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K`
                : String(n)
              const items: Array<{ k: string; v: string }> = []
              items.push({ k: "CTX", v: ctx.limit ? `${fmt(ctx.total)}/${fmt(ctx.limit)}` : fmt(ctx.total) })
              if (ctx.input != null) items.push({ k: "IN", v: fmt(ctx.input) })
              if (ctx.output != null) items.push({ k: "OUT", v: fmt(ctx.output) })
              return items
            } catch {
              return []
            }
          })(),
        ],
        // Design-spec: Replay + Pause/Run buttons before the Tasks toggle.
        // The runtime panel exposes these via the workflow runtime; we
        // dispatch via a global event the WorkflowRuntimePanel listens for,
        // since session.tsx doesn't directly hold the run handlers.
        actions: (
          <>
            <button
              type="button"
              class="rune-btn"
              data-size="sm"
              onClick={() =>
                window.dispatchEvent(new CustomEvent("rune:wf:replay"))
              }
              title="Replay workflow from start"
            >
              ↻ Replay
            </button>
            <Show
              when={isRunning}
              fallback={
                <button
                  type="button"
                  class="rune-btn"
                  data-size="sm"
                  data-variant="primary"
                  onClick={() =>
                    window.dispatchEvent(new CustomEvent("rune:wf:run"))
                  }
                  title={isPaused ? "Resume workflow" : "Run workflow"}
                >
                  ▶ {isPaused ? "Resume" : "Run"}
                </button>
              }
            >
              <button
                type="button"
                class="rune-btn"
                data-size="sm"
                data-variant="primary"
                onClick={() =>
                  window.dispatchEvent(new CustomEvent("rune:wf:pause"))
                }
                title="Pause workflow"
              >
                ⏸ Pause
              </button>
            </Show>
          </>
        ),
      },
      // Design-spec: Canvas / Chat / Events fixed tabs + browser-tab-style
      // dynamic tabs for each opened node / sand-table session. Click ×
      // on a dynamic tab to close it; the body switches back to the
      // previous fixed tab (canvas) when the active tab is closed.
      //
      // For TUI / master pre-plan sessions (no workflow snapshot yet),
      // only the Chat tab is meaningful — Canvas / Events would render
      // an empty body. Hide them in that case so the substrip stays
      // honest about what the session can show.
      substrip: {
        tabs: [
          ...(snap ? [{ id: "canvas", name: "Canvas" }] : []),
          { id: "chat", name: "Chat" },
          ...(snap ? [{ id: "events", name: "Events", count: snap?.events?.length }] : []),
          ...((params.id && store.workflowOpenTabs[params.id]) || []).map((t) => ({
            id: `${t.kind}:${t.id}`,
            // Resolve the tab title from the bound child session whenever
            // possible — `session.title` is auto-generated from the first
            // user message and the user can rename it from the chat view,
            // so following it makes opened-node tabs distinguishable. The
            // planner-emitted node title is the fallback when the node
            // hasn't been started yet (no session_id) or when the session
            // is still on its default ISO-timestamp title.
            name: (() => {
              const snap = workflowSnapshot()
              const node = snap?.nodes?.find((n) => n.id === t.id)
              const sid = node?.session_id
              const sess = sid
                ? (sync.data.session ?? []).find((s) => s.id === sid)
                : undefined
              const title = sess?.title && !isDefaultSessionTitle(sess.title) ? sess.title : t.title
              return distillTitle(title || t.title, 18)
            })(),
            onClose: () => {
              const sid = params.id
              if (!sid) return
              setStore("workflowOpenTabs", sid, (prev) =>
                (prev ?? []).filter((x) => x.id !== t.id),
              )
              if (store.workflowTab === `${t.kind}:${t.id}`) {
                setStore("workflowTab", snap ? "canvas" : "chat")
              }
            },
          })),
        ],
        active: store.workflowTab,
        onTab: (id: string) => setStore("workflowTab", id),
        // Design-spec right cluster: search input (200px) + model picker
        // chip (state dot + label + chevron) + theme toggle. Search is a
        // pass-through that dispatches a global event for now; downstream
        // can listen and apply a filter. Model picker re-uses the unified
        // RuneModelPicker so it matches the refiner / retrieve modules.
        right: (
          <div class="rune-row rune-gap-2">
            <div class="rune-search-input">
              <span class="rune-search-icon" aria-hidden>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="7" cy="7" r="4.5" />
                  <path d="M11 11l3 3" />
                </svg>
              </span>
              <input
                type="text"
                placeholder="search…"
                onInput={(e) =>
                  window.dispatchEvent(
                    new CustomEvent("rune:wf:search", { detail: e.currentTarget.value }),
                  )
                }
              />
            </div>
            <RuneAgentPicker
              current={local.agent.current()?.name}
              agents={rootAgentOptions()}
              onChange={(agent) => local.agent.set(agent)}
            />
            <RuneModelPicker
              current={(() => {
                const m = local.model.current()
                return m ? { providerID: m.providerID, modelID: m.id } : undefined
              })()}
              onChange={(m) => {
                local.model.set({ providerID: m.providerID, modelID: m.modelID } as never)
              }}
            />
          </div>
        ),
      },
      // Tasks live both in the Rail (compact sub-list under Workflow) and
      // the right-edge Tasks Drawer (richer cards). The user wanted them
      // in the rail per the design template; the drawer stays as the
      // "all tasks at a glance" overlay.
      railSubs: rootSessions().map((s) => ({
        id: s.id,
        // Show the real (auto-generated or user-renamed) title. Sessions
        // start with a default "Parent session - <ISO>" placeholder
        // until the title agent fires on the first user message; render
        // those as "Untitled" so the rail isn't a wall of identical
        // timestamps when several tasks are still warming up.
        title: isDefaultSessionTitle(s.title) ? "Untitled" : (s.title || "Untitled"),
        onDelete: () => void deleteWorkflowTask(s.id),
      })),
      activeSubId: params.id,
      onPickSub: (id: string) => {
        const dir = params.dir ?? base64Encode(sdk.directory)
        navigate(`/${dir}/session/${id}`)
      },
      tasks: rootSessions().map((s) => ({
        id: s.id,
        title: isDefaultSessionTitle(s.title) ? "Untitled" : (s.title || "Untitled"),
        state: "idle" as const,
        time: s.time?.updated
          ? new Date(s.time.updated).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })
          : undefined,
      })),
      activeTaskId: params.id,
      onPickTask: (id: string) => {
        const dir = params.dir ?? base64Encode(sdk.directory)
        navigate(`/${dir}/session/${id}`)
      },
      onCreateTask: () => void newWorkflowTask(),
      railBadges: runningCount() > 0 ? { workflow: runningCount() } : undefined,
      // Bottom status bar — design spec puts the live-state pill here
      // (READY/RUNNING) along with session id, model, ctx and graph rev.
      status: (() => {
        const snap = workflowSnapshot()
        const tone = snap?.workflow.status?.toLowerCase() ?? ""
        const state: "ready" | "running" | "paused" | "failed" = tone.includes("run")
          ? "running"
          : tone.includes("pause") || tone.includes("wait")
            ? "paused"
            : tone.includes("fail")
              ? "failed"
              : "ready"
        const m = local.model.current()
        const modelLabel = m ? `${m.providerID}/${m.id}` : undefined
        return {
          state,
          sessionId: params.id,
          model: modelLabel,
          rev: snap?.workflow.graph_rev,
        }
      })(),
    })
  })
  onCleanup(() => shell.setChrome({}))

  return (
    <>
    <Switch>
      <Match when={params.id && !workflowReady()}>
        <div class="flex size-full min-h-0 flex-col bg-gradient-to-br from-background via-background to-muted/20">
          <div class="h-14 border-b border-border/50 bg-background/80 px-6 backdrop-blur-sm" />
          <div class="flex-1 overflow-hidden">
            <div class="flex h-full gap-px bg-border/30">
              <div class="flex-1 bg-background/40 px-8 py-8">
                <div class="mx-auto flex max-w-2xl flex-col gap-6">
                  <div class="h-20 rounded-xl bg-background/70 shadow-md" />
                  <div class="mx-auto h-8 w-6 rounded-full bg-muted/40" />
                  <div class="h-20 rounded-xl bg-background/70 shadow-md" />
                  <div class="mx-auto h-8 w-6 rounded-full bg-muted/40" />
                  <div class="h-20 rounded-xl bg-background/70 shadow-md" />
                </div>
              </div>
              <div class="w-[420px] border-l border-border/50 bg-background/60 px-6 py-6 backdrop-blur-sm">
                <div class="space-y-4">
                  <div class="h-28 rounded-xl bg-muted/30" />
                  <div class="h-20 rounded-xl bg-muted/20" />
                  <div class="h-20 rounded-xl bg-muted/20" />
                </div>
              </div>
            </div>
          </div>
          <div class="h-80 border-t border-emerald-500/20 bg-background/95 shadow-2xl backdrop-blur-sm" />
        </div>
      </Match>
      <Match when={params.id && workflowSnapshot() && workflowRootSelected()}>
        {/* Root session of a workflow → full hand-off to the React
         * WorkflowApp (TopBar + Canvas/Chat/Events body + own composer).
         * This branch used to gate on `store.workflow === "graph"`, which
         * made the Chat tab fall through to the legacy MessageTimeline —
         * losing the React ChatPanel design (monitor + plan chip +
         * sand-table cards). The substrip's `workflowTab` is forwarded
         * so the React side renders the right tab body. */}
        <div class="size-full overflow-hidden bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.08),transparent_32%),radial-gradient(circle_at_top_right,rgba(59,130,246,0.08),transparent_28%),linear-gradient(180deg,#f8fafc_0%,#eef2f7_100%)]">
          <WorkflowRuntimePanel
            snapshot={workflowSnapshot()!}
            currentSessionID={params.id}
            onSelectSession={selectWorkflowSession}
            onSelectRootView={selectWorkflowRoot}
            onNewTask={() => void newWorkflowTask()}
            onWorkspaceClick={pickWorkspace}
            workflowTab={store.workflowTab}
          />
        </div>
      </Match>
      <Match when={true}>
        <div class="relative bg-background-base size-full overflow-hidden flex flex-col">
          {sessionSync() ?? ""}
          <SessionHeader />
          <div class="flex-1 min-h-0 flex flex-col md:flex-row">
            <Show when={!isDesktop() && !!params.id}>
              <Tabs value={store.mobileTab} class="h-auto">
                <Tabs.List>
                  <Tabs.Trigger
                    value="session"
                    class="!w-1/2 !max-w-none"
                    classes={{ button: "w-full" }}
                    onClick={() => setStore("mobileTab", "session")}
                  >
                    {language.t("session.tab.session")}
                  </Tabs.Trigger>
                  <Tabs.Trigger
                    value="changes"
                    class="!w-1/2 !max-w-none !border-r-0"
                    classes={{ button: "w-full" }}
                    onClick={() => setStore("mobileTab", "changes")}
                  >
                    {hasReview()
                      ? language.t("session.review.filesChanged", { count: reviewCount() })
                      : language.t("session.review.change.other")}
                  </Tabs.Trigger>
                </Tabs.List>
              </Tabs>
            </Show>

            {/* Session panel */}
            <div
              classList={{
                "@container relative shrink-0 flex flex-col min-h-0 h-full bg-background-stronger flex-1 md:flex-none": true,
                "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
                  !size.active() && !ui.reviewSnap,
              }}
              style={{
                width: sessionPanelWidth(),
              }}
            >
              <Show when={params.id && workflowSnapshot()}>
                <WorkflowSessionStrip
                  snapshot={workflowSnapshot()!}
                  currentSessionID={params.id}
                  rootView={store.workflow}
                  onSelectRootView={selectWorkflowRoot}
                  onSelectSession={selectWorkflowSession}
                />
              </Show>
              <div class="flex-1 min-h-0 overflow-hidden">
                <Switch>
                  <Match when={params.id}>
                    <Switch>
                      <Match when={workflowRootSelected() && workflowSnapshot()}>
                        <Switch>
                          <Match when={store.workflow === "session"}>
                            <Show when={lastUserMessage()}>
                              <MessageTimeline
                                mobileChanges={mobileChanges()}
                                mobileFallback={reviewContent({
                                  diffStyle: "unified",
                                  classes: {
                                    root: "pb-8",
                                    header: "px-4",
                                    container: "px-4",
                                  },
                                  loadingClass: "px-4 py-4 text-text-weak",
                                  emptyClass: "h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6",
                                })}
                                actions={actions}
                                scroll={ui.scroll}
                                onResumeScroll={resumeScroll}
                                setScrollRef={setScrollRef}
                                onScheduleScrollState={scheduleScrollState}
                                onAutoScrollHandleScroll={autoScroll.handleScroll}
                                onMarkScrollGesture={markScrollGesture}
                                hasScrollGesture={hasScrollGesture}
                                onUserScroll={markUserScroll}
                                onTurnBackfillScroll={historyWindow.onScrollerScroll}
                                onAutoScrollInteraction={autoScroll.handleInteraction}
                                centered={false}
                                setContentRef={(el) => {
                                  content = el
                                  autoScroll.contentRef(el)

                                  const root = scroller
                                  if (root) scheduleScrollState(root)
                                }}
                                turnStart={historyWindow.turnStart()}
                                historyMore={historyMore()}
                                historyLoading={historyLoading()}
                                onLoadEarlier={() => {
                                  void historyWindow.loadAndReveal()
                                }}
                                renderedUserMessages={historyWindow.renderedUserMessages()}
                                anchor={anchor}
                              />
                            </Show>
                          </Match>
                          <Match when={true}>
                            <WorkflowRuntimePanel
                              snapshot={workflowSnapshot()!}
                              currentSessionID={params.id}
                              onSelectSession={selectWorkflowSession}
                              onSelectRootView={selectWorkflowRoot}
                              onNewTask={() => void newWorkflowTask()}
                              onWorkspaceClick={pickWorkspace}
                            />
                          </Match>
                        </Switch>
                      </Match>
                      <Match when={workflowSnapshot() && store.workflowTab !== "chat"}>
                        {/* Child node session (or non-root view) under a
                         * workflow — when the user picks Canvas / Events
                         * (or a dynamic node:/sand: tab) from the substrip,
                         * render the workflow runtime panel inside the
                         * standard layout (composer stays at the bottom).
                         * Without this branch the user was stuck on the
                         * legacy MessageTimeline regardless of tab choice. */}
                        <WorkflowRuntimePanel
                          snapshot={workflowSnapshot()!}
                          currentSessionID={params.id}
                          onSelectSession={selectWorkflowSession}
                          onSelectRootView={selectWorkflowRoot}
                          onNewTask={() => void newWorkflowTask()}
                          onWorkspaceClick={pickWorkspace}
                          workflowTab={store.workflowTab}
                        />
                      </Match>
                      <Match when={true}>
                        <Show when={lastUserMessage()}>
                          <MessageTimeline
                            mobileChanges={mobileChanges()}
                            mobileFallback={reviewContent({
                              diffStyle: "unified",
                              classes: {
                                root: "pb-8",
                                header: "px-4",
                                container: "px-4",
                              },
                              loadingClass: "px-4 py-4 text-text-weak",
                              emptyClass: "h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6",
                            })}
                            actions={actions}
                            scroll={ui.scroll}
                            onResumeScroll={resumeScroll}
                            setScrollRef={setScrollRef}
                            onScheduleScrollState={scheduleScrollState}
                            onAutoScrollHandleScroll={autoScroll.handleScroll}
                            onMarkScrollGesture={markScrollGesture}
                            hasScrollGesture={hasScrollGesture}
                            onUserScroll={markUserScroll}
                            onTurnBackfillScroll={historyWindow.onScrollerScroll}
                            onAutoScrollInteraction={autoScroll.handleInteraction}
                            centered={centered()}
                            setContentRef={(el) => {
                              content = el
                              autoScroll.contentRef(el)

                              const root = scroller
                              if (root) scheduleScrollState(root)
                            }}
                            turnStart={historyWindow.turnStart()}
                            historyMore={historyMore()}
                            historyLoading={historyLoading()}
                            onLoadEarlier={() => {
                              void historyWindow.loadAndReveal()
                            }}
                            renderedUserMessages={historyWindow.renderedUserMessages()}
                            anchor={anchor}
                          />
                        </Show>
                      </Match>
                    </Switch>
                  </Match>
                  <Match when={true}>
                    <div class="flex h-full flex-col">
                      <Show when={local.agent.current()?.name === "orchestrator"}>
                        <div class="border-b border-border-weak-base bg-background-panel px-5 py-4">
                          <div class="flex items-center gap-2">
                            <span class="rounded-full border border-sky-500/25 bg-sky-500/8 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-sky-700 dark:text-sky-300">
                              root orchestrator session
                            </span>
                            <span class="rounded-full border border-border-weak-base px-2 py-0.5 text-[10px] font-medium text-text-weak">
                              planning mode
                            </span>
                          </div>
                          <div class="mt-2 text-13-medium text-text-strong">
                            The workflow is created only after your first query is planned and confirmed.
                          </div>
                          <div class="mt-1 text-12-regular text-text-weak">
                            Start with the requirement, let the orchestrator iterate on the plan, then confirm execution to create node sessions.
                          </div>
                        </div>
                      </Show>
                      <div class="min-h-0 flex-1">
                        <NewSessionView worktree={newSessionWorktree()} />
                      </div>
                    </div>
                  </Match>
                </Switch>
              </div>

              <Show when={!graph()}>
                <SessionComposerRegion
                  state={composer}
                  ready={!store.deferRender && messagesReady()}
                  centered={centered()}
                  inputRef={(el) => {
                    inputRef = el
                  }}
                  newSessionWorktree={newSessionWorktree()}
                  onNewSessionWorktreeReset={() => setStore("newSessionWorktree", "main")}
                  onSubmit={() => {
                    comments.clear()
                    resumeScroll()
                  }}
                  onResponseSubmit={resumeScroll}
                  followup={
                    params.id
                      ? {
                          queue: queueEnabled,
                          items: followupDock(),
                          sending: sendingFollowup(),
                          edit: editingFollowup(),
                          onQueue: queueFollowup,
                          onAbort: () => {
                            const id = params.id
                            if (!id) return
                            setFollowup("paused", id, true)
                          },
                          onSend: (id) => {
                            void sendFollowup(params.id!, id, { manual: true })
                          },
                          onEdit: editFollowup,
                          onEditLoaded: clearFollowupEdit,
                        }
                      : undefined
                  }
                  revert={
                    rolled().length > 0
                      ? {
                          items: rolled(),
                          restoring: ui.restoring,
                          disabled: ui.reverting,
                          onRestore: restore,
                        }
                      : undefined
                  }
                  setPromptDockRef={(el) => {
                    promptDock = el
                  }}
                />
              </Show>

              <Show when={desktopReviewOpen() && !graph()}>
                <div onPointerDown={() => size.start()}>
                  <ResizeHandle
                    direction="horizontal"
                    size={layout.session.width()}
                    min={450}
                    max={typeof window === "undefined" ? 1000 : window.innerWidth * 0.45}
                    onResize={(width) => {
                      size.touch()
                      layout.session.resize(width)
                    }}
                  />
                </div>
              </Show>
            </div>

            <SessionSidePanel
              hide={graph}
              reviewPanel={reviewPanel}
              activeDiff={tree.activeDiff}
              focusReviewDiff={focusReviewDiff}
              reviewSnap={ui.reviewSnap}
              size={size}
              diffs={resolvedDiffs}
              hasReview={resolvedHasReview}
              reviewCount={resolvedReviewCount}
              diffsReady={resolvedDiffsReady}
            />
          </div>

          <TerminalPanel />
        </div>
      </Match>
    </Switch>
    </>
  )
}
