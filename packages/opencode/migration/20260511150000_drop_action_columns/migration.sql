-- Drop the action-budget columns from `workflow_node`. The action design
-- (per-node tool-call counter + auto-wake on `action_count >= max_actions`)
-- is being removed: it added context bloat and a wake path that fired on
-- every tool call without giving the orchestrator anything actionable.
-- Attempt-budget (`attempt`/`max_attempts`) remains as the sole retry gate.
ALTER TABLE `workflow_node` DROP COLUMN `action_count`;--> statement-breakpoint
ALTER TABLE `workflow_node` DROP COLUMN `max_actions`;
