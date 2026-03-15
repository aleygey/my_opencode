import { describeRoute, resolver, validator } from "hono-openapi"
import { Hono } from "hono"
import z from "zod"
import { Workflow } from "@/workflow"
import { errors } from "../error"
import { SessionProxyMiddleware } from "@/control-plane/session-proxy-middleware"
import { Snapshot } from "@/snapshot"

export function WorkflowRoutes() {
  return new Hono()
    .use(SessionProxyMiddleware)
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
}
