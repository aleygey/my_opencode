/**
 * Retrieve agent inspection page.
 *
 * Per-session view of the audit log produced by the Retrieve service in
 * packages/opencode/src/retrieve/index.ts. Each entry corresponds to one
 * `selectForSession` call (i.e. one user-turn injection). Lets the user see
 * which experiences were injected, the seeds vs graph-expanded picks, the
 * diff against the previous turn, and the final rendered system-prompt block.
 *
 * Sidecar to refiner-page.tsx — same fetch-with-buildHeaders pattern, no SDK
 * regen required.
 */

import { Button } from "@opencode-ai/ui/button"
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

type PickSource = "seed" | "expand:requires" | "expand:refines" | "heuristic" | "cache"

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

/* ──────────────────────────────────────────────────────
   Header utilities (copied verbatim from refiner-page)
   ────────────────────────────────────────────────────── */

function buildHeaders(input: {
  directory: string
  username?: string
  password?: string
}) {
  const headers: Record<string, string> = {
    "x-opencode-directory": encodeURIComponent(input.directory),
  }
  if (input.password) {
    headers.Authorization = `Basic ${btoa(
      `${input.username ?? "opencode"}:${input.password}`,
    )}`
  }
  return headers
}

async function readJsonOrThrow<T>(res: Response, label: string): Promise<T> {
  const ctype = res.headers.get("content-type") ?? ""
  if (!ctype.includes("application/json")) {
    const body = await res.text().catch(() => "")
    const preview = body.slice(0, 120).replace(/\s+/g, " ")
    throw new Error(
      `${label} did not return JSON (got "${ctype}"). ` +
        `Backend may need a restart to load new retrieve routes. Response: ${preview}`,
    )
  }
  return (await res.json()) as T
}

async function fetchLog(input: {
  baseUrl: string
  directory: string
  sessionID: string
  password?: string
  username?: string
  fetcher?: typeof fetch
}): Promise<LogResponse> {
  const url = new URL("/experimental/retrieve/log", input.baseUrl)
  url.searchParams.set("session_id", input.sessionID)
  url.searchParams.set("limit", "200")
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

async function previewRetrieve(input: {
  baseUrl: string
  directory: string
  sessionID: string
  agentName: string
  userText?: string
  password?: string
  username?: string
  fetcher?: typeof fetch
}) {
  const url = new URL("/experimental/retrieve/preview", input.baseUrl)
  const res = await (input.fetcher ?? fetch)(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...buildHeaders({
        directory: input.directory,
        username: input.username,
        password: input.password,
      }),
    },
    body: JSON.stringify({
      session_id: input.sessionID,
      agent_name: input.agentName,
      user_text: input.userText,
    }),
  })
  if (!res.ok) throw new Error(`Failed retrieve preview (${res.status})`)
  return readJsonOrThrow<{
    picked: PickedExperience[]
    diff: { added: string[]; removed: string[]; kept: string[] }
    system_text?: string
    turn_index: number
    agent_layer: "master" | "slave"
  }>(res, "Retrieve preview")
}

/* ──────────────────────────────────────────────────────
   Helpers
   ────────────────────────────────────────────────────── */

const fmtTime = (ts: number) => {
  const d = new Date(ts)
  const today = new Date()
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  const ss = String(d.getSeconds()).padStart(2, "0")
  if (sameDay) return `${hh}:${mm}:${ss}`
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${m}-${day} ${hh}:${mm}`
}

const sourceLabel = (s: PickSource) => {
  if (s === "seed") return "种子"
  if (s === "heuristic") return "兜底"
  if (s === "expand:requires") return "前置(requires)"
  if (s === "expand:refines") return "细化(refines)"
  if (s === "cache") return "缓存"
  return s
}

const sourceColorVar = (s: PickSource) => {
  if (s === "seed") return "var(--retrieve-seed)"
  if (s === "heuristic") return "var(--retrieve-heuristic)"
  if (s === "expand:requires") return "var(--retrieve-requires)"
  if (s === "expand:refines") return "var(--retrieve-refines)"
  if (s === "cache") return "var(--retrieve-cache)"
  return "var(--retrieve-default)"
}

/* ──────────────────────────────────────────────────────
   Runtime config (model picker) — mirrors refiner-page's
   /experimental/refiner/config plumbing.
   ────────────────────────────────────────────────────── */

type ConfigSource = "override" | "agent" | "default" | "none"

type RetrieveConfig = {
  resolved?: { providerID: string; modelID: string }
  source: ConfigSource
  override: { model?: { providerID: string; modelID: string }; temperature?: number } | null
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

const SOURCE_LABEL: Record<ConfigSource, string> = {
  override: "override",
  agent: "agent config",
  default: "default",
  none: "—",
}

const modelLabel = (model?: { providerID: string; modelID: string }) =>
  model ? `${model.providerID}/${model.modelID}` : "—"

/**
 * Dropdown that lists every visible model from `useModels()` grouped by
 * provider, plus a "reset to default" item visible only when an override is
 * active. On click, calls `props.onChange` with the chosen `{providerID,
 * modelID}`. Visual classnames use the `rt-model-*` prefix to mirror the
 * refiner page's `rf-model-*` styles.
 */
function ModelPicker(props: {
  current?: { providerID: string; modelID: string }
  source?: ConfigSource
  busy?: boolean
  onChange: (model: { providerID: string; modelID: string }) => void
  onReset?: () => void
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
    <div class="rt-model" ref={(el) => (root = el)}>
      <button
        type="button"
        class="rt-model-trigger"
        aria-expanded={open() ? "true" : "false"}
        onClick={() => setOpen((v) => !v)}
        disabled={props.busy}
        title={props.source ? `source: ${SOURCE_LABEL[props.source]}` : undefined}
      >
        <span class="rt-dot" />
        <span>{modelLabel(props.current)}</span>
        <Show when={props.source && props.source !== "none"}>
          <span class="rt-model-source" data-source={props.source}>
            {SOURCE_LABEL[props.source!]}
          </span>
        </Show>
        <span class="rt-model-caret">▾</span>
      </button>
      <Show when={open()}>
        <div class="rt-model-menu">
          <Show when={props.source === "override" && props.onReset}>
            <button
              type="button"
              class="rt-model-item rt-model-reset"
              onClick={() => {
                props.onReset?.()
                setOpen(false)
              }}
            >
              ⟲ 恢复默认（清除 override）
            </button>
            <div class="rt-model-sep" />
          </Show>
          <Show
            when={grouped().length > 0}
            fallback={<div class="rt-model-group">暂无可用模型</div>}
          >
            <For each={grouped()}>
              {([providerName, items]) => (
                <>
                  <div class="rt-model-group">{providerName}</div>
                  <For each={items}>
                    {(item) => {
                      const active = () =>
                        props.current?.providerID === item.providerID &&
                        props.current?.modelID === item.modelID
                      return (
                        <button
                          type="button"
                          class="rt-model-item"
                          data-active={active() ? "true" : "false"}
                          onClick={() => {
                            props.onChange({
                              providerID: item.providerID,
                              modelID: item.modelID,
                            })
                            setOpen(false)
                          }}
                        >
                          {item.name}
                        </button>
                      )
                    }}
                  </For>
                </>
              )}
            </For>
          </Show>
        </div>
      </Show>
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

  const [selected, setSelected] = createSignal<RetrieveLogEntry | null>(null)
  const [autoRefresh, setAutoRefresh] = createSignal(true)
  const [previewText, setPreviewText] = createSignal("")
  const [previewBusy, setPreviewBusy] = createSignal(false)
  const [previewResult, setPreviewResult] = createSignal<
    Awaited<ReturnType<typeof previewRetrieve>> | null
  >(null)
  const [previewError, setPreviewError] = createSignal<string | null>(null)

  // Runtime config (currently effective model + override).
  // - `configResource` keeps the picker label live (refetched on update).
  // - `configBusy` disables the trigger during a PUT round-trip.
  // - `configError` shows up next to the picker in the toolbar so users see
  //   why "save" didn't persist (e.g. unauthorized, schema mismatch).
  const [configBusy, setConfigBusy] = createSignal(false)
  const [configError, setConfigError] = createSignal<string | null>(null)

  const logArgs = () => {
    const current = server.current
    const sessionID = params.id
    if (!current || !sessionID) return
    return {
      sessionID,
      baseUrl: current.http.url,
      directory: sdk.directory,
      password: current.http.password,
      username: current.http.username,
      fetcher: platform.fetch,
    }
  }

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

  const [configResource, { refetch: refetchConfig }] = createResource(
    configArgs,
    async (input) => fetchRetrieveConfig(input),
  )

  const updateConfig = async (
    body: { model?: { providerID: string; modelID: string } | null; temperature?: number | null },
  ) => {
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

  // `stableFetcher` keeps the previous reference when the polled payload is
  // structurally identical — without it, the 5s refetch would re-key the
  // entry list every cycle and the page would visibly flash.
  const [logResource, { refetch }] = createResource(
    logArgs,
    stableFetcher(async (input: NonNullable<ReturnType<typeof logArgs>>) => {
      return await fetchLog({
        sessionID: input.sessionID,
        baseUrl: input.baseUrl,
        directory: input.directory,
        password: input.password,
        username: input.username,
        fetcher: input.fetcher,
      })
    }),
  )

  // Auto-refresh while page is open. 5s interval is gentle on the backend.
  let interval: ReturnType<typeof setInterval> | undefined
  onMount(() => {
    interval = setInterval(() => {
      if (autoRefresh()) refetch()
    }, 5000)
  })
  onCleanup(() => {
    if (interval) clearInterval(interval)
  })

  const entries = createMemo(() => logResource()?.entries ?? [])

  // Auto-pick the most-recent entry when the data loads (newest first).
  createMemo(() => {
    const list = entries()
    const cur = selected()
    if (!cur && list.length > 0) setSelected(list[0])
    else if (cur && !list.find((e) => e.id === cur.id) && list.length > 0) {
      setSelected(list[0])
    }
  })

  const runPreview = async () => {
    const current = server.current
    if (!params.id || !current) return
    setPreviewBusy(true)
    setPreviewError(null)
    try {
      const res = await previewRetrieve({
        sessionID: params.id,
        baseUrl: current.http.url,
        directory: sdk.directory,
        password: current.http.password,
        username: current.http.username,
        fetcher: platform.fetch,
        agentName: "build",
        userText: previewText(),
      })
      setPreviewResult(res)
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : String(e))
      setPreviewResult(null)
    } finally {
      setPreviewBusy(false)
    }
  }

  return (
    <div class="retrieve-page flex flex-col size-full" data-component="retrieve-page">
      <SessionHeader />

      <div class="retrieve-toolbar">
        <div class="retrieve-toolbar-left">
          <div class="retrieve-title">Retrieve · session injection log</div>
          <div class="retrieve-subtitle">
            Each row = one user turn that triggered an injection. Newest first.
          </div>
        </div>
        <div class="retrieve-toolbar-right">
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
          <label class="retrieve-toggle">
            <input
              type="checkbox"
              checked={autoRefresh()}
              onChange={(e) => setAutoRefresh(e.currentTarget.checked)}
            />
            <span>Auto-refresh 5s</span>
          </label>
          <Button variant="ghost" size="small" onClick={() => refetch()}>
            Refresh now
          </Button>
          <Button variant="ghost" size="small" onClick={() => navigate(`/${params.dir}/session/${params.id}`)}>
            Back to session
          </Button>
        </div>
      </div>

      <div class="retrieve-body">
        <div class="retrieve-list-pane">
          {/*
            Use `.latest` instead of `!logResource.loading` so that a 5s
            polling refetch doesn't briefly flip this Show into the
            "Loading…" fallback. We only want the spinner on the very first
            load (no prior data), not on every poll cycle.
          */}
          <Show when={logResource.latest} fallback={<div class="retrieve-empty">Loading…</div>}>
            <Show
              when={entries().length > 0}
              fallback={
                <div class="retrieve-empty">
                  <p>No injections recorded for this session yet.</p>
                  <p class="retrieve-empty-sub">
                    Send a user message in the session, or use the preview panel below to dry-run.
                  </p>
                </div>
              }
            >
              <For each={entries()}>
                {(entry) => (
                  <button
                    type="button"
                    class="retrieve-row"
                    classList={{ "is-selected": selected()?.id === entry.id }}
                    onClick={() => setSelected(entry)}
                  >
                    <div class="retrieve-row-head">
                      <span class="retrieve-row-turn">#{entry.turn_index}</span>
                      <span class="retrieve-row-time">{fmtTime(entry.created_at)}</span>
                      <span class="retrieve-row-agent">{entry.agent_name}</span>
                      <span class="retrieve-row-layer" data-layer={entry.layer}>
                        {entry.layer}
                      </span>
                      <Show when={entry.llm_used}>
                        <span class="retrieve-row-llm">llm</span>
                      </Show>
                      <Show when={!entry.llm_used && entry.picked.length > 0}>
                        <span
                          class="retrieve-row-llm"
                          data-fallback={entry.picked.every((p) => p.source === "cache") ? "cache" : "heuristic"}
                        >
                          {entry.picked.every((p) => p.source === "cache") ? "cache" : "heuristic"}
                        </span>
                      </Show>
                      <Show when={entry.error}>
                        <span class="retrieve-row-error">err</span>
                      </Show>
                    </div>
                    <div class="retrieve-row-line">
                      <Show when={entry.user_text_excerpt} fallback={<em class="retrieve-row-empty-text">(no user text)</em>}>
                        {entry.user_text_excerpt}
                      </Show>
                    </div>
                    <div class="retrieve-row-stats">
                      <span>candidates {entry.candidate_count}</span>
                      <span>seeds {entry.seed_ids.length}</span>
                      <span>expand {entry.expand_ids.length}</span>
                      <span class="retrieve-row-picked">picked {entry.picked.length}</span>
                      <Show when={entry.diff.added.length > 0}>
                        <span class="retrieve-row-added">+{entry.diff.added.length}</span>
                      </Show>
                      <Show when={entry.diff.removed.length > 0}>
                        <span class="retrieve-row-removed">−{entry.diff.removed.length}</span>
                      </Show>
                      <span class="retrieve-row-duration">{entry.duration_ms}ms</span>
                    </div>
                  </button>
                )}
              </For>
            </Show>
          </Show>
        </div>

        <div class="retrieve-detail-pane">
          <Show
            when={selected()}
            fallback={
              <div class="retrieve-empty">
                <p>Pick an entry on the left.</p>
              </div>
            }
          >
            {(entry) => (
              <div class="retrieve-detail">
                <header class="retrieve-detail-header">
                  <div class="retrieve-detail-title">
                    Turn #{entry().turn_index} · {entry().agent_name} · {entry().layer}
                  </div>
                  <div class="retrieve-detail-meta">
                    {fmtTime(entry().created_at)} · duration {entry().duration_ms}ms
                    <Show when={entry().model}>
                      {" · "}
                      <code>{entry().model!.providerID}/{entry().model!.modelID}</code>
                      <span class="retrieve-detail-model-source"> ({entry().model!.source})</span>
                    </Show>
                    {!entry().llm_used && entry().picked.length > 0
                      ? entry().picked.every((p) => p.source === "cache")
                        ? " · cache replay (no LLM)"
                        : " · heuristic fallback"
                      : ""}
                  </div>
                  <Show when={entry().error}>
                    <div class="retrieve-detail-error">error: {entry().error}</div>
                  </Show>
                </header>

                <Show when={entry().user_text_excerpt}>
                  <section class="retrieve-section">
                    <h4>User text</h4>
                    <pre class="retrieve-pre">{entry().user_text_excerpt}</pre>
                  </section>
                </Show>

                <section class="retrieve-section">
                  <h4>Diff</h4>
                  <div class="retrieve-diff">
                    <div class="retrieve-diff-col">
                      <div class="retrieve-diff-label retrieve-diff-added">added ({entry().diff.added.length})</div>
                      <For each={entry().diff.added}>
                        {(id) => <div class="retrieve-diff-id"><code>{id}</code></div>}
                      </For>
                    </div>
                    <div class="retrieve-diff-col">
                      <div class="retrieve-diff-label retrieve-diff-removed">removed ({entry().diff.removed.length})</div>
                      <For each={entry().diff.removed}>
                        {(id) => <div class="retrieve-diff-id"><code>{id}</code></div>}
                      </For>
                    </div>
                    <div class="retrieve-diff-col">
                      <div class="retrieve-diff-label retrieve-diff-kept">kept ({entry().diff.kept.length})</div>
                      <For each={entry().diff.kept}>
                        {(id) => <div class="retrieve-diff-id"><code>{id}</code></div>}
                      </For>
                    </div>
                  </div>
                </section>

                <section class="retrieve-section">
                  <h4>Picked experiences ({entry().picked.length})</h4>
                  <Show
                    when={entry().picked.length > 0}
                    fallback={<div class="retrieve-empty-inline">Nothing injected this turn.</div>}
                  >
                    <ul class="retrieve-picks">
                      <For each={entry().picked}>
                        {(p) => (
                          <li class="retrieve-pick">
                            <div
                              class="retrieve-pick-tag"
                              style={{ "background-color": sourceColorVar(p.source) }}
                            >
                              {sourceLabel(p.source)}
                            </div>
                            <div class="retrieve-pick-body">
                              <div class="retrieve-pick-head">
                                <span class="retrieve-pick-kind">{p.kind}</span>
                                <span class="retrieve-pick-title">{p.title}</span>
                                <code class="retrieve-pick-id">{p.experience_id}</code>
                                <Show when={p.target_layer && p.target_layer !== "both"}>
                                  <span class="retrieve-pick-layer" data-layer={p.target_layer}>
                                    {p.target_layer}
                                  </span>
                                </Show>
                              </div>
                              <div class="retrieve-pick-abstract">{p.abstract}</div>
                              <Show when={p.statement}>
                                <div class="retrieve-pick-statement">rule: {p.statement}</div>
                              </Show>
                              <Show when={p.trigger_condition}>
                                <div class="retrieve-pick-trigger">when: {p.trigger_condition}</div>
                              </Show>
                              <Show when={p.reason}>
                                <div class="retrieve-pick-reason">reason: {p.reason}</div>
                              </Show>
                            </div>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </section>

                <Show when={entry().picked.length > 0}>
                  <section class="retrieve-section">
                    <h4>Rendered system block (the actual text injected)</h4>
                    <pre class="retrieve-pre retrieve-pre-system">{renderSystemTextPreview(entry())}</pre>
                  </section>
                </Show>
              </div>
            )}
          </Show>
        </div>
      </div>

      <div class="retrieve-preview-bar">
        <div class="retrieve-preview-label">Preview (dry-run, no state mutation)</div>
        <textarea
          class="retrieve-preview-input"
          placeholder="Type a user message to see what retrieve would inject right now…"
          value={previewText()}
          onInput={(e) => setPreviewText(e.currentTarget.value)}
          rows={2}
        />
        <Button variant="primary" size="small" disabled={previewBusy()} onClick={runPreview}>
          {previewBusy() ? "…" : "Preview"}
        </Button>
        <Show when={previewError()}>
          <div class="retrieve-preview-error">{previewError()}</div>
        </Show>
        <Show when={previewResult()}>
          {(res) => (
            <div class="retrieve-preview-result">
              <div class="retrieve-preview-result-head">
                Would pick {res().picked.length} · turn #{res().turn_index} · agent_layer {res().agent_layer}
              </div>
              <ul class="retrieve-preview-list">
                <For each={res().picked}>
                  {(p) => (
                    <li>
                      <code>{p.experience_id}</code> {p.title}
                      <span class="retrieve-preview-pick-source" style={{ color: sourceColorVar(p.source) }}>
                        {" "}
                        ({sourceLabel(p.source)})
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}

/** Reconstruct the rendered system block exactly the way retrieve/index.ts emits it. */
function renderSystemTextPreview(entry: RetrieveLogEntry): string {
  if (entry.picked.length === 0) return "(nothing to render)"
  const lines: string[] = []
  lines.push("<retrieved_experiences>")
  lines.push(
    "These reusable experiences were selected for this turn based on the conversation. " +
      "Use them as soft guidance — they describe rules, conventions, or knowledge from prior interactions in this workspace.",
  )
  lines.push("")
  for (const p of entry.picked) {
    lines.push(
      `<experience id="${p.experience_id}" kind="${p.kind}"${
        p.target_layer ? ` layer="${p.target_layer}"` : ""
      }>`,
    )
    lines.push(`title: ${p.title}`)
    if (p.statement) lines.push(`rule: ${p.statement}`)
    lines.push(`detail: ${p.abstract}`)
    if (p.trigger_condition) lines.push(`when: ${p.trigger_condition}`)
    lines.push("</experience>")
  }
  lines.push("</retrieved_experiences>")
  return lines.join("\n")
}
