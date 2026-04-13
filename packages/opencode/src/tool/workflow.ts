import { Tool } from "./tool"
import z from "zod"
import { Workflow } from "@/workflow"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
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

const last = async (sessionID: string) => {
  const msgs = await Session.messages({ sessionID: SessionID.make(sessionID), limit: 40 })
  return msgs
    .toReversed()
    .find((msg) => msg.info.role === "user" && msg.parts.some((part) => !("synthetic" in part) || !part.synthetic))
}

const text = async (sessionID: string) =>
  (await last(sessionID))?.parts
    .flatMap((part) => (part.type === "text" && (!("synthetic" in part) || !part.synthetic) ? [part.text] : []))
    .join("\n")
    .trim() ?? ""

const assertConfirmed = async (sessionID: string) => {
  if (confirm.test(await text(sessionID))) return
  throw new Error("workflow_create is blocked until the user explicitly confirms execution in the root orchestrator session.")
}

const assertNodeSession = (node: Awaited<ReturnType<typeof Workflow.getNode>>, sessionID: string) => {
  if (!node.session_id) throw new Error(`Workflow node ${node.id} has no active subagent session.`)
  if (node.session_id === sessionID) return
  throw new Error(`Workflow node ${node.id} must be operated from its bound subagent session ${node.session_id}.`)
}

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
  SessionPrompt.prompt({
    sessionID: SessionID.make(input.sessionID),
    agent: input.agent,
    model: input.model?.providerID && input.model.modelID
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
          "Call workflow_pull immediately, follow runtime commands, report progress with workflow_update, and continue until you complete or block.",
          "",
          input.text,
        ].join("\n"),
      },
    ],
  })

export const WorkflowCreateTool = Tool.define("workflow_create", {
  description: "Create a workflow runtime with nodes, edges, checkpoints, and a root orchestrator session.",
  parameters: z.object({
    title: z.string(),
    session_id: z.string().optional(),
    config: z.record(z.string(), z.any()).optional(),
    summary: z.record(z.string(), z.any()).optional(),
    nodes: Workflow.create.schema.shape.nodes,
    edges: Workflow.create.schema.shape.edges,
    checkpoints: Workflow.create.schema.shape.checkpoints,
  }),
  async execute(input, ctx) {
    await assertConfirmed(input.session_id ?? ctx.sessionID)
    const info = await Workflow.create({
      session_id: input.session_id ?? ctx.sessionID,
      title: input.title,
      config: input.config,
      summary: input.summary,
      nodes: input.nodes,
      edges: input.edges,
      checkpoints: input.checkpoints,
    })
    ctx.metadata({
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
  },
})

export const WorkflowNodeCreateTool = Tool.define("workflow_node_create", {
  description: "Create a workflow node. Prefer creating the session only when the node actually starts running.",
  parameters: z.object({
    workflow_id: z.string(),
    title: z.string(),
    agent: z.string(),
    model,
    config: z.record(z.string(), z.any()).optional(),
    max_attempts: z.number().int().positive().optional(),
    max_actions: z.number().int().positive().optional(),
    position: z.number().int().nonnegative().optional(),
    create_session: z.boolean().optional().default(true),
    initial_prompt: z.string().optional(),
  }),
  async execute(input, ctx) {
    const session = input.create_session
      ? await Session.create({
          parentID: ctx.sessionID,
          title: `${input.title} (@${input.agent} node)`,
        })
      : undefined
    const node = await Workflow.createNode({
      workflowID: input.workflow_id,
      session_id: session?.id,
      title: input.title,
      agent: input.agent,
      model: input.model,
      config: input.config,
      max_attempts: input.max_attempts,
      max_actions: input.max_actions,
      position: input.position,
    })

    if (session && input.initial_prompt) {
      void SessionPrompt.prompt({
        sessionID: session.id,
        agent: input.agent,
        model: input.model?.providerID && input.model.modelID
          ? {
              providerID: ProviderID.make(input.model.providerID),
              modelID: ModelID.make(input.model.modelID),
            }
          : undefined,
        variant: input.model?.variant,
        parts: [{ type: "text", text: input.initial_prompt }],
      }).catch(() => undefined)
    }

    return {
      title: input.title,
      metadata: {
        workflowID: input.workflow_id,
        nodeID: node.id,
        sessionID: session?.id,
      },
      output: format({
        node,
        session_id: session?.id,
      }),
    }
  },
})

export const WorkflowNodeStartTool = Tool.define("workflow_node_start", {
  description: "Start an existing workflow node by creating and attaching its child session, then optionally send the initial prompt.",
  parameters: z.object({
    node_id: z.string(),
    title: z.string().optional(),
    model,
    status: z.enum(["ready", "running", "waiting"]).optional(),
    initial_prompt: z.string(),
  }),
  async execute(input, ctx) {
    const current = await Workflow.getNode(input.node_id)
    if (current.status === "cancelled") {
      throw new Error(`Workflow node ${current.id} is cancelled and cannot be started again.`)
    }
    const session = current.session_id
      ? await Session.get(SessionID.make(current.session_id))
      : await Session.create({
          parentID: ctx.sessionID,
          title: input.title ?? `${current.title} (@${current.agent} node)`,
        })

    const node = current.session_id
      ? current
      : await Workflow.patchNode({
          nodeID: current.id,
          source: "orchestrator",
          patch: {
            session_id: session.id,
            status: input.status ?? "running",
            model: input.model ?? current.model,
          },
          event: {
            kind: "node.started",
            payload: {
              session_id: session.id,
            },
          },
        })

    await Workflow.control({
      workflowID: node.workflow_id,
      nodeID: node.id,
      source: "orchestrator",
      command: "continue",
      payload: {
        reason: "node_started",
      },
    })

    void prompt({
      workflowID: node.workflow_id,
      nodeID: node.id,
      agent: node.agent,
      sessionID: session.id,
      model: input.model ?? node.model,
      text: input.initial_prompt,
    }).catch(() => undefined)

    return {
      title: node.title,
      metadata: {
        workflowID: node.workflow_id,
        nodeID: node.id,
        sessionID: session.id,
      },
      output: format({
        node,
        session_id: session.id,
      }),
    }
  },
})

export const WorkflowNodePauseTool = Tool.define("workflow_node_pause", {
  description: "Pause a workflow node immediately by stopping its current subagent loop and marking the node as paused.",
  parameters: z.object({
    node_id: z.string(),
    reason: z.string().optional(),
  }),
  async execute(input) {
    const node = await Workflow.pauseNode({
      nodeID: input.node_id,
      source: "orchestrator",
      reason: input.reason,
    })
    return {
      title: node.title,
      metadata: {
        workflowID: node.workflow_id,
        nodeID: node.id,
      },
      output: format(node),
    }
  },
})

export const WorkflowNodeAbortTool = Tool.define("workflow_node_abort", {
  description: "Abort a workflow node immediately by stopping its current subagent loop and marking the node as cancelled.",
  parameters: z.object({
    node_id: z.string(),
    reason: z.string().optional(),
  }),
  async execute(input) {
    const node = await Workflow.abortNode({
      nodeID: input.node_id,
      source: "orchestrator",
      reason: input.reason,
    })
    return {
      title: node.title,
      metadata: {
        workflowID: node.workflow_id,
        nodeID: node.id,
      },
      output: format(node),
    }
  },
})

export const WorkflowEdgeCreateTool = Tool.define("workflow_edge_create", {
  description: "Create a dependency edge between two workflow nodes.",
  parameters: z.object({
    workflow_id: z.string(),
    from_node_id: z.string(),
    to_node_id: z.string(),
    label: z.string().optional(),
    config: z.record(z.string(), z.any()).optional(),
  }),
  async execute(input) {
    const edge = await Workflow.createEdge({
      workflowID: input.workflow_id,
      from_node_id: input.from_node_id,
      to_node_id: input.to_node_id,
      label: input.label,
      config: input.config,
    })
    return {
      title: input.label ?? "workflow edge",
      metadata: {
        workflowID: input.workflow_id,
        edgeID: edge.id,
      },
      output: format(edge),
    }
  },
})

export const WorkflowCheckpointCreateTool = Tool.define("workflow_checkpoint_create", {
  description: "Create a checkpoint attached to a workflow node.",
  parameters: z.object({
    workflow_id: z.string(),
    node_id: z.string(),
    label: z.string(),
    status: z.enum(["pending", "passed", "failed", "skipped"]).optional(),
    config: z.record(z.string(), z.any()).optional(),
    result_json: z.record(z.string(), z.any()).optional(),
  }),
  async execute(input) {
    const checkpoint = await Workflow.createCheckpoint({
      workflowID: input.workflow_id,
      node_id: input.node_id,
      label: input.label,
      status: input.status,
      config: input.config,
      result_json: input.result_json,
    })
    return {
      title: input.label,
      metadata: {
        workflowID: input.workflow_id,
        checkpointID: checkpoint.id,
      },
      output: format(checkpoint),
    }
  },
})

export const WorkflowReadTool = Tool.define("workflow_read", {
  description: "Read workflow runtime state. Prefer passing cursor to fetch only incremental changes.",
  parameters: z.object({
    workflow_id: z.string(),
    cursor: z.number().int().nonnegative().optional(),
  }),
  async execute(input) {
    const result = await Workflow.read({
      workflowID: input.workflow_id,
      cursor: input.cursor,
    })
    return {
      title: "workflow read",
      metadata: {
        workflowID: input.workflow_id,
        cursor: result.cursor,
      },
      output: format(result),
    }
  },
})

export const WorkflowControlTool = Tool.define("workflow_control", {
  description: "Send a soft control command to a workflow node, such as continue, resume, retry, or context injection.",
  parameters: z.object({
    workflow_id: z.string(),
    node_id: z.string(),
    command: z.enum(["continue", "resume", "retry", "inject_context"]),
    payload: z.record(z.string(), z.any()).optional(),
  }),
  async execute(input) {
    await Workflow.control({
      workflowID: input.workflow_id,
      nodeID: input.node_id,
      source: "orchestrator",
      command: input.command,
      payload: input.payload,
    })
    const node = await Workflow.getNode(input.node_id)
    if (node.session_id) {
      void prompt({
        workflowID: input.workflow_id,
        nodeID: input.node_id,
        agent: node.agent,
        sessionID: node.session_id,
        model: node.model,
        text: [
          `Runtime command: ${input.command}`,
          input.payload ? JSON.stringify(input.payload, null, 2) : "",
          "Call workflow_pull now, apply the command, and continue execution in this node session.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      }).catch(() => undefined)
    }
    return {
      title: "workflow control",
      metadata: {
        workflowID: input.workflow_id,
        nodeID: input.node_id,
      },
      output: format({
        ok: true,
        command: input.command,
      }),
    }
  },
})

export const WorkflowUpdateTool = Tool.define("workflow_update", {
  description: "Update the current workflow node state from inside a subagent session. Only changed fields need to be sent.",
  parameters: z.object({
    node_id: z.string().optional(),
    patch: nodePatch,
    event_kind: z.string().optional(),
    event_payload: z.record(z.string(), z.any()).optional(),
  }),
  async execute(input, ctx) {
    const node = input.node_id ? await Workflow.getNode(input.node_id) : await Workflow.nodeBySession(ctx.sessionID)
    assertNodeSession(node, ctx.sessionID)
    const updated = await Workflow.patchNode({
      nodeID: node.id,
      source: "node",
      patch: input.patch,
      event: input.event_kind
        ? {
            kind: input.event_kind,
            payload: input.event_payload,
          }
        : undefined,
    })
    return {
      title: updated.title,
      metadata: {
        workflowID: updated.workflow_id,
        nodeID: updated.id,
      },
      output: format(updated),
    }
  },
})

export const WorkflowPullTool = Tool.define("workflow_pull", {
  description: "Pull pending runtime commands and context updates for the current workflow node session.",
  parameters: z.object({
    node_id: z.string().optional(),
    cursor: z.number().int().nonnegative().optional(),
  }),
  async execute(input, ctx) {
    const node = input.node_id ? await Workflow.getNode(input.node_id) : await Workflow.nodeBySession(ctx.sessionID)
    assertNodeSession(node, ctx.sessionID)
    const result = await Workflow.pull({
      nodeID: node.id,
      cursor: input.cursor,
    })
    return {
      title: node.title,
      metadata: {
        workflowID: node.workflow_id,
        nodeID: node.id,
        cursor: result.cursor,
      },
      output: format(result),
    }
  },
})
