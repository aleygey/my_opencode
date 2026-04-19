CREATE TABLE `scheduled_task` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`expression` text NOT NULL,
	`command` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_execution` (
	`id` text PRIMARY KEY,
	`task_id` text NOT NULL,
	`status` text NOT NULL,
	`result` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_task_execution_task_id_scheduled_task_id_fk` FOREIGN KEY (`task_id`) REFERENCES `scheduled_task`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `scheduled_task_type_idx` ON `scheduled_task` (`type`);--> statement-breakpoint
CREATE INDEX `task_execution_task_idx` ON `task_execution` (`task_id`);
