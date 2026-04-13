CREATE TABLE `workflow` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`current_node_id` text,
	`selected_node_id` text,
	`version` integer DEFAULT 0 NOT NULL,
	`config` text,
	`summary` text,
	`time_paused` integer,
	`time_completed` integer,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `workflow_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `workflow_session_idx` ON `workflow` (`session_id`);
--> statement-breakpoint
CREATE TABLE `workflow_node` (
	`id` text PRIMARY KEY,
	`workflow_id` text NOT NULL,
	`session_id` text,
	`title` text NOT NULL,
	`agent` text NOT NULL,
	`model` text,
	`config` text,
	`status` text NOT NULL,
	`result_status` text NOT NULL,
	`fail_reason` text,
	`action_count` integer DEFAULT 0 NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 1 NOT NULL,
	`max_actions` integer DEFAULT 20 NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`state_json` text,
	`result_json` text,
	`position` integer DEFAULT 0 NOT NULL,
	`time_started` integer,
	`time_completed` integer,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `workflow_node_workflow_id_workflow_id_fk` FOREIGN KEY (`workflow_id`) REFERENCES `workflow`(`id`) ON DELETE CASCADE,
	CONSTRAINT `workflow_node_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX `workflow_node_workflow_idx` ON `workflow_node` (`workflow_id`);
--> statement-breakpoint
CREATE INDEX `workflow_node_session_idx` ON `workflow_node` (`session_id`);
--> statement-breakpoint
CREATE TABLE `workflow_edge` (
	`id` text PRIMARY KEY,
	`workflow_id` text NOT NULL,
	`from_node_id` text NOT NULL,
	`to_node_id` text NOT NULL,
	`label` text,
	`config` text,
	`time_created` integer NOT NULL,
	CONSTRAINT `workflow_edge_workflow_id_workflow_id_fk` FOREIGN KEY (`workflow_id`) REFERENCES `workflow`(`id`) ON DELETE CASCADE,
	CONSTRAINT `workflow_edge_from_node_id_workflow_node_id_fk` FOREIGN KEY (`from_node_id`) REFERENCES `workflow_node`(`id`) ON DELETE CASCADE,
	CONSTRAINT `workflow_edge_to_node_id_workflow_node_id_fk` FOREIGN KEY (`to_node_id`) REFERENCES `workflow_node`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `workflow_edge_workflow_idx` ON `workflow_edge` (`workflow_id`);
--> statement-breakpoint
CREATE INDEX `workflow_edge_from_idx` ON `workflow_edge` (`from_node_id`);
--> statement-breakpoint
CREATE INDEX `workflow_edge_to_idx` ON `workflow_edge` (`to_node_id`);
--> statement-breakpoint
CREATE TABLE `workflow_checkpoint` (
	`id` text PRIMARY KEY,
	`workflow_id` text NOT NULL,
	`node_id` text NOT NULL,
	`label` text NOT NULL,
	`status` text NOT NULL,
	`config` text,
	`result_json` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `workflow_checkpoint_workflow_id_workflow_id_fk` FOREIGN KEY (`workflow_id`) REFERENCES `workflow`(`id`) ON DELETE CASCADE,
	CONSTRAINT `workflow_checkpoint_node_id_workflow_node_id_fk` FOREIGN KEY (`node_id`) REFERENCES `workflow_node`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `workflow_checkpoint_workflow_idx` ON `workflow_checkpoint` (`workflow_id`);
--> statement-breakpoint
CREATE INDEX `workflow_checkpoint_node_idx` ON `workflow_checkpoint` (`node_id`);
--> statement-breakpoint
CREATE TABLE `workflow_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workflow_id` text NOT NULL,
	`node_id` text,
	`session_id` text,
	`target_node_id` text,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`payload` text NOT NULL,
	`time_created` integer NOT NULL,
	CONSTRAINT `workflow_event_workflow_id_workflow_id_fk` FOREIGN KEY (`workflow_id`) REFERENCES `workflow`(`id`) ON DELETE CASCADE,
	CONSTRAINT `workflow_event_node_id_workflow_node_id_fk` FOREIGN KEY (`node_id`) REFERENCES `workflow_node`(`id`) ON DELETE CASCADE,
	CONSTRAINT `workflow_event_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE SET NULL,
	CONSTRAINT `workflow_event_target_node_id_workflow_node_id_fk` FOREIGN KEY (`target_node_id`) REFERENCES `workflow_node`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `workflow_event_workflow_idx` ON `workflow_event` (`workflow_id`);
--> statement-breakpoint
CREATE INDEX `workflow_event_node_idx` ON `workflow_event` (`node_id`);
--> statement-breakpoint
CREATE INDEX `workflow_event_target_idx` ON `workflow_event` (`target_node_id`);
