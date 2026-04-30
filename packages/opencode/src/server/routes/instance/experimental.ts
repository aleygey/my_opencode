import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { ProviderID, ModelID } from "@/provider/schema"
import { ToolRegistry } from "@/tool"
import { Worktree } from "@/worktree"
import { Instance } from "@/project/instance"
import { Project } from "@/project"
import { MCP } from "@/mcp"
import { Session } from "@/session"
import { Config } from "@/config"
import { ConsoleState } from "@/config/console-state"
import { Account } from "@/account/account"
import { AccountID, OrgID } from "@/account/schema"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"
import { Effect, Option } from "effect"
import { Agent } from "@/agent/agent"
import { Refiner } from "@/refiner"
// Retrieve is intentionally lazy-imported at the call sites below.
// Reason: pulling `@/retrieve` into the static module graph (via a top-level
// `import { Retrieve } from "@/retrieve"`) deadlocks `bun --compile`'s
// startup-time module loader, producing a 100% CPU spin in stripped binary
// frames before the HTTP server ever binds. The module body has no top-level
// side effects — it's purely the AOT bundler's chunk-init ordering that
// breaks. See commit message + git bisect at 54d99fb9f for the regression
// trail. DO NOT promote this to a static import without re-verifying the
// AOT smoke test (`script/build.ts` boots `serve` and probes a route).
import { jsonRequest, runRequest } from "./trace"

const loadRetrieve = () => import("@/retrieve").then((m) => m.Retrieve)

const ConsoleOrgOption = z.object({
  accountID: z.string(),
  accountEmail: z.string(),
  accountUrl: z.string(),
  orgID: z.string(),
  orgName: z.string(),
  active: z.boolean(),
})

const ConsoleOrgList = z.object({
  orgs: z.array(ConsoleOrgOption),
})

const ConsoleSwitchBody = z.object({
  accountID: z.string(),
  orgID: z.string(),
})

export const ExperimentalRoutes = lazy(() =>
  new Hono()
    .get(
      "/console",
      describeRoute({
        summary: "Get active Console provider metadata",
        description: "Get the active Console org name and the set of provider IDs managed by that Console org.",
        operationId: "experimental.console.get",
        responses: {
          200: {
            description: "Active Console provider metadata",
            content: {
              "application/json": {
                schema: resolver(ConsoleState.zod),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("ExperimentalRoutes.console.get", c, function* () {
          const config = yield* Config.Service
          const account = yield* Account.Service
          const [state, groups] = yield* Effect.all([config.getConsoleState(), account.orgsByAccount()], {
            concurrency: "unbounded",
          })
          return {
            ...state,
            switchableOrgCount: groups.reduce((count, group) => count + group.orgs.length, 0),
          }
        }),
    )
    .get(
      "/console/orgs",
      describeRoute({
        summary: "List switchable Console orgs",
        description: "Get the available Console orgs across logged-in accounts, including the current active org.",
        operationId: "experimental.console.listOrgs",
        responses: {
          200: {
            description: "Switchable Console orgs",
            content: {
              "application/json": {
                schema: resolver(ConsoleOrgList),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("ExperimentalRoutes.console.listOrgs", c, function* () {
          const account = yield* Account.Service
          const [groups, active] = yield* Effect.all([account.orgsByAccount(), account.active()], {
            concurrency: "unbounded",
          })
          const info = Option.getOrUndefined(active)
          const orgs = groups.flatMap((group) =>
            group.orgs.map((org) => ({
              accountID: group.account.id,
              accountEmail: group.account.email,
              accountUrl: group.account.url,
              orgID: org.id,
              orgName: org.name,
              active: !!info && info.id === group.account.id && info.active_org_id === org.id,
            })),
          )
          return { orgs }
        }),
    )
    .post(
      "/console/switch",
      describeRoute({
        summary: "Switch active Console org",
        description: "Persist a new active Console account/org selection for the current local OpenCode state.",
        operationId: "experimental.console.switchOrg",
        responses: {
          200: {
            description: "Switch success",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      validator("json", ConsoleSwitchBody),
      async (c) =>
        jsonRequest("ExperimentalRoutes.console.switchOrg", c, function* () {
          const body = c.req.valid("json")
          const account = yield* Account.Service
          yield* account.use(AccountID.make(body.accountID), Option.some(OrgID.make(body.orgID)))
          return true
        }),
    )
    .get(
      "/refiner/overview",
      describeRoute({
        summary: "Get refiner overview",
        description:
          "Get refiner status, model, distilled experiences, their attached observations, and graph relations for the current session or workflow.",
        operationId: "experimental.refiner.overview.get",
        responses: {
          200: {
            description: "Refiner overview",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), z.unknown())),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          session_id: z.string().optional(),
          workflow_id: z.string().optional(),
          limit: z.coerce.number().optional(),
          include_archived: z.coerce.boolean().optional(),
          scope: z.enum(["all", "session", "workflow"]).optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        return c.json(
          await Refiner.overview({
            sessionID: query.session_id,
            workflowID: query.workflow_id,
            limit: query.limit ?? 40,
            includeArchived: query.include_archived,
            scope: query.scope,
          }),
        )
      },
    )
    .get(
      "/refiner/experience/:id",
      describeRoute({
        summary: "Get refiner experience detail",
        description: "Fetch a single distilled experience with all attached observations and refinement history.",
        operationId: "experimental.refiner.experience.get",
        responses: {
          200: {
            description: "Refiner experience",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), z.unknown())),
              },
            },
          },
          ...errors(400),
        },
      }),
      async (c) => {
        const id = c.req.param("id")
        const exp = await Refiner.experienceByID(id)
        if (!exp) return c.json({ error: "not_found", id }, 404)
        return c.json(exp)
      },
    )
    .get(
      "/refiner/taxonomy",
      describeRoute({
        summary: "Get refiner taxonomy",
        description: "List refiner experience kinds: the 7 core kinds plus any dynamically discovered custom kinds.",
        operationId: "experimental.refiner.taxonomy.get",
        responses: {
          200: {
            description: "Refiner taxonomy",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), z.unknown())),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Refiner.taxonomy())
      },
    )
    .get(
      "/refiner/stats",
      describeRoute({
        summary: "Get per-experience usage statistics",
        description:
          "Per-experience injection / usage counters. `injected.by_tier` separates baseline / topical / recall sources. `used.cited` is the refiner judge's count of times the agent applied the experience; `used.recalled` is the count of voluntary `recall_experience` tool calls that returned this experience. Single JSON dict keyed by experience id.",
        operationId: "experimental.refiner.stats.get",
        responses: {
          200: {
            description: "Per-experience usage stats",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), z.unknown())),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Refiner.usageStats())
      },
    )
    .get(
      "/retrieve/log",
      describeRoute({
        summary: "Get retrieve injection log",
        description:
          "List retrieve agent audit log entries — what experiences were injected into agent system prompts, when, and why. Newest first.",
        operationId: "experimental.retrieve.log.list",
        responses: {
          200: {
            description: "Retrieve log entries",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), z.unknown())),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          session_id: z.string().optional(),
          limit: z.coerce.number().optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const Retrieve = await loadRetrieve()
        const entries = await Retrieve.listLog({
          sessionID: query.session_id,
          limit: query.limit ?? 100,
        })
        return c.json({ entries })
      },
    )
    .post(
      "/retrieve/preview",
      describeRoute({
        summary: "Dry-run retrieve preview",
        description:
          "Run the retrieve pipeline without persisting state or advancing the turn index. Returns what WOULD be injected if a turn started now with the given user_text.",
        operationId: "experimental.retrieve.preview",
        responses: {
          200: {
            description: "Retrieve preview",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), z.unknown())),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          session_id: z.string(),
          agent_name: z.string().default("build"),
          user_text: z.string().optional(),
          workflow_id: z.string().optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const Retrieve = await loadRetrieve()
        const preview = await Retrieve.preview({
          sessionID: body.session_id,
          agentName: body.agent_name,
          userText: body.user_text,
          workflowID: body.workflow_id,
        })
        return c.json(preview)
      },
    )
    .get(
      "/retrieve/config",
      describeRoute({
        summary: "Get retrieve config",
        description:
          "Get the retrieve agent's currently resolved model plus its source (runtime override, agent config, or provider default) and any persisted override.",
        operationId: "experimental.retrieve.config.get",
        responses: {
          200: {
            description: "Retrieve config",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), z.unknown())),
              },
            },
          },
        },
      }),
      async (c) => {
        const Retrieve = await loadRetrieve()
        return c.json(await Retrieve.config())
      },
    )
    .put(
      "/retrieve/config",
      describeRoute({
        summary: "Update retrieve config",
        description:
          "Persist a runtime override for the retrieve agent's model (and optional temperature). Pass `model: null` to clear the override. Lets the retrieve frontend page swap to a small/fast model without restarting opencode.",
        operationId: "experimental.retrieve.config.update",
        responses: {
          200: {
            description: "Updated retrieve config",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), z.unknown())),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          model: z
            .union([
              z.object({
                providerID: z.string().min(1),
                modelID: z.string().min(1),
              }),
              z.null(),
            ])
            .optional(),
          temperature: z.union([z.number().min(0).max(2), z.null()]).optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const Retrieve = await loadRetrieve()
        return c.json(await Retrieve.setConfig(body))
      },
    )
    .get(
      "/refiner/config",
      describeRoute({
        summary: "Get refiner config",
        description:
          "Get the refiner agent's currently resolved model plus its source (runtime override, agent config, or provider default) and any persisted override.",
        operationId: "experimental.refiner.config.get",
        responses: {
          200: {
            description: "Refiner config",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), z.unknown())),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Refiner.config())
      },
    )
    .put(
      "/refiner/config",
      describeRoute({
        summary: "Update refiner config",
        description:
          "Persist a runtime override for the refiner agent's model (and optional temperature). Pass `model: null` to clear the override.",
        operationId: "experimental.refiner.config.update",
        responses: {
          200: {
            description: "Updated refiner config",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), z.unknown())),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          model: z
            .union([
              z.object({
                providerID: z.string().min(1),
                modelID: z.string().min(1),
              }),
              z.null(),
            ])
            .optional(),
          temperature: z.union([z.number().min(0).max(2), z.null()]).optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        return c.json(await Refiner.setConfig(body))
      },
    )
    .get(
      "/refiner/categories",
      describeRoute({
        summary: "List refiner categories",
        description:
          "Return the auto-maintained category index (category slug → experience IDs + count).",
        operationId: "experimental.refiner.categories.list",
        responses: {
          200: {
            description: "Categories",
            content: { "application/json": { schema: resolver(z.record(z.string(), z.unknown())) } },
          },
        },
      }),
      async (c) => {
        return c.json(await Refiner.categories())
      },
    )
    .delete(
      "/refiner/experience/:id",
      describeRoute({
        summary: "Delete experience",
        description:
          "Delete an experience (cascade-remove its attached observations by default) and append a deleted.ndjson audit entry.",
        operationId: "experimental.refiner.experience.delete",
        responses: {
          200: {
            description: "Deletion result",
            content: { "application/json": { schema: resolver(z.record(z.string(), z.unknown())) } },
          },
          ...errors(400),
        },
      }),
      validator(
        "query",
        z.object({
          cascade: z.coerce.boolean().optional(),
          reason: z.string().optional(),
        }),
      ),
      async (c) => {
        const id = c.req.param("id")
        const q = c.req.valid("query")
        const result = await Refiner.deleteExperience(id, {
          cascadeObservations: q.cascade ?? true,
          reason: q.reason,
        })
        if (!result.ok) return c.json({ error: result.error, id }, 404)
        return c.json(result)
      },
    )
    .post(
      "/refiner/experience/:id/archive",
      describeRoute({
        summary: "Archive experience",
        description: "Flag an experience as archived; overview hides archived experiences by default.",
        operationId: "experimental.refiner.experience.archive",
        responses: {
          200: {
            description: "Archive result",
            content: { "application/json": { schema: resolver(z.record(z.string(), z.unknown())) } },
          },
          ...errors(400),
        },
      }),
      validator("json", z.object({ archived: z.boolean() })),
      async (c) => {
        const id = c.req.param("id")
        const { archived } = c.req.valid("json")
        const result = await Refiner.setArchived(id, archived)
        if (!result.ok) return c.json({ error: result.error, id }, 404)
        return c.json(result)
      },
    )
    .post(
      "/refiner/experience/:id/review",
      describeRoute({
        summary: "Set experience review status",
        description:
          "Move an experience between pending/approved/rejected. Auto-routed experiences land as 'pending' until the user approves them; 'rejected' is a soft delete preserved for audit.",
        operationId: "experimental.refiner.experience.review",
        responses: {
          200: {
            description: "Updated experience",
            content: { "application/json": { schema: resolver(z.record(z.string(), z.unknown())) } },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({ status: z.enum(["pending", "approved", "rejected"]) }),
      ),
      async (c) => {
        const id = c.req.param("id")
        const { status } = c.req.valid("json")
        const result = await Refiner.setReviewStatus(id, status)
        if (!result.ok) return c.json({ error: result.error, id }, 404)
        return c.json(result)
      },
    )
    .post(
      "/refiner/experience/:id/observation",
      describeRoute({
        summary: "Augment experience (add observation + re-refine)",
        description:
          "Attach a user-supplied observation to an existing experience and trigger a fresh refinement.",
        operationId: "experimental.refiner.experience.augment",
        responses: {
          200: {
            description: "Augmented experience",
            content: { "application/json": { schema: resolver(z.record(z.string(), z.unknown())) } },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          user_text: z.string().min(1),
          note: z.string().optional(),
        }),
      ),
      async (c) => {
        const id = c.req.param("id")
        const body = c.req.valid("json")
        const result = await Refiner.augmentExperience({
          id,
          user_text: body.user_text,
          note: body.note,
        })
        if (!result.ok) return c.json({ error: result.error, id }, 400)
        return c.json(result)
      },
    )
    .post(
      "/refiner/experience",
      describeRoute({
        summary: "Create experience (agent-assisted)",
        description:
          "Create a new experience from a free-text prompt. The refiner LLM derives title/abstract/kind/categories.",
        operationId: "experimental.refiner.experience.create",
        responses: {
          200: {
            description: "Created experience",
            content: { "application/json": { schema: resolver(z.record(z.string(), z.unknown())) } },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          user_text: z.string().min(1),
          kind_hint: z.string().optional(),
          scope_hint: z.enum(["workspace", "project", "repo", "user"]).optional(),
          task_type_hint: z.string().optional(),
          note: z.string().optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const result = await Refiner.createExperienceFromText({
          user_text: body.user_text,
          kind_hint: body.kind_hint as any,
          scope_hint: body.scope_hint,
          task_type_hint: body.task_type_hint,
          note: body.note,
        })
        if (!result.ok) return c.json({ error: result.error }, 400)
        return c.json(result)
      },
    )
    .patch(
      "/refiner/experience/:id",
      describeRoute({
        summary: "Manually edit experience (no LLM)",
        description:
          "Patch title/abstract/statement/scope/task_type/categories in place. Records a manual_edit refinement history entry with a snapshot for undo.",
        operationId: "experimental.refiner.experience.patch",
        responses: {
          200: {
            description: "Patched experience",
            content: { "application/json": { schema: resolver(z.record(z.string(), z.unknown())) } },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          title: z.string().optional(),
          abstract: z.string().optional(),
          statement: z.union([z.string(), z.null()]).optional(),
          trigger_condition: z.union([z.string(), z.null()]).optional(),
          task_type: z.union([z.string(), z.null()]).optional(),
          scope: z.enum(["workspace", "project", "repo", "user"]).optional(),
          categories: z.array(z.string()).optional(),
        }),
      ),
      async (c) => {
        const id = c.req.param("id")
        const body = c.req.valid("json")
        const result = await Refiner.patchExperience({ id, ...body })
        if (!result.ok) return c.json({ error: result.error, id }, 404)
        return c.json(result)
      },
    )
    .post(
      "/refiner/experience/:id/refine",
      describeRoute({
        summary: "Re-refine experience",
        description: "Re-run the refiner LLM on an experience's existing observations without adding new ones.",
        operationId: "experimental.refiner.experience.reRefine",
        responses: {
          200: {
            description: "Re-refined experience",
            content: { "application/json": { schema: resolver(z.record(z.string(), z.unknown())) } },
          },
          ...errors(400),
        },
      }),
      async (c) => {
        const id = c.req.param("id")
        const result = await Refiner.reRefine(id)
        if (!result.ok) return c.json({ error: result.error, id }, 400)
        return c.json(result)
      },
    )
    .post(
      "/refiner/experience/:id/undo-refinement",
      describeRoute({
        summary: "Undo last refinement",
        description: "Restore an experience to the snapshot recorded in its most recent refinement_history entry.",
        operationId: "experimental.refiner.experience.undoRefinement",
        responses: {
          200: {
            description: "Restored experience",
            content: { "application/json": { schema: resolver(z.record(z.string(), z.unknown())) } },
          },
          ...errors(400),
        },
      }),
      async (c) => {
        const id = c.req.param("id")
        const result = await Refiner.undoRefinement(id)
        if (!result.ok) return c.json({ error: result.error, id }, 400)
        return c.json(result)
      },
    )
    .delete(
      "/refiner/experience/:experience_id/observation/:observation_id",
      describeRoute({
        summary: "Delete observation",
        description: "Remove a single observation from an experience; auto-archives the experience if it was the last one.",
        operationId: "experimental.refiner.observation.delete",
        responses: {
          200: {
            description: "Delete result",
            content: { "application/json": { schema: resolver(z.record(z.string(), z.unknown())) } },
          },
          ...errors(400),
        },
      }),
      async (c) => {
        const result = await Refiner.deleteObservation({
          experience_id: c.req.param("experience_id"),
          observation_id: c.req.param("observation_id"),
        })
        if (!result.ok) return c.json({ error: result.error }, 404)
        return c.json(result)
      },
    )
    .post(
      "/refiner/observation/move",
      describeRoute({
        summary: "Move observation between experiences",
        description: "Detach an observation from one experience and re-attach it (with re-refine) to another.",
        operationId: "experimental.refiner.observation.move",
        responses: {
          200: {
            description: "Move result",
            content: { "application/json": { schema: resolver(z.record(z.string(), z.unknown())) } },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          observation_id: z.string().min(1),
          from_experience_id: z.string().min(1),
          to_experience_id: z.string().min(1),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const result = await Refiner.moveObservation(body)
        if (!result.ok) return c.json({ error: result.error }, 400)
        return c.json(result)
      },
    )
    .post(
      "/refiner/experience/merge",
      describeRoute({
        summary: "Merge experiences",
        description:
          "Combine multiple experiences into a new one (LLM re-synthesizes title/abstract/statement); source experiences are archived and merge audit is recorded.",
        operationId: "experimental.refiner.experience.merge",
        responses: {
          200: {
            description: "Merged experience",
            content: { "application/json": { schema: resolver(z.record(z.string(), z.unknown())) } },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          ids: z.array(z.string().min(1)).min(2),
          reason: z.string().optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const result = await Refiner.mergeExperiences(body)
        if (!result.ok) return c.json({ error: result.error }, 400)
        return c.json(result)
      },
    )
    .get(
      "/refiner/graph",
      describeRoute({
        summary: "Get refiner chain graph",
        description:
          "Return every experience (id, kind, title, abstract, archived) along with every edge in the chain graph. Drives the top-level Graph tab in the UI.",
        operationId: "experimental.refiner.graph.get",
        responses: {
          200: {
            description: "Chain graph",
            content: { "application/json": { schema: resolver(z.record(z.string(), z.unknown())) } },
          },
        },
      }),
      validator(
        "query",
        z.object({
          include_archived: z.coerce.boolean().optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const overview = await Refiner.overview({
          limit: 10000,
          includeArchived: query.include_archived ?? false,
          scope: "all",
        })
        const edges = await Refiner.listEdges()
        return c.json({
          experiences: overview.experiences.map((exp) => ({
            id: exp.id,
            kind: exp.kind,
            title: exp.title,
            abstract: exp.abstract,
            task_type: exp.task_type,
            scope: exp.scope,
            categories: exp.categories,
            archived: !!exp.archived,
            review_status: exp.review_status,
            reviewed_at: exp.reviewed_at,
            observation_count: exp.observations.length,
            last_refined_at: exp.last_refined_at,
          })),
          edges,
        })
      },
    )
    .get(
      "/refiner/experience/:id/neighbors",
      describeRoute({
        summary: "Get experience neighbors",
        description:
          "BFS traversal around a seed experience in the chain graph. Defaults to requires+refines edges, both directions, depth 2.",
        operationId: "experimental.refiner.experience.neighbors",
        responses: {
          200: {
            description: "Neighbor subgraph",
            content: { "application/json": { schema: resolver(z.record(z.string(), z.unknown())) } },
          },
          ...errors(400),
        },
      }),
      validator(
        "query",
        z.object({
          edge_kinds: z.string().optional(), // comma-separated list
          direction: z.enum(["in", "out", "both"]).optional(),
          max_depth: z.coerce.number().min(1).max(5).optional(),
        }),
      ),
      async (c) => {
        const id = c.req.param("id")
        const query = c.req.valid("query")
        const exp = await Refiner.experienceByID(id)
        if (!exp) return c.json({ error: "not_found", id }, 404)
        const kinds = query.edge_kinds
          ? (query.edge_kinds.split(",").map((s) => s.trim()).filter(Boolean) as Array<
              "requires" | "refines" | "supports" | "contradicts" | "see_also"
            >)
          : undefined
        return c.json(
          await Refiner.neighbors({
            id,
            edge_kinds: kinds,
            direction: query.direction,
            max_depth: query.max_depth,
          }),
        )
      },
    )
    .post(
      "/refiner/edge",
      describeRoute({
        summary: "Create chain edge",
        description:
          "Manually insert a directed edge between two experiences. Applies the same dedup / self-loop / cycle-check pipeline as the LLM route batch; cycles on `requires`/`refines` are downgraded.",
        operationId: "experimental.refiner.edge.create",
        responses: {
          200: {
            description: "Edge create result",
            content: { "application/json": { schema: resolver(z.record(z.string(), z.unknown())) } },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          from: z.string().min(1),
          to: z.string().min(1),
          kind: z.enum(["requires", "refines", "supports", "contradicts", "see_also"]),
          reason: z.string().max(400).optional(),
          confidence: z.number().min(0).max(1).optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const result = await Refiner.createEdge(body)
        if (!result.ok) return c.json({ error: result.error }, 400)
        return c.json(result)
      },
    )
    .delete(
      "/refiner/edge/:edge_id",
      describeRoute({
        summary: "Delete chain edge",
        description: "Remove a single edge by its id.",
        operationId: "experimental.refiner.edge.delete",
        responses: {
          200: {
            description: "Edge delete result",
            content: { "application/json": { schema: resolver(z.record(z.string(), z.unknown())) } },
          },
          ...errors(400),
        },
      }),
      async (c) => {
        const edgeID = c.req.param("edge_id")
        return c.json(await Refiner.deleteEdge({ edge_id: edgeID }))
      },
    )
    .get(
      "/refiner/search",
      describeRoute({
        summary: "Search refiner experiences",
        description: "Substring search across title, abstract, statement, task_type, categories, and observation text.",
        operationId: "experimental.refiner.search",
        responses: {
          200: {
            description: "Search results",
            content: { "application/json": { schema: resolver(z.record(z.string(), z.unknown())) } },
          },
        },
      }),
      validator(
        "query",
        z.object({
          q: z.string().min(1),
          limit: z.coerce.number().optional(),
          include_archived: z.coerce.boolean().optional(),
        }),
      ),
      async (c) => {
        const q = c.req.valid("query")
        return c.json(
          await Refiner.search({ q: q.q, limit: q.limit, includeArchived: q.include_archived }),
        )
      },
    )
    .post(
      "/refiner/ingest-session/:session_id",
      describeRoute({
        summary: "Batch ingest session into refiner",
        description:
          "Replay user messages from an existing session through the refiner pipeline. Pass `message_ids` in the body to cherry-pick specific user messages; omit for full session ingest. Useful for sedimenting historical conversations.",
        operationId: "experimental.refiner.ingestSession",
        responses: {
          200: {
            description: "Ingest stats",
            content: { "application/json": { schema: resolver(z.record(z.string(), z.unknown())) } },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z
          .object({
            message_ids: z.array(z.string()).optional(),
          })
          .optional(),
      ),
      async (c) => {
        const sessionID = c.req.param("session_id")
        const body = c.req.valid("json") ?? {}
        return c.json(
          await Refiner.ingestSession({
            sessionID,
            messageIDs: body.message_ids,
          }),
        )
      },
    )
    .get(
      "/refiner/ingested-observations/:session_id",
      describeRoute({
        summary: "List ingested observations for a session",
        description:
          "Return the set of user message_ids that have already been observed for this session, so the UI can mark/disable already-imported rows in the cherry-pick drawer.",
        operationId: "experimental.refiner.listIngestedObservations",
        responses: {
          200: {
            description: "Ingested observation message_ids",
            content: { "application/json": { schema: resolver(z.record(z.string(), z.unknown())) } },
          },
        },
      }),
      async (c) => {
        const sessionID = c.req.param("session_id")
        return c.json(await Refiner.listIngestedObservations({ sessionID }))
      },
    )
    .get(
      "/refiner/export",
      describeRoute({
        summary: "Export refiner memory",
        description: "Return the entire refiner memory (experiences, taxonomy, categories, config) as a JSON bundle.",
        operationId: "experimental.refiner.export",
        responses: {
          200: {
            description: "Export bundle",
            content: { "application/json": { schema: resolver(z.record(z.string(), z.unknown())) } },
          },
        },
      }),
      async (c) => {
        return c.json(await Refiner.exportJson())
      },
    )
    .post(
      "/refiner/import",
      describeRoute({
        summary: "Import refiner memory",
        description: "Accept a JSON bundle previously produced by /refiner/export and write experiences to disk.",
        operationId: "experimental.refiner.import",
        responses: {
          200: {
            description: "Import result",
            content: { "application/json": { schema: resolver(z.record(z.string(), z.unknown())) } },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          data: z.unknown(),
          mode: z.enum(["merge", "replace"]).optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const result = await Refiner.importJson({ data: body.data, mode: body.mode })
        if (!result.ok) return c.json({ error: result.error }, 400)
        return c.json(result)
      },
    )
    .get(
      "/tool/ids",
      describeRoute({
        summary: "List tool IDs",
        description:
          "Get a list of all available tool IDs, including both built-in tools and dynamically registered tools.",
        operationId: "tool.ids",
        responses: {
          200: {
            description: "Tool IDs",
            content: {
              "application/json": {
                schema: resolver(z.array(z.string()).meta({ ref: "ToolIDs" })),
              },
            },
          },
          ...errors(400),
        },
      }),
      async (c) =>
        jsonRequest("ExperimentalRoutes.tool.ids", c, function* () {
          const registry = yield* ToolRegistry.Service
          return yield* registry.ids()
        }),
    )
    .get(
      "/tool",
      describeRoute({
        summary: "List tools",
        description:
          "Get a list of available tools with their JSON schema parameters for a specific provider and model combination.",
        operationId: "tool.list",
        responses: {
          200: {
            description: "Tools",
            content: {
              "application/json": {
                schema: resolver(
                  z
                    .array(
                      z
                        .object({
                          id: z.string(),
                          description: z.string(),
                          parameters: z.any(),
                        })
                        .meta({ ref: "ToolListItem" }),
                    )
                    .meta({ ref: "ToolList" }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "query",
        z.object({
          provider: z.string(),
          model: z.string(),
        }),
      ),
      async (c) => {
        const { provider, model } = c.req.valid("query")
        const tools = await runRequest(
          "ExperimentalRoutes.tool.list",
          c,
          Effect.gen(function* () {
            const agents = yield* Agent.Service
            const registry = yield* ToolRegistry.Service
            return yield* registry.tools({
              providerID: ProviderID.make(provider),
              modelID: ModelID.make(model),
              agent: yield* agents.get(yield* agents.defaultAgent()),
            })
          }),
        )
        return c.json(
          tools.map((t) => ({
            id: t.id,
            description: t.description,
            parameters: z.toJSONSchema(t.parameters),
          })),
        )
      },
    )
    .post(
      "/worktree",
      describeRoute({
        summary: "Create worktree",
        description: "Create a new git worktree for the current project and run any configured startup scripts.",
        operationId: "worktree.create",
        responses: {
          200: {
            description: "Worktree created",
            content: {
              "application/json": {
                schema: resolver(Worktree.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Worktree.CreateInput.optional()),
      async (c) =>
        jsonRequest("ExperimentalRoutes.worktree.create", c, function* () {
          const body = c.req.valid("json")
          const svc = yield* Worktree.Service
          return yield* svc.create(body)
        }),
    )
    .get(
      "/worktree",
      describeRoute({
        summary: "List worktrees",
        description: "List all sandbox worktrees for the current project.",
        operationId: "worktree.list",
        responses: {
          200: {
            description: "List of worktree directories",
            content: {
              "application/json": {
                schema: resolver(z.array(z.string())),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("ExperimentalRoutes.worktree.list", c, function* () {
          const svc = yield* Project.Service
          return yield* svc.sandboxes(Instance.project.id)
        }),
    )
    .delete(
      "/worktree",
      describeRoute({
        summary: "Remove worktree",
        description: "Remove a git worktree and delete its branch.",
        operationId: "worktree.remove",
        responses: {
          200: {
            description: "Worktree removed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Worktree.RemoveInput),
      async (c) =>
        jsonRequest("ExperimentalRoutes.worktree.remove", c, function* () {
          const body = c.req.valid("json")
          const worktree = yield* Worktree.Service
          const project = yield* Project.Service
          yield* worktree.remove(body)
          yield* project.removeSandbox(Instance.project.id, body.directory)
          return true
        }),
    )
    .post(
      "/worktree/reset",
      describeRoute({
        summary: "Reset worktree",
        description: "Reset a worktree branch to the primary default branch.",
        operationId: "worktree.reset",
        responses: {
          200: {
            description: "Worktree reset",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Worktree.ResetInput),
      async (c) =>
        jsonRequest("ExperimentalRoutes.worktree.reset", c, function* () {
          const body = c.req.valid("json")
          const svc = yield* Worktree.Service
          yield* svc.reset(body)
          return true
        }),
    )
    .get(
      "/session",
      describeRoute({
        summary: "List sessions",
        description:
          "Get a list of all OpenCode sessions across projects, sorted by most recently updated. Archived sessions are excluded by default.",
        operationId: "experimental.session.list",
        responses: {
          200: {
            description: "List of sessions",
            content: {
              "application/json": {
                schema: resolver(Session.GlobalInfo.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          directory: z.string().optional().meta({ description: "Filter sessions by project directory" }),
          roots: z.coerce.boolean().optional().meta({ description: "Only return root sessions (no parentID)" }),
          start: z.coerce
            .number()
            .optional()
            .meta({ description: "Filter sessions updated on or after this timestamp (milliseconds since epoch)" }),
          cursor: z.coerce
            .number()
            .optional()
            .meta({ description: "Return sessions updated before this timestamp (milliseconds since epoch)" }),
          search: z.string().optional().meta({ description: "Filter sessions by title (case-insensitive)" }),
          limit: z.coerce.number().optional().meta({ description: "Maximum number of sessions to return" }),
          archived: z.coerce.boolean().optional().meta({ description: "Include archived sessions (default false)" }),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const limit = query.limit ?? 100
        const sessions: Session.GlobalInfo[] = []
        for await (const session of Session.listGlobal({
          directory: query.directory,
          roots: query.roots,
          start: query.start,
          cursor: query.cursor,
          search: query.search,
          limit: limit + 1,
          archived: query.archived,
        })) {
          sessions.push(session)
        }
        const hasMore = sessions.length > limit
        const list = hasMore ? sessions.slice(0, limit) : sessions
        if (hasMore && list.length > 0) {
          c.header("x-next-cursor", String(list[list.length - 1].time.updated))
        }
        return c.json(list)
      },
    )
    .get(
      "/resource",
      describeRoute({
        summary: "Get MCP resources",
        description: "Get all available MCP resources from connected servers. Optionally filter by name.",
        operationId: "experimental.resource.list",
        responses: {
          200: {
            description: "MCP resources",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), MCP.Resource)),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("ExperimentalRoutes.resource.list", c, function* () {
          const mcp = yield* MCP.Service
          return yield* mcp.resources()
        }),
    ),
)
