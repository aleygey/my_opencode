CREATE TABLE `automation_task` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`expression` text NOT NULL,
	`prompt` text NOT NULL,
	`agent` text DEFAULT 'orchestrator' NOT NULL,
	`model` text,
	`worktree_prefix` text,
	`enabled` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`last_run_at` integer,
	`error_message` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`max_consecutive_failures` integer DEFAULT 3 NOT NULL,
	`max_retention` integer DEFAULT 20 NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `automation_run` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`session_id` text,
	`workflow_id` text,
	`worktree_name` text,
	`worktree_directory` text,
	`worktree_branch` text,
	`status` text DEFAULT 'running' NOT NULL,
	`error_message` text,
	`started_at` integer,
	`finished_at` integer,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_automation_run_task_id_automation_task_id_fk` FOREIGN KEY (`task_id`) REFERENCES `automation_task`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `automation_task_type_idx` ON `automation_task` (`type`);--> statement-breakpoint
CREATE INDEX `automation_task_enabled_idx` ON `automation_task` (`enabled`);--> statement-breakpoint
CREATE INDEX `automation_run_task_idx` ON `automation_run` (`task_id`);--> statement-breakpoint
CREATE INDEX `automation_run_status_idx` ON `automation_run` (`status`);
