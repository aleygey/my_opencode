import { Tool } from "./tool"
import DESCRIPTION from "./sand-table.txt"
import z from "zod"
import { Session } from "../session"
import { SessionID, MessageID, PartID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { SessionPrompt } from "../session/prompt"
import { Provider } from "../provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { Log } from "../util/log"
import { defer } from "@/util/defer"

const log = Log.create({ service: "tool.sand-table" })

// ── Bus Event ──────────────────────────────────────────────────────────────

export const SandTableMessageEvent = BusEvent.define(
  "sandtable.message",
  z.object({
    discussionID: z.string(),
    role: z.string(),
    round: z.number(),
  }),
)

// ── Types ──────────────────────────────────────────────────────────────────

type DiscussionRole = "planner" | "evaluator" | "orchestrator"

interface DiscussionMessage {
  role: DiscussionRole
  model: string
  content: string
  round: number
  timestamp: number
}

interface Participant {
  role: "planner" | "evaluator"
  sessionID: SessionID
  model: { providerID: ProviderID; modelID: ModelID }
}

interface DiscussionState {
  id: string
  topic: string
  context: string
  messages: DiscussionMessage[]
  round: number
  maxRounds: number
  status: "running" | "approved" | "completed" | "failed"
  participants: Participant[]
  currentPlan?: string
  evaluation?: string
}

export const SandTableParticipantSchema = z.object({
  role: z.enum(["planner", "evaluator"]),
  sessionID: z.string(),
  model: z.object({
    providerID: z.string(),
    modelID: z.string(),
  }),
})

export const SandTableMessageSchema = z.object({
  role: z.enum(["planner", "evaluator", "orchestrator"]),
  model: z.string(),
  content: z.string(),
  round: z.number(),
  timestamp: z.number(),
})

export const SandTableDiscussionSchema = z.object({
  id: z.string(),
  topic: z.string(),
  context: z.string(),
  round: z.number(),
  max_rounds: z.number(),
  status: z.enum(["running", "approved", "completed", "failed"]),
  participants: SandTableParticipantSchema.array(),
  current_plan: z.string().optional(),
  last_evaluation: z.string().optional(),
  messages: SandTableMessageSchema.array(),
})

// ── In-memory state ────────────────────────────────────────────────────────

const discussions = new Map<string, DiscussionState>()

function serialize(state: DiscussionState) {
  return {
    id: state.id,
    topic: state.topic,
    context: state.context,
    round: state.round,
    max_rounds: state.maxRounds,
    status: state.status,
    participants: state.participants.map((item) => ({
      role: item.role,
      sessionID: item.sessionID,
      model: {
        providerID: item.model.providerID,
        modelID: item.model.modelID,
      },
    })),
    current_plan: state.currentPlan,
    last_evaluation: state.evaluation,
    messages: state.messages,
  }
}

export function discussionGet(id: string) {
  const state = discussions.get(id)
  if (!state) return
  return serialize(state)
}

export async function discussionWrite(input: {
  discussionID: string
  content: string
  role?: DiscussionRole
}) {
  const state = discussions.get(input.discussionID)
  if (!state) return
  state.messages.push({
    role: input.role ?? "orchestrator",
    model: "orchestrator",
    content: input.content,
    round: state.round,
    timestamp: Date.now(),
  })

  await Bus.publish(SandTableMessageEvent, {
    discussionID: state.id,
    role: input.role ?? "orchestrator",
    round: state.round,
  })

  return serialize(state)
}

// ── Model resolution ───────────────────────────────────────────────────────

const ModelAssignment = z.object({
  providerID: z.string(),
  modelID: z.string(),
})

async function resolveModels(
  overrides?: { planner?: z.infer<typeof ModelAssignment>; evaluator?: z.infer<typeof ModelAssignment> },
  currentModel?: { providerID: ProviderID; modelID: ModelID },
): Promise<{
  planner: { providerID: ProviderID; modelID: ModelID }
  evaluator: { providerID: ProviderID; modelID: ModelID }
}> {
  const planner = overrides?.planner
    ? {
        providerID: ProviderID.make(overrides.planner.providerID),
        modelID: ModelID.make(overrides.planner.modelID),
      }
    : currentModel ?? (await Provider.defaultModel())

  const evaluator = overrides?.evaluator
    ? {
        providerID: ProviderID.make(overrides.evaluator.providerID),
        modelID: ModelID.make(overrides.evaluator.modelID),
      }
    : planner

  return { planner, evaluator }
}

// ── Prompts ────────────────────────────────────────────────────────────────

const PLANNER_SYSTEM =
  "You are a plan architect in a sand table exercise. Given the user's goal and context, produce a detailed, actionable workflow plan. Structure it as a list of nodes with agent assignments, dependencies, and checkpoints. If this is a revision round, incorporate the evaluator's feedback to improve the plan. Use msg_write to share your plan."

const EVALUATOR_SYSTEM =
  "You are a plan evaluator in a sand table exercise. Review the proposed plan critically: check for completeness, feasibility, risk, missing edge cases, and optimal agent assignment. Respond with either APPROVE (if the plan is solid) or REVISE followed by specific, actionable feedback. Use msg_write to share your evaluation."

function plannerPrompt(state: DiscussionState): string {
  const lines = [
    `Topic: ${state.topic}`,
    state.context ? `Context: ${state.context}` : "",
    `Round ${state.round}/${state.maxRounds}`,
    "",
  ]
  if (state.evaluation) {
    lines.push(`Evaluator feedback from last round:`, state.evaluation, "")
  }
  lines.push(
    `Generate a detailed workflow plan. Use msg_write with discussion_id="${state.id}" to publish your plan.`,
  )
  return lines.filter((l) => l !== undefined).join("\n")
}

function evaluatorPrompt(state: DiscussionState): string {
  const lines = [
    `Topic: ${state.topic}`,
    state.context ? `Context: ${state.context}` : "",
    `Round ${state.round}/${state.maxRounds}`,
    "",
    `Proposed plan:`,
    state.currentPlan ?? "(no plan received)",
    "",
    `Evaluate this plan. Respond with APPROVE or REVISE + feedback. Use msg_write with discussion_id="${state.id}" to publish your evaluation.`,
  ]
  return lines.join("\n")
}

// ── Convergence ────────────────────────────────────────────────────────────

function checkApproval(state: DiscussionState): boolean {
  const lastEval = state.messages
    .filter((m) => m.role === "evaluator" && m.round === state.round)
    .pop()
  if (!lastEval) return false
  return /\bAPPROVE\b/i.test(lastEval.content)
}

function extractFeedback(state: DiscussionState): string | null {
  const lastEval = state.messages
    .filter((m) => m.role === "evaluator" && m.round === state.round)
    .pop()
  if (!lastEval || checkApproval(state)) return null
  const match = lastEval.content.match(/\bREVISE\b[:\s]*([\s\S]*)/i)
  return match?.[1]?.trim() ?? lastEval.content
}

// ── Round execution ────────────────────────────────────────────────────────

async function waitForMessage(
  state: DiscussionState,
  role: DiscussionRole,
  timeoutMs = 60_000,
): Promise<DiscussionMessage | null> {
  const startLen = state.messages.filter((m) => m.role === role && m.round === state.round).length
  return new Promise<DiscussionMessage | null>((resolve) => {
    const timer = setTimeout(() => {
      unsub()
      resolve(null)
    }, timeoutMs)
    const unsub = Bus.subscribe(SandTableMessageEvent, (event) => {
      if (event.properties.discussionID !== state.id) return
      if (event.properties.role !== role) return
      if (event.properties.round !== state.round) return
      const msgs = state.messages.filter((m) => m.role === role && m.round === state.round)
      if (msgs.length > startLen) {
        clearTimeout(timer)
        unsub()
        resolve(msgs[msgs.length - 1])
      }
    })
  })
}

async function runParticipant(
  state: DiscussionState,
  participant: Participant,
  prompt: string,
  abort: AbortSignal,
) {
  const messageID = MessageID.ascending()
  const cancel = () => SessionPrompt.cancel(participant.sessionID)
  abort.addEventListener("abort", cancel)
  using _ = defer(() => abort.removeEventListener("abort", cancel))

  await SessionPrompt.prompt({
    messageID,
    sessionID: participant.sessionID,
    model: participant.model,
    agent: "sandtable",
    tools: {
      msg_read: true,
      msg_write: true,
      todowrite: false,
      todoread: false,
      task: false,
    },
    parts: [{ type: "text" as const, text: prompt, id: PartID.ascending() }],
  })
}

// ── Main tool ──────────────────────────────────────────────────────────────

const parameters = z.object({
  topic: z.string().describe("The planning topic or question to discuss"),
  context: z.string().optional().describe("Additional context from the current session"),
  max_rounds: z.number().int().min(1).max(5).default(3).describe("Maximum discussion rounds"),
  models: z
    .object({
      planner: ModelAssignment.optional(),
      evaluator: ModelAssignment.optional(),
    })
    .optional()
    .describe(
      "Override model for each role. If omitted, auto-detect from available providers.",
    ),
})

export const SandTableTool = Tool.define("sand_table", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx) {
    const discussionID = crypto.randomUUID()
    const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
    if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

    const currentModel = {
      providerID: msg.info.providerID,
      modelID: msg.info.modelID,
    }

    const models = await resolveModels(params.models, currentModel)

    log.info("sand_table starting", {
      discussionID,
      topic: params.topic,
      planner: `${models.planner.providerID}/${models.planner.modelID}`,
      evaluator: `${models.evaluator.providerID}/${models.evaluator.modelID}`,
    })

    // Create child sessions
    const plannerSession = await Session.create({
      parentID: ctx.sessionID,
      title: `Sand Table Planner (@sandtable)`,
      permission: [
        { permission: "msg_read", pattern: "*", action: "allow" },
        { permission: "msg_write", pattern: "*", action: "allow" },
        { permission: "*" as const, pattern: "*", action: "deny" },
      ],
    })

    const evaluatorSession = await Session.create({
      parentID: ctx.sessionID,
      title: `Sand Table Evaluator (@sandtable)`,
      permission: [
        { permission: "msg_read", pattern: "*", action: "allow" },
        { permission: "msg_write", pattern: "*", action: "allow" },
        { permission: "*" as const, pattern: "*", action: "deny" },
      ],
    })

    const state: DiscussionState = {
      id: discussionID,
      topic: params.topic,
      context: params.context ?? "",
      messages: [],
      round: 0,
      maxRounds: params.max_rounds,
      status: "running",
      participants: [
        { role: "planner", sessionID: plannerSession.id, model: models.planner },
        { role: "evaluator", sessionID: evaluatorSession.id, model: models.evaluator },
      ],
    }
    discussions.set(discussionID, state)

    ctx.metadata({
      title: `Sand table: ${params.topic.slice(0, 60)}`,
      metadata: { sandTableID: discussionID },
    })

    try {
      for (let round = 1; round <= params.max_rounds; round++) {
        if (ctx.abort.aborted) {
          state.status = "failed"
          break
        }

        state.round = round
        log.info("sand_table round", { discussionID, round })

        // Step 1: Planner generates/revises plan
        const planner = state.participants.find((p) => p.role === "planner")!
        await runParticipant(state, planner, plannerPrompt(state), ctx.abort)

        // Wait for planner's msg_write
        const planMsg = await waitForMessage(state, "planner", 60_000)
        if (planMsg) {
          state.currentPlan = planMsg.content
        } else {
          log.warn("planner timeout", { discussionID, round })
        }

        // Step 2: Evaluator reviews plan
        const evaluator = state.participants.find((p) => p.role === "evaluator")!
        await runParticipant(state, evaluator, evaluatorPrompt(state), ctx.abort)

        // Wait for evaluator's msg_write
        const evalMsg = await waitForMessage(state, "evaluator", 60_000)
        if (evalMsg) {
          state.evaluation = evalMsg.content
        } else {
          log.warn("evaluator timeout", { discussionID, round })
        }

        // Check if evaluator approved
        if (checkApproval(state)) {
          state.status = "approved"
          log.info("sand_table approved", { discussionID, round })
          break
        }

        // Extract feedback for next round
        const feedback = extractFeedback(state)
        if (feedback) {
          state.evaluation = feedback
        }
      }

      if (state.status === "running") {
        state.status = "completed"
      }
    } catch (err) {
      state.status = "failed"
      log.error("sand_table error", { discussionID, error: String(err) })
    }

    const output = JSON.stringify(
      {
        sand_table_id: state.id,
        status: state.status,
        rounds: state.round,
        final_plan: state.currentPlan,
        last_evaluation: state.evaluation,
        history: state.messages,
      },
      null,
      2,
    )

    return {
      title: `Sand table ${state.status} (${state.round} rounds)`,
      metadata: { sandTableID: state.id },
      output,
    }
  },
})

// ── msg_read tool ──────────────────────────────────────────────────────────

const msgReadParams = z.object({
  discussion_id: z.string().describe("The sand table discussion ID"),
  since_round: z
    .number()
    .int()
    .optional()
    .describe("Only return messages from this round onwards"),
})

export const MsgReadTool = Tool.define("msg_read", {
  description:
    "Read messages from a sand table discussion. Available to both participants and the orchestrator.",
  parameters: msgReadParams,
  async execute(params: z.infer<typeof msgReadParams>, _ctx) {
    const state = discussions.get(params.discussion_id)
    if (!state) {
      return {
        title: "No discussion",
        output: "Discussion not found",
        metadata: {},
      }
    }
    const msgs = params.since_round
      ? state.messages.filter((m) => m.round >= params.since_round!)
      : state.messages
    return {
      title: `Read ${msgs.length} messages`,
      output: JSON.stringify(msgs, null, 2),
      metadata: {},
    }
  },
})

// ── msg_write tool ─────────────────────────────────────────────────────────

const msgWriteParams = z.object({
  discussion_id: z.string().describe("The sand table discussion ID"),
  content: z.string().describe("Message content to publish"),
  role: z
    .enum(["planner", "evaluator", "orchestrator"])
    .optional()
    .describe(
      "Override role (orchestrator only). Subagents' role is auto-detected from their session.",
    ),
})

export const MsgWriteTool = Tool.define("msg_write", {
  description:
    "Write a message to a sand table discussion. Participants use this to publish their analysis. The orchestrator can use this to inject user context.",
  parameters: msgWriteParams,
  async execute(params: z.infer<typeof msgWriteParams>, ctx) {
    const state = discussions.get(params.discussion_id)
    if (!state) {
      return {
        title: "Failed",
        output: "Discussion not found",
        metadata: {},
      }
    }

    // Detect caller identity
    const participant = state.participants.find(
      (p) => p.sessionID === ctx.sessionID,
    )
    const role: DiscussionRole =
      participant?.role ?? params.role ?? "orchestrator"
    const model =
      participant
        ? `${participant.model.providerID}/${participant.model.modelID}`
        : "orchestrator"

    state.messages.push({
      role,
      model,
      content: params.content,
      round: state.round,
      timestamp: Date.now(),
    })

    await Bus.publish(SandTableMessageEvent, {
      discussionID: state.id,
      role,
      round: state.round,
    })

    return {
      title: `Published as ${role}`,
      output: "Message written to sand table",
      metadata: {},
    }
  },
})
