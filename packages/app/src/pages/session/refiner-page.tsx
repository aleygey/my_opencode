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
import { Portal } from "solid-js/web"
import { Markdown } from "@opencode-ai/ui/markdown"
import { useNavigate, useParams } from "@solidjs/router"
import { useShellBridge } from "@/components/unified-shell/shell-bridge"
import {
  KnowledgeGraph as RuneKnowledgeGraph,
  KnowledgeList as RuneKnowledgeList,
  type KnowledgeEdge as RuneKnowledgeEdge,
  type KnowledgeExp as RuneKnowledgeExp,
} from "@/components/unified-shell/modules"
import { RuneModelPicker } from "@/components/unified-shell/model-picker"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { stableFetcher } from "@/utils/stable-fetch"
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

type ReviewStatus = "pending" | "approved" | "rejected"

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
  review_status?: ReviewStatus
  reviewed_at?: number
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

type ChainEdgeKind =
  | "requires"
  | "refines"
  | "supports"
  | "contradicts"
  | "see_also"

type GraphEdge = {
  from: string
  to: string
  kind:
    | "has_observation"
    | "related"
    | `chain_${ChainEdgeKind}`
  edge_id?: string
  reason?: string
  confidence?: number
}

// Mirrors backend's RefinerLogEntry / RefinerLlmCall — surfaced via the
// Knowledge "Logs" modal so the user can audit every refiner run.
type RefinerLlmCall = {
  stage: "route" | "refine" | "synthesis" | "edge"
  provider_id?: string
  model_id?: string
  system_prompt?: string
  user_prompt: string
  response_text?: string
  reasoning_text?: string
  structured_output?: unknown
  error?: string
  duration_ms: number
}

type RefinerLogEntry = {
  id: string
  created_at: number
  duration_ms: number
  trigger: "auto" | "manual" | "history" | "import" | "re_refine"
  session_id?: string
  message_id?: string
  observation_id?: string
  user_text: string
  outcome: "new_exp" | "update_exp" | "edge_only" | "noise" | "dropped" | "error"
  experience_ids: string[]
  reason?: string
  llm_calls: RefinerLlmCall[]
}

type ChainGraphEdge = {
  id: string
  from: string
  to: string
  kind: ChainEdgeKind
  reason?: string
  confidence?: number
  created_at?: number
  created_by?: string
  source_observation_id?: string
}

type ChainGraphExperienceLite = {
  id: string
  kind: Kind
  title: string
  abstract: string
  task_type?: string
  scope?: Scope
  categories?: string[]
  archived?: boolean
  review_status?: ReviewStatus
  reviewed_at?: number
  observation_count?: number
  last_refined_at?: number
}

type ChainGraphResponse = {
  experiences: ChainGraphExperienceLite[]
  edges: ChainGraphEdge[]
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

// OKLCH hue per palette — mirrors the CSS palette blocks in refiner-page.css.
// Used by the StarGraph SVG which emits inline oklch() fills for theme parity.
const PALETTE_HUE: Record<PaletteName, number> = {
  cobalt: 250,
  amber: 35,
  mint: 155,
  ember: 295,
  blue: 200,
  lilac: 340,
  solaris: 85,
  gray: 235,
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

// Short keyword label for StarGraph chip nodes — first clause (up to
// comma/period/semicolon/middle-dot), whitespace collapsed, capped at maxChars.
const shortLabel = (text?: string, maxChars = 10): string => {
  if (!text) return ""
  const firstClause = text.split(/[，,。.;；：:·]/)[0]?.trim() ?? ""
  const src = firstClause || text.trim()
  const cleaned = src.replace(/\s+/g, "")
  if (cleaned.length <= maxChars) return cleaned
  return cleaned.slice(0, maxChars) + "…"
}

const hhmm = (ts: number): string => {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

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

async function fetchRefinerLog(input: {
  baseUrl: string
  directory: string
  password?: string
  username?: string
  fetcher?: typeof fetch
}): Promise<{ entries: RefinerLogEntry[] }> {
  const url = new URL("/experimental/refiner/log", input.baseUrl)
  const res = await (input.fetcher ?? fetch)(url, {
    headers: buildHeaders({
      directory: input.directory,
      username: input.username,
      password: input.password,
    }),
  })
  if (!res.ok) throw new Error(`Failed to load refiner log (${res.status})`)
  return readJsonOrThrow<{ entries: RefinerLogEntry[] }>(res, "Refiner log")
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

type ExperienceUsageStat = {
  injected: {
    total: number
    by_tier: { baseline: number; topical: number; recall: number }
    last_at: number
  }
  used: {
    cited: number
    recalled: number
    last_at: number
  }
}

type UsageStatsResponse = Record<string, ExperienceUsageStat>

async function fetchUsageStats(input: {
  baseUrl: string
  directory: string
  password?: string
  username?: string
  fetcher?: typeof fetch
}): Promise<UsageStatsResponse> {
  const url = new URL("/experimental/refiner/stats", input.baseUrl)
  const res = await (input.fetcher ?? fetch)(url, {
    headers: buildHeaders({
      directory: input.directory,
      username: input.username,
      password: input.password,
    }),
  })
  if (!res.ok) throw new Error(`Failed to load usage stats (${res.status})`)
  return readJsonOrThrow<UsageStatsResponse>(res, "Refiner usage stats")
}

type ConfigSource = "override" | "agent" | "default" | "none"

type RefinerConfig = {
  resolved?: { providerID: string; modelID: string }
  source: ConfigSource
  override: {
    model?: { providerID: string; modelID: string }
    temperature?: number
    auto_enabled?: boolean
  } | null
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
  body: {
    model?: { providerID: string; modelID: string } | null
    temperature?: number | null
    auto_enabled?: boolean | null
  }
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

const fetchChainGraph = (
  b: ApiBase,
  opts?: { includeArchived?: boolean },
): Promise<ChainGraphResponse> =>
  apiRequest<ChainGraphResponse>(b, "/experimental/refiner/graph", {
    query: opts?.includeArchived ? { include_archived: true } : undefined,
  }).catch((err) => {
    console.warn("[refiner] graph endpoint unavailable:", err)
    return { experiences: [], edges: [] }
  })

const apiCreateEdge = (
  b: ApiBase,
  input: {
    from: string
    to: string
    kind: ChainEdgeKind
    reason?: string
    confidence?: number
  },
) =>
  apiRequest(b, "/experimental/refiner/edge", {
    method: "POST",
    json: input,
  })

const apiDeleteEdge = (b: ApiBase, edgeID: string) =>
  apiRequest(b, `/experimental/refiner/edge/${encodeURIComponent(edgeID)}`, {
    method: "DELETE",
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

const apiReviewExperience = (b: ApiBase, id: string, status: ReviewStatus) =>
  apiRequest(b, `/experimental/refiner/experience/${encodeURIComponent(id)}/review`, {
    method: "POST",
    json: { status },
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

const apiIngestSession = (
  b: ApiBase,
  sessionID: string,
  opts?: { messageIDs?: string[] },
) =>
  apiRequest<{ ok: boolean; stats: { processed: number; observed: number; skipped: number } }>(
    b,
    `/experimental/refiner/ingest-session/${encodeURIComponent(sessionID)}`,
    {
      method: "POST",
      json: opts?.messageIDs && opts.messageIDs.length > 0 ? { message_ids: opts.messageIDs } : {},
    },
  )

// Sessions the user can pick from in the import drawer. Roots-only to keep slave
// (parentID-bearing) sessions out of the list — ingesting a slave session would
// pull the master-authored prompt and pollute the experience library the same
// way live capture used to.
type SessionListItem = {
  id: string
  title?: string
  time?: { created?: number; updated?: number }
  version?: string
}

const apiListRootSessions = (b: ApiBase, opts?: { limit?: number; search?: string }) =>
  apiRequest<SessionListItem[]>(b, `/session`, {
    query: {
      roots: true,
      limit: opts?.limit ?? 50,
      search: opts?.search,
    },
  })

// Raw message envelope from the backend — we only touch fields we render.
type RawMessagePart = { type: string; text?: string; synthetic?: boolean; ignored?: boolean }
type RawMessageWithParts = {
  info: {
    id: string
    role: "user" | "assistant" | "system"
    time?: { created?: number }
  }
  parts: RawMessagePart[]
}

const apiListSessionMessages = (b: ApiBase, sessionID: string) =>
  apiRequest<RawMessageWithParts[]>(
    b,
    `/session/${encodeURIComponent(sessionID)}/message`,
  )

const apiListIngestedObservations = (b: ApiBase, sessionID: string) =>
  apiRequest<{ session_id: string; message_ids: string[] }>(
    b,
    `/experimental/refiner/ingested-observations/${encodeURIComponent(sessionID)}`,
  )

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
  | { type: "ingest"; sessionID?: string }
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
   (Old per-page ModelPicker removed — replaced by the shared
   `RuneModelPicker` from `@/components/unified-shell/model-picker`
   so all three runtime modules share a single visual treatment.)
   ────────────────────────────────────────────────────── */

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

/**
 * Two-level drawer for importing historical opencode sessions into the refiner.
 *
 * Level 1 (left column): list root sessions (no parentID) with a search box.
 *   Hiding slave/child sessions is deliberate — master→slave prompts were
 *   authored by the master agent, not the user, so ingesting them would pollute
 *   the experience graph with system-authored content.
 *
 * Level 2 (right column): for the selected session, list user messages only.
 *   The user ticks specific messages (or "select all"), and the submit replays
 *   exactly those through `captureObservation`, which pulls the same 3-message
 *   prior-history + workflow snapshot as live capture.
 *
 * Already-ingested message_ids are fetched once per session and used to gray
 * out rows, so re-opening the drawer shows progress at a glance.
 */
function HistoryImportDrawer(props: {
  apiBase: () => ApiBase | undefined
  currentSessionID?: string
  onClose: () => void
  onSubmit: (sessionID: string, messageIDs?: string[]) => Promise<void>
}) {
  const [sessionQuery, setSessionQuery] = createSignal("")
  const [sessions, setSessions] = createSignal<SessionListItem[]>([])
  const [sessionsLoading, setSessionsLoading] = createSignal(false)
  const [sessionsError, setSessionsError] = createSignal<string | undefined>()
  const [selectedSessionID, setSelectedSessionID] = createSignal<string | undefined>(
    props.currentSessionID,
  )
  const [messages, setMessages] = createSignal<RawMessageWithParts[]>([])
  const [messagesLoading, setMessagesLoading] = createSignal(false)
  const [messagesError, setMessagesError] = createSignal<string | undefined>()
  const [ingestedIDs, setIngestedIDs] = createSignal<Set<string>>(new Set())
  const [picked, setPicked] = createSignal<Set<string>>(new Set())
  const [submitBusy, setSubmitBusy] = createSignal(false)
  const [submitError, setSubmitError] = createSignal<string | undefined>()
  const [submitDone, setSubmitDone] = createSignal<
    { observed: number; skipped: number } | undefined
  >()

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose()
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => document.removeEventListener("keydown", onKey))
  })

  const loadSessions = async () => {
    const b = props.apiBase()
    if (!b) return
    setSessionsLoading(true)
    setSessionsError(undefined)
    try {
      const list = await apiListRootSessions(b, {
        limit: 80,
        search: sessionQuery().trim() || undefined,
      })
      // Sort newest first by updated time — list() already returns in DB order
      // but we want to be explicit since time fields may be absent in old rows.
      list.sort((a, b2) => {
        const au = a.time?.updated ?? a.time?.created ?? 0
        const bu = b2.time?.updated ?? b2.time?.created ?? 0
        return bu - au
      })
      setSessions(list)
    } catch (err) {
      setSessionsError(err instanceof Error ? err.message : String(err))
    } finally {
      setSessionsLoading(false)
    }
  }

  const loadMessages = async (sessionID: string) => {
    const b = props.apiBase()
    if (!b) return
    setMessages([])
    setPicked(new Set<string>())
    setIngestedIDs(new Set<string>())
    setMessagesError(undefined)
    setSubmitDone(undefined)
    setSubmitError(undefined)
    setMessagesLoading(true)
    try {
      const [msgs, ingested] = await Promise.all([
        apiListSessionMessages(b, sessionID),
        apiListIngestedObservations(b, sessionID).catch(() => ({ message_ids: [] })),
      ])
      setMessages(msgs)
      setIngestedIDs(new Set(ingested.message_ids))
    } catch (err) {
      setMessagesError(err instanceof Error ? err.message : String(err))
    } finally {
      setMessagesLoading(false)
    }
  }

  onMount(() => {
    void loadSessions()
    const sid = selectedSessionID()
    if (sid) void loadMessages(sid)
  })

  createEffect(() => {
    const sid = selectedSessionID()
    if (!sid) return
    void loadMessages(sid)
  })

  // Only user messages are candidates for ingest (assistant / system are skipped
  // backend-side anyway; filtering here keeps the picker honest).
  const pickableMessages = createMemo(() =>
    messages().filter((m) => {
      if (m.info.role !== "user") return false
      const hasText = m.parts.some(
        (p) => p.type === "text" && !p.synthetic && !p.ignored && (p.text ?? "").trim() !== "",
      )
      return hasText
    }),
  )

  const messageText = (m: RawMessageWithParts) =>
    m.parts
      .flatMap((p) => (p.type === "text" && !p.synthetic && !p.ignored ? [p.text ?? ""] : []))
      .join("\n")
      .trim()

  const togglePick = (messageID: string) => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(messageID)) next.delete(messageID)
      else next.add(messageID)
      return next
    })
  }

  const selectAllUnimported = () => {
    const next = new Set<string>()
    for (const m of pickableMessages()) {
      if (!ingestedIDs().has(m.info.id)) next.add(m.info.id)
    }
    setPicked(next)
  }
  const clearPicked = () => setPicked(new Set<string>())

  const submit = async () => {
    const sid = selectedSessionID()
    if (!sid) return
    setSubmitBusy(true)
    setSubmitError(undefined)
    try {
      const ids = [...picked()]
      await props.onSubmit(sid, ids.length > 0 ? ids : undefined)
      setSubmitDone({ observed: ids.length || pickableMessages().length, skipped: 0 })
      // Refresh ingested set so repeatedly imported rows gray out immediately.
      const b = props.apiBase()
      if (b) {
        const fresh = await apiListIngestedObservations(b, sid).catch(() => undefined)
        if (fresh) setIngestedIDs(new Set(fresh.message_ids))
      }
      setPicked(new Set<string>())
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitBusy(false)
    }
  }

  const formatTime = (ms?: number) => {
    if (!ms) return ""
    try {
      return new Date(ms).toLocaleString()
    } catch {
      return ""
    }
  }

  const pickedCount = () => picked().size
  const pickableCount = () => pickableMessages().length
  const alreadyIngestedCount = () =>
    pickableMessages().filter((m) => ingestedIDs().has(m.info.id)).length

  return (
    <div class="rf-drawer-scrim" onClick={() => props.onClose()}>
      <div
        class="rf-drawer"
        role="dialog"
        aria-label="Import historical sessions"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="rf-drawer-head">
          <div>
            <div class="rf-drawer-title">从历史会话导入经验</div>
            <div class="rf-drawer-subtitle">
              从 opencode 数据库挑选任意会话，再勾选用户消息，refiner 会按「当前消息 + 前 3 条历史 +
              workflow（如有）」提炼成 experience。
            </div>
          </div>
          <button
            type="button"
            class="rf-drawer-close"
            aria-label="关闭"
            onClick={() => props.onClose()}
          >
            ×
          </button>
        </div>

        <div class="rf-drawer-body">
          {/* ─── Left: session list ─── */}
          <div class="rf-drawer-col rf-drawer-col-left">
            <div class="rf-drawer-col-head">
              <div class="rf-drawer-col-title">会话</div>
              <input
                type="search"
                class="rf-drawer-search"
                placeholder="按标题过滤…"
                value={sessionQuery()}
                onInput={(e) => setSessionQuery(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void loadSessions()
                }}
              />
            </div>
            <Show when={sessionsLoading()}>
              <div class="rf-drawer-muted">加载中…</div>
            </Show>
            <Show when={sessionsError()}>
              <div class="rf-drawer-error">{sessionsError()}</div>
            </Show>
            <div class="rf-drawer-session-list">
              <For each={sessions()}>
                {(s) => (
                  <button
                    type="button"
                    class="rf-drawer-session-row"
                    data-selected={selectedSessionID() === s.id ? "true" : "false"}
                    onClick={() => setSelectedSessionID(s.id)}
                    title={s.id}
                  >
                    <div class="rf-drawer-session-title">{s.title || "(untitled)"}</div>
                    <div class="rf-drawer-session-meta">
                      <span class="rf-drawer-session-time">
                        {formatTime(s.time?.updated ?? s.time?.created)}
                      </span>
                      <span class="rf-drawer-session-id">{s.id.slice(-10)}</span>
                    </div>
                  </button>
                )}
              </For>
              <Show when={!sessionsLoading() && sessions().length === 0}>
                <div class="rf-drawer-muted">无匹配会话。</div>
              </Show>
            </div>
          </div>

          {/* ─── Right: message picker ─── */}
          <div class="rf-drawer-col rf-drawer-col-right">
            <div class="rf-drawer-col-head">
              <div class="rf-drawer-col-title">
                用户消息
                <Show when={selectedSessionID()}>
                  <span class="rf-drawer-col-title-hint">
                    {pickedCount()}/{pickableCount()} 选中
                    <Show when={alreadyIngestedCount() > 0}>
                      （已导入 {alreadyIngestedCount()}）
                    </Show>
                  </span>
                </Show>
              </div>
              <div class="rf-drawer-col-actions">
                <button
                  type="button"
                  class="rf-btn rf-btn-ghost rf-btn-xs"
                  onClick={selectAllUnimported}
                  disabled={!selectedSessionID() || pickableCount() === 0}
                >
                  选未导入
                </button>
                <button
                  type="button"
                  class="rf-btn rf-btn-ghost rf-btn-xs"
                  onClick={clearPicked}
                  disabled={pickedCount() === 0}
                >
                  清空
                </button>
              </div>
            </div>

            <Show when={!selectedSessionID()}>
              <div class="rf-drawer-muted">请先在左侧选择一个会话。</div>
            </Show>
            <Show when={selectedSessionID() && messagesLoading()}>
              <div class="rf-drawer-muted">加载消息中…</div>
            </Show>
            <Show when={messagesError()}>
              <div class="rf-drawer-error">{messagesError()}</div>
            </Show>

            <div class="rf-drawer-msg-list">
              <For each={pickableMessages()}>
                {(m) => {
                  const text = messageText(m)
                  const isIngested = () => ingestedIDs().has(m.info.id)
                  const isPicked = () => picked().has(m.info.id)
                  return (
                    <label
                      class="rf-drawer-msg-row"
                      data-ingested={isIngested() ? "true" : "false"}
                      data-picked={isPicked() ? "true" : "false"}
                    >
                      <input
                        type="checkbox"
                        class="rf-drawer-msg-check"
                        checked={isPicked()}
                        onChange={() => togglePick(m.info.id)}
                      />
                      <div class="rf-drawer-msg-body">
                        <div class="rf-drawer-msg-text">{text}</div>
                        <div class="rf-drawer-msg-meta">
                          <span>{formatTime(m.info.time?.created)}</span>
                          <Show when={isIngested()}>
                            <span class="rf-drawer-msg-ingested">已导入</span>
                          </Show>
                        </div>
                      </div>
                    </label>
                  )
                }}
              </For>
              <Show
                when={
                  selectedSessionID() && !messagesLoading() && pickableMessages().length === 0
                }
              >
                <div class="rf-drawer-muted">该会话没有可导入的用户消息。</div>
              </Show>
            </div>
          </div>
        </div>

        <div class="rf-drawer-foot">
          <div class="rf-drawer-foot-status">
            <Show when={submitBusy()}>
              <span class="rf-spinner" /> <span>导入中…</span>
            </Show>
            <Show when={submitError()}>
              <span class="rf-drawer-error-inline">{submitError()}</span>
            </Show>
            <Show when={submitDone()}>
              {(d) => (
                <span class="rf-drawer-ok-inline">
                  已提交 {d().observed} 条，图谱稍后刷新。
                </span>
              )}
            </Show>
          </div>
          <div class="rf-drawer-foot-actions">
            <button
              type="button"
              class="rf-btn rf-btn-ghost"
              onClick={() => props.onClose()}
              disabled={submitBusy()}
            >
              关闭
            </button>
            <button
              type="button"
              class="rf-btn rf-btn-primary"
              onClick={() => void submit()}
              disabled={submitBusy() || !selectedSessionID() || pickableCount() === 0}
              title={
                pickedCount() === 0
                  ? "未勾选消息 → 导入全部可导入消息"
                  : `导入 ${pickedCount()} 条消息`
              }
            >
              {pickedCount() > 0
                ? `导入选中的 ${pickedCount()} 条`
                : `导入全部 ${pickableCount()} 条`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ──────────────────────────────────────────────────────
   StarGraph — chip-shaped obs nodes around a center experience,
   with mouse-follow flow (halo drifts, rings parallax, edges
   bend toward cursor, nodes lean & scale on hover). Hover state
   lifts back to the parent via the onHover accessor so the info
   column can echo highlights on the matching obs card.

   Rendering pattern notes (carried from the design's React prototype):
   - Per-node hover scale is animated by writing `transform` attribute
     via setAttribute inside a rAF loop — CSS transform on SVG <g> is
     unreliable in Safari/WebKit when combined with transform-box.
   - Mouse smoothing and per-node lean both run in their own rAF loops
     so that lerp math stays frame-rate capped.
   ────────────────────────────────────────────────────── */

type MouseState = { x: number; y: number; active: boolean }

type StarNode = {
  id: string
  x: number
  y: number
  idx: number
  label: string
  time: string
  message_id: string
  session_id: string
  user_text: string
}

function StarObsNode(props: {
  node: StarNode
  idx: number
  hovered: boolean
  hue: number
  smoothed: () => MouseState
  onHover: (id: string | null) => void
  onClick?: () => void
}) {
  let gRef: SVGGElement | undefined
  const state = {
    scale: 1,
    tx: 0,
    ty: 0,
    targetScale: 1,
    targetTx: 0,
    targetTy: 0,
  }

  onMount(() => {
    let raf = 0
    const tick = () => {
      const k = 0.18
      state.scale += (state.targetScale - state.scale) * k
      state.tx += (state.targetTx - state.tx) * k
      state.ty += (state.targetTy - state.ty) * k
      if (gRef) {
        gRef.setAttribute(
          "transform",
          `translate(${state.tx.toFixed(3)} ${state.ty.toFixed(3)}) scale(${state.scale.toFixed(4)})`,
        )
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    onCleanup(() => cancelAnimationFrame(raf))
  })

  createEffect(() => {
    const s = props.hovered ? 1.14 : 1
    const sm = props.smoothed()
    const leanX = sm.active ? (sm.x - props.node.x) * 0.06 : 0
    const leanY = sm.active ? (sm.y - props.node.y) * 0.06 : 0
    state.targetScale = s
    state.targetTx = props.node.x + leanX - props.node.x * s
    state.targetTy = props.node.y + leanY - props.node.y * s
  })

  const chipW = 92
  const chipH = 34
  const CY_REF = 160 // viewBox center; used to decide label above/below

  return (
    <g
      ref={gRef}
      class={`rf-star-node${props.hovered ? " is-hover" : ""}`}
      transform="translate(0 0) scale(1)"
      style={{
        cursor: "pointer",
        "animation-delay": `${220 + props.idx * 90}ms`,
        filter: props.hovered
          ? `drop-shadow(0 6px 14px oklch(0.5 0.10 ${props.hue} / 0.28))`
          : "none",
        transition: "filter .22s",
      }}
      onMouseEnter={() => props.onHover(props.node.id)}
      onMouseLeave={() => props.onHover(null)}
      onClick={() => props.onClick?.()}
    >
      <rect
        x={props.node.x - chipW / 2}
        y={props.node.y - chipH / 2}
        width={chipW}
        height={chipH}
        rx={chipH / 2}
        fill={props.hovered ? `oklch(0.97 0.02 ${props.hue})` : "var(--rf-card)"}
        stroke={`oklch(0.62 0.08 ${props.hue})`}
        stroke-width={props.hovered ? 1.5 : 1}
        style={{ transition: "stroke-width .18s, fill .18s" }}
      />
      <circle
        cx={props.node.x - chipW / 2 + 9}
        cy={props.node.y}
        r={3}
        fill={`oklch(0.58 0.10 ${props.hue})`}
      />
      <text
        x={props.node.x - chipW / 2 + 17}
        y={props.node.y + 1}
        font-size="11"
        fill="var(--rf-ink)"
        font-weight="500"
        dominant-baseline="middle"
        style={{ "letter-spacing": "-0.003em" }}
      >
        {props.node.label}
      </text>
      <text
        x={props.node.x}
        y={props.node.y + (props.node.y > CY_REF ? 30 : -22)}
        text-anchor="middle"
        font-size="9.5"
        fill="var(--rf-dim)"
        font-family="var(--font-family-mono)"
      >
        {props.node.id.slice(0, 6)} · {props.node.time}
      </text>
    </g>
  )
}

function StarGraph(props: {
  experience: Experience
  hoveredObs: () => string | null
  onHover: (id: string | null) => void
  onClickObs?: (obs: Observation) => void
}) {
  const W = 480
  const H = 320
  const cx = W / 2
  const cy = H / 2
  const hue = () => PALETTE_HUE[paletteFor(props.experience.kind)]

  const nodes = createMemo<StarNode[]>(() => {
    const obs = props.experience.observations
    const n = obs.length
    if (n === 0) return []
    const radius = n <= 2 ? 100 : n <= 4 ? 118 : 130
    const angleOffset = -Math.PI / 2 - (n > 1 ? Math.PI / n : 0) * 0.15
    return obs.map((o, i) => {
      const a = angleOffset + (i / Math.max(1, n)) * Math.PI * 2
      return {
        id: o.id,
        x: cx + Math.cos(a) * radius,
        y: cy + Math.sin(a) * radius,
        idx: i,
        label: shortLabel(o.user_text, 10),
        time: hhmm(o.observed_at),
        message_id: o.message_id,
        session_id: o.session_id,
        user_text: o.user_text,
      }
    })
  })
  const radius = () => {
    const n = nodes().length
    return n <= 2 ? 100 : n <= 4 ? 118 : 130
  }

  let svgRef: SVGSVGElement | undefined
  const [mouse, setMouse] = createSignal<MouseState>({ x: cx, y: cy, active: false })
  const [smoothed, setSmoothed] = createSignal<MouseState>({ x: cx, y: cy, active: false })

  onMount(() => {
    let raf = 0
    const tick = () => {
      const m = mouse()
      setSmoothed((prev) => ({
        x: prev.x + (m.x - prev.x) * 0.12,
        y: prev.y + (m.y - prev.y) * 0.12,
        active: m.active,
      }))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    onCleanup(() => cancelAnimationFrame(raf))
  })

  const onMove = (e: MouseEvent) => {
    if (!svgRef) return
    const rect = svgRef.getBoundingClientRect()
    const sx = ((e.clientX - rect.left) / rect.width) * W
    const sy = ((e.clientY - rect.top) / rect.height) * H
    setMouse({ x: sx, y: sy, active: true })
  }
  const onLeave = () => setMouse((m) => ({ ...m, active: false, x: cx, y: cy }))

  const parallax = (strength: number) => {
    const s = smoothed()
    return { tx: (s.x - cx) * strength, ty: (s.y - cy) * strength }
  }

  // Halo gradient id — namespaced by experience id so multiple modals
  // (unlikely, but cheap to guard) do not collide.
  const gradId = () => `rf-star-halo-${props.experience.id}`

  // Tooltip source (center or an obs node)
  type TipSource = {
    kind: "exp" | "obs"
    x: number
    y: number
    meta: string
    title: string | null
    text: string
    halfH: number
  }
  const tooltip = createMemo<TipSource | null>(() => {
    const id = props.hoveredObs()
    if (!id) return null
    if (id === "__center__") {
      const n = nodes().length
      return {
        kind: "exp",
        x: cx,
        y: cy,
        meta: `${props.experience.id.slice(0, 10).toUpperCase()} · ${kindDisplay(props.experience.kind)} · ${n} obs`,
        title: props.experience.title,
        text: props.experience.abstract,
        halfH: 24,
      }
    }
    const nd = nodes().find((nn) => nn.id === id)
    if (!nd) return null
    return {
      kind: "obs",
      x: nd.x,
      y: nd.y,
      meta: `${nd.id.slice(0, 6)} · ${nd.time}`,
      title: null,
      text: nd.user_text,
      halfH: 17,
    }
  })

  const wrapLines = (text: string, perLine = 22, max = 3): string[] => {
    const words = text.replace(/\s+/g, "")
    const lines: string[] = []
    for (let i = 0; i < words.length && lines.length < max; i += perLine) {
      lines.push(words.slice(i, i + perLine))
    }
    if (words.length > lines.length * perLine && lines.length > 0) {
      lines[lines.length - 1] =
        lines[lines.length - 1].slice(0, perLine - 1) + "…"
    }
    return lines
  }

  return (
    <svg
      ref={svgRef}
      class="rf-star-svg"
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height={H}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
    >
      <defs>
        <radialGradient id={gradId()} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color={`oklch(0.74 0.045 ${hue()})`} stop-opacity="0.25" />
          <stop offset="60%" stop-color={`oklch(0.74 0.045 ${hue()})`} stop-opacity="0.05" />
          <stop offset="100%" stop-color={`oklch(0.74 0.045 ${hue()})`} stop-opacity="0" />
        </radialGradient>
      </defs>

      {/* halo — drifts with cursor */}
      {(() => {
        const p = parallax(0.12)
        return (
          <circle
            cx={cx + p.tx}
            cy={cy + p.ty}
            r={110}
            fill={`url(#${gradId()})`}
            class="rf-star-halo"
            style={{ transition: "cx .4s ease-out, cy .4s ease-out" }}
          />
        )
      })()}

      {/* rings — gentle drift */}
      {(() => {
        const p = parallax(0.05)
        return (
          <g
            style={{
              transform: `translate(${p.tx}px, ${p.ty}px)`,
              transition: "transform .4s ease-out",
            }}
          >
            <circle cx={cx} cy={cy} r={radius()} fill="none" stroke="var(--rf-line)" stroke-dasharray="2 4" opacity="0.6" />
            <circle cx={cx} cy={cy} r={radius() - 30} fill="none" stroke="var(--rf-line-soft)" stroke-dasharray="2 4" opacity="0.4" />
          </g>
        )
      })()}

      {/* edges — bend toward cursor */}
      <For each={nodes()}>
        {(nd, i) => {
          const midX = (cx + nd.x) / 2
          const midY = (cy + nd.y) / 2
          const ctrlX = () => {
            const sm = smoothed()
            const bend = sm.active ? 0.25 : 0
            return midX + (sm.x - midX) * bend
          }
          const ctrlY = () => {
            const sm = smoothed()
            const bend = sm.active ? 0.25 : 0
            return midY + (sm.y - midY) * bend
          }
          const active = () => props.hoveredObs() === nd.id
          return (
            <g class="rf-star-edge-wrap" style={{ "animation-delay": `${120 + i() * 80}ms` }}>
              <path
                d={`M ${cx} ${cy} Q ${ctrlX()} ${ctrlY()} ${nd.x} ${nd.y}`}
                fill="none"
                stroke={active() ? `oklch(0.55 0.12 ${hue()})` : `oklch(0.78 0.04 ${hue()})`}
                stroke-width={active() ? 1.6 : 1}
                class="rf-star-edge"
                style={{ transition: "stroke .25s, stroke-width .25s" }}
              />
            </g>
          )
        }}
      </For>

      {/* center chip */}
      {(() => {
        const hov = () => props.hoveredObs() === "__center__"
        const scale = () => (hov() ? 1.1 : 1)
        const transform = () => {
          const p = parallax(0.03)
          const s = scale()
          const tx = cx + p.tx - cx * s
          const ty = cy + p.ty - cy * s
          return `translate(${tx} ${ty}) scale(${s})`
        }
        return (
          <g
            class={`rf-star-center${hov() ? " is-hover" : ""}`}
            transform={transform()}
            style={{
              cursor: "pointer",
              transition: "transform .28s cubic-bezier(0.2, 0.9, 0.25, 1.25)",
              filter: hov()
                ? `drop-shadow(0 6px 14px oklch(0.5 0.10 ${hue()} / 0.3))`
                : "none",
            }}
            onMouseEnter={() => props.onHover("__center__")}
            onMouseLeave={() => props.onHover(null)}
          >
            <rect x={cx - 62} y={cy - 22} width={124} height={44} rx={22} fill="var(--rf-card)" stroke={`oklch(0.55 0.10 ${hue()})`} stroke-width={1.3} />
            <rect x={cx - 58} y={cy - 18} width={116} height={36} rx={18} fill={`oklch(0.97 0.018 ${hue()})`} />
            <text x={cx} y={cy - 2} text-anchor="middle" font-size="11" fill={`oklch(0.34 0.08 ${hue()})`} font-weight="600">
              {kindDisplay(props.experience.kind)}
            </text>
            <text x={cx} y={cy + 13} text-anchor="middle" font-size="9" fill="var(--rf-dim)" font-family="var(--font-family-mono)">
              {props.experience.id.slice(0, 8).toUpperCase()} · {nodes().length} obs
            </text>
          </g>
        )
      })()}

      {/* obs nodes */}
      <For each={nodes()}>
        {(nd, i) => (
          <StarObsNode
            node={nd}
            idx={i()}
            hovered={props.hoveredObs() === nd.id}
            hue={hue()}
            smoothed={smoothed}
            onHover={props.onHover}
            onClick={() => {
              const found = props.experience.observations.find((oo) => oo.id === nd.id)
              if (found) props.onClickObs?.(found)
            }}
          />
        )}
      </For>

      {/* tooltip — rendered last so it sits on top */}
      <Show when={tooltip()} keyed>
        {(t) => {
          const lines = wrapLines(t.text)
          const tw = 264
          const headerH = 22
          const titleH = t.title ? 18 : 0
          const bodyH = lines.length * 16
          const th = headerH + titleH + bodyH + 10
          const gap = t.halfH + 12
          let ty = t.y - gap - th
          if (ty < 6) ty = t.y + gap
          if (ty + th > H - 6) ty = Math.max(6, H - 6 - th)
          let tx = t.x - tw / 2
          tx = Math.max(8, Math.min(W - tw - 8, tx))
          return (
            <g class="rf-star-tooltip" style={{ "pointer-events": "none" }}>
              <rect
                x={tx}
                y={ty}
                width={tw}
                height={th}
                rx={8}
                fill="var(--rf-card)"
                stroke="var(--rf-line-strong)"
                stroke-width={1}
                style={{ filter: "drop-shadow(0 6px 16px oklch(0.22 0.03 235 / 0.22))" }}
              />
              <text
                x={tx + 12}
                y={ty + 15}
                font-size="9.5"
                fill="var(--rf-dim)"
                font-family="var(--font-family-mono)"
                style={{ "letter-spacing": "0.05em", "text-transform": "uppercase" }}
              >
                {t.meta}
              </text>
              <Show when={t.title}>
                <text x={tx + 12} y={ty + 32} font-size="12" fill="var(--rf-ink)" font-weight="600">
                  {t.title && t.title.length > 22 ? t.title.slice(0, 22) + "…" : t.title}
                </text>
              </Show>
              <For each={lines}>
                {(ln, i) => (
                  <text
                    x={tx + 12}
                    y={ty + headerH + titleH + 12 + i() * 16}
                    font-size="12"
                    fill={t.title ? "var(--rf-ink-soft)" : "var(--rf-ink)"}
                  >
                    {ln}
                  </text>
                )}
              </For>
            </g>
          )
        }}
      </Show>
    </svg>
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
  onReview: (status: ReviewStatus) => Promise<void> | void
  onToggleMergeSelect: (id: string) => void
  mergeSelected: boolean
  /** Live counters for this experience — undefined when no stats exist yet. */
  usageStat?: ExperienceUsageStat
}

function ExperiencePeek(props: ExperiencePeekProps) {
  const exp = () => props.experience
  const palette = () => paletteFor(exp().kind)
  const [acting, setActing] = createSignal<string | undefined>()
  // Phase 2a: the in-modal constellation graph moved to the page-level
  // "Graph" tab. The peek card is now an info-only right panel; hover
  // linkage between obs cards and graph nodes is no longer needed here.

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
      <div class="rf-peek-head" data-palette={palette()}>
        <div class="rf-peek-head-l">
          <span class="rf-peek-catpill">
            <span class="rf-peek-catpill-dot" />
            {kindDisplay(exp().kind)}
          </span>
          <Show when={exp().archived}>
            <span class="rf-peek-head-archived">Archived</span>
          </Show>
          <Show when={(exp().review_status ?? "approved") !== "approved"}>
            <span
              class="rf-peek-head-tag"
              data-review-status={exp().review_status}
              title={
                exp().review_status === "pending"
                  ? "待审核 — 自动捕获后未经人工确认，retrieval 不会注入"
                  : "已拒绝 — 文件保留作审计"
              }
            >
              <b>review</b>
              {exp().review_status === "pending" ? "Pending" : "Rejected"}
            </span>
          </Show>
          <Show when={exp().task_type}>
            <span class="rf-peek-head-tag">
              <b>task</b>
              {exp().task_type}
            </span>
          </Show>
          <span class="rf-peek-head-tag">
            <b>scope</b>
            {exp().scope}
          </span>
          <Show when={referenceTotals().sessions > 1}>
            <span class="rf-peek-head-tag">
              <b>sessions</b>
              {referenceTotals().sessions}
            </span>
          </Show>
          <Show when={refCount() > 0}>
            <span class="rf-peek-head-tag">
              <b>refined</b>
              {refCount()}×
            </span>
          </Show>
          <Show when={props.usageStat && props.usageStat.injected.total > 0}>
            <span
              class="rf-peek-head-tag rf-peek-head-tag-injected"
              title={(() => {
                const t = props.usageStat!.injected.by_tier
                return `injected ${props.usageStat!.injected.total}× — baseline ${t.baseline} / topical ${t.topical} / recall ${t.recall}`
              })()}
            >
              <b>注入</b>
              {props.usageStat!.injected.total}×
            </span>
          </Show>
          <Show
            when={
              props.usageStat &&
              (props.usageStat.used.cited > 0 || props.usageStat.used.recalled > 0)
            }
          >
            <span
              class="rf-peek-head-tag rf-peek-head-tag-used"
              title={`used ${props.usageStat!.used.cited + props.usageStat!.used.recalled}× — cited ${props.usageStat!.used.cited} (refiner judge) / recalled ${props.usageStat!.used.recalled} (recall_experience tool)`}
            >
              <b>使用</b>
              {props.usageStat!.used.cited + props.usageStat!.used.recalled}×
            </span>
          </Show>
          <span class="rf-peek-id">
            {exp().id.slice(0, 10).toUpperCase()}
          </span>
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

      <h2 class="rf-peek-title">{exp().title}</h2>

      <div class="rf-peek-info-col rf-peek-info-col-wide">
          <section class="rf-peek-field">
            <div class="rf-peek-field-head">
              <span class="rf-peek-field-label">Abstract</span>
              <span class="rf-peek-field-hint">LLM 精炼出的核心摘要</span>
            </div>
            <div class="rf-peek-field-body rf-peek-field-lead">
              {exp().abstract}
            </div>
          </section>

          <Show when={(exp().categories ?? []).length > 0}>
            <section class="rf-peek-field rf-peek-field-inline">
              <span class="rf-peek-field-label">Tags</span>
              <div class="rf-peek-tags">
                <For each={exp().categories ?? []}>
                  {(cat) => <span class="rf-peek-tag-chip">#{cat}</span>}
                </For>
              </div>
            </section>
          </Show>

          <Show when={exp().trigger_condition}>
            <section class="rf-peek-field">
              <div class="rf-peek-field-head">
                <span class="rf-peek-field-label">Trigger</span>
                <span class="rf-peek-field-hint">
                  何时应触发（Phase 2 注入用）
                </span>
              </div>
              <div class="rf-peek-field-body rf-peek-field-muted">
                {exp().trigger_condition}
              </div>
            </section>
          </Show>

          <Show when={exp().statement}>
            <section class="rf-peek-field">
              <div class="rf-peek-field-head">
                <span class="rf-peek-field-label">Statement</span>
                <span class="rf-peek-field-hint">
                  机器可读陈述（e.g. <code>after:commit → require:lint</code>）
                </span>
              </div>
              <pre class="rf-peek-field-mono">{exp().statement}</pre>
            </section>
          </Show>

          <Show when={(exp().conflicts_with ?? []).length > 0}>
            <section class="rf-peek-field">
              <div class="rf-peek-field-head">
                <span class="rf-peek-field-label">Conflicts with</span>
              </div>
              <div class="rf-peek-related">
                <For each={exp().conflicts_with ?? []}>
                  {(id) => {
                    const c = () => relatedLookup().get(id)
                    return (
                      <Show
                        when={c()}
                        fallback={
                          <span class="rf-peek-chip rf-peek-chip-muted">
                            <b>missing</b>
                            {id.slice(0, 10)}…
                          </span>
                        }
                      >
                        <button
                          type="button"
                          class="rf-peek-related-chip rf-peek-conflict-chip"
                          data-palette={paletteFor(c()!.kind)}
                          onClick={() => props.onPickExperience(c()!.id)}
                        >
                          <span class="rf-peek-related-kind">
                            ⚠ {kindDisplay(c()!.kind)}
                          </span>
                          <span class="rf-peek-related-title">
                            {clip(c()!.title, 60)}
                          </span>
                        </button>
                      </Show>
                    )
                  }}
                </For>
              </div>
            </section>
          </Show>

          <section class="rf-peek-field">
            <div class="rf-peek-field-head">
              <span class="rf-peek-field-label">Source observations</span>
              <span class="rf-peek-field-count">
                {exp().observations.length}
              </span>
              <span class="rf-peek-field-hint">
                这些原始用户消息是 abstract 归纳的来源
              </span>
            </div>
            <Show
              when={exp().observations.length > 0}
              fallback={
                <div class="rf-peek-field-body rf-peek-field-muted">
                  尚未挂载任何 observation。
                </div>
              }
            >
              <div class="rf-peek-obs-list">
                <For
                  each={[...exp().observations].sort(
                    (a, b) => b.observed_at - a.observed_at,
                  )}
                >
                  {(obs, i) => {
                    const node = () =>
                      obs.agent_context.workflow_snapshot?.node_id
                    const isManual = () =>
                      (obs as any).source === "manual_create" ||
                      (obs as any).source === "manual_augment"
                    return (
                      <div
                        class="rf-peek-obs"
                        style={{
                          "animation-delay": `${140 + i() * 60}ms`,
                        }}
                      >
                        <div class="rf-peek-obs-head">
                          <span class="rf-peek-obs-sig">
                            {obs.id.slice(0, 6)}
                          </span>
                          <span class="rf-peek-obs-dot">·</span>
                          <span class="rf-peek-obs-time">
                            {fmtTime(obs.observed_at)}
                          </span>
                          <Show when={node()}>
                            <span class="rf-peek-chip rf-peek-chip-tight">
                              <b>节点</b>
                              {node()}
                            </span>
                          </Show>
                          <Show when={isManual()}>
                            <span class="rf-peek-chip rf-peek-chip-tight">
                              <b>来源</b>手动
                            </span>
                          </Show>
                          <span class="rf-peek-obs-actions">
                            <button
                              type="button"
                              class="rf-peek-iconbtn"
                              title="移到另一个 experience"
                              onClick={(e) => {
                                e.stopPropagation()
                                props.onAction({
                                  type: "moveObservation",
                                  experience: exp(),
                                  observation: obs,
                                })
                              }}
                            >
                              ↻
                            </button>
                            <button
                              type="button"
                              class="rf-peek-iconbtn rf-peek-iconbtn-danger"
                              title="删除该 observation"
                              onClick={(e) => {
                                e.stopPropagation()
                                props.onAction({
                                  type: "deleteObservation",
                                  experience: exp(),
                                  observation: obs,
                                })
                              }}
                            >
                              ✕
                            </button>
                          </span>
                        </div>
                        <div class="rf-peek-obs-body">
                          {clip(obs.user_text, 220)}
                        </div>
                        <a
                          class="rf-peek-obs-link"
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
                          会话 {obs.session_id.slice(0, 10)}… · 消息{" "}
                          {obs.message_id.slice(0, 10)}…
                          <span class="rf-peek-obs-link-arrow">→</span>
                        </a>
                      </div>
                    )
                  }}
                </For>
              </div>
            </Show>
          </section>

          <Show when={refCount() > 0}>
            <section class="rf-peek-field">
              <div class="rf-peek-field-head">
                <span class="rf-peek-field-label">Refinement history</span>
                <span class="rf-peek-field-count">{refCount()}</span>
                <span class="rf-peek-field-hint">
                  <Show when={refFirst()}>
                    first {fmtTime(refFirst())}
                  </Show>
                  <Show when={refLast() && refLast() !== refFirst()}>
                    <span> · last {fmtTime(refLast())}</span>
                  </Show>
                </span>
              </div>
              <div class="rf-peek-history">
                <For each={[...(exp().refinement_history ?? [])].reverse()}>
                  {(rec) => (
                    <div class="rf-peek-history-row">
                      <span class="rf-peek-history-time">
                        {fmtTime(rec.at)}
                      </span>
                      <span class="rf-peek-history-kind">
                        {rec.kind ?? "refine"}
                      </span>
                      <span class="rf-peek-history-model">
                        {rec.model ?? "—"}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </section>
          </Show>

          <Show when={exp().related_experience_ids.length > 0}>
            <section class="rf-peek-field">
              <div class="rf-peek-field-head">
                <span class="rf-peek-field-label">Related experiences</span>
              </div>
              <div class="rf-peek-related">
                <For each={exp().related_experience_ids}>
                  {(id) => {
                    const related = () => relatedLookup().get(id)
                    return (
                      <Show
                        when={related()}
                        fallback={
                          <span class="rf-peek-chip rf-peek-chip-muted">
                            <b>missing</b>
                            {id.slice(0, 10)}…
                          </span>
                        }
                      >
                        <button
                          type="button"
                          class="rf-peek-related-chip"
                          data-palette={paletteFor(related()!.kind)}
                          onClick={() => props.onPickExperience(related()!.id)}
                        >
                          <span class="rf-peek-related-kind">
                            {kindDisplay(related()!.kind)}
                          </span>
                          <span class="rf-peek-related-title">
                            {clip(related()!.title, 60)}
                          </span>
                        </button>
                      </Show>
                    )
                  }}
                </For>
              </div>
            </section>
          </Show>

          <section class="rf-peek-field rf-peek-field-meta">
            <div class="rf-peek-meta-row">
              <span class="rf-peek-meta-k">created</span>
              <span class="rf-peek-meta-v">
                {fmtTime(exp().created_at)}
              </span>
            </div>
            <div class="rf-peek-meta-row">
              <span class="rf-peek-meta-k">refined</span>
              <span class="rf-peek-meta-v">
                {fmtTime(exp().last_refined_at)}
              </span>
            </div>
            <div class="rf-peek-meta-path">{exp().path}</div>
          </section>
      </div>

      {/* Restored full action set: Add obs / Edit / Re-refine / Undo /
        * Archive / Approve / Reject / Re-queue / Delete. Earlier these
        * were cut to align with the design template's "single Refine
        * button" but the user wants the full power-user toolkit back. */}
      <div class="rf-peek-foot">
        <button
          type="button"
          class="rune-btn"
          data-size="sm"
          disabled={!!acting() || exp().archived}
          onClick={() => props.onAction({ type: "augment", experience: exp() })}
          title="追加一条 observation 并触发 re-refine"
        >
          ＋ Add obs
        </button>
        <button
          type="button"
          class="rune-btn"
          data-size="sm"
          disabled={!!acting()}
          onClick={() => props.onAction({ type: "edit", experience: exp() })}
          title="手动编辑字段（不调用 LLM）"
        >
          ✎ Edit
        </button>
        <button
          type="button"
          class="rune-btn"
          data-size="sm"
          disabled={!!acting() || exp().observations.length === 0 || exp().archived}
          onClick={() => void run("refine", () => props.onReRefine())}
          title="基于当前 observations 重新运行 refiner 模型"
        >
          {acting() === "refine" ? "⟳ Refining…" : "⟳ Re-refine"}
        </button>
        <button
          type="button"
          class="rune-btn"
          data-size="sm"
          disabled={!!acting() || !undoable()}
          onClick={() => void run("undo", () => props.onUndo())}
          title={undoable() ? "回滚到上一次快照" : "没有可回滚的快照"}
        >
          ⤺ Undo
        </button>
        <button
          type="button"
          class="rune-btn"
          data-size="sm"
          disabled={!!acting()}
          onClick={() => void run("archive", () => props.onArchiveToggle())}
          title={exp().archived ? "取消归档" : "归档（从概览中隐藏）"}
        >
          {exp().archived ? "⬒ Unarchive" : "⬓ Archive"}
        </button>
        <Show when={(exp().review_status ?? "approved") === "pending"}>
          <button
            type="button"
            class="rune-btn"
            data-size="sm"
            data-variant="primary"
            disabled={!!acting()}
            onClick={() => void run("approve", () => props.onReview("approved"))}
            title="通过审核 — 此 experience 进入正式知识库"
          >
            {acting() === "approve" ? "⟳ Approving…" : "✓ Approve"}
          </button>
          <button
            type="button"
            class="rune-btn"
            data-size="sm"
            disabled={!!acting()}
            onClick={() => void run("reject", () => props.onReview("rejected"))}
            title="拒绝 — 软删除，文件保留作审计"
          >
            {acting() === "reject" ? "⟳ Rejecting…" : "⌀ Reject"}
          </button>
        </Show>
        <Show when={(exp().review_status ?? "approved") === "rejected"}>
          <button
            type="button"
            class="rune-btn"
            data-size="sm"
            disabled={!!acting()}
            onClick={() => void run("requeue", () => props.onReview("pending"))}
            title="重新加入待审核队列"
          >
            {acting() === "requeue" ? "⟳ Re-queueing…" : "↻ Re-queue"}
          </button>
        </Show>
        <span class="rune-grow" />
        <button
          type="button"
          class="rune-btn"
          data-size="sm"
          disabled={!!acting()}
          onClick={() => props.onAction({ type: "delete", experience: exp() })}
          title="删除（保留审计）"
          style={{ color: "var(--rune-st-err)" }}
        >
          ✕ Delete
        </button>
      </div>
    </>
  )
}

/* ──────────────────────────────────────────────────────
   Experience modal — centered overlay that replaces the old
   right-hand peek aside. Handles:
     • scrim click-to-close
     • Escape key-to-close (global listener, only while mounted)
     • palette-aware card border + body-scroll lock
   ────────────────────────────────────────────────────── */

function ExperienceModal(props: {
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
  onReview: (id: string, status: ReviewStatus) => Promise<void> | void
  onToggleMergeSelect: (id: string) => void
  mergeSelected: (id: string) => boolean
  usageStat?: ExperienceUsageStat
}) {
  // Lock <body> scroll + bind Escape while open; releases on close.
  createEffect(() => {
    if (!props.experience) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose()
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = prevOverflow
    })
  })

  return (
    <Show when={props.experience}>
      {(exp) => (
        <div
          class="rf-peek-scrim"
          onClick={() => props.onClose()}
          role="presentation"
        >
          <div
            class="rf-peek-modal"
            data-palette={paletteFor(exp().kind)}
            role="dialog"
            aria-modal="true"
            aria-label={exp().title}
            onClick={(e) => e.stopPropagation()}
          >
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
              onReview={(status) => props.onReview(exp().id, status)}
              onToggleMergeSelect={props.onToggleMergeSelect}
              mergeSelected={props.mergeSelected(exp().id)}
              usageStat={props.usageStat}
            />
          </div>
        </div>
      )}
    </Show>
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
          {/* Review-status badge — surface pending items so the user can spot
              what auto-routing has admitted but not yet vetted. Approved items
              show no chip (default state), keeping the list clean. */}
          <Show when={(props.item.review_status ?? "approved") === "pending"}>
            <span
              class="rf-row-archived"
              data-review-status="pending"
              title="待审核"
              style={{ background: "var(--rf-warn, oklch(0.70 0.15 70))", color: "white" }}
            >
              pending
            </span>
          </Show>
          <Show when={props.item.review_status === "rejected"}>
            <span
              class="rf-row-archived"
              data-review-status="rejected"
              title="已拒绝"
              style={{ background: "var(--rf-bad, oklch(0.55 0.18 25))", color: "white" }}
            >
              rejected
            </span>
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
  sort: "kind" | "recent" | "newest"
  setSort: (s: "kind" | "recent" | "newest") => void
}) {
  // Tristate cycle: kind → recent → newest → kind. Each click advances by one
  // step so the user can reach any mode in at most two clicks.
  const SORT_CYCLE: Array<"kind" | "recent" | "newest"> = ["kind", "recent", "newest"]
  const SORT_LABEL: Record<"kind" | "recent" | "newest", string> = {
    kind: "按分类",
    recent: "最近修改",
    newest: "最新创建",
  }
  const SORT_TITLE: Record<"kind" | "recent" | "newest", string> = {
    kind: "按 kind 分组（内部按最近修改时间排）",
    recent: "按 last_refined_at 倒序",
    newest: "按 created_at 倒序",
  }
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
      {/* Kind chips — small fixed set (≤ 12), always visible, never scroll. */}
      <div class="rf-fbar-group rf-fbar-kinds">
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

      {/* Tag chips — variable count (can be many). Scrolls *inside* this
          container so the search bar on the right is never pushed off-screen.
          The active tag stays bound to a category filter that also flows into
          the graph view (so picking a tag highlights only that subset there). */}
      <Show when={props.categories.length > 0}>
        <span class="rf-fbar-div" />
        <div class="rf-fbar-group rf-fbar-tags">
          <span class="rf-fbar-label">标签</span>
          <div class="rf-fbar-tags-scroll">
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
        </div>
      </Show>

      {/* Search + sort pinned right; never moves off-screen no matter how many
          tags are present. */}
      <div class="rf-fbar-right">
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
          onCompositionStart={(e) => {
            ;(e.currentTarget as HTMLInputElement & { _composing?: boolean })._composing = true
          }}
          onCompositionEnd={(e) => {
            const el = e.currentTarget as HTMLInputElement & { _composing?: boolean }
            el._composing = false
            props.setQuery(el.value)
          }}
          onInput={(e) => {
            const el = e.currentTarget as HTMLInputElement & { _composing?: boolean }
            if (el._composing) return
            props.setQuery(el.value)
          }}
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
        onClick={() => {
          const idx = SORT_CYCLE.indexOf(props.sort)
          const next = SORT_CYCLE[(idx + 1) % SORT_CYCLE.length]
          props.setSort(next)
        }}
        title={SORT_TITLE[props.sort]}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" width="13" height="13">
          <path d="M4 4h9M4 8h6M4 12h3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        {SORT_LABEL[props.sort]}
      </button>
      </div>
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
   ExperienceGraphView — full-canvas topology of every
   experience wired through chain edges. Renders inline SVG
   with a radial-ish layout (grouped by kind → ring position).
   No animations, no physics — just topology.
   ────────────────────────────────────────────────────── */

const CHAIN_EDGE_STYLE: Record<
  ChainEdgeKind,
  { color: string; dash?: string; label: string; code: ChainEdgeKind; desc: string }
> = {
  requires: { color: "#4f46e5", label: "先决条件", code: "requires", desc: "强依赖 · DAG · 必须先完成对端" },
  refines: { color: "#0ea5e9", dash: "4,3", label: "细化", code: "refines", desc: "本条是对端的特化/补充" },
  supports: { color: "#10b981", dash: "2,3", label: "支持", code: "supports", desc: "本条为对端提供支持证据" },
  contradicts: { color: "#ef4444", dash: "6,3", label: "冲突", code: "contradicts", desc: "本条与对端直接矛盾" },
  see_also: { color: "#9ca3af", dash: "1,4", label: "相关", code: "see_also", desc: "同话题可参考，方向弱" },
}

/** 边语义 → 中文短语模板，用于组合悬浮卡片的"连环指引"。
 *  `{self}` = 当前悬浮的 experience 标题；`{other}` = 关联 experience 标题。
 *  `out` 对应 from=self→to=other 的方向；`in` 对应 from=other→to=self。 */
const CHAIN_EDGE_PHRASE: Record<
  ChainEdgeKind,
  { out: string; in: string }
> = {
  requires: {
    out: "先完成「{other}」，再执行「{self}」",
    in: "「{other}」依赖本条，需先确保「{self}」成立",
  },
  refines: {
    out: "「{self}」是对「{other}」的细化/特化",
    in: "「{other}」对本条做了进一步细化",
  },
  supports: {
    out: "「{self}」可作为「{other}」的佐证",
    in: "「{other}」为本条提供支持证据",
  },
  contradicts: {
    out: "注意：「{self}」与「{other}」存在冲突",
    in: "注意：「{other}」与本条存在冲突",
  },
  see_also: {
    out: "同话题可参考「{other}」",
    in: "同话题可参考「{other}」",
  },
}

type GraphLayoutNode = {
  id: string
  exp: ChainGraphExperienceLite
  x: number
  y: number
}


function computeGraphLayout(
  experiences: ChainGraphExperienceLite[],
  opts: { width: number; height: number },
): Map<string, GraphLayoutNode> {
  const { width, height } = opts
  const cx = width / 2
  const cy = height / 2
  // Group by kind → each kind becomes an angular sector, nodes distributed
  // across concentric rings inside that sector.
  const groups = new Map<Kind, ChainGraphExperienceLite[]>()
  for (const e of experiences) {
    const arr = groups.get(e.kind) ?? []
    arr.push(e)
    groups.set(e.kind, arr)
  }
  const kinds = [...groups.keys()]
  const kindCount = Math.max(kinds.length, 1)
  const out = new Map<string, GraphLayoutNode>()
  const rMin = Math.min(width, height) * 0.14
  const rMax = Math.min(width, height) * 0.44

  kinds.forEach((kind, ki) => {
    const list = (groups.get(kind) ?? [])
      .slice()
      .sort(
        (a, b) => (b.last_refined_at ?? 0) - (a.last_refined_at ?? 0),
      )
    const sectorStart = (ki / kindCount) * Math.PI * 2
    const sectorEnd = ((ki + 1) / kindCount) * Math.PI * 2
    const count = list.length
    list.forEach((e, i) => {
      // Spread within sector. For single-node sectors center on midangle.
      const t = count === 1 ? 0.5 : i / (count - 1)
      const angle = sectorStart + (sectorEnd - sectorStart) * (0.1 + 0.8 * t)
      // Push older ones outward (toward rMax); newest stays mid-ring.
      const rFactor = count === 1 ? 0.55 : 0.35 + 0.55 * t
      const r = rMin + (rMax - rMin) * rFactor
      out.set(e.id, {
        id: e.id,
        exp: e,
        x: cx + Math.cos(angle) * r,
        y: cy + Math.sin(angle) * r,
      })
    })
  })
  return out
}

/**
 * Force-directed (Obsidian-like) layout. Seeds nodes on a kind-grouped
 * radial ring, then runs a small fixed-iteration physics simulation:
 *
 * - Repulsion: every pair of nodes pushes apart with `k_rep / d^2`
 * - Spring: every connected pair pulls together toward `targetLen`
 * - Centering: a weak pull toward the canvas center prevents drift
 *
 * The simulation is deterministic (no randomness) and bounded — we cap it at
 * 220 iterations with cooling, which is fast enough that we don't need a
 * worker for graphs up to a few hundred nodes. Returns positions in canvas
 * coordinates, scaled to fit a comfortable margin.
 */
function computeGraphLayoutForce(
  experiences: ChainGraphExperienceLite[],
  edges: ChainGraphEdge[],
  opts: { width: number; height: number },
): Map<string, GraphLayoutNode> {
  const { width, height } = opts
  const cx = width / 2
  const cy = height / 2
  const out = new Map<string, GraphLayoutNode>()
  if (experiences.length === 0) return out

  // 1. Seed positions on a kind-grouped radial ring.
  const seed = computeGraphLayout(experiences, opts)

  // Estimate the rendered label box for each title. Mirrors the renderer:
  // - Title is clipped to 22 chars
  // - Font is 14px medium, label sits to the right of the node circle (x=15)
  // - Chinese / wide CJK ≈ 14px/char; ASCII ≈ 7.5px/char
  // The bbox we use for collision is anchored at the node center and extends
  // RIGHT by `labelW + leftOffset + tail` and HALF-HEIGHT up/down by 11px.
  // Slight half-pad on the LEFT covers the node disc itself.
  const LABEL_OFFSET_X = 15
  const LABEL_TAIL = 6
  const LABEL_HALF_H = 11
  const NODE_HALF_H = 11
  const measureLabelWidth = (title: string) => {
    const s = title.length > 22 ? title.slice(0, 22) : title
    let w = 0
    for (const ch of s) {
      w += /[一-鿿　-〿＀-￯]/.test(ch) ? 14 : 7.5
    }
    return Math.max(w, 28)
  }

  type Body = {
    id: string
    exp: ChainGraphExperienceLite
    x: number
    y: number
    vx: number
    vy: number
    /** Half-width of the personal-space ellipse, measured from the node
     *  CENTER. Includes the dot offset, label width, and a small tail. The
     *  label only extends rightward, but for the physics pass we treat it
     *  symmetrically — labels will be untangled in a final bbox-collision
     *  pass that knows about the right-skew. */
    halfW: number
    halfH: number
    labelW: number
  }
  const bodies: Body[] = []
  const indexOf = new Map<string, number>()
  for (const e of experiences) {
    const s = seed.get(e.id)
    if (!s) continue
    indexOf.set(e.id, bodies.length)
    const lw = measureLabelWidth(e.title)
    bodies.push({
      id: e.id,
      exp: e,
      x: s.x,
      y: s.y,
      vx: 0,
      vy: 0,
      labelW: lw,
      halfW: 0.5 * (LABEL_OFFSET_X + lw + LABEL_TAIL) + 6,
      halfH: Math.max(NODE_HALF_H, LABEL_HALF_H) + 4,
    })
  }
  if (bodies.length === 0) return out

  const n = bodies.length
  // Tuning: bigger graphs need more space per node + a longer spring. The
  // previous settings (targetLen×0.85, kRep×1.6, RELAX_ITERS=60) routinely
  // let Chinese labels overlap on 30+ node graphs because:
  //   - targetLen was derived from the *container* area, but Chinese labels
  //     can be 200+ px wide while the container's per-node budget was
  //     ~100 px → labels physically can't fit at scale 1.
  //   - the fit-to-canvas pass at the bottom then scaled positions DOWN
  //     (labels stayed at fixed font size in viewBox coords) → overlap
  //     re-introduced after relax already cleaned it up.
  //
  // New approach: compute the layout in a *virtual* canvas big enough to
  // accommodate the average label width × node count, never down-scale at
  // the end, and let the existing pan/zoom UI handle initial fit.
  //
  // Tuning history:
  //   - First fix used 1.3 / 0.95 / 2.2 — labels stopped overlapping but
  //     the graph felt *too* spread out (user feedback "节点距离太大了").
  //   - Tightened to 0.7 / 0.7 / 1.3 below: labels still don't overlap
  //     because the relax pass cleans up residual cases, but neighbouring
  //     nodes sit ~30% closer so the radial layout feels compact again.
  const avgLabelW = bodies.reduce((s, b) => s + b.labelW, 0) / Math.max(n, 1)
  const perNodeArea = (avgLabelW + LABEL_OFFSET_X + LABEL_TAIL + 24) * (LABEL_HALF_H * 2 + 24) * 0.7
  const virtualArea = Math.max(width * height * 0.85, perNodeArea * n)
  const targetLen = Math.sqrt(virtualArea / Math.max(n, 1)) * 0.7
  const kRep = targetLen * targetLen * 1.3
  const kSpring = 0.045
  const damping = 0.82
  const maxStep = 22
  const iterations = n < 20 ? 220 : n < 80 ? 320 : 420
  const centerPull = 0.002

  const adj: Array<[number, number]> = []
  for (const e of edges) {
    const i = indexOf.get(e.from)
    const j = indexOf.get(e.to)
    if (i === undefined || j === undefined) continue
    if (i === j) continue
    adj.push([i, j])
  }

  for (let iter = 0; iter < iterations; iter++) {
    // Cooling factor — lets the system settle by the end.
    const cool = 1 - iter / iterations
    // Repulsion (O(n²)).
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = bodies[i]
        const b = bodies[j]
        let dx = a.x - b.x
        let dy = a.y - b.y
        let d2 = dx * dx + dy * dy
        if (d2 < 0.0001) {
          // Coincident nodes — nudge apart deterministically.
          dx = (i - j) * 0.5 + 0.01
          dy = (j - i) * 0.5 + 0.01
          d2 = dx * dx + dy * dy
        }
        const d = Math.sqrt(d2)
        const f = kRep / d2
        const fx = (dx / d) * f
        const fy = (dy / d) * f
        a.vx += fx
        a.vy += fy
        b.vx -= fx
        b.vy -= fy
      }
    }
    // Springs along edges.
    for (const [i, j] of adj) {
      const a = bodies[i]
      const b = bodies[j]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01
      const delta = d - targetLen
      const f = kSpring * delta
      const fx = (dx / d) * f
      const fy = (dy / d) * f
      a.vx += fx
      a.vy += fy
      b.vx -= fx
      b.vy -= fy
    }
    // Center pull + integrate.
    for (const body of bodies) {
      body.vx += (cx - body.x) * centerPull
      body.vy += (cy - body.y) * centerPull
      body.vx *= damping
      body.vy *= damping
      let step = Math.sqrt(body.vx * body.vx + body.vy * body.vy)
      if (step > maxStep) {
        body.vx = (body.vx / step) * maxStep
        body.vy = (body.vy / step) * maxStep
        step = maxStep
      }
      body.x += body.vx * cool
      body.y += body.vy * cool
    }
  }

  // ── Label-collision relaxation pass ──────────────────────────────────
  // Force-directed alone treats nodes as point-masses, so labels (which can
  // be ~200 px wide for long Chinese titles) frequently end up overlapping
  // each other even when the dots themselves are well-spaced. Run a few
  // iterations of bbox-overlap-relaxation: for every pair whose label
  // bounding boxes overlap, push them apart along the axis of *minimum*
  // overlap. Vertical offsets are usually fine (labels don't grow downward),
  // so most fixes resolve as small Y-shifts instead of jittering X.
  // Labels render to the right of the node circle; bbox left edge is the
  // node center, right edge is `LABEL_OFFSET_X + labelW + LABEL_TAIL`.
  const labelBox = (b: Body) => ({
    x1: b.x - 4,
    x2: b.x + LABEL_OFFSET_X + b.labelW + LABEL_TAIL,
    y1: b.y - LABEL_HALF_H - 2,
    y2: b.y + LABEL_HALF_H + 2,
  })
  // Bumped from 60 → 200 — dense graphs need more sweeps because each push
  // can create a fresh overlap with a third node. We exit early when no
  // movement occurs in an iteration, so the cost on sparse graphs is low.
  const RELAX_ITERS = 200
  for (let iter = 0; iter < RELAX_ITERS; iter++) {
    let movedAny = false
    for (let i = 0; i < n; i++) {
      const A = labelBox(bodies[i])
      for (let j = i + 1; j < n; j++) {
        const B = labelBox(bodies[j])
        const ox = Math.min(A.x2, B.x2) - Math.max(A.x1, B.x1)
        const oy = Math.min(A.y2, B.y2) - Math.max(A.y1, B.y1)
        if (ox <= 0 || oy <= 0) continue
        // Push apart along the axis of smaller overlap (cheaper to fix).
        // Distribute the push 50/50 so neither node gets pinned.
        if (oy <= ox) {
          const push = oy * 0.5 + 0.5
          if (bodies[i].y < bodies[j].y) {
            bodies[i].y -= push
            bodies[j].y += push
          } else {
            bodies[i].y += push
            bodies[j].y -= push
          }
        } else {
          const push = ox * 0.5 + 0.5
          // Note: labels grow rightward, so X-pushes prefer to move the
          // RIGHTMOST node further right, which usually clears overlaps
          // without dragging the left node into something else.
          if (bodies[i].x < bodies[j].x) {
            bodies[i].x -= push * 0.6
            bodies[j].x += push * 1.4
          } else {
            bodies[i].x += push * 1.4
            bodies[j].x -= push * 0.6
          }
        }
        movedAny = true
      }
    }
    if (!movedAny) break
  }

  // Translate-only fit: include label extents in the bounding box so the
  // rightmost label doesn't get clipped by the canvas edge. We deliberately
  // do NOT down-scale positions when the bbox exceeds the container —
  // labels render at a fixed font size in viewBox px, so position-scaling
  // would re-introduce label overlap that the relax pass just removed.
  // Instead, the bodies extend beyond the viewBox; the consumer computes
  // an initial fit-zoom (bounded below by ~0.4) so the user sees the whole
  // graph at first paint and can scroll/zoom in to read individual labels.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const b of bodies) {
    const lx2 = b.x + LABEL_OFFSET_X + b.labelW + LABEL_TAIL
    if (b.x < minX) minX = b.x
    if (b.y - LABEL_HALF_H < minY) minY = b.y - LABEL_HALF_H
    if (lx2 > maxX) maxX = lx2
    if (b.y + LABEL_HALF_H > maxY) maxY = b.y + LABEL_HALF_H
  }
  const bw = Math.max(maxX - minX, 1)
  const bh = Math.max(maxY - minY, 1)
  // Centre the bbox at the canvas centre so the initial pan=(0,0) view
  // shows the graph centred (after the consumer applies its fit-zoom).
  const ox = cx - (minX + bw / 2)
  const oy = cy - (minY + bh / 2)

  for (const b of bodies) {
    out.set(b.id, {
      id: b.id,
      exp: b.exp,
      x: b.x + ox,
      y: b.y + oy,
    })
  }
  return out
}

/* Refiner activity log browser. Shows every refiner run grouped by
 * session — including queries that the refiner classed as noise or
 * dropped (those that DIDN'T crystallise into an experience), so the
 * user can audit what the refiner agent decided. Click a session row
 * on the left, click a run on the right, see all per-stage LLM calls
 * (route / refine) with their prompts and responses. */
function RefinerLogsModal(props: {
  entries: RefinerLogEntry[]
  loading: boolean
  onClose: () => void
  onReload: () => void
}) {
  const [selectedSession, setSelectedSession] = createSignal<string | undefined>()
  const [selectedRunId, setSelectedRunId] = createSignal<string | undefined>()
  const [filterMode, setFilterMode] = createSignal<"all" | "no_exp">("all")
  const [callOpen, setCallOpen] = createSignal<Set<string>>(new Set())

  // Group runs by session — most-recent activity first per session.
  // PURE MEMO — does not write to any signal it reads (writing inside
  // createMemo while also reading the same signal makes Solid log a
  // reactive-loop warning and on some Solid versions ends up in a
  // tight re-eval cycle that visually "freezes" the modal — that was
  // the actual cause of the user's "卡住" report).
  const sessions = createMemo(() => {
    const map = new Map<
      string,
      { id: string; runs: RefinerLogEntry[]; latest: number; produced: number; failed: number }
    >()
    for (const e of props.entries) {
      const sid = e.session_id ?? "manual"
      const existing = map.get(sid)
      if (existing) {
        existing.runs.push(e)
        if (e.created_at > existing.latest) existing.latest = e.created_at
        if (e.outcome === "new_exp" || e.outcome === "update_exp") existing.produced++
        if (e.outcome === "error" || e.outcome === "noise" || e.outcome === "dropped") existing.failed++
      } else {
        map.set(sid, {
          id: sid,
          runs: [e],
          latest: e.created_at,
          produced: e.outcome === "new_exp" || e.outcome === "update_exp" ? 1 : 0,
          failed:
            e.outcome === "error" || e.outcome === "noise" || e.outcome === "dropped" ? 1 : 0,
        })
      }
    }
    return [...map.values()].sort((a, b) => b.latest - a.latest)
  })

  // Auto-select the top session whenever entries load and nothing is
  // chosen yet. Effect, NOT memo — this is a side effect.
  createEffect(() => {
    const arr = sessions()
    if (!selectedSession() && arr.length > 0) setSelectedSession(arr[0].id)
  })

  // ESC closes the modal. Without this, the only way out was clicking
  // the × button or the scrim background, which the user couldn't find
  // when the empty-state "stuck" the modal in its initial layout.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        props.onClose()
      }
    }
    window.addEventListener("keydown", onKey, true)
    onCleanup(() => window.removeEventListener("keydown", onKey, true))
  })

  const visibleRuns = createMemo(() => {
    const sid = selectedSession()
    if (!sid) return []
    const session = sessions().find((s) => s.id === sid)
    if (!session) return []
    const runs = [...session.runs].sort((a, b) => b.created_at - a.created_at)
    if (filterMode() === "no_exp") {
      return runs.filter((r) =>
        r.outcome === "noise" || r.outcome === "dropped" || r.outcome === "error",
      )
    }
    return runs
  })

  const selectedRun = createMemo(() => {
    const id = selectedRunId()
    if (id) {
      const found = visibleRuns().find((r) => r.id === id)
      if (found) return found
    }
    return visibleRuns()[0]
  })

  const fmtTimeFull = (t: number) => {
    const d = new Date(t)
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
      d.getHours(),
    )}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  }

  const outcomeLabel = (o: RefinerLogEntry["outcome"]) => {
    switch (o) {
      case "new_exp":
        return "新建 exp"
      case "update_exp":
        return "更新 exp"
      case "edge_only":
        return "edge only"
      case "noise":
        return "noise"
      case "dropped":
        return "dropped"
      case "error":
        return "error"
    }
  }

  const callKey = (run: RefinerLogEntry, idx: number) => `${run.id}:${idx}`
  const isCallOpen = (k: string) => callOpen().has(k)
  const toggleCall = (k: string) => {
    const next = new Set(callOpen())
    if (next.has(k)) next.delete(k)
    else next.add(k)
    setCallOpen(next)
  }

  return (
    <Portal>
      <div class="rf-logs-scrim" onClick={props.onClose} role="presentation">
        <div
          class="rf-logs-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Refiner activity log"
          onClick={(ev) => ev.stopPropagation()}
        >
          <div class="rf-logs-hd">
            <span class="rf-logs-title">Refiner · activity log</span>
            <span class="rf-logs-meta">
              {props.entries.length} runs · {sessions().length} sessions
            </span>
            <span style={{ flex: 1 }} />
            <div class="rf-logs-filter" role="group">
              <button
                type="button"
                data-active={filterMode() === "all"}
                onClick={() => setFilterMode("all")}
              >
                全部
              </button>
              <button
                type="button"
                data-active={filterMode() === "no_exp"}
                onClick={() => setFilterMode("no_exp")}
                title="仅显示没有沉淀为 experience 的 query（noise/dropped/error）"
              >
                未沉淀
              </button>
            </div>
            <button
              type="button"
              class="rune-btn"
              data-size="xs"
              onClick={props.onReload}
              disabled={props.loading}
              title="重新拉取日志"
            >
              {props.loading ? "刷新中…" : "↻ 刷新"}
            </button>
            <button
              type="button"
              class="rf-logs-close"
              aria-label="Close"
              onClick={props.onClose}
            >
              ×
            </button>
          </div>

          <div class="rf-logs-body">
            <Show
              when={!props.loading && sessions().length > 0}
              fallback={
                <div class="rf-logs-empty">
                  {props.loading
                    ? "加载中…"
                    : "暂无 refiner 日志。新的 refiner 运行会写入这里，包括没有沉淀的 query。"}
                </div>
              }
            >
              <aside class="rf-logs-sessions">
                <div class="rf-logs-pane-hd">Sessions</div>
                <For each={sessions()}>
                  {(s) => (
                    <button
                      type="button"
                      class="rf-logs-session-row"
                      data-active={s.id === selectedSession()}
                      onClick={() => {
                        setSelectedSession(s.id)
                        setSelectedRunId(undefined)
                      }}
                      title={s.id}
                    >
                      <div class="rf-logs-session-row-l">
                        <div class="rf-logs-session-id">
                          {s.id === "manual" ? "manual / 手动新建" : s.id.slice(0, 12)}
                        </div>
                        <div class="rf-logs-session-meta">
                          {s.runs.length} runs · {fmtTime(s.latest)}
                        </div>
                      </div>
                      <div class="rf-logs-session-stats">
                        <Show when={s.produced > 0}>
                          <span class="rf-logs-stat is-ok">+{s.produced}</span>
                        </Show>
                        <Show when={s.failed > 0}>
                          <span class="rf-logs-stat is-warn">–{s.failed}</span>
                        </Show>
                      </div>
                    </button>
                  )}
                </For>
              </aside>

              <section class="rf-logs-runs">
                <div class="rf-logs-pane-hd">
                  Runs
                  <span style={{ "margin-left": "auto", color: "var(--rune-fg-faint)" }}>
                    {visibleRuns().length}
                  </span>
                </div>
                <Show
                  when={visibleRuns().length > 0}
                  fallback={
                    <div class="rf-logs-empty">该 session 没有匹配筛选条件的 run。</div>
                  }
                >
                  <For each={visibleRuns()}>
                    {(r) => (
                      <button
                        type="button"
                        class="rf-logs-run-row"
                        data-active={r.id === selectedRun()?.id}
                        data-outcome={r.outcome}
                        onClick={() => setSelectedRunId(r.id)}
                      >
                        <div class="rf-logs-run-row-head">
                          <span class="rf-logs-run-time">{fmtTime(r.created_at)}</span>
                          <span class="rf-logs-run-trigger">{r.trigger}</span>
                          <span style={{ flex: 1 }} />
                          <span class={`rf-logs-outcome rf-logs-outcome-${r.outcome}`}>
                            {outcomeLabel(r.outcome)}
                          </span>
                          <span class="rf-logs-run-ms">{r.duration_ms}ms</span>
                        </div>
                        <div class="rf-logs-run-text">
                          {r.user_text.length > 140
                            ? r.user_text.slice(0, 140) + "…"
                            : r.user_text}
                        </div>
                      </button>
                    )}
                  </For>
                </Show>
              </section>

              <section class="rf-logs-detail">
                <Show
                  when={selectedRun()}
                  fallback={<div class="rf-logs-empty">选择一个 run 查看详情。</div>}
                >
                  {(run) => (
                    <>
                      <div class="rf-logs-pane-hd">
                        Run {run().id.slice(0, 10)}
                        <span style={{ "margin-left": "12px", color: "var(--rune-fg-faint)" }}>
                          {fmtTimeFull(run().created_at)}
                        </span>
                      </div>
                      <div class="rf-logs-detail-body">
                        <section class="rf-logs-sec">
                          <h4 class="rf-logs-sec-hd">User text</h4>
                          <pre class="rf-logs-pre">{run().user_text}</pre>
                        </section>
                        <section class="rf-logs-sec">
                          <h4 class="rf-logs-sec-hd">Outcome</h4>
                          <div class="rf-logs-outcome-box">
                            <span
                              class={`rf-logs-outcome rf-logs-outcome-${run().outcome}`}
                            >
                              {outcomeLabel(run().outcome)}
                            </span>
                            <Show when={run().reason}>
                              <span class="rf-logs-outcome-reason">{run().reason}</span>
                            </Show>
                            <Show when={run().experience_ids.length > 0}>
                              <span class="rf-logs-outcome-reason">
                                touched: {run().experience_ids.join(", ")}
                              </span>
                            </Show>
                          </div>
                        </section>
                        <section class="rf-logs-sec">
                          <h4 class="rf-logs-sec-hd">
                            LLM calls ({run().llm_calls.length})
                          </h4>
                          <Show
                            when={run().llm_calls.length > 0}
                            fallback={
                              <div class="rf-logs-empty">
                                这个 run 没有触发 LLM（可能直接走了 fallback）。
                              </div>
                            }
                          >
                            <For each={run().llm_calls}>
                              {(call, i) => {
                                const k = callKey(run(), i())
                                return (
                                  <div class="rf-logs-call">
                                    <button
                                      type="button"
                                      class="rf-logs-call-hd"
                                      onClick={() => toggleCall(k)}
                                    >
                                      <span class="rf-logs-call-stage">{call.stage}</span>
                                      <Show when={call.provider_id || call.model_id}>
                                        <span class="rf-logs-call-model rune-mono">
                                          {call.provider_id}/{call.model_id}
                                        </span>
                                      </Show>
                                      <span style={{ flex: 1 }} />
                                      <Show when={call.error}>
                                        <span class="rf-logs-call-err">⚠</span>
                                      </Show>
                                      <span class="rf-logs-call-ms">{call.duration_ms}ms</span>
                                      <span class="rf-logs-call-caret">
                                        {isCallOpen(k) ? "▾" : "▸"}
                                      </span>
                                    </button>
                                    <Show when={isCallOpen(k)}>
                                      <div class="rf-logs-call-body">
                                        <Show when={call.error}>
                                          <div class="rf-logs-sec-err">
                                            <h5 class="rf-logs-sec-hd">Error</h5>
                                            <pre class="rf-logs-pre">{call.error}</pre>
                                          </div>
                                        </Show>
                                        <Show when={call.system_prompt}>
                                          <div>
                                            <h5 class="rf-logs-sec-hd">System</h5>
                                            <div class="rf-logs-md">
                                              <Markdown text={call.system_prompt!} />
                                            </div>
                                          </div>
                                        </Show>
                                        <div>
                                          <h5 class="rf-logs-sec-hd">User prompt</h5>
                                          <div class="rf-logs-md">
                                            <Markdown text={call.user_prompt} />
                                          </div>
                                        </div>
                                        <Show when={call.reasoning_text}>
                                          <div>
                                            <h5 class="rf-logs-sec-hd">Reasoning</h5>
                                            <div class="rf-logs-md rf-logs-md-reasoning">
                                              <Markdown text={call.reasoning_text!} />
                                            </div>
                                          </div>
                                        </Show>
                                        <Show when={call.response_text}>
                                          <div>
                                            <h5 class="rf-logs-sec-hd">Response</h5>
                                            <div class="rf-logs-md">
                                              <Markdown text={call.response_text!} />
                                            </div>
                                          </div>
                                        </Show>
                                        <Show when={call.structured_output !== undefined}>
                                          <div>
                                            <h5 class="rf-logs-sec-hd">Structured output</h5>
                                            <pre class="rf-logs-pre">
                                              {JSON.stringify(call.structured_output, null, 2)}
                                            </pre>
                                          </div>
                                        </Show>
                                      </div>
                                    </Show>
                                  </div>
                                )
                              }}
                            </For>
                          </Show>
                        </section>
                      </div>
                    </>
                  )}
                </Show>
              </section>
            </Show>
          </div>
        </div>
      </div>
    </Portal>
  )
}

function pad2(n: number) {
  return n < 10 ? "0" + n : String(n)
}

function ExperienceGraphView(props: {
  data?: ChainGraphResponse
  loading?: boolean
  onPick: (id: string) => void
  activeKind?: Kind
  /** Category filter (e.g. "embedded-system"). When set, only experiences
   *  whose `categories` includes this slug are rendered. Edges are kept iff
   *  both endpoints survive the filter — orphan edges would mislead. */
  activeCategory?: string
  /** Tag filter — same shape as `activeCategory` (matches against
   *  `categories[]`), but driven by clicking a #tag chip on a list card.
   *  In the unified shell `activeCategory` is never set (legacy filterbar
   *  is hidden), so this is the actual filter the user reaches. */
  activeTag?: string
  activeEdgeKinds: Set<ChainEdgeKind>
  toggleEdgeKind: (k: ChainEdgeKind) => void
  includeArchived: boolean
}) {
  let containerRef: HTMLDivElement | undefined
  const [size, setSize] = createSignal({ w: 960, h: 640 })
  onMount(() => {
    if (!containerRef) return
    const obs = new ResizeObserver(() => {
      const rect = containerRef!.getBoundingClientRect()
      setSize({ w: Math.max(320, rect.width), h: Math.max(240, rect.height) })
    })
    obs.observe(containerRef)
    onCleanup(() => obs.disconnect())
  })

  const filteredExps = createMemo(() => {
    const src = props.data?.experiences ?? []
    const kind = props.activeKind
    const cat = props.activeCategory
    const tag = props.activeTag
    return src.filter((e) => {
      if (!props.includeArchived && e.archived) return false
      if (kind && e.kind !== kind) return false
      if (cat && !(e.categories ?? []).includes(cat)) return false
      if (tag && !(e.categories ?? []).includes(tag)) return false
      return true
    })
  })

  // Force-directed star/Obsidian-style layout. Replaces the previous ELK
  // (rectangular layered) pass. The simulation seeds nodes on a radial-by-
  // kind ring (so first paint already looks star-shaped), then runs N
  // iterations of repulsion + spring to spread overlapping clusters and pull
  // related nodes together. Re-runs only when (nodes, edges, canvas size)
  // actually change identity — polling is short-circuited upstream by
  // stableFetcher so the simulation is rarely recomputed.
  const layout = createMemo<Map<string, GraphLayoutNode>>(() => {
    const s = size()
    return computeGraphLayoutForce(
      filteredExps(),
      props.data?.edges ?? [],
      { width: s.w, height: s.h },
    )
  })

  const visibleEdges = createMemo(() => {
    const nodes = layout()
    const kinds = props.activeEdgeKinds
    return (props.data?.edges ?? []).filter(
      (e) => nodes.has(e.from) && nodes.has(e.to) && kinds.has(e.kind),
    )
  })

  const stats = createMemo(() => ({
    nodes: filteredExps().length,
    edges: visibleEdges().length,
  }))

  const [hovered, setHovered] = createSignal<string | null>(null)

  // ── Pan / zoom state ───────────────────────────────────────────────────
  // The graph SVG renders in viewBox coordinates. We apply a single
  // transform `translate(pan) scale(zoom)` to a wrapping <g> so all nodes,
  // edges and the hover hit-targets pan together.
  // Why not viewBox? Because that changes coords on the fly and complicates
  // hover-card positioning. A single CTM is simpler and lets us re-use the
  // same screen→content mapping the hovercard already does.
  const [zoom, setZoom] = createSignal(1)
  const [pan, setPan] = createSignal({ x: 0, y: 0 })
  // Whether the user has manually panned/zoomed since the last layout
  // change. While false, layout updates re-fit the view automatically;
  // once the user interacts we stop overwriting their viewport.
  let userMovedView = false

  // Compute the bbox of all body positions (already includes label extents
  // via the layout's fit-translation). Returns null if empty.
  const layoutBBox = createMemo(() => {
    const m = layout()
    if (m.size === 0) return null
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const node of m.values()) {
      const lx2 = node.x + 15 + 6 + 200 // approx label extent (right-skewed)
      if (node.x < minX) minX = node.x
      if (node.y - 11 < minY) minY = node.y - 11
      if (lx2 > maxX) maxX = lx2
      if (node.y + 11 > maxY) maxY = node.y + 11
    }
    return { minX, minY, maxX, maxY }
  })

  // Auto fit-zoom: the layout function no longer down-scales positions to
  // the canvas (would defeat label-overlap relaxation), so we compute an
  // initial zoom here that fits the whole graph in the viewport. Bounded
  // below by 0.4 so users can still read labels at first paint; they can
  // zoom in further. Re-fits on layout change unless the user has panned.
  createEffect(() => {
    const bb = layoutBBox()
    const s = size()
    if (!bb || userMovedView) return
    const bw = Math.max(bb.maxX - bb.minX, 1)
    const bh = Math.max(bb.maxY - bb.minY, 1)
    const margin = 32
    const sx = (s.w - 2 * margin) / bw
    const sy = (s.h - 2 * margin) / bh
    const z = Math.max(0.4, Math.min(1, Math.min(sx, sy)))
    setZoom(z)
    // Centre the bbox in the viewport at the new zoom.
    const cx = (bb.minX + bb.maxX) / 2
    const cy = (bb.minY + bb.maxY) / 2
    setPan({ x: s.w / 2 - cx * z, y: s.h / 2 - cy * z })
  })
  let svgRef: SVGSVGElement | undefined
  let dragState: { startX: number; startY: number; baseX: number; baseY: number } | null = null

  const onMouseDown = (e: MouseEvent) => {
    // Only left-button drag, and only when the click started on the SVG
    // background — never steal a node's onClick.
    if (e.button !== 0) return
    const target = e.target as Element | null
    if (target?.closest(".rf-graph-node")) return
    e.preventDefault()
    const p = pan()
    dragState = { startX: e.clientX, startY: e.clientY, baseX: p.x, baseY: p.y }
  }
  const onMouseMove = (e: MouseEvent) => {
    if (!dragState) return
    userMovedView = true
    setPan({
      x: dragState.baseX + (e.clientX - dragState.startX),
      y: dragState.baseY + (e.clientY - dragState.startY),
    })
  }
  const onMouseUp = () => {
    dragState = null
  }
  const onWheel = (e: WheelEvent) => {
    if (!svgRef) return
    e.preventDefault()
    userMovedView = true
    const rect = svgRef.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    const z = zoom()
    const factor = Math.exp(-e.deltaY * 0.0018)
    const nz = Math.max(0.3, Math.min(3.5, z * factor))
    // Zoom around the cursor: keep the content point under the cursor in place.
    const p = pan()
    const cx = (px - p.x) / z
    const cy = (py - p.y) / z
    setZoom(nz)
    setPan({ x: px - cx * nz, y: py - cy * nz })
  }
  // Reset view → re-arm the auto-fit effect so it re-centres on the next
  // layout / size change (and immediately, via the createEffect rerun).
  const resetView = () => {
    userMovedView = false
    // Trigger the auto-fit effect by reading layoutBBox(); it will set
    // zoom + pan based on the current bbox.
    const bb = layoutBBox()
    const s = size()
    if (!bb) {
      setZoom(1)
      setPan({ x: 0, y: 0 })
      return
    }
    const bw = Math.max(bb.maxX - bb.minX, 1)
    const bh = Math.max(bb.maxY - bb.minY, 1)
    const margin = 32
    const sx = (s.w - 2 * margin) / bw
    const sy = (s.h - 2 * margin) / bh
    const z = Math.max(0.4, Math.min(1, Math.min(sx, sy)))
    setZoom(z)
    const cx = (bb.minX + bb.maxX) / 2
    const cy = (bb.minY + bb.maxY) / 2
    setPan({ x: s.w / 2 - cx * z, y: s.h / 2 - cy * z })
  }

  onMount(() => {
    if (typeof window === "undefined") return
    window.addEventListener("mousemove", onMouseMove)
    window.addEventListener("mouseup", onMouseUp)
    onCleanup(() => {
      window.removeEventListener("mousemove", onMouseMove)
      window.removeEventListener("mouseup", onMouseUp)
    })
  })

  // When a node is hovered, compose a Chinese "guidance card" by walking
  // every outgoing/incoming edge and rendering it via CHAIN_EDGE_PHRASE.
  // Edges hidden by the legend toggles are excluded — the card only composes
  // what the user is currently looking at.
  type HoverCardLine = {
    edgeID: string
    code: ChainEdgeKind
    label: string
    color: string
    text: string
    otherID: string
  }
  type HoverCard = {
    exp: ChainGraphExperienceLite
    x: number
    y: number
    outgoing: HoverCardLine[]
    incoming: HoverCardLine[]
  }
  const hoverCard = createMemo<HoverCard | null>(() => {
    const id = hovered()
    if (!id) return null
    const node = layout().get(id)
    if (!node) return null
    const exp = node.exp
    const expTitle = exp.title
    const expByID = new Map<string, ChainGraphExperienceLite>()
    for (const e of props.data?.experiences ?? []) expByID.set(e.id, e)
    const buildLine = (edge: ChainGraphEdge, role: "out" | "in"): HoverCardLine | null => {
      const style = CHAIN_EDGE_STYLE[edge.kind]
      if (!style) return null
      const otherID = role === "out" ? edge.to : edge.from
      const other = expByID.get(otherID)
      if (!other) return null
      const template = CHAIN_EDGE_PHRASE[edge.kind][role]
      const text = template
        .replaceAll("{self}", expTitle)
        .replaceAll("{other}", other.title)
      return {
        edgeID: edge.id,
        code: edge.kind,
        label: style.label,
        color: style.color,
        text,
        otherID,
      }
    }
    const outgoing: HoverCardLine[] = []
    const incoming: HoverCardLine[] = []
    for (const e of visibleEdges()) {
      if (e.from === id) {
        const line = buildLine(e, "out")
        if (line) outgoing.push(line)
      } else if (e.to === id) {
        const line = buildLine(e, "in")
        if (line) incoming.push(line)
      }
    }
    return { exp, x: node.x, y: node.y, outgoing, incoming }
  })

  return (
    <div class="rf-graph-view" ref={(el) => (containerRef = el)}>
      <div class="rf-graph-topbar">
        <div class="rf-graph-legend">
          <span class="rf-graph-stat">
            <b>{stats().nodes}</b> 节点
          </span>
          <span class="rf-graph-stat">
            <b>{stats().edges}</b> 边
          </span>
          <span class="rf-graph-sep" />
          <For each={Object.entries(CHAIN_EDGE_STYLE) as [ChainEdgeKind, (typeof CHAIN_EDGE_STYLE)[ChainEdgeKind]][]}>
            {([k, style]) => {
              const active = () => props.activeEdgeKinds.has(k)
              return (
                <button
                  type="button"
                  class="rf-graph-legend-btn"
                  data-active={active() ? "true" : "false"}
                  title={style.desc}
                  onClick={() => props.toggleEdgeKind(k)}
                >
                  <svg width="28" height="10" viewBox="0 0 28 10" aria-hidden="true">
                    <line
                      x1="2"
                      y1="5"
                      x2="26"
                      y2="5"
                      stroke={style.color}
                      stroke-width="2"
                      stroke-dasharray={style.dash ?? "0"}
                    />
                    <polygon
                      points="22,2 26,5 22,8"
                      fill={style.color}
                      opacity={active() ? 1 : 0.4}
                    />
                  </svg>
                  <span>{style.label}</span>
                </button>
              )
            }}
          </For>
        </div>
      </div>
      <svg
        class="rf-graph-svg"
        ref={(el) => (svgRef = el)}
        width={size().w}
        height={size().h}
        viewBox={`0 0 ${size().w} ${size().h}`}
        onMouseDown={onMouseDown}
        onWheel={onWheel}
        onDblClick={resetView}
        style={{ cursor: dragState ? "grabbing" : "grab" }}
      >
        <defs>
          {/* Larger arrow markers so direction is unmistakable. `userSpaceOnUse`
              keeps the marker size constant in viewBox px regardless of stroke-
              width, and `auto-start-reverse` places the head at edge end. */}
          <For each={Object.entries(CHAIN_EDGE_STYLE) as [ChainEdgeKind, (typeof CHAIN_EDGE_STYLE)[ChainEdgeKind]][]}>
            {([k, style]) => (
              <marker
                id={`rf-arrow-${k}`}
                viewBox="0 0 10 10"
                refX="10"
                refY="5"
                markerWidth="14"
                markerHeight="14"
                markerUnits="userSpaceOnUse"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L10,5 L0,10 L2,5 Z" fill={style.color} />
              </marker>
            )}
          </For>
        </defs>

        <g
          class="rf-graph-world"
          transform={`translate(${pan().x},${pan().y}) scale(${zoom()})`}
        >
          {/* Edges first (so nodes render on top) */}
          <For each={visibleEdges()}>
            {(e) => {
              const a = () => layout().get(e.from)
              const b = () => layout().get(e.to)
              const style = CHAIN_EDGE_STYLE[e.kind]
              const isDimmed = () => {
                const h = hovered()
                if (!h) return false
                return e.from !== h && e.to !== h
              }
              // Stop the line short of the node so the arrowhead lands just
              // outside the node circle rather than under it. Node radius ≈ 9
              // in content units; the hover-grown radius is 12.
              const NODE_R = 11
              const geom = () => {
                const A = a()
                const B = b()
                if (!A || !B) return null
                const dx = B.x - A.x
                const dy = B.y - A.y
                const d = Math.sqrt(dx * dx + dy * dy) || 1
                const ux = dx / d
                const uy = dy / d
                return {
                  x1: A.x + ux * NODE_R,
                  y1: A.y + uy * NODE_R,
                  x2: B.x - ux * NODE_R,
                  y2: B.y - uy * NODE_R,
                }
              }
              return (
                <Show when={geom()} keyed>
                  {(g) => (
                    <line
                      x1={g.x1}
                      y1={g.y1}
                      x2={g.x2}
                      y2={g.y2}
                      stroke={style.color}
                      stroke-width={isDimmed() ? 1.6 : 2.6}
                      stroke-dasharray={style.dash ?? "0"}
                      stroke-linecap="round"
                      opacity={isDimmed() ? 0.3 : 0.9}
                      marker-end={`url(#rf-arrow-${e.kind})`}
                    >
                      <title>{`${style.label}: ${e.reason ?? ""}`}</title>
                    </line>
                  )}
                </Show>
              )
            }}
          </For>

          {/* Nodes */}
          <For each={[...layout().values()]}>
            {(node) => {
              const exp = node.exp
              const pal = paletteFor(exp.kind)
              const isHovered = () => hovered() === node.id
              const isArchived = !!exp.archived
              return (
                <g
                  class="rf-graph-node"
                  data-palette={pal}
                  data-hovered={isHovered() ? "true" : "false"}
                  data-archived={isArchived ? "true" : "false"}
                  transform={`translate(${node.x},${node.y})`}
                  onMouseEnter={() => setHovered(node.id)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={(ev) => {
                    ev.stopPropagation()
                    props.onPick(node.id)
                  }}
                >
                  <circle
                    r={isHovered() ? 12 : 9}
                    class="rf-graph-node-dot"
                  />
                  <text
                    class="rf-graph-node-label"
                    x={15}
                    y={5}
                    text-anchor="start"
                  >
                    {clip(exp.title, 22)}
                  </text>
                </g>
              )
            }}
          </For>
        </g>
      </svg>
      <div class="rf-graph-controls" aria-label="Zoom controls">
        <button
          type="button"
          class="rf-graph-ctrl"
          onClick={() => {
            const z = zoom()
            const nz = Math.min(3.5, z * 1.2)
            const { w, h } = size()
            const p = pan()
            const cx = (w / 2 - p.x) / z
            const cy = (h / 2 - p.y) / z
            setZoom(nz)
            setPan({ x: w / 2 - cx * nz, y: h / 2 - cy * nz })
          }}
          title="放大"
        >
          ＋
        </button>
        <button
          type="button"
          class="rf-graph-ctrl"
          onClick={() => {
            const z = zoom()
            const nz = Math.max(0.3, z / 1.2)
            const { w, h } = size()
            const p = pan()
            const cx = (w / 2 - p.x) / z
            const cy = (h / 2 - p.y) / z
            setZoom(nz)
            setPan({ x: w / 2 - cx * nz, y: h / 2 - cy * nz })
          }}
          title="缩小"
        >
          －
        </button>
        <button
          type="button"
          class="rf-graph-ctrl"
          onClick={resetView}
          title="重置视图（双击空白处也可）"
        >
          ⌖
        </button>
        <span class="rf-graph-ctrl-zoom" title="当前缩放">
          {Math.round(zoom() * 100)}%
        </span>
      </div>
      <Show when={hoverCard()} keyed>
        {(c) => {
          // Position the card beside the hovered node, clamped into view.
          // c.x / c.y are content coordinates (pre-transform); we project them
          // to screen coords using the current pan + zoom so the card tracks
          // the node when the canvas is panned/zoomed.
          const cardW = 340
          const cardMaxH = 360
          const pad = 12
          const style = () => {
            const { w, h } = size()
            const z = zoom()
            const p = pan()
            const sx = p.x + c.x * z
            const sy = p.y + c.y * z
            const offset = 18
            // Prefer right side; fall back to left if near right edge.
            let left = sx + offset
            if (left + cardW + pad > w) left = sx - offset - cardW
            left = Math.max(pad, Math.min(w - cardW - pad, left))
            let top = sy - 20
            top = Math.max(pad, Math.min(h - 80, top))
            return {
              left: `${left}px`,
              top: `${top}px`,
              "max-width": `${cardW}px`,
              "max-height": `${cardMaxH}px`,
            }
          }
          const total = () => c.outgoing.length + c.incoming.length
          return (
            <div class="rf-graph-hovercard" style={style()}>
              <div class="rf-graph-hovercard-head">
                <span
                  class="rf-graph-hovercard-kind"
                  data-palette={paletteFor(c.exp.kind)}
                >
                  {kindDisplay(c.exp.kind)}
                </span>
                <span class="rf-graph-hovercard-title">{clip(c.exp.title, 28)}</span>
              </div>
              <Show when={c.exp.abstract}>
                <p class="rf-graph-hovercard-abstract">
                  {clip(c.exp.abstract, 180)}
                </p>
              </Show>
              <Show when={total() === 0}>
                <div class="rf-graph-hovercard-empty">
                  当前经验暂无连边
                </div>
              </Show>
              <Show when={c.outgoing.length > 0}>
                <div class="rf-graph-hovercard-section">
                  <div class="rf-graph-hovercard-section-title">向外关联</div>
                  <ul class="rf-graph-hovercard-list">
                    <For each={c.outgoing}>
                      {(ln) => (
                        <li class="rf-graph-hovercard-item">
                          <span
                            class="rf-graph-hovercard-tag"
                            style={{ "--rf-edge-color": ln.color } as never}
                          >
                            {ln.label}
                          </span>
                          <span class="rf-graph-hovercard-text">{ln.text}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </Show>
              <Show when={c.incoming.length > 0}>
                <div class="rf-graph-hovercard-section">
                  <div class="rf-graph-hovercard-section-title">来自其他</div>
                  <ul class="rf-graph-hovercard-list">
                    <For each={c.incoming}>
                      {(ln) => (
                        <li class="rf-graph-hovercard-item">
                          <span
                            class="rf-graph-hovercard-tag"
                            style={{ "--rf-edge-color": ln.color } as never}
                          >
                            {ln.label}
                          </span>
                          <span class="rf-graph-hovercard-text">{ln.text}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </Show>
              <div class="rf-graph-hovercard-foot">
                点击节点查看详情 · 共 {total()} 条关联
              </div>
            </div>
          )
        }}
      </Show>
      <Show when={props.loading}>
        <div class="rf-graph-loading">载入中…</div>
      </Show>
      <Show when={!props.loading && stats().nodes === 0}>
        <div class="rf-graph-empty">
          <h3>图谱为空</h3>
          <p>尚未有 experience，或当前筛选未命中任何条目。</p>
        </div>
      </Show>
    </div>
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
  /* Multi-select for "Merge" — populated when the user shift-clicks /
   * cmd-clicks experience cards. Empty by default. The Merge button in
   * the header is disabled when fewer than 2 are selected. */
  const [selectedIds, setSelectedIds] = createSignal<string[]>([])
  const [activeCategory, setActiveCategory] = createSignal<string | undefined>()
  /* Active tag filter — separate from `activeCategory`. Tags are the
   * granular labels each experience carries (categories[]). Clicking a
   * #tag chip on a card sets this; the experience list shows only ones
   * containing that tag. Toggling the same tag clears the filter. */
  const [activeTag, setActiveTag] = createSignal<string | undefined>()
  const [activeKind, setActiveKind] = createSignal<Kind | undefined>()
  const [query, setQuery] = createSignal<string>("")
  // Track IME composition so we don't fire `setQuery` mid-pinyin.
  // Chinese / Japanese IME fires `input` events on every keystroke
  // during composition (each pinyin letter), and updating the
  // controlled signal mid-way resets the underlying input element,
  // breaking the IME's selection popup. The user reported "搜索框
  // 只能一个字一个字输入" — that's the symptom. The composition
  // bracket below + the gated onInput restore normal multi-char IME.
  const [composing, setComposing] = createSignal(false)
  // Refiner activity log modal state. `showLogs` toggles the modal;
  // `logEntries` is reloaded when the modal opens. The modal browses
  // every refiner run (including queries that never crystallised into
  // an experience), grouped by session, so the user can audit how the
  // refiner agent decided what to keep / drop.
  const [showLogs, setShowLogs] = createSignal(false)
  const [logEntries, setLogEntries] = createSignal<RefinerLogEntry[]>([])
  const [logsLoading, setLogsLoading] = createSignal(false)
  const [sortMode, setSortMode] = createSignal<"kind" | "recent" | "newest">("kind")
  const [includeArchived, setIncludeArchived] = createSignal(false)
  const [scopeMode, setScopeMode] = createSignal<"all" | "session">("all")
  const [mergeIDs, setMergeIDs] = createSignal<Set<string>>(new Set())
  const [banner, setBanner] = createSignal<string | undefined>()
  const [viewMode, setViewMode] = createSignal<"list" | "graph">("list")
  const [graphEdgeKinds, setGraphEdgeKinds] = createSignal<Set<ChainEdgeKind>>(
    new Set<ChainEdgeKind>([
      "requires",
      "refines",
      "supports",
      "contradicts",
      "see_also",
    ]),
  )
  const toggleGraphEdgeKind = (k: ChainEdgeKind) => {
    setGraphEdgeKinds((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

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

  // Loader for the refiner log modal — fired on open. We don't poll;
  // the user explicitly clicks the Logs button when they want to look.
  const reloadLogs = async () => {
    const current = server.current
    if (!current) return
    setLogsLoading(true)
    try {
      const result = await fetchRefinerLog({
        baseUrl: current.http.url,
        directory: sdk.directory,
        password: current.http.password,
        username: current.http.username,
        fetcher: platform.fetch,
      })
      // Newest first — append-only on disk so reverse here.
      setLogEntries([...result.entries].reverse())
    } catch (err) {
      console.error("refiner log load failed", err)
      setLogEntries([])
    } finally {
      setLogsLoading(false)
    }
  }
  const openLogs = () => {
    setShowLogs(true)
    void reloadLogs()
  }

  // Each resource is wrapped in `stableFetcher` so polling refetches don't
  // produce new object references when the server returned an identical
  // payload — that would otherwise re-key every <For> row and re-run every
  // memo, causing the visible "page keeps refreshing" flash.
  const [overview, { refetch }] = createResource(overviewArgs, stableFetcher(fetchOverview))
  const [taxonomy, { refetch: refetchTaxonomy }] = createResource(
    taxonomyArgs,
    stableFetcher(fetchTaxonomy),
  )
  const [config, { refetch: refetchConfig }] = createResource(taxonomyArgs, stableFetcher(fetchConfig))
  // Per-experience usage statistics (injection / cited / recalled). Polled
  // alongside the overview so the peek card's badges update naturally as
  // counters tick over without the user reloading.
  const [usageStats, { refetch: refetchUsageStats }] = createResource(
    taxonomyArgs,
    stableFetcher(fetchUsageStats),
  )
  const [categoriesData, { refetch: refetchCategories }] = createResource(
    taxonomyArgs,
    stableFetcher(fetchCategories),
  )
  // Full chain graph is only fetched while the Graph tab is open to avoid
  // paying the round-trip on every list-page view.
  const chainGraphArgs = () => {
    if (viewMode() !== "graph") return
    const b = taxonomyArgs()
    if (!b) return
    return { base: b, includeArchived: includeArchived() }
  }
  const [chainGraph, { refetch: refetchChainGraph }] = createResource(
    chainGraphArgs,
    stableFetcher((args: { base: ApiBase; includeArchived: boolean }) =>
      fetchChainGraph(args.base, { includeArchived: args.includeArchived }),
    ),
  )

  // Hash deeplink only: when the URL has `#<experience_id>` (e.g. linked from
  // the retrieve page's exp chip), open THAT experience. We do NOT auto-open
  // the most recent experience anymore — users found that intrusive. They land
  // on the page and can browse / pick on their own.
  let hashOpened = false
  const openExpFromHash = (data: NonNullable<ReturnType<typeof overview>>): boolean => {
    if (typeof window === "undefined") return false
    const hash = window.location.hash.replace(/^#/, "").trim()
    if (!hash) return false
    const target = data.experiences.find((e) => e.id === hash)
    if (!target) return false
    setSelection({ kind: "experience", id: `experience:${target.id}` })
    return true
  }
  createEffect(() => {
    const data = overview()
    if (!data || hashOpened || selection()) return
    if (openExpFromHash(data)) {
      hashOpened = true
    }
  })

  // Re-act to hashchange so deeplinks fired AFTER initial load (e.g. user
  // is on /refiner and the retrieve page opens a new tab to a different
  // exp_id) still surface the correct card.
  onMount(() => {
    if (typeof window === "undefined") return
    const handler = () => {
      const data = overview()
      if (!data) return
      openExpFromHash(data)
    }
    window.addEventListener("hashchange", handler)
    onCleanup(() => window.removeEventListener("hashchange", handler))
  })

  // Refresh strategy: this page used to poll every 4s, then 15s — but the
  // user found even 15s too noisy ("the page keeps refreshing while I'm
  // editing"). The data here changes slowly (a refinement is admitted every
  // few minutes at most), so we drop background polling to **5 minutes** and
  // rely on these explicit refresh moments instead:
  //
  //   1. Initial mount (handled by createResource's source-tracking)
  //   2. After any successful action (handle{Edit,Create,Augment,…} all
  //      call refreshAll() at the end)
  //   3. When the tab becomes visible after being hidden (catch-up)
  //   4. When the user closes any modal (in case the action mutated data —
  //      cheap "did anything change while you were busy?" check)
  //   5. The manual ↻ button at the top of the page
  //
  // The interval is kept (not removed) so a long-running session eventually
  // sees new data without the user having to click — but at 5 minutes it's
  // basically invisible compared to the 15s previous cadence.
  const POLL_INTERVAL_MS = 5 * 60 * 1000
  const tickPoll = () => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return
    // Hard pause while any action modal is open. Refetching mid-edit can
    // cause `selectedExperience()` (and thus the modal's parent props chain)
    // to swap reference, which in some Solid render paths costs the input
    // its focus / scroll / a typed character. The user would then see "the
    // page refreshed and ate my edit". Polling resumes when they close the
    // modal (see the action effect below), plus an extra tick fires there.
    if (action()) return
    void refetch()
    void refetchTaxonomy()
    void refetchConfig()
    void refetchCategories()
    if (viewMode() === "graph") void refetchChainGraph()
  }
  const poll = setInterval(tickPoll, POLL_INTERVAL_MS)
  // Resume immediately when the user returns to the tab so they don't have to
  // wait an entire interval to see fresh data after coming back.
  const onVisibility = () => {
    if (typeof document === "undefined") return
    if (document.visibilityState === "visible") tickPoll()
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility)
  }
  // Refetch once when an action modal closes — covers the case where the
  // action mutated something but didn't call refreshAll() (rare, but the
  // belt-and-braces here is cheap and means the user always sees fresh data
  // the moment they finish whatever they were doing).
  let prevActionType: string | undefined
  createEffect(() => {
    const a = action()
    const next = a?.type
    if (prevActionType && !next) tickPoll()
    prevActionType = next
  })
  onCleanup(() => {
    clearInterval(poll)
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility)
    }
  })

  const refreshAll = () => {
    void refetch()
    void refetchTaxonomy()
    void refetchConfig()
    void refetchCategories()
    if (viewMode() === "graph") void refetchChainGraph()
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

  // All unique #tag values across the experience library, sorted by
  // frequency desc. Powers the substrip's tag-dropdown filter so the
  // user can pick a tag without first finding a card that has it
  // (the previous design forced you to click an inline #chip).
  const allTags = createMemo<Array<{ tag: string; count: number }>>(() => {
    const counter = new Map<string, number>()
    for (const e of overview()?.experiences ?? []) {
      for (const t of e.categories ?? []) {
        if (!t) continue
        counter.set(t, (counter.get(t) ?? 0) + 1)
      }
    }
    return [...counter.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  })

  // Filtered experience list (applies kind/category/query/archived filters)
  const visibleExperiences = createMemo(() => {
    const all = overview()?.experiences ?? []
    const archivedOk = includeArchived()
    const cat = activeCategory()
    const kind = activeKind()
    const tag = activeTag()
    const q = query().trim().toLowerCase()
    return all.filter((e) => {
      if (!archivedOk && e.archived) return false
      if (cat && !(e.categories ?? []).includes(cat)) return false
      if (tag && !(e.categories ?? []).includes(tag)) return false
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

  // Flat list with sort key chosen by sortMode. "recent" sorts by the latest
  // re-refinement timestamp (intuitively "what changed lately"); "newest"
  // sorts by birth time (`created_at`) — useful when you want to see what the
  // refiner has been admitting into the graph in the order it discovered it,
  // independent of subsequent edits/re-refinements.
  const visibleExperiencesFlat = createMemo(() => {
    const arr = [...visibleExperiences()]
    if (sortMode() === "newest") {
      arr.sort((a, b) => b.created_at - a.created_at)
    } else {
      arr.sort((a, b) => b.last_refined_at - a.last_refined_at)
    }
    return arr
  })

  // Mapping from Experience → RuneKnowledgeExp for the new design list +
  // graph components. Each card renders kind chip + title + abstract excerpt
  // + scope/tags row + obs count + flag (pending/rejected) — same data, just
  // arranged per the design template.
  const runeExperiences = createMemo<RuneKnowledgeExp[]>(() => {
    const ageOf = (e: Experience): string => {
      if (!e.last_refined_at) return ""
      const days = Math.max(0, Math.floor((Date.now() - e.last_refined_at) / 86400000))
      if (days === 0) return "今"
      if (days < 30) return `${days}d`
      if (days < 365) return `${Math.floor(days / 30)}mo`
      return `${Math.floor(days / 365)}y`
    }
    const status = (e: Experience): RuneKnowledgeExp["flag"] => {
      const r = e.review_status
      if (r === "pending") return "pending"
      if (r === "rejected") return "rejected"
      return undefined
    }
    return visibleExperiencesFlat().map((e) => ({
      id: e.id,
      cat: e.kind,
      catLabel: kindDisplay(e.kind),
      title: e.title,
      body: e.abstract,
      scope: e.scope,
      flag: status(e),
      ago: ageOf(e),
      obs: e.observations?.length,
      tags: e.categories ?? [],
      statement: e.statement,
    }))
  })

  // Edges adapted for RuneKnowledgeGraph (radial layout). The chain graph
  // endpoint is the source of truth; we project it into the simple {a,b,kind}
  // shape the design's graph expects.
  const runeGraphEdges = createMemo<RuneKnowledgeEdge[]>(() => {
    const data = chainGraph.latest
    if (!data) return []
    return (data.edges ?? []).map((e) => ({
      a: e.from,
      b: e.to,
      kind: e.kind,
    }))
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

  const pickExperienceByID = (id: string, modifiers?: { shift?: boolean; meta?: boolean }) => {
    // Shift / Cmd / Ctrl-click → toggle multi-select for Merge.
    if (modifiers?.shift || modifiers?.meta) {
      setSelectedIds((prev) => {
        if (prev.includes(id)) return prev.filter((x) => x !== id)
        return [...prev, id]
      })
      return
    }
    // Plain click → clear multi-select and open detail.
    setSelectedIds([])
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

  // Per-message auto-precipitate switch. Off → refiner stops running on
  // every user message (token-cost control). Default (no override) is on.
  const updateAutoEnabled = async (next: boolean) => {
    const current = server.current
    if (!current) return
    try {
      await putConfig({
        baseUrl: current.http.url,
        directory: sdk.directory,
        username: current.http.username,
        password: current.http.password,
        fetcher: platform.fetch,
        body: { auto_enabled: next },
      })
    } catch (err) {
      console.warn("[refiner] update auto_enabled failed", err)
    }
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

  const handleReview = async (id: string, status: ReviewStatus) => {
    await withBase((b) => apiReviewExperience(b, id, status))
    flash(
      status === "approved"
        ? "Approved"
        : status === "rejected"
        ? "Rejected"
        : "Re-queued for review",
    )
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

  const handleIngest = async (sessionID: string, opts?: { messageIDs?: string[] }) => {
    const res = await withBase((b) => apiIngestSession(b, sessionID, opts))
    const observed = res?.stats?.observed ?? 0
    const skipped = res?.stats?.skipped ?? 0
    flash(`Session ingested · observed=${observed} · skipped=${skipped}`)
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

  // Categories surfaced into the unified Rail so the body view stays
  // focused on the list / graph. The core 7 kinds (workflow_rule etc.)
  // plus any custom slugs become Rail sub-rows; clicking syncs the
  // existing kind filter signal so all downstream filtering still works.
  const railCategorySubs = createMemo(() => {
    const tax = taxonomy()
    const counts = kindCounts()
    const items: { id: string; title: string; meta?: string }[] = [
      {
        id: "__all",
        title: "全部",
        meta: String(overview()?.status.total_experiences ?? 0),
      },
    ]
    if (!tax) return items
    const coreSlugs = (tax.core ?? []).map((k) =>
      typeof k === "string" ? k : k.slug,
    )
    for (const slug of coreSlugs) {
      const c = counts.get(slug as Kind) ?? 0
      items.push({
        id: slug,
        title: kindDisplay(slug as Kind),
        meta: c > 0 ? String(c) : undefined,
      })
    }
    for (const c of tax.custom ?? []) {
      items.push({
        id: c.slug,
        title: c.slug.replace(/^custom:/, ""),
        meta: c.count > 0 ? String(c.count) : undefined,
      })
    }
    return items
  })

  // Publish chrome config to the parent UnifiedShell via the shell bridge.
  // The parent shell consumes this reactively without remounting on rail
  // navigation — the visual effect is in-page module switching.
  const shell = useShellBridge()
  // Knowledge rail badge = experiences awaiting review (review_status =
  // "pending"). The badge appears next to "Knowledge" in the rail to
  // signal "stuff needs your attention".
  const pendingReviewCount = createMemo(() => {
    const exps = overview()?.experiences ?? []
    return exps.filter((e) => (e.review_status ?? "approved") === "pending").length
  })
  createEffect(() => {
    shell.setChrome({
      header: {
        parent: "Knowledge",
        title: "Experience library",
        meta: [
          { k: "EXP", v: String(overview()?.status.total_experiences ?? 0) },
          { k: "OBS", v: String(overview()?.status.total_observations ?? 0) },
        ],
        // Action cluster: refresh / merge selected / import / new / export.
        // Re-index was renamed to ↻ "刷新" because users found "Re-index"
        // ambiguous (it suggested rebuilding embeddings; in fact it just
        // re-fetches the overview + taxonomy from disk, which the page
        // already polls automatically every 5 minutes).
        actions: (
          <>
            <button
              type="button"
              class="rune-btn"
              data-size="sm"
              onClick={() => void refreshAll()}
              title="重新拉取 overview 与 taxonomy 缓存"
            >
              ↻ 刷新
            </button>
            <button
              type="button"
              class="rune-btn"
              data-size="sm"
              disabled={mergeIDs().size < 2}
              onClick={() => setAction({ type: "merge", ids: Array.from(mergeIDs()) })}
              title="将多条选中的 experience 合并为一条（保留全部 observation）"
            >
              ⥁ Merge
              <Show when={mergeIDs().size >= 2}>
                <span style={{ "margin-left": "4px", "font-variant-numeric": "tabular-nums" }}>
                  ·{mergeIDs().size}
                </span>
              </Show>
            </button>
            <button
              type="button"
              class="rune-btn"
              data-size="sm"
              onClick={() => setAction({ type: "ingest", sessionID: params.id ?? "" })}
              title="从历史会话中挑选 user query 手动归纳为 experience"
              disabled={!params.id}
            >
              ⇅ From history
            </button>
            <button
              type="button"
              class="rune-btn"
              data-size="sm"
              onClick={() => setAction({ type: "import" })}
              title="导入 JSON 包（合并或替换）"
            >
              ⤴ Import
            </button>
            <button
              type="button"
              class="rune-btn"
              data-size="sm"
              onClick={() => {
                const data = overview()?.experiences ?? []
                if (data.length === 0) return
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
                const url = URL.createObjectURL(blob)
                const a = document.createElement("a")
                a.href = url
                a.download = `experiences-${new Date().toISOString().slice(0, 10)}.json`
                a.click()
                URL.revokeObjectURL(url)
              }}
              title="导出 experience 库为 JSON"
            >
              ⤵ Export
            </button>
            <button
              type="button"
              class="rune-btn"
              data-size="sm"
              onClick={openLogs}
              title="查看 refiner agent 的活动日志（按 session/query 浏览所有 refiner 运行，包含没有沉淀为 experience 的 query）"
            >
              ⌥ Logs
            </button>
            <button
              type="button"
              class="rune-btn"
              data-size="sm"
              data-variant="primary"
              onClick={() => setAction({ type: "create" })}
              title="手动新建 experience"
            >
              ＋ New
            </button>
          </>
        ),
      },
      // Design's Knowledge ships both List and Graph views (segmented
      // toggle in the design — sliding pill rather than text-link tabs).
      // The right cluster carries the unified RuneModelPicker — without
      // this the user has no way to pick the refiner's LLM (the legacy
      // `rf-top` toolbar that used to host it is `display:none`'d when
      // running inside the unified shell).
      substrip: {
        tabs: [
          { id: "list", name: "List" },
          { id: "graph", name: "Graph" },
        ],
        active: viewMode(),
        onTab: (id: string) => setViewMode(id as "list" | "graph"),
        variant: "segmented",
        right: (
          <div class="rune-row rune-gap-2">
            {/* Search input — narrow, ghost border (consistent with the
              * Workflow substrip search). Filters by title, abstract,
              * statement, task_type, categories, and observation text. */}
            <div class="rune-search-input">
              <span class="rune-search-icon" aria-hidden>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="7" cy="7" r="4.5" />
                  <path d="M11 11l3 3" />
                </svg>
              </span>
              <input
                type="text"
                placeholder="搜索 exp…"
                value={query()}
                onCompositionStart={() => setComposing(true)}
                onCompositionEnd={(e) => {
                  setComposing(false)
                  setQuery(e.currentTarget.value)
                }}
                onInput={(e) => {
                  // Suppress controlled-input rewrites during IME
                  // composition so multi-stroke pinyin works.
                  if (composing()) return
                  setQuery(e.currentTarget.value)
                }}
              />
              <Show when={query()}>
                <button
                  type="button"
                  class="rune-search-clear"
                  aria-label="Clear search"
                  onClick={() => setQuery("")}
                >×</button>
              </Show>
            </div>
            {/* Tag dropdown — picks a single #tag from the library's
              * full set, ranked by frequency. Selecting a tag drives
              * `activeTag` (same signal that inline chip clicks set),
              * so list + graph both react. */}
            <select
              class="rune-tag-select"
              value={activeTag() ?? ""}
              onChange={(e) => {
                const v = e.currentTarget.value
                setActiveTag(v ? v : undefined)
              }}
              title="按 tag 过滤"
            >
              <option value="">所有 tag</option>
              <For each={allTags()}>
                {(t) => <option value={t.tag}>#{t.tag} · {t.count}</option>}
              </For>
            </select>
            {/* Per-message auto-precipitate toggle. Override file (if
              * present) wins; otherwise defaults to `true`. Flipping it
              * off makes the refiner stop running on every user message
              * — manual triggers from this page still work. */}
            <label
              class="rune-refiner-auto-toggle"
              title="开启后每条用户消息都会触发 refiner 自动沉淀经验；关闭以减少 token 消耗（仍可手动运行）"
            >
              <input
                type="checkbox"
                checked={config()?.override?.auto_enabled !== false}
                onChange={(e) => void updateAutoEnabled(e.currentTarget.checked)}
              />
              <span>自动沉淀</span>
            </label>
            <RuneModelPicker
              current={config()?.resolved ?? overview()?.model}
              source={config()?.source}
              kicker="MODEL"
              onChange={updateModel}
              onReset={resetModel}
            />
          </div>
        ),
      },
      railSubs: railCategorySubs(),
      activeSubId: activeKind() ?? "__all",
      onPickSub: (id: string) => {
        if (id === "__all") setActiveKind(undefined)
        else setActiveKind(id as Kind)
      },
      railBadges: pendingReviewCount() > 0 ? { knowledge: pendingReviewCount() } : undefined,
    })
  })
  // Reset chrome when this page unmounts so a stale config doesn't bleed
  // into the next module that mounts.
  onCleanup(() => shell.setChrome({}))

  return (
    <div class="refiner-page relative flex size-full min-h-0 flex-col overflow-hidden" data-rune-shell-knowledge="true">

      {/* Legacy rf-top toolbar — hidden when running inside UnifiedShell.
          Its functions (Refiner header, model picker, view toggle, scope
          toggle, refresh) are now provided by the shell's Header /
          Substrip. The block is kept rendered so all the buttons remain
          mounted (existing handlers / focus refs / etc.); CSS hides it. */}
      <div class="rf-top" style={{ display: "none" }}>
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

        <RuneModelPicker
          current={config()?.resolved ?? overview()?.model}
          source={config()?.source}
          kicker="MODEL"
          onChange={updateModel}
          onReset={resetModel}
        />

        <div class="rf-top-spacer" />

        <div
          class="rf-scope-toggle rf-view-toggle"
          role="group"
          aria-label="View mode"
          title="列表视图 or 图谱视图"
        >
          <button
            type="button"
            class="rf-scope-btn"
            data-active={viewMode() === "list"}
            onClick={() => setViewMode("list")}
          >
            列表
          </button>
          <button
            type="button"
            class="rf-scope-btn"
            data-active={viewMode() === "graph"}
            onClick={() => setViewMode("graph")}
          >
            图谱
          </button>
        </div>

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
              label: "Import from history",
              onPick: () => setAction({ type: "ingest", sessionID: params.id }),
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

      {/* Plan B: kind/category filtering is in the unified shell rail
          (left sub-list under Knowledge). The legacy Filterbar overlapped
          with rail subs and is no longer rendered. Its component is kept
          defined in case any debugging path mounts it directly. */}

      <Show when={banner()}>
        <div class="rf-banner">{banner()}</div>
      </Show>

      {/* Tag-filter banner — lifted above the stage so it shows in BOTH
          list and graph views (the chip is set from list cards but the
          graph also needs to honour it). */}
      <Show when={activeTag()}>
        <div class="rf-tag-filter-bar">
          <span class="rf-tag-filter-label">已按 tag 筛选:</span>
          <button
            type="button"
            class="rune-chip kw-tag-chip is-active"
            onClick={() => setActiveTag(undefined)}
            title="点击清除筛选"
          >
            #{activeTag()} ×
          </button>
        </div>
      </Show>

      <div class="rf-stage" data-view={viewMode()}>
        <Show when={viewMode() === "graph"}>
          <div class="rf-main rf-main-graph">
            <ExperienceGraphView
              data={chainGraph.latest}
              loading={chainGraph.loading && !chainGraph.latest}
              onPick={pickExperienceByID}
              activeKind={activeKind()}
              activeCategory={activeCategory()}
              activeTag={activeTag()}
              activeEdgeKinds={graphEdgeKinds()}
              toggleEdgeKind={toggleGraphEdgeKind}
              includeArchived={includeArchived()}
            />
          </div>
        </Show>
        <Show when={viewMode() === "list"}>
          <div class="rf-main">
            <RuneKnowledgeList
              experiences={runeExperiences()}
              selectedIds={new Set(selectedIds())}
              activeTag={activeTag()}
              onPickTag={(t) => setActiveTag(activeTag() === t ? undefined : t)}
              pickedId={(() => {
                const sel = selection()
                if (!sel) return undefined
                return sel.id.startsWith("experience:")
                  ? sel.id.slice("experience:".length)
                  : sel.id
              })()}
              onPick={pickExperienceByID}
              emptyText="没有匹配的经验。试试清空搜索或切换其他分类。"
            />
          </div>
        </Show>
      </div>

      <ExperienceModal
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
        onReview={(id, status) => handleReview(id, status)}
        onToggleMergeSelect={toggleMergeSelect}
        mergeSelected={(id) => mergeIDs().has(id)}
        usageStat={(() => {
          const sel = selectedExperience()
          if (!sel) return undefined
          return usageStats()?.[sel.id]
        })()}
      />

      <Show when={showLogs()}>
        <RefinerLogsModal
          entries={logEntries()}
          loading={logsLoading()}
          onClose={() => setShowLogs(false)}
          onReload={() => void reloadLogs()}
        />
      </Show>

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
          <HistoryImportDrawer
            apiBase={apiBase}
            currentSessionID={a().sessionID}
            onClose={() => setAction(undefined)}
            onSubmit={(sessionID, messageIDs) =>
              handleIngest(sessionID, messageIDs ? { messageIDs } : undefined)
            }
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
