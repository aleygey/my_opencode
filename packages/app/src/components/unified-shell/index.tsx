/**
 * UnifiedShell — top-level chrome shared by every session module.
 *
 * Layout:
 *   ┌──────┬──────────────────────────────────────────────────────────┐
 *   │ Rail │ Header   (breadcrumb · meta · actions · Tasks)           │
 *   │      ├──────────────────────────────────────────────────────────┤
 *   │      │ Substrip (sub-tabs · search · model · …)                 │
 *   │      ├──────────────────────────────────────────────────────────┤
 *   │      │ Body — module-specific content                           │
 *   └──────┴──────────────────────────────────────────────────────────┘
 *
 *   + TasksDrawer (right-edge overlay, click ⏃ in header to open)
 *   + TweaksPanel (top-right gear, theme + rail collapse)
 *
 * The shell is route-agnostic: it accepts a `module` prop ("workflow" /
 * "knowledge" / "trace") and the page renders its own body via the
 * `children` slot. Module switches navigate the URL via the parent route.
 *
 * Token & style scope: every selector is namespaced under `.rune-shell`
 * so this file's CSS does not leak into other pages.
 */

import { useNavigate, useParams } from "@solidjs/router"
import {
  createMemo,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  type ParentProps,
  Show,
} from "solid-js"
import "./fonts.css"
import "./tokens.css"
import "./shell.css"

/* ──────────────────────────────────────────────────────
   Types
   ────────────────────────────────────────────────────── */

export type ShellModule = "workflow" | "knowledge" | "trace"

export type ShellTheme = "light" | "dark"

export type ShellHeaderConfig = {
  /** Parent crumb e.g. "Workflow". Falls back to module label. */
  parent?: string
  /** Current page title (current crumb). */
  title?: string
  /** mono key/value pairs shown after the crumb. */
  meta?: Array<{ k: string; v: string }>
  /** Right-aligned action buttons. */
  actions?: JSX.Element
}

export type ShellSubstripTab = {
  id: string
  name: string
  count?: number
}

export type ShellSubstripConfig = {
  tabs: ShellSubstripTab[]
  active?: string
  onTab?: (id: string) => void
  /** "default" tabs underline; "segmented" sliding pill toggle. */
  variant?: "default" | "segmented"
  /** Right-aligned slot inside the substrip — search, model picker, etc. */
  right?: JSX.Element
}

export type ShellRailSubItem = {
  id: string
  title: string
  /** Optional small id chip / count e.g. T-104 or "5". */
  meta?: string
  /** Optional left dot status. */
  state?: "ok" | "run" | "warn" | "idle" | "err"
}

export type ShellTask = {
  id: string
  title: string
  state?: "ok" | "run" | "warn" | "idle" | "err"
  /** human-readable stage name */
  stage?: string
  /** progress 0–1, drives the bar */
  progress?: number
  /** secondary text on row 2 */
  subtitle?: string
  /** time / age string */
  time?: string
}

export type ShellProps = ParentProps<{
  /** Active module — drives Rail highlight and breadcrumb. */
  module: ShellModule
  /** Header config (breadcrumb / meta / actions). */
  header?: ShellHeaderConfig
  /** Sub-tab strip below the header (optional per module). */
  substrip?: ShellSubstripConfig
  /** Rail sub-items under the active module (e.g. tasks under Workflow,
   *  categories under Knowledge). */
  railSubs?: ShellRailSubItem[]
  /** Currently selected sub-item — drives highlight in the rail subs. */
  activeSubId?: string
  /** Click handler for sub-items in the rail. */
  onPickSub?: (id: string) => void
  /** Optional badge counts shown on each rail module item. */
  railBadges?: Partial<Record<ShellModule, string | number>>
  /** Task list rendered in the right-side drawer. */
  tasks?: ShellTask[]
  /** Currently active task id (highlights in drawer + count in toggle). */
  activeTaskId?: string
  /** Click on a task in the drawer. */
  onPickTask?: (id: string) => void
  /** Click + button to spawn a new task. */
  onCreateTask?: () => void
}>

/* ──────────────────────────────────────────────────────
   Theme + rail-collapsed persistence
   ────────────────────────────────────────────────────── */

const THEME_KEY = "rune-shell:theme"
const RAIL_KEY = "rune-shell:rail"

function readPref<T extends string>(key: string, fallback: T): T {
  if (typeof localStorage === "undefined") return fallback
  try {
    const v = localStorage.getItem(key)
    return (v as T) ?? fallback
  } catch {
    return fallback
  }
}

function writePref(key: string, value: string) {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(key, value)
  } catch {
    // ignore quota / disabled
  }
}

/* ──────────────────────────────────────────────────────
   Rail
   ────────────────────────────────────────────────────── */

/** Inline SVG icons for each module — match the Claude Design template's
 *  workflow / knowledge / trace shapes (rather than the spritesheet icons,
 *  which don't carry the same visual language). 16px viewBox, 1.5px stroke,
 *  rounded line caps. Stays color-currentColor so the rail's hover/active
 *  states change icon colour with the row. */
const ICONS: Record<ShellModule, () => JSX.Element> = {
  workflow: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="3.5" cy="4" r="1.7" />
      <circle cx="12.5" cy="4" r="1.7" />
      <circle cx="3.5" cy="12" r="1.7" />
      <circle cx="12.5" cy="12" r="1.7" />
      <path d="M5.2 4h5.6M5.2 12h5.6M3.5 5.7v4.6M12.5 5.7v4.6" />
    </svg>
  ),
  knowledge: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 2.5h7.5a2.5 2.5 0 0 1 2.5 2.5v8.5H5.5A2.5 2.5 0 0 1 3 11V2.5z" />
      <path d="M3 11a2.5 2.5 0 0 1 2.5-2.5H13" />
      <path d="M6 5h4M6 7.5h4" />
    </svg>
  ),
  trace: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.2 1.8" />
    </svg>
  ),
}

const MODULE_DEFS: Array<{
  id: ShellModule
  label: string
}> = [
  { id: "workflow", label: "Workflow" },
  { id: "knowledge", label: "Knowledge" },
  { id: "trace", label: "Trace" },
]

function Rail(props: {
  module: ShellModule
  collapsed: boolean
  badges?: ShellProps["railBadges"]
  subs?: ShellRailSubItem[]
  activeSubId?: string
  onPickModule: (m: ShellModule) => void
  onPickSub?: (id: string) => void
  onToggleCollapse: () => void
}) {
  // Track which module rows are open (for sub-list reveal). Active module
  // defaults to open; user can toggle by clicking the active row again.
  const [open, setOpen] = createSignal<Record<string, boolean>>({
    workflow: true,
    knowledge: true,
  })

  const handleClick = (m: ShellModule, expandable: boolean) => {
    const isActive = props.module === m
    if (isActive && expandable) {
      setOpen((s) => ({ ...s, [m]: !s[m] }))
    } else {
      props.onPickModule(m)
      if (expandable) setOpen((s) => ({ ...s, [m]: true }))
    }
  }

  return (
    <nav class="rune-rail">
      <div class="rune-rail-brand">
        <span class="rune-rail-brand-mark">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <rect x="1" y="1" width="18" height="18" stroke="currentColor" stroke-width="1.4" />
            <path d="M4 13l4-7 3 6 2-3 3 5" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round" />
          </svg>
        </span>
        <span class="rune-rail-brand-name">
          RUNE<b>·</b>RT
        </span>
      </div>

      <div class="rune-rail-sec">
        <span class="rune-kicker">Modules</span>
      </div>

      <div class="rune-rail-group">
        <For each={MODULE_DEFS}>
          {(def) => {
            const isOn = () => props.module === def.id
            const expandable = () =>
              (def.id === "workflow" || def.id === "knowledge") && (props.subs?.length ?? 0) > 0 && isOn()
            const isOpen = () => isOn() && open()[def.id] && !props.collapsed
            return (
              <>
                <button
                  type="button"
                  class="rune-rail-item"
                  classList={{ "is-on": isOn() }}
                  onClick={() => handleClick(def.id, expandable())}
                >
                  <span class="rune-rail-item-ic">{ICONS[def.id]()}</span>
                  <span class="rune-rail-item-name">{def.label}</span>
                  <Show when={props.badges?.[def.id]}>
                    <span class="rune-rail-item-badge">{props.badges![def.id]}</span>
                  </Show>
                  <Show when={expandable() && !props.collapsed}>
                    <span class="rune-rail-item-caret" classList={{ "is-open": isOpen() }}>
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
                        <path d="M5 6l3 3 3-3" />
                      </svg>
                    </span>
                  </Show>
                </button>
                <Show when={isOpen() && props.subs && props.subs.length > 0}>
                  <div class="rune-rail-subs">
                    <For each={props.subs}>
                      {(sub) => (
                        <button
                          type="button"
                          class="rune-rail-sub"
                          classList={{ "is-on": sub.id === props.activeSubId }}
                          onClick={() => props.onPickSub?.(sub.id)}
                        >
                          <Show when={sub.state}>
                            <span class="rune-dot" data-st={sub.state} />
                          </Show>
                          <span class="rune-rail-sub-title">{sub.title}</span>
                          <Show when={sub.meta}>
                            <span
                              classList={{
                                "rune-rail-sub-id": def.id === "workflow",
                                "rune-rail-sub-n": def.id === "knowledge",
                              }}
                            >
                              {sub.meta}
                            </span>
                          </Show>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </>
            )
          }}
        </For>
      </div>

      <div class="rune-rail-foot">
        <Show
          when={!props.collapsed}
          fallback={
            <button
              type="button"
              class="rune-btn"
              data-variant="ghost"
              data-icon="true"
              data-size="sm"
              title="Expand rail"
              onClick={props.onToggleCollapse}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
                <path d="M6 4l4 4-4 4" />
              </svg>
            </button>
          }
        >
          <span class="rune-rail-foot-text">v1 · runtime</span>
          <span class="rune-grow" />
          <button
            type="button"
            class="rune-btn"
            data-variant="ghost"
            data-icon="true"
            data-size="xs"
            title="Collapse rail"
            onClick={props.onToggleCollapse}
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
              <path d="M10 4l-4 4 4 4" />
            </svg>
          </button>
        </Show>
      </div>
    </nav>
  )
}

/* ──────────────────────────────────────────────────────
   Header
   ────────────────────────────────────────────────────── */

function Header(props: {
  module: ShellModule
  cfg?: ShellHeaderConfig
  taskCount: number
  taskRunning: boolean
  onTasks: () => void
}) {
  const moduleLabel = () => MODULE_DEFS.find((m) => m.id === props.module)?.label ?? "Workflow"
  return (
    <header class="rune-head">
      <div class="rune-head-crumbs">
        <span class="rune-head-crumb-prev">{props.cfg?.parent ?? moduleLabel()}</span>
        <Show when={props.cfg?.title}>
          <span class="rune-head-crumb-sep">/</span>
          <span class="rune-head-crumb-cur">{props.cfg!.title}</span>
        </Show>
      </div>
      <Show when={props.cfg?.meta && props.cfg.meta.length > 0}>
        <div class="rune-head-meta">
          <For each={props.cfg!.meta!}>
            {(m) => (
              <span class="rune-head-meta-item">
                {m.k} <b>{m.v}</b>
              </span>
            )}
          </For>
        </div>
      </Show>
      <span class="rune-grow" />
      <div class="rune-head-actions">
        {props.cfg?.actions}
        <button
          type="button"
          class="rune-tasks-toggle"
          data-running={props.taskRunning ? "true" : "false"}
          onClick={props.onTasks}
          title="Open tasks drawer"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
            <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
            <path d="M5 6.5h6M5 9h4" />
          </svg>
          <span>Tasks</span>
          <span class="rune-tasks-toggle-count">{props.taskRunning ? "1·RUN" : String(props.taskCount)}</span>
        </button>
      </div>
    </header>
  )
}

/* ──────────────────────────────────────────────────────
   Substrip
   ────────────────────────────────────────────────────── */

function Substrip(props: { cfg: ShellSubstripConfig }) {
  const idx = createMemo(() => {
    const tabs = props.cfg.tabs
    const active = props.cfg.active
    const i = tabs.findIndex((t) => t.id === active)
    return i < 0 ? 0 : i
  })

  return (
    <div class="rune-substrip">
      <Show
        when={props.cfg.variant === "segmented"}
        fallback={
          <div class="rune-substrip-tabs">
            <For each={props.cfg.tabs}>
              {(t) => (
                <button
                  type="button"
                  class="rune-substrip-tab"
                  classList={{ "is-on": t.id === props.cfg.active }}
                  onClick={() => props.cfg.onTab?.(t.id)}
                >
                  {t.name}
                  <Show when={t.count !== undefined}>
                    <span class="rune-substrip-tab-count">{t.count}</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        }
      >
        <div class="rune-seg" style={{ width: `${props.cfg.tabs.length * 90}px` }}>
          <span
            class="rune-seg-thumb"
            style={{ transform: `translateX(${idx() * 100}%)` }}
          />
          <For each={props.cfg.tabs}>
            {(t) => (
              <button
                type="button"
                class="rune-seg-btn"
                classList={{ "is-on": t.id === props.cfg.active }}
                onClick={() => props.cfg.onTab?.(t.id)}
              >
                {t.name}
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.cfg.right}>
        <div class="rune-substrip-right">{props.cfg.right}</div>
      </Show>
    </div>
  )
}

/* ──────────────────────────────────────────────────────
   Tasks Drawer
   ────────────────────────────────────────────────────── */

function TasksDrawer(props: {
  open: boolean
  tasks: ShellTask[]
  activeId?: string
  onClose: () => void
  onPick?: (id: string) => void
  onCreate?: () => void
}) {
  const [filt, setFilt] = createSignal<"all" | "running" | "done" | "review">("all")
  const visible = createMemo(() => {
    const f = filt()
    return props.tasks.filter((t) => {
      if (f === "all") return true
      if (f === "running") return t.state === "run"
      if (f === "done") return t.state === "ok"
      if (f === "review") return t.state === "warn"
      return true
    })
  })

  // Esc closes
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && props.open) props.onClose()
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => document.removeEventListener("keydown", onKey))
  })

  return (
    <Show when={props.open}>
      <>
        <div class="rune-drawer-scrim" onClick={props.onClose} />
        <aside class="rune-drawer is-on">
          <div class="rune-drawer-head">
            <span class="rune-kicker">Tasks</span>
            <span class="rune-grow" />
            <span class="rune-drawer-mono-meta">{props.tasks.length} total</span>
            <button
              type="button"
              class="rune-btn"
              data-variant="ghost"
              data-icon="true"
              data-size="sm"
              onClick={props.onClose}
              title="Close"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>

          <div class="rune-drawer-filt">
            <For
              each={[
                { k: "all" as const, n: "All" },
                { k: "running" as const, n: "Running" },
                { k: "done" as const, n: "Done" },
                { k: "review" as const, n: "Review" },
              ]}
            >
              {(opt) => (
                <button
                  type="button"
                  class="rune-btn"
                  data-size="xs"
                  data-variant={filt() === opt.k ? undefined : "ghost"}
                  onClick={() => setFilt(opt.k)}
                >
                  {opt.n}
                </button>
              )}
            </For>
          </div>

          <div class="rune-drawer-list">
            <Show
              when={visible().length > 0}
              fallback={
                <div style={{ padding: "32px 16px", "text-align": "center", color: "var(--rune-fg-faint)", "font-size": "var(--rune-fs-sm)" }}>
                  No tasks under this filter
                </div>
              }
            >
              <For each={visible()}>
                {(t) => (
                  <button
                    type="button"
                    class="rune-tcard"
                    classList={{ "is-on": t.id === props.activeId }}
                    onClick={() => {
                      props.onPick?.(t.id)
                      props.onClose()
                    }}
                  >
                    <div class="rune-tcard-row1">
                      <span class="rune-dot" data-st={t.state ?? "idle"} />
                      <span class="rune-tcard-title">{t.title}</span>
                      <Show when={t.id}>
                        <span class="rune-tcard-id">{t.id.slice(0, 12)}</span>
                      </Show>
                    </div>
                    <Show when={t.subtitle || t.stage || t.time}>
                      <div class="rune-tcard-row2">
                        <Show when={t.stage}>
                          <span>{t.stage}</span>
                        </Show>
                        <Show when={t.subtitle}>
                          <span>·</span>
                          <span>{t.subtitle}</span>
                        </Show>
                        <span class="rune-grow" />
                        <Show when={t.time}>
                          <span>{t.time}</span>
                        </Show>
                      </div>
                    </Show>
                    <Show when={t.progress !== undefined}>
                      <div class="rune-tcard-bar">
                        <i style={{ width: `${(t.progress ?? 0) * 100}%` }} />
                      </div>
                    </Show>
                  </button>
                )}
              </For>
            </Show>
          </div>

          <Show when={props.onCreate}>
            <div class="rune-drawer-foot">
              <button
                type="button"
                class="rune-btn"
                data-variant="primary"
                style={{ width: "100%", "justify-content": "center" }}
                onClick={() => {
                  props.onCreate?.()
                  props.onClose()
                }}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7">
                  <path d="M8 3v10M3 8h10" />
                </svg>
                <span>New task</span>
              </button>
            </div>
          </Show>
        </aside>
      </>
    </Show>
  )
}

/* ──────────────────────────────────────────────────────
   Tweaks Panel
   ────────────────────────────────────────────────────── */

function TweaksPanel(props: {
  theme: ShellTheme
  collapsed: boolean
  onTheme: (t: ShellTheme) => void
  onCollapse: (v: boolean) => void
}) {
  const [open, setOpen] = createSignal(false)
  let root: HTMLDivElement | undefined

  onMount(() => {
    const handler = (e: MouseEvent) => {
      if (!root) return
      if (!root.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", handler)
    onCleanup(() => document.removeEventListener("mousedown", handler))
  })

  return (
    <div ref={(el) => (root = el)}>
      <button
        type="button"
        class="rune-tweaks-trigger"
        onClick={() => setOpen((v) => !v)}
        title="Tweaks"
        aria-expanded={open() ? "true" : "false"}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
          <circle cx="8" cy="8" r="2.4" />
          <path d="M8 1v2.5M8 12.5V15M1 8h2.5M12.5 8H15M3 3l1.8 1.8M11.2 11.2L13 13M3 13l1.8-1.8M11.2 4.8L13 3" />
        </svg>
      </button>
      <Show when={open()}>
        <div class="rune-tweaks-pop" role="dialog" aria-label="Tweaks">
          <div class="rune-tweaks-row">
            <span class="rune-tweaks-label">Theme</span>
            <div class="rune-tweaks-segment">
              <button
                type="button"
                class="rune-tweaks-segment-btn"
                classList={{ "is-on": props.theme === "light" }}
                onClick={() => props.onTheme("light")}
              >
                Light
              </button>
              <button
                type="button"
                class="rune-tweaks-segment-btn"
                classList={{ "is-on": props.theme === "dark" }}
                onClick={() => props.onTheme("dark")}
              >
                Dark
              </button>
            </div>
          </div>
          <div class="rune-tweaks-row">
            <span class="rune-tweaks-label">Collapse rail</span>
            <div class="rune-tweaks-segment">
              <button
                type="button"
                class="rune-tweaks-segment-btn"
                classList={{ "is-on": !props.collapsed }}
                onClick={() => props.onCollapse(false)}
              >
                Off
              </button>
              <button
                type="button"
                class="rune-tweaks-segment-btn"
                classList={{ "is-on": props.collapsed }}
                onClick={() => props.onCollapse(true)}
              >
                On
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}

/* ──────────────────────────────────────────────────────
   UnifiedShell — exported root
   ────────────────────────────────────────────────────── */

export function UnifiedShell(props: ShellProps) {
  const navigate = useNavigate()
  const params = useParams<{ dir: string; id: string }>()

  const [theme, setTheme] = createSignal<ShellTheme>(readPref<ShellTheme>(THEME_KEY, "light"))
  const [collapsed, setCollapsed] = createSignal<boolean>(readPref<string>(RAIL_KEY, "false") === "true")
  const [tasksOpen, setTasksOpen] = createSignal(false)

  const updateTheme = (t: ShellTheme) => {
    setTheme(t)
    writePref(THEME_KEY, t)
  }
  const updateCollapsed = (v: boolean) => {
    setCollapsed(v)
    writePref(RAIL_KEY, v ? "true" : "false")
  }

  // Route mapping: existing app routes are
  //   /:dir/session/:id            → workflow (chat)
  //   /:dir/session/:id/refiner    → knowledge
  //   /:dir/session/:id/retrieve   → trace
  // Rail navigation dispatches between them via these paths so URLs stay
  // bookmarkable and link-compatible. SessionProviders does remount on
  // switch (a blink between modules); reworking routing into a single
  // shared parent for zero-remount is a follow-up.
  const navigateModule = (m: ShellModule) => {
    if (m === props.module) return
    const dir = params.dir
    const id = params.id
    if (!dir || !id) return
    const base = `/${dir}/session/${id}`
    const url =
      m === "workflow" ? base : m === "knowledge" ? `${base}/refiner` : `${base}/retrieve`
    navigate(url)
  }

  const taskCount = () => props.tasks?.length ?? 0
  const taskRunning = () => (props.tasks ?? []).some((t) => t.state === "run")

  return (
    <div
      class="rune-shell"
      data-theme={theme()}
      data-rail={collapsed() ? "collapsed" : "expanded"}
    >
      <Rail
        module={props.module}
        collapsed={collapsed()}
        badges={props.railBadges}
        subs={props.railSubs}
        activeSubId={props.activeSubId}
        onPickModule={navigateModule}
        onPickSub={props.onPickSub}
        onToggleCollapse={() => updateCollapsed(!collapsed())}
      />
      <main class="rune-main">
        <Header
          module={props.module}
          cfg={props.header}
          taskCount={taskCount()}
          taskRunning={taskRunning()}
          onTasks={() => setTasksOpen(true)}
        />
        <Show
          when={props.substrip}
          fallback={<div class="rune-substrip-empty" />}
        >
          <Substrip cfg={props.substrip!} />
        </Show>
        <div class="rune-body">{props.children}</div>
      </main>

      <TasksDrawer
        open={tasksOpen()}
        tasks={props.tasks ?? []}
        activeId={props.activeTaskId}
        onClose={() => setTasksOpen(false)}
        onPick={props.onPickTask}
        onCreate={props.onCreateTask}
      />

      <TweaksPanel
        theme={theme()}
        collapsed={collapsed()}
        onTheme={updateTheme}
        onCollapse={updateCollapsed}
      />
    </div>
  )
}

export default UnifiedShell
