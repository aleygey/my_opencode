import path from "path"
import matter from "gray-matter"
import z from "zod"
import { generateObject, streamObject, type ModelMessage } from "ai"
import PROMPT_REFINER from "@/agent/prompt/refiner.txt"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Instance } from "@/project/instance"
import { Workflow } from "@/workflow"
import { Filesystem } from "@/util/filesystem"
import { Hash } from "@/util/hash"
import { Log } from "@/util/log"

const log = Log.create({ service: "refiner" })

const Classification = z.enum([
  "context_completion",
  "tool_gap_completion",
  "workflow_orchestration_completion",
  "constraint_or_policy",
  "task_scope_change",
  "noise",
])

const Scope = z.enum(["workspace", "project", "repo", "user"])

const AgentDecision = z.object({
  related: z.boolean(),
  classification: Classification,
  long_term_value: z.boolean(),
  reason: z.string(),
  task_type: z.string().min(1),
  workflow_context: z.object({
    phase: z.string(),
    node_agent: z.string().optional(),
    execution_scene: z.string().optional(),
    prerequisites: z.array(z.string()).optional(),
    environment: z.array(z.string()).optional(),
  }),
  problem_or_requirement: z.object({
    summary: z.string(),
    original_gap: z.string().optional(),
  }),
  know_how: z.object({
    summary: z.string(),
    recommended_actions: z.array(z.string()).optional(),
    tool_hints: z.array(z.string()).optional(),
    skill_hints: z.array(z.string()).optional(),
    platform_hints: z.array(z.string()).optional(),
    acceptance_hints: z.array(z.string()).optional(),
  }),
  reusability: z.object({
    scope: Scope,
    merge_candidate: z.boolean(),
    skill_candidate: z.boolean(),
  }),
})

type Classification = z.infer<typeof Classification>
type Scope = z.infer<typeof Scope>
type AgentDecision = z.infer<typeof AgentDecision>

type CandidateSourceType = "user" | "master" | "slave"

type Candidate = {
  source_type: CandidateSourceType
  workflow_id: string
  session_id?: string
  node_id?: string
  trigger_kind: string
  observed_at: number
  text: string
  event_payload?: Record<string, unknown>
}

type EvidenceItem = {
  workflow_id: string
  node_id?: string
  source_type: CandidateSourceType
  trigger_kind: string
  observed_at: number
  recovery_status: "pending" | "success" | "fail"
  inbox_path?: string
  note?: string
}

type ExperienceRecord = {
  kind: "workflow_experience"
  id: string
  created_at: string
  updated_at: string
  task_type: string
  classification: Exclude<Classification, "noise">
  related: true
  long_term_value: true
  workflow_context: {
    phase: string
    node_agent?: string
    execution_scene?: string
    prerequisites: string[]
    environment: string[]
  }
  problem_or_requirement: {
    summary: string
    original_gap?: string
  }
  know_how: {
    summary: string
    recommended_actions: string[]
    tool_hints: string[]
    skill_hints: string[]
    platform_hints: string[]
    acceptance_hints: string[]
  }
  reusability: {
    scope: Scope
    merge_candidate: boolean
    skill_candidate: boolean
  }
  evidence: {
    count: number
    success_count: number
    failure_count: number
    repeated: boolean
    items: EvidenceItem[]
  }
}

type InboxRecord = {
  kind: "refiner_inbox"
  id: string
  created_at: string
  workflow_id: string
  node_id?: string
  session_id?: string
  source_type: CandidateSourceType
  trigger_kind: string
  classification: Classification
  related: boolean
  long_term_value: boolean
  reason: string
  task_type: string
  workflow_phase: string
  node_agent?: string
  experience_id?: string
  experience_path?: string
}

const state = Instance.state(() => ({
  userSeen: {} as Record<string, string>,
  eventSeen: {} as Record<string, true>,
  pending: {} as Record<string, string[]>,
}))

function nowISO(ts = Date.now()) {
  return new Date(ts).toISOString()
}

function rel(filepath: string) {
  return path.relative(Instance.worktree, filepath) || filepath
}

function slug(input: string, fallback = "record") {
  const value = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
  return value || fallback
}

function uniq(items?: string[]) {
  return [...new Set((items ?? []).map((item) => item.trim()).filter(Boolean))]
}

async function withTimeout<T>(promise: Promise<T>, ms: number) {
  return await Promise.race([
    promise,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ])
}

function first(items?: string[]) {
  return uniq(items).at(0)
}

function lines(text: string) {
  return text
    .split(/\r?\n|[;；]/)
    .map((item) => item.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
}

function keywords(text: string, values: string[]) {
  const lower = text.toLowerCase()
  return values.some((value) => lower.includes(value.toLowerCase()))
}

function defaultTaskType(text: string) {
  if (keywords(text, ["code", "coding", "commit", "build", "test", "debug", "gerrit", "jenkins", "固件", "代码"])) {
    return "coding"
  }
  if (keywords(text, ["report", "summary", "blog", "doc", "发布说明", "测试报告"])) return "documentation"
  return "workflow_task"
}

function inferPhase(text: string, runtimePhase: string) {
  if (keywords(text, ["commit", "push", "release", "deploy", "gerrit", "jenkins", "发布", "提交", "推送", "构建验证"])) {
    return "deliver"
  }
  if (keywords(text, ["retry", "replan", "inject_context", "补充", "纠偏", "重试"])) return "retry"
  if (runtimePhase === "planning") return "plan"
  if (runtimePhase === "completed") return "deliver"
  return "execute"
}

function inferScope(text: string): Scope {
  if (keywords(text, ["后续", "以后", "默认", "每次", "习惯"])) return "user"
  if (keywords(text, ["repo", "repository", "project", "workspace", "仓库", "项目"])) return "repo"
  return "workspace"
}

function inferClassification(text: string): Classification {
  if (keywords(text, ["还要", "另外", "新增", "追加", "顺便", "除了", "also need", "in addition"])) {
    return "task_scope_change"
  }
  if (
    keywords(text, [
      "流程",
      "步骤",
      "然后",
      "之后",
      "后续",
      "提交",
      "推送",
      "触发",
      "构建",
      "验证",
      "发布",
      "交付",
      "workflow",
    ])
  ) {
    return "workflow_orchestration_completion"
  }
  if (
    keywords(text, [
      "gerrit",
      "jenkins",
      "api",
      "platform",
      "cli",
      "sdk",
      "internal tool",
      "内部平台",
      "工具",
      "命令",
      "平台",
    ])
  ) {
    return "tool_gap_completion"
  }
  if (
    keywords(text, [
      "格式",
      "规范",
      "必须",
      "禁止",
      "规则",
      "按照",
      "约束",
      "policy",
      "constraint",
      "approval",
      "commit message",
    ])
  ) {
    return "constraint_or_policy"
  }
  if (
    keywords(text, [
      "need",
      "needs",
      "missing",
      "required",
      "blocked",
      "waiting for",
      "缺少",
      "需要",
      "阻塞",
      "环境",
      "目录",
      "参数",
      "验收",
      "规则",
    ])
  ) {
    return "context_completion"
  }
  return "noise"
}

function inferNoise(text: string) {
  return keywords(text, [
    "thanks",
    "thank you",
    "hello",
    "hi",
    "在吗",
    "谢谢",
    "继续",
    "快点",
    "催一下",
    "ok",
    "好的",
  ])
}

function heuristicDecision(input: {
  candidate: Candidate
  runtimePhase: string
  nodeAgent?: string
}): AgentDecision {
  const text = input.candidate.text.trim()
  const classification = inferClassification(text)
  const related = classification !== "noise" && !inferNoise(text)
  const longTerm =
    related &&
    (classification === "tool_gap_completion" ||
      classification === "workflow_orchestration_completion" ||
      classification === "constraint_or_policy" ||
      keywords(text, ["后续", "以后", "默认", "每次", "统一", "长期", "仓库", "项目", "团队"]))

  const actions = lines(text).slice(0, 6)
  const toolHints = uniq(
    [
      ...(/gerrit/gi.test(text) ? ["gerrit"] : []),
      ...(/jenkins/gi.test(text) ? ["jenkins"] : []),
      ...(/git/gi.test(text) ? ["git"] : []),
    ].filter(Boolean),
  )

  return {
    related,
    classification: related ? classification : "noise",
    long_term_value: longTerm,
    reason: related ? "Matched reusable workflow signals from the candidate content" : "No durable workflow signal detected",
    task_type: defaultTaskType(text),
    workflow_context: {
      phase: inferPhase(text, input.runtimePhase),
      node_agent: input.nodeAgent,
      execution_scene: input.runtimePhase,
      prerequisites: uniq(
        keywords(text, ["权限", "permission", "credential", "token"]) ? ["Required access or credential must exist"] : [],
      ),
      environment: uniq(
        keywords(text, ["环境", "env", "目录", "workspace", "repo", "仓库"]) ? ["Environment-specific setup may apply"] : [],
      ),
    },
    problem_or_requirement: {
      summary: first(actions) ?? text.slice(0, 240),
      original_gap: classification === "context_completion" || classification === "tool_gap_completion" ? text.slice(0, 240) : undefined,
    },
    know_how: {
      summary: related ? (first(actions) ?? text.slice(0, 240)) : "No reusable know-how extracted",
      recommended_actions: classification === "noise" ? [] : actions,
      tool_hints: toolHints,
      skill_hints: uniq(toolHints.map((item) => `${item}-skill`)),
      platform_hints: toolHints,
      acceptance_hints: uniq(
        keywords(text, ["build", "compile", "构建", "编译"]) ? ["Build or compilation succeeds"] : [],
      ),
    },
    reusability: {
      scope: inferScope(text),
      merge_candidate: longTerm,
      skill_candidate: longTerm && ["tool_gap_completion", "workflow_orchestration_completion"].includes(classification),
    },
  }
}

async function chooseModel() {
  const chosen = await withTimeout(Provider.defaultModel().catch(() => undefined), 300)
  if (!chosen) return
  return (
    (await withTimeout(Provider.getSmallModel(chosen.providerID).catch(() => undefined), 300)) ??
    (await withTimeout(Provider.getModel(chosen.providerID, chosen.modelID).catch(() => undefined), 300))
  )
}

async function refineWithAgent(input: {
  candidate: Candidate
  snapshot: Awaited<ReturnType<typeof Workflow.get>>
  nodeAgent?: string
}) {
  const model = await chooseModel()
  if (!model) return
  const language = await Provider.getLanguage(model).catch(() => undefined)
  if (!language) return
  const auth = await Auth.get(model.providerID).catch(() => undefined)
  const cfg = await Config.get().catch(() => undefined)
  const isOpenaiOauth = model.providerID === "openai" && auth?.type === "oauth"
  const system = [PROMPT_REFINER]
  const messages = [
    ...(isOpenaiOauth
      ? []
      : system.map(
          (item): ModelMessage => ({
            role: "system",
            content: item,
          }),
        )),
    {
      role: "user" as const,
      content: JSON.stringify(
        {
          candidate: input.candidate,
          workflow: {
            id: input.snapshot.workflow.id,
            title: input.snapshot.workflow.title,
            status: input.snapshot.workflow.status,
            phase: input.snapshot.runtime.phase,
            active_node_id: input.snapshot.runtime.active_node_id,
            waiting_node_ids: input.snapshot.runtime.waiting_node_ids,
            failed_node_ids: input.snapshot.runtime.failed_node_ids,
          },
          node: input.snapshot.nodes.find((node) => node.id === input.candidate.node_id),
          recent_events: input.snapshot.events.slice(-8),
          node_agent_hint: input.nodeAgent,
        },
        null,
        2,
      ),
    },
  ]

  const params = {
    experimental_telemetry: {
      isEnabled: cfg?.experimental?.openTelemetry,
      metadata: {
        userId: cfg?.username ?? "unknown",
      },
    },
    temperature: 0.1,
    messages,
    model: language,
    schema: AgentDecision,
  } satisfies Parameters<typeof generateObject>[0]

  if (isOpenaiOauth) {
    const result = streamObject({
      ...params,
      providerOptions: ProviderTransform.providerOptions(model, {
        instructions: system.join("\n"),
        store: false,
      }),
      onError: () => {},
    })
    for await (const part of result.fullStream) {
      if (part.type === "error") throw part.error
    }
    return result.object
  }

  return (await generateObject(params)).object
}

async function settings() {
  const cfg = await Config.get().catch(() => undefined)
  const refiner = cfg?.experimental?.refiner
  const enabled = refiner?.enabled ?? true
  const modelAssisted = refiner?.model_assisted ?? false
  const base = refiner?.directory
    ? (path.isAbsolute(refiner.directory) ? refiner.directory : path.join(Instance.worktree, refiner.directory))
    : path.join(Instance.worktree, ".opencode", "refiner-memory")
  return { enabled, base, modelAssisted }
}

function relevantNode(snapshot: Awaited<ReturnType<typeof Workflow.get>>, nodeID?: string) {
  return (
    snapshot.nodes.find((node) => node.id === nodeID) ??
    snapshot.nodes.find((node) => node.id === snapshot.runtime.active_node_id) ??
    snapshot.nodes.find((node) => snapshot.runtime.failed_node_ids.includes(node.id)) ??
    snapshot.nodes.find((node) => snapshot.runtime.waiting_node_ids.includes(node.id))
  )
}

function pruneSnapshot(snapshot: Awaited<ReturnType<typeof Workflow.get>>) {
  return {
    workflow: snapshot.workflow,
    runtime: snapshot.runtime,
    nodes: snapshot.nodes.map((node) => ({
      id: node.id,
      title: node.title,
      agent: node.agent,
      status: node.status,
      result_status: node.result_status,
      fail_reason: node.fail_reason,
      attempt: node.attempt,
      action_count: node.action_count,
    })),
    events: snapshot.events.slice(-8),
  }
}

function fingerprint(record: {
  classification: Exclude<Classification, "noise">
  taskType: string
  phase: string
  nodeAgent?: string
  summary: string
  actions: string[]
}) {
  return Hash.fast(
    JSON.stringify([
      record.classification,
      record.taskType,
      record.phase,
      record.nodeAgent ?? "",
      record.summary.toLowerCase(),
      record.actions.slice(0, 3).map((item) => item.toLowerCase()),
    ]),
  )
}

function pendingKey(workflowID: string, nodeID?: string) {
  return `${workflowID}:${nodeID ?? "root"}`
}

function renderExperience(record: ExperienceRecord) {
  return [
    "# Workflow Experience",
    "",
    "## Summary",
    record.know_how.summary,
    "",
    "## Workflow Context",
    `- Task type: ${record.task_type}`,
    `- Phase: ${record.workflow_context.phase}`,
    record.workflow_context.node_agent ? `- Node agent: ${record.workflow_context.node_agent}` : "",
    record.workflow_context.execution_scene ? `- Execution scene: ${record.workflow_context.execution_scene}` : "",
    record.workflow_context.prerequisites.length ? `- Prerequisites: ${record.workflow_context.prerequisites.join("; ")}` : "",
    record.workflow_context.environment.length ? `- Environment: ${record.workflow_context.environment.join("; ")}` : "",
    "",
    "## Problem Or Requirement",
    record.problem_or_requirement.summary,
    record.problem_or_requirement.original_gap ? `Original gap: ${record.problem_or_requirement.original_gap}` : "",
    "",
    "## Know How",
    record.know_how.recommended_actions.length
      ? record.know_how.recommended_actions.map((item) => `- ${item}`).join("\n")
      : "- No action list extracted",
    record.know_how.tool_hints.length ? `Tool hints: ${record.know_how.tool_hints.join(", ")}` : "",
    record.know_how.skill_hints.length ? `Skill hints: ${record.know_how.skill_hints.join(", ")}` : "",
    record.know_how.acceptance_hints.length ? `Acceptance hints: ${record.know_how.acceptance_hints.join(", ")}` : "",
    "",
    "## Evidence",
    `- Evidence count: ${record.evidence.count}`,
    `- Success count: ${record.evidence.success_count}`,
    `- Failure count: ${record.evidence.failure_count}`,
    record.evidence.items
      .slice(-5)
      .map(
        (item) =>
          `- ${item.trigger_kind} at ${nowISO(item.observed_at)} on workflow ${item.workflow_id}${item.node_id ? ` / node ${item.node_id}` : ""} (${item.recovery_status})`,
      )
      .join("\n"),
    "",
  ]
    .filter(Boolean)
    .join("\n")
}

function renderInbox(input: {
  record: InboxRecord
  candidate: Candidate
  snapshot: Awaited<ReturnType<typeof Workflow.get>>
  decision: AgentDecision
}) {
  return [
    "# Refiner Inbox",
    "",
    "## Candidate",
    input.candidate.text || "(empty)",
    "",
    "## Decision",
    `- Related: ${input.record.related}`,
    `- Classification: ${input.record.classification}`,
    `- Long-term value: ${input.record.long_term_value}`,
    `- Reason: ${input.record.reason}`,
    "",
    "## Workflow Snapshot",
    "```json",
    JSON.stringify(pruneSnapshot(input.snapshot), null, 2),
    "```",
    "",
    "## Extracted Know How",
    "```json",
    JSON.stringify(input.decision, null, 2),
    "```",
    "",
  ].join("\n")
}

async function readMatter(filepath: string) {
  const raw = await Filesystem.readText(filepath)
  return matter(raw)
}

function cleanUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== undefined)
      .map((item) => cleanUndefined(item)) as T
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => {
        if (item === undefined) return []
        return [[key, cleanUndefined(item)]]
      }),
    ) as T
  }
  return value
}

async function writeMatter(filepath: string, data: Record<string, unknown>, content: string) {
  await Filesystem.write(filepath, matter.stringify(content, cleanUndefined(data)))
}

async function queuePendingExperience(workflowID: string, nodeID: string | undefined, filepath: string) {
  const current = state()
  const key = pendingKey(workflowID, nodeID)
  current.pending[key] = uniq([...(current.pending[key] ?? []), filepath])
}

async function markPendingSuccess(workflowID: string, nodeID: string | undefined, note: string) {
  const current = state()
  const keys = uniq([pendingKey(workflowID, nodeID), pendingKey(workflowID, undefined)])
  for (const key of keys) {
    const files = current.pending[key]
    if (!files?.length) continue
    delete current.pending[key]
    for (const file of files) {
      const doc = await readMatter(file).catch(() => undefined)
      if (!doc) continue
      const data = doc.data as ExperienceRecord
      const items = Array.isArray(data.evidence?.items) ? (data.evidence.items as EvidenceItem[]) : []
      let changed = false
      const nextItems = items.map((item) => {
        if (item.workflow_id !== workflowID) return item
        if (nodeID && item.node_id && item.node_id !== nodeID) return item
        if (item.recovery_status !== "pending") return item
        changed = true
        return {
          ...item,
          recovery_status: "success" as const,
          note,
        }
      })
      if (!changed) continue
      const successCount = nextItems.filter((item) => item.recovery_status === "success").length
      const failureCount = nextItems.filter((item) => item.recovery_status === "fail").length
      const next = {
        ...data,
        updated_at: nowISO(),
        evidence: {
          ...data.evidence,
          count: nextItems.length,
          success_count: successCount,
          failure_count: failureCount,
          repeated: nextItems.length > 1,
          items: nextItems.slice(-20),
        },
      } satisfies ExperienceRecord
      await writeMatter(file, next as unknown as Record<string, unknown>, renderExperience(next))
    }
  }
}

async function writeInbox(input: {
  candidate: Candidate
  snapshot: Awaited<ReturnType<typeof Workflow.get>>
  decision: AgentDecision
  experiencePath?: string
  experienceID?: string
}) {
  const cfg = await settings()
  const ts = input.candidate.observed_at
  const stamp = nowISO(ts).replace(/[:.]/g, "-")
  const id = `${stamp}-${Hash.fast(`${input.candidate.workflow_id}:${input.candidate.trigger_kind}:${input.candidate.text}`).slice(0, 8)}`
  const filepath = path.join(cfg.base, "inbox", nowISO(ts).slice(0, 10), `${id}.md`)
  const node = relevantNode(input.snapshot, input.candidate.node_id)
  const record: InboxRecord = {
    kind: "refiner_inbox",
    id,
    created_at: nowISO(ts),
    workflow_id: input.candidate.workflow_id,
    node_id: input.candidate.node_id,
    session_id: input.candidate.session_id,
    source_type: input.candidate.source_type,
    trigger_kind: input.candidate.trigger_kind,
    classification: input.decision.classification,
    related: input.decision.related,
    long_term_value: input.decision.long_term_value,
    reason: input.decision.reason,
    task_type: input.decision.task_type,
    workflow_phase: input.decision.workflow_context.phase,
    node_agent: node?.agent,
    experience_id: input.experienceID,
    experience_path: input.experiencePath ? rel(input.experiencePath) : undefined,
  }
  await writeMatter(filepath, record as unknown as Record<string, unknown>, renderInbox({ record, candidate: input.candidate, snapshot: input.snapshot, decision: input.decision }))
  return filepath
}

async function upsertExperience(input: {
  candidate: Candidate
  snapshot: Awaited<ReturnType<typeof Workflow.get>>
  decision: AgentDecision
}) {
  if (!input.decision.related || !input.decision.long_term_value || input.decision.classification === "noise") return
  const cfg = await settings()
  const node = relevantNode(input.snapshot, input.candidate.node_id)
  const taskType = slug(input.decision.task_type, "workflow-task")
  const phase = slug(input.decision.workflow_context.phase, "execute")
  const summary = input.decision.problem_or_requirement.summary.trim()
  const digest = fingerprint({
    classification: input.decision.classification,
    taskType,
    phase,
    nodeAgent: input.decision.workflow_context.node_agent ?? node?.agent,
    summary,
    actions: uniq(input.decision.know_how.recommended_actions),
  })
  const basename = `${slug(summary, "experience").slice(0, 40)}-${digest.slice(0, 8)}.md`
  const filepath = path.join(cfg.base, "experiences", taskType, phase, basename)
  const doc = await readMatter(filepath).catch(() => undefined)
  const ts = input.candidate.observed_at
  const evidence: EvidenceItem = {
    workflow_id: input.candidate.workflow_id,
    node_id: input.candidate.node_id,
    source_type: input.candidate.source_type,
    trigger_kind: input.candidate.trigger_kind,
    observed_at: ts,
    recovery_status:
      input.candidate.trigger_kind === "node.completed" ||
      (input.candidate.trigger_kind === "node.updated" && input.candidate.event_payload?.status === "completed")
        ? "success"
        : input.candidate.source_type === "slave"
          ? "pending"
          : "pending",
  }

  const existing = (doc?.data ?? {}) as Partial<ExperienceRecord>
  const items = uniq(
    [
      ...((existing.evidence?.items as EvidenceItem[] | undefined) ?? []).map((item) => JSON.stringify(item)),
      JSON.stringify(evidence),
    ],
  ).map((item) => JSON.parse(item) as EvidenceItem)

  const next: ExperienceRecord = {
    kind: "workflow_experience",
    id: digest,
    created_at: typeof existing.created_at === "string" ? existing.created_at : nowISO(ts),
    updated_at: nowISO(),
    task_type: input.decision.task_type,
    classification: input.decision.classification,
    related: true,
    long_term_value: true,
    workflow_context: {
      phase: input.decision.workflow_context.phase,
      node_agent: input.decision.workflow_context.node_agent ?? node?.agent,
      execution_scene: input.decision.workflow_context.execution_scene ?? input.snapshot.runtime.phase,
      prerequisites: uniq([
        ...((existing.workflow_context?.prerequisites as string[] | undefined) ?? []),
        ...uniq(input.decision.workflow_context.prerequisites),
      ]),
      environment: uniq([
        ...((existing.workflow_context?.environment as string[] | undefined) ?? []),
        ...uniq(input.decision.workflow_context.environment),
      ]),
    },
    problem_or_requirement: {
      summary,
      original_gap:
        input.decision.problem_or_requirement.original_gap ?? (existing.problem_or_requirement?.original_gap as string | undefined),
    },
    know_how: {
      summary: input.decision.know_how.summary,
      recommended_actions: uniq([
        ...((existing.know_how?.recommended_actions as string[] | undefined) ?? []),
        ...uniq(input.decision.know_how.recommended_actions),
      ]),
      tool_hints: uniq([
        ...((existing.know_how?.tool_hints as string[] | undefined) ?? []),
        ...uniq(input.decision.know_how.tool_hints),
      ]),
      skill_hints: uniq([
        ...((existing.know_how?.skill_hints as string[] | undefined) ?? []),
        ...uniq(input.decision.know_how.skill_hints),
      ]),
      platform_hints: uniq([
        ...((existing.know_how?.platform_hints as string[] | undefined) ?? []),
        ...uniq(input.decision.know_how.platform_hints),
      ]),
      acceptance_hints: uniq([
        ...((existing.know_how?.acceptance_hints as string[] | undefined) ?? []),
        ...uniq(input.decision.know_how.acceptance_hints),
      ]),
    },
    reusability: {
      scope: input.decision.reusability.scope,
      merge_candidate: input.decision.reusability.merge_candidate || Boolean(existing.reusability?.merge_candidate),
      skill_candidate: input.decision.reusability.skill_candidate || Boolean(existing.reusability?.skill_candidate),
    },
    evidence: {
      count: items.length,
      success_count: items.filter((item) => item.recovery_status === "success").length,
      failure_count: items.filter((item) => item.recovery_status === "fail").length,
      repeated: items.length > 1,
      items: items.slice(-20),
    },
  }
  await writeMatter(filepath, next as unknown as Record<string, unknown>, renderExperience(next))
  if (input.candidate.trigger_kind !== "node.completed") {
    await queuePendingExperience(input.candidate.workflow_id, input.candidate.node_id, filepath)
  }
  return { id: digest, filepath }
}

async function extractUserMessage(sessionID: SessionID, messageID: MessageID) {
  const message = MessageV2.get({ sessionID, messageID })
  if (message.info.role !== "user") return
  const text = message.parts
    .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text.trim()] : []))
    .filter(Boolean)
    .join("\n")
    .trim()
  if (!text) return
  const signature = Hash.fast(text)
  const current = state()
  if (current.userSeen[messageID] === signature) return
  current.userSeen[messageID] = signature
  return {
    text,
    info: message.info,
  }
}

function isInterestingEvent(event: Workflow.EventInfo) {
  if (event.kind === "node.control") return true
  if (["node.attempt_reported", "node.failed", "node.completed", "node.action_limit_reached", "node.attempt_limit_reached", "node.stalled"].includes(event.kind)) return true
  if (event.kind === "node.updated") {
    const status = typeof event.payload.status === "string" ? event.payload.status : undefined
    const result = typeof event.payload.result_status === "string" ? event.payload.result_status : undefined
    return ["waiting", "failed", "completed", "interrupted"].includes(status ?? "") || ["success", "fail", "partial"].includes(result ?? "")
  }
  return false
}

function eventText(event: Workflow.EventInfo) {
  if (event.kind === "node.control") {
    return [`Runtime command: ${event.payload.command ?? "unknown"}`, JSON.stringify(event.payload, null, 2)].filter(Boolean).join("\n\n")
  }
  if (event.kind === "node.attempt_reported") {
    return [
      typeof event.payload.summary === "string" ? event.payload.summary : "",
      ...(Array.isArray(event.payload.needs) ? event.payload.needs.map(String) : []),
      ...(Array.isArray(event.payload.errors)
        ? event.payload.errors.map((item) => {
            if (!item || typeof item !== "object") return String(item)
            return [item.source, item.reason].filter(Boolean).join(": ")
          })
        : []),
    ]
      .filter(Boolean)
      .join("\n")
  }
  return JSON.stringify(event.payload, null, 2)
}

async function observeCandidate(candidate: Candidate) {
  const cfg = await settings()
  if (!cfg.enabled) return
  const snapshot = await Workflow.get(candidate.workflow_id).catch(() => undefined)
  if (!snapshot) return
  const node = relevantNode(snapshot, candidate.node_id)
  let decision = heuristicDecision({
    candidate,
    runtimePhase: snapshot.runtime.phase,
    nodeAgent: node?.agent,
  })

  if (cfg.modelAssisted) {
    decision =
      (await refineWithAgent({
        candidate,
        snapshot,
        nodeAgent: node?.agent,
      }).catch((error) => {
        log.warn("refiner agent failed, falling back to heuristics", { error })
        return undefined
      })) ?? decision
  }

  if (!decision.related && candidate.source_type !== "user") {
    decision = {
      ...decision,
      related: true,
      classification: decision.classification === "noise" ? "context_completion" : decision.classification,
      long_term_value: candidate.source_type !== "slave" ? decision.long_term_value : true,
    }
  }

  const experience = await upsertExperience({ candidate, snapshot, decision })
  const inboxPath = await writeInbox({
    candidate,
    snapshot,
    decision,
    experienceID: experience?.id,
    experiencePath: experience?.filepath,
  })
  if (experience?.filepath) {
    const doc = await readMatter(experience.filepath).catch(() => undefined)
    if (doc) {
      const data = doc.data as ExperienceRecord
      const nextItems = data.evidence.items.map((item) =>
        item.workflow_id === candidate.workflow_id &&
          item.trigger_kind === candidate.trigger_kind &&
          item.observed_at === candidate.observed_at &&
          item.source_type === candidate.source_type
          ? {
              ...item,
              inbox_path: rel(inboxPath),
            }
          : item,
      )
      const next = {
        ...data,
        evidence: {
          ...data.evidence,
          items: nextItems,
        },
      } satisfies ExperienceRecord
      await writeMatter(experience.filepath, next as unknown as Record<string, unknown>, renderExperience(next))
    }
  }
}

export namespace Refiner {
  export const DecisionSchema = AgentDecision
  export const ClassificationSchema = Classification

  export function classifyHeuristically(input: { text: string; runtimePhase?: string; nodeAgent?: string }) {
    return heuristicDecision({
      candidate: {
        source_type: "user",
        workflow_id: "workflow",
        trigger_kind: "user.message",
        observed_at: Date.now(),
        text: input.text,
      },
      runtimePhase: input.runtimePhase ?? "execute",
      nodeAgent: input.nodeAgent,
    })
  }

  export async function observeUserMessage(input: { sessionID: SessionID; messageID: MessageID }) {
    const extracted = await extractUserMessage(input.sessionID, input.messageID).catch(() => undefined)
    if (!extracted) return
    const workflow = await Workflow.bySession(input.sessionID).catch(() => undefined)
    if (!workflow) return
    await observeCandidate({
      source_type: "user",
      workflow_id: workflow.workflow.id,
      session_id: input.sessionID,
      node_id: relevantNode(workflow)?.id,
      trigger_kind: "user.message",
      observed_at: extracted.info.time.created,
      text: extracted.text,
    })
  }

  export async function observeWorkflowEvent(event: Workflow.EventInfo) {
    if (!isInterestingEvent(event)) return
    const current = state()
    const seenKey = `${event.workflow_id}:${event.id}:${event.kind}`
    if (current.eventSeen[seenKey]) return
    current.eventSeen[seenKey] = true

    const source_type: CandidateSourceType =
      event.kind === "node.control" || event.source === "orchestrator" ? "master" : "slave"

    await observeCandidate({
      source_type,
      workflow_id: event.workflow_id,
      session_id: event.session_id,
      node_id: event.node_id,
      trigger_kind: event.kind,
      observed_at: event.time_created,
      text: eventText(event),
      event_payload: event.payload,
    })

    const status = typeof event.payload.status === "string" ? event.payload.status : undefined
    const result = typeof event.payload.result_status === "string" ? event.payload.result_status : undefined
    if (event.kind === "node.completed" || status === "completed" || result === "success") {
      await markPendingSuccess(event.workflow_id, event.node_id, "Later workflow observation marked this case as recovered successfully")
    }
  }
}
