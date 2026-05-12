import path from "path"
import { unlink } from "fs/promises"
import matter from "gray-matter"
import z from "zod"
import { Effect } from "effect"
import { generateText, jsonSchema, stepCountIs, streamText, tool, type ModelMessage } from "ai"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Config } from "@/config"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session"
import { Provider } from "@/provider"
import { ProviderID, ModelID } from "@/provider/schema"
import { ProviderTransform } from "@/provider"
import { Instance } from "@/project/instance"
import { AppRuntime } from "@/effect/app-runtime"
import { Workflow } from "@/workflow"
import { Filesystem, Log } from "@/util"
import { Glob } from "@opencode-ai/shared/util/glob"
import { Hash } from "@opencode-ai/shared/util/hash"
import {
  EdgeKind as EdgeKindSchema,
  type EdgeKind,
  type ExperienceEdge,
  persistBatch as persistEdgeBatch,
  readEdges as readEdgesRaw,
  removeEdges as removeEdgesRaw,
  removeEdgesFor as removeEdgesForExpRaw,
  rewireEdges as rewireEdgesRaw,
  traverseFrom as traverseFromSeed,
} from "./graph"

const log = Log.create({ service: "refiner" })

// -----------------------------------------------------------------------------
// Taxonomy
// -----------------------------------------------------------------------------

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

const KindSchema = z
  .string()
  .refine(
    (val): val is Kind => {
      if ((CORE_KINDS as readonly string[]).includes(val)) return true
      if (val.startsWith("custom:") && val.length > "custom:".length) return true
      return false
    },
    { message: "kind must be a core kind or 'custom:<slug>'" },
  ) as z.ZodType<Kind>

const KIND_PATTERN = `^(${CORE_KINDS.join("|")}|custom:[a-z0-9-]+)$`
const KIND_DESCRIPTION =
  `Must be exactly one of: ${CORE_KINDS.join(", ")}; ` +
  `or 'custom:<slug>' where <slug> is lowercase letters, digits or hyphens only.`

/**
 * z.toJSONSchema drops .refine() predicates, so the kind field would otherwise
 * arrive at the LLM as an unconstrained string. Walk the JSON schema and inject
 * a regex pattern + description on every 'kind' property so the LLM has explicit
 * constraints in the tool schema.
 */
function applyKindConstraint<T>(schema: T): T {
  const visit = (node: any): void => {
    if (!node || typeof node !== "object") return
    if (node.properties && typeof node.properties === "object") {
      if (node.properties.kind && typeof node.properties.kind === "object") {
        const prev = node.properties.kind
        node.properties.kind = {
          type: "string",
          pattern: KIND_PATTERN,
          description: prev.description
            ? `${KIND_DESCRIPTION} ${prev.description}`
            : KIND_DESCRIPTION,
        }
      }
      for (const key of Object.keys(node.properties)) visit(node.properties[key])
    }
    for (const key of ["items", "additionalProperties", "anyOf", "oneOf", "allOf", "$defs", "definitions"]) {
      const v = node[key]
      if (Array.isArray(v)) v.forEach(visit)
      else if (v && typeof v === "object") visit(v)
    }
  }
  visit(schema)
  return schema
}

const CORE_KIND_DESCRIPTIONS: Record<CoreKind, string> = {
  workflow_rule: "流程规则（顺序/因果）：一定要先做 A 再做 B；某事必须发生在某事之后",
  workflow_gap: "流程缺口：slave agent 或当前流程缺少的工具/资料/步骤，用户补齐了使其可复用",
  know_how: "操作性指导（怎么做）：用户告诉 agent 某件事应当如何执行",
  constraint_or_policy: "硬约束/禁令：永远不要做什么；合规、审批、命名等静态规则",
  domain_knowledge: "领域/事实知识：是什么、叫什么、属于什么；业务概念、环境事实",
  preference_style: "风格/偏好：代码/沟通/文档风格的个人或团队偏好",
  pitfall_or_caveat: "常见坑/注意点：容易误判、容易遗漏、容易踩的陷阱",
}

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

const Scope = z.enum(["workspace", "project", "repo", "user"])
type Scope = z.infer<typeof Scope>

// target_layer: which agent layer this experience is intended to inform.
//   - "master": orchestrator / planner agents (build, plan, sandtable)
//   - "slave":  task-executor subagents (general, explore, etc.)
//   - "both":   either layer can benefit (default for back-compat)
const TargetLayer = z.enum(["master", "slave", "both"])
type TargetLayer = z.infer<typeof TargetLayer>

const HistoryEntry = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  message_id: z.string(),
})

const WorkflowSnapshot = z.object({
  workflow_id: z.string(),
  node_id: z.string().optional(),
  phase: z.string().optional(),
  recent_events: z.array(
    z.object({
      kind: z.string(),
      at: z.number(),
      summary: z.string(),
    }),
  ),
})

const ObservationSchema = z.object({
  id: z.string(),
  observed_at: z.number(),
  session_id: z.string(),
  message_id: z.string(),
  user_text: z.string(),
  // Where this observation came from.
  // "session"        – captured from a live user message (default)
  // "manual_augment" – user added context under an existing experience
  // "ingest"         – batch-ingested from an older session
  source: z.enum(["session", "manual_augment", "ingest"]).optional(),
  note: z.string().optional(),
  agent_context: z.object({
    session_history_excerpt: z.array(HistoryEntry),
    workflow_snapshot: WorkflowSnapshot.optional(),
  }),
})
type Observation = z.infer<typeof ObservationSchema>

const RefinementSnapshot = z.object({
  title: z.string(),
  abstract: z.string(),
  statement: z.string().optional(),
  trigger_condition: z.string().optional(),
  task_type: z.string().optional(),
  scope: Scope.optional(),
  kind: KindSchema.optional(),
  categories: z.array(z.string()).optional(),
})
type RefinementSnapshot = z.infer<typeof RefinementSnapshot>

const RefinementEntry = z.object({
  at: z.number(),
  trigger_observation_id: z.string(),
  // Legacy field kept optional for forward-compat; new entries also populate prev_snapshot.
  prev_abstract_digest: z.string().optional(),
  prev_snapshot: RefinementSnapshot.optional(),
  // "auto" | "manual_augment" | "manual_edit" | "merge" | "undo" | "re_refine"
  kind: z
    .enum(["auto", "manual_augment", "manual_edit", "merge", "undo", "re_refine"])
    .optional(),
  // Which observation IDs or merge-source IDs triggered this entry.
  source_ids: z.array(z.string()).optional(),
  model: z.string(),
})
type RefinementEntry = z.infer<typeof RefinementEntry>

const ExperienceSchema = z.object({
  id: z.string(),
  kind: KindSchema,
  title: z.string(),
  abstract: z.string(),
  statement: z.string().optional(),
  trigger_condition: z.string().optional(),
  task_type: z.string().optional(),
  scope: Scope,
  // Phase 2b — read-side layering (default "both" for back-compat with all
  // existing experiences). The refiner is free to leave this at the default;
  // retrieve uses it as a soft filter when assembling system-prompt injects.
  target_layer: TargetLayer.default("both"),
  categories: z.array(z.string()).default([]),
  observations: z.array(ObservationSchema),
  related_experience_ids: z.array(z.string()),
  conflicts_with: z.array(z.string()).default([]),
  refinement_history: z.array(RefinementEntry),
  archived: z.boolean().default(false),
  archived_at: z.number().optional(),
  // Review queue. Newly auto-routed experiences land as "pending" — the user
  // must approve them in the UI before they participate in retrieval/injection.
  // Manually-created (UI form, augment, merge) defaults to "approved" since the
  // user explicitly initiated those. "rejected" is a soft delete: the file
  // stays for audit but it's hidden from default views.
  // Default "approved" so existing on-disk experiences parse cleanly without a
  // migration pass.
  review_status: z.enum(["pending", "approved", "rejected"]).default("approved"),
  reviewed_at: z.number().optional(),
  created_at: z.number(),
  last_refined_at: z.number(),
})
type Experience = z.infer<typeof ExperienceSchema>

type ExperienceWithPath = Experience & { path: string }

type ExperienceSummary = {
  id: string
  kind: Kind
  title: string
  abstract: string
  task_type?: string
  observation_count: number
  last_refined_at: number
}

// Phase 2a — edge proposal embedded in route output.
//
// Each edge either points FROM the current (freshly created) experience to a
// peer ("from" omitted, LLM only needs to name `to`) — or both endpoints are
// explicit for `edge_only` decisions that augment the graph without creating
// a new experience.
const EdgeProposalWireSchema = z.object({
  from: z.string().optional(),
  to: z.string(),
  kind: EdgeKindSchema,
  reason: z.string().max(400).default(""),
  confidence: z.number().min(0).max(1).optional(),
})
type EdgeProposalWire = z.infer<typeof EdgeProposalWireSchema>

// Flat object schema so that provider adapters that require `type: "object"` at
// the function tool root (e.g., Azure OpenAI) accept it. Branch invariants are
// enforced at parse time via refine(), not via discriminated union.
//
// `attach` is kept for schema backward-compat only: Phase 2a drops auto-merge.
// If an LLM still emits `attach`, the runtime downgrades it to `noise` with an
// explicit rejection reason — the next-turn prompt is authoritative.
const RouteAction = z.enum(["attach", "new", "edge_only", "noise"])
const RouteDecisionWireSchema = z.object({
  action: RouteAction,
  reason: z.string(),
  experience_id: z.string().optional(),
  kind: KindSchema.optional(),
  title: z.string().max(60).optional(),
  abstract: z.string().optional(),
  statement: z.string().optional(),
  trigger_condition: z.string().optional(),
  task_type: z.string().optional(),
  scope: Scope.optional(),
  categories: z.array(z.string()).optional(),
  conflicts_with: z.array(z.string()).optional(),
  // Phase 2a: LLM may output edges alongside `new` (new_with_edges) or alone
  // (`edge_only`). Capped at 5 per decision by the runtime regardless.
  edges: z.array(EdgeProposalWireSchema).max(5).optional(),
})
type RouteDecisionWire = z.infer<typeof RouteDecisionWireSchema>

// Wrapper schema that always emits an array of decisions. The array MAY be
// empty (equivalent to "nothing reusable here") or contain up to 8 decisions
// when the single observation genuinely covers several distinct reusable
// ideas. This replaces the legacy single-decision contract so one user
// message can fan out into multiple experiences when its content warrants it.
const RouteDecisionsWireSchema = z.object({
  decisions: z.array(RouteDecisionWireSchema).max(8),
})
type RouteDecisionsWire = z.infer<typeof RouteDecisionsWireSchema>

// Phase 2a route decisions (4 effective branches):
//   - "new"          — new experience, optionally with edges linking to peers
//   - "edge_only"    — no new experience; only insert edges between existing
//   - "noise"        — nothing to sink
//   - "attach" [DEPRECATED] — kept for schema tolerance; runtime drops + logs.
//     The prompt no longer advertises this branch; manual merge is the only
//     legitimate compression path.
type EdgeProposal = {
  from?: string
  to: string
  kind: EdgeKind
  reason?: string
  confidence?: number
}

type RouteDecision =
  | {
      action: "attach"
      experience_id: string
      reason: string
      categories?: string[]
      conflicts_with?: string[]
    }
  | {
      action: "new"
      reason: string
      kind: Kind
      title: string
      abstract: string
      statement?: string
      trigger_condition?: string
      task_type?: string
      scope: Scope
      categories?: string[]
      conflicts_with?: string[]
      edges?: EdgeProposal[]
    }
  | {
      action: "edge_only"
      reason: string
      edges: EdgeProposal[]
    }
  | { action: "noise"; reason: string }

function normalizeEdges(wires?: EdgeProposalWire[]): EdgeProposal[] | undefined {
  if (!wires || wires.length === 0) return undefined
  const out: EdgeProposal[] = []
  for (const w of wires) {
    if (!w.to) continue
    out.push({
      from: w.from || undefined,
      to: w.to,
      kind: w.kind,
      reason: w.reason,
      confidence: w.confidence,
    })
  }
  return out.length ? out : undefined
}

function normalizeRouteDecision(wire: RouteDecisionWire): RouteDecision | { error: string } {
  if (wire.action === "attach") {
    if (!wire.experience_id) return { error: "attach missing experience_id" }
    return {
      action: "attach",
      experience_id: wire.experience_id,
      reason: wire.reason,
      categories: wire.categories,
      conflicts_with: wire.conflicts_with,
    }
  }
  if (wire.action === "noise") {
    return { action: "noise", reason: wire.reason }
  }
  if (wire.action === "edge_only") {
    const edges = normalizeEdges(wire.edges)
    if (!edges) return { error: "edge_only missing edges" }
    // edge_only requires explicit from on every edge (no implicit "newly-created" anchor)
    for (const e of edges) {
      if (!e.from) return { error: "edge_only edge missing from" }
    }
    return { action: "edge_only", reason: wire.reason, edges }
  }
  // new
  if (!wire.kind) return { error: "new missing kind" }
  if (!wire.title) return { error: "new missing title" }
  if (!wire.abstract) return { error: "new missing abstract" }
  if (!wire.scope) return { error: "new missing scope" }
  return {
    action: "new",
    reason: wire.reason,
    kind: wire.kind,
    title: wire.title,
    abstract: wire.abstract,
    statement: wire.statement,
    trigger_condition: wire.trigger_condition,
    task_type: wire.task_type,
    scope: wire.scope,
    categories: wire.categories,
    conflicts_with: wire.conflicts_with,
    edges: normalizeEdges(wire.edges),
  }
}

const RefineOutputSchema = z.object({
  kind: KindSchema.describe("必填。7 个核心 kind 之一，或 custom:<slug>"),
  title: z
    .string()
    .min(1)
    .max(60)
    .describe("必填。10–30 字简体中文名词短语，概括该 experience 主题；不得留空或用占位符"),
  abstract: z
    .string()
    .min(1)
    .describe(
      "必填。1–3 句简体中文归纳，必须覆盖所有 observations 的共同含义；不得复述用户原文，不得输出英文占位符或诸如 'not used' / 'ignore' / 'placeholder' 之类的字符串",
    ),
  statement: z
    .string()
    .optional()
    .describe("可选。机器可读的简短陈述，如 'after:commit => require:lint'。不确定时请省略，不要提交空串"),
  trigger_condition: z
    .string()
    .optional()
    .describe("可选。简体中文描述何时应被触发。不确定时请省略，不要提交空串"),
  task_type: z
    .string()
    .optional()
    .describe(
      "可选。任务域 slug，如 coding / delivery / review / docs / ops 等。不确定时请**省略**该字段而不是提交空串",
    ),
  scope: Scope.describe("必填。workspace | project | repo | user 中之一"),
  categories: z
    .array(z.string())
    .optional()
    .describe("可选。0–4 个 kebab-case 标签 slug，优先复用已存在的"),
  conflicts_with: z
    .array(z.string())
    .optional()
    .describe("可选。直接冲突的 experience id 列表；无冲突请省略或给空数组"),
})
type RefineOutput = z.infer<typeof RefineOutputSchema>

// -----------------------------------------------------------------------------
// Graph overview types (for HTTP endpoint)
// -----------------------------------------------------------------------------

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
  // has_observation / related — legacy view edges (experience → its observations,
  // legacy related_experience_ids links). chain_* edges carry the Phase 2a
  // typed edges from graph.ndjson.
  kind:
    | "has_observation"
    | "related"
    | "chain_requires"
    | "chain_refines"
    | "chain_supports"
    | "chain_contradicts"
    | "chain_see_also"
  edge_id?: string
  reason?: string
  confidence?: number
}

type RefinerOverview = {
  schema_version: 2
  status: {
    total_experiences: number
    total_observations: number
    latest_refined_at?: number
  }
  model?: { providerID: string; modelID: string }
  experiences: ExperienceWithPath[]
  graph: {
    nodes: GraphNode[]
    edges: GraphEdge[]
  }
}

// -----------------------------------------------------------------------------
// State & test overrides
// -----------------------------------------------------------------------------

// Local replacement for upstream's removed `Instance.state` helper: keeps a
// per-instance State keyed by `Instance.directory`. Call `state()` synchronously
// from inside an instance ALS context (same requirement as `Instance.state`).
type RefinerInstanceState = {
  userSeen: Record<string, string>
}
const __refinerStateByDirectory = new Map<string, RefinerInstanceState>()
function state(): RefinerInstanceState {
  const key = Instance.directory
  let existing = __refinerStateByDirectory.get(key)
  if (!existing) {
    existing = { userSeen: {} }
    __refinerStateByDirectory.set(key, existing)
  }
  return existing
}

// -----------------------------------------------------------------------------
// Effect-Service bridges
// -----------------------------------------------------------------------------
//
// Upstream's Session / Provider / Agent / Auth / Config now live behind Effect
// `Context.Service`. Refiner stays as a namespace module with async entrypoints,
// so every Service call is funneled through `AppRuntime.runPromise(Effect.gen)`
// in this single block. Each helper returns `Promise<T | undefined>` so
// legacy `.catch(() => undefined)` call-sites keep their graceful fallback.

async function svcConfigGet() {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const c = yield* Config.Service
      return yield* c.get()
    }),
  ).catch(() => undefined)
}

async function svcSessionMessages(input: { sessionID: SessionID; limit?: number }) {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const s = yield* Session.Service
      return yield* s.messages(input)
    }),
  ).catch(() => [] as Array<MessageV2.WithParts>)
}

async function svcSessionGet(id: SessionID) {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const s = yield* Session.Service
      return yield* s.get(id)
    }),
  ).catch(() => undefined)
}

async function svcAgentGet(name: string) {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const a = yield* Agent.Service
      return yield* a.get(name)
    }),
  ).catch(() => undefined)
}

async function svcProviderGetModel(providerID: ProviderID, modelID: ModelID) {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const p = yield* Provider.Service
      return yield* p.getModel(providerID, modelID)
    }),
  ).catch(() => undefined)
}

async function svcProviderGetLanguage(model: Provider.Model) {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const p = yield* Provider.Service
      return yield* p.getLanguage(model)
    }),
  ).catch(() => undefined)
}

async function svcProviderGetSmallModel(providerID: ProviderID) {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const p = yield* Provider.Service
      return yield* p.getSmallModel(providerID)
    }),
  ).catch(() => undefined)
}

async function svcProviderDefaultModel() {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const p = yield* Provider.Service
      return yield* p.defaultModel()
    }),
  ).catch(() => undefined)
}

async function svcAuthGet(providerID: string) {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const a = yield* Auth.Service
      return yield* a.get(providerID)
    }),
  ).catch(() => undefined)
}

// The override may return a single decision (legacy convenience) or an array
// of decisions (to exercise the multi-decision path in tests). The caller
// normalizes to an array before handing back to observeObservation.
let testRouteOverride:
  | ((
      observation: Observation,
      existing: ExperienceSummary[],
    ) => Promise<RouteDecision | RouteDecision[] | undefined>)
  | undefined
let testRefineOverride:
  | ((
      observation: Observation,
      experience: Experience,
    ) => Promise<RefineOutput | undefined>)
  | undefined

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

function nowMs() {
  return Date.now()
}

function compactText(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

function clipText(text: string, size = 180) {
  const v = compactText(text)
  if (v.length <= size) return v
  return `${v.slice(0, size - 1).trimEnd()}…`
}

function sha1Short(input: string, size = 12) {
  return Hash.fast(input).slice(0, size)
}

function uniqueStrings(items: Array<string | undefined | null>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of items) {
    if (!item) continue
    const s = item.trim()
    if (!s) continue
    if (seen.has(s)) continue
    seen.add(s)
    result.push(s)
  }
  return result
}

// Normalize a free-form category label into a stable slug:
// lowercase, whitespace collapsed, non-[a-z0-9-] stripped.
function slugifyCategory(label: string): string {
  return compactText(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

function rel(filepath: string) {
  return path.relative(Instance.worktree, filepath) || filepath
}

function cleanUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.filter((item) => item !== undefined).map((item) => cleanUndefined(item)) as T
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => {
        if (item === undefined) return []
        return [[key, cleanUndefined(item)]]
      }),
    ) as T
  }
  return value
}

async function withTimeout<T>(promise: Promise<T>, ms: number) {
  return await Promise.race([
    promise,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ])
}

async function settings() {
  const cfg = await svcConfigGet()
  const refiner = cfg?.experimental?.refiner
  const enabled = refiner?.enabled ?? true
  const base = refiner?.directory
    ? path.isAbsolute(refiner.directory)
      ? refiner.directory
      : path.join(Instance.worktree, refiner.directory)
    : path.join(Instance.worktree, ".opencode", "refiner-memory")
  // `auto_enabled` priority: per-project override file (set via the
  // UI toggle) > global config (.opencode/config) > default true.
  // We read the override here so the toggle takes effect without
  // requiring a config edit. The master `enabled` flag still trumps
  // this — when `enabled === false`, refiner is OFF regardless of
  // `auto_enabled`.
  let auto_enabled = refiner?.auto_enabled ?? true
  try {
    const overridePath = path.join(base, "config.json")
    if (await Filesystem.exists(overridePath)) {
      const raw = await Filesystem.readJson<unknown>(overridePath).catch(() => undefined)
      const parsed = ConfigOverrideSchema.safeParse(raw)
      if (parsed.success && typeof parsed.data.auto_enabled === "boolean") {
        auto_enabled = parsed.data.auto_enabled
      }
    }
  } catch {
    // Read failure is non-fatal — fall back to whatever auto_enabled
    // already resolved to from global config / default.
  }
  return { enabled, auto_enabled, base }
}

// -----------------------------------------------------------------------------
// Refiner activity log — one entry per refiner run (one observation, one
// manual create, one re-refine, etc.). Captures the exact prompts and
// responses for every LLM call inside that run, plus the final decision
// outcome. Surfaced via the Knowledge "Logs" UI so the user can audit
// queries that DID and DID NOT crystallise into experiences. Append-only
// JSONL stored alongside the experience files.
// -----------------------------------------------------------------------------

const RefinerLlmCallSchema = z.object({
  stage: z.enum(["route", "refine", "synthesis", "edge"]),
  provider_id: z.string().optional(),
  model_id: z.string().optional(),
  system_prompt: z.string().optional(),
  user_prompt: z.string(),
  response_text: z.string().optional(),
  reasoning_text: z.string().optional(),
  structured_output: z.unknown().optional(),
  error: z.string().optional(),
  duration_ms: z.number(),
})
export type RefinerLlmCall = z.infer<typeof RefinerLlmCallSchema>

const RefinerLogEntrySchema = z.object({
  id: z.string(),
  created_at: z.number(),
  duration_ms: z.number(),
  /** Where the run was kicked off from. `auto` = observed user message,
   *  `manual` = user clicked "+ New" in the UI, `history` = "From
   *  history" import, `import` = bulk JSON import, `re_refine` = user
   *  re-refined an existing experience. */
  trigger: z.enum(["auto", "manual", "history", "import", "re_refine"]),
  session_id: z.string().optional(),
  message_id: z.string().optional(),
  observation_id: z.string().optional(),
  /** The user-text that was being routed/refined. May be a clipped
   *  excerpt for very long inputs. Always populated even when the LLM
   *  decides the input is noise — the user wants to see those queries
   *  too ("没有沉淀的 query"). */
  user_text: z.string(),
  /** Final disposition of this run. */
  outcome: z.enum([
    "new_exp",      // a new experience was crystallised
    "update_exp",   // an existing experience was extended (attach/update)
    "edge_only",    // only graph edges were proposed, no exp change
    "noise",        // the LLM decided the input was noise
    "dropped",      // a non-noise decision was filtered out (validation, dedup, etc.)
    "error",        // the LLM call failed entirely
  ]),
  /** Experience ids touched by this run. */
  experience_ids: z.array(z.string()).default([]),
  /** Free-form reason string (best-effort, sourced from the decision). */
  reason: z.string().optional(),
  /** Per-stage LLM call traces, in invocation order. */
  llm_calls: z.array(RefinerLlmCallSchema),
})
export type RefinerLogEntry = z.infer<typeof RefinerLogEntrySchema>

/* Recorder injected into the LLM call sites (`routeObservation`,
 * `refineExperience`). They append one trace per LLM round-trip. The
 * caller (e.g. `observeObservation`) gathers them into a single log
 * entry once the run is complete. */
type RefinerLlmRecorder = (call: RefinerLlmCall) => void

function refinerLogFilepath(base: string) {
  return path.join(base, "refiner-log.ndjson")
}

async function appendRefinerLog(entry: RefinerLogEntry) {
  try {
    const { base } = await settings()
    const file = refinerLogFilepath(base)
    const line = JSON.stringify(entry) + "\n"
    const prev = await Filesystem.readText(file).catch(() => "")
    await Filesystem.write(file, prev + line)
  } catch (error) {
    log.warn("refiner log append failed", { error })
  }
}

async function readRefinerLog(): Promise<RefinerLogEntry[]> {
  try {
    const { base } = await settings()
    const file = refinerLogFilepath(base)
    const raw = await Filesystem.readText(file).catch(() => "")
    if (!raw) return []
    const out: RefinerLogEntry[] = []
    for (const line of raw.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = RefinerLogEntrySchema.safeParse(JSON.parse(trimmed))
        if (parsed.success) out.push(parsed.data)
      } catch {
        // skip malformed lines
      }
    }
    return out
  } catch {
    return []
  }
}

async function readMatter(filepath: string) {
  const raw = await Filesystem.readText(filepath)
  return matter(raw)
}

async function writeMatter(filepath: string, data: Record<string, unknown>, content: string) {
  await Filesystem.write(filepath, matter.stringify(content, cleanUndefined(data)))
}

function messageText(message: MessageV2.WithParts) {
  return compactText(
    message.parts
      .flatMap((part) => {
        if (part.type === "text" && !part.synthetic && !part.ignored) return [part.text.trim()]
        if (part.type === "tool") return [`[tool:${part.tool}]`]
        return []
      })
      .filter(Boolean)
      .join("\n"),
  )
}

function eventText(event: Workflow.EventInfo) {
  if (event.kind === "node.control") {
    return `Runtime command: ${typeof event.payload?.command === "string" ? event.payload.command : "unknown"}`
  }
  if (event.kind === "node.attempt_reported") {
    const bits: string[] = []
    if (typeof event.payload?.summary === "string") bits.push(event.payload.summary)
    if (Array.isArray(event.payload?.needs)) bits.push(...event.payload.needs.map(String))
    if (Array.isArray(event.payload?.errors))
      bits.push(
        ...event.payload.errors.map((item) => {
          if (!item || typeof item !== "object") return String(item)
          return [(item as Record<string, unknown>).source, (item as Record<string, unknown>).reason]
            .filter(Boolean)
            .join(": ")
        }),
      )
    return bits.filter(Boolean).join("\n")
  }
  if (event.kind === "node.updated") {
    const status = typeof event.payload?.status === "string" ? event.payload.status : undefined
    const result = typeof event.payload?.result_status === "string" ? event.payload.result_status : undefined
    return [status ? `status=${status}` : "", result ? `result=${result}` : ""].filter(Boolean).join(" ")
  }
  return JSON.stringify(event.payload ?? {}, null, 0)
}

// -----------------------------------------------------------------------------
// Disk rendering
// -----------------------------------------------------------------------------

function renderObservation(observation: Observation) {
  const lines: string[] = [
    "# Refiner Observation",
    "",
    `- session: ${observation.session_id}`,
    `- message: ${observation.message_id}`,
    `- observed_at: ${new Date(observation.observed_at).toISOString()}`,
    "",
    "## User Text",
    "",
    "> " + observation.user_text.replace(/\n/g, "\n> "),
    "",
  ]
  const history = observation.agent_context.session_history_excerpt
  if (history.length) {
    lines.push("## Prior History (前 3 条)")
    lines.push("")
    for (const entry of history) {
      lines.push(`- [${entry.role}] ${clipText(entry.text, 220)}`)
    }
    lines.push("")
  }
  const snapshot = observation.agent_context.workflow_snapshot
  if (snapshot) {
    lines.push("## Workflow Snapshot")
    lines.push("")
    lines.push(`- workflow: ${snapshot.workflow_id}`)
    if (snapshot.phase) lines.push(`- phase: ${snapshot.phase}`)
    if (snapshot.node_id) lines.push(`- node: ${snapshot.node_id}`)
    if (snapshot.recent_events.length) {
      lines.push("- recent_events:")
      for (const event of snapshot.recent_events) {
        lines.push(`  - ${event.kind} @ ${new Date(event.at).toISOString()}: ${clipText(event.summary, 140)}`)
      }
    }
    lines.push("")
  }
  return lines.join("\n")
}

function renderExperience(exp: Experience) {
  return [
    `# ${exp.title}`,
    "",
    `- kind: ${exp.kind}`,
    `- scope: ${exp.scope}`,
    exp.task_type ? `- task_type: ${exp.task_type}` : "",
    `- observations: ${exp.observations.length}`,
    `- refined: ${exp.refinement_history.length} time(s)`,
    `- created_at: ${new Date(exp.created_at).toISOString()}`,
    `- last_refined_at: ${new Date(exp.last_refined_at).toISOString()}`,
    "",
    "## Abstract",
    "",
    exp.abstract,
    "",
    exp.statement ? "## Statement\n\n" + exp.statement + "\n" : "",
    exp.trigger_condition ? "## Trigger Condition\n\n" + exp.trigger_condition + "\n" : "",
    "## Observations",
    "",
    ...exp.observations.map(
      (o) =>
        `- ${new Date(o.observed_at).toISOString()} · session ${o.session_id} · msg ${o.message_id} · ${clipText(
          o.user_text,
          120,
        )}`,
    ),
    "",
  ]
    .filter((line) => line !== "")
    .join("\n")
}

// -----------------------------------------------------------------------------
// Taxonomy persistence
// -----------------------------------------------------------------------------

type TaxonomyEntry = {
  slug: string
  count: number
  first_seen_at: number
  last_seen_at: number
  sample_experience_ids: string[]
}

type CategoryEntry = {
  slug: string
  count: number
  first_seen_at: number
  last_seen_at: number
  experience_ids: string[]
}

type TaxonomyFile = {
  core: CoreKind[]
  custom: Record<string, TaxonomyEntry>
  categories: Record<string, CategoryEntry>
}

async function readTaxonomy(): Promise<TaxonomyFile> {
  const cfg = await settings()
  const filepath = path.join(cfg.base, "taxonomy.json")
  const raw = await Filesystem.readText(filepath).catch(() => undefined)
  if (!raw) return { core: [...CORE_KINDS], custom: {}, categories: {} }
  try {
    const parsed = JSON.parse(raw) as Partial<TaxonomyFile>
    return {
      core: [...CORE_KINDS],
      custom: parsed.custom ?? {},
      categories: parsed.categories ?? {},
    }
  } catch {
    return { core: [...CORE_KINDS], custom: {}, categories: {} }
  }
}

async function writeTaxonomy(data: TaxonomyFile) {
  const cfg = await settings()
  const filepath = path.join(cfg.base, "taxonomy.json")
  await Filesystem.write(filepath, JSON.stringify(data, null, 2))
}

async function registerCustomKind(kind: Kind, experienceID: string) {
  if (!kind.startsWith("custom:")) return
  const slug = kind.slice("custom:".length)
  const taxonomy = await readTaxonomy()
  const existing = taxonomy.custom[slug]
  const now = nowMs()
  if (existing) {
    existing.count += 1
    existing.last_seen_at = now
    existing.sample_experience_ids = [
      ...new Set([...existing.sample_experience_ids, experienceID]),
    ].slice(-5)
  } else {
    taxonomy.custom[slug] = {
      slug,
      count: 1,
      first_seen_at: now,
      last_seen_at: now,
      sample_experience_ids: [experienceID],
    }
  }
  await writeTaxonomy(taxonomy)
}

async function listKinds() {
  const taxonomy = await readTaxonomy()
  return {
    core: CORE_KINDS.map((k) => ({ slug: k, description: CORE_KIND_DESCRIPTIONS[k] })),
    custom: Object.values(taxonomy.custom).sort((a, b) => b.count - a.count),
  }
}

async function registerCategory(rawSlug: string, experienceID: string) {
  const slug = slugifyCategory(rawSlug)
  if (!slug) return
  const taxonomy = await readTaxonomy()
  const existing = taxonomy.categories[slug]
  const now = nowMs()
  if (existing) {
    existing.count += 1
    existing.last_seen_at = now
    existing.experience_ids = [...new Set([...existing.experience_ids, experienceID])]
  } else {
    taxonomy.categories[slug] = {
      slug,
      count: 1,
      first_seen_at: now,
      last_seen_at: now,
      experience_ids: [experienceID],
    }
  }
  await writeTaxonomy(taxonomy)
}

async function listCategories() {
  const taxonomy = await readTaxonomy()
  return {
    categories: Object.values(taxonomy.categories).sort((a, b) => b.count - a.count),
  }
}

// -----------------------------------------------------------------------------
// Observation I/O
// -----------------------------------------------------------------------------

function observationFilepath(base: string, observation: Observation) {
  const safe = sha1Short(observation.id, 16)
  return path.join(base, "observations", observation.session_id, `${safe}.md`)
}

async function writeObservation(observation: Observation) {
  const cfg = await settings()
  const filepath = observationFilepath(cfg.base, observation)
  await writeMatter(
    filepath,
    observation as unknown as Record<string, unknown>,
    renderObservation(observation),
  )
  return filepath
}

/**
 * Agents whose user messages should NOT be observed. The orchestrator
 * is the workflow master — its "user" turns are typically meta-commands
 * (start node, configure model, propose graph edit), not domain queries
 * worth precipitating as experiences. The user explicitly asked: only
 * refine the user's own query, not the orchestrator layer's prompts.
 *
 * If you add more meta/orchestration agents later, gate them here too.
 */
const NON_REFINABLE_AGENTS = new Set(["orchestrator"])

async function extractUserMessage(sessionID: SessionID, messageID: MessageID) {
  let message: MessageV2.WithParts
  try {
    // MessageV2.get is now synchronous and throws NotFoundError on miss.
    message = MessageV2.get({ sessionID, messageID })
  } catch {
    return
  }
  if (message.info.role !== "user") return
  // Skip user messages addressed to an orchestration-layer agent. These
  // are typically "create workflow X", "start node n2", "approve plan"
  // — operational commands, not generalisable user intent. Refining
  // them just inflates the experience library with noise.
  const agentName = (message.info as { agent?: string }).agent
  if (agentName && NON_REFINABLE_AGENTS.has(agentName)) {
    log.debug("refiner.observe: skipping orchestrator-bound user message", {
      sessionID,
      messageID,
      agent: agentName,
    })
    return
  }
  const text = message.parts
    .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text.trim()] : []))
    .filter(Boolean)
    .join("\n")
    .trim()
  if (!text) return
  const signature = Hash.fast(text)
  const current = state()
  if (current.userSeen[messageID] === signature) return
  current.userSeen[messageID] = signature
  return { text, info: message.info }
}

async function captureObservation(input: {
  sessionID: string
  messageID: string
  text: string
  observedAt: number
  source?: Observation["source"]
}): Promise<Observation> {
  // Prior history (up to 3 messages before this one). Pulled identically for
  // live user messages and historical ingest so both paths give the refiner
  // LLM the same kind of temporal context. NOTE: these three messages are
  // temporally adjacent but not guaranteed topically relevant — the prompt
  // explicitly instructs the LLM to self-assess relevance before using them.
  const allMessages = await svcSessionMessages({
    sessionID: SessionID.make(input.sessionID),
    limit: 40,
  })
  const prior = allMessages
    .filter((m) => m.info.id !== input.messageID && m.info.time.created < input.observedAt)
    .sort((a, b) => a.info.time.created - b.info.time.created)
    .slice(-3)
    .map((m) => ({
      role: m.info.role === "user" ? ("user" as const) : ("assistant" as const),
      text: clipText(messageText(m), 320),
      message_id: m.info.id,
    }))

  // Optional workflow snapshot. Absent for sessions that predate the workflow
  // runtime (Workflow.bySession returns nothing) — that's fine, the schema
  // field is optional and the prompt handles its absence gracefully.
  let workflowSnapshot: Observation["agent_context"]["workflow_snapshot"]
  const byResult = await Workflow.bySession(SessionID.make(input.sessionID)).catch(() => undefined)
  if (byResult) {
    const snapshot = await Workflow.get(byResult.workflow.id).catch(() => undefined)
    if (snapshot) {
      workflowSnapshot = {
        workflow_id: snapshot.workflow.id,
        node_id: snapshot.runtime.active_node_id,
        phase: snapshot.runtime.phase,
        recent_events: snapshot.events.slice(-8).map((event) => ({
          kind: event.kind,
          at: event.time_created,
          summary: clipText(eventText(event), 160),
        })),
      }
    }
  }

  const observation: Observation = {
    id: `${input.sessionID}:${input.messageID}:${input.observedAt}`,
    observed_at: input.observedAt,
    session_id: input.sessionID,
    message_id: input.messageID,
    user_text: input.text,
    ...(input.source ? { source: input.source } : {}),
    agent_context: {
      session_history_excerpt: prior,
      workflow_snapshot: workflowSnapshot,
    },
  }
  await writeObservation(observation)
  return observation
}

// -----------------------------------------------------------------------------
// Experience I/O
// -----------------------------------------------------------------------------

function experienceFilepath(base: string, exp: Pick<Experience, "id" | "kind">) {
  const kindDir = exp.kind.replace(":", "_")
  return path.join(base, "experiences", kindDir, `${exp.id}.md`)
}

async function writeExperience(exp: Experience) {
  const cfg = await settings()
  const filepath = experienceFilepath(cfg.base, exp)
  await writeMatter(filepath, exp as unknown as Record<string, unknown>, renderExperience(exp))
  return filepath
}

async function listExperiences(): Promise<ExperienceWithPath[]> {
  const cfg = await settings()
  const files = (
    await Glob.scan("experiences/**/*.md", { cwd: cfg.base, absolute: true, dot: true }).catch(() => [])
  ).sort()
  const result: ExperienceWithPath[] = []
  for (const file of files) {
    const doc = await readMatter(file).catch(() => undefined)
    if (!doc) continue
    const parsed = ExperienceSchema.safeParse(doc.data)
    if (!parsed.success) {
      log.warn("skipping experience with invalid schema", { file, error: parsed.error.message })
      continue
    }
    result.push({ ...parsed.data, path: rel(file) })
  }
  return result
}

async function getExperienceByID(id: string): Promise<ExperienceWithPath | undefined> {
  const all = await listExperiences()
  return all.find((exp) => exp.id === id)
}

function summarizeExperience(exp: Experience): ExperienceSummary {
  return {
    id: exp.id,
    kind: exp.kind,
    title: clipText(exp.title, 60),
    abstract: clipText(exp.abstract, 200),
    task_type: exp.task_type,
    observation_count: exp.observations.length,
    last_refined_at: exp.last_refined_at,
  }
}

// -----------------------------------------------------------------------------
// Rejected log
// -----------------------------------------------------------------------------

async function appendRejected(entry: {
  at: number
  reason: string
  observation_id: string
  session_id: string
  message_id: string
  excerpt: string
  stage: "route" | "abstract_guard"
}) {
  const cfg = await settings()
  const filepath = path.join(cfg.base, "rejected.ndjson")
  const existing = (await Filesystem.readText(filepath).catch(() => "")) ?? ""
  const line = JSON.stringify(entry) + "\n"
  await Filesystem.write(filepath, existing + line)
}

// -----------------------------------------------------------------------------
// Runtime config override (persisted at .opencode/refiner-memory/config.json)
// -----------------------------------------------------------------------------

const ConfigOverrideSchema = z.object({
  model: z
    .object({
      providerID: z.string().min(1),
      modelID: z.string().min(1),
    })
    .optional(),
  temperature: z.number().min(0).max(2).optional(),
  /* Per-project switch for the per-message auto-precipitate hook.
   * When false, `observeUserMessage` short-circuits and the refiner
   * stops burning tokens on every user message (the user asked for
   * this as a token-cost control). Manual refiner triggers via the
   * UI are unaffected. Falls back to
   * `experimental.refiner.auto_enabled` from global config, then to
   * `true` as the default. */
  auto_enabled: z.boolean().optional(),
})
type ConfigOverride = z.infer<typeof ConfigOverrideSchema>

async function configOverridePath() {
  const cfg = await settings()
  return path.join(cfg.base, "config.json")
}

async function readConfigOverride(): Promise<ConfigOverride | undefined> {
  try {
    const p = await configOverridePath()
    if (!(await Filesystem.exists(p))) return undefined
    const raw = await Filesystem.readJson<unknown>(p).catch(() => undefined)
    if (!raw) return undefined
    const parsed = ConfigOverrideSchema.safeParse(raw)
    if (!parsed.success) {
      log.warn("refiner config override invalid; ignoring", { error: parsed.error.message })
      return undefined
    }
    return parsed.data
  } catch {
    return undefined
  }
}

async function writeConfigOverride(next: ConfigOverride): Promise<void> {
  const p = await configOverridePath()
  await Filesystem.writeJson(p, next)
}

// -----------------------------------------------------------------------------
// LLM model resolution
// -----------------------------------------------------------------------------

type ModelSource = "override" | "agent" | "default"

async function resolveRefinerModel() {
  const agent = await svcAgentGet("refiner")
  if (!agent) return

  // 1. Runtime override (PUT /experimental/refiner/config) takes highest priority
  const override = await readConfigOverride()
  if (override?.model) {
    const model = await withTimeout(
      svcProviderGetModel(
        ProviderID.make(override.model.providerID),
        ModelID.make(override.model.modelID),
      ),
      300,
    )
    if (model) return { agent, model, selected: override.model, source: "override" as ModelSource }
    // override points to an unreachable model: fall through, but log once
    log.warn("refiner override model unavailable; falling back", { override: override.model })
  }

  // 2. Static agent config (opencode.jsonc: agent.refiner.model)
  if (agent.model) {
    const model = await withTimeout(
      svcProviderGetModel(agent.model.providerID, agent.model.modelID),
      300,
    )
    if (model) return { agent, model, selected: agent.model, source: "agent" as ModelSource }
  }

  // 3. Provider default + small-model fallback
  const selected = await withTimeout(svcProviderDefaultModel(), 300)
  if (!selected) return

  const model =
    (await withTimeout(svcProviderGetSmallModel(selected.providerID), 300)) ??
    (await withTimeout(svcProviderGetModel(selected.providerID, selected.modelID), 300))
  if (!model) return

  return { agent, model, selected, source: "default" as ModelSource }
}

// -----------------------------------------------------------------------------
// Read-only tools for refiner agent
// -----------------------------------------------------------------------------

function createRefinerTools(input: { observation: Observation }) {
  return {
    get_session_history: tool({
      description: "Read more messages from the session if the inline history (前 3 条) is insufficient.",
      inputSchema: z.object({
        session_id: z.string().optional(),
        limit: z.number().int().positive().max(40).optional(),
      }),
      execute: async ({ session_id, limit }) => {
        const sessionID = session_id ?? input.observation.session_id
        const messages = await svcSessionMessages({
          sessionID: SessionID.make(sessionID),
          limit: limit ?? 20,
        })
        return messages.slice(-1 * (limit ?? 20)).map((message) => ({
          id: message.info.id,
          role: message.info.role,
          created_at: message.info.time.created,
          text: clipText(messageText(message), 320),
        }))
      },
    }),
    get_experience_detail: tool({
      description:
        "Fetch full detail (all observations and refinement history) of an existing experience by id, before deciding to attach or create new.",
      inputSchema: z.object({ experience_id: z.string() }),
      execute: async ({ experience_id }) => {
        const exp = await getExperienceByID(experience_id)
        if (!exp) return { found: false }
        return {
          found: true,
          id: exp.id,
          kind: exp.kind,
          title: exp.title,
          abstract: exp.abstract,
          statement: exp.statement,
          trigger_condition: exp.trigger_condition,
          task_type: exp.task_type,
          scope: exp.scope,
          observation_count: exp.observations.length,
          observation_excerpts: exp.observations.slice(-5).map((o) => clipText(o.user_text, 200)),
        }
      },
    }),
    get_experience_neighbors: tool({
      description:
        "BFS traversal around a seed experience in the chain graph. Use this when you want to check whether a candidate is already wired into the graph, or to find plausible edge targets. Defaults: requires+refines edges, both directions, depth 2. Do not call more than twice per decision.",
      inputSchema: z.object({
        experience_id: z.string(),
        edge_kinds: z
          .array(z.enum(["requires", "refines", "supports", "contradicts", "see_also"]))
          .optional(),
        direction: z.enum(["in", "out", "both"]).optional(),
        max_depth: z.number().int().min(1).max(4).optional(),
      }),
      execute: async ({ experience_id, edge_kinds, direction, max_depth }) => {
        const exp = await getExperienceByID(experience_id)
        if (!exp) return { found: false }
        const cfg = await settings()
        const edges = await readEdgesRaw(cfg.base).catch(() => [] as ExperienceEdge[])
        const result = traverseFromSeed(edges, experience_id, {
          edgeKinds: (edge_kinds ?? ["requires", "refines"]) as EdgeKind[],
          direction: direction ?? "both",
          maxDepth: max_depth ?? 2,
        })
        const all = await listExperiences()
        const byID = new Map(all.map((e) => [e.id, e]))
        return {
          found: true,
          seed: experience_id,
          nodes: result.nodes.map((id) => {
            const n = byID.get(id)
            return {
              id,
              kind: n?.kind ?? null,
              title: n?.title ?? "<missing>",
              abstract: n ? clipText(n.abstract, 160) : "",
              depth: result.depth.get(id) ?? 0,
            }
          }),
          edges: result.edges.map((e) => ({
            id: e.id,
            from: e.from,
            to: e.to,
            kind: e.kind,
            reason: e.reason,
          })),
        }
      },
    }),
  }
}

// -----------------------------------------------------------------------------
// StructuredOutput helper
// -----------------------------------------------------------------------------

function createStructuredOutputTool(input: {
  schema: Record<string, unknown>
  onSuccess: (output: unknown) => void
}) {
  const { $schema, ...toolSchema } = input.schema as Record<string, unknown>
  void $schema
  return tool({
    description:
      "Emit the final structured decision. Call exactly once after any optional retrieval, and do not call again.",
    inputSchema: jsonSchema(toolSchema as Record<string, unknown>),
    async execute(args) {
      input.onSuccess(args)
      return { output: "Structured decision captured." }
    },
  })
}

// -----------------------------------------------------------------------------
// LLM call: route (attach | new | noise)
// -----------------------------------------------------------------------------

async function routeObservation(input: {
  observation: Observation
  existing: ExperienceSummary[]
  /** Optional recorder — when present, captures the LLM call's trace so
   *  the caller can append it to a `RefinerLogEntry`. */
  recorder?: RefinerLlmRecorder
}): Promise<RouteDecision[]> {
  if (testRouteOverride) {
    try {
      const override = await testRouteOverride(input.observation, input.existing)
      if (override) return Array.isArray(override) ? override : [override]
    } catch (error) {
      log.warn("route test override failed", { error })
    }
  }

  const resolved = await resolveRefinerModel()
  if (!resolved?.model) return []
  const language = await svcProviderGetLanguage(resolved.model)
  if (!language) return []
  const auth = await svcAuthGet(resolved.model.providerID)
  const cfg = await svcConfigGet()
  const isOpenaiOauth = resolved.model.providerID === "openai" && auth?.type === "oauth"

  const systemPrompt = resolved.agent.prompt
  const kinds = await listKinds()
  const categories = (await listCategories().catch(() => ({ categories: [] }))).categories
  const userPayload = {
    task: "route",
    observation: input.observation,
    existing_experiences: input.existing,
    kinds,
    categories,
  }

  const tools = createRefinerTools({ observation: input.observation })
  const decisions: RouteDecision[] = []
  let routeStructuredOutput: unknown = undefined
  // We tell the LLM the expected shape is the array wrapper. The legacy
  // single-decision shape is still accepted in the fallback below in case a
  // model stubbornly emits the old contract; downstream code sees an array
  // either way.
  const schema = ProviderTransform.schema(
    resolved.model,
    applyKindConstraint(z.toJSONSchema(RouteDecisionsWireSchema)),
  ) as Record<string, unknown>

  const messages: ModelMessage[] = [
    ...(isOpenaiOauth || !systemPrompt
      ? []
      : ([{ role: "system", content: systemPrompt }] as ModelMessage[])),
    { role: "user", content: JSON.stringify(userPayload, null, 2) },
  ]

  const collectWire = (wires: RouteDecisionWire[]) => {
    for (const wire of wires) {
      const normalized = normalizeRouteDecision(wire)
      if ("error" in normalized) {
        log.warn("route output failed normalization", { error: normalized.error, wire })
        continue
      }
      decisions.push(normalized)
    }
  }

  const params = {
    experimental_telemetry: {
      isEnabled: cfg?.experimental?.openTelemetry,
      metadata: { userId: cfg?.username ?? "unknown" },
    },
    temperature: 0.1,
    messages,
    model: language,
    tools: {
      ...tools,
      StructuredOutput: createStructuredOutputTool({
        schema,
        onSuccess(output) {
          routeStructuredOutput = output
          // Preferred shape: { decisions: [...] }
          const multi = RouteDecisionsWireSchema.safeParse(output)
          if (multi.success) {
            collectWire(multi.data.decisions)
            return
          }
          // Resilience path: legacy single-decision shape. We still accept it
          // so an LLM that ignores the new contract does not silently drop
          // observations on the floor. The normalizeRouteDecision call below
          // validates all of action/kind/title/abstract/scope fields.
          const single = RouteDecisionWireSchema.safeParse(output)
          if (single.success) {
            log.info("route output used legacy single-decision shape", {
              observation_id: input.observation.id,
            })
            collectWire([single.data])
            return
          }
          log.warn("route output failed schema", {
            error: multi.error.message,
            legacy_error: single.error.message,
            raw_kind: (output as any)?.kind,
            raw_action: (output as any)?.action,
          })
        },
      }),
    },
    providerOptions: ProviderTransform.providerOptions(resolved.model, {
      instructions: systemPrompt ?? "",
      store: false,
    }),
    stopWhen: stepCountIs(6),
  } satisfies Parameters<typeof generateText>[0]

  // Capture the LLM call into a recorder slot so the caller can fold
  // it into the final RefinerLogEntry. We always record the request
  // side (prompts) so the user sees the exact input even on failure.
  const callT0 = Date.now()
  const trace: RefinerLlmCall = {
    stage: "route",
    provider_id: resolved.model.providerID,
    model_id: resolved.model.api.id,
    system_prompt: systemPrompt,
    user_prompt: JSON.stringify(userPayload, null, 2),
    duration_ms: 0,
  }

  try {
    if (isOpenaiOauth) {
      const result = streamText({ ...params, onError: () => {} })
      for await (const part of result.fullStream) {
        if (part.type === "error") throw part.error
      }
      try { trace.response_text = await result.text } catch {}
      try { trace.reasoning_text = await result.reasoningText } catch {}
    } else {
      const result = await generateText(params)
      trace.response_text = (result as { text?: string }).text
      trace.reasoning_text = (result as { reasoningText?: string }).reasoningText
    }
  } catch (error) {
    log.warn("refiner route LLM failed", { error })
    trace.error = error instanceof Error ? error.message : String(error)
    trace.duration_ms = Date.now() - callT0
    input.recorder?.(trace)
    return []
  }

  if (routeStructuredOutput !== undefined) trace.structured_output = routeStructuredOutput
  trace.duration_ms = Date.now() - callT0
  input.recorder?.(trace)

  return decisions
}

// -----------------------------------------------------------------------------
// LLM call: refine (regenerate title/abstract/kind over all observations)
// -----------------------------------------------------------------------------

async function refineExperience(input: {
  experience: Experience
  triggerObservation: Observation
  /** Optional recorder — when present, captures the LLM call's trace. */
  recorder?: RefinerLlmRecorder
}): Promise<RefineOutput | undefined> {
  if (testRefineOverride) {
    try {
      const override = await testRefineOverride(input.triggerObservation, input.experience)
      if (override) return override
    } catch (error) {
      log.warn("refine test override failed", { error })
    }
  }

  const resolved = await resolveRefinerModel()
  if (!resolved?.model) return
  const language = await svcProviderGetLanguage(resolved.model)
  if (!language) return
  const auth = await svcAuthGet(resolved.model.providerID)
  const cfg = await svcConfigGet()
  const isOpenaiOauth = resolved.model.providerID === "openai" && auth?.type === "oauth"
  const systemPrompt = resolved.agent.prompt

  // Sample: most recent 8 + oldest 2 (with no dup)
  const obs = input.experience.observations
  const recent = obs.slice(-8)
  const oldest = obs.slice(0, 2).filter((o) => !recent.includes(o))
  const sampled = [...oldest, ...recent]

  const payload = {
    task: "refine",
    current: {
      id: input.experience.id,
      kind: input.experience.kind,
      title: input.experience.title,
      abstract: input.experience.abstract,
      statement: input.experience.statement,
      trigger_condition: input.experience.trigger_condition,
      task_type: input.experience.task_type,
      scope: input.experience.scope,
    },
    observations: sampled.map((o) => ({
      observed_at: o.observed_at,
      user_text: o.user_text,
      // Surface the user's manual note so refine can actually incorporate
      // explicitly provided guidance. Previously this field was dropped and
      // the LLM only saw user_text, leaving manual augments effectively
      // invisible to refinement.
      note: o.note,
      source: o.source,
      history: o.agent_context.session_history_excerpt,
      workflow: o.agent_context.workflow_snapshot,
    })),
    kinds: await listKinds(),
    categories: (await listCategories().catch(() => ({ categories: [] }))).categories,
    trigger_observation_id: input.triggerObservation.id,
  }

  let output: RefineOutput | undefined
  let refineStructuredOutput: unknown = undefined
  const schema = ProviderTransform.schema(
    resolved.model,
    applyKindConstraint(z.toJSONSchema(RefineOutputSchema)),
  ) as Record<string, unknown>

  const refineDirective =
    "TASK = refine. 你正在根据全部 observations 重新生成一个 experience。\n" +
    "必须调用 StructuredOutput 工具，并且输出对象要**完整填写** kind / title / abstract / scope；" +
    "不确定的 optional 字段（statement / trigger_condition / task_type / categories / conflicts_with）请**省略**，不要提交空串或占位符。\n" +
    "abstract 必须是简体中文对 observations 的归纳，绝不能输出诸如 'not used' / 'ignore' / 'placeholder' 这类英文说明。\n" +
    "以下 JSON 是 refine 任务的输入（注意顶层 task 字段）：\n"

  const messages: ModelMessage[] = [
    ...(isOpenaiOauth || !systemPrompt
      ? []
      : ([{ role: "system", content: systemPrompt }] as ModelMessage[])),
    { role: "user", content: refineDirective + JSON.stringify(payload, null, 2) },
  ]

  const params = {
    experimental_telemetry: {
      isEnabled: cfg?.experimental?.openTelemetry,
      metadata: { userId: cfg?.username ?? "unknown" },
    },
    temperature: 0.1,
    messages,
    model: language,
    tools: {
      StructuredOutput: createStructuredOutputTool({
        schema,
        onSuccess(raw) {
          refineStructuredOutput = raw
          const parsed = RefineOutputSchema.safeParse(raw)
          if (parsed.success) output = parsed.data
          else
            log.warn("refine output failed schema", {
              error: parsed.error.message,
              raw_kind: (raw as any)?.kind,
              raw_title: (raw as any)?.title,
            })
        },
      }),
    },
    providerOptions: ProviderTransform.providerOptions(resolved.model, {
      instructions: systemPrompt ?? "",
      store: false,
    }),
    stopWhen: stepCountIs(4),
  } satisfies Parameters<typeof generateText>[0]

  // Capture for the recorder, mirroring routeObservation.
  const callT0 = Date.now()
  const trace: RefinerLlmCall = {
    stage: "refine",
    provider_id: resolved.model.providerID,
    model_id: resolved.model.api.id,
    system_prompt: systemPrompt,
    user_prompt: refineDirective + JSON.stringify(payload, null, 2),
    duration_ms: 0,
  }

  try {
    if (isOpenaiOauth) {
      const result = streamText({ ...params, onError: () => {} })
      for await (const part of result.fullStream) {
        if (part.type === "error") throw part.error
      }
      try { trace.response_text = await result.text } catch {}
      try { trace.reasoning_text = await result.reasoningText } catch {}
    } else {
      const result = await generateText(params)
      trace.response_text = (result as { text?: string }).text
      trace.reasoning_text = (result as { reasoningText?: string }).reasoningText
    }
  } catch (error) {
    log.warn("refiner refine LLM failed", { error })
    trace.error = error instanceof Error ? error.message : String(error)
    trace.duration_ms = Date.now() - callT0
    input.recorder?.(trace)
    return
  }

  if (refineStructuredOutput !== undefined) trace.structured_output = refineStructuredOutput
  trace.duration_ms = Date.now() - callT0
  input.recorder?.(trace)

  return output
}

// -----------------------------------------------------------------------------
// Originality guard
// -----------------------------------------------------------------------------

function abstractEqualsRaw(abstractText: string, observations: Observation[]) {
  const normalized = compactText(abstractText).slice(0, 200)
  if (!normalized) return true
  const abstractDigest = Hash.fast(normalized.toLowerCase())
  for (const obs of observations) {
    const rawHead = compactText(obs.user_text).slice(0, 200).toLowerCase()
    if (!rawHead) continue
    if (Hash.fast(rawHead) === abstractDigest) return true
    // fuzzy: if abstract is a contiguous slice of user_text
    if (rawHead.includes(normalized.toLowerCase())) return true
  }
  return false
}

/**
 * Detect abstracts that look like the model's own schema comments / placeholders
 * rather than a real distilled rule. The refine prompt describes BOTH the route
 * and the refine schemas, so a confused model sometimes emits the route-schema
 * comment "This is not used in route output; ignore" (or similar) as the
 * abstract. Catch that and treat it as an unacceptable refinement.
 */
function abstractLooksLikePlaceholder(abstractText: string) {
  const raw = compactText(abstractText)
  if (!raw) return true
  if (raw.length < 10) return true

  const lower = raw.toLowerCase()
  const placeholderPatterns = [
    /\bnot used\b/,
    /\bignore\b.*\b(if|this|field)\b/,
    /\bplaceholder\b/,
    /\bto be filled\b/,
    /\btbd\b/,
    /\bn\/a\b/,
    /route output/,
    /this (field|is) (is )?not/,
    /^<[^>]+>$/,
    /^".*"$/,
    /^\{[^{}]*\}$/,
  ]
  for (const p of placeholderPatterns) if (p.test(lower)) return true

  // If we expect Chinese natural language prose, reject output that is
  // overwhelmingly ASCII (likely an English schema comment).
  const chineseCount = (raw.match(/[\u4e00-\u9fff]/g) ?? []).length
  const asciiLetters = (raw.match(/[A-Za-z]/g) ?? []).length
  if (chineseCount === 0 && asciiLetters >= 4) return true
  return false
}

/**
 * Normalize optional string fields returned by the LLM: an empty / whitespace
 * string should be treated as "missing" so that downstream `?? existing` falls
 * through instead of overwriting the previous good value with "".
 */
function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

// -----------------------------------------------------------------------------
// Attach + refine
// -----------------------------------------------------------------------------

async function attachAndRefine(input: {
  experience: ExperienceWithPath
  observation: Observation
  categoryHints?: string[]
  conflictHints?: string[]
  historyKind?: "auto" | "manual_augment" | "re_refine"
}) {
  const resolved = await resolveRefinerModel()
  const modelTag = resolved?.selected ? `${resolved.selected.providerID}/${resolved.selected.modelID}` : "unknown"

  const snapshotExp: Experience = {
    ...input.experience,
    observations: [...input.experience.observations, input.observation],
  }

  // First attempt
  let refined = await refineExperience({ experience: snapshotExp, triggerObservation: input.observation })
  if (!refined) {
    log.warn("refine returned nothing on attach; leaving experience unchanged", {
      experience_id: snapshotExp.id,
    })
    return { attached: false as const, reason: "refine_failed" }
  }

  // Originality guard: retry once if abstract is essentially raw text OR
  // looks like a schema-comment/placeholder rather than a real distillation.
  const abstractInvalid = (r: RefineOutput) =>
    abstractEqualsRaw(r.abstract, snapshotExp.observations) ||
    abstractLooksLikePlaceholder(r.abstract)

  if (abstractInvalid(refined)) {
    log.info("abstract invalid (raw or placeholder); retrying once", {
      experience_id: snapshotExp.id,
      abstract_preview: clipText(refined.abstract, 120),
    })
    refined = await refineExperience({ experience: snapshotExp, triggerObservation: input.observation })
    if (!refined || abstractInvalid(refined)) {
      await appendRejected({
        at: nowMs(),
        reason: refined
          ? abstractLooksLikePlaceholder(refined.abstract)
            ? "abstract_placeholder_after_retry"
            : "abstract_equals_raw_after_retry"
          : "refine_failed_after_retry",
        observation_id: input.observation.id,
        session_id: input.observation.session_id,
        message_id: input.observation.message_id,
        excerpt: clipText(input.observation.user_text, 200),
        stage: "abstract_guard",
      })
      return { attached: false as const, reason: "abstract_not_abstract_enough" }
    }
  }

  // Coerce empty-string optional fields to undefined so that `?? existing`
  // preserves prior good values instead of overwriting them with "".
  refined = {
    ...refined,
    statement: blankToUndefined(refined.statement),
    trigger_condition: blankToUndefined(refined.trigger_condition),
    task_type: blankToUndefined(refined.task_type),
  }

  const prevDigest = sha1Short(compactText(input.experience.abstract).toLowerCase(), 12)
  const prevSnapshot: RefinementSnapshot = {
    title: input.experience.title,
    abstract: input.experience.abstract,
    statement: input.experience.statement,
    trigger_condition: input.experience.trigger_condition,
    task_type: input.experience.task_type,
    scope: input.experience.scope,
    kind: input.experience.kind,
    categories: input.experience.categories,
  }
  const mergedCategories = uniqueStrings([
    ...(snapshotExp.categories ?? []),
    ...(input.categoryHints ?? []),
    ...(refined.categories ?? []),
  ])
  const mergedConflicts = uniqueStrings([
    ...(snapshotExp.conflicts_with ?? []),
    ...(input.conflictHints ?? []),
    ...(refined.conflicts_with ?? []),
  ]).filter((id) => id !== snapshotExp.id)

  const next: Experience = {
    ...snapshotExp,
    kind: refined.kind,
    title: refined.title,
    abstract: refined.abstract,
    statement: refined.statement,
    trigger_condition: refined.trigger_condition,
    task_type: refined.task_type ?? snapshotExp.task_type,
    scope: refined.scope,
    categories: mergedCategories,
    conflicts_with: mergedConflicts,
    last_refined_at: nowMs(),
    refinement_history: [
      ...snapshotExp.refinement_history,
      {
        at: nowMs(),
        trigger_observation_id: input.observation.id,
        prev_abstract_digest: prevDigest,
        prev_snapshot: prevSnapshot,
        kind:
          input.historyKind ??
          (input.observation.source === "manual_augment"
            ? ("manual_augment" as const)
            : ("auto" as const)),
        source_ids: [input.observation.id],
        model: modelTag,
      },
    ],
  }

  // If kind changed, delete the old file so it moves to new kind dir
  if (next.kind !== input.experience.kind) {
    const cfg = await settings()
    const oldPath = experienceFilepath(cfg.base, input.experience)
    await unlink(oldPath).catch(() => {})
  }

  const filepath = await writeExperience(next)
  if (next.kind.startsWith("custom:")) await registerCustomKind(next.kind, next.id)
  for (const slug of next.categories ?? []) await registerCategory(slug, next.id)
  return { attached: true as const, experience: { ...next, path: rel(filepath) } }
}

// -----------------------------------------------------------------------------
// Create new
// -----------------------------------------------------------------------------

async function createExperience(input: {
  observation: Observation
  proposal: Extract<RouteDecision, { action: "new" }>
  /**
   * Default "pending" — experiences born from the auto-router go to the review
   * queue. Manual creation paths (UI form, agent-assisted createExperienceFromText)
   * pass "approved" because the user already vetted them by initiating creation.
   */
  reviewStatus?: "pending" | "approved" | "rejected"
}): Promise<ExperienceWithPath | undefined> {
  // Originality + placeholder guard
  if (
    abstractEqualsRaw(input.proposal.abstract, [input.observation]) ||
    abstractLooksLikePlaceholder(input.proposal.abstract)
  ) {
    await appendRejected({
      at: nowMs(),
      reason: abstractLooksLikePlaceholder(input.proposal.abstract)
        ? "new_abstract_placeholder"
        : "new_abstract_equals_raw",
      observation_id: input.observation.id,
      session_id: input.observation.session_id,
      message_id: input.observation.message_id,
      excerpt: clipText(input.observation.user_text, 200),
      stage: "abstract_guard",
    })
    return
  }

  const id = sha1Short(`${input.observation.id}:${input.proposal.kind}:${input.proposal.title}:${nowMs()}`, 12)
  const exp: Experience = {
    id,
    kind: input.proposal.kind,
    title: input.proposal.title,
    abstract: input.proposal.abstract,
    statement: blankToUndefined(input.proposal.statement),
    trigger_condition: blankToUndefined(input.proposal.trigger_condition),
    task_type: blankToUndefined(input.proposal.task_type),
    scope: input.proposal.scope,
    target_layer: "both",
    categories: input.proposal.categories ?? [],
    observations: [input.observation],
    related_experience_ids: [],
    conflicts_with: [],
    refinement_history: [],
    archived: false,
    review_status: input.reviewStatus ?? "pending",
    reviewed_at: input.reviewStatus && input.reviewStatus !== "pending" ? nowMs() : undefined,
    created_at: nowMs(),
    last_refined_at: nowMs(),
  }
  const filepath = await writeExperience(exp)
  if (exp.kind.startsWith("custom:")) await registerCustomKind(exp.kind, exp.id)
  for (const slug of exp.categories ?? []) await registerCategory(slug, exp.id)
  return { ...exp, path: rel(filepath) }
}

// -----------------------------------------------------------------------------
// Main entry
// -----------------------------------------------------------------------------

async function observeObservation(observation: Observation) {
  // Recorder + outcome tracking — folded into a RefinerLogEntry at the
  // bottom so the Knowledge "Logs" UI can show every refiner run, even
  // ones the LLM classed as noise / dropped / errored ("没有沉淀的 query").
  const startedAt = nowMs()
  const llmCalls: RefinerLlmCall[] = []
  const recorder: RefinerLlmRecorder = (call) => llmCalls.push(call)
  const touchedExpIds = new Set<string>()
  const decisionSummaries: unknown[] = []
  let outcome: RefinerLogEntry["outcome"] = "dropped"
  let outcomeReason: string | undefined
  const writeLog = () =>
    appendRefinerLog({
      id: "rf_" + Hash.fast(`${observation.id}:${startedAt}`).slice(0, 12),
      created_at: startedAt,
      duration_ms: nowMs() - startedAt,
      trigger: "auto",
      session_id: observation.session_id,
      message_id: observation.message_id,
      observation_id: observation.id,
      user_text: clipText(observation.user_text, 600),
      outcome,
      experience_ids: [...touchedExpIds],
      reason: outcomeReason,
      llm_calls: llmCalls,
    })

  const existingRaw = await listExperiences()
  const existing = existingRaw.map(summarizeExperience)

  const decisions = await routeObservation({ observation, existing, recorder })
  if (!decisions.length) {
    // No route output at all (LLM failure / empty array). Distinct from an
    // explicit noise decision — the observer file already captured the raw
    // input for later retry. We do still emit a refiner log entry so the
    // user can see *which* queries had a failed route LLM call.
    log.warn("refiner route produced no decisions", { observation_id: observation.id })
    outcome = llmCalls.some((c) => c.error) ? "error" : "dropped"
    outcomeReason = "route produced no decisions"
    void writeLog()
    return
  }

  // Tracking per-call de-duplication keys. Duplicate attach/new from a chatty
  // model are dropped rather than double-applied.
  const seenAttach = new Set<string>()
  const seenNew = new Set<string>()
  // Snapshot per iteration so that a freshly created exp is visible when a
  // later decision in the same batch references it.
  const liveExperiences = [...existingRaw]
  const liveExperienceIDs = new Set(liveExperiences.map((e) => e.id))
  // Edges proposed by this observation batch, accumulated into one transaction
  // so cycle checks see sibling edges created in the same batch.
  const pendingEdges: Array<{
    from: string
    to: string
    kind: EdgeKind
    reason: string
    confidence: number
    source_observation_id?: string
    created_by: "llm_route"
  }> = []

  for (const decision of decisions) {
    decisionSummaries.push(decision)
    if (decision.action === "noise") {
      // Track explicit-noise outcomes so the user can browse "queries
      // the agent ignored" in the Logs UI. We deliberately keep the
      // earliest non-noise outcome winning if there are multiple
      // decisions in the same batch.
      if (outcome === "dropped") {
        outcome = "noise"
        outcomeReason = decision.reason
      }
      await appendRejected({
        at: nowMs(),
        reason: decision.reason,
        observation_id: observation.id,
        session_id: observation.session_id,
        message_id: observation.message_id,
        excerpt: clipText(observation.user_text, 200),
        stage: "route",
      })
      continue
    }

    // Phase 2a: attach is deprecated. A forward-compat LLM may still emit it;
    // we log + reject to nudge the next turn towards new/edge_only.
    if (decision.action === "attach") {
      if (seenAttach.has(decision.experience_id)) continue
      seenAttach.add(decision.experience_id)
      log.info("refiner route attempted deprecated attach; dropping", {
        observation_id: observation.id,
        experience_id: decision.experience_id,
      })
      await appendRejected({
        at: nowMs(),
        reason: "attach_deprecated_phase2a",
        observation_id: observation.id,
        session_id: observation.session_id,
        message_id: observation.message_id,
        excerpt: clipText(observation.user_text, 200),
        stage: "route",
      })
      continue
    }

    if (decision.action === "edge_only") {
      // edge_only doesn't change exp content, but it does touch the
      // graph — note as "edge_only" unless something stronger lands.
      if (outcome === "dropped" || outcome === "noise") outcome = "edge_only"
      for (const e of decision.edges) {
        if (!e.from) continue
        // Defer endpoint-existence check to persist time (liveExperienceIDs is
        // authoritative for this call; anything else would be stale).
        if (!liveExperienceIDs.has(e.from) || !liveExperienceIDs.has(e.to)) {
          log.info("edge_only references unknown exp; dropping", {
            from: e.from,
            to: e.to,
            kind: e.kind,
          })
          continue
        }
        pendingEdges.push({
          from: e.from,
          to: e.to,
          kind: e.kind,
          reason: (e.reason ?? decision.reason ?? "").slice(0, 400),
          confidence: e.confidence ?? 0.7,
          source_observation_id: observation.id,
          created_by: "llm_route",
        })
      }
      continue
    }

    // new — optionally with edges referring to the freshly-created exp
    const key = `${decision.kind}::${decision.title}`
    if (seenNew.has(key)) {
      log.info("refiner route emitted duplicate new; skipping second", {
        observation_id: observation.id,
        kind: decision.kind,
        title: decision.title,
      })
      continue
    }
    seenNew.add(key)
    const created = await createExperience({ observation, proposal: decision })
    if (!created) continue
    outcome = "new_exp"
    outcomeReason = decision.reason
    touchedExpIds.add(created.id)
    liveExperiences.push(created)
    liveExperienceIDs.add(created.id)

    for (const e of decision.edges ?? []) {
      const from = e.from ?? created.id
      if (!liveExperienceIDs.has(from) || !liveExperienceIDs.has(e.to)) {
        log.info("new_with_edges references unknown exp; dropping", {
          from,
          to: e.to,
          kind: e.kind,
        })
        continue
      }
      if (from === e.to) continue
      pendingEdges.push({
        from,
        to: e.to,
        kind: e.kind,
        reason: (e.reason ?? decision.reason ?? "").slice(0, 400),
        confidence: e.confidence ?? 0.7,
        source_observation_id: observation.id,
        created_by: "llm_route",
      })
    }
  }

  if (pendingEdges.length > 0) {
    const cfg = await settings()
    const { results } = await persistEdgeBatch(cfg.base, pendingEdges, { max: 10 })
    const failures = results.filter((r) => !r.ok)
    if (failures.length > 0) {
      log.info("edge batch had non-applied proposals", {
        observation_id: observation.id,
        total: results.length,
        failed: failures.length,
      })
    }
  }

  // Final log entry — fire-and-forget so a slow disk doesn't stall
  // observation throughput. Errors are swallowed inside appendRefinerLog.
  void writeLog()
}

// -----------------------------------------------------------------------------
// Overview
// -----------------------------------------------------------------------------

function buildOverviewGraph(experiences: ExperienceWithPath[], chainEdges: ExperienceEdge[] = []) {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const expIDSet = new Set(experiences.map((e) => e.id))
  for (const exp of experiences) {
    const expNodeID = `experience:${exp.id}`
    nodes.push({
      id: expNodeID,
      type: "experience",
      label: clipText(exp.title, 60),
      secondary: clipText(exp.abstract, 120),
      kind: exp.kind,
      path: exp.path,
    })
    for (const obs of exp.observations) {
      const obsNodeID = `observation:${obs.id}`
      nodes.push({
        id: obsNodeID,
        type: "observation",
        label: clipText(obs.user_text, 60),
        secondary: new Date(obs.observed_at).toISOString(),
      })
      edges.push({ from: expNodeID, to: obsNodeID, kind: "has_observation" })
    }
    for (const relatedID of exp.related_experience_ids) {
      edges.push({ from: expNodeID, to: `experience:${relatedID}`, kind: "related" })
    }
  }
  // Phase 2a typed chain edges (requires / refines / supports / contradicts /
  // see_also). Only surface edges whose endpoints are both present in the
  // current overview slice; dangling edges stay hidden (will be pruned by
  // the integrity pass).
  for (const ce of chainEdges) {
    if (!expIDSet.has(ce.from) || !expIDSet.has(ce.to)) continue
    edges.push({
      from: `experience:${ce.from}`,
      to: `experience:${ce.to}`,
      kind: (`chain_${ce.kind}` as GraphEdge["kind"]),
      edge_id: ce.id,
      reason: ce.reason,
      confidence: ce.confidence,
    })
  }
  return { nodes, edges }
}

// -----------------------------------------------------------------------------
// Sidecar usage judge — LLM-as-judge for "did the agent actually USE
// the experiences we injected last turn?"
//
// Architectural decision (see docs/05-Retrieve-Agent-Design.md): the judge
// lives on the refiner side, not retrieve. Refiner is already a sidecar
// agent that sees session messages on every user msg; adding a usage
// judge to its lifecycle is cheaper than spinning a separate observer.
//
// Runs fire-and-forget after each user message. Reads the most recent
// retrieve log entry for the session that has picks, gathers the
// assistant text/tool calls produced AFTER it (and before the new user
// msg), then asks a small model: "which of these injected experiences did
// the agent apply?" — and bumps usage-stats accordingly.
//
// In-memory `judgedRetrieveEntries` set deduplicates so a process won't
// re-judge the same retrieve log entry on a restart-immune session. On
// restart we may re-judge once, which is acceptable noise.
// -----------------------------------------------------------------------------

const judgedRetrieveEntries = new Set<string>()

const UsageJudgeWireSchema = z.object({
  applied_experience_ids: z.array(z.string()).default([]),
  rationale: z.string().max(400).default(""),
})

type RetrieveLogPick = {
  experience_id: string
  kind: string
  title: string
  abstract?: string
  statement?: string
  source: string
}

type RetrieveLogRow = {
  id: string
  session_id: string
  turn_index: number
  agent_name: string
  picked: RetrieveLogPick[]
  llm_used: boolean
  duration_ms: number
  created_at: number
}

async function readRetrieveLogRaw(): Promise<RetrieveLogRow[]> {
  const { base } = await settings()
  const fp = path.join(base, "retrieve-log.ndjson")
  const raw = await Filesystem.readText(fp).catch(() => "")
  if (!raw) return []
  const out: RetrieveLogRow[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.picked)) {
        out.push(parsed as RetrieveLogRow)
      }
    } catch {
      // skip malformed
    }
  }
  return out
}

/**
 * Find the most recent retrieve log entry for a session that:
 *   - has at least one picked experience
 *   - was created BEFORE `asOf` (so the new user msg's row, if any, is
 *     excluded — we're judging what happened in the PREVIOUS turn)
 *   - hasn't already been judged in this process
 * Returns undefined if nothing eligible.
 */
async function findUnjudgedRetrieveEntry(
  sessionID: string,
  asOf: number,
): Promise<RetrieveLogRow | undefined> {
  const all = await readRetrieveLogRaw()
  const candidates = all
    .filter((e) => e.session_id === sessionID)
    .filter((e) => e.picked.length > 0)
    .filter((e) => e.created_at < asOf)
    .filter((e) => !judgedRetrieveEntries.has(e.id))
    .sort((a, b) => b.created_at - a.created_at)
  return candidates[0]
}

/**
 * Collect assistant text + tool calls produced between `since` and `until`
 * timestamps in this session. Truncates each item to keep prompt size
 * bounded (we don't need full tool outputs to judge "did the agent
 * follow the rule?").
 */
async function collectAssistantWork(
  sessionID: SessionID,
  since: number,
  until: number,
): Promise<string> {
  const messages = await svcSessionMessages({ sessionID, limit: 80 })
  const filtered = messages
    .filter((m) => {
      const t = m.info.time.created
      return t > since && t < until
    })
    .filter((m) => m.info.role === "assistant")
    .sort((a, b) => a.info.time.created - b.info.time.created)
  if (filtered.length === 0) return ""
  const lines: string[] = []
  for (const m of filtered) {
    for (const part of m.parts) {
      if (part.type === "text" && !part.synthetic && !part.ignored) {
        lines.push(part.text.slice(0, 800))
      } else if (part.type === "tool") {
        const argsStr =
          typeof (part as any).input === "object"
            ? JSON.stringify((part as any).input).slice(0, 300)
            : ""
        lines.push(`[tool ${part.tool}${argsStr ? " " + argsStr : ""}]`)
      }
    }
  }
  return lines.join("\n").slice(0, 6000)
}

async function judgePreviousTurnUsage(input: {
  sessionID: SessionID
  asOf: number
}): Promise<{ applied: string[]; entry_id?: string } | undefined> {
  const target = await findUnjudgedRetrieveEntry(input.sessionID, input.asOf)
  if (!target) return undefined

  // Mark immediately to avoid races within the same process.
  judgedRetrieveEntries.add(target.id)

  const work = await collectAssistantWork(
    input.sessionID,
    target.created_at,
    input.asOf,
  )
  if (!work.trim()) {
    log.debug("refiner.judge: no assistant work after retrieve entry", {
      entry_id: target.id,
    })
    return { applied: [], entry_id: target.id }
  }

  const resolved = await resolveRefinerModel()
  if (!resolved?.model) return undefined
  const language = await svcProviderGetLanguage(resolved.model)
  if (!language) return undefined
  const auth = await svcAuthGet(resolved.model.providerID)
  const cfg = await svcConfigGet()
  const isOpenaiOauth = resolved.model.providerID === "openai" && auth?.type === "oauth"

  const injected = target.picked.map((p) => ({
    id: p.experience_id,
    kind: p.kind,
    title: p.title,
    statement: p.statement,
    abstract: p.abstract ? p.abstract.slice(0, 220) : undefined,
  }))

  const systemPrompt = [
    "你是 retrieve usage judge，一个旁路评估角色。",
    "任务：根据 agent 这一轮的产出（文字 + 工具调用），判断它**实际遵循/应用了**注入经验中的哪几条。",
    "判断标准（严格）：",
    "  1. 对应规则在 agent 的代码改动、工具调用 args、或解释性文字中**有可观察的体现** → applied",
    "  2. 仅仅 agent 的文字里**提到了**经验主题、但没有动作 → 不算 applied",
    "  3. agent 完全没产出（空 turn）或产出与经验无关 → applied 为空数组",
    "  4. 不确定时 **不要** 算 applied — 漏报比误报代价小",
    "",
    "只调用 StructuredOutput 工具一次，给出 applied_experience_ids 数组（来自下面经验的 id）和一句 rationale。",
  ].join("\n")

  const userPayload = {
    task: "judge_usage",
    injected_experiences: injected,
    agent_work_excerpt: work,
  }

  const schema = ProviderTransform.schema(
    resolved.model,
    z.toJSONSchema(UsageJudgeWireSchema),
  ) as Record<string, unknown>

  let parsed: { applied_experience_ids: string[]; rationale: string } | undefined

  const messages: ModelMessage[] = [
    ...(isOpenaiOauth || !systemPrompt
      ? []
      : ([{ role: "system", content: systemPrompt }] as ModelMessage[])),
    { role: "user", content: JSON.stringify(userPayload, null, 2) },
  ]

  const params = {
    experimental_telemetry: {
      isEnabled: cfg?.experimental?.openTelemetry,
      metadata: { userId: cfg?.username ?? "unknown" },
    },
    temperature: 0,
    messages,
    model: language,
    tools: {
      StructuredOutput: createStructuredOutputTool({
        schema,
        onSuccess(output) {
          const wire = UsageJudgeWireSchema.safeParse(output)
          if (wire.success) parsed = wire.data
          else
            log.warn("usage judge output failed schema", {
              error: wire.error.message,
            })
        },
      }),
    },
    providerOptions: ProviderTransform.providerOptions(resolved.model, {
      instructions: systemPrompt,
      store: false,
    }),
    stopWhen: stepCountIs(3),
  } satisfies Parameters<typeof generateText>[0]

  try {
    if (isOpenaiOauth) {
      const result = streamText({ ...params, onError: () => {} })
      for await (const part of result.fullStream) {
        if (part.type === "error") throw part.error
      }
    } else {
      await generateText(params)
    }
  } catch (error) {
    log.warn("usage judge LLM failed", { error, entry_id: target.id })
    return undefined
  }

  if (!parsed) return undefined

  // Only count ids that were actually injected — guards against the LLM
  // hallucinating ids that weren't on the menu.
  const validIds = new Set(injected.map((e) => e.id))
  const applied = parsed.applied_experience_ids.filter((id) => validIds.has(id))

  if (applied.length > 0) {
    const { bumpUsageCited } = await import("./usage")
    await bumpUsageCited(applied)
    log.info("refiner.judge: usage cited", {
      entry_id: target.id,
      applied,
      rationale: parsed.rationale.slice(0, 120),
    })
  } else {
    log.debug("refiner.judge: no applied experiences", {
      entry_id: target.id,
      rationale: parsed.rationale.slice(0, 120),
    })
  }

  return { applied, entry_id: target.id }
}

// -----------------------------------------------------------------------------
// Public namespace
// -----------------------------------------------------------------------------

export namespace Refiner {
  export const RouteDecisionSchemaExport = RouteDecisionWireSchema
  export const RouteDecisionsSchemaExport = RouteDecisionsWireSchema
  export const RefineOutputSchemaExport = RefineOutputSchema
  export const ExperienceSchemaExport = ExperienceSchema
  export const ObservationSchemaExport = ObservationSchema
  export const RefinerLogEntrySchemaExport = RefinerLogEntrySchema

  /** Read the entire refiner activity log. Newest entries are at the
   *  end of the file; the caller may want to reverse for a most-recent-
   *  first display. Returns [] when the log file doesn't exist or is
   *  malformed — surfacing the empty case is safer than failing. */
  export async function readLog(): Promise<RefinerLogEntry[]> {
    return readRefinerLog()
  }

  export function setRouteOverrideForTest(
    override?:
      | ((
          observation: Observation,
          existing: ExperienceSummary[],
        ) => Promise<RouteDecision | RouteDecision[] | undefined>)
      | undefined,
  ) {
    testRouteOverride = override
  }

  export function setRefineOverrideForTest(
    override?:
      | ((observation: Observation, experience: Experience) => Promise<RefineOutput | undefined>)
      | undefined,
  ) {
    testRefineOverride = override
  }

  export async function observeUserMessage(input: { sessionID: SessionID; messageID: MessageID }) {
    const cfg = await settings()
    if (!cfg.enabled) return
    // Per-message auto-refinement gate. The user reported wanting a
    // switch to "stop refiner from running on every message" for
    // token cost control. Setting `experimental.refiner.auto_enabled
    // = false` skips the entire observe pipeline; manual triggers
    // from the refiner UI still work because they enter through
    // different entry points (ingestExperience / refineExisting).
    if (!cfg.auto_enabled) {
      log.debug("refiner.observe: auto_enabled=false, skipping per-message refine", {
        sessionID: input.sessionID,
        messageID: input.messageID,
      })
      return
    }
    // Slave/child sessions carry a parentID — they are spawned by the `task`
    // tool (see src/tool/task.ts:71) when a master/root agent dispatches work
    // to a sub-agent. In that case the "user" message is in fact a master
    // prompt, not real user intent, and must not be observed. Top-level user
    // sessions (UI new session, Session.fork) have parentID = undefined.
    const session = await svcSessionGet(input.sessionID)
    if (session?.parentID) {
      log.debug("refiner.observe: skipping child session (master→slave prompt)", {
        sessionID: input.sessionID,
        messageID: input.messageID,
        parentID: session.parentID,
      })
      return
    }

    // Sidecar usage judge: BEFORE we observe the new user message, judge
    // the previous turn's work — what experiences did the agent actually
    // apply when reacting to the previous user message? Fire-and-forget so
    // it can't block the main observation pipeline.
    void judgePreviousTurnUsage({
      sessionID: input.sessionID,
      asOf: Date.now(),
    }).catch((error) => {
      log.warn("refiner.judge: previous turn usage judge failed", { error })
    })

    const extracted = await extractUserMessage(input.sessionID, input.messageID).catch(() => undefined)
    if (!extracted) return
    const observation = await captureObservation({
      sessionID: input.sessionID,
      messageID: input.messageID,
      text: extracted.text,
      observedAt: extracted.info.time.created,
    })
    await observeObservation(observation).catch((error) => {
      log.warn("observeObservation failed", { error, observation_id: observation.id })
    })
  }

  /**
   * Manual entry point for the usage judge — exposed so backend tests and
   * future cron-style triggers can drive it without going through the user
   * message hook. The default trigger is the fire-and-forget call inside
   * `observeUserMessage` above.
   */
  export async function judgeUsage(input: { sessionID: SessionID; asOf?: number }) {
    return judgePreviousTurnUsage({ sessionID: input.sessionID, asOf: input.asOf ?? Date.now() })
  }

  /** Read aggregated injection / usage counters for all experiences. */
  export async function usageStats() {
    const { readStats } = await import("./usage")
    return readStats()
  }

  export async function experienceByID(id: string) {
    return getExperienceByID(id)
  }

  export async function experiences() {
    return listExperiences()
  }

  export async function taxonomy() {
    return listKinds()
  }

  export const ConfigOverrideSchemaExport = ConfigOverrideSchema

  export async function config() {
    const override = await readConfigOverride()
    const resolved = await resolveRefinerModel()
    return {
      resolved: resolved?.selected,
      source: (resolved?.source ?? "none") as ModelSource | "none",
      override: override ?? null,
    }
  }

  export async function setConfig(input: {
    model?: { providerID: string; modelID: string } | null
    temperature?: number | null
    auto_enabled?: boolean | null
  }) {
    const existing: ConfigOverride = (await readConfigOverride()) ?? {}
    const next: ConfigOverride = { ...existing }

    if ("model" in input) {
      if (input.model === null) {
        delete next.model
      } else if (input.model) {
        next.model = { providerID: input.model.providerID, modelID: input.model.modelID }
      }
    }

    if ("temperature" in input) {
      if (input.temperature === null) delete next.temperature
      else if (typeof input.temperature === "number") next.temperature = input.temperature
    }

    if ("auto_enabled" in input) {
      if (input.auto_enabled === null) delete next.auto_enabled
      else if (typeof input.auto_enabled === "boolean") next.auto_enabled = input.auto_enabled
    }

    await writeConfigOverride(next)
    return config()
  }

  // ---------- Delete + Archive + audit ----------

  async function appendAudit(file: "deleted.ndjson" | "merged.ndjson" | "ingested.ndjson", entry: Record<string, unknown>) {
    const cfg = await settings()
    const filepath = path.join(cfg.base, file)
    const existing = (await Filesystem.readText(filepath).catch(() => "")) ?? ""
    await Filesystem.write(filepath, existing + JSON.stringify(entry) + "\n")
  }

  export async function deleteExperience(id: string, options?: { cascadeObservations?: boolean; reason?: string }) {
    const cascade = options?.cascadeObservations ?? true
    const target = await getExperienceByID(id)
    if (!target) return { ok: false as const, error: "not_found" }
    const cfg = await settings()
    const expPath = experienceFilepath(cfg.base, target)
    await unlink(expPath).catch(() => {})
    let observationsRemoved = 0
    if (cascade) {
      for (const obs of target.observations) {
        await unlink(observationFilepath(cfg.base, obs)).catch(() => {})
        observationsRemoved++
      }
    }
    // Remove from other experiences' related/conflicts references
    const rest = await listExperiences()
    for (const exp of rest) {
      if (exp.id === id) continue
      const needsUpdate =
        exp.related_experience_ids.includes(id) || (exp.conflicts_with ?? []).includes(id)
      if (!needsUpdate) continue
      const next: Experience = {
        ...exp,
        related_experience_ids: exp.related_experience_ids.filter((x) => x !== id),
        conflicts_with: (exp.conflicts_with ?? []).filter((x) => x !== id),
      }
      await writeExperience(next)
    }
    // Phase 2a: strip any edges touching this experience so the graph never
    // carries dangling refs. Failures are non-fatal and audited in the log.
    await removeEdgesForExpRaw(cfg.base, id).catch((err) =>
      log.warn("removeEdgesForExp failed on delete", { err, id }),
    )
    await appendAudit("deleted.ndjson", {
      at: nowMs(),
      id: target.id,
      kind: target.kind,
      title: target.title,
      observations_removed: observationsRemoved,
      cascade,
      reason: options?.reason ?? "user_delete",
    })
    return { ok: true as const, observations_removed: observationsRemoved }
  }

  export async function setArchived(id: string, archived: boolean) {
    const target = await getExperienceByID(id)
    if (!target) return { ok: false as const, error: "not_found" }
    const next: Experience = {
      ...target,
      archived,
      archived_at: archived ? nowMs() : undefined,
    }
    const filepath = await writeExperience(next)
    return { ok: true as const, experience: { ...next, path: rel(filepath) } }
  }

  /**
   * Approve / reject / re-queue an experience. Auto-routed experiences land as
   * "pending" — they remain on disk but are filtered out of retrieval surfaces
   * until the user approves them. "rejected" is a soft-delete that preserves
   * the file for audit; the UI hides them by default but they're still
   * recoverable by flipping review_status back.
   */
  export async function setReviewStatus(
    id: string,
    status: "pending" | "approved" | "rejected",
  ) {
    const target = await getExperienceByID(id)
    if (!target) return { ok: false as const, error: "not_found" }
    const next: Experience = {
      ...target,
      review_status: status,
      reviewed_at: status === "pending" ? undefined : nowMs(),
    }
    const filepath = await writeExperience(next)
    return { ok: true as const, experience: { ...next, path: rel(filepath) } }
  }

  // ---------- Augment (user adds a manual observation) ----------

  export async function augmentExperience(input: {
    id: string
    user_text: string
    note?: string
  }) {
    const target = await getExperienceByID(input.id)
    if (!target) return { ok: false as const, error: "not_found" }
    const text = input.user_text?.trim()
    if (!text) return { ok: false as const, error: "empty_user_text" }

    const observedAt = nowMs()
    const manualID = `manual:${target.id}:${sha1Short(`${observedAt}:${text}`, 10)}`
    const observation: Observation = {
      id: manualID,
      observed_at: observedAt,
      session_id: "manual",
      message_id: manualID,
      user_text: text,
      source: "manual_augment",
      note: input.note,
      agent_context: {
        session_history_excerpt: [],
      },
    }
    await writeObservation(observation)

    const result = await attachAndRefine({
      experience: target,
      observation,
      historyKind: "manual_augment",
    })
    if (!result.attached) {
      return { ok: false as const, error: result.reason }
    }
    return { ok: true as const, experience: result.experience }
  }

  // ---------- Agent-assisted manual creation ----------

  export async function createExperienceFromText(input: {
    user_text: string
    kind_hint?: Kind
    scope_hint?: "workspace" | "project" | "repo" | "user"
    task_type_hint?: string
    note?: string
    /** When the call originates from the "From history" picker, the
     *  caller passes the source session/message ids so the resulting
     *  refiner-log entry shows up under the correct session in the
     *  Logs UI. Plain manual create leaves these undefined. */
    source_session_id?: string
    source_message_id?: string
  }) {
    const text = input.user_text?.trim()
    if (!text) return { ok: false as const, error: "empty_user_text" }

    // Recorder + log entry plumbing — same pattern as observeObservation.
    // We always produce a refiner-log entry, even on the user-text fallback
    // path, so the Knowledge Logs UI shows manual creates too.
    const startedAt = nowMs()
    const llmCalls: RefinerLlmCall[] = []
    const recorder: RefinerLlmRecorder = (call) => llmCalls.push(call)
    const touchedExpIds = new Set<string>()
    let outcome: RefinerLogEntry["outcome"] = "dropped"
    let outcomeReason: string | undefined
    const trigger: RefinerLogEntry["trigger"] = input.source_session_id ? "history" : "manual"

    const observedAt = startedAt
    const manualID = `manual-new:${sha1Short(`${observedAt}:${text}`, 10)}`
    const observation: Observation = {
      id: manualID,
      observed_at: observedAt,
      session_id: input.source_session_id ?? "manual",
      message_id: input.source_message_id ?? manualID,
      user_text: text,
      source: "manual_augment",
      note: input.note,
      agent_context: {
        session_history_excerpt: [],
      },
    }
    await writeObservation(observation)
    const writeLog = () =>
      appendRefinerLog({
        id: "rf_" + Hash.fast(`${manualID}:${startedAt}`).slice(0, 12),
        created_at: startedAt,
        duration_ms: nowMs() - startedAt,
        trigger,
        session_id: observation.session_id,
        message_id: observation.message_id,
        observation_id: manualID,
        user_text: clipText(text, 600),
        outcome,
        experience_ids: [...touchedExpIds],
        reason: outcomeReason,
        llm_calls: llmCalls,
      })

    // Run route to let the LLM pick category/kind, but force the action to "new":
    // we still leverage the full router because it sees existing categories/kinds.
    const existing = (await listExperiences()).map(summarizeExperience)
    const decisions = await routeObservation({ observation, existing, recorder })
    /* If the route LLM call failed (e.g. provider returned `choices: null`),
     * fall through to the synthesis branch below instead of hard-erroring with
     * `route_failed`. The user explicitly asked to create an experience —
     * better to produce one with a fallback kind than to drop their input on
     * the floor when the routing model is flaky. The synthesis branch will
     * either run `refineExperience` (if THAT call works) or, if that also
     * fails, the proposal is built from the user-provided hints + their
     * raw text. */

    // This endpoint's contract is "create one experience from this text".
    // If the router fanned out into multiple decisions, we pick the first
    // "new" as the seed. Any extra attach/new decisions from the same text
    // are ignored here — the caller asked for a single create. If no "new"
    // decision exists at all, we fall through to the synthesis branch so
    // the user still gets an experience (albeit without LLM-picked kind).
    const decisionNew = decisions.find((d): d is Extract<RouteDecision, { action: "new" }> => d.action === "new")
    let proposal: Extract<RouteDecision, { action: "new" }>
    if (decisionNew) {
      proposal = {
        ...decisionNew,
        kind: input.kind_hint ?? decisionNew.kind,
        scope: input.scope_hint ?? decisionNew.scope,
        task_type: input.task_type_hint ?? decisionNew.task_type,
      }
    } else {
      // Synthesize a minimal proposal by requesting a direct refine on a one-obs experience
      const skeleton: Experience = {
        id: "pending",
        kind: input.kind_hint ?? "know_how",
        title: clipText(text, 40),
        abstract: clipText(text, 180),
        scope: input.scope_hint ?? "workspace",
        target_layer: "both",
        task_type: input.task_type_hint,
        categories: [],
        observations: [observation],
        related_experience_ids: [],
        conflicts_with: [],
        refinement_history: [],
        archived: false,
        review_status: "approved",
        created_at: observedAt,
        last_refined_at: observedAt,
      }
      const refined = await refineExperience({ experience: skeleton, triggerObservation: observation, recorder })
      if (refined) {
        proposal = {
          action: "new",
          reason: "manual_create",
          kind: input.kind_hint ?? refined.kind,
          title: refined.title,
          abstract: refined.abstract,
          statement: refined.statement,
          trigger_condition: refined.trigger_condition,
          task_type: input.task_type_hint ?? refined.task_type,
          scope: input.scope_hint ?? refined.scope,
          categories: refined.categories,
          conflicts_with: refined.conflicts_with,
        }
      } else {
        /* Last-resort fallback: both the route LLM and the refine LLM failed
         * (provider quirk or transient outage). Build a minimal proposal
         * straight from the user's input + their hints so the experience
         * still lands on disk. The user can refine/edit later via the
         * card's Re-refine / Edit buttons once the model is healthy again. */
        log.warn("manual create — both route and refine LLM failed; using user-text fallback", {
          observation_id: observation.id,
        })
        proposal = {
          action: "new",
          reason: "manual_create_fallback",
          kind: input.kind_hint ?? "know_how",
          title: clipText(text, 40),
          abstract: clipText(text, 200),
          statement: undefined,
          trigger_condition: undefined,
          task_type: input.task_type_hint,
          scope: input.scope_hint ?? "workspace",
          categories: [],
          conflicts_with: [],
        }
      }
    }

    // Manual creation is user-initiated, so skip the review queue.
    const exp = await createExperience({ observation, proposal, reviewStatus: "approved" })
    if (!exp) {
      outcome = "error"
      outcomeReason = "abstract_guard_rejected"
      void writeLog()
      return { ok: false as const, error: "create_failed_abstract_guard" }
    }
    outcome = "new_exp"
    outcomeReason = proposal.reason
    touchedExpIds.add(exp.id)
    void writeLog()
    return { ok: true as const, experience: exp }
  }

  // ---------- Manual edit (no LLM) ----------

  export async function patchExperience(input: {
    id: string
    title?: string
    abstract?: string
    statement?: string | null
    trigger_condition?: string | null
    task_type?: string | null
    scope?: "workspace" | "project" | "repo" | "user"
    categories?: string[]
  }) {
    const target = await getExperienceByID(input.id)
    if (!target) return { ok: false as const, error: "not_found" }

    const changes: string[] = []
    const next: Experience = { ...target }
    if (input.title !== undefined && input.title !== target.title) {
      next.title = input.title
      changes.push("title")
    }
    if (input.abstract !== undefined && input.abstract !== target.abstract) {
      next.abstract = input.abstract
      changes.push("abstract")
    }
    if (input.statement !== undefined && input.statement !== target.statement) {
      next.statement = input.statement === null ? undefined : input.statement
      changes.push("statement")
    }
    if (input.trigger_condition !== undefined && input.trigger_condition !== target.trigger_condition) {
      next.trigger_condition = input.trigger_condition === null ? undefined : input.trigger_condition
      changes.push("trigger_condition")
    }
    if (input.task_type !== undefined && input.task_type !== target.task_type) {
      next.task_type = input.task_type === null ? undefined : input.task_type
      changes.push("task_type")
    }
    if (input.scope !== undefined && input.scope !== target.scope) {
      next.scope = input.scope
      changes.push("scope")
    }
    if (input.categories !== undefined) {
      const slugged = uniqueStrings(input.categories.map(slugifyCategory))
      if (slugged.join("|") !== (target.categories ?? []).join("|")) {
        next.categories = slugged
        changes.push("categories")
      }
    }
    if (changes.length === 0) return { ok: true as const, experience: { ...target, path: target.path } }

    const prevSnapshot: RefinementSnapshot = {
      title: target.title,
      abstract: target.abstract,
      statement: target.statement,
      trigger_condition: target.trigger_condition,
      task_type: target.task_type,
      scope: target.scope,
      kind: target.kind,
      categories: target.categories,
    }
    next.refinement_history = [
      ...target.refinement_history,
      {
        at: nowMs(),
        trigger_observation_id: "manual_edit",
        prev_abstract_digest: sha1Short(compactText(target.abstract).toLowerCase(), 12),
        prev_snapshot: prevSnapshot,
        kind: "manual_edit",
        source_ids: changes,
        model: "manual",
      },
    ]
    const filepath = await writeExperience(next)
    if (next.categories && next.categories.length > 0) {
      for (const slug of next.categories) await registerCategory(slug, next.id)
    }
    return { ok: true as const, experience: { ...next, path: rel(filepath) } }
  }

  // ---------- Manual re-refine (same observations) ----------

  export async function reRefine(id: string) {
    const target = await getExperienceByID(id)
    if (!target) return { ok: false as const, error: "not_found" }
    if (target.observations.length === 0) return { ok: false as const, error: "no_observations" }
    const trigger = target.observations[target.observations.length - 1]
    const result = await attachAndRefine({
      experience: { ...target, observations: target.observations.slice(0, -1), path: target.path },
      observation: trigger,
      historyKind: "re_refine",
    })
    if (!result.attached) return { ok: false as const, error: result.reason }
    return { ok: true as const, experience: result.experience }
  }

  // ---------- Undo last refinement ----------

  export async function undoRefinement(id: string) {
    const target = await getExperienceByID(id)
    if (!target) return { ok: false as const, error: "not_found" }
    const last = target.refinement_history[target.refinement_history.length - 1]
    if (!last || !last.prev_snapshot) {
      return { ok: false as const, error: "no_undoable_history" }
    }
    const snap = last.prev_snapshot
    const kindChanged = snap.kind && snap.kind !== target.kind
    const restored: Experience = {
      ...target,
      kind: snap.kind ?? target.kind,
      title: snap.title,
      abstract: snap.abstract,
      statement: snap.statement,
      trigger_condition: snap.trigger_condition,
      task_type: snap.task_type,
      scope: snap.scope ?? target.scope,
      categories: snap.categories ?? target.categories,
      refinement_history: [
        ...target.refinement_history.slice(0, -1),
        {
          at: nowMs(),
          trigger_observation_id: last.trigger_observation_id,
          kind: "undo",
          model: "manual",
          prev_snapshot: {
            title: target.title,
            abstract: target.abstract,
            statement: target.statement,
            trigger_condition: target.trigger_condition,
            task_type: target.task_type,
            scope: target.scope,
            kind: target.kind,
            categories: target.categories,
          },
        },
      ],
    }
    if (kindChanged) {
      const cfg = await settings()
      await unlink(experienceFilepath(cfg.base, target)).catch(() => {})
    }
    const filepath = await writeExperience(restored)
    return { ok: true as const, experience: { ...restored, path: rel(filepath) } }
  }

  // ---------- Observation-level ops ----------

  export async function deleteObservation(input: { experience_id: string; observation_id: string }) {
    const target = await getExperienceByID(input.experience_id)
    if (!target) return { ok: false as const, error: "not_found" }
    const obs = target.observations.find((o) => o.id === input.observation_id)
    if (!obs) return { ok: false as const, error: "observation_not_found" }
    const cfg = await settings()
    await unlink(observationFilepath(cfg.base, obs)).catch(() => {})

    const remaining = target.observations.filter((o) => o.id !== input.observation_id)
    // If no observations remain, auto-archive the experience to prevent an orphan hero.
    if (remaining.length === 0) {
      const archived: Experience = { ...target, observations: [], archived: true, archived_at: nowMs() }
      const filepath = await writeExperience(archived)
      return { ok: true as const, auto_archived: true as const, experience: { ...archived, path: rel(filepath) } }
    }
    const next: Experience = { ...target, observations: remaining }
    const filepath = await writeExperience(next)
    return { ok: true as const, auto_archived: false as const, experience: { ...next, path: rel(filepath) } }
  }

  export async function moveObservation(input: {
    observation_id: string
    from_experience_id: string
    to_experience_id: string
  }) {
    if (input.from_experience_id === input.to_experience_id) {
      return { ok: false as const, error: "same_experience" }
    }
    const from = await getExperienceByID(input.from_experience_id)
    const to = await getExperienceByID(input.to_experience_id)
    if (!from) return { ok: false as const, error: "from_not_found" }
    if (!to) return { ok: false as const, error: "to_not_found" }
    const obs = from.observations.find((o) => o.id === input.observation_id)
    if (!obs) return { ok: false as const, error: "observation_not_found" }

    const fromNext: Experience = {
      ...from,
      observations: from.observations.filter((o) => o.id !== input.observation_id),
    }
    await writeExperience(fromNext)

    const attachResult = await attachAndRefine({
      experience: to,
      observation: obs,
      historyKind: "manual_augment",
    })
    if (!attachResult.attached) return { ok: false as const, error: attachResult.reason }
    return { ok: true as const, from: fromNext, to: attachResult.experience }
  }

  // ---------- Merge ----------

  export async function mergeExperiences(input: { ids: string[]; reason?: string }) {
    if (input.ids.length < 2) return { ok: false as const, error: "need_at_least_two" }
    const all = await listExperiences()
    const sources = input.ids
      .map((id) => all.find((e) => e.id === id))
      .filter((e): e is ExperienceWithPath => !!e)
    if (sources.length < 2) return { ok: false as const, error: "missing_sources" }

    // Combine observations (de-dup by id), pick seed experience for primary fields
    const allObs = new Map<string, Observation>()
    for (const src of sources) for (const obs of src.observations) allObs.set(obs.id, obs)
    const mergedObs = [...allObs.values()].sort((a, b) => a.observed_at - b.observed_at)

    const seed = sources.reduce((a, b) => (a.last_refined_at >= b.last_refined_at ? a : b))
    const mergedCategories = uniqueStrings(sources.flatMap((s) => s.categories ?? []))
    const mergedRelated = uniqueStrings(
      sources.flatMap((s) => s.related_experience_ids).filter((id) => !input.ids.includes(id)),
    )

    const synthesizedExperience: Experience = {
      ...seed,
      id: sha1Short(`merge:${input.ids.join(",")}:${nowMs()}`, 12),
      observations: mergedObs,
      categories: mergedCategories,
      related_experience_ids: mergedRelated,
      conflicts_with: [],
      refinement_history: [],
      archived: false,
      // User-initiated merge — skip review queue.
      review_status: "approved",
      reviewed_at: nowMs(),
      created_at: nowMs(),
      last_refined_at: nowMs(),
    }

    // Ask the LLM to merge: we call refineExperience on the synthesized experience,
    // with the last observation as trigger. The refiner already sees all observations.
    const trigger = mergedObs[mergedObs.length - 1]
    let refined = await refineExperience({ experience: synthesizedExperience, triggerObservation: trigger })

    // If the LLM failed or produced a placeholder abstract, retry once; if still
    // bad, FALL BACK to the seed experience's metadata so the merge itself still
    // completes. The user can always trigger a manual re-refine on the result.
    let synthesisFallback = false
    if (!refined || abstractLooksLikePlaceholder(refined.abstract)) {
      log.warn("merge refine produced invalid output; retrying", {
        seed_id: seed.id,
        source_ids: input.ids,
        had_output: Boolean(refined),
      })
      refined = await refineExperience({ experience: synthesizedExperience, triggerObservation: trigger })
    }
    if (!refined || abstractLooksLikePlaceholder(refined.abstract)) {
      log.warn("merge refine failed after retry; falling back to seed metadata", {
        seed_id: seed.id,
        source_ids: input.ids,
      })
      synthesisFallback = true
      refined = {
        kind: seed.kind,
        title: seed.title,
        abstract: seed.abstract,
        statement: seed.statement,
        trigger_condition: seed.trigger_condition,
        task_type: seed.task_type,
        scope: seed.scope,
        categories: mergedCategories,
        conflicts_with: [],
      }
    }

    const resolved = await resolveRefinerModel()
    const modelTag = resolved?.selected ? `${resolved.selected.providerID}/${resolved.selected.modelID}` : "unknown"
    const merged: Experience = {
      ...synthesizedExperience,
      kind: refined.kind,
      title: refined.title,
      abstract: refined.abstract,
      statement: blankToUndefined(refined.statement),
      trigger_condition: blankToUndefined(refined.trigger_condition),
      task_type: blankToUndefined(refined.task_type) ?? synthesizedExperience.task_type,
      scope: refined.scope,
      categories: uniqueStrings([...(refined.categories ?? []), ...mergedCategories]),
      refinement_history: [
        {
          at: nowMs(),
          trigger_observation_id: trigger.id,
          kind: "merge",
          source_ids: input.ids,
          model: synthesisFallback ? `${modelTag}:fallback` : modelTag,
        },
      ],
    }
    const filepath = await writeExperience(merged)
    if (merged.kind.startsWith("custom:")) await registerCustomKind(merged.kind, merged.id)
    for (const slug of merged.categories) await registerCategory(slug, merged.id)

    // Archive (not delete) the sources; audit the merge.
    for (const src of sources) {
      const archived: Experience = { ...src, archived: true, archived_at: nowMs() }
      await writeExperience(archived)
    }
    // Phase 2a: rewire any chain edges that pointed at the archived sources so
    // they now reference the merged experience. rewireEdges dedups + drops
    // self-loops introduced by the swap.
    {
      const cfgGraph = await settings()
      for (const src of sources) {
        await rewireEdgesRaw(cfgGraph.base, src.id, merged.id).catch((err) =>
          log.warn("rewireEdges failed during merge", { err, old: src.id, new: merged.id }),
        )
      }
    }
    await appendAudit("merged.ndjson", {
      at: nowMs(),
      merged_id: merged.id,
      source_ids: input.ids,
      reason: input.reason ?? "user_merge",
      synthesis_fallback: synthesisFallback ? true : undefined,
    })
    return {
      ok: true as const,
      experience: { ...merged, path: rel(filepath) },
      synthesisFallback,
    }
  }

  // ---------- Search ----------

  export async function search(input: { q: string; limit?: number; includeArchived?: boolean }) {
    const q = input.q.trim().toLowerCase()
    if (!q) return { results: [] as Array<{ experience_id: string; score: number; where: string }> }
    const all = await listExperiences()
    const limit = input.limit ?? 20
    const scored: Array<{ experience_id: string; score: number; where: string; exp: Experience }> = []
    for (const exp of all) {
      if (!input.includeArchived && exp.archived) continue
      let score = 0
      const where: string[] = []
      const hay = {
        title: exp.title.toLowerCase(),
        abstract: exp.abstract.toLowerCase(),
        statement: (exp.statement ?? "").toLowerCase(),
        task_type: (exp.task_type ?? "").toLowerCase(),
        categories: (exp.categories ?? []).join(" ").toLowerCase(),
      }
      if (hay.title.includes(q)) { score += 5; where.push("title") }
      if (hay.abstract.includes(q)) { score += 3; where.push("abstract") }
      if (hay.statement.includes(q)) { score += 3; where.push("statement") }
      if (hay.task_type.includes(q)) { score += 2; where.push("task_type") }
      if (hay.categories.includes(q)) { score += 2; where.push("categories") }
      for (const obs of exp.observations) {
        if (obs.user_text.toLowerCase().includes(q)) { score += 1; where.push("observation"); break }
      }
      if (score > 0) scored.push({ experience_id: exp.id, score, where: where.join(","), exp })
    }
    scored.sort((a, b) => b.score - a.score || b.exp.last_refined_at - a.exp.last_refined_at)
    return {
      results: scored.slice(0, limit).map((s) => ({
        experience_id: s.experience_id,
        score: s.score,
        where: s.where,
        title: s.exp.title,
        abstract: clipText(s.exp.abstract, 180),
        kind: s.exp.kind,
        archived: !!s.exp.archived,
      })),
    }
  }

  // ---------- Batch ingest from historical session ----------

  export async function ingestSession(input: {
    sessionID: string
    messageIDs?: string[]
  }): Promise<{ ok: true; stats: { processed: number; observed: number; skipped: number } }> {
    const cfg = await settings()
    const stats = { processed: 0, observed: 0, skipped: 0 }
    const messages = await svcSessionMessages({ sessionID: SessionID.make(input.sessionID), limit: 500 })
    const filter = input.messageIDs && input.messageIDs.length > 0 ? new Set(input.messageIDs) : null
    for (const msg of messages) {
      stats.processed++
      if (msg.info.role !== "user") {
        stats.skipped++
        continue
      }
      if (filter && !filter.has(msg.info.id)) {
        stats.skipped++
        continue
      }
      const text = msg.parts
        .flatMap((p) => (p.type === "text" && !p.synthetic && !p.ignored ? [p.text.trim()] : []))
        .filter(Boolean)
        .join("\n")
        .trim()
      if (!text) {
        stats.skipped++
        continue
      }
      try {
        // Delegate to the shared capture helper so ingested observations get the
        // same prior-history excerpt (3 messages) and workflow snapshot that live
        // captures do. Passing source: "ingest" keeps them distinguishable in the
        // audit / UI without changing downstream refiner behavior.
        const observation = await captureObservation({
          sessionID: input.sessionID,
          messageID: msg.info.id,
          text,
          observedAt: msg.info.time.created,
          source: "ingest",
        })
        await observeObservation(observation)
        stats.observed++
      } catch (err) {
        log.warn("ingest observeObservation failed", { err, message_id: msg.info.id })
        stats.skipped++
      }
    }
    await appendAudit("ingested.ndjson", {
      at: nowMs(),
      session_id: input.sessionID,
      message_ids: input.messageIDs ?? null,
      stats,
      base: cfg.base,
    })
    return { ok: true as const, stats }
  }

  /**
   * List message_ids already observed for a given session. Used by the ingest
   * drawer so the UI can disable / visually mark rows the user has previously
   * imported (since ingest is idempotent but the user shouldn't accidentally
   * re-import in bulk).
   */
  export async function listIngestedObservations(input: { sessionID: string }): Promise<{
    session_id: string
    message_ids: string[]
  }> {
    const cfg = await settings()
    const dir = path.join(cfg.base, "observations", input.sessionID)
    const files = await Glob.scan("*.md", { cwd: dir, absolute: true, dot: true }).catch(() => [])
    const messageIDs: string[] = []
    for (const file of files) {
      const doc = await readMatter(file).catch(() => undefined)
      if (!doc) continue
      const parsed = ObservationSchema.safeParse(doc.data)
      if (!parsed.success) continue
      messageIDs.push(parsed.data.message_id)
    }
    return { session_id: input.sessionID, message_ids: messageIDs }
  }

  // ---------- Export / Import ----------

  export async function exportArchive(): Promise<{ base: string; files: string[] }> {
    const cfg = await settings()
    const files = (
      await Glob.scan("**/*", { cwd: cfg.base, absolute: true, dot: true, include: "file" }).catch(() => [])
    ).sort()
    return { base: cfg.base, files: files.map((f) => rel(f)) }
  }

  export async function exportJson(): Promise<Record<string, unknown>> {
    const cfg = await settings()
    const experiences = await listExperiences()
    const taxonomyObj = await listKinds().catch(() => ({ core: [], custom: [] }))
    const categoriesObj = await listCategories().catch(() => ({ categories: [] }))
    const configObj = (await readConfigOverride()) ?? null
    return {
      version: 2,
      exported_at: nowMs(),
      base: rel(cfg.base),
      experiences,
      taxonomy: taxonomyObj,
      categories: categoriesObj,
      config: configObj,
    }
  }

  export async function importJson(input: { data: unknown; mode?: "merge" | "replace" }) {
    const parsed = z
      .object({
        version: z.number(),
        experiences: z.array(ExperienceSchema),
      })
      .safeParse(input.data)
    if (!parsed.success) return { ok: false as const, error: "invalid_payload", details: parsed.error.message }
    const mode = input.mode ?? "merge"
    const cfg = await settings()
    if (mode === "replace") {
      // Move existing experience dir to a timestamped archive instead of rm -rf
      const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)
      const existingDir = path.join(cfg.base, "experiences")
      const archiveDir = path.join(cfg.base, `experiences.pre-import-${stamp}`)
      if (await Filesystem.exists(existingDir)) {
        await Bun.write(path.join(archiveDir, ".placeholder"), "").catch(() => {})
      }
    }
    let imported = 0
    for (const exp of parsed.data.experiences) {
      await writeExperience(exp)
      imported++
    }
    return { ok: true as const, imported }
  }

  // ---------- Categories ----------

  export async function categories() {
    return listCategories()
  }

  export async function overview(input: {
    sessionID?: string
    workflowID?: string
    limit?: number
    includeArchived?: boolean
    /**
     * "all" (default): return every experience regardless of origin session/workflow.
     * "session": only experiences that have an observation from sessionID.
     * "workflow": only experiences that have an observation from workflowID.
     */
    scope?: "all" | "session" | "workflow"
  }): Promise<RefinerOverview> {
    const all = await listExperiences()
    const base = input.includeArchived ? all : all.filter((exp) => !exp.archived)
    const scope = input.scope ?? "all"
    let filtered = base
    if (scope === "session" && input.sessionID) {
      filtered = base.filter((exp) => exp.observations.some((o) => o.session_id === input.sessionID))
    } else if (scope === "workflow" && input.workflowID) {
      filtered = base.filter((exp) =>
        exp.observations.some((o) => o.agent_context.workflow_snapshot?.workflow_id === input.workflowID),
      )
    }
    // Order: most recently refined first, so new distillations surface at the top.
    filtered = [...filtered].sort((a, b) => b.last_refined_at - a.last_refined_at)
    const limited = filtered.slice(0, input.limit ?? 40)
    const latest = limited.reduce<number | undefined>(
      (acc, exp) => (acc === undefined || exp.last_refined_at > acc ? exp.last_refined_at : acc),
      undefined,
    )
    const resolved = await resolveRefinerModel()
    const totalObservations = limited.reduce((sum, exp) => sum + exp.observations.length, 0)
    const cfg = await settings()
    const chainEdges = await readEdgesRaw(cfg.base).catch(() => [] as ExperienceEdge[])
    return {
      schema_version: 2,
      status: {
        total_experiences: limited.length,
        total_observations: totalObservations,
        latest_refined_at: latest,
      },
      model: resolved?.selected,
      experiences: limited,
      graph: buildOverviewGraph(limited, chainEdges),
    }
  }

  // ---------- Phase 2a: chain-experience graph ----------

  export async function listEdges() {
    const cfg = await settings()
    return readEdgesRaw(cfg.base)
  }

  /**
   * BFS neighborhood around a seed experience. Default traversal uses
   * requires + refines with depth=2 — matching the retrieve-agent default
   * in docs/runtime-workflow-design.md §4.5.5.
   */
  export async function neighbors(input: {
    id: string
    edge_kinds?: EdgeKind[]
    direction?: "in" | "out" | "both"
    max_depth?: number
  }) {
    const cfg = await settings()
    const edges = await readEdgesRaw(cfg.base)
    const result = traverseFromSeed(edges, input.id, {
      edgeKinds: input.edge_kinds ?? (["requires", "refines"] as EdgeKind[]),
      direction: input.direction ?? "both",
      maxDepth: input.max_depth ?? 2,
    })
    const all = await listExperiences()
    const byID = new Map(all.map((e) => [e.id, e]))
    return {
      seed: input.id,
      nodes: result.nodes.map((id) => {
        const exp = byID.get(id)
        return exp
          ? {
              id,
              kind: exp.kind,
              title: exp.title,
              abstract: clipText(exp.abstract, 200),
              archived: !!exp.archived,
              depth: result.depth.get(id) ?? 0,
            }
          : { id, kind: null, title: "<missing>", abstract: "", archived: false, depth: result.depth.get(id) ?? 0 }
      }),
      edges: result.edges,
    }
  }

  /** Manually create an edge between two experiences. Applies the same
   * dedup / self-loop / cycle-check pipeline as the LLM route batch. */
  export async function createEdge(input: {
    from: string
    to: string
    kind: EdgeKind
    reason?: string
    confidence?: number
  }) {
    const cfg = await settings()
    const all = await listExperiences()
    const ids = new Set(all.map((e) => e.id))
    if (!ids.has(input.from)) return { ok: false as const, error: "from_not_found" }
    if (!ids.has(input.to)) return { ok: false as const, error: "to_not_found" }
    const { results } = await persistEdgeBatch(cfg.base, [
      {
        from: input.from,
        to: input.to,
        kind: input.kind,
        reason: (input.reason ?? "").slice(0, 400),
        confidence: input.confidence ?? 1.0,
        created_by: "user_manual",
      },
    ])
    return { ok: true as const, result: results[0] ?? null }
  }

  export async function deleteEdge(input: { edge_id: string }) {
    const cfg = await settings()
    const removed = await removeEdgesRaw(cfg.base, (e) => e.id === input.edge_id)
    return { ok: true as const, removed }
  }

  /** Internal helper invoked by deleteExperience / mergeExperiences to keep
   * the graph clean. Exported on the namespace for transparency + testability. */
  export async function pruneEdgesForExperience(id: string) {
    const cfg = await settings()
    return removeEdgesForExpRaw(cfg.base, id)
  }

  export async function rewireEdgesAfterMerge(oldID: string, newID: string) {
    const cfg = await settings()
    return rewireEdgesRaw(cfg.base, oldID, newID)
  }
}
