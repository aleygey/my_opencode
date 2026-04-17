import { describeRoute, resolver, validator } from "hono-openapi"
import { Hono } from "hono"
import z from "zod"
import { Workflow } from "@/workflow"
import { errors } from "../error"
import { Snapshot } from "@/snapshot"
import {
  discussionGet,
  discussionWrite,
  SandTableDiscussionSchema,
} from "@/tool/sand-table"

export function WorkflowRoutes() {
  return new Hono()
    .get(
      "/sand_table/:discussionID",
      describeRoute({
        summary: "Get sand table discussion",
        operationId: "workflow.sand_table.get",
        responses: {
          200: {
            description: "Sand table discussion",
            content: {
              "application/json": {
                schema: resolver(SandTableDiscussionSchema),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ discussionID: z.string() })),
      async (c) => {
        const result = discussionGet(c.req.valid("param").discussionID)
        if (!result) return c.body(null, 404)
        return c.json(result)
      },
    )
    .post(
      "/sand_table/:discussionID/message",
      describeRoute({
        summary: "Write sand table discussion message",
        operationId: "workflow.sand_table.message",
        responses: {
          200: {
            description: "Updated sand table discussion",
            content: {
              "application/json": {
                schema: resolver(SandTableDiscussionSchema),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ discussionID: z.string() })),
      validator(
        "json",
        z.object({
          content: z.string().min(1),
          role: z.enum(["planner", "evaluator", "orchestrator"]).optional(),
        }),
      ),
      async (c) => {
        const param = c.req.valid("param")
        const body = c.req.valid("json")
        const result = await discussionWrite({
          discussionID: param.discussionID,
          content: body.content,
          role: body.role,
        })
        if (!result) return c.body(null, 404)
        return c.json(result)
      },
    )
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
                schema: resolver(Snapshot.FileDiff.array()),
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
      "/:workflowID/control",
      describeRoute({
        summary: "Control workflow node",
        operationId: "workflow.control",
        responses: {
          200: {
            description: "Control accepted",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
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
                schema: resolver(Snapshot.FileDiff.array()),
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
