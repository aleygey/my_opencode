import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import {
  CreateAutomationTaskSchema,
  UpdateAutomationTaskSchema,
  AutomationTaskInfoSchema,
  AutomationRunInfoSchema,
  createTask,
  updateTask,
  removeTask,
  listTasks,
  getTask,
  toggleTask,
  triggerRun,
  listRuns,
  getRun,
  ensureScheduler,
} from "@/automation"

const TriggerResultSchema = z.object({
  runID: z.string(),
  status: z.string(),
  error: z.string().optional(),
})

export const AutomationRoutes = (): Hono => {
  // Ensure the scheduler is alive whenever any route is exercised. Lazy boot
  // keeps unit tests of unrelated routes from spinning up Croner / disk reads.
  const ensure = () => ensureScheduler()

  return new Hono()
    .get(
      "/task",
      describeRoute({
        summary: "List automation tasks",
        description:
          "Return every scheduled-task definition for this opencode instance, newest first. Each task carries its schedule (cron or interval ms), the orchestrator prompt to send on each fire, current status, last-run timestamp, and circuit-breaker state.",
        operationId: "automation.task.list",
        responses: {
          200: {
            description: "List of tasks",
            content: { "application/json": { schema: resolver(AutomationTaskInfoSchema.array()) } },
          },
        },
      }),
      async (c) => {
        ensure()
        return c.json(listTasks())
      },
    )
    .get(
      "/task/:id",
      describeRoute({
        summary: "Get a single automation task",
        operationId: "automation.task.get",
        responses: {
          200: {
            description: "Task",
            content: { "application/json": { schema: resolver(AutomationTaskInfoSchema) } },
          },
          404: { description: "Not found" },
        },
      }),
      async (c) => {
        ensure()
        const row = getTask(c.req.param("id"))
        if (!row) return c.json({ error: "not_found" }, 404)
        return c.json(row)
      },
    )
    .post(
      "/task",
      describeRoute({
        summary: "Create an automation task",
        description:
          "Define a new scheduled task. Set `type` to `cron` for cron-expression scheduling or `interval` for a millisecond-period repeating timer. The scheduler picks up the new task immediately — no restart required.",
        operationId: "automation.task.create",
        responses: {
          200: {
            description: "Created task",
            content: { "application/json": { schema: resolver(AutomationTaskInfoSchema) } },
          },
        },
      }),
      validator("json", CreateAutomationTaskSchema),
      async (c) => {
        ensure()
        try {
          const row = createTask(c.req.valid("json"))
          return c.json(row)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return c.json({ error: "invalid_input", message }, 400)
        }
      },
    )
    .patch(
      "/task/:id",
      describeRoute({
        summary: "Update an automation task",
        description:
          "Patch any field of an existing task. Re-validates the cron/interval expression when either `type` or `expression` is changed. The scheduler re-registers the task atomically.",
        operationId: "automation.task.update",
        responses: {
          200: {
            description: "Updated task",
            content: { "application/json": { schema: resolver(AutomationTaskInfoSchema) } },
          },
          404: { description: "Not found" },
        },
      }),
      validator("json", UpdateAutomationTaskSchema),
      async (c) => {
        ensure()
        try {
          const row = updateTask(c.req.param("id"), c.req.valid("json"))
          if (!row) return c.json({ error: "not_found" }, 404)
          return c.json(row)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return c.json({ error: "invalid_input", message }, 400)
        }
      },
    )
    .delete(
      "/task/:id",
      describeRoute({
        summary: "Delete an automation task",
        description:
          "Remove a task and cascade-delete its run history. Best-effort: also cleans up any worktrees still owned by historical runs.",
        operationId: "automation.task.delete",
        responses: {
          200: { description: "Deleted", content: { "application/json": { schema: resolver(z.boolean()) } } },
        },
      }),
      async (c) => {
        ensure()
        const ok = removeTask(c.req.param("id"))
        return c.json(ok)
      },
    )
    .post(
      "/task/:id/toggle",
      describeRoute({
        summary: "Flip a task's enabled flag",
        description:
          "Convenience endpoint that flips the `enabled` boolean. Disabling pauses the schedule; re-enabling clears the failure counter so a previously circuit-broken task can resume.",
        operationId: "automation.task.toggle",
        responses: {
          200: {
            description: "Task",
            content: { "application/json": { schema: resolver(AutomationTaskInfoSchema) } },
          },
          404: { description: "Not found" },
        },
      }),
      async (c) => {
        ensure()
        const row = toggleTask(c.req.param("id"))
        if (!row) return c.json({ error: "not_found" }, 404)
        return c.json(row)
      },
    )
    .post(
      "/task/:id/trigger",
      describeRoute({
        summary: "Fire a task on demand",
        description:
          "Run the task immediately (out of band from the schedule). Subject to the same single-run concurrency guard — if another run is already in flight, the new one lands as `skipped`.",
        operationId: "automation.task.trigger",
        responses: {
          200: {
            description: "Run handle",
            content: { "application/json": { schema: resolver(TriggerResultSchema) } },
          },
        },
      }),
      async (c) => {
        ensure()
        const result = await triggerRun(c.req.param("id"))
        return c.json(result)
      },
    )
    .get(
      "/run",
      describeRoute({
        summary: "List automation runs",
        description:
          "Return run history across all tasks, newest first. Pass `task_id` to scope to a single task.",
        operationId: "automation.run.list",
        responses: {
          200: {
            description: "Runs",
            content: { "application/json": { schema: resolver(AutomationRunInfoSchema.array()) } },
          },
        },
      }),
      validator(
        "query",
        z.object({
          task_id: z.string().optional(),
          limit: z.coerce.number().int().positive().max(200).optional(),
        }),
      ),
      async (c) => {
        ensure()
        const q = c.req.valid("query")
        return c.json(listRuns(q.task_id, q.limit ?? 20))
      },
    )
    .get(
      "/run/:id",
      describeRoute({
        summary: "Get a single run",
        operationId: "automation.run.get",
        responses: {
          200: {
            description: "Run",
            content: { "application/json": { schema: resolver(AutomationRunInfoSchema) } },
          },
          404: { description: "Not found" },
        },
      }),
      async (c) => {
        ensure()
        const row = getRun(c.req.param("id"))
        if (!row) return c.json({ error: "not_found" }, 404)
        return c.json(row)
      },
    )
}
