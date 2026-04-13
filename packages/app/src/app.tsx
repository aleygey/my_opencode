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
import { type BaseRouterProps, Navigate, Route, Router } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import type { PermissionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { type Duration, Effect } from "effect"
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

const HomeRoute = lazy(() => import("@/pages/home"))
const loadSession = () => import("@/pages/session")
const Session = lazy(loadSession)
const Loading = () => <div class="size-full" />

if (typeof location === "object" && /\/session(?:\/|$)/.test(location.pathname)) {
  void loadSession()
}

const SessionRoute = () => (
  <SessionProviders>
    <Session />
  </SessionProviders>
)

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
      <Suspense fallback={<Loading />}>
        {props.appChildren}
        {props.children}
      </Suspense>
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
        <div class="flex h-dvh w-screen items-center justify-center bg-background-base px-6 text-center">
          <div class="w-full max-w-3xl">
            <div class="mx-auto max-w-md">
              <div class="text-16-medium text-text-strong">Connected to {server.name || server.key}</div>
              <div class="mt-2 text-14-regular text-text-weak">
                {err() || "No workflow root session exists yet. Create one from a project below."}
              </div>
            </div>
            <Show
              when={projects().length > 0}
              fallback={
                <div class="mt-6 text-13-regular text-text-weak">
                  No projects were returned by the server, so there is nothing to bootstrap yet.
                </div>
              }
            >
              <div class="mt-8 grid gap-3 text-left md:grid-cols-2">
                <For each={projects().slice(0, 8)}>
                  {(project) => (
                    <button
                      type="button"
                      class="rounded-2xl border border-border/60 bg-background px-4 py-4 transition-colors hover:bg-muted/30"
                      disabled={!!make()}
                      onClick={() => void boot(project.worktree, project.name || project.worktree.split("/").at(-1) || "Workflow")}
                    >
                      <div class="truncate text-14-medium text-text-strong">{project.name || project.worktree.split("/").at(-1)}</div>
                      <div class="mt-1 truncate text-12-regular text-text-weak">{project.worktree}</div>
                      <div class="mt-3 text-12-medium text-emerald-600">
                        {make() === project.worktree ? "Creating workflow..." : "Create workflow"}
                      </div>
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <div class="mt-6">
              <button
                type="button"
                class="rounded-xl border border-border/60 px-4 py-2 text-13-medium text-text-base transition-colors hover:bg-muted/30"
                onClick={() => void load()}
              >
                Refresh
              </button>
            </div>
            <div class="mt-3 text-12-regular text-text-weaker">
              Health check and global sync are already passing. This page is waiting for a workflow root session.
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
              <QueryProvider>
                <DialogProvider>
                  <MarkedProvider>
                    <FileComponentProvider component={File}>{props.children}</FileComponentProvider>
                  </MarkedProvider>
                </DialogProvider>
              </QueryProvider>
            </ErrorBoundary>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

const effectMinDuration =
  (duration: Duration.Input) =>
  <A, E, R>(e: Effect.Effect<A, E, R>) =>
    Effect.all([e, Effect.sleep(duration)], { concurrency: "unbounded" }).pipe(Effect.map((v) => v[0]))

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
    <Show
      when={checkMode() === "blocking" ? !startupHealthCheck.loading : startupHealthCheck.state !== "pending"}
      fallback={
        <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
          <Splash class="w-16 h-20 opacity-50 animate-pulse" />
        </div>
      }
    >
      <Show
        when={startupHealthCheck()}
        fallback={
          <ConnectionError
            onRetry={() => {
              if (checkMode() === "background") healthCheckActions.refetch()
            }}
            onServerSelected={(key) => {
              setCheckMode("blocking")
              server.setActive(key)
              healthCheckActions.refetch()
            }}
          />
        }
      >
        {props.children}
      </Show>
    </Show>
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
          <GlobalSDKProvider>
            <GlobalSyncProvider>
              <Dynamic
                component={props.router ?? Router}
                root={(routerProps) => <RouterRoot appChildren={props.children}>{routerProps.children}</RouterRoot>}
              >
                <Route path="/" component={HomeRoute} />
                <Route path="/:dir" component={DirectoryLayout}>
                  <Route path="/" component={SessionIndexRoute} />
                  <Route path="/session/:id?" component={SessionRoute} />
                </Route>
              </Dynamic>
            </GlobalSyncProvider>
          </GlobalSDKProvider>
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
        <GlobalSDKProvider>
          <GlobalSyncProvider>
            <Router root={(routerProps) => <WorkflowShellProviders>{routerProps.children}</WorkflowShellProviders>}>
              <Route path="/*all" component={WorkflowScreen} />
            </Router>
          </GlobalSyncProvider>
        </GlobalSDKProvider>
      </ConnectionGate>
    </ServerProvider>
  )
}
