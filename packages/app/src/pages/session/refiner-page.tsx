import { Button } from "@opencode-ai/ui/button"
import {
  createEffect,
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
import "./refiner-page.css"

/* ──────────────────────────────────────────────────────
   Types — schema v2 (experiences + observations)
   ────────────────────────────────────────────────────── */

const CORE_KINDS = [
  "workflow_rule",
  "workflow_gap",
  "know_how",
  "constraint_or_policy",
  "domain_knowledge",
  "preference_style",
  "pitfall_or_caveat",
] as const
type CoreKind = (typeof CORE_KINDS)[number]
type Kind = CoreKind | `custom:${string}`

type Scope = "workspace" | "project" | "repo" | "user"

type HistoryEntry = {
  role: "user" | "assistant"
  text: string
  message_id: string
}

type WorkflowSnapshot = {
  workflow_id: string
  node_id?: string
  phase?: string
  recent_events: Array<{ kind: string; at: number; summary: string }>
}

type Observation = {
  id: string
  observed_at: number
  session_id: string
  message_id: string
  user_text: string
  agent_context: {
    session_history_excerpt: HistoryEntry[]
    workflow_snapshot?: WorkflowSnapshot
  }
}

type RefinementSnapshot = {
  kind: Kind
  title: string
  abstract: string
  statement?: string
  trigger_condition?: string
  task_type?: string
  scope: Scope
  categories?: string[]
}

type RefinementEntry = {
  at: number
  trigger_observation_id: string
  prev_abstract_digest: string
  prev_snapshot?: RefinementSnapshot
  model: string
  kind?: "refine" | "manual_edit" | "merge" | "re_refine" | "augment"
  source_ids?: string[]
}

type Experience = {
  id: string
  kind: Kind
  title: string
  abstract: string
  statement?: string
  trigger_condition?: string
  task_type?: string
  scope: Scope
  categories?: string[]
  conflicts_with?: string[]
  archived?: boolean
  archived_at?: number
  observations: Observation[]
  related_experience_ids: string[]
  refinement_history: RefinementEntry[]
  created_at: number
  last_refined_at: number
  path: string
}

type CategoryEntry = {
  slug: string
  count: number
  experience_ids: string[]
  last_seen_at?: number
}

type CategoriesResponse = {
  categories: CategoryEntry[]
}

type SearchHit = {
  experience: Experience
  matches: { field: "title" | "abstract" | "statement" | "task_type" | "category" | "observation"; snippet: string }[]
}

type SearchResponse = {
  hits: SearchHit[]
  query: string
  total: number
}

type GraphNode = {
  id: string
  type: "experience" | "observation"
  label: string
  secondary?: string
  kind?: Kind
  path?: string
}

type GraphEdge = {
  from: string
  to: string
  kind: "has_observation" | "related"
}

type RefinerOverview = {
  schema_version: 2
  status: {
    total_experiences: number
    total_observations: number
    latest_refined_at?: number
  }
  model?: { providerID: string; modelID: string }
  experiences: Experience[]
  graph: { nodes: GraphNode[]; edges: GraphEdge[] }
}

type TaxonomyEntry = {
  slug: string
  first_seen_at?: number
  count: number
  sample_ids?: string[]
}

type TaxonomyResponse = {
  core: Array<{ slug: CoreKind; description?: string } | string>
  custom: TaxonomyEntry[]
}

/* ──────────────────────────────────────────────────────
   Kind palette — map each CORE kind to a palette name
   defined in packages/ui/src/styles/colors.css.
   Custom kinds fall back to the neutral "gray" palette.
   ────────────────────────────────────────────────────── */

type PaletteName =
  | "cobalt"
  | "amber"
  | "mint"
  | "ember"
  | "blue"
  | "lilac"
  | "solaris"
  | "gray"

const KIND_PALETTE: Record<CoreKind, PaletteName> = {
  workflow_rule: "cobalt",
  workflow_gap: "amber",
  know_how: "mint",
  constraint_or_policy: "ember",
  domain_knowledge: "blue",
  preference_style: "lilac",
  pitfall_or_caveat: "solaris",
}

const KIND_LABEL: Record<CoreKind, string> = {
  workflow_rule: "流程规则",
  workflow_gap: "流程缺口",
  know_how: "操作指导",
  constraint_or_policy: "硬约束",
  domain_knowledge: "领域知识",
  preference_style: "风格偏好",
  pitfall_or_caveat: "注意事项",
}

function paletteFor(kind?: Kind): PaletteName {
  if (!kind) return "gray"
  if (kind.startsWith("custom:")) return "gray"
  return KIND_PALETTE[kind as CoreKind] ?? "gray"
}

function kindDisplay(kind?: Kind) {
  if (!kind) return "—"
  if (kind.startsWith("custom:")) return kind.slice("custom:".length)
  return KIND_LABEL[kind as CoreKind] ?? kind
}

/* ── Helpers ── */

const fmtTime = (value?: string | number) =>
  value
    ? new Date(value).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—"

const clip = (value?: string, size = 120) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim()
  if (!text) return "—"
  return text.length <= size ? text : `${text.slice(0, size - 1).trimEnd()}…`
}

const modelLabel = (model?: { providerID: string; modelID: string }) =>
  model ? `${model.providerID}/${model.modelID}` : "—"

function buildHeaders(input: {
  directory: string
  username?: string
  password?: string
  extra?: Record<string, string>
}) {
  const headers: Record<string, string> = {
    "x-opencode-directory": encodeURIComponent(input.directory),
    ...(input.extra ?? {}),
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
        `Backend may need a restart to load new refiner routes. Response: ${preview}`,
    )
  }
  return (await res.json()) as T
}

async function fetchOverview(input: {
  baseUrl: string
  directory: string
  sessionID: string
  scope: "all" | "session"
  includeArchived?: boolean
  password?: string
  username?: string
  fetcher?: typeof fetch
}) {
  const url = new URL("/experimental/refiner/overview", input.baseUrl)
  url.searchParams.set("session_id", input.sessionID)
  url.searchParams.set("limit", "40")
  url.searchParams.set("scope", input.scope)
  if (input.includeArchived) url.searchParams.set("include_archived", "true")
  const res = await (input.fetcher ?? fetch)(url, {
    headers: buildHeaders({
      directory: input.directory,
      username: input.username,
      password: input.password,
    }),
  })
  if (!res.ok) throw new Error(`Failed to load refiner overview (${res.status})`)
  return readJsonOrThrow<RefinerOverview>(res, "Refiner overview")
}

async function fetchTaxonomy(input: {
  baseUrl: string
  directory: string
  password?: string
  username?: string
  fetcher?: typeof fetch
}) {
  const url = new URL("/experimental/refiner/taxonomy", input.baseUrl)
  const res = await (input.fetcher ?? fetch)(url, {
    headers: buildHeaders({
      directory: input.directory,
      username: input.username,
      password: input.password,
    }),
  })
  if (!res.ok) throw new Error(`Failed to load refiner taxonomy (${res.status})`)
  return readJsonOrThrow<TaxonomyResponse>(res, "Refiner taxonomy")
}

type ConfigSource = "override" | "agent" | "default" | "none"

type RefinerConfig = {
  resolved?: { providerID: string; modelID: string }
  source: ConfigSource
  override: { model?: { providerID: string; modelID: string }; temperature?: number } | null
}

async function fetchConfig(input: {
  baseUrl: string
  directory: string
  password?: string
  username?: string
  fetcher?: typeof fetch
}) {
  const url = new URL("/experimental/refiner/config", input.baseUrl)
  const res = await (input.fetcher ?? fetch)(url, {
    headers: buildHeaders({
      directory: input.directory,
      username: input.username,
      password: input.password,
    }),
  })
  if (!res.ok) throw new Error(`Failed to load refiner config (${res.status})`)
  return readJsonOrThrow<RefinerConfig>(res, "Refiner config")
}

async function putConfig(input: {
  baseUrl: string
  directory: string
  password?: string
  username?: string
  fetcher?: typeof fetch
  body: { model?: { providerID: string; modelID: string } | null; temperature?: number | null }
}) {
  const url = new URL("/experimental/refiner/config", input.baseUrl)
  const res = await (input.fetcher ?? fetch)(url, {
    method: "PUT",
    headers: buildHeaders({
      directory: input.directory,
      username: input.username,
      password: input.password,
      extra: { "content-type": "application/json" },
    }),
    body: JSON.stringify(input.body),
  })
  if (!res.ok) throw new Error(`Failed to update refiner config (${res.status})`)
  return readJsonOrThrow<RefinerConfig>(res, "Refiner config update")
}

const SOURCE_LABEL: Record<ConfigSource, string> = {
  override: "override",
  agent: "agent config",
  default: "default",
  none: "—",
}

/* ──────────────────────────────────────────────────────
   HTTP helpers for all action endpoints
   ────────────────────────────────────────────────────── */

type ApiBase = {
  baseUrl: string
  directory: string
  password?: string
  username?: string
  fetcher?: typeof fetch
}

async function apiRequest<T = unknown>(
  base: ApiBase,
  path: string,
  init: {
    method?: string
    json?: unknown
    query?: Record<string, string | number | boolean | undefined>
  } = {},
): Promise<T> {
  const url = new URL(path, base.baseUrl)
  if (init.query) {
    for (const [k, v] of Object.entries(init.query)) {
      if (v === undefined || v === null || v === "") continue
      url.searchParams.set(k, String(v))
    }
  }
  const headers = buildHeaders({
    directory: base.directory,
    username: base.username,
    password: base.password,
    extra: init.json !== undefined ? { "content-type": "application/json" } : undefined,
  })
  const res = await (base.fetcher ?? fetch)(url, {
    method: init.method ?? "GET",
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  })
  if (!res.ok) {
    let detail = ""
    try {
      const body = await res.text()
      detail = body ? `: ${body.slice(0, 300)}` : ""
    } catch {}
    throw new Error(`Refiner request ${path} failed (${res.status})${detail}`)
  }
  const ctype = res.headers.get("content-type") ?? ""
  if (!ctype.includes("application/json")) {
    // Backend returned the SPA fallback (HTML) — route not registered.
    // Usually means the backend needs to be restarted to pick up new endpoints.
    const body = await res.text().catch(() => "")
    const preview = body.slice(0, 120).replace(/\s+/g, " ")
    throw new Error(
      `Refiner endpoint ${path} did not return JSON (got "${ctype}"). ` +
        `Is the backend running the current build? Response started with: ${preview}`,
    )
  }
  return (await res.json()) as T
}

const fetchCategories = (b: ApiBase): Promise<CategoriesResponse> =>
  apiRequest<CategoriesResponse>(b, "/experimental/refiner/categories").catch((err) => {
    // Graceful degradation — if the backend hasn't been restarted yet to pick up
    // the new categories endpoint, show an empty strip instead of crashing the page.
    console.warn("[refiner] categories endpoint unavailable:", err)
    return { categories: [] }
  })

const apiDeleteExperience = (b: ApiBase, id: string, opts?: { cascade?: boolean; reason?: string }) =>
  apiRequest(b, `/experimental/refiner/experience/${encodeURIComponent(id)}`, {
    method: "DELETE",
    query: { cascade: opts?.cascade, reason: opts?.reason },
  })

const apiArchiveExperience = (b: ApiBase, id: string, archived: boolean) =>
  apiRequest(b, `/experimental/refiner/experience/${encodeURIComponent(id)}/archive`, {
    method: "POST",
    json: { archived },
  })

const apiAugmentExperience = (
  b: ApiBase,
  id: string,
  input: { user_text: string; note?: string },
) =>
  apiRequest(b, `/experimental/refiner/experience/${encodeURIComponent(id)}/observation`, {
    method: "POST",
    json: input,
  })

const apiCreateExperience = (
  b: ApiBase,
  input: {
    user_text: string
    kind_hint?: string
    scope_hint?: Scope
    task_type_hint?: string
    note?: string
  },
) =>
  apiRequest(b, `/experimental/refiner/experience`, {
    method: "POST",
    json: input,
  })

const apiPatchExperience = (
  b: ApiBase,
  id: string,
  body: {
    title?: string
    abstract?: string
    statement?: string | null
    trigger_condition?: string | null
    task_type?: string | null
    scope?: Scope
    categories?: string[]
  },
) =>
  apiRequest(b, `/experimental/refiner/experience/${encodeURIComponent(id)}`, {
    method: "PATCH",
    json: body,
  })

const apiReRefineExperience = (b: ApiBase, id: string) =>
  apiRequest(b, `/experimental/refiner/experience/${encodeURIComponent(id)}/refine`, {
    method: "POST",
  })

const apiUndoRefinement = (b: ApiBase, id: string) =>
  apiRequest(b, `/experimental/refiner/experience/${encodeURIComponent(id)}/undo-refinement`, {
    method: "POST",
  })

const apiDeleteObservation = (b: ApiBase, experienceID: string, observationID: string) =>
  apiRequest(
    b,
    `/experimental/refiner/experience/${encodeURIComponent(experienceID)}/observation/${encodeURIComponent(observationID)}`,
    { method: "DELETE" },
  )

const apiMoveObservation = (
  b: ApiBase,
  input: { observation_id: string; from_experience_id: string; to_experience_id: string },
) =>
  apiRequest(b, `/experimental/refiner/observation/move`, {
    method: "POST",
    json: input,
  })

const apiMergeExperiences = (b: ApiBase, ids: string[], reason?: string) =>
  apiRequest(b, `/experimental/refiner/experience/merge`, {
    method: "POST",
    json: { ids, reason },
  })

const apiSearch = (b: ApiBase, q: string, opts?: { limit?: number; includeArchived?: boolean }) =>
  apiRequest<SearchResponse>(b, `/experimental/refiner/search`, {
    query: {
      q,
      limit: opts?.limit,
      include_archived: opts?.includeArchived,
    },
  })

const apiIngestSession = (b: ApiBase, sessionID: string) =>
  apiRequest(b, `/experimental/refiner/ingest-session/${encodeURIComponent(sessionID)}`, {
    method: "POST",
  })

const apiExport = (b: ApiBase) => apiRequest<Record<string, unknown>>(b, `/experimental/refiner/export`)

const apiImport = (b: ApiBase, data: unknown, mode?: "merge" | "replace") =>
  apiRequest(b, `/experimental/refiner/import`, {
    method: "POST",
    json: { data, mode },
  })

/* ──────────────────────────────────────────────────────
   Light-weight modal primitive used by all refiner dialogs
   ────────────────────────────────────────────────────── */

type ModalProps = {
  title: string
  subtitle?: string
  onClose: () => void
  tone?: "default" | "danger"
  children: any
  footer?: any
  wide?: boolean
  busy?: boolean
}

function RfModal(props: ModalProps) {
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose()
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => document.removeEventListener("keydown", onKey))
  })

  return (
    <div class="rf-modal-scrim" onClick={() => props.onClose()}>
      <div
        class="rf-modal"
        data-tone={props.tone ?? "default"}
        data-wide={props.wide ? "true" : "false"}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="rf-modal-head">
          <div class="rf-modal-titles">
            <div class="rf-modal-title">{props.title}</div>
            <Show when={props.subtitle}>
              <div class="rf-modal-subtitle">{props.subtitle}</div>
            </Show>
          </div>
          <button
            type="button"
            class="rf-modal-close"
            aria-label="关闭"
            onClick={() => props.onClose()}
          >
            ×
          </button>
        </div>
        <div class="rf-modal-body">{props.children}</div>
        <Show when={props.footer}>
          <div class="rf-modal-foot">{props.footer}</div>
        </Show>
        <Show when={props.busy}>
          <div class="rf-modal-busy">
            <span class="rf-spinner" />
            <span>Working…</span>
          </div>
        </Show>
      </div>
    </div>
  )
}

/* ──────────────────────────────────────────────────────
   Action definitions — centralized modal type union
   ────────────────────────────────────────────────────── */

type ActionKind =
  | { type: "create" }
  | { type: "augment"; experience: Experience }
  | { type: "edit"; experience: Experience }
  | { type: "delete"; experience: Experience }
  | { type: "merge"; ids: string[] }
  | { type: "import" }
  | { type: "search" }
  | { type: "ingest"; sessionID: string }
  | { type: "deleteObservation"; experience: Experience; observation: Observation }
  | { type: "moveObservation"; experience: Experience; observation: Observation }

const CORE_KIND_LABELS: Array<{ slug: CoreKind; label: string }> = CORE_KINDS.map((slug) => ({
  slug,
  label: KIND_LABEL[slug],
}))

const SCOPES: Scope[] = ["workspace", "project", "repo", "user"]
const SCOPE_LABEL: Record<Scope, string> = {
  workspace: "工作区 (workspace)",
  project: "项目 (project)",
  repo: "仓库 (repo)",
  user: "用户 (user)",
}


/* ──────────────────────────────────────────────────────
   Model picker — unchanged UX
   ────────────────────────────────────────────────────── */

function ModelPicker(props: {
  current?: { providerID: string; modelID: string }
  source?: ConfigSource
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
    <div class="rf-model" ref={(el) => (root = el)}>
      <button
        type="button"
        class="rf-model-trigger"
        aria-expanded={open() ? "true" : "false"}
        onClick={() => setOpen((v) => !v)}
        title={props.source ? `source: ${SOURCE_LABEL[props.source]}` : undefined}
      >
        <span class="rf-dot" />
        <span>{modelLabel(props.current)}</span>
        <Show when={props.source && props.source !== "none"}>
          <span class="rf-model-source" data-source={props.source}>
            {SOURCE_LABEL[props.source!]}
          </span>
        </Show>
        <span class="rf-model-caret">▾</span>
      </button>
      <Show when={open()}>
        <div class="rf-model-menu">
          <Show when={props.source === "override" && props.onReset}>
            <button
              type="button"
              class="rf-model-item rf-model-reset"
              onClick={() => {
                props.onReset?.()
                setOpen(false)
              }}
            >
              ⟲ 恢复默认（agent 默认模型）
            </button>
            <div class="rf-model-sep" />
          </Show>
          <Show
            when={grouped().length > 0}
            fallback={<div class="rf-model-group">暂无可用模型</div>}
          >
            <For each={grouped()}>
              {([providerName, items]) => (
                <>
                  <div class="rf-model-group">{providerName}</div>
                  <For each={items}>
                    {(item) => {
                      const active = () =>
                        props.current?.providerID === item.providerID &&
                        props.current?.modelID === item.modelID
                      return (
                        <button
                          type="button"
                          class="rf-model-item"
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
   Overflow "More" menu — consolidates secondary actions
   ────────────────────────────────────────────────────── */

type MoreMenuItem =
  | { type: "action"; key: string; label: string; icon: string; onPick: () => void }
  | { type: "toggle"; key: string; label: string; icon: string; checked: boolean; onToggle: () => void }
  | { type: "sep" }

function MoreMenu(props: { items: MoreMenuItem[] }) {
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
    <div class="rf-more" ref={(el) => (root = el)}>
      <button
        type="button"
        class="rf-topbtn rf-topbtn-icon"
        aria-label="更多操作"
        aria-expanded={open() ? "true" : "false"}
        onClick={() => setOpen((v) => !v)}
        title="更多操作"
      >
        ⋯
      </button>
      <Show when={open()}>
        <div class="rf-more-menu">
          <For each={props.items}>
            {(item) => {
              if (item.type === "sep") return <div class="rf-more-sep" />
              if (item.type === "toggle") {
                return (
                  <button
                    type="button"
                    class="rf-more-item"
                    data-active={item.checked ? "true" : "false"}
                    onClick={() => {
                      item.onToggle()
                    }}
                  >
                    <span class="rf-more-check" data-checked={item.checked ? "true" : "false"}>
                      {item.checked ? "✓" : ""}
                    </span>
                    <span>{item.label}</span>
                  </button>
                )
              }
              return (
                <button
                  type="button"
                  class="rf-more-item"
                  onClick={() => {
                    setOpen(false)
                    item.onPick()
                  }}
                >
                  <span class="rf-more-kbd" style={{ "margin-left": "0", "margin-right": "8px", width: "16px" }}>
                    {item.icon}
                  </span>
                  <span>{item.label}</span>
                </button>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}

/* ──────────────────────────────────────────────────────
   Modal: Create experience (agent-assist)
   ────────────────────────────────────────────────────── */

function CreateModal(props: {
  onClose: () => void
  onSubmit: (input: {
    user_text: string
    kind_hint?: string
    scope_hint?: Scope
    task_type_hint?: string
    note?: string
  }) => Promise<void>
}) {
  const [userText, setUserText] = createSignal("")
  const [kindHint, setKindHint] = createSignal<string>("")
  const [scopeHint, setScopeHint] = createSignal<Scope>("project")
  const [taskHint, setTaskHint] = createSignal("")
  const [note, setNote] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>()

  const canSubmit = () => userText().trim().length >= 6 && !busy()

  const submit = async () => {
    if (!canSubmit()) return
    setBusy(true)
    setError(undefined)
    try {
      await props.onSubmit({
        user_text: userText().trim(),
        kind_hint: kindHint() || undefined,
        scope_hint: scopeHint(),
        task_type_hint: taskHint().trim() || undefined,
        note: note().trim() || undefined,
      })
      props.onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <RfModal
      title="New experience"
      subtitle="描述一条规则 / 事实 / 陷阱，Refiner 会自动抽象、分类并归档。"
      onClose={props.onClose}
      wide
      busy={busy()}
      footer={
        <>
          <button
            type="button"
            class="rf-btn rf-btn-ghost"
            onClick={() => props.onClose()}
            disabled={busy()}
          >
            取消
          </button>
          <button
            type="button"
            class="rf-btn rf-btn-primary"
            onClick={() => void submit()}
            disabled={!canSubmit()}
          >
            Create (with LLM)
          </button>
        </>
      }
    >
      <label class="rf-field">
        <span class="rf-field-label">
          Description <span class="rf-field-note">（必填，≥ 6 字）</span>
        </span>
        <textarea
          class="rf-textarea"
          rows={5}
          placeholder="例：每次 commit 前必须先跑 bun test 和 lint，失败就不提交。"
          value={userText()}
          onInput={(e) => setUserText(e.currentTarget.value)}
          autofocus
        />
      </label>
      <div class="rf-field-row">
        <label class="rf-field">
          <span class="rf-field-label">Kind hint (optional)</span>
          <select
            class="rf-select"
            value={kindHint()}
            onChange={(e) => setKindHint(e.currentTarget.value)}
          >
            <option value="">— let the model decide —</option>
            <For each={CORE_KIND_LABELS}>
              {(k) => <option value={k.slug}>{k.label}</option>}
            </For>
          </select>
        </label>
        <label class="rf-field">
          <span class="rf-field-label">Scope</span>
          <select
            class="rf-select"
            value={scopeHint()}
            onChange={(e) => setScopeHint(e.currentTarget.value as Scope)}
          >
            <For each={SCOPES}>{(s) => <option value={s}>{SCOPE_LABEL[s]}</option>}</For>
          </select>
        </label>
        <label class="rf-field">
          <span class="rf-field-label">Task type (optional)</span>
          <input
            type="text"
            class="rf-input"
            placeholder="e.g. coding / review"
            value={taskHint()}
            onInput={(e) => setTaskHint(e.currentTarget.value)}
          />
        </label>
      </div>
      <label class="rf-field">
        <span class="rf-field-label">Note (optional, internal)</span>
        <input
          type="text"
          class="rf-input"
          placeholder="为什么要新建这条 experience"
          value={note()}
          onInput={(e) => setNote(e.currentTarget.value)}
        />
      </label>
      <Show when={error()}>
        <div class="rf-modal-error">{error()}</div>
      </Show>
    </RfModal>
  )
}

/* ──────────────────────────────────────────────────────
   Modal: Augment experience
   ────────────────────────────────────────────────────── */

function AugmentModal(props: {
  experience: Experience
  onClose: () => void
  onSubmit: (input: { user_text: string; note?: string }) => Promise<void>
}) {
  const [userText, setUserText] = createSignal("")
  const [note, setNote] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>()

  const canSubmit = () => userText().trim().length >= 6 && !busy()

  const submit = async () => {
    if (!canSubmit()) return
    setBusy(true)
    setError(undefined)
    try {
      await props.onSubmit({
        user_text: userText().trim(),
        note: note().trim() || undefined,
      })
      props.onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <RfModal
      title="Add observation"
      subtitle={`为 “${clip(props.experience.title, 60)}” 追加一条 observation，并触发 re-refine。`}
      onClose={props.onClose}
      busy={busy()}
      footer={
        <>
          <button
            type="button"
            class="rf-btn rf-btn-ghost"
            onClick={() => props.onClose()}
            disabled={busy()}
          >
            取消
          </button>
          <button
            type="button"
            class="rf-btn rf-btn-primary"
            onClick={() => void submit()}
            disabled={!canSubmit()}
          >
            Attach & re-refine
          </button>
        </>
      }
    >
      <label class="rf-field">
        <span class="rf-field-label">Observation text</span>
        <textarea
          class="rf-textarea"
          rows={5}
          placeholder="描述一个能强化该 experience 的例子 / 复述 / 补充说明。"
          value={userText()}
          onInput={(e) => setUserText(e.currentTarget.value)}
          autofocus
        />
      </label>
      <label class="rf-field">
        <span class="rf-field-label">Note (optional, internal)</span>
        <input
          type="text"
          class="rf-input"
          placeholder="为什么要追加这条 observation"
          value={note()}
          onInput={(e) => setNote(e.currentTarget.value)}
        />
      </label>
      <Show when={error()}>
        <div class="rf-modal-error">{error()}</div>
      </Show>
    </RfModal>
  )
}

/* ──────────────────────────────────────────────────────
   Modal: Manual edit (no-LLM)
   ────────────────────────────────────────────────────── */

function EditModal(props: {
  experience: Experience
  onClose: () => void
  onSubmit: (input: {
    title?: string
    abstract?: string
    statement?: string | null
    trigger_condition?: string | null
    task_type?: string | null
    scope?: Scope
    categories?: string[]
  }) => Promise<void>
}) {
  const exp = props.experience
  const [title, setTitle] = createSignal(exp.title)
  const [abstractVal, setAbstractVal] = createSignal(exp.abstract)
  const [statement, setStatement] = createSignal(exp.statement ?? "")
  const [trigger, setTrigger] = createSignal(exp.trigger_condition ?? "")
  const [taskType, setTaskType] = createSignal(exp.task_type ?? "")
  const [scope, setScope] = createSignal<Scope>(exp.scope)
  const [categories, setCategories] = createSignal((exp.categories ?? []).join(", "))
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>()

  const canSubmit = () =>
    title().trim().length > 0 && abstractVal().trim().length > 0 && !busy()

  const submit = async () => {
    if (!canSubmit()) return
    setBusy(true)
    setError(undefined)
    const parsedCategories = categories()
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0)
    try {
      await props.onSubmit({
        title: title().trim(),
        abstract: abstractVal().trim(),
        statement: statement().trim() ? statement().trim() : null,
        trigger_condition: trigger().trim() ? trigger().trim() : null,
        task_type: taskType().trim() ? taskType().trim() : null,
        scope: scope(),
        categories: parsedCategories,
      })
      props.onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <RfModal
      title="Manual edit"
      subtitle="不调用 LLM；会记录一次 manual_edit 快照，可供 undo 回滚。"
      onClose={props.onClose}
      wide
      busy={busy()}
      footer={
        <>
          <button
            type="button"
            class="rf-btn rf-btn-ghost"
            onClick={() => props.onClose()}
            disabled={busy()}
          >
            取消
          </button>
          <button
            type="button"
            class="rf-btn rf-btn-primary"
            onClick={() => void submit()}
            disabled={!canSubmit()}
          >
            Save
          </button>
        </>
      }
    >
      <label class="rf-field">
        <span class="rf-field-label">Title</span>
        <input
          type="text"
          class="rf-input"
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
        />
      </label>
      <label class="rf-field">
        <span class="rf-field-label">Abstract</span>
        <textarea
          class="rf-textarea"
          rows={4}
          value={abstractVal()}
          onInput={(e) => setAbstractVal(e.currentTarget.value)}
        />
      </label>
      <label class="rf-field">
        <span class="rf-field-label">Statement (machine-readable)</span>
        <input
          type="text"
          class="rf-input rf-input-mono"
          placeholder="e.g. after:commit => require:lint"
          value={statement()}
          onInput={(e) => setStatement(e.currentTarget.value)}
        />
      </label>
      <label class="rf-field">
        <span class="rf-field-label">Trigger condition</span>
        <input
          type="text"
          class="rf-input"
          value={trigger()}
          onInput={(e) => setTrigger(e.currentTarget.value)}
        />
      </label>
      <div class="rf-field-row">
        <label class="rf-field">
          <span class="rf-field-label">Task type</span>
          <input
            type="text"
            class="rf-input"
            value={taskType()}
            onInput={(e) => setTaskType(e.currentTarget.value)}
          />
        </label>
        <label class="rf-field">
          <span class="rf-field-label">Scope</span>
          <select
            class="rf-select"
            value={scope()}
            onChange={(e) => setScope(e.currentTarget.value as Scope)}
          >
            <For each={SCOPES}>{(s) => <option value={s}>{SCOPE_LABEL[s]}</option>}</For>
          </select>
        </label>
      </div>
      <label class="rf-field">
        <span class="rf-field-label">
          Categories <span class="rf-field-note">（用英文逗号分隔，kebab-case）</span>
        </span>
        <input
          type="text"
          class="rf-input"
          placeholder="git-workflow, ci-pipeline"
          value={categories()}
          onInput={(e) => setCategories(e.currentTarget.value)}
        />
      </label>
      <Show when={error()}>
        <div class="rf-modal-error">{error()}</div>
      </Show>
    </RfModal>
  )
}

/* ──────────────────────────────────────────────────────
   Modal: Delete confirmation
   ────────────────────────────────────────────────────── */

function DeleteModal(props: {
  experience: Experience
  onClose: () => void
  onSubmit: (opts: { cascade: boolean; reason?: string }) => Promise<void>
}) {
  const [cascade, setCascade] = createSignal(true)
  const [reason, setReason] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>()

  const submit = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await props.onSubmit({
        cascade: cascade(),
        reason: reason().trim() || undefined,
      })
      props.onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <RfModal
      title="Delete experience"
      subtitle={`“${clip(props.experience.title, 80)}” — 删除后不可恢复。`}
      tone="danger"
      onClose={props.onClose}
      busy={busy()}
      footer={
        <>
          <button
            type="button"
            class="rf-btn rf-btn-ghost"
            onClick={() => props.onClose()}
            disabled={busy()}
          >
            取消
          </button>
          <button
            type="button"
            class="rf-btn rf-btn-danger"
            onClick={() => void submit()}
            disabled={busy()}
          >
            Delete
          </button>
        </>
      }
    >
      <div class="rf-modal-note">
        该 experience 已挂载 <b>{props.experience.observations.length}</b> 条 observation。
      </div>
      <label class="rf-checkline">
        <input
          type="checkbox"
          checked={cascade()}
          onChange={(e) => setCascade(e.currentTarget.checked)}
        />
        <span>同时从磁盘中删除其 observation 文件</span>
      </label>
      <label class="rf-field">
        <span class="rf-field-label">Reason (optional, for audit)</span>
        <input
          type="text"
          class="rf-input"
          value={reason()}
          onInput={(e) => setReason(e.currentTarget.value)}
          placeholder="为什么要删除"
        />
      </label>
      <Show when={error()}>
        <div class="rf-modal-error">{error()}</div>
      </Show>
    </RfModal>
  )
}

/* ──────────────────────────────────────────────────────
   Modal: Merge experiences
   ────────────────────────────────────────────────────── */

function MergeModal(props: {
  experiences: Experience[]
  onClose: () => void
  onSubmit: (reason?: string) => Promise<void>
}) {
  const [reason, setReason] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>()

  const submit = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await props.onSubmit(reason().trim() || undefined)
      props.onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const totalObs = () =>
    props.experiences.reduce((sum, e) => sum + e.observations.length, 0)

  return (
    <RfModal
      title={`Merge ${props.experiences.length} experiences`}
      subtitle="Refiner 将基于合并后的全部 observations 重新精炼出一条新 experience。源 experiences 会被归档（不会删除）。如模型未产出有效摘要，将自动沿用种子 experience 字段，可手动 re-refine。"
      onClose={props.onClose}
      wide
      busy={busy()}
      footer={
        <>
          <button
            type="button"
            class="rf-btn rf-btn-ghost"
            onClick={() => props.onClose()}
            disabled={busy()}
          >
            取消
          </button>
          <button
            type="button"
            class="rf-btn rf-btn-primary"
            onClick={() => void submit()}
            disabled={busy() || props.experiences.length < 2}
          >
            Merge ({totalObs()} observations)
          </button>
        </>
      }
    >
      <div class="rf-modal-note">将合并以下 experiences：</div>
      <ul class="rf-merge-list">
        <For each={props.experiences}>
          {(e) => (
            <li>
              <span
                class="rf-dot rf-dot-sm"
                data-palette={paletteFor(e.kind)}
              />
              <span class="rf-merge-kind">{kindDisplay(e.kind)}</span>
              <span class="rf-merge-title">{clip(e.title, 80)}</span>
              <span class="rf-merge-obs">{e.observations.length} obs</span>
            </li>
          )}
        </For>
      </ul>
      <label class="rf-field">
        <span class="rf-field-label">Reason (optional, for audit)</span>
        <input
          type="text"
          class="rf-input"
          value={reason()}
          onInput={(e) => setReason(e.currentTarget.value)}
          placeholder="为什么要合并这些 experiences"
        />
      </label>
      <Show when={error()}>
        <div class="rf-modal-error">{error()}</div>
      </Show>
    </RfModal>
  )
}

/* ──────────────────────────────────────────────────────
   Modal: Import bundle
   ────────────────────────────────────────────────────── */

function ImportModal(props: {
  onClose: () => void
  onSubmit: (input: { data: unknown; mode: "merge" | "replace" }) => Promise<void>
}) {
  const [raw, setRaw] = createSignal("")
  const [mode, setMode] = createSignal<"merge" | "replace">("merge")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>()

  const submit = async () => {
    setBusy(true)
    setError(undefined)
    let data: unknown
    try {
      data = JSON.parse(raw())
    } catch (err) {
      setError("Invalid JSON")
      setBusy(false)
      return
    }
    try {
      await props.onSubmit({ data, mode: mode() })
      props.onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    const text = await file.text()
    setRaw(text)
  }

  return (
    <RfModal
      title="导入 Bundle"
      subtitle="粘贴导出的 bundle JSON，或选择一个 JSON 文件。"
      onClose={props.onClose}
      wide
      busy={busy()}
      footer={
        <>
          <button
            type="button"
            class="rf-btn rf-btn-ghost"
            onClick={() => props.onClose()}
            disabled={busy()}
          >
            取消
          </button>
          <button
            type="button"
            class="rf-btn rf-btn-primary"
            onClick={() => void submit()}
            disabled={busy() || raw().trim().length === 0}
          >
            导入
          </button>
        </>
      }
    >
      <div class="rf-field-row">
        <label class="rf-field">
          <span class="rf-field-label">模式</span>
          <select
            class="rf-select"
            value={mode()}
            onChange={(e) => setMode(e.currentTarget.value as "merge" | "replace")}
          >
            <option value="merge">合并（按 id 追加 / 覆盖）</option>
            <option value="replace">替换（先清空再导入）</option>
          </select>
        </label>
        <label class="rf-field">
          <span class="rf-field-label">从文件选取</span>
          <input
            type="file"
            accept="application/json,.json"
            class="rf-input"
            onChange={(e) => void onFile(e.currentTarget.files?.[0])}
          />
        </label>
      </div>
      <label class="rf-field">
        <span class="rf-field-label">Bundle JSON</span>
        <textarea
          class="rf-textarea rf-textarea-mono"
          rows={10}
          placeholder='{ "experiences": [...] }'
          value={raw()}
          onInput={(e) => setRaw(e.currentTarget.value)}
        />
      </label>
      <Show when={error()}>
        <div class="rf-modal-error">{error()}</div>
      </Show>
    </RfModal>
  )
}

/* ──────────────────────────────────────────────────────
   Modal: Search
   ────────────────────────────────────────────────────── */

function SearchModal(props: {
  initialQuery?: string
  runSearch: (q: string, includeArchived: boolean) => Promise<SearchResponse>
  onPick: (experienceID: string) => void
  onClose: () => void
}) {
  const [q, setQ] = createSignal(props.initialQuery ?? "")
  const [includeArchived, setIncludeArchived] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [response, setResponse] = createSignal<SearchResponse | undefined>()
  const [error, setError] = createSignal<string | undefined>()

  let debounceTimer: ReturnType<typeof setTimeout> | undefined

  const run = async () => {
    const query = q().trim()
    if (query.length < 2) {
      setResponse(undefined)
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const res = await props.runSearch(query, includeArchived())
      setResponse(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  createEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    q()
    includeArchived()
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => void run(), 200)
  })

  onCleanup(() => {
    if (debounceTimer) clearTimeout(debounceTimer)
  })

  return (
    <RfModal
      title="Search refiner memory"
      onClose={props.onClose}
      wide
      footer={
        <label class="rf-checkline">
          <input
            type="checkbox"
            checked={includeArchived()}
            onChange={(e) => setIncludeArchived(e.currentTarget.checked)}
          />
          <span>Include archived</span>
        </label>
      }
    >
      <input
        type="text"
        class="rf-input rf-input-search"
        placeholder="在 title / abstract / observation 中搜索关键字…"
        value={q()}
        onInput={(e) => setQ(e.currentTarget.value)}
        autofocus
      />
      <Show when={error()}>
        <div class="rf-modal-error">{error()}</div>
      </Show>
      <Show when={busy()}>
        <div class="rf-modal-note">
          <span class="rf-spinner" /> Searching…
        </div>
      </Show>
      <Show when={response()}>
        <div class="rf-modal-note">
          <b>{response()!.total}</b> results
        </div>
        <div class="rf-search-hits">
          <For each={response()!.hits}>
            {(hit) => (
              <button
                type="button"
                class="rf-search-hit"
                data-palette={paletteFor(hit.experience.kind)}
                onClick={() => {
                  props.onPick(hit.experience.id)
                  props.onClose()
                }}
              >
                <div class="rf-search-hit-head">
                  <span class="rf-search-hit-kind">
                    {kindDisplay(hit.experience.kind)}
                  </span>
                  <Show when={hit.experience.archived}>
                    <span class="rf-search-hit-archived">Archived</span>
                  </Show>
                </div>
                <div class="rf-search-hit-title">{hit.experience.title}</div>
                <Show when={hit.matches.length > 0}>
                  <div class="rf-search-hit-matches">
                    <For each={hit.matches.slice(0, 3)}>
                      {(m) => (
                        <div class="rf-search-hit-match">
                          <span class="rf-search-hit-match-field">{m.field}</span>
                          <span class="rf-search-hit-match-snippet">
                            {clip(m.snippet, 140)}
                          </span>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
    </RfModal>
  )
}

/* ──────────────────────────────────────────────────────
   Modal: Delete observation confirm
   ────────────────────────────────────────────────────── */

function DeleteObservationModal(props: {
  experience: Experience
  observation: Observation
  onClose: () => void
  onSubmit: () => Promise<void>
}) {
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>()
  const submit = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await props.onSubmit()
      props.onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <RfModal
      title="Delete observation"
      subtitle="该 experience 将在去掉这条 observation 后 re-refine。若这是最后一条 observation，该 experience 会被自动归档。"
      tone="danger"
      onClose={props.onClose}
      busy={busy()}
      footer={
        <>
          <button
            type="button"
            class="rf-btn rf-btn-ghost"
            onClick={() => props.onClose()}
            disabled={busy()}
          >
            取消
          </button>
          <button
            type="button"
            class="rf-btn rf-btn-danger"
            onClick={() => void submit()}
            disabled={busy()}
          >
            Delete observation
          </button>
        </>
      }
    >
      <div class="rf-modal-note">Observation preview:</div>
      <pre class="rf-modal-pre">{clip(props.observation.user_text, 320)}</pre>
      <Show when={error()}>
        <div class="rf-modal-error">{error()}</div>
      </Show>
    </RfModal>
  )
}

/* ──────────────────────────────────────────────────────
   Modal: Move observation
   ────────────────────────────────────────────────────── */

function MoveObservationModal(props: {
  experience: Experience
  observation: Observation
  allExperiences: Experience[]
  onClose: () => void
  onSubmit: (toExperienceID: string) => Promise<void>
}) {
  const [target, setTarget] = createSignal<string>("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>()

  const candidates = createMemo(() =>
    props.allExperiences
      .filter((e) => e.id !== props.experience.id && !e.archived)
      .sort((a, b) => b.last_refined_at - a.last_refined_at),
  )

  const submit = async () => {
    if (!target()) return
    setBusy(true)
    setError(undefined)
    try {
      await props.onSubmit(target())
      props.onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <RfModal
      title="Move observation"
      subtitle="从源 experience 移出该 observation，两端都会 re-refine。"
      onClose={props.onClose}
      wide
      busy={busy()}
      footer={
        <>
          <button
            type="button"
            class="rf-btn rf-btn-ghost"
            onClick={() => props.onClose()}
            disabled={busy()}
          >
            取消
          </button>
          <button
            type="button"
            class="rf-btn rf-btn-primary"
            onClick={() => void submit()}
            disabled={busy() || !target()}
          >
            Move
          </button>
        </>
      }
    >
      <div class="rf-modal-note">Observation preview:</div>
      <pre class="rf-modal-pre">{clip(props.observation.user_text, 240)}</pre>
      <div class="rf-modal-note">From <b>{clip(props.experience.title, 60)}</b> → move to:</div>
      <div class="rf-move-list">
        <For each={candidates()}>
          {(e) => (
            <label
              class="rf-move-item"
              data-active={target() === e.id ? "true" : "false"}
            >
              <input
                type="radio"
                name="move-target"
                value={e.id}
                checked={target() === e.id}
                onChange={() => setTarget(e.id)}
              />
              <span
                class="rf-dot rf-dot-sm"
                data-palette={paletteFor(e.kind)}
              />
              <span class="rf-move-item-kind">{kindDisplay(e.kind)}</span>
              <span class="rf-move-item-title">{clip(e.title, 80)}</span>
              <span class="rf-move-item-obs">{e.observations.length} obs</span>
            </label>
          )}
        </For>
      </div>
      <Show when={error()}>
        <div class="rf-modal-error">{error()}</div>
      </Show>
    </RfModal>
  )
}

/* ──────────────────────────────────────────────────────
   Modal: Ingest session confirm
   ────────────────────────────────────────────────────── */

function IngestModal(props: {
  sessionID: string
  onClose: () => void
  onSubmit: () => Promise<void>
}) {
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>()
  const [result, setResult] = createSignal<Record<string, unknown> | undefined>()
  const submit = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await props.onSubmit()
      setResult({ ok: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <RfModal
      title="Ingest this session"
      subtitle="把本会话所有 user messages 回放到 refiner 流程中生成 observations，已存在的 observation 会跳过。"
      onClose={props.onClose}
      busy={busy()}
      footer={
        <>
          <button
            type="button"
            class="rf-btn rf-btn-ghost"
            onClick={() => props.onClose()}
            disabled={busy()}
          >
            Close
          </button>
          <Show when={!result()}>
            <button
              type="button"
              class="rf-btn rf-btn-primary"
              onClick={() => void submit()}
              disabled={busy()}
            >
              Ingest
            </button>
          </Show>
        </>
      }
    >
      <div class="rf-modal-note">
        Target session: <span class="rf-mono-dim">{props.sessionID}</span>
      </div>
      <Show when={error()}>
        <div class="rf-modal-error">{error()}</div>
      </Show>
      <Show when={result()}>
        <div class="rf-modal-ok">Done — check the graph for new experiences.</div>
      </Show>
    </RfModal>
  )
}

/* ──────────────────────────────────────────────────────
   Peek panel — experience-centric (schema v2)
   ────────────────────────────────────────────────────── */

type Selection = { kind: "experience"; id: string } | undefined

type ExperiencePeekProps = {
  experience: Experience
  onClose: () => void
  onPickExperience: (id: string) => void
  onPickObservation: (input: { sessionID: string; messageID: string }) => void
  sessionHref: (input: { sessionID: string; messageID: string }) => string
  allExperiences: Experience[]
  onAction: (a: ActionKind) => void
  onReRefine: () => Promise<void> | void
  onUndo: () => Promise<void> | void
  onArchiveToggle: () => Promise<void> | void
  onToggleMergeSelect: (id: string) => void
  mergeSelected: boolean
}

function ExperiencePeek(props: ExperiencePeekProps) {
  const exp = () => props.experience
  const palette = () => paletteFor(exp().kind)
  const [acting, setActing] = createSignal<string | undefined>()

  const run = async (tag: string, fn: () => Promise<void> | void) => {
    if (acting()) return
    setActing(tag)
    try {
      await fn()
    } catch (err) {
      console.warn(`[refiner] ${tag} failed`, err)
    } finally {
      setActing(undefined)
    }
  }

  const relatedLookup = createMemo(() => {
    const map = new Map<string, Experience>()
    for (const e of props.allExperiences) map.set(e.id, e)
    return map
  })

  const refCount = () => exp().refinement_history.length
  const refFirst = () => exp().refinement_history[0]?.at
  const refLast = () =>
    exp().refinement_history[exp().refinement_history.length - 1]?.at
  const undoable = () => {
    const last = exp().refinement_history[exp().refinement_history.length - 1]
    return !!last?.prev_snapshot
  }

  const uniqueSessions = () => {
    const set = new Set<string>()
    for (const o of exp().observations) set.add(o.session_id)
    return set.size
  }
  const referenceTotals = () => ({
    observations: exp().observations.length,
    sessions: uniqueSessions(),
    related: exp().related_experience_ids.length,
    conflicts: (exp().conflicts_with ?? []).length,
  })

  return (
    <>
      <div class="rf-peek-hero" data-palette={palette()}>
        <span class="rf-peek-kind">
          <span class="rf-dot" />
          {kindDisplay(exp().kind)}
        </span>
        <div class="rf-peek-heading">{exp().title}</div>
        <div class="rf-peek-metrow">
          <Show when={exp().archived}>
            <span class="rf-tag rf-tag-archived">Archived</span>
          </Show>
          <Show when={exp().task_type}>
            <span class="rf-tag">
              <span class="rf-tag-k">task</span>
              <span class="rf-tag-v">{exp().task_type}</span>
            </span>
          </Show>
          <span class="rf-tag">
            <span class="rf-tag-k">scope</span>
            <span class="rf-tag-v">{exp().scope}</span>
          </span>
          <span class="rf-tag">
            <span class="rf-tag-k">obs</span>
            <span class="rf-tag-v">{exp().observations.length}</span>
          </span>
          <Show when={referenceTotals().sessions > 1}>
            <span class="rf-tag">
              <span class="rf-tag-k">sessions</span>
              <span class="rf-tag-v">{referenceTotals().sessions}</span>
            </span>
          </Show>
          <Show when={refCount() > 0}>
            <span class="rf-tag">
              <span class="rf-tag-k">refined</span>
              <span class="rf-tag-v">{refCount()}×</span>
            </span>
          </Show>
        </div>
        <button
          type="button"
          class="rf-peek-close"
          aria-label="Close"
          onClick={props.onClose}
        >
          ×
        </button>
      </div>

      <div class="rf-peek-actions">
        <button
          type="button"
          class="rf-actbtn"
          disabled={!!acting() || exp().archived}
          onClick={() => props.onAction({ type: "augment", experience: exp() })}
          title="追加一条 observation 并触发 re-refine"
        >
          ＋ Add obs
        </button>
        <button
          type="button"
          class="rf-actbtn"
          disabled={!!acting()}
          onClick={() => props.onAction({ type: "edit", experience: exp() })}
          title="手动编辑字段（不调用 LLM）"
        >
          ✎ Edit
        </button>
        <button
          type="button"
          class="rf-actbtn"
          disabled={!!acting() || exp().observations.length === 0 || exp().archived}
          onClick={() => void run("refine", () => props.onReRefine())}
          title="基于当前 observations 重新运行 refiner 模型"
        >
          {acting() === "refine" ? "⟳ Refining…" : "⟳ Re-refine"}
        </button>
        <button
          type="button"
          class="rf-actbtn"
          disabled={!!acting() || !undoable()}
          onClick={() => void run("undo", () => props.onUndo())}
          title={undoable() ? "回滚到上一次快照" : "没有可回滚的快照"}
        >
          ⤺ Undo
        </button>
        <button
          type="button"
          class="rf-actbtn"
          data-selected={props.mergeSelected ? "true" : "false"}
          disabled={!!acting() || exp().archived}
          onClick={() => props.onToggleMergeSelect(exp().id)}
          title={props.mergeSelected ? "从合并队列移除" : "加入合并队列"}
        >
          {props.mergeSelected ? "✓ Selected" : "⚭ Merge…"}
        </button>
        <button
          type="button"
          class="rf-actbtn"
          disabled={!!acting()}
          onClick={() => void run("archive", () => props.onArchiveToggle())}
          title={exp().archived ? "取消归档" : "归档（从概览中隐藏）"}
        >
          {exp().archived ? "⬒ Unarchive" : "⬓ Archive"}
        </button>
        <span class="rf-actspacer" />
        <button
          type="button"
          class="rf-actbtn rf-actbtn-danger"
          disabled={!!acting()}
          onClick={() => props.onAction({ type: "delete", experience: exp() })}
          title="删除（保留审计）"
        >
          ✕ Delete
        </button>
      </div>

      <div class="rf-peek-body">
        <div class="rf-sec" data-accent="abstract">
          <div class="rf-sec-head">
            <span class="rf-sec-title">Abstract</span>
            <span class="rf-sec-hint">LLM 精炼出的核心摘要</span>
          </div>
          <div class="rf-sec-prose rf-sec-prose-lead">{exp().abstract}</div>
        </div>

        <Show when={(exp().categories ?? []).length > 0}>
          <div class="rf-sec rf-sec-inline" data-accent="categories">
            <span class="rf-sec-title rf-sec-title-inline">Tags</span>
            <div class="rf-cats">
              <For each={exp().categories ?? []}>
                {(cat) => <span class="rf-cat-chip">#{cat}</span>}
              </For>
            </div>
          </div>
        </Show>

        <Show when={exp().trigger_condition}>
          <div class="rf-sec" data-accent="trigger">
            <div class="rf-sec-head">
              <span class="rf-sec-title">Trigger</span>
              <span class="rf-sec-hint">何时应触发该条 experience（Phase 2 注入用）</span>
            </div>
            <div class="rf-sec-prose">{exp().trigger_condition}</div>
          </div>
        </Show>

        <Show when={exp().statement}>
          <details class="rf-sec rf-sec-details" data-accent="statement">
            <summary class="rf-sec-summary">
              <span class="rf-sec-title">Statement</span>
              <span class="rf-sec-hint">LLM 产出的机器可读陈述（e.g. `after:commit → require:lint`）</span>
              <span class="rf-sec-caret">▾</span>
            </summary>
            <pre class="rf-sec-mono">{exp().statement}</pre>
          </details>
        </Show>

        <Show when={(exp().conflicts_with ?? []).length > 0}>
          <div class="rf-sec" data-accent="conflicts">
            <div class="rf-sec-head">
              <span class="rf-sec-title">Conflicts with</span>
            </div>
            <div class="rf-related">
              <For each={exp().conflicts_with ?? []}>
                {(id) => {
                  const c = () => relatedLookup().get(id)
                  return (
                    <Show
                      when={c()}
                      fallback={
                        <span class="rf-chip rf-chip-muted">
                          <b>missing</b>
                          {id.slice(0, 10)}…
                        </span>
                      }
                    >
                      <button
                        type="button"
                        class="rf-related-chip rf-conflict-chip"
                        data-palette={paletteFor(c()!.kind)}
                        onClick={() => props.onPickExperience(c()!.id)}
                      >
                        <span class="rf-related-kind">⚠ {kindDisplay(c()!.kind)}</span>
                        <span class="rf-related-title">{clip(c()!.title, 60)}</span>
                      </button>
                    </Show>
                  )
                }}
              </For>
            </div>
          </div>
        </Show>

        <details class="rf-sec rf-sec-details" data-accent="observations">
          <summary class="rf-sec-summary">
            <span class="rf-sec-title">
              Source observations
              <span class="rf-sec-count">{exp().observations.length}</span>
            </span>
            <span class="rf-sec-hint">这些原始用户消息是 abstract 归纳的来源</span>
            <span class="rf-sec-caret">▾</span>
          </summary>
          <Show
            when={exp().observations.length > 0}
            fallback={<div class="rf-sec-prose rf-muted">尚未挂载任何 observation。</div>}
          >
            <div class="rf-observations">
              <For each={[...exp().observations].sort((a, b) => b.observed_at - a.observed_at)}>
                {(obs) => {
                  const node = () => obs.agent_context.workflow_snapshot?.node_id
                  return (
                    <div class="rf-observation-wrap">
                      <a
                        class="rf-observation"
                        href={props.sessionHref({
                          sessionID: obs.session_id,
                          messageID: obs.message_id,
                        })}
                        onClick={(e) => {
                          e.preventDefault()
                          props.onPickObservation({
                            sessionID: obs.session_id,
                            messageID: obs.message_id,
                          })
                        }}
                      >
                        <div class="rf-observation-head">
                          <span class="rf-observation-time">
                            {fmtTime(obs.observed_at)}
                          </span>
                          <Show when={node()}>
                            <span class="rf-chip rf-chip-tight">
                              <b>节点</b>
                              {node()}
                            </span>
                          </Show>
                          <Show when={(obs as any).source === "manual_create" || (obs as any).source === "manual_augment"}>
                            <span class="rf-chip rf-chip-tight">
                              <b>来源</b>手动
                            </span>
                          </Show>
                        </div>
                        <div class="rf-observation-body">
                          {clip(obs.user_text, 220)}
                        </div>
                        <div class="rf-observation-foot">
                          <span class="rf-mono-dim">
                            会话 {obs.session_id.slice(0, 10)}… · 消息 {obs.message_id.slice(0, 10)}…
                          </span>
                        </div>
                      </a>
                      <div class="rf-observation-actions">
                        <button
                          type="button"
                          class="rf-iconbtn"
                          title="Move to another experience"
                          onClick={() =>
                            props.onAction({
                              type: "moveObservation",
                              experience: exp(),
                              observation: obs,
                            })
                          }
                        >
                          ↻
                        </button>
                        <button
                          type="button"
                          class="rf-iconbtn rf-iconbtn-danger"
                          title="Delete this observation"
                          onClick={() =>
                            props.onAction({
                              type: "deleteObservation",
                              experience: exp(),
                              observation: obs,
                            })
                          }
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>
        </details>

        <Show when={refCount() > 0}>
          <details class="rf-sec rf-sec-details" data-accent="history">
            <summary class="rf-sec-summary">
              <span class="rf-sec-title">
                Refinement history
                <span class="rf-sec-count">{refCount()}</span>
              </span>
              <span class="rf-sec-hint">
                <Show when={refFirst()}>first {fmtTime(refFirst())}</Show>
                <Show when={refLast() && refLast() !== refFirst()}>
                  <span> · last {fmtTime(refLast())}</span>
                </Show>
              </span>
              <span class="rf-sec-caret">▾</span>
            </summary>
            <div class="rf-history">
              <For each={[...(exp().refinement_history ?? [])].reverse()}>
                {(rec) => (
                  <div class="rf-history-row">
                    <span class="rf-history-time">{fmtTime(rec.at)}</span>
                    <span class="rf-history-kind">{rec.kind ?? "refine"}</span>
                    <span class="rf-history-model rf-mono-dim">{rec.model ?? "—"}</span>
                  </div>
                )}
              </For>
            </div>
          </details>
        </Show>

        <Show when={exp().related_experience_ids.length > 0}>
          <div class="rf-sec" data-accent="related">
            <div class="rf-sec-head">
              <span class="rf-sec-title">Related experiences</span>
            </div>
            <div class="rf-related">
              <For each={exp().related_experience_ids}>
                {(id) => {
                  const related = () => relatedLookup().get(id)
                  return (
                    <Show
                      when={related()}
                      fallback={
                        <span class="rf-chip rf-chip-muted">
                          <b>missing</b>
                          {id.slice(0, 10)}…
                        </span>
                      }
                    >
                      <button
                        type="button"
                        class="rf-related-chip"
                        data-palette={paletteFor(related()!.kind)}
                        onClick={() => props.onPickExperience(related()!.id)}
                      >
                        <span class="rf-related-kind">
                          {kindDisplay(related()!.kind)}
                        </span>
                        <span class="rf-related-title">
                          {clip(related()!.title, 60)}
                        </span>
                      </button>
                    </Show>
                  )
                }}
              </For>
            </div>
          </div>
        </Show>

        <div class="rf-peek-foot">
          <span class="rf-peek-foot-item">
            <span class="rf-peek-foot-k">created</span>
            <span class="rf-peek-foot-v">{fmtTime(exp().created_at)}</span>
          </span>
          <span class="rf-peek-foot-item">
            <span class="rf-peek-foot-k">refined</span>
            <span class="rf-peek-foot-v">{fmtTime(exp().last_refined_at)}</span>
          </span>
          <span class="rf-peek-foot-path">{exp().path}</span>
        </div>
      </div>
    </>
  )
}

function PeekPanel(props: {
  experience?: Experience
  allExperiences: Experience[]
  onClose: () => void
  onPickExperience: (id: string) => void
  onPickObservation: (input: { sessionID: string; messageID: string }) => void
  sessionHref: (input: { sessionID: string; messageID: string }) => string
  onAction: (a: ActionKind) => void
  onReRefine: (id: string) => Promise<void> | void
  onUndo: (id: string) => Promise<void> | void
  onArchiveToggle: (id: string, archived: boolean) => Promise<void> | void
  onToggleMergeSelect: (id: string) => void
  mergeSelected: (id: string) => boolean
}) {
  return (
    <aside class="rf-peek" data-open={props.experience ? "true" : "false"}>
      <div class="rf-peek-inner">
        <Show when={props.experience}>
          {(exp) => (
            <ExperiencePeek
              experience={exp()}
              allExperiences={props.allExperiences}
              onClose={props.onClose}
              onPickExperience={props.onPickExperience}
              onPickObservation={props.onPickObservation}
              sessionHref={props.sessionHref}
              onAction={props.onAction}
              onReRefine={() => props.onReRefine(exp().id)}
              onUndo={() => props.onUndo(exp().id)}
              onArchiveToggle={() =>
                props.onArchiveToggle(exp().id, !exp().archived)
              }
              onToggleMergeSelect={props.onToggleMergeSelect}
              mergeSelected={props.mergeSelected(exp().id)}
            />
          )}
        </Show>
      </div>
    </aside>
  )
}

/* ──────────────────────────────────────────────────────
   Taxonomy strip — compact counts for core + custom kinds
   ────────────────────────────────────────────────────── */

function TaxonomyStrip(props: {
  taxonomy?: TaxonomyResponse
  countsByKind: Map<Kind, number>
}) {
  const coreSlugs = createMemo<CoreKind[]>(() => {
    const src = props.taxonomy?.core ?? []
    const slugs: CoreKind[] = []
    for (const item of src) {
      const slug = typeof item === "string" ? item : item.slug
      if ((CORE_KINDS as readonly string[]).includes(slug)) {
        slugs.push(slug as CoreKind)
      }
    }
    if (slugs.length === 0) return [...CORE_KINDS]
    return slugs
  })

  const customEntries = createMemo(() => props.taxonomy?.custom ?? [])

  return (
    <div class="rf-taxonomy">
      <For each={coreSlugs()}>
        {(slug) => {
          const count = () => props.countsByKind.get(slug) ?? 0
          return (
            <span class="rf-tax-pill" data-palette={paletteFor(slug)} title={slug}>
              <span class="rf-dot" />
              <span class="rf-tax-label">{KIND_LABEL[slug]}</span>
              <span class="rf-tax-count">{count()}</span>
            </span>
          )
        }}
      </For>
      <Show when={customEntries().length > 0}>
        <span class="rf-tax-sep" />
        <For each={customEntries()}>
          {(entry) => (
            <span
              class="rf-tax-pill"
              data-palette="gray"
              title={`custom:${entry.slug}`}
            >
              <span class="rf-dot" />
              <span class="rf-tax-label">{entry.slug}</span>
              <span class="rf-tax-count">{entry.count}</span>
            </span>
          )}
        </For>
      </Show>
    </div>
  )
}

/* ──────────────────────────────────────────────────────
   Category strip — filterable chips for orthogonal categories
   ────────────────────────────────────────────────────── */

function CategoryStrip(props: {
  categories: CategoryEntry[]
  active?: string
  onToggle: (slug: string | undefined) => void
}) {
  return (
    <Show when={props.categories.length > 0}>
      <div class="rf-categories">
        <span class="rf-categories-label">分类</span>
        <button
          type="button"
          class="rf-cat-pill"
          data-active={props.active === undefined ? "true" : "false"}
          onClick={() => props.onToggle(undefined)}
        >
          全部
        </button>
        <For each={props.categories}>
          {(cat) => (
            <button
              type="button"
              class="rf-cat-pill"
              data-active={props.active === cat.slug ? "true" : "false"}
              onClick={() =>
                props.onToggle(props.active === cat.slug ? undefined : cat.slug)
              }
              title={`${cat.slug} · ${cat.count} experience${cat.count === 1 ? "" : "s"}`}
            >
              <span>#{cat.slug}</span>
              <span class="rf-cat-count">{cat.count}</span>
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}

/* ──────────────────────────────────────────────────────
   ExperienceRow — redesigned list row
   ────────────────────────────────────────────────────── */

function highlightMatch(text: string, q: string) {
  if (!q) return text
  const i = text.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return text
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  )
}

const touchedLabel = (ts?: number) => {
  if (!ts) return "—"
  const diffSec = Math.max(0, (Date.now() - ts) / 1000)
  if (diffSec < 60) return "just now"
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`
  if (diffSec < 86400 * 30) return `${Math.round(diffSec / 86400)}d ago`
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" })
}

function ExperienceRow(props: {
  item: Experience
  query: string
  selected: boolean
  mergeSel: boolean
  anySelected: boolean
  onOpen: () => void
  onToggleCheck: () => void
}) {
  const palette = () => paletteFor(props.item.kind)
  const abstract = () =>
    props.item.abstract ? clip(props.item.abstract, 120) : ""
  const categories = () => (props.item.categories ?? []).slice(0, 3)
  return (
    <div
      class="rf-row"
      data-palette={palette()}
      data-selected={props.selected ? "true" : "false"}
      data-archived={props.item.archived ? "true" : "false"}
      data-checked={props.mergeSel ? "true" : "false"}
      data-any-selected={props.anySelected ? "true" : "false"}
      onClick={props.onOpen}
    >
      <span
        class="rf-row-check"
        data-checked={props.mergeSel ? "true" : "false"}
        onClick={(e) => {
          e.stopPropagation()
          props.onToggleCheck()
        }}
        title="加入合并选择"
      >
        <Show when={props.mergeSel}>
          <svg class="rf-row-check-ic" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M3 8.5l3 3 7-7"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </Show>
      </span>
      <span class="rf-row-cat-bar" />
      <div class="rf-row-body">
        <div class="rf-row-title" title={props.item.title}>
          {highlightMatch(props.item.title, props.query)}
          <Show when={props.item.archived}>
            <span class="rf-row-archived">archived</span>
          </Show>
        </div>
        <div class="rf-row-sub">
          <For each={categories()}>
            {(cat, i) => (
              <>
                <Show when={i() > 0}>
                  <span class="rf-row-dot" />
                </Show>
                <span class="rf-row-tag">#{cat}</span>
              </>
            )}
          </For>
          <Show when={categories().length > 0 && abstract()}>
            <span class="rf-row-dot" />
          </Show>
          <Show when={abstract()}>
            <span class="rf-row-summary">{abstract()}</span>
          </Show>
        </div>
      </div>
      <div class="rf-row-meta">
        <span class="rf-row-scope">{props.item.scope}</span>
        <span class="rf-row-obs">
          {props.item.observations.length} obs
        </span>
        <span class="rf-row-touched">{touchedLabel(props.item.last_refined_at)}</span>
      </div>
    </div>
  )
}

/* ──────────────────────────────────────────────────────
   Filterbar — unified kind + category + sort + search row
   Replaces TaxonomyStrip + CategoryStrip when the new layout
   is active. Kind chips become first-class filters instead of
   passive readouts; category chips keep their toggle behaviour;
   a sort toggle and a search input round out the row.
   ────────────────────────────────────────────────────── */

function Filterbar(props: {
  taxonomy?: TaxonomyResponse
  countsByKind: Map<Kind, number>
  categories: CategoryEntry[]
  totalCount: number
  activeKind?: Kind
  setActiveKind: (k: Kind | undefined) => void
  activeCategory?: string
  setActiveCategory: (slug: string | undefined) => void
  query: string
  setQuery: (q: string) => void
  sort: "kind" | "recent"
  setSort: (s: "kind" | "recent") => void
}) {
  const coreSlugs = createMemo<CoreKind[]>(() => {
    const src = props.taxonomy?.core ?? []
    const slugs: CoreKind[] = []
    for (const item of src) {
      const slug = typeof item === "string" ? item : item.slug
      if ((CORE_KINDS as readonly string[]).includes(slug)) slugs.push(slug as CoreKind)
    }
    if (slugs.length === 0) return [...CORE_KINDS]
    return slugs
  })
  const customEntries = createMemo(() => props.taxonomy?.custom ?? [])

  return (
    <div class="rf-fbar">
      <div class="rf-fbar-group">
        <span class="rf-fbar-label">分类</span>
        <button
          type="button"
          class="rf-chip"
          data-active={props.activeKind === undefined ? "true" : "false"}
          onClick={() => props.setActiveKind(undefined)}
        >
          全部 <span class="rf-chip-count">{props.totalCount}</span>
        </button>
        <For each={coreSlugs()}>
          {(slug) => {
            const count = () => props.countsByKind.get(slug) ?? 0
            const active = () => props.activeKind === slug
            return (
              <button
                type="button"
                class="rf-chip"
                data-palette={paletteFor(slug)}
                data-active={active() ? "true" : "false"}
                title={slug}
                onClick={() => props.setActiveKind(active() ? undefined : slug)}
              >
                <span class="rf-chip-sw" />
                {KIND_LABEL[slug]}
                <span class="rf-chip-count">{count()}</span>
              </button>
            )
          }}
        </For>
        <Show when={customEntries().length > 0}>
          <span class="rf-fbar-sep" />
          <For each={customEntries()}>
            {(entry) => {
              const kind = `custom:${entry.slug}` as Kind
              const active = () => props.activeKind === kind
              return (
                <button
                  type="button"
                  class="rf-chip"
                  data-palette="gray"
                  data-active={active() ? "true" : "false"}
                  title={kind}
                  onClick={() => props.setActiveKind(active() ? undefined : kind)}
                >
                  <span class="rf-chip-sw" />
                  {entry.slug}
                  <span class="rf-chip-count">{entry.count}</span>
                </button>
              )
            }}
          </For>
        </Show>
      </div>

      <Show when={props.categories.length > 0}>
        <span class="rf-fbar-div" />
        <div class="rf-fbar-group">
          <span class="rf-fbar-label">标签</span>
          <For each={props.categories}>
            {(cat) => {
              const active = () => props.activeCategory === cat.slug
              return (
                <button
                  type="button"
                  class="rf-chip rf-chip-tag"
                  data-active={active() ? "true" : "false"}
                  title={`${cat.slug} · ${cat.count}`}
                  onClick={() =>
                    props.setActiveCategory(active() ? undefined : cat.slug)
                  }
                >
                  <span class="rf-chip-hash">#</span>
                  {cat.slug}
                  <span class="rf-chip-count">{cat.count}</span>
                </button>
              )
            }}
          </For>
        </div>
      </Show>

      <div class="rf-fbar-spacer" />

      <div class="rf-fbar-search">
        <svg
          class="rf-fbar-search-ic"
          viewBox="0 0 16 16"
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4" />
          <path d="M10.5 10.5L13 13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
        <input
          type="text"
          placeholder="搜索经验、观察、标签…"
          value={props.query}
          onInput={(e) => props.setQuery(e.currentTarget.value)}
        />
        <Show when={props.query}>
          <button
            type="button"
            class="rf-fbar-search-clear"
            onClick={() => props.setQuery("")}
            aria-label="清空搜索"
          >
            ×
          </button>
        </Show>
      </div>

      <button
        type="button"
        class="rf-chip rf-chip-sort"
        onClick={() => props.setSort(props.sort === "kind" ? "recent" : "kind")}
        title="切换排序"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" width="13" height="13">
          <path d="M4 4h9M4 8h6M4 12h3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        {props.sort === "kind" ? "按分类" : "最近修改"}
      </button>
    </div>
  )
}

/* ──────────────────────────────────────────────────────
   Merge tray — floating prompt when ≥ 2 experiences selected
   ────────────────────────────────────────────────────── */

function MergeTray(props: {
  selected: Experience[]
  onClear: () => void
  onOpen: () => void
}) {
  return (
    <Show when={props.selected.length > 0}>
      <div class="rf-merge-tray" data-ready={props.selected.length >= 2 ? "true" : "false"}>
        <span class="rf-merge-tray-label">
          Merge selection: <b>{props.selected.length}</b>
        </span>
        <div class="rf-merge-tray-chips">
          <For each={props.selected}>
            {(exp) => (
              <span
                class="rf-merge-tray-chip"
                data-palette={paletteFor(exp.kind)}
                title={exp.title}
              >
                {clip(exp.title, 40)}
              </span>
            )}
          </For>
        </div>
        <button
          type="button"
          class="rf-btn rf-btn-ghost"
          onClick={props.onClear}
        >
          Clear
        </button>
        <button
          type="button"
          class="rf-btn rf-btn-primary"
          disabled={props.selected.length < 2}
          onClick={props.onOpen}
        >
          Merge…
        </button>
      </div>
    </Show>
  )
}

/* ──────────────────────────────────────────────────────
   Page
   ────────────────────────────────────────────────────── */

export default function RefinerPage() {
  const params = useParams()
  const navigate = useNavigate()
  const sdk = useSDK()
  const server = useServer()
  const platform = usePlatform()

  const [selection, setSelection] = createSignal<Selection>()
  const [action, setAction] = createSignal<ActionKind | undefined>()
  const [activeCategory, setActiveCategory] = createSignal<string | undefined>()
  const [activeKind, setActiveKind] = createSignal<Kind | undefined>()
  const [query, setQuery] = createSignal<string>("")
  const [sortMode, setSortMode] = createSignal<"kind" | "recent">("kind")
  const [includeArchived, setIncludeArchived] = createSignal(false)
  const [scopeMode, setScopeMode] = createSignal<"all" | "session">("all")
  const [mergeIDs, setMergeIDs] = createSignal<Set<string>>(new Set())
  const [banner, setBanner] = createSignal<string | undefined>()

  const overviewArgs = () => {
    const current = server.current
    const sessionID = params.id
    if (!current || !sessionID) return
    return {
      baseUrl: current.http.url,
      directory: sdk.directory,
      sessionID,
      scope: scopeMode(),
      includeArchived: includeArchived(),
      password: current.http.password,
      username: current.http.username,
      fetcher: platform.fetch,
    }
  }

  const taxonomyArgs = () => {
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

  const [overview, { refetch }] = createResource(overviewArgs, fetchOverview)
  const [taxonomy, { refetch: refetchTaxonomy }] = createResource(
    taxonomyArgs,
    fetchTaxonomy,
  )
  const [config, { refetch: refetchConfig }] = createResource(taxonomyArgs, fetchConfig)
  const [categoriesData, { refetch: refetchCategories }] = createResource(
    taxonomyArgs,
    fetchCategories,
  )

  createEffect(() => {
    const data = overview()
    if (!data || selection()) return
    const latest = data.experiences[0]
    if (latest) setSelection({ kind: "experience", id: `experience:${latest.id}` })
  })

  const poll = setInterval(() => {
    void refetch()
    void refetchTaxonomy()
    void refetchConfig()
    void refetchCategories()
  }, 4000)
  onCleanup(() => clearInterval(poll))

  const refreshAll = () => {
    void refetch()
    void refetchTaxonomy()
    void refetchConfig()
    void refetchCategories()
  }

  const apiBase = (): ApiBase | undefined => {
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

  const experienceByID = createMemo(() => {
    const map = new Map<string, Experience>()
    for (const exp of overview()?.experiences ?? []) map.set(exp.id, exp)
    return map
  })

  const selectedExperience = createMemo<Experience | undefined>(() => {
    const sel = selection()
    if (!sel) return undefined
    const id = sel.id.startsWith("experience:")
      ? sel.id.slice("experience:".length)
      : sel.id
    return experienceByID().get(id)
  })

  // Filtered experience list (applies kind/category/query/archived filters)
  const visibleExperiences = createMemo(() => {
    const all = overview()?.experiences ?? []
    const archivedOk = includeArchived()
    const cat = activeCategory()
    const kind = activeKind()
    const q = query().trim().toLowerCase()
    return all.filter((e) => {
      if (!archivedOk && e.archived) return false
      if (cat && !(e.categories ?? []).includes(cat)) return false
      if (kind && e.kind !== kind) return false
      if (q) {
        const hay = [
          e.title,
          e.abstract,
          e.statement ?? "",
          e.task_type ?? "",
          (e.categories ?? []).join(" "),
          e.observations.map((o) => o.user_text).join(" "),
        ]
          .join(" ")
          .toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  })

  // Flat list sorted by last_refined_at (used when sortMode === "recent")
  const visibleExperiencesFlat = createMemo(() => {
    const arr = [...visibleExperiences()]
    arr.sort((a, b) => b.last_refined_at - a.last_refined_at)
    return arr
  })

  const experiencesByKind = createMemo(() => {
    const map = new Map<Kind, Experience[]>()
    for (const exp of visibleExperiences()) {
      const arr = map.get(exp.kind) ?? []
      arr.push(exp)
      map.set(exp.kind, arr)
    }
    for (const [, arr] of map) arr.sort((a, b) => b.last_refined_at - a.last_refined_at)
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length)
  })

  const kindCounts = createMemo(() => {
    const map = new Map<Kind, number>()
    for (const exp of visibleExperiences()) {
      map.set(exp.kind, (map.get(exp.kind) ?? 0) + 1)
    }
    return map
  })

  const pickExperienceByID = (id: string) => {
    setSelection({ kind: "experience", id: `experience:${id}` })
  }

  const sessionHref = (input: { sessionID: string; messageID: string }) => {
    return `/${params.dir}/session/${input.sessionID}#message-${input.messageID}`
  }

  const navigateToObservation = (input: { sessionID: string; messageID: string }) => {
    navigate(sessionHref(input))
  }

  const updateModel = async (model: { providerID: string; modelID: string }) => {
    const current = server.current
    if (!current) return
    try {
      await putConfig({
        baseUrl: current.http.url,
        directory: sdk.directory,
        username: current.http.username,
        password: current.http.password,
        fetcher: platform.fetch,
        body: { model },
      })
    } catch (err) {
      console.warn("[refiner] update model failed", err)
    }
    void refetch()
    void refetchConfig()
  }

  const resetModel = async () => {
    const current = server.current
    if (!current) return
    try {
      await putConfig({
        baseUrl: current.http.url,
        directory: sdk.directory,
        username: current.http.username,
        password: current.http.password,
        fetcher: platform.fetch,
        body: { model: null },
      })
    } catch (err) {
      console.warn("[refiner] reset model failed", err)
    }
    void refetch()
    void refetchConfig()
  }

  const flash = (msg: string) => {
    setBanner(msg)
    setTimeout(() => setBanner(undefined), 3500)
  }

  // ── Action wrappers: call API, refresh, toast. All tolerate missing base.
  const withBase = <T,>(fn: (b: ApiBase) => Promise<T>): Promise<T> => {
    const b = apiBase()
    if (!b) return Promise.reject(new Error("server not ready"))
    return fn(b)
  }

  const handleDelete = async (id: string, opts: { cascade: boolean; reason?: string }) => {
    await withBase((b) => apiDeleteExperience(b, id, opts))
    flash("Experience deleted")
    if (selection()?.id === `experience:${id}`) setSelection(undefined)
    removeFromMerge(id)
    refreshAll()
  }

  const handleArchiveToggle = async (id: string, archived: boolean) => {
    await withBase((b) => apiArchiveExperience(b, id, archived))
    flash(archived ? "Archived" : "Unarchived")
    refreshAll()
  }

  const handleAugment = async (
    id: string,
    input: { user_text: string; note?: string },
  ) => {
    await withBase((b) => apiAugmentExperience(b, id, input))
    flash("Observation attached · re-refined")
    refreshAll()
  }

  const handleCreate = async (input: {
    user_text: string
    kind_hint?: string
    scope_hint?: Scope
    task_type_hint?: string
    note?: string
  }) => {
    const res = (await withBase((b) => apiCreateExperience(b, input))) as any
    flash("Experience created")
    refreshAll()
    const newID: string | undefined = res?.experience?.id
    if (newID) setSelection({ kind: "experience", id: `experience:${newID}` })
  }

  const handleEdit = async (
    id: string,
    body: Parameters<typeof apiPatchExperience>[2],
  ) => {
    await withBase((b) => apiPatchExperience(b, id, body))
    flash("Saved")
    refreshAll()
  }

  const handleReRefine = async (id: string) => {
    await withBase((b) => apiReRefineExperience(b, id))
    flash("Re-refined")
    refreshAll()
  }

  const handleUndo = async (id: string) => {
    await withBase((b) => apiUndoRefinement(b, id))
    flash("Reverted to snapshot")
    refreshAll()
  }

  const handleDeleteObservation = async (
    experienceID: string,
    observationID: string,
  ) => {
    await withBase((b) => apiDeleteObservation(b, experienceID, observationID))
    flash("Observation removed · re-refined")
    refreshAll()
  }

  const handleMoveObservation = async (input: {
    observation_id: string
    from_experience_id: string
    to_experience_id: string
  }) => {
    await withBase((b) => apiMoveObservation(b, input))
    flash("Observation moved")
    refreshAll()
  }

  const handleMerge = async (ids: string[], reason?: string) => {
    const res = (await withBase((b) => apiMergeExperiences(b, ids, reason))) as any
    if (res?.synthesisFallback) {
      flash("Merged (model produced invalid abstract; kept seed fields — you can re-refine manually)")
    } else {
      flash("Merged")
    }
    setMergeIDs(new Set<string>())
    refreshAll()
    const newID: string | undefined = res?.experience?.id
    if (newID) setSelection({ kind: "experience", id: `experience:${newID}` })
  }

  const handleIngest = async (sessionID: string) => {
    await withBase((b) => apiIngestSession(b, sessionID))
    flash("Session ingested")
    refreshAll()
  }

  const handleExport = async () => {
    const bundle = await withBase((b) => apiExport(b))
    const blob = new Blob([JSON.stringify(bundle, null, 2)], {
      type: "application/json",
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `refiner-export-${Date.now()}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    flash("Exported")
  }

  const handleImport = async (input: { data: unknown; mode: "merge" | "replace" }) => {
    await withBase((b) => apiImport(b, input.data, input.mode))
    flash("Imported")
    refreshAll()
  }

  const runSearch = async (q: string, withArchived: boolean) => {
    const b = apiBase()
    if (!b) throw new Error("server not ready")
    return apiSearch(b, q, { limit: 30, includeArchived: withArchived })
  }

  // ── Merge selection helpers
  const toggleMergeSelect = (id: string) => {
    setMergeIDs((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const removeFromMerge = (id: string) => {
    setMergeIDs((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }
  const clearMergeSelection = () => setMergeIDs(new Set<string>())
  const mergeSelectedExperiences = createMemo(() => {
    const ids = mergeIDs()
    const map = experienceByID()
    const out: Experience[] = []
    for (const id of ids) {
      const e = map.get(id)
      if (e) out.push(e)
    }
    return out
  })

  return (
    <div class="refiner-page relative flex size-full min-h-0 flex-col overflow-hidden">
      <SessionHeader />

      <div class="rf-top">
        <div class="rf-brand">
          <span class="rf-brand-title">Refiner</span>
          <span class="rf-brand-meta">
            <span class="rf-brand-num">{overview()?.status.total_experiences ?? 0}</span>
            <span>experiences</span>
            <span class="rf-brand-sep">·</span>
            <span class="rf-brand-num">{overview()?.status.total_observations ?? 0}</span>
            <span>observations</span>
            <Show when={overview()?.status.latest_refined_at}>
              <span class="rf-brand-sep">·</span>
              <span>{fmtTime(overview()!.status.latest_refined_at)}</span>
            </Show>
          </span>
        </div>

        <ModelPicker
          current={config()?.resolved ?? overview()?.model}
          source={config()?.source}
          onChange={updateModel}
          onReset={resetModel}
        />

        <div class="rf-top-spacer" />

        <div
          class="rf-scope-toggle"
          role="group"
          aria-label="Scope filter"
          title="显示全部记忆，或仅显示本会话产生的 experience"
        >
          <button
            type="button"
            class="rf-scope-btn"
            data-active={scopeMode() === "all"}
            onClick={() => setScopeMode("all")}
          >
            全部
          </button>
          <button
            type="button"
            class="rf-scope-btn"
            data-active={scopeMode() === "session"}
            onClick={() => setScopeMode("session")}
          >
            本会话
          </button>
        </div>

        <div class="rf-top-div" />

        <button
          type="button"
          class="rf-topbtn rf-topbtn-icon"
          onClick={refreshAll}
          title="刷新"
          aria-label="刷新"
        >
          ↻
        </button>

        <MoreMenu
          items={[
            {
              type: "action",
              key: "new",
              icon: "＋",
              label: "New experience",
              onPick: () => setAction({ type: "create" }),
            },
            {
              type: "action",
              key: "search",
              icon: "⌕",
              label: "Search memory",
              onPick: () => setAction({ type: "search" }),
            },
            {
              type: "action",
              key: "ingest",
              icon: "⇅",
              label: "Ingest this session",
              onPick: () => setAction({ type: "ingest", sessionID: params.id ?? "" }),
            },
            { type: "sep" },
            {
              type: "action",
              key: "export",
              icon: "⇩",
              label: "Export as JSON",
              onPick: () => void handleExport(),
            },
            {
              type: "action",
              key: "import",
              icon: "⇧",
              label: "Import bundle",
              onPick: () => setAction({ type: "import" }),
            },
            { type: "sep" },
            {
              type: "toggle",
              key: "archived",
              icon: "",
              label: "Show archived",
              checked: includeArchived(),
              onToggle: () => setIncludeArchived(!includeArchived()),
            },
          ]}
        />

        <Button
          variant="secondary"
          size="small"
          onClick={() => navigate(`/${params.dir}/session/${params.id}`)}
        >
          返回
        </Button>
      </div>

      <Filterbar
        taxonomy={taxonomy()}
        countsByKind={kindCounts()}
        categories={categoriesData()?.categories ?? []}
        totalCount={overview()?.experiences.length ?? 0}
        activeKind={activeKind()}
        setActiveKind={setActiveKind}
        activeCategory={activeCategory()}
        setActiveCategory={setActiveCategory}
        query={query()}
        setQuery={setQuery}
        sort={sortMode()}
        setSort={setSortMode}
      />

      <Show when={banner()}>
        <div class="rf-banner">{banner()}</div>
      </Show>

      <div class="rf-stage">
        <div class="rf-main">
          <div class="rf-list-view">
            <div class="rf-list-inner">
              <div class="rf-list-header">
                <div class="rf-list-title">
                  经验列表
                  <span class="rf-list-title-sub">
                    {visibleExperiences().length} 条
                    <Show when={query()}>
                      {" · 匹配 "}
                      <em>{`"${query()}"`}</em>
                    </Show>
                  </span>
                </div>
                <div class="rf-list-controls">
                  <Show
                    when={mergeIDs().size > 0}
                    fallback={
                      <button
                        class="rf-topbtn rf-topbtn-ghost"
                        onClick={() => setAction({ type: "create" })}
                      >
                        ＋ 新建
                      </button>
                    }
                  >
                    <span class="rf-list-selected">{mergeIDs().size} 已选</span>
                    <button
                      class="rf-topbtn"
                      disabled={mergeIDs().size < 2}
                      onClick={() =>
                        setAction({
                          type: "merge",
                          ids: [...mergeIDs()],
                        })
                      }
                    >
                      合并 {mergeIDs().size}
                    </button>
                    <button
                      class="rf-topbtn"
                      onClick={async () => {
                        for (const id of mergeIDs()) {
                          await handleArchiveToggle(id, true)
                        }
                        clearMergeSelection()
                      }}
                    >
                      归档
                    </button>
                    <button
                      class="rf-topbtn rf-topbtn-ghost"
                      onClick={clearMergeSelection}
                    >
                      取消
                    </button>
                  </Show>
                </div>
              </div>

              <Show
                when={visibleExperiences().length > 0}
                fallback={
                  <div class="rf-list-empty">
                    <h3>没有匹配的经验</h3>
                    <p>试试清空搜索，或者切换其他分类。</p>
                  </div>
                }
              >
                <Show
                  when={sortMode() === "kind"}
                  fallback={
                    <section class="rf-list-group">
                      <For each={visibleExperiencesFlat()}>
                        {(item) => (
                          <ExperienceRow
                            item={item}
                            query={query()}
                            selected={
                              selection()?.id === `experience:${item.id}`
                            }
                            mergeSel={mergeIDs().has(item.id)}
                            anySelected={mergeIDs().size > 0}
                            onOpen={() => pickExperienceByID(item.id)}
                            onToggleCheck={() => toggleMergeSelect(item.id)}
                          />
                        )}
                      </For>
                    </section>
                  }
                >
                  <For each={experiencesByKind()}>
                    {([kind, items]) => (
                      <section class="rf-list-group">
                        <header
                          class="rf-list-group-head"
                          data-palette={paletteFor(kind)}
                        >
                          <span class="rf-list-group-bar" />
                          <span class="rf-list-group-title">
                            {kindDisplay(kind)}
                          </span>
                          <span class="rf-list-group-count">{items.length}</span>
                        </header>
                        <For each={items}>
                          {(item) => (
                            <ExperienceRow
                              item={item}
                              query={query()}
                              selected={
                                selection()?.id === `experience:${item.id}`
                              }
                              mergeSel={mergeIDs().has(item.id)}
                              anySelected={mergeIDs().size > 0}
                              onOpen={() => pickExperienceByID(item.id)}
                              onToggleCheck={() => toggleMergeSelect(item.id)}
                            />
                          )}
                        </For>
                      </section>
                    )}
                  </For>
                </Show>
              </Show>
            </div>
          </div>
        </div>

        <PeekPanel
          experience={selectedExperience()}
          allExperiences={overview()?.experiences ?? []}
          onClose={() => setSelection(undefined)}
          onPickExperience={pickExperienceByID}
          onPickObservation={navigateToObservation}
          sessionHref={sessionHref}
          onAction={setAction}
          onReRefine={(id) => handleReRefine(id)}
          onUndo={(id) => handleUndo(id)}
          onArchiveToggle={(id, archived) => handleArchiveToggle(id, archived)}
          onToggleMergeSelect={toggleMergeSelect}
          mergeSelected={(id) => mergeIDs().has(id)}
        />
      </div>

      <MergeTray
        selected={mergeSelectedExperiences()}
        onClear={clearMergeSelection}
        onOpen={() =>
          setAction({
            type: "merge",
            ids: mergeSelectedExperiences().map((e) => e.id),
          })
        }
      />

      {/* Modals */}
      <Show when={action()?.type === "create"}>
        <CreateModal
          onClose={() => setAction(undefined)}
          onSubmit={(input) => handleCreate(input)}
        />
      </Show>
      <Show
        when={(() => {
          const a = action()
          return a?.type === "augment" ? a : undefined
        })()}
      >
        {(a) => (
          <AugmentModal
            experience={a().experience}
            onClose={() => setAction(undefined)}
            onSubmit={(input) => handleAugment(a().experience.id, input)}
          />
        )}
      </Show>
      <Show
        when={(() => {
          const a = action()
          return a?.type === "edit" ? a : undefined
        })()}
      >
        {(a) => (
          <EditModal
            experience={a().experience}
            onClose={() => setAction(undefined)}
            onSubmit={(input) => handleEdit(a().experience.id, input)}
          />
        )}
      </Show>
      <Show
        when={(() => {
          const a = action()
          return a?.type === "delete" ? a : undefined
        })()}
      >
        {(a) => (
          <DeleteModal
            experience={a().experience}
            onClose={() => setAction(undefined)}
            onSubmit={(opts) => handleDelete(a().experience.id, opts)}
          />
        )}
      </Show>
      <Show
        when={(() => {
          const a = action()
          return a?.type === "merge" ? a : undefined
        })()}
      >
        {(a) => (
          <MergeModal
            experiences={a()
              .ids.map((id) => experienceByID().get(id))
              .filter((x): x is Experience => !!x)}
            onClose={() => setAction(undefined)}
            onSubmit={(reason) => handleMerge(a().ids, reason)}
          />
        )}
      </Show>
      <Show when={action()?.type === "import"}>
        <ImportModal
          onClose={() => setAction(undefined)}
          onSubmit={(input) => handleImport(input)}
        />
      </Show>
      <Show when={action()?.type === "search"}>
        <SearchModal
          runSearch={runSearch}
          onPick={pickExperienceByID}
          onClose={() => setAction(undefined)}
        />
      </Show>
      <Show
        when={(() => {
          const a = action()
          return a?.type === "ingest" ? a : undefined
        })()}
      >
        {(a) => (
          <IngestModal
            sessionID={a().sessionID}
            onClose={() => setAction(undefined)}
            onSubmit={() => handleIngest(a().sessionID)}
          />
        )}
      </Show>
      <Show
        when={(() => {
          const a = action()
          return a?.type === "deleteObservation" ? a : undefined
        })()}
      >
        {(a) => (
          <DeleteObservationModal
            experience={a().experience}
            observation={a().observation}
            onClose={() => setAction(undefined)}
            onSubmit={() =>
              handleDeleteObservation(a().experience.id, a().observation.id)
            }
          />
        )}
      </Show>
      <Show
        when={(() => {
          const a = action()
          return a?.type === "moveObservation" ? a : undefined
        })()}
      >
        {(a) => (
          <MoveObservationModal
            experience={a().experience}
            observation={a().observation}
            allExperiences={overview()?.experiences ?? []}
            onClose={() => setAction(undefined)}
            onSubmit={(to) =>
              handleMoveObservation({
                observation_id: a().observation.id,
                from_experience_id: a().experience.id,
                to_experience_id: to,
              })
            }
          />
        )}
      </Show>
    </div>
  )
}
