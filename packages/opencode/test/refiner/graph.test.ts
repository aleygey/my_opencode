/**
 * Unit tests for packages/opencode/src/refiner/graph.ts
 *
 * These tests intentionally import the graph module directly (no Session,
 * Workflow, or tool registry) so they don't trip the pre-existing
 * `tool/workflow.ts ↔ Workflow.Summary` module-load cycle that broke the old
 * end-to-end refiner test.
 */

import { describe, expect, test } from "bun:test"
import type { ExperienceEdge, EdgeKind } from "@/refiner/graph"
import {
  applyBatch,
  tryApplyProposal,
  traverseFrom,
  wouldCreateCycle,
} from "@/refiner/graph"

type ProposalInput = Omit<ExperienceEdge, "id" | "created_at"> & {
  created_at?: number
}

const mkProp = (
  from: string,
  to: string,
  kind: EdgeKind,
  opts?: Partial<ProposalInput>,
): ProposalInput => ({
  from,
  to,
  kind,
  reason: opts?.reason ?? `${from}-${kind}-${to}`,
  confidence: opts?.confidence ?? 0.7,
  created_by: opts?.created_by ?? "llm_route",
  source_observation_id: opts?.source_observation_id,
  created_at: opts?.created_at,
})

describe("wouldCreateCycle", () => {
  test("self-loop on DAG kind", () => {
    expect(wouldCreateCycle([], { from: "a", to: "a", kind: "requires" })).toBe(true)
  })

  test("self-loop on non-DAG kind is not reported as cycle", () => {
    // (self-loop is still rejected elsewhere, but wouldCreateCycle specifically
    // only inspects DAG kinds.)
    expect(wouldCreateCycle([], { from: "a", to: "a", kind: "supports" })).toBe(false)
  })

  test("simple 2-node cycle on requires", () => {
    const existing: ExperienceEdge[] = [
      {
        id: "1",
        from: "a",
        to: "b",
        kind: "requires",
        reason: "",
        confidence: 1,
        created_at: 0,
        created_by: "llm_route",
      },
    ]
    expect(wouldCreateCycle(existing, { from: "b", to: "a", kind: "requires" })).toBe(true)
  })

  test("3-node cycle detection", () => {
    const existing: ExperienceEdge[] = [
      { id: "1", from: "a", to: "b", kind: "requires", reason: "", confidence: 1, created_at: 0, created_by: "llm_route" },
      { id: "2", from: "b", to: "c", kind: "requires", reason: "", confidence: 1, created_at: 0, created_by: "llm_route" },
    ]
    expect(wouldCreateCycle(existing, { from: "c", to: "a", kind: "requires" })).toBe(true)
  })

  test("non-cycle addition is fine", () => {
    const existing: ExperienceEdge[] = [
      { id: "1", from: "a", to: "b", kind: "requires", reason: "", confidence: 1, created_at: 0, created_by: "llm_route" },
    ]
    expect(wouldCreateCycle(existing, { from: "b", to: "c", kind: "requires" })).toBe(false)
  })

  test("cycle check is scoped to the same kind (requires vs refines independent)", () => {
    const existing: ExperienceEdge[] = [
      { id: "1", from: "a", to: "b", kind: "refines", reason: "", confidence: 1, created_at: 0, created_by: "llm_route" },
    ]
    // Adding a requires b->a is NOT a cycle in requires subgraph
    expect(wouldCreateCycle(existing, { from: "b", to: "a", kind: "requires" })).toBe(false)
  })
})

describe("tryApplyProposal", () => {
  test("rejects self-loop", () => {
    const { result } = tryApplyProposal([], mkProp("a", "a", "requires"))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("self_loop")
  })

  test("appends fresh edge", () => {
    const { edges, result } = tryApplyProposal([], mkProp("a", "b", "requires"))
    expect(result.ok).toBe(true)
    expect(edges.length).toBe(1)
    expect(edges[0]!.from).toBe("a")
    expect(edges[0]!.to).toBe("b")
    expect(edges[0]!.kind).toBe("requires")
    expect(edges[0]!.id).toHaveLength(12)
  })

  test("dedup: same (from,to,kind) reported ok with duplicate_skipped", () => {
    const first = tryApplyProposal([], mkProp("a", "b", "requires"))
    const second = tryApplyProposal(first.edges, mkProp("a", "b", "requires"))
    expect(second.edges).toHaveLength(1)
    expect(second.result.ok).toBe(true)
    if (second.result.ok) expect(second.result.reason).toBe("duplicate_skipped")
  })

  test("requires cycle → downgrade to supports", () => {
    const start = tryApplyProposal([], mkProp("a", "b", "requires"))
    const cyc = tryApplyProposal(start.edges, mkProp("b", "a", "requires"))
    expect(cyc.result.ok).toBe(false)
    if (!cyc.result.ok) {
      expect(cyc.result.reason).toBe("cycle_detected_downgraded_to_supports")
      expect(cyc.result.downgraded_to?.kind).toBe("supports")
      expect(cyc.result.downgraded_to?.from).toBe("b")
      expect(cyc.result.downgraded_to?.to).toBe("a")
    }
    // The downgraded edge IS persisted to the list
    expect(cyc.edges.some((e) => e.kind === "supports" && e.from === "b" && e.to === "a")).toBe(true)
  })

  test("refines cycle → downgrade to see_also", () => {
    const start = tryApplyProposal([], mkProp("a", "b", "refines"))
    const cyc = tryApplyProposal(start.edges, mkProp("b", "a", "refines"))
    expect(cyc.result.ok).toBe(false)
    if (!cyc.result.ok) {
      expect(cyc.result.reason).toBe("refines_cycle_downgraded_to_see_also")
      expect(cyc.result.downgraded_to?.kind).toBe("see_also")
    }
    expect(cyc.edges.some((e) => e.kind === "see_also")).toBe(true)
  })

  test("supports is allowed to cycle", () => {
    const a2b = tryApplyProposal([], mkProp("a", "b", "supports"))
    const b2a = tryApplyProposal(a2b.edges, mkProp("b", "a", "supports"))
    expect(b2a.result.ok).toBe(true)
    expect(b2a.edges).toHaveLength(2)
  })
})

describe("applyBatch", () => {
  test("caps at opts.max", () => {
    const proposals: ProposalInput[] = [
      mkProp("a", "b", "requires"),
      mkProp("b", "c", "requires"),
      mkProp("c", "d", "requires"),
    ]
    const { edges, results } = applyBatch([], proposals, { max: 2 })
    expect(results).toHaveLength(2)
    expect(edges).toHaveLength(2)
  })

  test("mixes success and cycle-downgrade in one batch", () => {
    const batch: ProposalInput[] = [
      mkProp("a", "b", "requires"), // ok
      mkProp("b", "a", "requires"), // cycle → downgraded to supports
      mkProp("a", "c", "supports"), // ok
    ]
    const { edges, results } = applyBatch([], batch)
    expect(results).toHaveLength(3)
    expect(results[0]!.ok).toBe(true)
    expect(results[1]!.ok).toBe(false)
    expect(results[2]!.ok).toBe(true)
    // final state: a->b requires, b->a supports (downgrade), a->c supports
    expect(edges).toHaveLength(3)
    expect(edges.find((e) => e.from === "b" && e.to === "a")?.kind).toBe("supports")
  })

  test("duplicate proposals within the same batch dedup", () => {
    const batch: ProposalInput[] = [
      mkProp("a", "b", "requires"),
      mkProp("a", "b", "requires"),
      mkProp("a", "b", "requires"),
    ]
    const { edges } = applyBatch([], batch)
    expect(edges).toHaveLength(1)
  })
})

describe("traverseFrom", () => {
  const fixture: ExperienceEdge[] = [
    { id: "e1", from: "a", to: "b", kind: "requires", reason: "", confidence: 1, created_at: 0, created_by: "llm_route" },
    { id: "e2", from: "b", to: "c", kind: "requires", reason: "", confidence: 1, created_at: 0, created_by: "llm_route" },
    { id: "e3", from: "c", to: "d", kind: "refines", reason: "", confidence: 1, created_at: 0, created_by: "llm_route" },
    { id: "e4", from: "x", to: "b", kind: "supports", reason: "", confidence: 1, created_at: 0, created_by: "llm_route" },
  ]

  test("out direction, depth 1, requires only", () => {
    const r = traverseFrom(fixture, "a", { edgeKinds: ["requires"], direction: "out", maxDepth: 1 })
    expect(r.nodes.sort()).toEqual(["a", "b"])
    expect(r.edges.map((e) => e.id)).toEqual(["e1"])
  })

  test("out direction, depth 2, requires+refines follows chain a→b→c→d", () => {
    const r = traverseFrom(fixture, "a", {
      edgeKinds: ["requires", "refines"],
      direction: "out",
      maxDepth: 3,
    })
    expect(r.nodes.sort()).toEqual(["a", "b", "c", "d"])
  })

  test("both direction picks up in-edges too", () => {
    const r = traverseFrom(fixture, "b", {
      edgeKinds: ["requires", "supports"],
      direction: "both",
      maxDepth: 1,
    })
    // neighbors of b: a (in via requires), c (out via requires), x (in via supports)
    expect(r.nodes.sort()).toEqual(["a", "b", "c", "x"])
  })

  test("cycles don't hang traversal (visited set guards)", () => {
    // Deliberately introduce a supports cycle (allowed) and ensure traversal
    // terminates with a bounded node set.
    const cyclic: ExperienceEdge[] = [
      { id: "c1", from: "p", to: "q", kind: "supports", reason: "", confidence: 1, created_at: 0, created_by: "llm_route" },
      { id: "c2", from: "q", to: "p", kind: "supports", reason: "", confidence: 1, created_at: 0, created_by: "llm_route" },
    ]
    const r = traverseFrom(cyclic, "p", { edgeKinds: ["supports"], direction: "both", maxDepth: 10 })
    expect(r.nodes.sort()).toEqual(["p", "q"])
    expect(r.edges).toHaveLength(2)
  })

  test("depth map is correct", () => {
    const r = traverseFrom(fixture, "a", { edgeKinds: ["requires"], direction: "out", maxDepth: 5 })
    expect(r.depth.get("a")).toBe(0)
    expect(r.depth.get("b")).toBe(1)
    expect(r.depth.get("c")).toBe(2)
  })
})
