import { Tool } from "./tool"
import DESCRIPTION from "./sand-table.txt"
import z from "zod"
import { Effect } from "effect"
import { Session } from "../session"
import { SessionID, MessageID, PartID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { SessionPrompt } from "../session/prompt"
import { Provider } from "../provider"
import { ModelID, ProviderID } from "../provider/schema"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { Log } from "../util"
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
// Secondary index: the tool call ID that triggered each discussion.
//
// Rationale — the frontend learns about the discussion ID via
// `ctx.metadata({ sandTableID })`, but that publishes through an Effect that
// isn't run when `execute` is an async function (the Effect is created,
// never awaited, and the metadata update never reaches the client). Until
// that's fixed properly, the frontend has no way to know the discussion ID
// mid-run. However it DOES know the tool part's `callID` from the outset.
// We register each discussion under its callID too so polling can use that
// as a stable key instead of waiting for metadata propagation.
const discussionsByCallID = new Map<string, DiscussionState>()

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
  // Try primary (discussionID) first, then the callID fallback. This lets the
  // HTTP endpoint accept either identifier interchangeably.
  const state = discussions.get(id) ?? discussionsByCallID.get(id)
  if (!state) return
  return serialize(state)
}

export async function discussionWrite(input: {
  discussionID: string
  content: string
  role?: DiscussionRole
}) {
  // Accept either the real discussionID or the callID — see discussionGet.
  const state =
    discussions.get(input.discussionID) ?? discussionsByCallID.get(input.discussionID)
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

// NOTE: Localisation policy
// -------------------------
// The product is primarily used by a Chinese-speaking team, so planner and
// evaluator must answer in Simplified Chinese (简体中文). However, `APPROVE`
// and `REVISE` MUST stay as literal English tokens — `checkApproval` /
// `extractFeedback` below match on them via regex. Node titles, agent names
// (e.g. `coder`, `build-flash`) and tool invocations should also keep their
// English/technical identifiers because downstream routing parses them.
const PLANNER_SYSTEM = `You are a plan architect in a sand table exercise. Given the user's goal and context, produce a detailed, actionable workflow plan. If this is a revision round, incorporate the evaluator's feedback. Use msg_write to share your plan.

PLAN SHAPE (critical — this determines whether downstream execution can parallelise):
The plan is a DAG of nodes, NOT a linear list. Each node MUST declare its predecessors via a \`depends_on\` array of node IDs. An empty \`depends_on\` means the node can start immediately. Multiple nodes with the same (or empty) \`depends_on\` run in parallel. A node with multiple entries in \`depends_on\` is a fan-in — it waits for ALL of its predecessors.

DAG-FIRST DESIGN RULE:
Before writing the plan, identify which pieces of work are truly independent and MUST run in parallel (independent files, independent subsystems, independent evidence-gathering tasks). Only serialise two nodes when one genuinely consumes the output of the other. A plan that is a single straight chain (A→B→C→D) is almost always wrong — it means you failed to spot parallelism.

CANONICAL SHAPES:
- Fan-out + fan-in (most common):  root → {A, B, C run in parallel} → merge/integrate → deploy
    A.depends_on = [root],  B.depends_on = [root],  C.depends_on = [root]
    merge.depends_on = [A, B, C]
- Diamond:  analyze → {design, prototype in parallel} → validate
- Pipeline (rare — only when truly sequential):  extract → transform → load

SCHEMA (each node):
{
  id: string,              // stable short identifier, e.g. "fetch_logs"
  title: string,           // short English noun phrase
  agent: "coding" | "build-flash" | "debug" | "deploy" | ...,
  description: string,     // Chinese: what this node does and why
  depends_on: string[]     // REQUIRED; use [] for entry nodes. NEVER omit.
}

SELF-CHECK before you publish (apply all three):
1. Count nodes with \`depends_on: []\` — if exactly one, ask whether two tasks could actually start in parallel from the root.
2. Count fan-in nodes (\`depends_on.length >= 2\`) — if zero, your plan is a chain; reconsider whether an integration / aggregation / validation node is missing.
3. For every edge A → B, ask: does B literally consume A's output? If not, delete the edge and let them run in parallel.

Use msg_write to publish the plan.

IMPORTANT: Always write your plan content (descriptions, rationale, checkpoints) in Simplified Chinese (简体中文). Keep technical identifiers such as node IDs, titles, agent names, tool names, file paths, and code snippets in their original form.`

// Evaluator rubric — 8 dimensions the evaluator MUST explicitly score
// on every round. This is the core anti-anchoring measure: by forcing
// the evaluator to re-examine every dimension from scratch each round,
// we prevent the degenerate pattern of "planner patched the 3 issues I
// raised last round → APPROVE without thinking". Combined with the
// fresh-session-per-round wiring in the execute() loop below, each
// round starts with zero memory of the prior critique, so an APPROVE
// only happens when the current plan genuinely passes the rubric — not
// because the planner obeyed the previous round's punch-list.
const EVALUATOR_SYSTEM = `You are an INDEPENDENT plan evaluator in a sand table exercise.

Evaluate the proposed workflow plan against the rubric below. For each dimension, give a short verdict (OK / ISSUE / BLOCKER) and a one-line justification. Only return APPROVE if ALL dimensions are OK (zero ISSUE, zero BLOCKER).

RUBRIC (score every dimension explicitly, in order):
1. Goal alignment — does the plan actually solve the stated topic / user goal?
2. Node decomposition — are the nodes right-sized (not too coarse, not too granular) and does each node have a single clear purpose?
3. Dependency graph — is depends_on correct AND is the DAG exploiting available parallelism? Check each edge A→B: does B literally consume A's output? If not, the edge is a false dependency (ISSUE). A plan that is a single straight chain (every node has exactly one predecessor and one successor) is almost always a BLOCKER — flag it and require the planner to identify which tasks could fan out from the root or fan in at an integration node. Also check: no cycles, no missing edges, no orphan nodes.
4. Agent assignment — is each node's agent (coding / build-flash / debug / deploy / …) the best fit for the work it will do?
5. Checkpoints — do checkpoints cover the key decision points and risky transitions, and are they phrased so a human reviewer knows what to check?
6. Edge cases & failure modes — does the plan anticipate the top 3 realistic ways this could go wrong, and is there a response for each?
7. Rollback / recovery — if a middle node fails, can work be resumed or rolled back without restarting from scratch?
8. Complexity estimate — does estimated_complexity match the actual graph size, dependency depth, and risk surface?

ANTI-ANCHORING RULE (critical):
You have NO memory of previous rounds. Do not assume the plan improved just because "the planner addressed my last feedback" — you did not give feedback, this is your first and only look. Re-evaluate every dimension from scratch. If something is still wrong, say so, even if it was wrong last round too. If something is newly wrong, flag it. Do NOT approve just because the plan has changed.

WORKFLOW-DESIGN SPECIFIC CHECKS:
- Are there orphan nodes (no dependents, not a terminal)?
- Are there nodes that could run in parallel but are needlessly serialised?
- Does the plan conflate "planning work" with "execution work"? (The sand table IS the planner — the resulting plan should not include meta-planning nodes.)
- Do checkpoint placements create actual review leverage, or are they decorative?

OUTPUT FORMAT:
- Start with the literal uppercase token \`APPROVE\` or \`REVISE\` on its own line — this is parsed programmatically, do not translate or reformat it.
- If REVISE, list the failing dimensions with the ISSUE / BLOCKER marker and concrete actionable feedback.
- If APPROVE, still include the 8-dimension summary so the approval is auditable.

LANGUAGE: Write all narrative / feedback in Simplified Chinese (简体中文). Keep technical identifiers (node titles, agent names, tool names, file paths, code snippets, and the APPROVE / REVISE token itself) in their original form.

Use \`msg_write\` with the provided discussion_id to publish your evaluation.`

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
    // Reiterated per-turn so the model doesn't drift back to English when the
    // surrounding context (topic, feedback) is English. Technical identifiers
    // remain exempt so orchestrator routing isn't broken.
    `请使用简体中文撰写计划内容（节点描述、理由、风险等）。节点标题、agent 名称、工具名、文件路径、代码片段保持原样。`,
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
    // Anti-anchoring reminder at the call site too — even though the
    // session is fresh (no prior messages), the prompt itself shouldn't
    // hint at "last round" context the evaluator shouldn't have.
    `Evaluate this plan independently using the rubric in your system prompt. You have no memory of prior rounds; score every dimension from scratch.`,
    `Respond with APPROVE or REVISE on the first line, followed by the 8-dimension breakdown. Use msg_write with discussion_id="${state.id}" to publish.`,
    // Verdict token MUST stay uppercase English — checkApproval regex depends
    // on it. The rest of the response (feedback, rationale) should be in
    // Simplified Chinese for the Chinese-speaking team.
    `格式：第一行仅写大写英文 APPROVE 或 REVISE；随后以简体中文按 8 项 rubric 逐条给出 OK / ISSUE / BLOCKER + 理由。节点标题、agent 名称、工具名、文件路径、代码片段保持原样。`,
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

    // Planner session is long-lived — it iterates its own plan across
    // rounds, so it NEEDS the prior context (its last draft + the
    // evaluator's feedback) to produce a revised draft. Creating it
    // once and reusing is correct.
    const plannerSession = await Session.create({
      parentID: ctx.sessionID,
      title: `Sand Table Planner (@sandtable)`,
      permission: [
        { permission: "msg_read", pattern: "*", action: "allow" },
        { permission: "msg_write", pattern: "*", action: "allow" },
        { permission: "*" as const, pattern: "*", action: "deny" },
      ],
    })

    // Evaluator session is created PER ROUND (see loop below). Starting
    // state has no evaluator yet; participants[] gets the current
    // round's evaluator pushed in as each round starts, and stays
    // pointing at the most recent one for observability.
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
      ],
    }
    discussions.set(discussionID, state)
    // Register under the tool call ID as a secondary key so the frontend can
    // look up the discussion using the part.callID it already knows,
    // independent of whether the ctx.metadata update reaches the client.
    if (ctx.callID) discussionsByCallID.set(ctx.callID, state)

    // ctx.metadata returns a lazy Effect; calling it without running produces
    // no side effect. We fire-and-forget via Effect.runPromise so the client
    // *does* see the sandTableID published on the tool part state while
    // running. Failures are swallowed because the callID-keyed fallback above
    // keeps the UI functional even if metadata never propagates.
    void Effect.runPromise(
      ctx.metadata({
        title: `Sand table: ${params.topic.slice(0, 60)}`,
        metadata: { sandTableID: discussionID },
      }) as Effect.Effect<void, unknown, never>,
    ).catch((err) => log.warn("sand_table metadata publish failed", { err: String(err) }))

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

        // Step 2: Evaluator reviews plan.
        //
        // Fresh session per round: this is the anti-anchoring fix. If
        // we reused the evaluator session, round N+1 would see round
        // N's critique in its own message history, and the model
        // tends to rubber-stamp ("planner fixed the points I raised
        // → APPROVE") regardless of what the current plan actually
        // says. Spinning up a new session means round N+1's evaluator
        // has zero memory of round N's critique and must re-evaluate
        // from the rubric in EVALUATOR_SYSTEM.
        const evaluatorSession = await Session.create({
          parentID: ctx.sessionID,
          title: `Sand Table Evaluator · round ${round} (@sandtable)`,
          permission: [
            { permission: "msg_read", pattern: "*", action: "allow" },
            { permission: "msg_write", pattern: "*", action: "allow" },
            { permission: "*" as const, pattern: "*", action: "deny" },
          ],
        })
        const evaluator: Participant = {
          role: "evaluator",
          sessionID: evaluatorSession.id,
          model: models.evaluator,
        }
        // Keep participants[] pointing at the CURRENT round's
        // evaluator so the UI can show which session is running.
        // Replace any prior evaluator entry rather than accumulating
        // — callers read participants[] by role, not as a history.
        state.participants = [
          ...state.participants.filter((p) => p.role !== "evaluator"),
          evaluator,
        ]
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
