import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"

/**
 * Refiner curator tools — the precise toolset the `refiner-curator`
 * agent uses to walk through the experience library with the user.
 *
 * Each tool is a thin wrapper over an existing Refiner namespace
 * function. The wrappers exist so the curator agent's permission map
 * can name them individually (and `*: deny` blocks everything else)
 * without exposing the entire experimental REST surface as agent-
 * callable. Lazy-import the refiner module so the tool registry
 * doesn't pull its graph traversal at startup.
 */

const format = (value: unknown) => JSON.stringify(value, null, 2)

// ── refiner_list_experiences ───────────────────────────────────────

const ListParameters = z.object({
  /** Cap the size of returned payload — agent typically only needs the
   *  freshest N; setting too high inflates context. */
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(200)
    .describe("最多返回多少条经验，按 last_refined_at 倒序裁剪。默认 200。"),
  /** Filter by kind. Useful when the agent is processing one bucket at
   *  a time (e.g. all workflow_rule first). */
  kind: z
    .string()
    .optional()
    .describe("可选：只返回指定 kind（如 workflow_rule / know_how）。省略 = 全部。"),
})

export const RefinerListExperiencesTool = Tool.define(
  "refiner_list_experiences",
  Effect.gen(function* () {
    return {
      description:
        "拉取活跃 experience 库的紧凑投影。每条返回 id / kind / title / abstract / scope / categories / observation_count / conflicts_with / last_refined_at。不包含完整 observations 文本，避免占用上下文。",
      parameters: ListParameters,
      execute: (params: z.infer<typeof ListParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const { Refiner } = yield* Effect.promise(() => import("../refiner"))
          const all = yield* Effect.promise(() => Refiner.experiences())
          const filtered = params.kind ? all.filter((e: { kind: string }) => e.kind === params.kind) : all
          const sorted = [...filtered].sort(
            (a: { last_refined_at?: number }, b: { last_refined_at?: number }) =>
              (b.last_refined_at ?? 0) - (a.last_refined_at ?? 0),
          )
          const limited = sorted.slice(0, params.limit)
          const compact = limited.map((e: {
            id: string
            kind: string
            title: string
            abstract: string
            scope: string
            categories?: string[]
            conflicts_with?: string[]
            observations: unknown[]
            last_refined_at?: number
          }) => ({
            id: e.id,
            kind: e.kind,
            title: e.title,
            abstract: e.abstract,
            scope: e.scope,
            categories: e.categories ?? [],
            conflicts_with: e.conflicts_with ?? [],
            observation_count: e.observations.length,
            last_refined_at: e.last_refined_at,
          }))
          return {
            title: `refiner_list: ${compact.length} of ${all.length} experiences`,
            metadata: {
              total_active: all.length,
              returned: compact.length,
              filtered_by_kind: params.kind,
            },
            output: format({ count: compact.length, total: all.length, experiences: compact }),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ── refiner_merge ──────────────────────────────────────────────────

const MergeParameters = z.object({
  ids: z
    .array(z.string())
    .min(2)
    .describe("要合并的 experience id 列表（至少 2 个）。"),
  keep: z.string().describe("合并后保留的主 id，其余被并入主 id 后删除。必须在 ids 列表里。"),
  reason: z.string().describe("简体中文 1 句话说明为什么这些可以合并（用户已确认）。"),
})

export const RefinerMergeTool = Tool.define(
  "refiner_merge",
  Effect.gen(function* () {
    return {
      description:
        "合并 2 条或以上 experience。所有 observations 会被搬到 `keep` 指定的主 id 上，其余 experience 删除。仅在用户通过 question 卡片明确同意后再调。",
      parameters: MergeParameters,
      execute: (params: z.infer<typeof MergeParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.ids.includes(params.keep)) {
            return {
              title: "refiner_merge refused",
              metadata: {
                ok: false,
                ids: params.ids,
                keep: params.keep,
                reason: "keep_not_in_ids",
              },
              output: format({ ok: false, error: "keep id 必须在 ids 列表里" }),
            }
          }
          const { Refiner } = yield* Effect.promise(() => import("../refiner"))
          const result = yield* Effect.promise(() =>
            Refiner.mergeExperiences({
              ids: params.ids,
              reason: `curator: ${params.reason.slice(0, 200)}`,
            }),
          )
          return {
            title: `refiner_merge: ${params.ids.length} → 1`,
            metadata: {
              ok: (result as { ok?: boolean }).ok !== false,
              ids: params.ids,
              keep: params.keep,
              reason: "ok",
            },
            output: format(result),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ── refiner_delete ─────────────────────────────────────────────────

const DeleteParameters = z.object({
  id: z.string(),
  reason: z.string().describe("简体中文 1 句话说明删除原因（用户已确认）。"),
  cascade_observations: z
    .boolean()
    .default(true)
    .describe("是否级联删除该 experience 的所有 observation 文件（一般为 true）。"),
})

export const RefinerDeleteTool = Tool.define(
  "refiner_delete",
  Effect.gen(function* () {
    return {
      description:
        "删除一条 experience。在用户通过 question 卡片明确同意后再调。会同时记录到 deleted.ndjson 审计。",
      parameters: DeleteParameters,
      execute: (params: z.infer<typeof DeleteParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const { Refiner } = yield* Effect.promise(() => import("../refiner"))
          const result = yield* Effect.promise(() =>
            Refiner.deleteExperience(params.id, {
              cascadeObservations: params.cascade_observations,
              reason: `curator: ${params.reason.slice(0, 200)}`,
            }),
          )
          return {
            title: `refiner_delete: ${params.id}`,
            metadata: { id: params.id, ok: result.ok },
            output: format(result),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ── refiner_update_categories ──────────────────────────────────────

const UpdateCategoriesParameters = z.object({
  id: z.string(),
  categories: z
    .array(z.string())
    .describe(
      "新的 categories 数组（0–4 个 kebab-case slug，支持两级 `parent/child`）。替换原数组，不是合并。",
    ),
  reason: z.string().describe("简体中文说明为什么改这些标签（用户已确认）。"),
})

export const RefinerUpdateCategoriesTool = Tool.define(
  "refiner_update_categories",
  Effect.gen(function* () {
    return {
      description:
        "修改一条 experience 的 categories 标签。用于整理标签层次：合并近义标签、补全缺失标签、规范命名。",
      parameters: UpdateCategoriesParameters,
      execute: (params: z.infer<typeof UpdateCategoriesParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const { Refiner } = yield* Effect.promise(() => import("../refiner"))
          const result = yield* Effect.promise(() =>
            Refiner.patchExperience({
              id: params.id,
              categories: params.categories,
            }),
          )
          return {
            title: `refiner_update_categories: ${params.id}`,
            metadata: {
              id: params.id,
              categories: params.categories,
              ok: (result as { ok?: boolean }).ok !== false,
              reason: params.reason,
            },
            output: format(result),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ── refiner_update_scope ───────────────────────────────────────────

const UpdateScopeParameters = z.object({
  id: z.string(),
  scope: z.enum(["workspace", "project", "repo", "user"]).describe("新的 scope。"),
  reason: z.string().describe("简体中文说明为什么改 scope（用户已确认）。"),
})

export const RefinerUpdateScopeTool = Tool.define(
  "refiner_update_scope",
  Effect.gen(function* () {
    return {
      description:
        "修改一条 experience 的 scope。user = 个人偏好；workspace = 跨项目通用；project = 单 project 专用；repo = 单仓库专用。",
      parameters: UpdateScopeParameters,
      execute: (params: z.infer<typeof UpdateScopeParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const { Refiner } = yield* Effect.promise(() => import("../refiner"))
          const result = yield* Effect.promise(() =>
            Refiner.patchExperience({
              id: params.id,
              scope: params.scope,
            }),
          )
          return {
            title: `refiner_update_scope: ${params.id} → ${params.scope}`,
            metadata: {
              id: params.id,
              scope: params.scope,
              ok: (result as { ok?: boolean }).ok !== false,
              reason: params.reason,
            },
            output: format(result),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ── refiner_re_refine ──────────────────────────────────────────────

const ReRefineParameters = z.object({
  id: z.string(),
  reason: z.string().describe("简体中文说明为什么要重新提炼（如：abstract 已过时、用户想看一次新表述）。"),
})

export const RefinerReRefineTool = Tool.define(
  "refiner_re_refine",
  Effect.gen(function* () {
    return {
      description:
        "对一条已有 experience 触发重新提炼。底层会让 LLM 用当前的 prompt + 全部 observations 重写 title / abstract / statement。仅在用户明确同意后调。",
      parameters: ReRefineParameters,
      execute: (params: z.infer<typeof ReRefineParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const { Refiner } = yield* Effect.promise(() => import("../refiner"))
          const result = yield* Effect.promise(() => Refiner.reRefine(params.id))
          return {
            title: `refiner_re_refine: ${params.id}`,
            metadata: { id: params.id, ok: (result as { ok?: boolean }).ok !== false, reason: params.reason },
            output: format(result),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
