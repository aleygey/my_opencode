import "@/index.css"
import { I18nProvider } from "@opencode-ai/ui/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { File } from "@opencode-ai/ui/file"
import { Font } from "@opencode-ai/ui/font"
import { Splash } from "@opencode-ai/ui/logo"
import { ThemeProvider } from "@opencode-ai/ui/theme/context"
import { MetaProvider } from "@solidjs/meta"
import { type BaseRouterProps, Navigate, Route, Router, useLocation, useNavigate } from "@solidjs/router"
import { UnifiedShell } from "@/components/unified-shell"
import { ShellBridgeProvider, useShellBridge } from "@/components/unified-shell/shell-bridge"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import type { PermissionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { Effect } from "effect"
import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  ErrorBoundary,
  For,
  type JSX,
  lazy,
  onCleanup,
  onMount,
  type ParentProps,
  Show,
  Suspense,
  Switch,
  Match,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { CommandProvider } from "@/context/command"
import { CommentsProvider } from "@/context/comments"
import { FileProvider } from "@/context/file"
import { GlobalSDKProvider } from "@/context/global-sdk"
import { GlobalSyncProvider } from "@/context/global-sync"
import { HighlightsProvider } from "@/context/highlights"
import { LanguageProvider, type Locale, useLanguage } from "@/context/language"
import { LayoutProvider } from "@/context/layout"
import { LocalProvider } from "@/context/local"
import { ModelsProvider } from "@/context/models"
import { NotificationProvider } from "@/context/notification"
import { PermissionProvider, usePermission } from "@/context/permission"
import { usePlatform } from "@/context/platform"
import { PromptProvider } from "@/context/prompt"
import { ServerConnection, ServerProvider, serverName, useServer } from "@/context/server"
import { SettingsProvider } from "@/context/settings"
import { useSettings } from "@/context/settings"
import { SDKProvider } from "@/context/sdk"
import { SyncProvider } from "@/context/sync"
import { TerminalProvider } from "@/context/terminal"
import {
  createWorkflowRuntime,
  type WorkflowSnapshot,
  WorkflowRuntimePanel,
} from "@/pages/session/workflow-panel"
import type { Task } from "@/react-workflow/components/task-sidebar"
import DirectoryLayout from "@/pages/directory-layout"
import Layout from "@/pages/layout"
import { ErrorPage } from "./pages/error"
import { useCheckServerHealth } from "./utils/server-health"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { DialogSelectDirectory } from "@/components/dialog-select-directory"
import { base64Encode } from "@opencode-ai/shared/util/encode"

const HomeRoute = lazy(() => import("@/pages/home"))
const loadSession = () => import("@/pages/session")
const loadRefinerPage = () => import("@/pages/session/refiner-page")
const loadRetrievePage = () => import("@/pages/session/retrieve-page")
const Session = lazy(loadSession)
const RefinerPage = lazy(loadRefinerPage)
const RetrievePage = lazy(loadRetrievePage)
const Loading = () => <div class="size-full" />

if (typeof location === "object" && /\/session(?:\/|$)/.test(location.pathname)) {
  void loadSession()
  if (/\/refiner(?:\/|$)/.test(location.pathname)) void loadRefinerPage()
  if (/\/retrieve(?:\/|$)/.test(location.pathname)) void loadRetrievePage()
}

/**
 * SessionShellRoute — parent route under /:dir/session/:id that mounts
 * SessionProviders + UnifiedShell + ShellBridgeProvider exactly once.
 *
 * The three child routes (workflow / refiner / retrieve) render only
 * their body via `props.children` — the shell stays mounted across rail
 * navigation, so switching modules feels like in-page tab switching
 * rather than a page jump. Each child publishes its chrome (header /
 * substrip / rail subs / tasks) through useShellBridge() into the
 * ShellBridgeProvider, which the shell consumes via reactive memos.
 */
const SessionShellRoute = (props: ParentProps) => (
  <SessionProviders>
    <ShellBridgeProvider>
      <SessionShellMount>{props.children}</SessionShellMount>
    </ShellBridgeProvider>
  </SessionProviders>
)

const SessionRoute = () => <Session />
const RefinerRoute = () => <RefinerPage />
const RetrieveRoute = () => <RetrievePage />

/** Renders the UnifiedShell with chrome props sourced from the shell-bridge.
 *  The bridge holds a signal updated by each child page; the shell reads
 *  reactively. The shell mounts ONCE and stays mounted across child route
 *  changes — the user sees an in-page tab switch instead of a full
 *  page transition. */
function SessionShellMount(props: ParentProps) {
  const bridge = useShellBridge()
  const location = useLocation()
  const moduleId = createMemo<"workflow" | "knowledge" | "trace">(() => {
    const p = location.pathname
    if (p.endsWith("/refiner")) return "knowledge"
    if (p.endsWith("/retrieve")) return "trace"
    return "workflow"
  })
  const chrome = bridge.chrome
  return (
    <UnifiedShell
      module={moduleId()}
      header={chrome().header}
      substrip={chrome().substrip}
      railSubs={chrome().railSubs}
      activeSubId={chrome().activeSubId}
      onPickSub={chrome().onPickSub}
      railBadges={chrome().railBadges}
      tasks={chrome().tasks}
      activeTaskId={chrome().activeTaskId}
      onPickTask={chrome().onPickTask}
      onCreateTask={chrome().onCreateTask}
      status={chrome().status}
    >
      {props.children}
    </UnifiedShell>
  )
}

const SessionIndexRoute = () => <Navigate href="session" />

function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return <I18nProvider value={{ locale: language.intl, t: language.t }}>{props.children}</I18nProvider>
}

declare global {
  interface Window {
    __OPENCODE__?: {
      updaterEnabled?: boolean
      deepLinks?: string[]
      wsl?: boolean
    }
    api?: {
      setTitlebar?: (theme: { mode: "light" | "dark" }) => Promise<void>
    }
  }
}

function QueryProvider(props: ParentProps) {
  const client = new QueryClient()
  return <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
}

function AppShellProviders(props: ParentProps) {
  return (
    <SettingsProvider>
      <PermissionProvider>
        <LayoutProvider>
          <NotificationProvider>
            <ModelsProvider>
              <CommandProvider>
                <HighlightsProvider>
                  <Layout>{props.children}</Layout>
                </HighlightsProvider>
              </CommandProvider>
            </ModelsProvider>
          </NotificationProvider>
        </LayoutProvider>
      </PermissionProvider>
    </SettingsProvider>
  )
}

function WorkflowShellProviders(props: ParentProps) {
  return (
    <SettingsProvider>
      <PermissionProvider>
        <LayoutProvider>
          <NotificationProvider>
            <ModelsProvider>
              <CommandProvider>
                <HighlightsProvider>{props.children}</HighlightsProvider>
              </CommandProvider>
            </ModelsProvider>
          </NotificationProvider>
        </LayoutProvider>
      </PermissionProvider>
    </SettingsProvider>
  )
}

function SessionProviders(props: ParentProps) {
  return (
    <TerminalProvider>
      <FileProvider>
        <PromptProvider>
          <CommentsProvider>{props.children}</CommentsProvider>
        </PromptProvider>
      </FileProvider>
    </TerminalProvider>
  )
}

function WorkflowProviders(props: ParentProps<{ dir: string }>) {
  return (
    <SDKProvider directory={() => props.dir}>
      <SyncProvider>
        <LocalProvider>{props.children}</LocalProvider>
      </SyncProvider>
    </SDKProvider>
  )
}

function RouterRoot(props: ParentProps<{ appChildren?: JSX.Element }>) {
  return (
    <AppShellProviders>
      {/*<Suspense fallback={<Loading />}>*/}
      {props.appChildren}
      {props.children}
      {/*</Suspense>*/}
    </AppShellProviders>
  )
}

function WorkflowRoot(props: {
  task: () => string | undefined
  session: () => string | undefined
  onSession: (id: string) => void
  onTask: (id: string) => void
  onWorkspaceClick?: () => void
  onNewTask?: () => void
  onDeleteTask?: (id: string) => void
  tasks?: Task[]
}) {
  const runtime = createWorkflowRuntime({ session: props.session })
  const snap = createMemo(() => runtime.snapshot())

  return (
    <Switch>
      <Match when={!runtime.ready()}>
        <div class="flex h-dvh w-screen items-center justify-center bg-background-base">
          <Splash class="h-20 w-16 opacity-50 animate-pulse" />
        </div>
      </Match>
      <Match when={snap()}>
        {(item) => (
          <div class="h-dvh w-screen overflow-hidden bg-background-base">
            <WorkflowRuntimePanel
              snapshot={item() as WorkflowSnapshot}
              currentSessionID={props.session()}
              onSelectSession={props.onSession}
              onWorkspaceClick={props.onWorkspaceClick}
              onNewTask={props.onNewTask}
              onDeleteTask={props.onDeleteTask}
              tasks={props.tasks}
              activeTaskId={props.task()}
              onTaskSelect={props.onTask}
            />
          </div>
        )}
      </Match>
      <Match when={true}>
        <div class="flex h-dvh w-screen items-center justify-center bg-background-base px-6 text-center">
          <div class="max-w-md">
            <div class="text-16-medium text-text-strong">No workflow found</div>
            <div class="mt-2 text-14-regular text-text-weak">
              The selected root session is not attached to a workflow snapshot.
            </div>
          </div>
        </div>
      </Match>
    </Switch>
  )
}

function WorkflowScreen() {
  const server = useServer()
  const platform = usePlatform()
  const settings = useSettings()
  const dialog = useDialog()
  const global = useGlobalSDK()
  const sync = useGlobalSync()
  const permission = usePermission()
  const navigate = useNavigate()
  const [busy, setBusy] = createSignal(true)
  const [make, setMake] = createSignal("")
  const [err, setErr] = createSignal("")
  const [perm, setPerm] = createSignal<PermissionRequest[]>([])
  const [list, setList] = createSignal<Array<{ info: Session; snap: WorkflowSnapshot }>>([])
  const [task, setTask] = createSignal<string>()
  const [session, setSession] = createSignal<string>()
  const projects = createMemo(() =>
    sync.data.project
      .slice()
      .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created)),
  )
  const tone = (status: string) => {
    const value = status.toLowerCase()
    if (value.includes("fail")) return "failed"
    if (value.includes("complete") || value.includes("success")) return "completed"
    if (value.includes("run")) return "running"
    if (value.includes("pause") || value.includes("wait") || value.includes("interrupt")) return "paused"
    return "pending"
  }
  const nodeType = (title: string) => {
    if (/build|flash/i.test(title)) return "build-flash" as const
    if (/deploy/i.test(title)) return "deploy" as const
    if (/debug|test|verify/i.test(title)) return "debug" as const
    return "coding" as const
  }
  const taskStatus = (snap: WorkflowSnapshot) => {
    const flow = tone(snap.workflow.status)
    if (flow === "paused") return "paused" as const
    if (
      snap.runtime.active_node_id ||
      snap.runtime.waiting_node_ids.length > 0 ||
      snap.nodes.some((node) => tone(node.status) === "running")
    ) {
      return "running" as const
    }
    if (snap.nodes.some((node) => tone(node.status) === "failed")) return "failed" as const
    if (flow === "completed") return "completed" as const
    if (flow === "failed") return "failed" as const
    if (flow === "pending") return "idle" as const
    return "interrupted" as const
  }

  const request = async <T,>(path: string, init?: RequestInit) => {
    const now = server.current
    if (!now) throw new Error("Server unavailable")
    const head: Record<string, string> = {}
    if (now.http.password) {
      head.Authorization = `Basic ${btoa(`${now.http.username ?? "opencode"}:${now.http.password}`)}`
    }
    const run = platform.fetch ?? fetch
    const res = await run(new URL(path, now.http.url), {
      ...init,
      headers: {
        ...head,
        ...(init?.headers ?? {}),
      },
    })
    if (!res.ok) throw new Error(`Request failed: ${res.status}`)
    return (await res.json()) as T
  }

  const load = async () => {
    setBusy(true)
    setErr("")
    const all = await request<Session[]>("/session?roots=true&limit=24")
      .then((rows) => rows ?? [])
      .then((rows) =>
        Promise.all(
          rows.map((info) =>
            request<WorkflowSnapshot>(`/workflow/session/${info.id}`)
              .then((snap) => ({ info, snap }))
              .catch(() => undefined),
          ),
        ),
      )
      .then((rows) => rows.filter((item): item is { info: Session; snap: WorkflowSnapshot } => !!item))
      .catch((e) => {
        setErr(e instanceof Error ? e.message : String(e))
        return []
      })
    setList(all)
    const next = task()
    const root = next && all.some((item) => item.snap.workflow.session_id === next) ? next : all[0]?.snap.workflow.session_id
    setTask(root)
    setSession((id) => {
      if (id && all.some((item) => item.snap.workflow.session_id === root && (item.snap.workflow.session_id === id || item.snap.nodes.some((node) => node.session_id === id)))) {
        return id
      }
      return root
    })
    setBusy(false)

    // Auto-redirect to the unified-shell session route when an active
    // workflow root session is found. Without this, cold-loading the URL
    // lands on the legacy `/*all` catchall WorkflowScreen and the user
    // sees the old chrome (no rune-shell, no rail/header/status bar) —
    // they had to manually click Refiner to escape into the new layout.
    if (root) {
      const item = all.find((x) => x.snap.workflow.session_id === root)
      const dir = item?.info.directory
      if (dir) {
        navigate(`/${base64Encode(dir)}/session/${root}`, { replace: true })
      }
    }
  }

  const boot = async (dir: string, title?: string) => {
    setMake(dir)
    setErr("")
    await global
      .createClient({
        directory: dir,
        throwOnError: true,
      })
      .session.create({
        title: title || "Workflow",
      })
      .then((res) => res.data)
      .then(async (session) => {
        if (!session?.id) throw new Error("Failed to create root session")
        const sdk = global.createClient({
          directory: dir,
          throwOnError: true,
        })
        await sdk.workflow.create({
          session_id: session.id,
          title: title || session.title || "Workflow",
        })
        const snap = await sdk.workflow.session({
          sessionID: session.id,
        })
        if (!snap.data) throw new Error("Failed to load workflow snapshot")
        setList((rows) => [{ info: session, snap: snap.data! }, ...rows])
        setTask(session.id)
        setSession(session.id)
        // Jump straight into the unified-shell session route for the
        // freshly-created workflow so the user lands on the new chrome
        // (rail / header / status bar / canvas tab) rather than the
        // legacy WorkflowRoot inline render.
        navigate(`/${base64Encode(dir)}/session/${session.id}`, { replace: true })
      })
      .catch((e) => {
        setErr(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        setMake("")
      })
  }

  const switchDir = async (dir: string) => {
    const id = task()
    if (!id) {
      await boot(dir, dir.split("/").at(-1) || "Workflow")
      return
    }
    setErr("")
    await request<Session>(`/session/${id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ directory: dir }),
    })
      .then((info) => {
        setList((rows) =>
          rows.map((item) =>
            item.snap.workflow.session_id === id
              ? {
                  ...item,
                  info,
                }
              : item,
          ),
        )
      })
      .catch((e) => {
        setErr(e instanceof Error ? e.message : String(e))
      })
  }

  const pickWorkspace = () => {
    dialog.show(() => (
      <DialogSelectDirectory
        title="Select workspace"
        onSelect={(result) => {
          if (typeof result !== "string" || !result) return
          void switchDir(result)
        }}
      />
    ))
  }

  const createTask = async () => {
    const dir = pick()?.info.directory
    if (!dir) {
      pickWorkspace()
      return
    }
    await boot(dir, "Workflow")
  }
  const deleteTask = async (id: string) => {
    const rows = list()
    const pos = rows.findIndex((item) => item.snap.workflow.session_id === id)
    if (pos < 0) return
    const item = rows[pos]
    if (!item) return
    await request<boolean>(`/workflow/session/${id}`, { method: "DELETE" }).catch((e) => {
      setErr(e instanceof Error ? e.message : String(e))
      return false
    })
    const next = rows.filter((entry) => entry.snap.workflow.session_id !== id)
    setList(next)
    if (task() !== id) return
    const pick = next[pos] ?? next[pos - 1] ?? next[0]
    setTask(pick?.snap.workflow.session_id)
    setSession(pick?.snap.workflow.session_id)
  }

  onMount(() => {
    void load()
  })

  const pick = createMemo(() => {
    const id = task()
    if (!id) return list()[0]
    return list().find((item) => item.snap.workflow.session_id === id) ?? list()[0]
  })
  const dir = createMemo(() => pick()?.info.directory)
  const loadPerm = async () => {
    if (!task()) {
      setPerm([])
      return
    }
    await request<PermissionRequest[]>("/permission")
      .then((x) => {
        setPerm((x ?? []).filter((item): item is PermissionRequest => !!item?.id && !!item.sessionID))
      })
      .catch(() => {
        setPerm([])
      })
  }
  createEffect(() => {
    void loadPerm()
  })
  const stopPerm = global.event.listen((e) => {
    if (e.details?.type !== "permission.asked" && e.details?.type !== "permission.replied") return
    void loadPerm()
  })
  onCleanup(stopPerm)
  createEffect(() => {
    if (!task()) return
    const timer = setInterval(() => {
      void loadPerm()
    }, 5000)
    onCleanup(() => clearInterval(timer))
  })
  const pending = createMemo<PermissionRequest[]>(() => {
    const root = task()
    if (!root) return perm()
    const ids = new Set<string>()
    ids.add(root)
    pick()
      ?.snap.nodes.map((node) => node.session_id)
      .filter((id): id is string => !!id)
      .forEach((id) => ids.add(id))
    return perm()
      .slice()
      .sort((a, b) => {
        const av = ids.has(a.sessionID) ? 0 : 1
        const bv = ids.has(b.sessionID) ? 0 : 1
        if (av !== bv) return av - bv
        return a.id.localeCompare(b.id)
      })
  })
  const respond = (item: PermissionRequest, response: "once" | "always" | "reject") => {
    permission.respond({
      sessionID: item.sessionID,
      permissionID: item.id,
      response,
      directory: dir(),
    })
  }
  const tasks = createMemo<Task[]>(() =>
    list().map((item) => ({
      id: item.snap.workflow.session_id,
      title: item.snap.workflow.title,
      status: taskStatus(item.snap),
      duration: item.snap.runtime.phase,
      nodes: item.snap.nodes.map((node) => ({
        id: node.id,
        title: node.title,
        type: nodeType(node.title),
        status: tone(node.status),
        session: node.session_id ?? item.snap.workflow.session_id,
      })),
    })),
  )
  let prev = {} as Record<string, Task["status"]>
  createEffect(() => {
    const list = tasks()
    const next = Object.fromEntries(list.map((item) => [item.id, item.status] as const))
    for (const item of list) {
      const old = prev[item.id]
      if (!old || old === item.status) continue
      if (!settings.notifications.agent()) continue
      if (item.status === "completed") {
        void platform.notify("Task Completed", item.title)
        continue
      }
      if (item.status === "paused" || item.status === "interrupted") {
        void platform.notify("Task Paused", item.title)
      }
    }
    prev = next
  })

  return (
    <Switch>
      <Match when={busy()}>
        <div class="flex h-dvh w-screen items-center justify-center bg-background-base">
          <Splash class="h-20 w-16 opacity-50 animate-pulse" />
        </div>
      </Match>
      <Match when={pick()}>
        {(item) => (
            <div class="h-dvh w-screen overflow-hidden bg-background-base">
              <WorkflowProviders dir={item().info.directory}>
                <div class="flex h-full w-full flex-col">
                  <Show when={pending().length > 0}>
                    <div class="border-b border-amber-500/30 bg-amber-500/10 px-4 py-3">
                      <div class="flex items-center justify-between gap-3">
                        <div>
                          <div class="text-13-medium text-amber-800 dark:text-amber-200">
                            Pending permissions
                          </div>
                          <div class="mt-1 text-12-regular text-amber-700/90 dark:text-amber-200/80">
                            One or more workflow sessions are waiting for permission before tool execution can continue.
                          </div>
                        </div>
                        <button
                          type="button"
                          class="rounded-lg border border-amber-500/40 px-3 py-1.5 text-12-medium text-amber-800 transition-colors hover:bg-amber-500/10 dark:text-amber-200"
                          onClick={() => pending().forEach((item) => respond(item, "once"))}
                        >
                          Allow all once
                        </button>
                      </div>
                      <div class="mt-3 flex flex-col gap-2">
                        <For each={pending()}>
                          {(item) => (
                            <div class="flex items-start justify-between gap-3 rounded-xl border border-amber-500/20 bg-background/70 px-3 py-2">
                              <div class="min-w-0">
                                <div class="text-12-medium text-text-strong">
                                  {item.permission}
                                  <span class="ml-2 text-text-weaker">{item.sessionID}</span>
                                </div>
                                <div class="mt-1 text-12-regular text-text-weaker break-all">
                                  {(item.patterns ?? []).join(", ") || "(no pattern)"}
                                </div>
                              </div>
                              <div class="flex shrink-0 items-center gap-2">
                                <button
                                  type="button"
                                  class="rounded-lg border border-border/60 px-2.5 py-1 text-12-medium text-text-base transition-colors hover:bg-muted/30"
                                  onClick={() => respond(item, "once")}
                                >
                                  Once
                                </button>
                                <button
                                  type="button"
                                  class="rounded-lg border border-emerald-500/40 px-2.5 py-1 text-12-medium text-emerald-700 transition-colors hover:bg-emerald-500/10 dark:text-emerald-300"
                                  onClick={() => respond(item, "always")}
                                >
                                  Always
                                </button>
                                <button
                                  type="button"
                                  class="rounded-lg border border-rose-500/40 px-2.5 py-1 text-12-medium text-rose-700 transition-colors hover:bg-rose-500/10 dark:text-rose-300"
                                  onClick={() => respond(item, "reject")}
                                >
                                  Reject
                                </button>
                              </div>
                            </div>
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>
                  <div class="min-h-0 flex-1">
                    <WorkflowRoot
                      task={task}
                      session={session}
                      onSession={setSession}
                      onTask={(id) => {
                        setTask(id)
                        setSession(id)
                      }}
                      onWorkspaceClick={pickWorkspace}
                      onNewTask={() => void createTask()}
                      onDeleteTask={(id) => void deleteTask(id)}
                      tasks={tasks()}
                    />
                  </div>
                </div>
              </WorkflowProviders>
            </div>
          )}
      </Match>
      <Match when={true}>
        {/* Empty-state landing — redesigned to match the unified shell
         * tokens. The previous version used a generic Tailwind palette
         * with hard borders + emerald accents, which clashed with the
         * rest of the redesigned UI. This version sits inside a
         * `.rune-shell` host so it inherits all the typography +
         * surface tokens, and the cards use the same soft 1px-line +
         * rounded corner treatment as the workflow node cards. */}
        <div
          class="rune-shell flex h-dvh w-screen items-center justify-center px-6"
          style={{ background: "var(--rune-bg-base)", color: "var(--rune-fg)" }}
        >
          <div class="w-full max-w-3xl">
            <div class="mx-auto max-w-xl text-center">
              <div
                class="mx-auto mb-5 inline-flex h-12 w-12 items-center justify-center rounded-full"
                style={{
                  background: "var(--rune-ac-soft)",
                  color: "var(--rune-ac-text)",
                  border: "1px solid var(--rune-ac-edge)",
                }}
                aria-hidden
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="6" r="2.5" />
                  <circle cx="6" cy="18" r="2.5" />
                  <circle cx="18" cy="18" r="2.5" />
                  <path d="M12 8.5v3a2 2 0 0 1-2 2H8M12 8.5v3a2 2 0 0 0 2 2h2M8 13.5v2M16 13.5v2" />
                </svg>
              </div>
              <h1
                style={{
                  "font-family": "var(--rune-font-sans)",
                  "font-size": "22px",
                  "font-weight": 620,
                  "letter-spacing": "-0.02em",
                  "font-variation-settings": '"opsz" 24',
                  color: "var(--rune-fg)",
                  margin: 0,
                }}
              >
                Start a workflow
              </h1>
              <div
                class="mx-auto mt-2 max-w-md"
                style={{
                  "font-size": "13px",
                  "line-height": 1.6,
                  color: "var(--rune-fg-mute)",
                }}
              >
                {err() || (
                  <>
                    <span class="rune-mono" style={{ color: "var(--rune-fg-dim)" }}>
                      {server.name || server.key}
                    </span>
                    <span style={{ margin: "0 6px", color: "var(--rune-fg-faint)" }}>·</span>
                    Pick a project to bootstrap a runtime session.
                  </>
                )}
              </div>
            </div>

            <Show
              when={projects().length > 0}
              fallback={
                <div
                  class="mx-auto mt-8 max-w-md rounded-lg px-4 py-3 text-center"
                  style={{
                    border: "1px dashed var(--rune-line)",
                    background: "var(--rune-bg-surface)",
                    "font-size": "12px",
                    color: "var(--rune-fg-mute)",
                  }}
                >
                  No projects were returned by the server.
                </div>
              }
            >
              <div class="mt-7 grid gap-2.5 sm:grid-cols-2">
                <For each={projects().slice(0, 8)}>
                  {(project) => {
                    const isActive = () => make() === project.worktree
                    return (
                      <button
                        type="button"
                        class="group text-left transition-all"
                        style={{
                          border: "1px solid var(--rune-line-faint)",
                          background: "var(--rune-bg-raised)",
                          "border-radius": "10px",
                          padding: "14px 16px",
                          color: "var(--rune-fg)",
                          "box-shadow": "0 1px 2px rgba(15, 23, 42, 0.04)",
                          cursor: make() ? "default" : "pointer",
                          opacity: make() && !isActive() ? 0.55 : 1,
                        }}
                        disabled={!!make()}
                        onClick={() =>
                          void boot(
                            project.worktree,
                            project.name || project.worktree.split("/").at(-1) || "Workflow",
                          )
                        }
                        onMouseEnter={(e) => {
                          if (!make()) e.currentTarget.style.borderColor = "var(--rune-ac-edge)"
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.borderColor = "var(--rune-line-faint)"
                        }}
                      >
                        <div
                          style={{
                            "font-size": "13.5px",
                            "font-weight": 600,
                            "letter-spacing": "-0.01em",
                            color: "var(--rune-fg)",
                            overflow: "hidden",
                            "text-overflow": "ellipsis",
                            "white-space": "nowrap",
                          }}
                        >
                          {project.name || project.worktree.split("/").at(-1)}
                        </div>
                        <div
                          style={{
                            "margin-top": "3px",
                            "font-family": "var(--rune-font-mono)",
                            "font-size": "10.5px",
                            color: "var(--rune-fg-faint)",
                            overflow: "hidden",
                            "text-overflow": "ellipsis",
                            "white-space": "nowrap",
                          }}
                          title={project.worktree}
                        >
                          {project.worktree}
                        </div>
                        <div
                          style={{
                            "margin-top": "10px",
                            display: "inline-flex",
                            "align-items": "center",
                            gap: "5px",
                            "font-size": "11px",
                            "font-weight": 500,
                            color: isActive() ? "var(--rune-ac-text)" : "var(--rune-fg-mute)",
                          }}
                        >
                          {isActive() ? (
                            <>
                              <span class="rune-dot" data-st="run" />
                              Creating…
                            </>
                          ) : (
                            <>
                              <span style={{ color: "var(--rune-ac-text)" }}>＋</span>
                              Create workflow
                            </>
                          )}
                        </div>
                      </button>
                    )
                  }}
                </For>
              </div>
            </Show>

            <div class="mt-6 flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                class="rune-btn"
                data-variant="primary"
                disabled={!!make()}
                onClick={pickWorkspace}
              >
                Choose another workspace…
              </button>
              <button
                type="button"
                class="rune-btn"
                onClick={() => void load()}
              >
                ↻ Refresh
              </button>
            </div>

            <div
              class="mt-5 text-center"
              style={{ "font-size": "10.5px", color: "var(--rune-fg-faint)", "letter-spacing": "0.02em" }}
            >
              Health check and global sync are passing — waiting for a workflow root session.
            </div>
          </div>
        </div>
      </Match>
    </Switch>
  )
}

export function AppBaseProviders(props: ParentProps<{ locale?: Locale }>) {
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider
        onThemeApplied={(_, mode) => {
          void window.api?.setTitlebar?.({ mode })
        }}
      >
        <LanguageProvider locale={props.locale}>
          <UiI18nBridge>
            <ErrorBoundary fallback={(error) => <ErrorPage error={error} />}>
              <DialogProvider>
                <MarkedProvider>
                  <FileComponentProvider component={File}>{props.children}</FileComponentProvider>
                </MarkedProvider>
              </DialogProvider>
            </ErrorBoundary>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

function ConnectionGate(props: ParentProps<{ disableHealthCheck?: boolean }>) {
  const server = useServer()
  const checkServerHealth = useCheckServerHealth()

  const [checkMode, setCheckMode] = createSignal<"blocking" | "background">("blocking")

  // performs repeated health check with a grace period for
  // non-http connections, otherwise fails instantly
  const [startupHealthCheck, healthCheckActions] = createResource(() =>
    props.disableHealthCheck
      ? true
      : Effect.gen(function* () {
          if (!server.current) return true
          const { http, type } = server.current

          while (true) {
            const res = yield* Effect.promise(() => checkServerHealth(http))
            if (res.healthy) return true
            if (checkMode() === "background" || type === "http") return false
          }
        }).pipe(
          Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeed(false) }),
          Effect.ensuring(Effect.sync(() => setCheckMode("background"))),
          Effect.runPromise,
        ),
  )

  return (
    <Suspense
      fallback={
        <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
          <Splash class="w-16 h-20 opacity-50 animate-pulse" />
        </div>
      }
    >
      {/*<Show
        when={checkMode() === "blocking" ? !startupHealthCheck.loading : startupHealthCheck.state !== "pending"}
        fallback={
          <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
            <Splash class="w-16 h-20 opacity-50 animate-pulse" />
          </div>
        }
      >*/}
      {checkMode() === "blocking" ? startupHealthCheck() : startupHealthCheck.latest}
      <Show
        when={startupHealthCheck()}
        fallback={
          <ConnectionError
            onRetry={() => {
              if (checkMode() === "background") void healthCheckActions.refetch()
            }}
            onServerSelected={(key) => {
              setCheckMode("blocking")
              server.setActive(key)
              void healthCheckActions.refetch()
            }}
          />
        }
      >
        {props.children}
      </Show>
      {/*</Show>*/}
    </Suspense>
  )
}

function ConnectionError(props: { onRetry?: () => void; onServerSelected?: (key: ServerConnection.Key) => void }) {
  const language = useLanguage()
  const server = useServer()
  const others = () => server.list.filter((s) => ServerConnection.key(s) !== server.key)
  const name = createMemo(() => server.name || server.key)
  const serverToken = "\u0000server\u0000"
  const unreachable = createMemo(() => language.t("app.server.unreachable", { server: serverToken }).split(serverToken))

  const timer = setInterval(() => props.onRetry?.(), 1000)
  onCleanup(() => clearInterval(timer))

  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-6 p-6">
      <div class="flex flex-col items-center max-w-md text-center">
        <Splash class="w-12 h-15 mb-4" />
        <p class="text-14-regular text-text-base">
          {unreachable()[0]}
          <span class="text-text-strong font-medium">{name()}</span>
          {unreachable()[1]}
        </p>
        <p class="mt-1 text-12-regular text-text-weak">{language.t("app.server.retrying")}</p>
      </div>
      <Show when={others().length > 0}>
        <div class="flex flex-col gap-2 w-full max-w-sm">
          <span class="text-12-regular text-text-base text-center">{language.t("app.server.otherServers")}</span>
          <div class="flex flex-col gap-1 bg-surface-base rounded-lg p-2">
            <For each={others()}>
              {(conn) => {
                const key = ServerConnection.key(conn)
                return (
                  <button
                    type="button"
                    class="flex items-center gap-3 w-full px-3 py-2 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"
                    onClick={() => props.onServerSelected?.(key)}
                  >
                    <span class="text-14-regular text-text-strong truncate">{serverName(conn)}</span>
                  </button>
                )
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

function ServerKey(props: ParentProps) {
  const server = useServer()
  return (
    <Show when={server.key} keyed>
      {props.children}
    </Show>
  )
}

export function AppInterface(props: {
  children?: JSX.Element
  defaultServer: ServerConnection.Key
  servers?: Array<ServerConnection.Any>
  router?: Component<BaseRouterProps>
  disableHealthCheck?: boolean
}) {
  return (
    <ServerProvider
      defaultServer={props.defaultServer}
      disableHealthCheck={props.disableHealthCheck}
      servers={props.servers}
    >
      <ConnectionGate disableHealthCheck={props.disableHealthCheck}>
        <ServerKey>
          <QueryProvider>
            <GlobalSDKProvider>
              <GlobalSyncProvider>
                <Dynamic
                  component={props.router ?? Router}
                  root={(routerProps) => <RouterRoot appChildren={props.children}>{routerProps.children}</RouterRoot>}
                >
                  <Route path="/" component={HomeRoute} />
                  <Route path="/:dir" component={DirectoryLayout}>
                    <Route path="/" component={SessionIndexRoute} />
                    <Route path="/session/:id?" component={SessionShellRoute}>
                      <Route path="/" component={SessionRoute} />
                      <Route path="/refiner" component={RefinerRoute} />
                      <Route path="/retrieve" component={RetrieveRoute} />
                    </Route>
                  </Route>
                </Dynamic>
              </GlobalSyncProvider>
            </GlobalSDKProvider>
          </QueryProvider>
        </ServerKey>
      </ConnectionGate>
    </ServerProvider>
  )
}

export function WorkflowInterface(props: {
  defaultServer: ServerConnection.Key
  servers?: Array<ServerConnection.Any>
  disableHealthCheck?: boolean
}) {
  return (
    <ServerProvider defaultServer={props.defaultServer} servers={props.servers}>
      <ConnectionGate disableHealthCheck={props.disableHealthCheck}>
        <ServerKey>
          <QueryProvider>
            <GlobalSDKProvider>
              <GlobalSyncProvider>
                <Router root={(routerProps) => <WorkflowShellProviders>{routerProps.children}</WorkflowShellProviders>}>
                  <Route path="/:dir" component={DirectoryLayout}>
                    <Route path="/session/:id?" component={SessionShellRoute}>
                      <Route path="/" component={SessionRoute} />
                      <Route path="/refiner" component={RefinerRoute} />
                      <Route path="/retrieve" component={RetrieveRoute} />
                    </Route>
                  </Route>
                  <Route path="/*all" component={WorkflowScreen} />
                </Router>
              </GlobalSyncProvider>
            </GlobalSDKProvider>
          </QueryProvider>
        </ServerKey>
      </ConnectionGate>
    </ServerProvider>
  )
}
