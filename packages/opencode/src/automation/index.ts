/**
 * Scheduled-task subsystem ("Automation").
 *
 * Lets users define a cron- or interval-driven prompt that fires periodically.
 * On each fire the runner creates a fresh worktree, bootstraps an opencode
 * instance inside it, opens a session, and dispatches the prompt to the
 * configured orchestrator agent. The session-finish hook calls back through
 * `markRunFinished()` to record completion in the run history.
 *
 * Wire-up:
 *   - The HTTP routes (`/automation/*`) are mounted by the instance route
 *     index.
 *   - The scheduler is created and started lazily on the first HTTP call OR
 *     explicitly via `Automation.start()` from a process-level boot path.
 *     We avoid auto-starting at import time so unit tests can construct
 *     fakes without triggering disk reads.
 */
export { create as createAutomationScheduler, type AutomationScheduler } from "./automation"
export { executeRun, cleanupWorktree, runID, automationID, markRunFinished, type TaskRow, type RunOptions, type RunResult } from "./runner"
export {
  createTask,
  removeTask,
  updateTask,
  listTasks,
  getTask,
  toggleTask,
  triggerRun,
  listRuns,
  getRun,
  setOnChange,
  type CreateTaskInput,
  type UpdateTaskInput,
} from "./api"
export {
  AutomationTaskTable,
  AutomationRunTable,
  AutomationTaskTypeSchema,
  AutomationTaskStatusSchema,
  AutomationRunStatusSchema,
  CreateAutomationTaskSchema,
  UpdateAutomationTaskSchema,
  AutomationTaskInfoSchema,
  AutomationRunInfoSchema,
  type AutomationTask,
  type AutomationTaskInsert,
  type AutomationRun,
  type AutomationRunInsert,
  type AutomationTaskType,
  type AutomationTaskStatus,
  type AutomationRunStatus,
} from "./automation.sql"

import { create as createScheduler, type AutomationScheduler } from "./automation"

let _scheduler: AutomationScheduler | null = null

/** Module-level singleton accessor — first call constructs + starts the
 *  scheduler; subsequent calls return the running instance. Both the HTTP
 *  routes and any explicit boot path go through this so we never end up
 *  with two schedulers racing on the same task table. */
export function ensureScheduler(): AutomationScheduler {
  if (_scheduler && _scheduler.isStarted()) return _scheduler
  _scheduler = createScheduler()
  _scheduler.start()
  return _scheduler
}

export function stopScheduler() {
  if (!_scheduler) return
  _scheduler.stop()
  _scheduler = null
}
