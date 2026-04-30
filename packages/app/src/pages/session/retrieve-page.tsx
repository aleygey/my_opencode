/**
 * Retrieve agent inspection page — redesign per Claude Design handoff.
 *
 * Two-column layout:
 *   - Topbar: page title + session selector + model picker + meta info
 *   - Body:   timeline (300px) | main (1fr)
 *
 * Each timeline row = one log entry (user-msg-triggered Tier B / baseline /
 * tool-call Tier C). Click a row → main pane shows the trigger badge, the
 * conversation excerpt, and a numbered list of recalled experiences with
 * expand-on-click for statement + matched-observation snippet.
 *
 * Data wiring stays identical to the previous version — same /experimental
 * endpoints, same SDK contexts. The visual structure is what changed.
 */

import {
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { SessionHeader } from "@/components/session"
import { useModels } from "@/context/models"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { stableFetcher } from "@/utils/stable-fetch"
import "./retrieve-page.css"

/* ──────────────────────────────────────────────────────
   Types — mirror packages/opencode/src/retrieve/index.ts
   ────────────────────────────────────────────────────── */

type PickSource =
  | "seed"
  | "expand:requires"
  | "expand:refines"
  | "heuristic"
  | "cache"
  | "baseline"

type PickedExperience = {
  experience_id: string
  kind: string
  title: string
  abstract: string
  statement?: string
  trigger_condition?: string
  task_type?: string
  target_layer?: "master" | "slave" | "both"
  source: PickSource
  reason?: string
}

type RetrieveLogEntry = {
  id: string
  session_id: string
  turn_index: number
  agent_name: string
  layer: "master" | "slave" | "both"
  workflow_id?: string
  user_text_excerpt?: string
  candidate_count: number
  seed_ids: string[]
  expand_ids: string[]
  picked: PickedExperience[]
  diff: { added: string[]; removed: string[]; kept: string[] }
  model?: { providerID: string; modelID: string; source: string }
  llm_used: boolean
  error?: string
  duration_ms: number
  created_at: number
}

type LogResponse = { entries: RetrieveLogEntry[] }

type ConfigSource = "override" | "agent" | "default" | "none"

type RetrieveConfig = {
  resolved?: { providerID: string; modelID: string }
  source: ConfigSource
  override: { model?: { providerID: string; modelID: string }; temperature?: number } | null
}

/* ──────────────────────────────────────────────────────
   HTTP helpers — unchanged from previous version
   ────────────────────────────────────────────────────── */

function buildHeaders(input: { directory: string; username?: string; password?: string }) {
  const headers: Record<string, string> = {
    "x-opencode-directory": encodeURIComponent(input.directory),
  }
  if (input.password) {
    headers.Authorization = `Basic ${btoa(`${input.username ?? "opencode"}:${input.password}`)}`
  }
  return headers
}

async function readJsonOrThrow<T>(res: Response, label: string): Promise<T> {
  const ctype = res.headers.get("content-type") ?? ""
  if (!ctype.includes("application/json")) {
    const body = await res.text().catch(() => "")
    const preview = body.slice(0, 120).replace(/\s+/g, " ")
    throw new Error(
      `${label} did not return JSON (got "${ctype}"). Backend may need a restart. Response: ${preview}`,
    )
  }
  return (await res.json()) as T
}

async function fetchLog(input: {
  baseUrl: string
  directory: string
  sessionID?: string
  password?: string
  username?: string
  fetcher?: typeof fetch
}): Promise<LogResponse> {
  const url = new URL("/experimental/retrieve/log", input.baseUrl)
  if (input.sessionID) url.searchParams.set("session_id", input.sessionID)
  url.searchParams.set("limit", "500")
  const res = await (input.fetcher ?? fetch)(url, {
    headers: buildHeaders({
      directory: input.directory,
      username: input.username,
      password: input.password,
    }),
  })
  if (!res.ok) throw new Error(`Failed to load retrieve log (${res.status})`)
  return readJsonOrThrow<LogResponse>(res, "Retrieve log")
}

async function fetchRetrieveConfig(input: {
  baseUrl: string
  directory: string
  password?: string
  username?: string
  fetcher?: typeof fetch
}): Promise<RetrieveConfig> {
  const url = new URL("/experimental/retrieve/config", input.baseUrl)
  const res = await (input.fetcher ?? fetch)(url, {
    headers: buildHeaders({
      directory: input.directory,
      username: input.username,
      password: input.password,
    }),
  })
  if (!res.ok) throw new Error(`Failed to load retrieve config (${res.status})`)
  return readJsonOrThrow<RetrieveConfig>(res, "Retrieve config")
}

async function putRetrieveConfig(input: {
  baseUrl: string
  directory: string
  password?: string
  username?: string
  fetcher?: typeof fetch
  body: { model?: { providerID: string; modelID: string } | null; temperature?: number | null }
}): Promise<RetrieveConfig> {
  const url = new URL("/experimental/retrieve/config", input.baseUrl)
  const res = await (input.fetcher ?? fetch)(url, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...buildHeaders({
        directory: input.directory,
        username: input.username,
        password: input.password,
      }),
    },
    body: JSON.stringify(input.body),
  })
  if (!res.ok) throw new Error(`Failed to update retrieve config (${res.status})`)
  return readJsonOrThrow<RetrieveConfig>(res, "Retrieve config update")
}

/* ──────────────────────────────────────────────────────
   Helpers — formatting + role mapping
   ────────────────────────────────────────────────────── */

const fmtClock = (ts: number) => {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  const ss = String(d.getSeconds()).padStart(2, "0")
  return `${hh}:${mm}:${ss}`
}

const fmtDate = (ts: number) => {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${m}-${day}`
}

const fmtSessionDate = (ts: number) => {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  return `${m}月${day}日 ${hh}:${mm}`
}

/**
 * Map a log entry to one of the design's three trigger roles.
 *  - tool  ← Tier C `recall_experience` call (agent_name has `:recall` suffix)
 *  - agent ← Tier A baseline-only injection (system-side, no user query)
 *  - user  ← Tier B topical pick triggered by user msg (the default)
 */
type TriggerRole = "user" | "agent" | "tool"
const triggerForEntry = (e: RetrieveLogEntry): TriggerRole => {
  if (e.agent_name.endsWith(":recall")) return "tool"
  if (e.picked.length > 0 && e.picked.every((p) => p.source === "baseline")) return "agent"
  return "user"
}

const TRIGGER_LABEL: Record<TriggerRole, string> = {
  user: "用户消息触发",
  agent: "Baseline 注入",
  tool: "工具调用触发",
}

const TRIGGER_GLYPH: Record<TriggerRole, string> = {
  user: "U",
  agent: "A",
  tool: "T",
}

/** Trigger-badge accent hue per role. Matches design palette. */
const TRIGGER_HUE: Record<TriggerRole, number> = {
  user: 235,
  agent: 250,
  tool: 155,
}

/** Kind → category dot hue (cool engineering pastels — match design palette). */
const KIND_HUE: Record<string, number> = {
  workflow_rule: 250,
  workflow_gap: 35,
  know_how: 155,
  constraint_or_policy: 295,
  domain_knowledge: 200,
  preference_style: 340,
  pitfall_or_caveat: 85,
}

const KIND_NAME: Record<string, string> = {
  workflow_rule: "流程",
  workflow_gap: "缺口",
  know_how: "操作",
  constraint_or_policy: "约束",
  domain_knowledge: "领域",
  preference_style: "风格",
  pitfall_or_caveat: "注意",
}

const kindHue = (kind: string) => KIND_HUE[kind] ?? 235
const kindName = (kind: string) => {
  if (kind.startsWith("custom:")) return kind.replace("custom:", "")
  return KIND_NAME[kind] ?? kind
}

const SOURCE_LABEL_MAP: Record<ConfigSource, string> = {
  override: "override",
  agent: "agent config",
  default: "default",
  none: "—",
}

const modelLabel = (model?: { providerID: string; modelID: string }) =>
  model ? `${model.providerID}/${model.modelID}` : "—"

/* ──────────────────────────────────────────────────────
   Generic dropdown — used by both session & model pickers
   ────────────────────────────────────────────────────── */

function Chev() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
    >
      <path d="M5 6l3 3 3-3" />
    </svg>
  )
}

function ExternalLink() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M6 3h7v7" />
      <path d="M13 3L6 10" />
      <path d="M11 8.5V13H3V5h4.5" />
    </svg>
  )
}

/* ──────────────────────────────────────────────────────
   Session picker — derives sessions from the log
   ────────────────────────────────────────────────────── */

type SessionSummary = {
  id: string
  totalTurns: number
  recallTurns: number
  lastAt: number
}

function SessionPicker(props: {
  current: SessionSummary | undefined
  options: SessionSummary[]
  onPick: (id: string) => void
  /** highlight chip when the picked session is the URL session */
  urlSessionId?: string
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
    <div class="rt-pop-wrap" ref={(el) => (root = el)}>
      <button class="rt-pop-trigger" type="button" onClick={() => setOpen((v) => !v)}>
        <span class="rt-kicker">SESSION</span>
        <span class="rt-pop-label">
          <Show when={props.current} fallback="—">
            <code>{props.current!.id.slice(-12)}</code>
            <Show when={props.urlSessionId === props.current!.id}>
              <span class="rt-current-pill">当前</span>
            </Show>
          </Show>
        </span>
        <Chev />
      </button>
      <Show when={open()}>
        <>
          <div class="rt-pop-scrim" onClick={() => setOpen(false)} />
          <div class="rt-pop-menu">
            <Show
              when={props.options.length > 0}
              fallback={<div class="rt-pop-empty">尚无 session</div>}
            >
              <For each={props.options}>
                {(s) => (
                  <button
                    type="button"
                    class="rt-pop-opt"
                    classList={{
                      active: props.current?.id === s.id,
                    }}
                    onClick={() => {
                      props.onPick(s.id)
                      setOpen(false)
                    }}
                  >
                    <span class="rt-pop-opt-ttl">
                      <code>{s.id.slice(-12)}</code>
                      <Show when={props.urlSessionId === s.id}>
                        <span class="rt-current-pill">当前</span>
                      </Show>
                    </span>
                    <span class="rt-pop-opt-sub">
                      {fmtSessionDate(s.lastAt)} · {s.recallTurns}/{s.totalTurns} 轮命中
                    </span>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </>
      </Show>
    </div>
  )
}

/* ──────────────────────────────────────────────────────
   Model picker — runtime config override (kept from prev)
   ────────────────────────────────────────────────────── */

function ModelPicker(props: {
  current?: { providerID: string; modelID: string }
  source: ConfigSource
  busy: boolean
  onChange: (model: { providerID: string; modelID: string }) => void
  onReset: () => void
}) {
  const models = useModels()
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

  const list = createMemo(() => {
    try {
      return models
        .list()
        .filter((m) => models.visible({ providerID: m.provider.id, modelID: m.id }))
    } catch {
      return []
    }
  })

  const grouped = createMemo(() => {
    const map = new Map<string, Array<{ providerID: string; modelID: string; name: string }>>()
    for (const m of list()) {
      const key = m.provider.name ?? m.provider.id
      const arr = map.get(key) ?? []
      arr.push({ providerID: m.provider.id, modelID: m.id, name: m.name })
      map.set(key, arr)
    }
    return [...map.entries()]
  })

  return (
    <div class="rt-pop-wrap" ref={(el) => (root = el)}>
      <button
        class="rt-pop-trigger"
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={props.busy}
        title={`source: ${SOURCE_LABEL_MAP[props.source]}`}
      >
        <span class="rt-kicker">MODEL</span>
        <span class="rt-pop-label">{modelLabel(props.current)}</span>
        <Show when={props.source !== "none"}>
          <span class="rt-source-tag" data-source={props.source}>
            {SOURCE_LABEL_MAP[props.source]}
          </span>
        </Show>
        <Chev />
      </button>
      <Show when={open()}>
        <>
          <div class="rt-pop-scrim" onClick={() => setOpen(false)} />
          <div class="rt-pop-menu rt-pop-menu-right">
            <Show when={props.source === "override"}>
              <button
                type="button"
                class="rt-pop-opt rt-pop-opt-reset"
                onClick={() => {
                  props.onReset()
                  setOpen(false)
                }}
              >
                ⟲ 恢复默认（清除 override）
              </button>
              <div class="rt-pop-sep" />
            </Show>
            <Show
              when={grouped().length > 0}
              fallback={<div class="rt-pop-empty">暂无可用模型</div>}
            >
              <For each={grouped()}>
                {([providerName, items]) => (
                  <>
                    <div class="rt-pop-group">{providerName}</div>
                    <For each={items}>
                      {(item) => {
                        const active = () =>
                          props.current?.providerID === item.providerID &&
                          props.current?.modelID === item.modelID
                        return (
                          <button
                            type="button"
                            class="rt-pop-opt"
                            classList={{ active: active() }}
                            onClick={() => {
                              props.onChange({
                                providerID: item.providerID,
                                modelID: item.modelID,
                              })
                              setOpen(false)
                            }}
                          >
                            <span class="rt-pop-opt-ttl">{item.name}</span>
                          </button>
                        )
                      }}
                    </For>
                  </>
                )}
              </For>
            </Show>
          </div>
        </>
      </Show>
    </div>
  )
}

/* ──────────────────────────────────────────────────────
   Recall row — expandable, shows statement + matched obs
   ────────────────────────────────────────────────────── */

function RecallRow(props: { rec: PickedExperience; idx: number; total: number; dir: string }) {
  const [open, setOpen] = createSignal(false)
  const hue = () => kindHue(props.rec.kind)
  const cat = () => kindName(props.rec.kind)

  return (
    <div
      class="rt-rec"
      classList={{ open: open() }}
      style={{ "animation-delay": `${props.idx * 60}ms` }}
      onClick={() => setOpen((v) => !v)}
    >
      <div class="rt-rec-row">
        <div class="rt-rec-rank">
          <span class="rt-rank-num">{String(props.idx + 1).padStart(2, "0")}</span>
          <span class="rt-rank-tot">/ {String(props.total).padStart(2, "0")}</span>
        </div>

        <div class="rt-rec-l">
          <div class="rt-rec-meta">
            <span class="rt-cat">
              <span
                class="rt-cat-dot"
                style={{ background: `oklch(0.74 0.06 ${hue()})` }}
              />
              {cat()}
            </span>
            <a
              class="rt-id-link"
              href={`/${props.dir}/refiner#${props.rec.experience_id}`}
              target="_blank"
              rel="noopener"
              title="在 Refiner 中查看该 experience"
              onClick={(ev) => ev.stopPropagation()}
            >
              <span class="rt-id">{props.rec.experience_id.slice(-10).toUpperCase()}</span>
              <ExternalLink />
            </a>
          </div>
          <div class="rt-rec-title">{props.rec.title}</div>
          <Show when={props.rec.reason}>
            <div class="rt-rec-reason">{props.rec.reason}</div>
          </Show>
        </div>
      </div>

      <div class="rt-rec-more" aria-hidden={!open()}>
        <Show when={props.rec.statement}>
          <div class="rt-rec-more-row">
            <span class="rt-rec-more-k">Statement</span>
            <code>{props.rec.statement}</code>
          </div>
        </Show>
        <Show when={props.rec.abstract}>
          <div class="rt-rec-more-row">
            <span class="rt-rec-more-k">Abstract</span>
            <span class="rt-quote">「{props.rec.abstract}」</span>
          </div>
        </Show>
        <Show when={props.rec.trigger_condition}>
          <div class="rt-rec-more-row">
            <span class="rt-rec-more-k">Trigger</span>
            <span class="rt-quote">{props.rec.trigger_condition}</span>
          </div>
        </Show>
        <div class="rt-rec-more-row">
          <span class="rt-rec-more-k">Source</span>
          <code>{props.rec.source}</code>
        </div>
      </div>
    </div>
  )
}

/* ──────────────────────────────────────────────────────
   Page
   ────────────────────────────────────────────────────── */

export default function RetrievePage() {
  const params = useParams<{ dir: string; id: string }>()
  const navigate = useNavigate()
  const sdk = useSDK()
  const server = useServer()
  const platform = usePlatform()

  // Selected session id. Defaults to the URL's session, but the user can
  // switch to any session present in the global log (TUI runs, other
  // browsers, etc.).
  const [selectedSession, setSelectedSession] = createSignal<string | null>(null)
  const [selectedEntry, setSelectedEntry] = createSignal<string | null>(null)
  const [autoRefresh, setAutoRefresh] = createSignal(true)

  // Runtime config (model override).
  const [configBusy, setConfigBusy] = createSignal(false)
  const [configError, setConfigError] = createSignal<string | null>(null)

  const configArgs = () => {
    const current = server.current
    if (!current) return
    return {
      baseUrl: current.http.url,
      directory: sdk.directory,
      password: current.http.password,
      username: current.http.username,
      fetcher: platform.fetch,
    }
  }

  const [configResource, { refetch: refetchConfig }] = createResource(configArgs, async (input) =>
    fetchRetrieveConfig(input),
  )

  const updateConfig = async (body: {
    model?: { providerID: string; modelID: string } | null
    temperature?: number | null
  }) => {
    const current = server.current
    if (!current) return
    setConfigBusy(true)
    setConfigError(null)
    try {
      await putRetrieveConfig({
        baseUrl: current.http.url,
        directory: sdk.directory,
        password: current.http.password,
        username: current.http.username,
        fetcher: platform.fetch,
        body,
      })
      await refetchConfig()
    } catch (e) {
      setConfigError(e instanceof Error ? e.message : String(e))
    } finally {
      setConfigBusy(false)
    }
  }

  // Always fetch the global log — we filter client-side so the session
  // dropdown can show all known sessions.
  const logArgs = () => {
    const current = server.current
    if (!current) return
    return {
      baseUrl: current.http.url,
      directory: sdk.directory,
      password: current.http.password,
      username: current.http.username,
      fetcher: platform.fetch,
    }
  }

  const [logResource, { refetch }] = createResource(
    logArgs,
    stableFetcher(async (input: NonNullable<ReturnType<typeof logArgs>>) => fetchLog(input)),
  )

  let interval: ReturnType<typeof setInterval> | undefined
  onMount(() => {
    interval = setInterval(() => {
      if (autoRefresh()) refetch()
    }, 5000)
  })
  onCleanup(() => {
    if (interval) clearInterval(interval)
  })

  const allEntries = createMemo(() => logResource()?.entries ?? [])

  // Sessions list, derived from log entries — newest activity first.
  const sessions = createMemo<SessionSummary[]>(() => {
    const map = new Map<string, SessionSummary>()
    for (const e of allEntries()) {
      const cur = map.get(e.session_id)
      if (cur) {
        cur.totalTurns++
        if (e.picked.length > 0) cur.recallTurns++
        if (e.created_at > cur.lastAt) cur.lastAt = e.created_at
      } else {
        map.set(e.session_id, {
          id: e.session_id,
          totalTurns: 1,
          recallTurns: e.picked.length > 0 ? 1 : 0,
          lastAt: e.created_at,
        })
      }
    }
    return [...map.values()].sort((a, b) => b.lastAt - a.lastAt)
  })

  // Pick a default session: prefer the URL one if present in the log,
  // otherwise the most-recent one.
  createMemo(() => {
    const list = sessions()
    if (selectedSession()) return
    if (list.length === 0) return
    const urlMatch = list.find((s) => s.id === params.id)
    setSelectedSession(urlMatch?.id ?? list[0].id)
  })

  // Entries filtered to the selected session, oldest → newest (timeline order).
  const sessionEntries = createMemo(() => {
    const sid = selectedSession()
    if (!sid) return [] as RetrieveLogEntry[]
    return allEntries()
      .filter((e) => e.session_id === sid)
      .slice()
      .sort((a, b) => a.turn_index - b.turn_index || a.created_at - b.created_at)
  })

  // Auto-pick first entry-with-recall when the session loads or changes.
  createMemo(() => {
    const list = sessionEntries()
    if (list.length === 0) {
      setSelectedEntry(null)
      return
    }
    const cur = selectedEntry()
    if (cur && list.find((e) => e.id === cur)) return
    const firstRecall = list.find((e) => e.picked.length > 0)
    setSelectedEntry((firstRecall ?? list[0]).id)
  })

  const activeEntry = createMemo(() => {
    const sid = selectedEntry()
    if (!sid) return null
    return sessionEntries().find((e) => e.id === sid) ?? null
  })

  const currentSession = createMemo(() =>
    sessions().find((s) => s.id === selectedSession()),
  )

  return (
    <div class="rt-page" data-component="retrieve-page">
      <SessionHeader />

      {/* ─── Topbar ─── */}
      <div class="rt-topbar">
        <div class="rt-page-title">Retrieve</div>

        <SessionPicker
          current={currentSession()}
          options={sessions()}
          onPick={(id) => {
            setSelectedSession(id)
            setSelectedEntry(null)
          }}
          urlSessionId={params.id}
        />

        <div class="rt-meta-right">
          <ModelPicker
            current={configResource()?.resolved}
            source={configResource()?.source ?? "none"}
            busy={configBusy()}
            onChange={(m) => updateConfig({ model: m })}
            onReset={() => updateConfig({ model: null })}
          />
          <Show when={configError()}>
            <span class="rt-config-error" title={configError() ?? ""}>
              ⚠ {configError()}
            </span>
          </Show>
          <Show when={currentSession()}>
            <span class="rt-meta-info">
              {fmtDate(currentSession()!.lastAt)} · {currentSession()!.recallTurns}/
              {currentSession()!.totalTurns} 轮命中
            </span>
          </Show>
          <button
            type="button"
            class="rt-topbar-link"
            onClick={() => navigate(`/${params.dir}/session/${params.id}`)}
            title="返回 session"
          >
            ← session
          </button>
        </div>
      </div>

      {/* ─── Body ─── */}
      <div class="rt-body">
        {/* Timeline */}
        <aside class="rt-timeline">
          <div class="rt-t-head">
            <span>对话时间线</span>
            <span class="rt-t-count">{sessionEntries().length}</span>
          </div>
          <div class="rt-t-list">
            <Show
              when={sessionEntries().length > 0}
              fallback={
                <div class="rt-empty">
                  <Show
                    when={!logResource.loading}
                    fallback="正在加载日志…"
                  >
                    暂无日志
                  </Show>
                </div>
              }
            >
              <For each={sessionEntries()}>
                {(entry) => {
                  const role = triggerForEntry(entry)
                  const has = entry.picked.length > 0
                  return (
                    <button
                      type="button"
                      class="rt-turn"
                      classList={{
                        active: selectedEntry() === entry.id,
                        "role-user": role === "user",
                        "role-agent": role === "agent",
                        "role-tool": role === "tool",
                        "has-recall": has,
                      }}
                      onClick={() => setSelectedEntry(entry.id)}
                    >
                      <span class="rt-role-mark">{TRIGGER_GLYPH[role]}</span>
                      <span class="rt-turn-text">
                        <Show
                          when={entry.user_text_excerpt}
                          fallback={
                            <em class="rt-turn-text-empty">
                              <Show when={role === "agent"} fallback="(no user text)">
                                baseline · turn {entry.turn_index}
                              </Show>
                            </em>
                          }
                        >
                          {entry.user_text_excerpt}
                        </Show>
                      </span>
                      <Show when={has}>
                        <span class="rt-hit">{entry.picked.length}</span>
                      </Show>
                    </button>
                  )
                }}
              </For>
            </Show>
          </div>
        </aside>

        {/* Main */}
        <main class="rt-main">
          <Show
            when={activeEntry()}
            fallback={
              <div class="rt-main-empty">
                <p>选择左侧任意一行查看详情。</p>
              </div>
            }
          >
            {(entryFn) => {
              const e = entryFn
              const role = () => triggerForEntry(e())
              const recall = () => e().picked
              return (
                <div class="rt-main-inner">
                  {/* Trigger badge + message */}
                  <section class="rt-sec rt-sec-msg">
                    <div
                      class="rt-trigger-badge"
                      style={{ "--t-hue": String(TRIGGER_HUE[role()]) }}
                      data-role={role()}
                    >
                      <span class="rt-trigger-glyph">{TRIGGER_GLYPH[role()]}</span>
                      <span class="rt-trigger-text">
                        <span class="rt-trigger-label">{TRIGGER_LABEL[role()]}</span>
                        <span class="rt-trigger-sub">
                          turn {String(e().turn_index).padStart(2, "0")} · {fmtClock(e().created_at)} ·{" "}
                          {e().agent_name}
                          <Show when={e().llm_used}>
                            <span class="rt-pill-llm">LLM</span>
                          </Show>
                          <Show when={!e().llm_used && e().picked.length > 0}>
                            <span
                              class="rt-pill-llm"
                              data-fallback={
                                e().picked.every((p) => p.source === "baseline")
                                  ? "baseline"
                                  : e().picked.every((p) => p.source === "cache")
                                    ? "cache"
                                    : "heuristic"
                              }
                            >
                              {e().picked.every((p) => p.source === "baseline")
                                ? "BASELINE"
                                : e().picked.every((p) => p.source === "cache")
                                  ? "CACHE"
                                  : "HEUR"}
                            </span>
                          </Show>
                          <Show when={e().error}>
                            <span class="rt-pill-err">ERR</span>
                          </Show>
                        </span>
                      </span>
                    </div>

                    <Show when={e().user_text_excerpt}>
                      <blockquote class="rt-msg">
                        <p>{e().user_text_excerpt}</p>
                      </blockquote>
                    </Show>

                    <Show when={e().error}>
                      <div class="rt-error-line">error: {e().error}</div>
                    </Show>
                  </section>

                  {/* Recall list */}
                  <Show
                    when={recall().length > 0}
                    fallback={
                      <section class="rt-sec rt-sec-empty">
                        <div class="rt-sec-kicker">
                          <span class="rt-sec-dot rt-sec-dot-empty" /> 经验召回
                        </div>
                        <p class="rt-empty-note">该轮未触发 retrieve</p>
                      </section>
                    }
                  >
                    <section class="rt-sec rt-sec-recall">
                      <div class="rt-sec-kicker">
                        <span class="rt-sec-dot rt-sec-dot-rec" /> 经验召回 · {recall().length} 条命中
                      </div>

                      <Show when={e().user_text_excerpt}>
                        <div class="rt-query-line">
                          <span class="rt-q-k">检索 QUERY</span>
                          <span class="rt-q-v">{e().user_text_excerpt}</span>
                        </div>
                      </Show>

                      <div class="rt-rec-list">
                        <For each={recall()}>
                          {(rec, i) => (
                            <RecallRow
                              rec={rec}
                              idx={i()}
                              total={recall().length}
                              dir={params.dir}
                            />
                          )}
                        </For>
                      </div>

                      {/* Diff summary at end */}
                      <Show
                        when={
                          e().diff.added.length > 0 ||
                          e().diff.removed.length > 0 ||
                          e().diff.kept.length > 0
                        }
                      >
                        <div class="rt-diff-row">
                          <Show when={e().diff.added.length > 0}>
                            <span class="rt-diff-chip rt-diff-add">+{e().diff.added.length}</span>
                          </Show>
                          <Show when={e().diff.removed.length > 0}>
                            <span class="rt-diff-chip rt-diff-rem">−{e().diff.removed.length}</span>
                          </Show>
                          <Show when={e().diff.kept.length > 0}>
                            <span class="rt-diff-chip rt-diff-kept">={e().diff.kept.length}</span>
                          </Show>
                          <span class="rt-diff-stat">
                            候选 {e().candidate_count} · 种子 {e().seed_ids.length} · 展开{" "}
                            {e().expand_ids.length} · {e().duration_ms}ms
                          </span>
                        </div>
                      </Show>
                    </section>
                  </Show>
                </div>
              )
            }}
          </Show>
        </main>
      </div>
    </div>
  )
}
