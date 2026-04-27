import { Effect } from "effect"
import z from "zod"
import * as Tool from "./tool"
import { Workflow } from "@/workflow"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { AppRuntime } from "@/effect/app-runtime"
import { SessionID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"

const model = z
  .object({
    providerID: z.string().optional(),
    modelID: z.string().optional(),
    variant: z.string().optional(),
  })
  .optional()

const nodePatch = z.object({
  status: z.enum(["pending", "ready", "running", "waiting", "paused", "interrupted", "completed", "failed", "cancelled"]).optional(),
  result_status: z.enum(["unknown", "success", "fail", "partial"]).optional(),
  fail_reason: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
  model: model.nullable().optional(),
  config: z
    .object({
      mode: z.enum(["replace", "merge"]).optional(),
      value: z.record(z.string(), z.any()).optional(),
    })
    .optional(),
  state_json: z
    .object({
      mode: z.enum(["replace", "merge"]).optional(),
      value: z.record(z.string(), z.any()).optional(),
    })
    .optional(),
  result_json: z
    .object({
      mode: z.enum(["replace", "merge"]).optional(),
      value: z.record(z.string(), z.any()).optional(),
    })
    .optional(),
  attempt_delta: z.number().int().optional(),
  action_count: z.number().int().nonnegative().optional(),
  max_attempts: z.number().int().positive().optional(),
  max_actions: z.number().int().positive().optional(),
  title: z.string().optional(),
})

const format = (value: unknown) => JSON.stringify(value, null, 2)

const confirm = /(^|\b)(confirm|confirmed|approve|approved|go ahead|proceed|start now|execute now|run it|ship it)(\b|$)|确认执行|确认开始|开始执行|可以执行|开始吧|执行吧|继续执行|请开始/iu

const assertNodeSession = (node: Awaited<ReturnType<typeof Workflow.getNode>>, sessionID: string) => {
  if (!node.session_id) throw new Error(`Workflow node ${node.id} has no active subagent session.`)
  if (node.session_id === sessionID) return
  throw new Error(`Workflow node ${node.id} must be operated from its bound subagent session ${node.session_id}.`)
}

const configured = (value?: {
  providerID?: string
  modelID?: string
  variant?: string
} | null) => !!value?.providerID && !!value?.modelID

// ── schemas ────────────────────────────────────────────────────────────────

// The `@/workflow` module cycles back through `SessionPrompt → ToolRegistry →
// tool/workflow.ts`, so `Workflow.*` is only partially initialized when this
// file loads. Any reference that resolves to `Workflow.Summary` or
// `Workflow.create.schema.*` at module-eval time hits `undefined` (see the
// `wh.Summary` runtime crash in the packaged binary). Build the schema lazily
// — both z.lazy and an accessor inside the Tool.define init run after the
// workflow namespace has finished initializing.
const WorkflowCreateParameters = z.lazy(() =>
  z.object({
    title: z.string(),
    session_id: z.string().optional(),
    config: z.record(z.string(), z.any()).optional(),
    summary: Workflow.Summary.optional(),
    nodes: Workflow.create.schema.shape.nodes,
    edges: Workflow.create.schema.shape.edges,
    checkpoints: Workflow.create.schema.shape.checkpoints,
  }),
)

const WorkflowNodeCreateParameters = z.object({
  workflow_id: z.string(),
  title: z.string(),
  agent: z.string(),
  model,
  config: z.record(z.string(), z.any()).optional(),
  max_attempts: z.number().int().positive().optional(),
  max_actions: z.number().int().positive().optional(),
  position: z.number().int().nonnegative().optional(),
  create_session: z.boolean().optional().default(false),
  initial_prompt: z.string().optional(),
})

const WorkflowNodeStartParameters = z.object({
  node_id: z.string(),
  title: z.string().optional(),
  model,
  status: z.enum(["ready", "running", "waiting"]).optional(),
  initial_prompt: z.string(),
})

const WorkflowNodePauseParameters = z.object({
  node_id: z.string(),
  reason: z.string().optional(),
})

const WorkflowNodeAbortParameters = z.object({
  node_id: z.string(),
  reason: z.string().optional(),
})

const WorkflowEdgeCreateParameters = z.object({
  workflow_id: z.string(),
  from_node_id: z.string(),
  to_node_id: z.string(),
  label: z.string().optional(),
  config: z.record(z.string(), z.any()).optional(),
})

const WorkflowCheckpointCreateParameters = z.object({
  workflow_id: z.string(),
  node_id: z.string(),
  label: z.string(),
  status: z.enum(["pending", "passed", "failed", "skipped"]).optional(),
  config: z.record(z.string(), z.any()).optional(),
  result_json: z.record(z.string(), z.any()).optional(),
})

const WorkflowReadParameters = z.object({
  workflow_id: z.string(),
  cursor: z.number().int().nonnegative().optional(),
})

const WorkflowControlParameters = z.object({
  workflow_id: z.string(),
  node_id: z.string(),
  command: z.enum(["continue", "resume", "retry", "inject_context"]),
  payload: z.record(z.string(), z.any()).optional(),
})

const WorkflowUpdateParameters = z.object({
  node_id: z.string().optional(),
  patch: nodePatch,
  event_kind: z.string().optional(),
  event_payload: z.record(z.string(), z.any()).optional(),
  /** List of runtime command_ids this update acknowledges. Removes them
   *  from pending_commands and emits node.command_acked. */
  ack: z.array(z.string()).optional(),
  ack_note: z.string().optional(),
  /** Optional structured need. When set, the node auto-transitions to
   *  waiting (unless already terminal) and pushes an entry into
   *  state_json.open_needs for the orchestrator to fulfill. */
  open_need: z
    .object({
      title: z.string(),
      prompt: z.string().optional(),
      kind: z.enum(["context", "approval", "tool", "other"]).optional(),
      required_by: z.string().optional(),
    })
    .optional(),
})

const WorkflowNeedFulfillParameters = z.object({
  node_id: z.string(),
  need_id: z.string(),
  context: z.string(),
  resolution_note: z.string().optional(),
})

const WorkflowPullParameters = z.object({
  node_id: z.string().optional(),
  cursor: z.number().int().nonnegative().optional(),
})

// ── tools ──────────────────────────────────────────────────────────────────

export const WorkflowCreateTool = Tool.define(
  "workflow_create",
  Effect.gen(function* () {
    const session = yield* Session.Service

    const last = (sessionID: string) =>
      Effect.gen(function* () {
        const msgs = yield* session.messages({ sessionID: SessionID.make(sessionID), limit: 40 })
        return msgs
          .toReversed()
          .find((msg) => msg.info.role === "user" && msg.parts.some((part) => !("synthetic" in part) || !part.synthetic))
      })

    const text = (sessionID: string) =>
      Effect.gen(function* () {
        const msg = yield* last(sessionID)
        return (
          msg?.parts
            .flatMap((part) =>
              part.type === "text" && (!("synthetic" in part) || !part.synthetic) ? [part.text] : [],
            )
            .join("\n")
            .trim() ?? ""
        )
      })

    const assertConfirmed = (sessionID: string) =>
      Effect.gen(function* () {
        const msg = yield* text(sessionID)
        if (confirm.test(msg)) return
        throw new Error(
          "workflow_create is blocked until the user explicitly confirms execution in the root orchestrator session.",
        )
      })

    return {
      description:
        "Create a workflow runtime with nodes, edges, checkpoints, and a root orchestrator session.",
      parameters: WorkflowCreateParameters,
      execute: (input: z.infer<typeof WorkflowCreateParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* assertConfirmed(input.session_id ?? ctx.sessionID)
          const info = yield* Effect.promise(() =>
            Workflow.create({
              session_id: input.session_id ?? ctx.sessionID,
              title: input.title,
              config: input.config,
              summary: input.summary,
              nodes: input.nodes,
              edges: input.edges,
              checkpoints: input.checkpoints,
            }),
          )
          yield* ctx.metadata({
            title: input.title,
            metadata: {
              workflowID: info.id,
            },
          })
          return {
            title: input.title,
            metadata: {
              workflowID: info.id,
            },
            output: format(info),
          }
        }).pipe(Effect.orDie),
    }
  }),
)


export const WorkflowNodeCreateTool = Tool.define(
  "workflow_node_create",
  Effect.gen(function* () {
    const session = yield* Session.Service
    return {
      description:
        "[DEPRECATED — prefer workflow_graph_propose with an INSERT_NODE op for a consistent edit-log audit trail.] Create a workflow node directly (skips workflow_edit row). Kept for backwards compatibility with existing master prompts; behaves exactly as before.",
      parameters: WorkflowNodeCreateParameters,
      execute: (input: z.infer<typeof WorkflowNodeCreateParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const created = input.create_session
            ? yield* session.create({
                parentID: ctx.sessionID,
                title: `${input.title} (@${input.agent} node)`,
              })
            : undefined
          const node = yield* Effect.promise(() =>
            Workflow.createNode({
              workflowID: input.workflow_id,
              session_id: created?.id,
              title: input.title,
              agent: input.agent,
              model: input.model,
              config: input.config,
              max_attempts: input.max_attempts,
              max_actions: input.max_actions,
              position: input.position,
            }),
          )

          return {
            title: input.title,
            metadata: {
              workflowID: input.workflow_id,
              nodeID: node.id,
              sessionID: created?.id,
            },
            output: format({
              node,
              session_id: created?.id,
            }),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

/**
 * P3 — propose a multi-op graph edit. Records the proposal in
 * `workflow_edit` (status: pending) but does not mutate the graph; a
 * follow-up `workflow_graph_apply` is required to commit. The master can
 * batch as many ops as it likes — they all commit atomically.
 *
 * Op kinds (discriminated union):
 *   - INSERT_NODE: { kind, node: { title, agent, model?, config?, ... } }
 *   - REPLACE_NODE: { kind, node_id, node: <full node shape> }
 *   - MODIFY_NODE: { kind, node_id, patch: <partial fields> }
 *   - DELETE_NODE: { kind, node_id }            // cascades incident edges
 *   - INSERT_EDGE: { kind, edge: { from_node_id, to_node_id, ... } }
 *   - DELETE_EDGE: { kind, edge_id }
 */
const WorkflowGraphProposeParameters = z.lazy(() =>
  z.object({
    workflow_id: z.string(),
    ops: Workflow.EditOp.array().min(1),
    reason: z.string().optional(),
  }),
)

export const WorkflowGraphProposeTool = Tool.define(
  "workflow_graph_propose",
  Effect.gen(function* () {
    return {
      description:
        "Master-only. Propose a batched, multi-op graph edit (INSERT_NODE / REPLACE_NODE / MODIFY_NODE / DELETE_NODE / INSERT_EDGE / DELETE_EDGE). Returns an edit_id. Call workflow_graph_apply with the edit_id to commit, or workflow_graph_reject to discard.",
      parameters: WorkflowGraphProposeParameters,
      execute: (input: z.infer<typeof WorkflowGraphProposeParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const edit = yield* Effect.promise(() =>
            Workflow.proposeEdit({
              workflowID: input.workflow_id,
              proposer_session_id: ctx.sessionID,
              ops: input.ops,
              reason: input.reason,
            }),
          )
          return {
            title: `propose edit (${input.ops.length} op${input.ops.length === 1 ? "" : "s"})`,
            metadata: {
              workflowID: input.workflow_id,
              editID: edit.id,
              graphRevBefore: edit.graph_rev_before,
            },
            output: format(edit),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

/**
 * P3 — apply a previously proposed edit. Re-validates `graph_rev_before`
 * inside the DB transaction; returns the updated edit row including
 * `graph_rev_after`. On stale graph_rev or invariant violation the whole
 * transaction rolls back and the edit stays `pending` so the master can
 * reject and re-propose.
 */
const WorkflowGraphApplyParameters = z.object({
  edit_id: z.string(),
})

export const WorkflowGraphApplyTool = Tool.define(
  "workflow_graph_apply",
  Effect.gen(function* () {
    return {
      description:
        "Master-only. Atomically apply a pending edit (created via workflow_graph_propose). Bumps graph_rev exactly once. Marks downstream completed nodes as stale. Throws on stale graph_rev or invariant violation; the edit stays pending so the master can reject and re-propose.",
      parameters: WorkflowGraphApplyParameters,
      execute: (input: z.infer<typeof WorkflowGraphApplyParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const edit = yield* Effect.promise(() => Workflow.applyEdit({ editID: input.edit_id }))
          return {
            title: `applied edit ${edit.id}`,
            metadata: {
              workflowID: edit.workflow_id,
              editID: edit.id,
              graphRevBefore: edit.graph_rev_before,
              graphRevAfter: edit.graph_rev_after,
            },
            output: format(edit),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

/** P3 — reject a pending edit without applying. */
const WorkflowGraphRejectParameters = z.object({
  edit_id: z.string(),
  reject_reason: z.string(),
})

export const WorkflowGraphRejectTool = Tool.define(
  "workflow_graph_reject",
  Effect.gen(function* () {
    return {
      description: "Master-only. Reject a pending edit by edit_id with a human-readable reason.",
      parameters: WorkflowGraphRejectParameters,
      execute: (input: z.infer<typeof WorkflowGraphRejectParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const edit = yield* Effect.promise(() =>
            Workflow.rejectEdit({
              editID: input.edit_id,
              reject_reason: input.reject_reason,
            }),
          )
          return {
            title: `rejected edit ${edit.id}`,
            metadata: {
              workflowID: edit.workflow_id,
              editID: edit.id,
            },
            output: format(edit),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

/**
 * P4 — analyze the graph and return ready candidates / blockers / capacity.
 * The runtime never auto-promotes nodes; the master uses this to decide what
 * to start next, then calls `workflow_node_start` (or via a future
 * `INSERT_NODE` op + apply followed by `workflow_node_start`).
 */
const WorkflowGraphScanReadyParameters = z.object({
  workflow_id: z.string(),
})

export const WorkflowGraphScanReadyTool = Tool.define(
  "workflow_graph_scan_ready",
  Effect.gen(function* () {
    return {
      description:
        "Master-only. Analyze the graph and return ready candidates (sorted by priority desc, position asc), nodes blocked by a missing upstream or a held resource, the running count, and whether max_concurrent_nodes is saturated.",
      parameters: WorkflowGraphScanReadyParameters,
      execute: (input: z.infer<typeof WorkflowGraphScanReadyParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => Workflow.scanReady(input.workflow_id))
          return {
            title: `scan ready (${result.ready.length} ready, ${result.running_count}/${result.max_concurrent} running${result.saturated ? ", saturated" : ""})`,
            metadata: {
              workflowID: input.workflow_id,
              readyCount: result.ready.length,
              runningCount: result.running_count,
              saturated: result.saturated,
            },
            output: format(result),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

/**
 * P4 — master-controlled exclusive-resource ledger. The runtime never
 * acquires or releases on its own; the master uses this tool whenever it
 * starts / completes a node that holds resources.
 */
const WorkflowGraphResourcesParameters = z.object({
  workflow_id: z.string(),
  acquire: z.record(z.string(), z.string()).optional(),
  release: z.array(z.string()).optional(),
  force: z.boolean().optional(),
})

export const WorkflowGraphResourcesTool = Tool.define(
  "workflow_graph_resources",
  Effect.gen(function* () {
    return {
      description:
        "Master-only. Acquire / release exclusive resource keys on a workflow. `acquire` maps resource_key→node_id (throws on conflict unless force=true; idempotent re-acquire by the same node is a no-op). `release` removes keys silently. Bumps workflow.version but not graph_rev.",
      parameters: WorkflowGraphResourcesParameters,
      execute: (input: z.infer<typeof WorkflowGraphResourcesParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            Workflow.updateResources({
              workflowID: input.workflow_id,
              acquire: input.acquire,
              release: input.release,
              force: input.force,
            }),
          )
          return {
            title: `resources ${result.acquired.length} acquired, ${result.released.length} released`,
            metadata: {
              workflowID: input.workflow_id,
              acquired: result.acquired,
              released: result.released,
            },
            output: format(result),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

/**
 * P5 — terminal-state finalizer for the entire workflow.
 *
 * Master calls this when the workflow has reached its goal (or has
 * unrecoverably failed). Records the structured `result_json` on
 * `workflow.result_json`, flips status, stamps `time_completed`, and emits
 * a `workflow.updated` event with `kind: "finalized"`. Refuses to run
 * while child nodes are still active unless `force: true`.
 */
const WorkflowFinalizeParameters = z.object({
  workflow_id: z.string(),
  status: z.enum(["completed", "failed", "cancelled"]),
  result_json: z.record(z.string(), z.any()).optional(),
  fail_reason: z.string().optional(),
  force: z.boolean().optional(),
})

export const WorkflowFinalizeTool = Tool.define(
  "workflow_finalize",
  Effect.gen(function* () {
    return {
      description:
        "Master-only. Finalize the workflow: write the structured result_json, flip status to completed/failed/cancelled, and stamp time_completed. Refuses if any node is still active (pending/ready/running/waiting/paused/interrupted) unless force: true. Bumps workflow.version but not graph_rev.",
      parameters: WorkflowFinalizeParameters,
      execute: (input: z.infer<typeof WorkflowFinalizeParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            Workflow.finalize({
              workflowID: input.workflow_id,
              status: input.status,
              result_json: input.result_json,
              fail_reason: input.fail_reason,
              force: input.force,
            }),
          )
          return {
            title: `workflow ${input.status}`,
            metadata: {
              workflowID: input.workflow_id,
              status: result.finalized_status,
              forced: !!input.force,
            },
            output: format(result),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const WorkflowNodeStartTool = Tool.define(
  "workflow_node_start",
  Effect.gen(function* () {
    const session = yield* Session.Service

    // SessionPrompt.Service is intentionally NOT pulled at init time to avoid
    // a hard Layer cycle (ToolRegistry ⇄ SessionPrompt). We bridge to it at
    // use time via AppRuntime instead.
    const prompt = (input: {
      workflowID: string
      nodeID: string
      agent: string
      sessionID: string
      model?: {
        providerID?: string
        modelID?: string
        variant?: string
      }
      text: string
    }) =>
      Effect.promise(() =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const sp = yield* SessionPrompt.Service
            return yield* sp.prompt({
              sessionID: SessionID.make(input.sessionID),
              agent: input.agent,
              model:
                input.model?.providerID && input.model.modelID
                  ? {
                      providerID: ProviderID.make(input.model.providerID),
                      modelID: ModelID.make(input.model.modelID),
                    }
                  : undefined,
              variant: input.model?.variant,
              parts: [
                {
                  type: "text",
                  text: [
                    `You are executing workflow node ${input.nodeID} in workflow ${input.workflowID}.`,
                    "Do the work in this subagent session, not in the root orchestrator session.",
                    "Workflow tools available to you: workflow_pull, workflow_update, workflow_read, workflow_need_fulfill, workflow_checkpoint_create.",
                    "If a tool name is referenced here but does not appear in your function list, retry the action once before giving up — never claim the runtime is missing a workflow_* tool until you have actually attempted to call it.",
                    "Call workflow_pull immediately, follow runtime commands, report progress with workflow_update, and continue until you complete or block.",
                    "",
                    input.text,
                  ].join("\n"),
                },
              ],
            })
          }),
        ),
      )

    return {
      description:
        "Start an existing workflow node by creating and attaching its child session, then optionally send the initial prompt. Idempotent — calling on an already-running node returns the current state without re-prompting.",
      parameters: WorkflowNodeStartParameters,
      execute: (input: z.infer<typeof WorkflowNodeStartParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const current = yield* Effect.promise(() => Workflow.getNode(input.node_id))
          if (current.status === "cancelled") {
            throw new Error(`Workflow node ${current.id} is cancelled and cannot be started again.`)
          }
          if (current.status === "completed") {
            throw new Error(
              `Workflow node ${current.id} is already completed; use workflow_control with retry to re-run.`,
            )
          }

          // P0.3 idempotent start: if the node is already running / waiting with an
          // attached session, skip session creation and re-prompting. This keeps
          // accidental double-calls from spawning another LLM round mid-execution.
          if (
            current.session_id &&
            (current.status === "running" || current.status === "waiting")
          ) {
            return {
              title: current.title,
              metadata: {
                workflowID: current.workflow_id,
                nodeID: current.id,
                sessionID: current.session_id,
              },
              output: format({
                node: current,
                session_id: current.session_id,
                idempotent: true,
                reason: `node already ${current.status}; skipped re-prompt`,
              }),
            }
          }

          const picked = input.model ?? current.model
          if (!configured(picked)) {
            throw new Error(
              `Workflow node ${current.id} cannot start until a providerID and modelID are configured.`,
            )
          }
          const childSession = current.session_id
            ? yield* session.get(SessionID.make(current.session_id))
            : yield* session.create({
                parentID: ctx.sessionID,
                title: input.title ?? `${current.title} (@${current.agent} node)`,
              })

          const node = current.session_id
            ? current
            : yield* Effect.promise(() =>
                Workflow.patchNode({
                  nodeID: current.id,
                  source: "orchestrator",
                  patch: {
                    session_id: childSession.id,
                    status: input.status ?? "running",
                    model: picked,
                  },
                  event: {
                    kind: "node.started",
                    payload: {
                      session_id: childSession.id,
                    },
                  },
                }),
              )

          yield* Effect.promise(() =>
            Workflow.control({
              workflowID: node.workflow_id,
              nodeID: node.id,
              source: "orchestrator",
              command: "continue",
              payload: {
                reason: "node_started",
              },
            }),
          )

          // Fire-and-forget prompt — matches legacy `void prompt(...).catch(...)`.
          yield* Effect.forkDetach(
            prompt({
              workflowID: node.workflow_id,
              nodeID: node.id,
              agent: node.agent,
              sessionID: childSession.id,
              model: picked,
              text: input.initial_prompt,
            }).pipe(Effect.ignore),
          )

          return {
            title: node.title,
            metadata: {
              workflowID: node.workflow_id,
              nodeID: node.id,
              sessionID: childSession.id,
            },
            output: format({
              node,
              session_id: childSession.id,
            }),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const WorkflowNodePauseTool = Tool.define(
  "workflow_node_pause",
  Effect.gen(function* () {
    return {
      description:
        "Pause a workflow node immediately by stopping its current subagent loop and marking the node as paused.",
      parameters: WorkflowNodePauseParameters,
      execute: (input: z.infer<typeof WorkflowNodePauseParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const node = yield* Effect.promise(() =>
            Workflow.pauseNode({
              nodeID: input.node_id,
              source: "orchestrator",
              reason: input.reason,
            }),
          )
          return {
            title: node.title,
            metadata: {
              workflowID: node.workflow_id,
              nodeID: node.id,
            },
            output: format(node),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const WorkflowNodeAbortTool = Tool.define(
  "workflow_node_abort",
  Effect.gen(function* () {
    return {
      description:
        "Abort a workflow node immediately by stopping its current subagent loop and marking the node as cancelled.",
      parameters: WorkflowNodeAbortParameters,
      execute: (input: z.infer<typeof WorkflowNodeAbortParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const node = yield* Effect.promise(() =>
            Workflow.abortNode({
              nodeID: input.node_id,
              source: "orchestrator",
              reason: input.reason,
            }),
          )
          return {
            title: node.title,
            metadata: {
              workflowID: node.workflow_id,
              nodeID: node.id,
            },
            output: format(node),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const WorkflowEdgeCreateTool = Tool.define(
  "workflow_edge_create",
  Effect.gen(function* () {
    return {
      description:
        "[DEPRECATED — prefer workflow_graph_propose with an INSERT_EDGE op for a consistent edit-log audit trail.] Create a dependency edge between two workflow nodes directly (skips workflow_edit row). Kept for backwards compatibility; still validates DAG invariants and bumps graph_rev.",
      parameters: WorkflowEdgeCreateParameters,
      execute: (input: z.infer<typeof WorkflowEdgeCreateParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const edge = yield* Effect.promise(() =>
            Workflow.createEdge({
              workflowID: input.workflow_id,
              from_node_id: input.from_node_id,
              to_node_id: input.to_node_id,
              label: input.label,
              config: input.config,
            }),
          )
          return {
            title: input.label ?? "workflow edge",
            metadata: {
              workflowID: input.workflow_id,
              edgeID: edge.id,
            },
            output: format(edge),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const WorkflowCheckpointCreateTool = Tool.define(
  "workflow_checkpoint_create",
  Effect.gen(function* () {
    return {
      description:
        "[LEGACY — checkpoints are not part of the dynamic-graph edit protocol.] Create a checkpoint attached to a workflow node. Use sparingly: in the master-controlled flow, prefer expressing acceptance criteria via node output_schema or an explicit verification node.",
      parameters: WorkflowCheckpointCreateParameters,
      execute: (input: z.infer<typeof WorkflowCheckpointCreateParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const checkpoint = yield* Effect.promise(() =>
            Workflow.createCheckpoint({
              workflowID: input.workflow_id,
              node_id: input.node_id,
              label: input.label,
              status: input.status,
              config: input.config,
              result_json: input.result_json,
            }),
          )
          return {
            title: input.label,
            metadata: {
              workflowID: input.workflow_id,
              checkpointID: checkpoint.id,
            },
            output: format(checkpoint),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const WorkflowReadTool = Tool.define(
  "workflow_read",
  Effect.gen(function* () {
    return {
      description:
        "Read workflow runtime state. Prefer passing cursor to fetch only incremental changes.",
      parameters: WorkflowReadParameters,
      execute: (input: z.infer<typeof WorkflowReadParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            Workflow.read({
              workflowID: input.workflow_id,
              cursor: input.cursor,
            }),
          )
          return {
            title: "workflow read",
            metadata: {
              workflowID: input.workflow_id,
              cursor: result.cursor,
            },
            output: format(result),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const WorkflowControlTool = Tool.define(
  "workflow_control",
  Effect.gen(function* () {
    // SessionPrompt.Service is intentionally NOT pulled at init time to avoid
    // a hard Layer cycle (ToolRegistry ⇄ SessionPrompt). We bridge to it at
    // use time via AppRuntime instead.
    const prompt = (input: {
      workflowID: string
      nodeID: string
      agent: string
      sessionID: string
      model?: {
        providerID?: string
        modelID?: string
        variant?: string
      }
      text: string
    }) =>
      Effect.promise(() =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const sp = yield* SessionPrompt.Service
            return yield* sp.prompt({
              sessionID: SessionID.make(input.sessionID),
              agent: input.agent,
              model:
                input.model?.providerID && input.model.modelID
                  ? {
                      providerID: ProviderID.make(input.model.providerID),
                      modelID: ModelID.make(input.model.modelID),
                    }
                  : undefined,
              variant: input.model?.variant,
              parts: [
                {
                  type: "text",
                  text: [
                    `You are executing workflow node ${input.nodeID} in workflow ${input.workflowID}.`,
                    "Do the work in this subagent session, not in the root orchestrator session.",
                    "Workflow tools available to you: workflow_pull, workflow_update, workflow_read, workflow_need_fulfill, workflow_checkpoint_create.",
                    "If a tool name is referenced here but does not appear in your function list, retry the action once before giving up — never claim the runtime is missing a workflow_* tool until you have actually attempted to call it.",
                    "Call workflow_pull immediately, follow runtime commands, report progress with workflow_update, and continue until you complete or block.",
                    "",
                    input.text,
                  ].join("\n"),
                },
              ],
            })
          }),
        ),
      )

    return {
      description:
        "Send a soft control command to a workflow node, such as continue, resume, retry, or context injection. Duplicates within a 5s window are silently absorbed.",
      parameters: WorkflowControlParameters,
      execute: (input: z.infer<typeof WorkflowControlParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            Workflow.control({
              workflowID: input.workflow_id,
              nodeID: input.node_id,
              source: "orchestrator",
              command: input.command,
              payload: input.payload,
            }),
          )
          const node = yield* Effect.promise(() => Workflow.getNode(input.node_id))
          // Only re-prompt the slave if we actually enqueued a new command.
          // Deduped commands already have an in-flight slave round.
          if (!result.deduped && node.session_id) {
            yield* Effect.forkDetach(
              prompt({
                workflowID: input.workflow_id,
                nodeID: input.node_id,
                agent: node.agent,
                sessionID: node.session_id,
                model: node.model,
                text: [
                  `Runtime command: ${input.command} (command_id: ${result.command_id})`,
                  input.payload ? JSON.stringify(input.payload, null, 2) : "",
                  "Call workflow_pull now, apply the command, ack it via workflow_update.patch.ack, and continue execution.",
                ]
                  .filter(Boolean)
                  .join("\n\n"),
              }).pipe(Effect.ignore),
            )
          }
          return {
            title: "workflow control",
            metadata: {
              workflowID: input.workflow_id,
              nodeID: input.node_id,
              commandID: result.command_id,
              deduped: result.deduped,
            },
            output: format({
              ok: true,
              command: input.command,
              command_id: result.command_id,
              deduped: result.deduped,
            }),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const WorkflowUpdateTool = Tool.define(
  "workflow_update",
  Effect.gen(function* () {
    return {
      description:
        "Update the current workflow node state from inside a subagent session. Only changed fields need to be sent. Pass `ack` to acknowledge runtime command_ids surfaced by workflow_pull. Pass `open_need` to structurally raise a blocker that the orchestrator must fulfill.",
      parameters: WorkflowUpdateParameters,
      execute: (input: z.infer<typeof WorkflowUpdateParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const node = input.node_id
            ? yield* Effect.promise(() => Workflow.getNode(input.node_id!))
            : yield* Effect.promise(() => Workflow.nodeBySession(ctx.sessionID))
          assertNodeSession(node, ctx.sessionID)
          const updated = yield* Effect.promise(() =>
            Workflow.patchNode({
              nodeID: node.id,
              source: "node",
              patch: input.patch,
              event: input.event_kind
                ? {
                    kind: input.event_kind,
                    payload: input.event_payload,
                  }
                : undefined,
            }),
          )
          let acked: string[] = []
          if (input.ack && input.ack.length > 0) {
            const result = yield* Effect.promise(() =>
              Workflow.ackCommand({
                nodeID: node.id,
                source: "node",
                command_ids: input.ack as [string, ...string[]],
                note: input.ack_note,
              }),
            )
            acked = result.acked
          }
          let opened_need_id: string | undefined
          if (input.open_need) {
            const result = yield* Effect.promise(() =>
              Workflow.openNeed({
                nodeID: node.id,
                source: "node",
                title: input.open_need!.title,
                prompt: input.open_need!.prompt,
                kind: input.open_need!.kind,
                required_by: input.open_need!.required_by,
              }),
            )
            opened_need_id = result.need_id
          }
          return {
            title: updated.title,
            metadata: {
              workflowID: updated.workflow_id,
              nodeID: updated.id,
              acked,
              opened_need_id,
            },
            output: format({ ...updated, acked, opened_need_id }),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const WorkflowNeedFulfillTool = Tool.define(
  "workflow_need_fulfill",
  Effect.gen(function* () {
    return {
      description:
        "Orchestrator fulfills a structured need raised by a slave. Moves the need from open to resolved, injects the supplied context, and wakes the slave.",
      parameters: WorkflowNeedFulfillParameters,
      execute: (input: z.infer<typeof WorkflowNeedFulfillParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const node = yield* Effect.promise(() => Workflow.getNode(input.node_id))
          const result = yield* Effect.promise(() =>
            Workflow.fulfillNeed({
              nodeID: node.id,
              source: "orchestrator",
              need_id: input.need_id,
              context: input.context,
              resolution_note: input.resolution_note,
            }),
          )
          return {
            title: `need ${input.need_id} fulfilled`,
            metadata: {
              workflowID: node.workflow_id,
              nodeID: node.id,
              needID: input.need_id,
              commandID: result.command_id,
              remainingOpen: result.remaining_open,
            },
            output: format(result),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const WorkflowPullTool = Tool.define(
  "workflow_pull",
  Effect.gen(function* () {
    return {
      description:
        "Pull pending runtime commands and context updates for the current workflow node session.",
      parameters: WorkflowPullParameters,
      execute: (input: z.infer<typeof WorkflowPullParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const node = input.node_id
            ? yield* Effect.promise(() => Workflow.getNode(input.node_id!))
            : yield* Effect.promise(() => Workflow.nodeBySession(ctx.sessionID))
          assertNodeSession(node, ctx.sessionID)
          const result = yield* Effect.promise(() =>
            Workflow.pull({
              nodeID: node.id,
              cursor: input.cursor,
            }),
          )
          return {
            title: node.title,
            metadata: {
              workflowID: node.workflow_id,
              nodeID: node.id,
              cursor: result.cursor,
            },
            output: format(result),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
