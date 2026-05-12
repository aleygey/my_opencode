import { describeRoute, resolver, validator } from "hono-openapi"
import { Hono } from "hono"
import z from "zod"
import { Workflow } from "@/workflow"
import { errors } from "../../error"
import { Snapshot } from "@/snapshot"

export function WorkflowRoutes() {
  return new Hono()
    .get(
      "/session/:sessionID",
      describeRoute({
        summary: "Get workflow for session",
        operationId: "workflow.session",
        responses: {
          200: {
            description: "Workflow snapshot",
            content: {
              "application/json": {
                schema: resolver(Workflow.Snapshot),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ sessionID: z.string() })),
      async (c) => {
        return c.json(await Workflow.bySession(c.req.valid("param").sessionID))
      },
    )
    .delete(
      "/session/:sessionID",
      describeRoute({
        summary: "Delete workflow task",
        operationId: "workflow.delete_session",
        responses: {
          200: {
            description: "Deleted workflow task",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ sessionID: z.string() })),
      async (c) => {
        return c.json(await Workflow.removeBySession(c.req.valid("param").sessionID))
      },
    )
    .get(
      "/:workflowID",
      describeRoute({
        summary: "Get workflow",
        operationId: "workflow.get",
        responses: {
          200: {
            description: "Workflow snapshot",
            content: {
              "application/json": {
                schema: resolver(Workflow.Snapshot),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ workflowID: z.string() })),
      async (c) => {
        return c.json(await Workflow.get(c.req.valid("param").workflowID))
      },
    )
    .get(
      "/:workflowID/read",
      describeRoute({
        summary: "Read workflow delta",
        operationId: "workflow.read",
        responses: {
          200: {
            description: "Workflow changes since cursor",
            content: {
              "application/json": {
                schema: resolver(Workflow.ReadResult),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ workflowID: z.string() })),
      validator("query", z.object({ cursor: z.coerce.number().int().nonnegative().optional() })),
      async (c) => {
        const param = c.req.valid("param")
        const query = c.req.valid("query")
        return c.json(await Workflow.read({ workflowID: param.workflowID, cursor: query.cursor }))
      },
    )
    .get(
      "/:workflowID/diff",
      describeRoute({
        summary: "Get workflow diff",
        operationId: "workflow.diff",
        responses: {
          200: {
            description: "Aggregated workflow file diff",
            content: {
              "application/json": {
                schema: resolver(Snapshot.FileDiff.zod.array()),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ workflowID: z.string() })),
      async (c) => {
        return c.json(await Workflow.diff(c.req.valid("param").workflowID))
      },
    )
    .post(
      "/",
      describeRoute({
        summary: "Create workflow",
        operationId: "workflow.create",
        responses: {
          200: {
            description: "Created workflow",
            content: {
              "application/json": {
                schema: resolver(Workflow.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Workflow.create.schema),
      async (c) => {
        return c.json(await Workflow.create(c.req.valid("json")))
      },
    )
    .post(
      "/:workflowID/node",
      describeRoute({
        summary: "Create workflow node",
        operationId: "workflow.node.create",
        responses: {
          200: {
            description: "Created workflow node",
            content: {
              "application/json": {
                schema: resolver(Workflow.Node),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ workflowID: z.string() })),
      validator("json", Workflow.createNode.schema.omit({ workflowID: true })),
      async (c) => {
        return c.json(await Workflow.createNode({ workflowID: c.req.valid("param").workflowID, ...c.req.valid("json") }))
      },
    )
    .post(
      "/:workflowID/edge",
      describeRoute({
        summary: "Create workflow edge",
        operationId: "workflow.edge.create",
        responses: {
          200: {
            description: "Created workflow edge",
            content: {
              "application/json": {
                schema: resolver(Workflow.Edge),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ workflowID: z.string() })),
      validator("json", Workflow.createEdge.schema.omit({ workflowID: true })),
      async (c) => {
        return c.json(await Workflow.createEdge({ workflowID: c.req.valid("param").workflowID, ...c.req.valid("json") }))
      },
    )
    .post(
      "/:workflowID/checkpoint",
      describeRoute({
        summary: "Create workflow checkpoint",
        operationId: "workflow.checkpoint.create",
        responses: {
          200: {
            description: "Created workflow checkpoint",
            content: {
              "application/json": {
                schema: resolver(Workflow.Checkpoint),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ workflowID: z.string() })),
      validator("json", Workflow.createCheckpoint.schema.omit({ workflowID: true })),
      async (c) => {
        return c.json(
          await Workflow.createCheckpoint({
            workflowID: c.req.valid("param").workflowID,
            ...c.req.valid("json"),
          }),
        )
      },
    )
    .post(
      "/:workflowID/edits/propose",
      describeRoute({
        summary: "Propose workflow graph edit",
        description:
          "Stage a batched graph mutation as a `workflow_edit` row in `pending` " +
          "status. Does NOT mutate the graph; a follow-up call to " +
          "`/edits/:editID/apply` runs the reconciler under optimistic " +
          "concurrency. Master-only in practice — slaves should never call this.",
        operationId: "workflow.edit.propose",
        responses: {
          200: {
            description: "Proposed workflow edit",
            content: {
              "application/json": {
                schema: resolver(Workflow.Edit),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ workflowID: z.string() })),
      validator("json", Workflow.proposeEdit.schema.omit({ workflowID: true })),
      async (c) => {
        return c.json(
          await Workflow.proposeEdit({
            workflowID: c.req.valid("param").workflowID,
            ...c.req.valid("json"),
          }),
        )
      },
    )
    .post(
      "/edits/:editID/apply",
      describeRoute({
        summary: "Apply workflow graph edit",
        description:
          "Run the reconciler for a `pending` edit: re-validate ops, re-check " +
          "`graph_rev_before` against the live workflow, then atomically replay " +
          "ops + bump `graph_rev`. Throws on stale base_rev (master must reject " +
          "and re-propose).",
        operationId: "workflow.edit.apply",
        responses: {
          200: {
            description: "Applied workflow edit",
            content: {
              "application/json": {
                schema: resolver(Workflow.Edit),
              },
            },
          },
          ...errors(400, 404, 409),
        },
      }),
      validator("param", z.object({ editID: z.string() })),
      async (c) => {
        return c.json(await Workflow.applyEdit({ editID: c.req.valid("param").editID }))
      },
    )
    .post(
      "/edits/:editID/reject",
      describeRoute({
        summary: "Reject workflow graph edit",
        description:
          "Mark a `pending` edit as `rejected` with an audit reason. Idempotent on " +
          "already-rejected rows; refuses already-applied / superseded edits.",
        operationId: "workflow.edit.reject",
        responses: {
          200: {
            description: "Rejected workflow edit",
            content: {
              "application/json": {
                schema: resolver(Workflow.Edit),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ editID: z.string() })),
      validator("json", Workflow.rejectEdit.schema.omit({ editID: true })),
      async (c) => {
        return c.json(
          await Workflow.rejectEdit({
            editID: c.req.valid("param").editID,
            ...c.req.valid("json"),
          }),
        )
      },
    )
    .get(
      "/:workflowID/scan_ready",
      describeRoute({
        summary: "Scan ready workflow nodes",
        description:
          "Return the master's scheduling view: ranked ready candidates plus " +
          "nodes blocked by dependency / resource. The runtime never starts " +
          "nodes itself — the master reads this view and dispatches via " +
          "`workflow_graph_propose(SET_NODE_STATUS=running, ...)`.",
        operationId: "workflow.scan_ready",
        responses: {
          200: {
            description: "Ready / blocked node breakdown",
            content: {
              "application/json": {
                schema: resolver(Workflow.ScanReadyResult),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ workflowID: z.string() })),
      async (c) => {
        return c.json(await Workflow.scanReady(c.req.valid("param").workflowID))
      },
    )
    .post(
      "/:workflowID/resources",
      describeRoute({
        summary: "Update workflow resource holds",
        description:
          "Acquire / release exclusive resource keys against the workflow's " +
          "`resources_held` ledger. Bumps `version` but NOT `graph_rev` — " +
          "resource churn isn't a topology change. Returns the conflict-free " +
          "delta the runtime committed.",
        operationId: "workflow.resources.update",
        responses: {
          200: {
            description: "Updated resource ledger",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    workflow: Workflow.Info,
                    acquired: z.array(z.object({ resource: z.string(), node_id: z.string() })),
                    released: z.array(z.string()),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ workflowID: z.string() })),
      validator("json", Workflow.updateResources.schema.omit({ workflowID: true })),
      async (c) => {
        return c.json(
          await Workflow.updateResources({
            workflowID: c.req.valid("param").workflowID,
            ...c.req.valid("json"),
          }),
        )
      },
    )
    .post(
      "/:workflowID/finalize",
      describeRoute({
        summary: "Finalize workflow",
        description:
          "Flip the workflow to a terminal status (`completed` / `failed` / " +
          "`cancelled`), record `result_json`, stamp `time_completed`. Refuses " +
          "while child nodes are still active unless `force: true`.",
        operationId: "workflow.finalize",
        responses: {
          200: {
            description: "Finalized workflow",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    workflow: Workflow.Info,
                    finalized_status: z.enum(["completed", "failed", "cancelled"]),
                    fail_reason: z.string().optional(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ workflowID: z.string() })),
      validator("json", Workflow.finalize.schema.omit({ workflowID: true })),
      async (c) => {
        return c.json(
          await Workflow.finalize({
            workflowID: c.req.valid("param").workflowID,
            ...c.req.valid("json"),
          }),
        )
      },
    )
    .post(
      "/:workflowID/control",
      describeRoute({
        summary: "Control workflow node",
        operationId: "workflow.control",
        responses: {
          200: {
            description: "Control accepted",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    ok: z.literal(true),
                    deduped: z.boolean(),
                    command_id: z.string().optional(),
                  }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ workflowID: z.string() })),
      validator("json", Workflow.control.schema.omit({ workflowID: true })),
      async (c) => {
        return c.json(await Workflow.control({ workflowID: c.req.valid("param").workflowID, ...c.req.valid("json") }))
      },
    )
    .patch(
      "/node/:nodeID",
      describeRoute({
        summary: "Update workflow node",
        operationId: "workflow.node.update",
        responses: {
          200: {
            description: "Updated workflow node",
            content: {
              "application/json": {
                schema: resolver(Workflow.Node),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ nodeID: z.string() })),
      validator("json", Workflow.patchNode.schema.omit({ nodeID: true })),
      async (c) => {
        return c.json(await Workflow.patchNode({ nodeID: c.req.valid("param").nodeID, ...c.req.valid("json") }))
      },
    )
    .post(
      "/node/:nodeID/pause",
      describeRoute({
        summary: "Pause workflow node",
        operationId: "workflow.node.pause",
        responses: {
          200: {
            description: "Paused workflow node",
            content: {
              "application/json": {
                schema: resolver(Workflow.Node),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ nodeID: z.string() })),
      validator("json", z.object({ reason: z.string().optional() }).optional()),
      async (c) => {
        return c.json(
          await Workflow.pauseNode({
            nodeID: c.req.valid("param").nodeID,
            source: "ui",
            reason: c.req.valid("json")?.reason,
          }),
        )
      },
    )
    .post(
      "/node/:nodeID/abort",
      describeRoute({
        summary: "Abort workflow node",
        operationId: "workflow.node.abort",
        responses: {
          200: {
            description: "Aborted workflow node",
            content: {
              "application/json": {
                schema: resolver(Workflow.Node),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ nodeID: z.string() })),
      validator("json", z.object({ reason: z.string().optional() }).optional()),
      async (c) => {
        return c.json(
          await Workflow.abortNode({
            nodeID: c.req.valid("param").nodeID,
            source: "ui",
            reason: c.req.valid("json")?.reason,
          }),
        )
      },
    )
    .post(
      "/node/:nodeID/uncancel",
      describeRoute({
        summary: "Uncancel workflow node",
        description:
          "Flip a cancelled node back to `pending` so it can be re-started. Preserves the bound child session so a subsequent start resumes from accumulated transcript. Use when adding follow-up context to the SAME task; for genuinely different work, use INSERT_NODE via workflow_graph_propose instead.",
        operationId: "workflow.node.uncancel",
        responses: {
          200: {
            description: "Uncancelled workflow node",
            content: {
              "application/json": {
                schema: resolver(Workflow.Node),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ nodeID: z.string() })),
      validator("json", z.object({ reason: z.string().optional() }).optional()),
      async (c) => {
        return c.json(
          await Workflow.uncancelNode({
            nodeID: c.req.valid("param").nodeID,
            source: "ui",
            reason: c.req.valid("json")?.reason,
          }),
        )
      },
    )
    .get(
      "/node/:nodeID/pull",
      describeRoute({
        summary: "Pull workflow node commands",
        operationId: "workflow.node.pull",
        responses: {
          200: {
            description: "Pending node events",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    node: Workflow.Node,
                    cursor: z.number().int().nonnegative(),
                    events: Workflow.EventInfo.array(),
                  }),
                ),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ nodeID: z.string() })),
      validator("query", z.object({ cursor: z.coerce.number().int().nonnegative().optional() })),
      async (c) => {
        return c.json(await Workflow.pull({ nodeID: c.req.valid("param").nodeID, cursor: c.req.valid("query").cursor }))
      },
    )
    .get(
      "/node/:nodeID/code_changes",
      describeRoute({
        summary: "Get workflow node code changes",
        operationId: "workflow.node.code_changes",
        responses: {
          200: {
            description: "Node session file diff",
            content: {
              "application/json": {
                schema: resolver(Snapshot.FileDiff.zod.array()),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ nodeID: z.string() })),
      async (c) => {
        return c.json(await Workflow.codeChanges(c.req.valid("param").nodeID))
      },
    )
}
