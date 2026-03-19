import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Database, eq, desc, and, inArray, gt, sql } from "@/storage/db"
import { Identifier } from "@/id/id"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { MessageV2 } from "@/session/message-v2"
import { NotFoundError } from "@/storage/db"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { fn } from "@/util/fn"
import z from "zod"
import {
  WorkflowCheckpointTable,
  WorkflowEdgeTable,
  WorkflowEventTable,
  WorkflowNodeTable,
  WorkflowTable,
  type WorkflowCheckpointStatus,
  type WorkflowNodeResultStatus,
  type WorkflowNodeStatus,
  type WorkflowStatus,
} from "./workflow.sql"

const log = Log.create({ service: "workflow" })

const workflowID = () => `wfl_${Identifier.create("workspace", false).slice(4)}`
const nodeID = () => `wfn_${Identifier.create("workspace", false).slice(4)}`
const edgeID = () => `wfe_${Identifier.create("workspace", false).slice(4)}`
const checkpointID = () => `wfc_${Identifier.create("workspace", false).slice(4)}`

const WorkflowStatus = z.enum(["pending", "running", "paused", "interrupted", "completed", "failed", "cancelled"])
const WorkflowNodeStatus = z.enum([
  "pending",
  "ready",
  "running",
  "waiting",
  "paused",
  "interrupted",
  "completed",
  "failed",
  "cancelled",
])
const WorkflowNodeResultStatus = z.enum(["unknown", "success", "fail", "partial"])
const WorkflowCheckpointStatus = z.enum(["pending", "passed", "failed", "skipped"])

function mergeJSON(
  current: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
  mode: "replace" | "merge",
) {
  if (!next) return current
  if (mode === "replace") return next
  return { ...(current ?? {}), ...next }
}

function normalizeWorkflowStatus(status: WorkflowNodeStatus | WorkflowStatus): WorkflowStatus {
  if (status === "running" || status === "waiting") return "running"
  if (status === "paused") return "paused"
  if (status === "interrupted") return "interrupted"
  if (status === "completed") return "completed"
  if (status === "failed") return "failed"
  if (status === "cancelled") return "cancelled"
  return "pending"
}

const wakeDelay = 15_000
const stallEvery = 15_000
const stallAfter = 45_000

type Wake = {
  workflowID: string
  sessionID: string
  eventID: number
  nodeID?: string
  kind: string
  reason: string
  time: number
}

export namespace Workflow {
  export const Info = z
    .object({
      id: z.string(),
      session_id: z.string(),
      title: z.string(),
      status: WorkflowStatus,
      current_node_id: z.string().optional(),
      selected_node_id: z.string().optional(),
      version: z.number().int().nonnegative(),
      config: z.record(z.string(), z.any()).optional(),
      summary: z.record(z.string(), z.any()).optional(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        paused: z.number().optional(),
        completed: z.number().optional(),
      }),
    })
    .meta({ ref: "Workflow" })
  export type Info = z.infer<typeof Info>

  export const Node = z
    .object({
      id: z.string(),
      workflow_id: z.string(),
      session_id: z.string().optional(),
      title: z.string(),
      agent: z.string(),
      model: z
        .object({
          providerID: z.string().optional(),
          modelID: z.string().optional(),
          variant: z.string().optional(),
        })
        .optional(),
      config: z.record(z.string(), z.any()).optional(),
      status: WorkflowNodeStatus,
      result_status: WorkflowNodeResultStatus,
      fail_reason: z.string().optional(),
      action_count: z.number().int().nonnegative(),
      attempt: z.number().int().nonnegative(),
      max_attempts: z.number().int().positive(),
      max_actions: z.number().int().positive(),
      version: z.number().int().nonnegative(),
      state_json: z.record(z.string(), z.any()).optional(),
      result_json: z.record(z.string(), z.any()).optional(),
      position: z.number().int().nonnegative(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        started: z.number().optional(),
        completed: z.number().optional(),
      }),
    })
    .meta({ ref: "WorkflowNode" })
  export type Node = z.infer<typeof Node>

  export const Edge = z
    .object({
      id: z.string(),
      workflow_id: z.string(),
      from_node_id: z.string(),
      to_node_id: z.string(),
      label: z.string().optional(),
      config: z.record(z.string(), z.any()).optional(),
      time_created: z.number(),
    })
    .meta({ ref: "WorkflowEdge" })
  export type Edge = z.infer<typeof Edge>

  export const Checkpoint = z
    .object({
      id: z.string(),
      workflow_id: z.string(),
      node_id: z.string(),
      label: z.string(),
      status: WorkflowCheckpointStatus,
      config: z.record(z.string(), z.any()).optional(),
      result_json: z.record(z.string(), z.any()).optional(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
      }),
    })
    .meta({ ref: "WorkflowCheckpoint" })
  export type Checkpoint = z.infer<typeof Checkpoint>

  export const EventInfo = z
    .object({
      id: z.number().int().nonnegative(),
      workflow_id: z.string(),
      node_id: z.string().optional(),
      session_id: z.string().optional(),
      target_node_id: z.string().optional(),
      kind: z.string(),
      source: z.string(),
      payload: z.record(z.string(), z.any()),
      time_created: z.number(),
    })
    .meta({ ref: "WorkflowEvent" })
  export type EventInfo = z.infer<typeof EventInfo>

  export const Runtime = z
    .object({
      phase: z.enum(["planning", "running", "waiting", "interrupted", "failed", "completed"]),
      active_node_id: z.string().optional(),
      waiting_node_ids: z.array(z.string()),
      failed_node_ids: z.array(z.string()),
      command_count: z.number().int().nonnegative(),
      update_count: z.number().int().nonnegative(),
      pull_count: z.number().int().nonnegative(),
      last_event_id: z.number().int().nonnegative(),
    })
    .meta({ ref: "WorkflowRuntime" })
  export type Runtime = z.infer<typeof Runtime>

  export const Snapshot = z
    .object({
      workflow: Info,
      runtime: Runtime,
      nodes: Node.array(),
      edges: Edge.array(),
      checkpoints: Checkpoint.array(),
      events: EventInfo.array(),
      cursor: z.number().int().nonnegative(),
    })
    .meta({ ref: "WorkflowSnapshot" })
  export type Snapshot = z.infer<typeof Snapshot>

  export const ReadResult = z
    .object({
      workflow: Info.optional(),
      runtime: Runtime.optional(),
      nodes: Node.array(),
      edges: Edge.array(),
      checkpoints: Checkpoint.array(),
      events: EventInfo.array(),
      cursor: z.number().int().nonnegative(),
    })
    .meta({ ref: "WorkflowReadResult" })
  export type ReadResult = z.infer<typeof ReadResult>

  export const Event = {
    Created: BusEvent.define("workflow.created", z.object({ info: Info })),
    Updated: BusEvent.define("workflow.updated", z.object({ info: Info })),
    NodeCreated: BusEvent.define("workflow.node.created", z.object({ info: Node })),
    NodeUpdated: BusEvent.define("workflow.node.updated", z.object({ info: Node })),
    EdgeCreated: BusEvent.define("workflow.edge.created", z.object({ info: Edge })),
    CheckpointUpdated: BusEvent.define("workflow.checkpoint.updated", z.object({ info: Checkpoint })),
    EventCreated: BusEvent.define("workflow.event.created", z.object({ info: EventInfo })),
  }

  async function workflowRow(workflowID: string) {
    return Database.use((db) => db.select().from(WorkflowTable).where(eq(WorkflowTable.id, workflowID)).get())
  }

  async function sendWake(wake: Wake) {
    await writeEvent({
      workflowID: wake.workflowID,
      sessionID: wake.sessionID,
      nodeID: wake.nodeID,
      source: "runtime",
      kind: "workflow.orchestrator_woken",
      payload: {
        wake_kind: wake.kind,
        wake_reason: wake.reason,
        trigger_event_id: wake.eventID,
      },
    })
    await SessionPrompt.prompt({
      sessionID: SessionID.make(wake.sessionID),
      agent: "orchestrator",
      parts: [
        {
          type: "text",
          text: [
            `Workflow wake event: ${wake.kind}`,
            `Reason: ${wake.reason}`,
            `Workflow ID: ${wake.workflowID}`,
            wake.nodeID ? `Node ID: ${wake.nodeID}` : "",
            `Trigger event ID: ${wake.eventID}`,
            "",
            `Call workflow_read with workflow_id="${wake.workflowID}" and cursor=${Math.max(0, wake.eventID - 1)} first.`,
            "Then decide whether to continue, inject context, retry, replan, or ask the user.",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    })
  }

  function classify(event: EventInfo) {
    if (event.kind === "node.completed") return { kind: "node.completed", reason: "node completed" }
    if (event.kind === "node.failed") return { kind: "node.failed", reason: "node failed" }
    if (event.kind === "node.interrupted") return { kind: "node.interrupted", reason: "node interrupted" }
    if (event.kind === "node.action_limit_reached") return { kind: "node.limit_reached", reason: "action limit reached" }
    if (event.kind === "node.attempt_limit_reached") return { kind: "node.limit_reached", reason: "attempt limit reached" }
    if (event.kind === "node.stalled") return { kind: "node.stalled", reason: "node stalled without recent pull or update" }
    if (event.kind === "checkpoint.failed") return { kind: "checkpoint.failed", reason: "checkpoint failed" }
    if (event.kind === "checkpoint.pending") return { kind: "checkpoint.pending_manual", reason: "checkpoint pending manual review" }
    if (event.kind === "node.updated" && event.payload.status === "waiting") {
      return { kind: "node.waiting", reason: "node is waiting for orchestrator or user input" }
    }
    if (event.kind === "node.blocked") return { kind: "node.waiting", reason: "node reported a blocked state" }
  }

  async function queueWake(input: Wake) {
    const current = state()
    const key = `${input.workflowID}:${input.kind}:${input.nodeID ?? "root"}`
    const seen = current.seen[key]
    if (seen && input.time - seen < wakeDelay) return
    current.seen[key] = input.time

    const status = SessionStatus.get(SessionID.make(input.sessionID))
    if (status.type === "idle") {
      await sendWake(input).catch(async (error) => {
        if (!(error instanceof Session.BusyError)) {
          log.warn("failed to wake orchestrator", { workflowID: input.workflowID, error })
          return
        }
        current.queue[input.sessionID] = [...(current.queue[input.sessionID] ?? []), input]
        await writeEvent({
          workflowID: input.workflowID,
          sessionID: input.sessionID,
          nodeID: input.nodeID,
          source: "runtime",
          kind: "workflow.orchestrator_wake_queued",
          payload: {
            wake_kind: input.kind,
            wake_reason: input.reason,
            trigger_event_id: input.eventID,
          },
        })
      })
      return
    }

    current.queue[input.sessionID] = [...(current.queue[input.sessionID] ?? []), input]
    await writeEvent({
      workflowID: input.workflowID,
      sessionID: input.sessionID,
      nodeID: input.nodeID,
      source: "runtime",
      kind: "workflow.orchestrator_wake_queued",
      payload: {
        wake_kind: input.kind,
        wake_reason: input.reason,
        trigger_event_id: input.eventID,
      },
    })
  }

  async function flush(sessionID: string) {
    const current = state()
    const items = current.queue[sessionID]
    if (!items?.length) return
    const wake = items.at(-1)
    delete current.queue[sessionID]
    if (!wake) return
    await sendWake(wake).catch((error) => {
      current.queue[sessionID] = [...(current.queue[sessionID] ?? []), wake]
      log.warn("failed to flush orchestrator wake", { sessionID, error })
    })
  }

  async function detectStall() {
    const now = Date.now()
    const nodes = Database.use((db) =>
      db
        .select()
        .from(WorkflowNodeTable)
        .where(inArray(WorkflowNodeTable.status, ["running", "waiting"]))
        .all(),
    ).map(fromNodeRow)
    for (const node of nodes) {
      if (now - node.time.updated < stallAfter) continue
      const current = state()
      const seen = current.stall[node.id]
      if (seen && now - seen < stallAfter) continue
      current.stall[node.id] = now
      await writeEvent({
        workflowID: node.workflow_id,
        nodeID: node.id,
        sessionID: node.session_id,
        target_node_id: node.id,
        source: "runtime",
        kind: "node.stalled",
        payload: {
          status: node.status,
          updated_at: node.time.updated,
          stalled_for_ms: now - node.time.updated,
        },
      })
    }
  }

  const state = Instance.state(() => {
    const unsubPart = Bus.subscribe(MessageV2.Event.PartUpdated, async (event) => {
      const part = event.properties.part
      if (part.type !== "tool") return
      if (part.state.status !== "pending") return
      const node = await nodeBySession(part.sessionID).catch(() => undefined)
      if (!node) return
      await patchNode({
        nodeID: node.id,
        source: "runtime",
        patch: {},
        action_delta: 1,
        event: {
          kind: "node.action",
          target_node_id: node.id,
          payload: {
            call_id: part.callID,
            tool: part.tool,
            status: part.state.status,
          },
        },
      }).catch((error) => {
        log.warn("failed to count workflow action", { nodeID: node.id, error })
      })
    })
    const unsubWorkflow = Bus.subscribe(Event.EventCreated, async (event) => {
      const info = event.properties.info
      const wake = classify(info)
      if (!wake) return
      const workflow = await workflowRow(info.workflow_id)
      if (!workflow || ["completed", "failed", "cancelled"].includes(workflow.status)) return
      await writeEvent({
        workflowID: info.workflow_id,
        sessionID: workflow.session_id,
        nodeID: info.node_id,
        source: "runtime",
        kind: "workflow.orchestrator_wake_requested",
        payload: {
          wake_kind: wake.kind,
          wake_reason: wake.reason,
          trigger_event_id: info.id,
          node_id: info.node_id,
        },
      })
      await queueWake({
        workflowID: info.workflow_id,
        sessionID: workflow.session_id,
        eventID: info.id,
        nodeID: info.node_id,
        kind: wake.kind,
        reason: wake.reason,
        time: Date.now(),
      })
    })
    const unsubStatus = Bus.subscribe(SessionStatus.Event.Status, async (event) => {
      if (event.properties.status.type !== "idle") return
      await flush(event.properties.sessionID)
    })
    const timer = setInterval(() => {
      void detectStall()
    }, stallEvery)
    return {
      unsubPart,
      unsubWorkflow,
      unsubStatus,
      timer,
      queue: {} as Record<string, Wake[]>,
      seen: {} as Record<string, number>,
      stall: {} as Record<string, number>,
    }
  }, async (entry) => {
    entry.unsubPart()
    entry.unsubWorkflow()
    entry.unsubStatus()
    clearInterval(entry.timer)
  })

  function fromWorkflowRow(row: typeof WorkflowTable.$inferSelect): Info {
    return {
      id: row.id,
      session_id: row.session_id,
      title: row.title,
      status: row.status,
      current_node_id: row.current_node_id ?? undefined,
      selected_node_id: row.selected_node_id ?? undefined,
      version: row.version,
      config: row.config ?? undefined,
      summary: row.summary ?? undefined,
      time: {
        created: row.time_created,
        updated: row.time_updated,
        paused: row.time_paused ?? undefined,
        completed: row.time_completed ?? undefined,
      },
    }
  }

  function fromNodeRow(row: typeof WorkflowNodeTable.$inferSelect): Node {
    return {
      id: row.id,
      workflow_id: row.workflow_id,
      session_id: row.session_id ?? undefined,
      title: row.title,
      agent: row.agent,
      model: row.model ?? undefined,
      config: row.config ?? undefined,
      status: row.status,
      result_status: row.result_status,
      fail_reason: row.fail_reason ?? undefined,
      action_count: row.action_count,
      attempt: row.attempt,
      max_attempts: row.max_attempts,
      max_actions: row.max_actions,
      version: row.version,
      state_json: row.state_json ?? undefined,
      result_json: row.result_json ?? undefined,
      position: row.position,
      time: {
        created: row.time_created,
        updated: row.time_updated,
        started: row.time_started ?? undefined,
        completed: row.time_completed ?? undefined,
      },
    }
  }

  function fromEdgeRow(row: typeof WorkflowEdgeTable.$inferSelect): Edge {
    return {
      id: row.id,
      workflow_id: row.workflow_id,
      from_node_id: row.from_node_id,
      to_node_id: row.to_node_id,
      label: row.label ?? undefined,
      config: row.config ?? undefined,
      time_created: row.time_created,
    }
  }

  function fromCheckpointRow(row: typeof WorkflowCheckpointTable.$inferSelect): Checkpoint {
    return {
      id: row.id,
      workflow_id: row.workflow_id,
      node_id: row.node_id,
      label: row.label,
      status: row.status,
      config: row.config ?? undefined,
      result_json: row.result_json ?? undefined,
      time: {
        created: row.time_created,
        updated: row.time_updated,
      },
    }
  }

  function fromEventRow(row: typeof WorkflowEventTable.$inferSelect): EventInfo {
    return {
      id: row.id,
      workflow_id: row.workflow_id,
      node_id: row.node_id ?? undefined,
      session_id: row.session_id ?? undefined,
      target_node_id: row.target_node_id ?? undefined,
      kind: row.kind,
      source: row.source,
      payload: row.payload,
      time_created: row.time_created,
    }
  }

  function runtime(input: { workflow: Info; nodes: Node[]; events: EventInfo[] }): Runtime {
    const active = input.nodes.find((node) => node.status === "running") ?? input.nodes.find((node) => node.status === "waiting")
    const waiting = input.nodes.filter((node) => node.status === "waiting").map((node) => node.id)
    const failed = input.nodes.filter((node) => node.status === "failed").map((node) => node.id)
    const phase =
      input.workflow.status === "completed"
        ? "completed"
        : input.workflow.status === "failed"
          ? "failed"
          : input.workflow.status === "interrupted"
            ? "interrupted"
            : waiting.length > 0
              ? "waiting"
              : active
                ? "running"
                : "planning"
    return {
      phase,
      active_node_id: active?.id,
      waiting_node_ids: waiting,
      failed_node_ids: failed,
      command_count: input.events.filter((event) => event.kind === "node.control").length,
      update_count: input.events.filter((event) => event.kind === "node.updated").length,
      pull_count: input.events.filter((event) => event.kind === "node.pulled").length,
      last_event_id: input.events.at(-1)?.id ?? 0,
    }
  }

  async function writeEvent(input: {
    workflowID: string
    nodeID?: string
    sessionID?: string
    target_node_id?: string
    kind: string
    source: string
    payload?: Record<string, unknown>
  }) {
    const row = Database.use((db) =>
      db
        .insert(WorkflowEventTable)
        .values({
          workflow_id: input.workflowID,
          node_id: input.nodeID,
          session_id: input.sessionID,
          target_node_id: input.target_node_id,
          kind: input.kind,
          source: input.source,
          payload: input.payload ?? {},
        })
        .returning()
        .get(),
    )
    if (!row) throw new Error("Failed to create workflow event")
    const info = fromEventRow(row)
    Database.effect(() => Bus.publish(Event.EventCreated, { info }))
    return info
  }

  async function touchWorkflow(input: {
    workflowID: string
    patch?: Partial<{
      status: WorkflowStatus
      current_node_id: string | null
      selected_node_id: string | null
      summary: Record<string, unknown> | null
    }>
  }) {
    const row = Database.use((db) =>
      db
        .update(WorkflowTable)
        .set({
          ...(input.patch?.status ? { status: input.patch.status } : {}),
          ...(input.patch?.current_node_id !== undefined ? { current_node_id: input.patch.current_node_id } : {}),
          ...(input.patch?.selected_node_id !== undefined ? { selected_node_id: input.patch.selected_node_id } : {}),
          ...(input.patch?.summary !== undefined ? { summary: input.patch.summary ?? null } : {}),
          version: sql`${WorkflowTable.version} + 1`,
          time_updated: Date.now(),
        })
        .where(eq(WorkflowTable.id, input.workflowID))
        .returning()
        .get(),
    )
    if (!row) throw new NotFoundError({ message: `Workflow not found: ${input.workflowID}` })
    const info = fromWorkflowRow(row)
    Database.effect(() => Bus.publish(Event.Updated, { info }))
    return info
  }

  export const create = fn(
    z.object({
      session_id: z.string(),
      title: z.string(),
      config: z.record(z.string(), z.any()).optional(),
      summary: z.record(z.string(), z.any()).optional(),
      nodes: z
        .array(
          z.object({
            id: z.string().optional(),
            session_id: z.string().optional(),
            title: z.string(),
            agent: z.string(),
            model: Node.shape.model.optional(),
            config: z.record(z.string(), z.any()).optional(),
            status: WorkflowNodeStatus.optional(),
            result_status: WorkflowNodeResultStatus.optional(),
            fail_reason: z.string().optional(),
            action_count: z.number().int().nonnegative().optional(),
            attempt: z.number().int().nonnegative().optional(),
            max_attempts: z.number().int().positive().optional(),
            max_actions: z.number().int().positive().optional(),
            state_json: z.record(z.string(), z.any()).optional(),
            result_json: z.record(z.string(), z.any()).optional(),
            position: z.number().int().nonnegative().optional(),
          }),
        )
        .optional(),
      edges: z
        .array(
          z.object({
            id: z.string().optional(),
            from_node_id: z.string(),
            to_node_id: z.string(),
            label: z.string().optional(),
            config: z.record(z.string(), z.any()).optional(),
          }),
        )
        .optional(),
      checkpoints: z
        .array(
          z.object({
            id: z.string().optional(),
            node_id: z.string(),
            label: z.string(),
            status: WorkflowCheckpointStatus.optional(),
            config: z.record(z.string(), z.any()).optional(),
            result_json: z.record(z.string(), z.any()).optional(),
          }),
        )
        .optional(),
    }),
    async (input) => {
      await state()
      const workflow = Database.transaction((tx) => {
        const row = tx
          .insert(WorkflowTable)
          .values({
            id: workflowID(),
            session_id: input.session_id,
            title: input.title,
            status: "pending",
            config: input.config,
            summary: input.summary,
          })
          .returning()
          .get()
        if (!row) throw new Error("Failed to create workflow")
        const created = fromWorkflowRow(row)

        for (const [index, node] of (input.nodes ?? []).entries()) {
          tx.insert(WorkflowNodeTable).values({
            id: node.id ?? nodeID(),
            workflow_id: created.id,
            session_id: node.session_id,
            title: node.title,
            agent: node.agent,
            model: node.model,
            config: node.config,
            status: node.status ?? "pending",
            result_status: node.result_status ?? "unknown",
            fail_reason: node.fail_reason,
            action_count: node.action_count ?? 0,
            attempt: node.attempt ?? 0,
            max_attempts: node.max_attempts ?? 1,
            max_actions: node.max_actions ?? 20,
            state_json: node.state_json,
            result_json: node.result_json,
            position: node.position ?? index,
          }).run()
        }

        for (const edge of input.edges ?? []) {
          tx.insert(WorkflowEdgeTable).values({
            id: edge.id ?? edgeID(),
            workflow_id: created.id,
            from_node_id: edge.from_node_id,
            to_node_id: edge.to_node_id,
            label: edge.label,
            config: edge.config,
          }).run()
        }

        for (const checkpoint of input.checkpoints ?? []) {
          tx.insert(WorkflowCheckpointTable).values({
            id: checkpoint.id ?? checkpointID(),
            workflow_id: created.id,
            node_id: checkpoint.node_id,
            label: checkpoint.label,
            status: checkpoint.status ?? "pending",
            config: checkpoint.config,
            result_json: checkpoint.result_json,
          }).run()
        }

        return created
      })

      Database.effect(async () => {
        await Bus.publish(Event.Created, { info: workflow })
        await writeEvent({
          workflowID: workflow.id,
          sessionID: workflow.session_id,
          source: "runtime",
          kind: "workflow.created",
          payload: {
            title: workflow.title,
          },
        })
        const snapshot = await get(workflow.id)
        for (const node of snapshot.nodes) {
          await Bus.publish(Event.NodeCreated, { info: node })
        }
        for (const edge of snapshot.edges) {
          await Bus.publish(Event.EdgeCreated, { info: edge })
        }
        for (const checkpoint of snapshot.checkpoints) {
          await Bus.publish(Event.CheckpointUpdated, { info: checkpoint })
        }
      })

      return workflow
    },
  )

  export const createNode = fn(
    z.object({
      workflowID: z.string(),
      session_id: z.string().optional(),
      title: z.string(),
      agent: z.string(),
      model: Node.shape.model.optional(),
      config: z.record(z.string(), z.any()).optional(),
      status: WorkflowNodeStatus.optional(),
      result_status: WorkflowNodeResultStatus.optional(),
      max_attempts: z.number().int().positive().optional(),
      max_actions: z.number().int().positive().optional(),
      position: z.number().int().nonnegative().optional(),
    }),
    async (input) => {
      await state()
      const row = Database.use((db) =>
        db
          .insert(WorkflowNodeTable)
          .values({
            id: nodeID(),
            workflow_id: input.workflowID,
            session_id: input.session_id,
            title: input.title,
            agent: input.agent,
            model: input.model,
            config: input.config,
            status: input.status ?? "pending",
            result_status: input.result_status ?? "unknown",
            max_attempts: input.max_attempts ?? 1,
            max_actions: input.max_actions ?? 20,
            position: input.position ?? 0,
          })
          .returning()
          .get(),
      )
      if (!row) throw new Error("Failed to create workflow node")
      const info = fromNodeRow(row)
      Database.effect(async () => {
        await Bus.publish(Event.NodeCreated, { info })
        await writeEvent({
          workflowID: info.workflow_id,
          nodeID: info.id,
          sessionID: info.session_id,
          source: "orchestrator",
          kind: "node.created",
          payload: {
            title: info.title,
            agent: info.agent,
          },
        })
        await touchWorkflow({ workflowID: info.workflow_id })
      })
      return info
    },
  )

  export const createEdge = fn(
    z.object({
      workflowID: z.string(),
      from_node_id: z.string(),
      to_node_id: z.string(),
      label: z.string().optional(),
      config: z.record(z.string(), z.any()).optional(),
    }),
    async (input) => {
      const row = Database.use((db) =>
        db
          .insert(WorkflowEdgeTable)
          .values({
            id: edgeID(),
            workflow_id: input.workflowID,
            from_node_id: input.from_node_id,
            to_node_id: input.to_node_id,
            label: input.label,
            config: input.config,
          })
          .returning()
          .get(),
      )
      if (!row) throw new Error("Failed to create workflow edge")
      const info = fromEdgeRow(row)
      Database.effect(async () => {
        await Bus.publish(Event.EdgeCreated, { info })
        await writeEvent({
          workflowID: info.workflow_id,
          source: "orchestrator",
          kind: "edge.created",
          payload: {
            from_node_id: info.from_node_id,
            to_node_id: info.to_node_id,
            label: info.label,
          },
        })
        await touchWorkflow({ workflowID: info.workflow_id })
      })
      return info
    },
  )

  export const createCheckpoint = fn(
    z.object({
      workflowID: z.string(),
      node_id: z.string(),
      label: z.string(),
      status: WorkflowCheckpointStatus.optional(),
      config: z.record(z.string(), z.any()).optional(),
      result_json: z.record(z.string(), z.any()).optional(),
    }),
    async (input) => {
      const row = Database.use((db) =>
        db
          .insert(WorkflowCheckpointTable)
          .values({
            id: checkpointID(),
            workflow_id: input.workflowID,
            node_id: input.node_id,
            label: input.label,
            status: input.status ?? "pending",
            config: input.config,
            result_json: input.result_json,
          })
          .returning()
          .get(),
      )
      if (!row) throw new Error("Failed to create workflow checkpoint")
      const info = fromCheckpointRow(row)
      Database.effect(async () => {
        await Bus.publish(Event.CheckpointUpdated, { info })
        await writeEvent({
          workflowID: info.workflow_id,
          nodeID: info.node_id,
          source: "orchestrator",
          kind: "checkpoint.created",
          payload: {
            label: info.label,
            status: info.status,
          },
        })
        await touchWorkflow({ workflowID: info.workflow_id })
      })
      return info
    },
  )

  export const getNode = fn(z.string(), async (nodeID) => {
    await state()
    const row = Database.use((db) => db.select().from(WorkflowNodeTable).where(eq(WorkflowNodeTable.id, nodeID)).get())
    if (!row) throw new NotFoundError({ message: `Workflow node not found: ${nodeID}` })
    return fromNodeRow(row)
  })

  export const nodeBySession = fn(z.string(), async (sessionID) => {
    await state()
    const row = Database.use((db) =>
      db.select().from(WorkflowNodeTable).where(eq(WorkflowNodeTable.session_id, sessionID)).get(),
    )
    if (!row) throw new NotFoundError({ message: `Workflow node not found for session: ${sessionID}` })
    return fromNodeRow(row)
  })

  export const get = fn(z.string(), async (workflowID) => {
    await state()
    const workflowRow = Database.use((db) =>
      db.select().from(WorkflowTable).where(eq(WorkflowTable.id, workflowID)).get(),
    )
    if (!workflowRow) throw new NotFoundError({ message: `Workflow not found: ${workflowID}` })
    const workflow = fromWorkflowRow(workflowRow)
    const rows = Database.use((db) => ({
      nodes: db
        .select()
        .from(WorkflowNodeTable)
        .where(eq(WorkflowNodeTable.workflow_id, workflowID))
        .orderBy(WorkflowNodeTable.position)
        .all(),
      edges: db.select().from(WorkflowEdgeTable).where(eq(WorkflowEdgeTable.workflow_id, workflowID)).all(),
      checkpoints: db
        .select()
        .from(WorkflowCheckpointTable)
        .where(eq(WorkflowCheckpointTable.workflow_id, workflowID))
        .all(),
      events: db
        .select()
        .from(WorkflowEventTable)
        .where(eq(WorkflowEventTable.workflow_id, workflowID))
        .orderBy(desc(WorkflowEventTable.id))
        .limit(100)
        .all(),
    }))
    const events = rows.events.toReversed().map(fromEventRow)
    const nodes = rows.nodes.map(fromNodeRow)
    return {
      workflow,
      runtime: runtime({
        workflow,
        nodes,
        events,
      }),
      nodes,
      edges: rows.edges.map(fromEdgeRow),
      checkpoints: rows.checkpoints.map(fromCheckpointRow),
      events,
      cursor: events.at(-1)?.id ?? 0,
    }
  })

  export const bySession = fn(z.string(), async (sessionID) => {
    await state()
    const direct = Database.use((db) =>
      db.select().from(WorkflowTable).where(eq(WorkflowTable.session_id, sessionID)).get(),
    )
    if (direct) return get(direct.id)
    const node = await nodeBySession(sessionID).catch(() => undefined)
    if (!node) throw new NotFoundError({ message: `Workflow not found for session: ${sessionID}` })
    return get(node.workflow_id)
  })

  export const read = fn(
    z.object({
      workflowID: z.string(),
      cursor: z.number().int().nonnegative().optional(),
    }),
    async (input) => {
      await state()
      const workflowRow = Database.use((db) =>
        db.select().from(WorkflowTable).where(eq(WorkflowTable.id, input.workflowID)).get(),
      )
      if (!workflowRow) throw new NotFoundError({ message: `Workflow not found: ${input.workflowID}` })
      const events = Database.use((db) =>
        db
          .select()
          .from(WorkflowEventTable)
          .where(and(eq(WorkflowEventTable.workflow_id, input.workflowID), gt(WorkflowEventTable.id, input.cursor ?? 0)))
          .orderBy(WorkflowEventTable.id)
          .all(),
      )
      const changedNodeIDs = [...new Set(events.map((row) => row.node_id).filter(Boolean))] as string[]
      const changedNodes = changedNodeIDs.length
        ? Database.use((db) =>
            db.select().from(WorkflowNodeTable).where(inArray(WorkflowNodeTable.id, changedNodeIDs)).all(),
          ).map(fromNodeRow)
        : []
      const changedEdge = events.some((row) => row.kind.startsWith("edge."))
      const changedCheckpoint = events.some((row) => row.kind.startsWith("checkpoint."))
      const includeWorkflow = events.some((row) => row.kind.startsWith("workflow.") || row.kind.startsWith("node."))
      const info = fromWorkflowRow(workflowRow)
      const feed = events.map(fromEventRow)
      return {
        workflow: includeWorkflow ? info : undefined,
        runtime: includeWorkflow
          ? runtime({
              workflow: info,
              nodes: changedNodes.length > 0
                ? changedNodes
                : Database.use((db) =>
                    db.select().from(WorkflowNodeTable).where(eq(WorkflowNodeTable.workflow_id, input.workflowID)).all(),
                  ).map(fromNodeRow),
              events: input.cursor === undefined
                ? feed
                : Database.use((db) =>
                    db
                      .select()
                      .from(WorkflowEventTable)
                      .where(eq(WorkflowEventTable.workflow_id, input.workflowID))
                      .orderBy(WorkflowEventTable.id)
                      .all(),
                  ).map(fromEventRow),
            })
          : undefined,
        nodes: changedNodes,
        edges: changedEdge
          ? Database.use((db) => db.select().from(WorkflowEdgeTable).where(eq(WorkflowEdgeTable.workflow_id, input.workflowID)).all()).map(fromEdgeRow)
          : [],
        checkpoints: changedCheckpoint
          ? Database.use((db) =>
              db.select().from(WorkflowCheckpointTable).where(eq(WorkflowCheckpointTable.workflow_id, input.workflowID)).all(),
            ).map(fromCheckpointRow)
          : [],
        events: feed,
        cursor: events.at(-1)?.id ?? input.cursor ?? 0,
      }
    },
  )

  export const patchNode = fn(
    z.object({
      nodeID: z.string(),
      source: z.string(),
      patch: z.object({
        status: WorkflowNodeStatus.optional(),
        result_status: WorkflowNodeResultStatus.optional(),
        fail_reason: z.string().nullable().optional(),
        session_id: z.string().nullable().optional(),
        model: Node.shape.model.nullable().optional(),
        config: z.object({
          mode: z.enum(["replace", "merge"]).optional(),
          value: z.record(z.string(), z.any()).optional(),
        }).optional(),
        state_json: z.object({
          mode: z.enum(["replace", "merge"]).optional(),
          value: z.record(z.string(), z.any()).optional(),
        }).optional(),
        result_json: z.object({
          mode: z.enum(["replace", "merge"]).optional(),
          value: z.record(z.string(), z.any()).optional(),
        }).optional(),
        attempt_delta: z.number().int().optional(),
        action_count: z.number().int().nonnegative().optional(),
        max_attempts: z.number().int().positive().optional(),
        max_actions: z.number().int().positive().optional(),
        title: z.string().optional(),
      }),
      action_delta: z.number().int().optional(),
      event: z
        .object({
          kind: z.string(),
          target_node_id: z.string().optional(),
          payload: z.record(z.string(), z.any()).optional(),
        })
        .optional(),
    }),
    async (input) => {
      await state()
      const row = Database.transaction((tx) => {
        const found = tx.select().from(WorkflowNodeTable).where(eq(WorkflowNodeTable.id, input.nodeID)).get()
        if (!found) throw new NotFoundError({ message: `Workflow node not found: ${input.nodeID}` })

        const current = fromNodeRow(found)
        const nextStatus = input.patch.status ?? current.status
        const attempt = current.attempt + (input.patch.attempt_delta ?? 0)
        const actionCount =
          input.patch.action_count ?? current.action_count + (input.action_delta ?? 0)
        const updated = tx
          .update(WorkflowNodeTable)
          .set({
            status: nextStatus,
            result_status: input.patch.result_status ?? current.result_status,
            fail_reason:
              input.patch.fail_reason === undefined ? current.fail_reason : (input.patch.fail_reason ?? null),
            session_id:
              input.patch.session_id === undefined ? current.session_id : (input.patch.session_id ?? null),
            model:
              input.patch.model === undefined ? current.model : (input.patch.model ?? null),
            config:
              input.patch.config === undefined
                ? current.config
                : (mergeJSON(
                    current.config,
                    input.patch.config.value,
                    input.patch.config.mode ?? "merge",
                  ) ?? null),
            state_json:
              input.patch.state_json === undefined
                ? current.state_json
                : (mergeJSON(
                    current.state_json,
                    input.patch.state_json.value,
                    input.patch.state_json.mode ?? "merge",
                  ) ?? null),
            result_json:
              input.patch.result_json === undefined
                ? current.result_json
                : (mergeJSON(
                    current.result_json,
                    input.patch.result_json.value,
                    input.patch.result_json.mode ?? "merge",
                  ) ?? null),
            attempt,
            action_count: actionCount,
            max_attempts: input.patch.max_attempts ?? current.max_attempts,
            max_actions: input.patch.max_actions ?? current.max_actions,
            title: input.patch.title ?? current.title,
            version: current.version + 1,
            time_started: current.time.started ?? (nextStatus === "running" ? Date.now() : null),
            time_completed:
              nextStatus === "completed" || nextStatus === "failed" || nextStatus === "cancelled"
                ? Date.now()
                : current.time.completed,
            time_updated: Date.now(),
          })
          .where(eq(WorkflowNodeTable.id, input.nodeID))
          .returning()
          .get()
        if (!updated) throw new Error("Failed to update workflow node")
        return fromNodeRow(updated)
      })

      const workflow = await touchWorkflow({
        workflowID: row.workflow_id,
        patch: {
          status: normalizeWorkflowStatus(row.status),
          current_node_id: row.status === "running" ? row.id : null,
          selected_node_id: row.id,
        },
      })
      Database.effect(async () => {
        await Bus.publish(Event.NodeUpdated, { info: row })
        await writeEvent({
          workflowID: row.workflow_id,
          nodeID: row.id,
          sessionID: row.session_id,
          target_node_id: input.event?.target_node_id,
          source: input.source,
          kind: input.event?.kind ?? "node.updated",
          payload: {
            ...(input.event?.payload ?? {}),
            status: row.status,
            result_status: row.result_status,
            action_count: row.action_count,
            attempt: row.attempt,
          },
        })
        if (row.action_count >= row.max_actions) {
          await writeEvent({
            workflowID: row.workflow_id,
            nodeID: row.id,
            sessionID: row.session_id,
            target_node_id: row.id,
            source: "runtime",
            kind: "node.action_limit_reached",
            payload: {
              action_count: row.action_count,
              max_actions: row.max_actions,
            },
          })
        }
        if (row.attempt >= row.max_attempts) {
          await writeEvent({
            workflowID: row.workflow_id,
            nodeID: row.id,
            sessionID: row.session_id,
            target_node_id: row.id,
            source: "runtime",
            kind: "node.attempt_limit_reached",
            payload: {
              attempt: row.attempt,
              max_attempts: row.max_attempts,
            },
          })
        }
        await Bus.publish(Event.Updated, { info: workflow })
      })
      return row
    },
  )

  export const control = fn(
    z.object({
      workflowID: z.string(),
      nodeID: z.string(),
      source: z.string(),
      command: z.enum(["continue", "pause", "resume", "interrupt", "retry", "cancel", "inject_context"]),
      payload: z.record(z.string(), z.any()).optional(),
    }),
    async (input) => {
      await state()
      await getNode(input.nodeID)
      await writeEvent({
        workflowID: input.workflowID,
        nodeID: input.nodeID,
        target_node_id: input.nodeID,
        source: input.source,
        kind: "node.control",
        payload: {
          command: input.command,
          ...(input.payload ?? {}),
        },
      })
      return true
    },
  )

  export const pull = fn(
    z.object({
      nodeID: z.string(),
      cursor: z.number().int().nonnegative().optional(),
    }),
    async (input) => {
      await state()
      const node = await getNode(input.nodeID)
      const rows = Database.use((db) =>
        db
          .select()
          .from(WorkflowEventTable)
          .where(
            and(
              eq(WorkflowEventTable.workflow_id, node.workflow_id),
              eq(WorkflowEventTable.target_node_id, node.id),
              gt(WorkflowEventTable.id, input.cursor ?? 0),
            ),
          )
          .orderBy(WorkflowEventTable.id)
          .all(),
      )
      await writeEvent({
        workflowID: node.workflow_id,
        nodeID: node.id,
        sessionID: node.session_id,
        source: "node",
        kind: "node.pulled",
        payload: {
          cursor: input.cursor ?? 0,
          pending: rows.length,
        },
      })
      return {
        node,
        cursor: rows.at(-1)?.id ?? input.cursor ?? 0,
        events: rows.map(fromEventRow),
      }
    },
  )

  export const setCheckpoint = fn(
    z.object({
      checkpointID: z.string(),
      status: WorkflowCheckpointStatus,
      result_json: z.record(z.string(), z.any()).optional(),
    }),
    async (input) => {
      await state()
      const row = Database.use((db) =>
        db
          .update(WorkflowCheckpointTable)
          .set({
            status: input.status,
            result_json: input.result_json,
            time_updated: Date.now(),
          })
          .where(eq(WorkflowCheckpointTable.id, input.checkpointID))
          .returning()
          .get(),
      )
      if (!row) throw new NotFoundError({ message: `Workflow checkpoint not found: ${input.checkpointID}` })
      const info = fromCheckpointRow(row)
      Database.effect(async () => {
        await Bus.publish(Event.CheckpointUpdated, { info })
        await writeEvent({
          workflowID: info.workflow_id,
          nodeID: info.node_id,
          source: "runtime",
          kind: `checkpoint.${info.status}`,
          payload: {
            checkpoint_id: info.id,
            label: info.label,
          },
        })
        await touchWorkflow({ workflowID: info.workflow_id })
      })
      return info
    },
  )

  export const diff = fn(z.string(), async (workflowID) => {
    await state()
    const snapshot = await get(workflowID)
    const byFile = new Map<string, Awaited<ReturnType<typeof Session.diff>>[number]>()

    for (const sessionID of [snapshot.workflow.session_id, ...snapshot.nodes.map((node) => node.session_id).filter(Boolean)]) {
      if (!sessionID) continue
      const diffs = await Session.diff(SessionID.make(sessionID))
      for (const diff of diffs) {
        const existing = byFile.get(diff.file)
        if (!existing) {
          byFile.set(diff.file, diff)
          continue
        }
        byFile.set(diff.file, {
          ...existing,
          additions: existing.additions + diff.additions,
          deletions: existing.deletions + diff.deletions,
          status:
            existing.status === diff.status
              ? existing.status
              : existing.status === "deleted" && diff.status === "added"
                ? "modified"
                : "modified",
        })
      }
    }

    return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file))
  })
}
