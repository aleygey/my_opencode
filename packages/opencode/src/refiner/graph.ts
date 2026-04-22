/**
 * Phase 2a — Chain Experience Graph
 *
 * Typed edges between experiences, stored as NDJSON at
 * .opencode/refiner-memory/graph.ndjson. This module owns the write path for
 * edges (cycle check, dedup, transactional batch apply) and exposes a set of
 * traversal helpers consumed by the read path + retrieve agent.
 *
 * Core invariants:
 *   - `requires` subgraph must be a DAG (no cycles)
 *   - Edges are deduplicated on (from, to, kind)
 *   - No self-loops
 *   - BFS traversal always keeps a `visited` set and depth cap as last-resort
 *     safety even if a cycle slips through
 */

import path from "path"
import { unlink } from "fs/promises"
import z from "zod"
import { Filesystem } from "@/util/filesystem"
import { Hash } from "@/util/hash"
import { Log } from "@/util/log"

const log = Log.create({ service: "refiner.graph" })

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

export const EdgeKind = z.enum([
  "requires", // directed, DAG — "from depends on to (to must be established first)"
  "refines", // directed — "from is a refinement/specialization of to"
  "supports", // directed, cycles allowed — "from provides supporting evidence for to"
  "contradicts", // undirected (stored as from→to but semantically symmetric)
  "see_also", // undirected — "from is weakly related to to"
])
export type EdgeKind = z.infer<typeof EdgeKind>

/** Kinds that must remain acyclic. */
export const DAG_KINDS = new Set<EdgeKind>(["requires", "refines"])

export const EdgeCreatedBy = z.enum(["llm_route", "llm_refine", "user_manual", "system"])
export type EdgeCreatedBy = z.infer<typeof EdgeCreatedBy>

export const ExperienceEdge = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  kind: EdgeKind,
  reason: z.string().max(400),
  confidence: z.number().min(0).max(1).default(0.7),
  created_at: z.number(),
  created_by: EdgeCreatedBy,
  source_observation_id: z.string().optional(),
})
export type ExperienceEdge = z.infer<typeof ExperienceEdge>

export const EdgeProposal = z.object({
  from: z.string().optional(), // defaults to the triggering experience
  to: z.string(),
  kind: EdgeKind,
  reason: z.string().max(400).default(""),
  confidence: z.number().min(0).max(1).optional(),
})
export type EdgeProposal = z.infer<typeof EdgeProposal>

// -----------------------------------------------------------------------------
// File layout
// -----------------------------------------------------------------------------

/** Returns absolute path to the graph NDJSON file, given the refiner base dir. */
export function graphFilepath(base: string) {
  return path.join(base, "graph.ndjson")
}

// -----------------------------------------------------------------------------
// I/O
// -----------------------------------------------------------------------------

export async function readEdges(base: string): Promise<ExperienceEdge[]> {
  const file = graphFilepath(base)
  const raw = await Filesystem.readText(file).catch(() => "")
  if (!raw) return []
  const out: ExperienceEdge[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = ExperienceEdge.safeParse(JSON.parse(trimmed))
      if (parsed.success) out.push(parsed.data)
      else log.warn("skipping invalid edge row", { error: parsed.error.message, line: trimmed.slice(0, 200) })
    } catch (err) {
      log.warn("skipping unparseable edge row", { err, line: trimmed.slice(0, 200) })
    }
  }
  return out
}

export async function writeAllEdges(base: string, edges: ExperienceEdge[]) {
  const file = graphFilepath(base)
  const body = edges.map((e) => JSON.stringify(e)).join("\n") + (edges.length ? "\n" : "")
  await Filesystem.write(file, body)
}

// -----------------------------------------------------------------------------
// Key / hashing
// -----------------------------------------------------------------------------

function edgeKey(from: string, to: string, kind: EdgeKind) {
  return `${kind}::${from}->${to}`
}

function makeEdgeID(from: string, to: string, kind: EdgeKind) {
  return Hash.fast(edgeKey(from, to, kind)).slice(0, 12)
}

// -----------------------------------------------------------------------------
// Cycle detection (write-time DFS, localized to requires/refines)
// -----------------------------------------------------------------------------

/**
 * Returns true if adding the candidate edge would introduce a cycle in the
 * subgraph restricted to `kind`. Only runs for DAG_KINDS; other kinds short
 * circuit to false.
 */
export function wouldCreateCycle(
  edges: ExperienceEdge[],
  candidate: { from: string; to: string; kind: EdgeKind },
): boolean {
  if (!DAG_KINDS.has(candidate.kind)) return false
  if (candidate.from === candidate.to) return true

  const adj = new Map<string, string[]>()
  for (const e of edges) {
    if (e.kind !== candidate.kind) continue
    if (!adj.has(e.from)) adj.set(e.from, [])
    adj.get(e.from)!.push(e.to)
  }
  // After inserting candidate, starting from candidate.to, can we reach candidate.from?
  const stack: string[] = [candidate.to]
  const visited = new Set<string>()
  while (stack.length) {
    const cur = stack.pop()!
    if (cur === candidate.from) return true
    if (visited.has(cur)) continue
    visited.add(cur)
    const nxt = adj.get(cur)
    if (nxt) stack.push(...nxt)
  }
  return false
}

// -----------------------------------------------------------------------------
// Write-time checks
// -----------------------------------------------------------------------------

export type ApplyEdgeResult =
  | { ok: true; edge: ExperienceEdge; reason?: string }
  | { ok: false; reason: string; downgraded_to?: ExperienceEdge }

/**
 * Apply a single proposal against an in-memory edge list. Returns the mutated
 * list alongside a per-proposal result. Does NOT persist. Callers use this
 * from within `applyBatch` which handles transactional persistence.
 *
 * Safety checks, in order:
 *   1. from !== to (no self-loops)
 *   2. valid exp IDs (caller's responsibility; we only check non-empty)
 *   3. duplicate (same from/to/kind already present → idempotent skip)
 *   4. cycle check on DAG kinds → downgrade to `supports` if possible,
 *      otherwise reject
 */
export function tryApplyProposal(
  edges: ExperienceEdge[],
  proposal: Omit<ExperienceEdge, "id" | "created_at"> & { created_at?: number },
): { edges: ExperienceEdge[]; result: ApplyEdgeResult } {
  const now = proposal.created_at ?? Date.now()

  if (!proposal.from || !proposal.to) {
    return {
      edges,
      result: { ok: false, reason: "missing_from_or_to" },
    }
  }

  if (proposal.from === proposal.to) {
    return {
      edges,
      result: { ok: false, reason: "self_loop" },
    }
  }

  // duplicate check
  const dup = edges.find(
    (e) => e.from === proposal.from && e.to === proposal.to && e.kind === proposal.kind,
  )
  if (dup) {
    return { edges, result: { ok: true, edge: dup, reason: "duplicate_skipped" } }
  }

  // cycle check on DAG kinds
  if (wouldCreateCycle(edges, proposal)) {
    // Downgrade strategy: if requires would cycle, degrade to supports.
    // supports allows cycles, so it never needs a further check.
    if (proposal.kind === "requires") {
      const downgraded: ExperienceEdge = {
        ...proposal,
        kind: "supports",
        id: makeEdgeID(proposal.from, proposal.to, "supports"),
        created_at: now,
      }
      // But supports could still be a duplicate
      const supDup = edges.find(
        (e) => e.from === downgraded.from && e.to === downgraded.to && e.kind === "supports",
      )
      if (supDup) {
        return {
          edges,
          result: { ok: false, reason: "cycle_detected_and_downgrade_duplicate", downgraded_to: supDup },
        }
      }
      return {
        edges: [...edges, downgraded],
        result: { ok: false, reason: "cycle_detected_downgraded_to_supports", downgraded_to: downgraded },
      }
    }
    // refines cycle — drop (rare; refines is already meant to be DAG; downgrade to see_also)
    if (proposal.kind === "refines") {
      const downgraded: ExperienceEdge = {
        ...proposal,
        kind: "see_also",
        id: makeEdgeID(proposal.from, proposal.to, "see_also"),
        created_at: now,
      }
      const saDup = edges.find(
        (e) => e.from === downgraded.from && e.to === downgraded.to && e.kind === "see_also",
      )
      if (saDup) {
        return {
          edges,
          result: { ok: false, reason: "refines_cycle_and_downgrade_duplicate", downgraded_to: saDup },
        }
      }
      return {
        edges: [...edges, downgraded],
        result: { ok: false, reason: "refines_cycle_downgraded_to_see_also", downgraded_to: downgraded },
      }
    }
  }

  const edge: ExperienceEdge = {
    ...proposal,
    id: makeEdgeID(proposal.from, proposal.to, proposal.kind),
    created_at: now,
  }
  return { edges: [...edges, edge], result: { ok: true, edge } }
}

/**
 * Transactional batch apply: evaluate all proposals against a snapshot;
 * returns the resulting list ready to be persisted. Individual failures are
 * reported in `results` but do NOT abort the batch — this matches the design
 * principle that an LLM batch may have some bad edges we want to drop/downgrade
 * while keeping the good ones. If the caller wants strict all-or-nothing
 * semantics, they inspect `results` and refuse to persist on any failure.
 */
export function applyBatch(
  current: ExperienceEdge[],
  proposals: Array<Omit<ExperienceEdge, "id" | "created_at"> & { created_at?: number }>,
  opts?: { max?: number },
): { edges: ExperienceEdge[]; results: ApplyEdgeResult[] } {
  const capped = opts?.max != null ? proposals.slice(0, opts.max) : proposals
  let edges = current
  const results: ApplyEdgeResult[] = []
  for (const p of capped) {
    const { edges: next, result } = tryApplyProposal(edges, p)
    edges = next
    results.push(result)
  }
  return { edges, results }
}

// -----------------------------------------------------------------------------
// Mutations with persistence
// -----------------------------------------------------------------------------

/** Persist a batch of proposals. Returns the applied results + final edges. */
export async function persistBatch(
  base: string,
  proposals: Array<Omit<ExperienceEdge, "id" | "created_at"> & { created_at?: number }>,
  opts?: { max?: number },
) {
  const current = await readEdges(base)
  const { edges, results } = applyBatch(current, proposals, opts)
  if (edges !== current) {
    await writeAllEdges(base, edges)
  }
  return { edges, results }
}

/** Delete edges matching a predicate. Returns the number removed. */
export async function removeEdges(
  base: string,
  predicate: (edge: ExperienceEdge) => boolean,
): Promise<number> {
  const current = await readEdges(base)
  const kept = current.filter((e) => !predicate(e))
  if (kept.length === current.length) return 0
  if (kept.length === 0) {
    await unlink(graphFilepath(base)).catch(() => {})
  } else {
    await writeAllEdges(base, kept)
  }
  return current.length - kept.length
}

/** Delete every edge that touches the given experience id (from OR to). */
export async function removeEdgesFor(base: string, experienceID: string) {
  return removeEdges(base, (e) => e.from === experienceID || e.to === experienceID)
}

/** Rewire edges whose from/to equal `fromID` to point at `toID` instead. */
export async function rewireEdges(base: string, fromID: string, toID: string) {
  const current = await readEdges(base)
  let changed = 0
  const next: ExperienceEdge[] = []
  for (const e of current) {
    if (e.from !== fromID && e.to !== toID && e.from !== fromID && e.to !== fromID) {
      next.push(e)
      continue
    }
    const updated: ExperienceEdge = {
      ...e,
      from: e.from === fromID ? toID : e.from,
      to: e.to === fromID ? toID : e.to,
    }
    // Reassign id since from/to/kind tuple changed
    updated.id = makeEdgeID(updated.from, updated.to, updated.kind)
    // Skip self-loops created by the rewire
    if (updated.from === updated.to) {
      changed++
      continue
    }
    next.push(updated)
    changed++
  }
  // Dedup after rewire
  const seen = new Set<string>()
  const deduped: ExperienceEdge[] = []
  for (const e of next) {
    const key = edgeKey(e.from, e.to, e.kind)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(e)
  }
  if (changed > 0 || deduped.length !== current.length) {
    await writeAllEdges(base, deduped)
  }
  return { changed, total: deduped.length }
}

// -----------------------------------------------------------------------------
// Traversal
// -----------------------------------------------------------------------------

export type NeighborOpts = {
  edgeKinds?: EdgeKind[]
  direction?: "in" | "out" | "both"
  maxDepth?: number
}

export type NeighborResult = {
  nodes: string[] // experience IDs, including the root (at index 0 when reachable)
  edges: ExperienceEdge[]
  depth: Map<string, number>
}

/**
 * BFS traversal from a seed. Always maintains a visited set — even if the
 * underlying graph has residual cycles, traversal will terminate.
 */
export function traverseFrom(
  edges: ExperienceEdge[],
  seed: string,
  opts?: NeighborOpts,
): NeighborResult {
  const kinds = opts?.edgeKinds ? new Set(opts.edgeKinds) : undefined
  const direction = opts?.direction ?? "both"
  const maxDepth = Math.max(0, opts?.maxDepth ?? 2)

  const outAdj = new Map<string, ExperienceEdge[]>()
  const inAdj = new Map<string, ExperienceEdge[]>()
  for (const e of edges) {
    if (kinds && !kinds.has(e.kind)) continue
    if (!outAdj.has(e.from)) outAdj.set(e.from, [])
    outAdj.get(e.from)!.push(e)
    if (!inAdj.has(e.to)) inAdj.set(e.to, [])
    inAdj.get(e.to)!.push(e)
  }

  const visited = new Set<string>([seed])
  const depth = new Map<string, number>([[seed, 0]])
  const nodes: string[] = [seed]
  const edgesOut: ExperienceEdge[] = []
  const queue: string[] = [seed]

  while (queue.length) {
    const cur = queue.shift()!
    const d = depth.get(cur)!
    if (d >= maxDepth) continue

    const collect: Array<{ neighbor: string; edge: ExperienceEdge }> = []
    if (direction === "out" || direction === "both") {
      for (const e of outAdj.get(cur) ?? []) collect.push({ neighbor: e.to, edge: e })
    }
    if (direction === "in" || direction === "both") {
      for (const e of inAdj.get(cur) ?? []) collect.push({ neighbor: e.from, edge: e })
    }
    for (const { neighbor, edge } of collect) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor)
        nodes.push(neighbor)
        depth.set(neighbor, d + 1)
        queue.push(neighbor)
      }
      // Record the edge at most once. edges arr is small so linear check OK.
      if (!edgesOut.includes(edge)) edgesOut.push(edge)
    }
  }

  return { nodes, edges: edgesOut, depth }
}

// -----------------------------------------------------------------------------
// Integrity helpers
// -----------------------------------------------------------------------------

/**
 * Drop edges that reference experience IDs not present in the provided set.
 * Returns number of dangling edges pruned. Safe to call opportunistically.
 */
export async function pruneDangling(base: string, aliveExperienceIDs: Set<string>) {
  return removeEdges(base, (e) => !aliveExperienceIDs.has(e.from) || !aliveExperienceIDs.has(e.to))
}
