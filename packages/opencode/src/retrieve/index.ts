/**
 * Phase 2b — Retrieve agent (read side).
 *
 * Counterpart to the Refiner: takes the current session/agent context and
 * produces a small set of experiences to inject into the system prompt of
 * the next LLM turn. No writes. Reuses Refiner's experience graph.
 *
 * Pipeline (selectForSession):
 *   1. coarse-filter: load all non-archived experiences, filter by target_layer
 *   2. LLM seed:      retrieve agent picks N seed IDs from the candidate list
 *      (heuristic fallback if no model is available)
 *   3. graph expand:  BFS along `requires` + `refines` edges from each seed
 *      (depth 1, direction "out") so prerequisites and refinements ride along
 *   4. budget:        cap total picks at MAX_PICKS, seed-priority preserved
 *   5. diff & render: compare against the per-session last-injected set,
 *      render as <experience id=... kind=...> blocks, append to system prompt
 *      and persist a log entry for frontend inspection
 *
 * State:
 *   - In-memory map: Map<sessionID, { lastInjected, history }>, scoped per
 *     Instance.directory (mirrors how Refiner scopes its state).
 *   - Disk log: NDJSON at .opencode/refiner-memory/retrieve-log.ndjson
 *     (one entry per selectForSession call, kept for the frontend page).
 *
 * Failure mode: any error in the pipeline → return { system_text: undefined,
 * picked: [] } so the host turn never blocks. Errors are logged.
 */

import path from "path"
import z from "zod"
import { Effect } from "effect"
import { generateText, jsonSchema, stepCountIs, streamText, tool, type ModelMessage } from "ai"
import { Refiner } from "@/refiner"
import {
  readEdges,
  traverseFrom,
  type ExperienceEdge,
} from "@/refiner/graph"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Config } from "@/config"
import { Provider } from "@/provider"
import { ProviderID, ModelID } from "@/provider/schema"
import { ProviderTransform } from "@/provider"
import { Instance } from "@/project/instance"
import { AppRuntime } from "@/effect/app-runtime"
import { Filesystem, Log } from "@/util"
import { Hash } from "@opencode-ai/shared/util/hash"

const log = Log.create({ service: "retrieve" })

// -----------------------------------------------------------------------------
// Schemas / types
// -----------------------------------------------------------------------------

const PickSource = z.enum(["seed", "expand:requires", "expand:refines", "heuristic", "cache"])
type PickSource = z.infer<typeof PickSource>

const PickedExperienceSchema = z.object({
  experience_id: z.string(),
  kind: z.string(),
  title: z.string(),
  abstract: z.string(),
  statement: z.string().optional(),
  trigger_condition: z.string().optional(),
  task_type: z.string().optional(),
  target_layer: z.enum(["master", "slave", "both"]).optional(),
  source: PickSource,
  reason: z.string().optional(),
})
export type PickedExperience = z.infer<typeof PickedExperienceSchema>

const RetrieveLogEntrySchema = z.object({
  id: z.string(), // hash of (session, turn_index, picked-id-set)
  session_id: z.string(),
  turn_index: z.number(),
  agent_name: z.string(),
  layer: z.enum(["master", "slave", "both"]),
  workflow_id: z.string().optional(),
  user_text_excerpt: z.string().optional(),
  candidate_count: z.number(),
  seed_ids: z.array(z.string()),
  expand_ids: z.array(z.string()),
  picked: z.array(PickedExperienceSchema),
  diff: z.object({
    added: z.array(z.string()),
    removed: z.array(z.string()),
    kept: z.array(z.string()),
  }),
  model: z
    .object({
      providerID: z.string(),
      modelID: z.string(),
      source: z.string(),
    })
    .optional(),
  llm_used: z.boolean(),
  error: z.string().optional(),
  duration_ms: z.number(),
  created_at: z.number(),
})
export type RetrieveLogEntry = z.infer<typeof RetrieveLogEntrySchema>

export type RetrieveResult = {
  /** Block of text to splice into the host LLM's system prompt; undefined if nothing picked. */
  system_text?: string
  picked: PickedExperience[]
  diff: { added: string[]; removed: string[]; kept: string[] }
}

// -----------------------------------------------------------------------------
// LLM wire schema for the retrieve agent
// -----------------------------------------------------------------------------

const SeedPickWireSchema = z.object({
  experience_id: z.string(),
  reason: z.string().max(200).default(""),
})

const RetrieveSeedOutputSchema = z.object({
  seeds: z.array(SeedPickWireSchema).max(10),
  reason: z.string().max(400).default(""),
})

// -----------------------------------------------------------------------------
// Per-instance state
// -----------------------------------------------------------------------------

type SessionState = {
  /** Set of experience IDs injected the previous turn. Drives the diff. */
  lastInjected: Set<string>
  /** Monotonically-increasing turn counter (1-indexed). */
  turnIndex: number
  /**
   * Cached system_text from the most recent real (non-dry-run) injection.
   * Once set, subsequent turns reuse it verbatim and skip the retrieve LLM
   * call entirely until `resetSession` (called on compaction) clears it.
   * This implements "已注入过的 exp 后续不再走 LLM，直到压缩重置".
   */
  cachedSystemText?: string
  /**
   * Picks paired with `cachedSystemText`. Reused on cache-hit turns to render
   * a `cache` log entry so the audit trail stays continuous across turns
   * (otherwise only turn-1 shows up on the retrieve page).
   */
  cachedPicks?: PickedExperience[]
  /** Model info recorded when the cache was filled — copied into cache-hit log entries. */
  cachedModel?: RetrieveLogEntry["model"]
}

type InstanceState = {
  bySession: Map<string, SessionState>
}

const __retrieveStateByDirectory = new Map<string, InstanceState>()

function state(): InstanceState {
  const key = Instance.directory
  let cur = __retrieveStateByDirectory.get(key)
  if (!cur) {
    cur = { bySession: new Map() }
    __retrieveStateByDirectory.set(key, cur)
  }
  return cur
}

function sessionState(sessionID: string): SessionState {
  const s = state()
  let v = s.bySession.get(sessionID)
  if (!v) {
    v = { lastInjected: new Set(), turnIndex: 0 }
    s.bySession.set(sessionID, v)
  }
  return v
}

// -----------------------------------------------------------------------------
// Tunables
// -----------------------------------------------------------------------------

const MAX_PICKS = 8
const MAX_CANDIDATES_TO_LLM = 50
const HEURISTIC_TOP_N = 5
const EXPAND_DEPTH = 1
const EXPAND_KINDS = ["requires", "refines"] as const

// -----------------------------------------------------------------------------
// Service helpers (same Effect-bridged pattern as refiner uses)
// -----------------------------------------------------------------------------

async function svcConfigGet() {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const c = yield* Config.Service
      return yield* c.get()
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

// -----------------------------------------------------------------------------
// Layer mapping (which agents see which experiences)
// -----------------------------------------------------------------------------

const MASTER_AGENTS = new Set([
  "build",
  "plan",
  "primary",
  "orchestrator",
  "sandtable",
])

function agentLayer(agentName: string): "master" | "slave" {
  if (MASTER_AGENTS.has(agentName)) return "master"
  // Anything else (general, explore, refiner, retrieve, custom subagents) → slave.
  return "slave"
}

function layerMatches(experienceTargetLayer: string, layer: "master" | "slave"): boolean {
  if (experienceTargetLayer === "both") return true
  return experienceTargetLayer === layer
}

// -----------------------------------------------------------------------------
// Disk paths
// -----------------------------------------------------------------------------

async function settings() {
  const cfg = await svcConfigGet()
  const refiner = cfg?.experimental?.refiner
  const base = refiner?.directory
    ? path.isAbsolute(refiner.directory)
      ? refiner.directory
      : path.join(Instance.worktree, refiner.directory)
    : path.join(Instance.worktree, ".opencode", "refiner-memory")
  return { base, enabled: refiner?.enabled ?? true }
}

function logFilepath(base: string) {
  return path.join(base, "retrieve-log.ndjson")
}

// -----------------------------------------------------------------------------
// Runtime config override (persisted at .opencode/refiner-memory/retrieve-config.json)
// Mirrors the refiner's override pattern so the frontend retrieve page can
// switch the retrieve agent's model on the fly without an opencode restart.
// -----------------------------------------------------------------------------

const ConfigOverrideSchema = z.object({
  model: z
    .object({
      providerID: z.string().min(1),
      modelID: z.string().min(1),
    })
    .optional(),
  temperature: z.number().min(0).max(2).optional(),
})
type ConfigOverride = z.infer<typeof ConfigOverrideSchema>

async function configOverridePath() {
  const cfg = await settings()
  return path.join(cfg.base, "retrieve-config.json")
}

async function readConfigOverride(): Promise<ConfigOverride | undefined> {
  try {
    const p = await configOverridePath()
    if (!(await Filesystem.exists(p))) return undefined
    const raw = await Filesystem.readJson<unknown>(p).catch(() => undefined)
    if (!raw) return undefined
    const parsed = ConfigOverrideSchema.safeParse(raw)
    if (!parsed.success) {
      log.warn("retrieve config override invalid; ignoring", { error: parsed.error.message })
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
// LLM model resolution (mirrors refiner's pattern; falls back to small/default)
// -----------------------------------------------------------------------------

type ModelSource = "override" | "agent" | "default"

type ResolvedModel = {
  agent: Agent.Info
  model: Provider.Model
  selected: { providerID: string; modelID: string }
  source: ModelSource
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return await Promise.race<T | undefined>([
    p,
    new Promise<undefined>((res) => setTimeout(() => res(undefined), ms)),
  ])
}

async function resolveRetrieveModel(): Promise<ResolvedModel | undefined> {
  const agent = await svcAgentGet("retrieve")
  if (!agent) return undefined

  // 1. Runtime override (PUT /experimental/retrieve/config) — highest priority.
  //    Lets the retrieve frontend page switch to a small/fast model without an
  //    opencode restart. Falls through to agent/default if the override points
  //    at an unreachable provider.
  const override = await readConfigOverride()
  if (override?.model) {
    const model = await withTimeout(
      svcProviderGetModel(
        ProviderID.make(override.model.providerID),
        ModelID.make(override.model.modelID),
      ),
      300,
    )
    if (model) {
      return { agent, model, selected: override.model, source: "override" }
    }
    log.warn("retrieve override model unavailable; falling back", {
      override: override.model,
    })
  }

  // 2. Static agent config — opencode.jsonc agent.retrieve.model
  if (agent.model) {
    const model = await withTimeout(
      svcProviderGetModel(agent.model.providerID, agent.model.modelID),
      300,
    )
    if (model) return { agent, model, selected: agent.model, source: "agent" }
  }

  // 3. Provider default + small-model fallback
  const selected = await withTimeout(svcProviderDefaultModel(), 300)
  if (!selected) return undefined
  const model =
    (await withTimeout(svcProviderGetSmallModel(selected.providerID), 300)) ??
    (await withTimeout(svcProviderGetModel(selected.providerID, selected.modelID), 300))
  if (!model) return undefined
  return { agent, model, selected, source: "default" }
}

// -----------------------------------------------------------------------------
// LLM seed selection
// -----------------------------------------------------------------------------

type CandidateSummary = {
  id: string
  kind: string
  title: string
  abstract: string
  task_type?: string
  target_layer?: string
  trigger_condition?: string
}

function summarize(exp: Awaited<ReturnType<typeof Refiner.experiences>>[number]): CandidateSummary {
  return {
    id: exp.id,
    kind: exp.kind,
    title: exp.title,
    abstract: exp.abstract.length > 200 ? exp.abstract.slice(0, 200) + "…" : exp.abstract,
    task_type: exp.task_type,
    target_layer: (exp as any).target_layer ?? "both",
    trigger_condition: exp.trigger_condition,
  }
}

function createStructuredOutputTool(input: {
  schema: Record<string, unknown>
  onSuccess: (output: unknown) => void
}) {
  const { $schema, ...toolSchema } = input.schema as Record<string, unknown>
  void $schema
  return tool({
    description:
      "Emit the seed selection. Call exactly once with the final list. Do not call again.",
    inputSchema: jsonSchema(toolSchema as Record<string, unknown>),
    async execute(args) {
      input.onSuccess(args)
      return { output: "seeds captured" }
    },
  })
}

async function llmSeedSelect(input: {
  candidates: CandidateSummary[]
  agentName: string
  layer: "master" | "slave"
  userText?: string
  workflowID?: string
}): Promise<
  | { ok: true; seeds: Array<{ id: string; reason: string }>; modelInfo: ResolvedModel; reason: string }
  | { ok: false; reason: "no_model" | "no_language" | "llm_error" | "no_seeds"; modelInfo?: ResolvedModel }
> {
  if (input.candidates.length === 0) return { ok: false, reason: "no_seeds" }

  const resolved = await resolveRetrieveModel()
  if (!resolved?.model) return { ok: false, reason: "no_model" }
  const language = await svcProviderGetLanguage(resolved.model)
  if (!language) return { ok: false, reason: "no_language", modelInfo: resolved }
  const auth = await svcAuthGet(resolved.model.providerID)
  const cfg = await svcConfigGet()
  const isOpenaiOauth = resolved.model.providerID === "openai" && auth?.type === "oauth"

  const trimmed = input.candidates.slice(0, MAX_CANDIDATES_TO_LLM)

  const userPayload = {
    task: "select_seeds",
    agent_name: input.agentName,
    layer: input.layer,
    workflow_id: input.workflowID,
    user_text: input.userText ?? "",
    candidates: trimmed,
    notes: [
      "Pick experiences that are likely to inform the next agent turn given the user_text and agent layer.",
      "Quality > quantity. Empty seeds is acceptable when nothing fits.",
      "Prefer experiences whose trigger_condition or task_type matches the user_text.",
      `Hard cap: 10 seed ids.`,
    ],
  }

  let seeds: Array<{ id: string; reason: string }> = []
  let topReason = ""

  const schema = ProviderTransform.schema(
    resolved.model,
    z.toJSONSchema(RetrieveSeedOutputSchema),
  ) as Record<string, unknown>

  const messages: ModelMessage[] = [
    ...(isOpenaiOauth || !resolved.agent.prompt
      ? []
      : ([{ role: "system", content: resolved.agent.prompt }] as ModelMessage[])),
    { role: "user", content: JSON.stringify(userPayload, null, 2) },
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
        onSuccess(output) {
          const parsed = RetrieveSeedOutputSchema.safeParse(output)
          if (!parsed.success) {
            log.warn("retrieve seed output failed schema", {
              error: parsed.error.message,
            })
            return
          }
          topReason = parsed.data.reason
          // Filter to known IDs only (LLM may hallucinate)
          const known = new Set(trimmed.map((c) => c.id))
          for (const seed of parsed.data.seeds) {
            if (!known.has(seed.experience_id)) {
              log.warn("retrieve seed referenced unknown id", { id: seed.experience_id })
              continue
            }
            seeds.push({ id: seed.experience_id, reason: seed.reason })
          }
        },
      }),
    },
    providerOptions: ProviderTransform.providerOptions(resolved.model, {
      instructions: resolved.agent.prompt ?? "",
      store: false,
    }),
    stopWhen: stepCountIs(3),
  } satisfies Parameters<typeof generateText>[0]

  try {
    if ((language as any).doStream) {
      const result = streamText({ ...params, onError: () => {} })
      for await (const _ of result.fullStream) {
        // drain
      }
    } else {
      await generateText(params)
    }
  } catch (error) {
    log.warn("retrieve LLM call failed", { error })
    return { ok: false, reason: "llm_error", modelInfo: resolved }
  }

  return { ok: true, seeds, modelInfo: resolved, reason: topReason }
}

function heuristicSeedSelect(candidates: CandidateSummary[]): Array<{ id: string; reason: string }> {
  // Fallback when no model is available: take the most-recently-refined N.
  return candidates.slice(0, HEURISTIC_TOP_N).map((c) => ({
    id: c.id,
    reason: "heuristic:recent",
  }))
}

// -----------------------------------------------------------------------------
// Graph expansion
// -----------------------------------------------------------------------------

function expandFromSeeds(
  edges: ExperienceEdge[],
  seedIDs: string[],
): Map<string, "expand:requires" | "expand:refines"> {
  const result = new Map<string, "expand:requires" | "expand:refines">()
  for (const seed of seedIDs) {
    const out = traverseFrom(edges, seed, {
      edgeKinds: EXPAND_KINDS as unknown as ExperienceEdge["kind"][],
      direction: "out",
      maxDepth: EXPAND_DEPTH,
    })
    for (const node of out.nodes) {
      if (node === seed) continue
      // Determine which edge kind brought it in (first-found wins)
      const edge = out.edges.find((e) => e.to === node && (e.kind === "requires" || e.kind === "refines"))
      const tag: "expand:requires" | "expand:refines" =
        edge?.kind === "refines" ? "expand:refines" : "expand:requires"
      if (!result.has(node)) result.set(node, tag)
    }
  }
  return result
}

// -----------------------------------------------------------------------------
// Render
// -----------------------------------------------------------------------------

function renderSystemBlock(picks: PickedExperience[]): string | undefined {
  if (picks.length === 0) return undefined
  const lines: string[] = []
  lines.push("<retrieved_experiences>")
  lines.push(
    "These reusable experiences were selected for this turn based on the conversation. " +
      "Use them as soft guidance — they describe rules, conventions, or knowledge from prior interactions in this workspace.",
  )
  lines.push("")
  for (const p of picks) {
    const head = `<experience id="${p.experience_id}" kind="${p.kind}"${
      p.target_layer ? ` layer="${p.target_layer}"` : ""
    }>`
    lines.push(head)
    lines.push(`title: ${p.title}`)
    if (p.statement) lines.push(`rule: ${p.statement}`)
    lines.push(`detail: ${p.abstract}`)
    if (p.trigger_condition) lines.push(`when: ${p.trigger_condition}`)
    lines.push(`</experience>`)
  }
  lines.push("</retrieved_experiences>")
  return lines.join("\n")
}

// -----------------------------------------------------------------------------
// Audit log persistence
// -----------------------------------------------------------------------------

async function appendLog(entry: RetrieveLogEntry) {
  try {
    const { base } = await settings()
    const file = logFilepath(base)
    const line = JSON.stringify(entry) + "\n"
    const prev = await Filesystem.readText(file).catch(() => "")
    await Filesystem.write(file, prev + line)
  } catch (error) {
    log.warn("retrieve log append failed", { error })
  }
}

async function readLog(): Promise<RetrieveLogEntry[]> {
  try {
    const { base } = await settings()
    const file = logFilepath(base)
    const raw = await Filesystem.readText(file).catch(() => "")
    if (!raw) return []
    const out: RetrieveLogEntry[] = []
    for (const line of raw.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = RetrieveLogEntrySchema.safeParse(JSON.parse(trimmed))
        if (parsed.success) out.push(parsed.data)
      } catch {
        // skip
      }
    }
    return out
  } catch {
    return []
  }
}

// -----------------------------------------------------------------------------
// Pipeline
// -----------------------------------------------------------------------------

type PipelineInput = {
  sessionID: string
  agentName: string
  workflowID?: string
  userText?: string
  /** When true, do not advance turn index, do not persist log, do not mutate state. */
  dryRun?: boolean
}

async function runPipeline(input: PipelineInput): Promise<{
  result: RetrieveResult
  logEntry: RetrieveLogEntry
}> {
  const t0 = Date.now()
  const layer = agentLayer(input.agentName)
  const ss = sessionState(input.sessionID)
  const turnIndex = input.dryRun ? ss.turnIndex : ss.turnIndex + 1

  const baseLog: Omit<RetrieveLogEntry, "id"> = {
    session_id: input.sessionID,
    turn_index: turnIndex,
    agent_name: input.agentName,
    layer,
    workflow_id: input.workflowID,
    user_text_excerpt: input.userText
      ? input.userText.length > 200
        ? input.userText.slice(0, 200) + "…"
        : input.userText
      : undefined,
    candidate_count: 0,
    seed_ids: [],
    expand_ids: [],
    picked: [],
    diff: { added: [], removed: [], kept: [] },
    llm_used: false,
    duration_ms: 0,
    created_at: Date.now(),
  }

  let entryError: string | undefined
  let picks: PickedExperience[] = []
  let seedIDs: string[] = []
  let expandIDs: string[] = []
  let modelInfo: RetrieveLogEntry["model"]
  let llmUsed = false
  let candidateCount = 0

  try {
    // Stage 1 — coarse filter
    const all = await Refiner.experiences()
    const candidates = all
      .filter((e) => !e.archived)
      .filter((e) => layerMatches((e as any).target_layer ?? "both", layer))
    candidateCount = candidates.length
    const summaries = candidates.map(summarize)
    const byID = new Map(candidates.map((c) => [c.id, c] as const))

    if (candidates.length > 0) {
      // Stage 2 — LLM seed (or heuristic fallback)
      const seedRes = await llmSeedSelect({
        candidates: summaries,
        agentName: input.agentName,
        layer,
        userText: input.userText,
        workflowID: input.workflowID,
      })
      let pickedSeeds: Array<{ id: string; reason: string; source: PickSource }>
      if (seedRes.ok) {
        llmUsed = true
        modelInfo = seedRes.modelInfo
          ? {
              providerID: seedRes.modelInfo.model.providerID,
              modelID: seedRes.modelInfo.model.api.id,
              source: seedRes.modelInfo.source,
            }
          : undefined
        pickedSeeds = seedRes.seeds.map((s) => ({ ...s, source: "seed" as PickSource }))
      } else {
        modelInfo = seedRes.modelInfo
          ? {
              providerID: seedRes.modelInfo.model.providerID,
              modelID: seedRes.modelInfo.model.api.id,
              source: seedRes.modelInfo.source,
            }
          : undefined
        if (seedRes.reason !== "no_model" && seedRes.reason !== "no_language") {
          // we tried LLM but it failed — still apply the heuristic fallback so
          // demo always shows something rather than blank-screening
          log.info("retrieve LLM unsuccessful, falling back to heuristic", {
            reason: seedRes.reason,
          })
        }
        pickedSeeds = heuristicSeedSelect(summaries).map((s) => ({
          ...s,
          source: "heuristic" as PickSource,
        }))
      }

      seedIDs = pickedSeeds.map((s) => s.id)

      // Stage 3 — graph expansion
      const { base } = await settings()
      const edges = await readEdges(base).catch(() => [] as ExperienceEdge[])
      const expandMap = expandFromSeeds(edges, seedIDs)
      expandIDs = [...expandMap.keys()].filter((id) => byID.has(id))

      // Stage 4 — assemble picks (seed first, then expand) within budget
      const out: PickedExperience[] = []
      const seen = new Set<string>()

      const pushIfPossible = (
        id: string,
        source: PickSource,
        reason?: string,
      ) => {
        if (out.length >= MAX_PICKS) return
        if (seen.has(id)) return
        const exp = byID.get(id)
        if (!exp) return
        seen.add(id)
        out.push({
          experience_id: exp.id,
          kind: exp.kind,
          title: exp.title,
          abstract: exp.abstract,
          statement: exp.statement,
          trigger_condition: exp.trigger_condition,
          task_type: exp.task_type,
          target_layer: (exp as any).target_layer ?? "both",
          source,
          reason,
        })
      }

      for (const seed of pickedSeeds) pushIfPossible(seed.id, seed.source, seed.reason)
      for (const [id, source] of expandMap) {
        if (!byID.has(id)) continue
        pushIfPossible(id, source, "graph expand")
      }

      picks = out
    }
  } catch (error) {
    entryError = error instanceof Error ? error.message : String(error)
    log.warn("retrieve pipeline error", { error })
  }

  // Stage 5 — diff + render
  const pickedIDs = new Set(picks.map((p) => p.experience_id))
  const diff = {
    added: [...pickedIDs].filter((id) => !ss.lastInjected.has(id)),
    removed: [...ss.lastInjected].filter((id) => !pickedIDs.has(id)),
    kept: [...pickedIDs].filter((id) => ss.lastInjected.has(id)),
  }
  const system_text = renderSystemBlock(picks)

  // Persist state (only on real run)
  if (!input.dryRun) {
    ss.turnIndex = turnIndex
    ss.lastInjected = pickedIDs
  }

  const duration_ms = Date.now() - t0
  const idSeed = `${input.sessionID}:${turnIndex}:${[...pickedIDs].sort().join(",")}`
  const id = "rl_" + Hash.fast(idSeed).slice(0, 12)
  const logEntry: RetrieveLogEntry = {
    ...baseLog,
    id,
    candidate_count: candidateCount,
    seed_ids: seedIDs,
    expand_ids: expandIDs,
    picked: picks,
    diff,
    model: modelInfo,
    llm_used: llmUsed,
    error: entryError,
    duration_ms,
  }

  const result: RetrieveResult = {
    system_text,
    picked: picks,
    diff,
  }
  return { result, logEntry }
}

// -----------------------------------------------------------------------------
// Public namespace
// -----------------------------------------------------------------------------

export namespace Retrieve {
  export const RetrieveLogEntrySchemaExport = RetrieveLogEntrySchema
  export const PickedExperienceSchemaExport = PickedExperienceSchema

  /**
   * Called from session/prompt.ts each turn. Mutates per-session state and
   * persists a log entry. Best-effort: errors are swallowed and logged.
   */
  export async function selectForSession(input: {
    sessionID: string
    agentName: string
    workflowID?: string
    userText?: string
  }): Promise<RetrieveResult> {
    try {
      const cfgEnabled = (await settings()).enabled
      if (!cfgEnabled) {
        return { picked: [], diff: { added: [], removed: [], kept: [] } }
      }
      // Fast path — already injected this compaction cycle. Reuse the cached
      // system_text and skip the retrieve LLM (the expensive bit, ~tens of
      // seconds). `resetSession` clears the cache on compaction, so the very
      // next turn after compaction re-runs the full pipeline.
      //
      // We still want a continuous audit trail on the retrieve frontend — the
      // user's screenshot showed only turn-1 visible because cache hits
      // skipped `appendLog`. So write a lightweight cache-hit log entry per
      // turn: same picks, source flipped to "cache", llm_used=false,
      // duration_ms ≈ 0. Frontend distinguishes via the new "cache" chip.
      const ss = sessionState(input.sessionID)
      if (ss.cachedSystemText !== undefined) {
        const t0 = Date.now()
        const turnIndex = ++ss.turnIndex
        const cachedPicks = ss.cachedPicks ?? []
        const picksForLog: PickedExperience[] = cachedPicks.map((p) => ({
          ...p,
          source: "cache" as PickSource,
          reason: p.reason ?? "已注入，沿用上一次缓存",
        }))
        const pickedIDs = new Set(picksForLog.map((p) => p.experience_id))
        const idSeed = `${input.sessionID}:${turnIndex}:cache:${[...pickedIDs].sort().join(",")}`
        const cacheEntry: RetrieveLogEntry = {
          id: "rl_" + Hash.fast(idSeed).slice(0, 12),
          session_id: input.sessionID,
          turn_index: turnIndex,
          agent_name: input.agentName,
          layer: agentLayer(input.agentName),
          workflow_id: input.workflowID,
          user_text_excerpt: input.userText
            ? input.userText.length > 200
              ? input.userText.slice(0, 200) + "…"
              : input.userText
            : undefined,
          candidate_count: 0,
          seed_ids: [],
          expand_ids: [],
          picked: picksForLog,
          diff: {
            added: [],
            removed: [],
            kept: [...ss.lastInjected],
          },
          model: ss.cachedModel,
          llm_used: false,
          duration_ms: Date.now() - t0,
          created_at: Date.now(),
        }
        // Skip the log when the cache is empty (turn-1 selected nothing) —
        // an `empty cache replay` row every turn would just be noise.
        if (picksForLog.length > 0) void appendLog(cacheEntry)
        return {
          system_text: ss.cachedSystemText,
          picked: picksForLog,
          diff: cacheEntry.diff,
        }
      }
      const { result, logEntry } = await runPipeline({ ...input, dryRun: false })
      // Remember what we injected so the next turn can short-circuit. Empty
      // picks → cache empty string so we still skip the LLM next turn (the
      // pipeline already decided "nothing to inject"; no point re-deciding).
      ss.cachedSystemText = result.system_text ?? ""
      ss.cachedPicks = result.picked
      ss.cachedModel = logEntry.model
      // fire-and-forget log persistence
      void appendLog(logEntry)
      return result
    } catch (error) {
      log.warn("retrieve.selectForSession failed", { error })
      return { picked: [], diff: { added: [], removed: [], kept: [] } }
    }
  }

  /**
   * Dry-run selection for the frontend "what would be injected if I asked
   * something now" preview. Does not advance turn or persist state, does not
   * write to the audit log.
   */
  export async function preview(input: {
    sessionID: string
    agentName: string
    workflowID?: string
    userText?: string
  }): Promise<RetrieveResult & { turn_index: number; agent_layer: "master" | "slave" }> {
    const { result } = await runPipeline({ ...input, dryRun: true })
    const ss = sessionState(input.sessionID)
    return {
      ...result,
      turn_index: ss.turnIndex,
      agent_layer: agentLayer(input.agentName),
    }
  }

  /** Clear injection memory for a session. Call on compaction. */
  export async function resetSession(sessionID: string) {
    const s = state()
    s.bySession.delete(sessionID)
  }

  /** All log entries across all sessions, newest first. Frontend list view. */
  export async function listLog(input?: { sessionID?: string; limit?: number }) {
    const all = await readLog()
    const filtered = input?.sessionID ? all.filter((e) => e.session_id === input.sessionID) : all
    filtered.sort((a, b) => b.created_at - a.created_at)
    if (input?.limit) return filtered.slice(0, input.limit)
    return filtered
  }

  // ---------- Runtime config (model + temperature) ----------

  export const ConfigOverrideSchemaExport = ConfigOverrideSchema

  /**
   * Current effective model + persisted override. Used by the retrieve
   * frontend page to render the model picker. `source` is one of:
   *   "override" — runtime override is winning
   *   "agent"    — opencode.jsonc agent.retrieve.model is winning
   *   "default"  — provider default / small-model fallback
   *   "none"     — no model resolvable at all
   */
  export async function config() {
    const override = await readConfigOverride()
    const resolved = await resolveRetrieveModel()
    return {
      resolved: resolved?.selected,
      source: (resolved?.source ?? "none") as ModelSource | "none",
      override: override ?? null,
    }
  }

  /**
   * Set/clear the runtime override. Pass `model: null` to remove the model
   * override (falls back to agent/default). Pass `temperature: null` to
   * remove the temperature override. Returns the post-update config so the
   * caller can refresh its view.
   */
  export async function setConfig(input: {
    model?: { providerID: string; modelID: string } | null
    temperature?: number | null
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

    await writeConfigOverride(next)
    return config()
  }
}
