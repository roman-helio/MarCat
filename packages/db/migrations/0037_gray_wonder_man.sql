CREATE TABLE `background_operation_items` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`outcome` text,
	`result_entity_id` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `background_operations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `background_operation_items_entity` ON `background_operation_items` (`operation_id`,`entity_id`);--> statement-breakpoint
CREATE INDEX `background_operation_items_queue` ON `background_operation_items` (`operation_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `background_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`kind` text NOT NULL,
	`scope_id` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`selected` integer NOT NULL,
	`processed` integer DEFAULT 0 NOT NULL,
	`succeeded` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`created_count` integer DEFAULT 0 NOT NULL,
	`updated_count` integer DEFAULT 0 NOT NULL,
	`error` text,
	`started_at` text,
	`finished_at` text,
	`heartbeat_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `background_operations_queue` ON `background_operations` (`kind`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `background_operations_scope` ON `background_operations` (`kind`,`scope_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `background_operations_dedupe` ON `background_operations` (`dedupe_key`,`status`);