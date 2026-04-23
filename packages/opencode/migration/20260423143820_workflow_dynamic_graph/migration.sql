-- Workflow dynamic graph (P1): additive schema for runtime-level graph editing.
-- All columns have safe defaults / nullable so existing rows keep loading.
--
-- IMPORTANT: The paired snapshot.json intentionally captures the FULL current
-- schema state (including any unrelated upstream drift) so downstream
-- `drizzle-kit generate` diffs stay correct. This migration.sql, however,
-- only applies the workflow-related DDL — unrelated schema changes remain
-- the responsibility of whoever introduced them.

ALTER TABLE `workflow` ADD `graph_rev` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow` ADD `max_concurrent_nodes` integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow` ADD `resources_held` text;--> statement-breakpoint
ALTER TABLE `workflow` ADD `result_json` text;--> statement-breakpoint

ALTER TABLE `workflow_node` ADD `input_ports` text;--> statement-breakpoint
ALTER TABLE `workflow_node` ADD `output_ports` text;--> statement-breakpoint
ALTER TABLE `workflow_node` ADD `consumed_inputs` text;--> statement-breakpoint
ALTER TABLE `workflow_node` ADD `stale` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_node` ADD `graph_rev_at_start` integer;--> statement-breakpoint
ALTER TABLE `workflow_node` ADD `priority` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_node` ADD `holds_resources` text;--> statement-breakpoint

ALTER TABLE `workflow_edge` ADD `from_port` text;--> statement-breakpoint
ALTER TABLE `workflow_edge` ADD `to_port` text;--> statement-breakpoint
ALTER TABLE `workflow_edge` ADD `required` integer DEFAULT 1 NOT NULL;--> statement-breakpoint

CREATE TABLE `workflow_edit` (
	`id` text PRIMARY KEY,
	`workflow_id` text NOT NULL,
	`proposer_session_id` text,
	`ops` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`reject_reason` text,
	`graph_rev_before` integer NOT NULL,
	`graph_rev_after` integer,
	`time_created` integer NOT NULL,
	`time_applied` integer,
	CONSTRAINT `fk_workflow_edit_workflow_id_workflow_id_fk` FOREIGN KEY (`workflow_id`) REFERENCES `workflow`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_workflow_edit_proposer_session_id_session_id_fk` FOREIGN KEY (`proposer_session_id`) REFERENCES `session`(`id`) ON DELETE SET NULL
);--> statement-breakpoint
CREATE INDEX `workflow_edit_workflow_idx` ON `workflow_edit` (`workflow_id`);--> statement-breakpoint
CREATE INDEX `workflow_edit_status_idx` ON `workflow_edit` (`status`);
