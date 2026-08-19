CREATE TABLE `creator_discovery_run_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `creator_discovery_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `creator_discovery_run_channels_unique` ON `creator_discovery_run_channels` (`run_id`,`channel_id`);--> statement-breakpoint
CREATE INDEX `creator_discovery_run_channels_queue` ON `creator_discovery_run_channels` (`run_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `creator_discovery_run_searches` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`task_key` text NOT NULL,
	`query` text NOT NULL,
	`page_token` text,
	`relevance_language` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `creator_discovery_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `creator_discovery_run_searches_unique` ON `creator_discovery_run_searches` (`run_id`,`task_key`);--> statement-breakpoint
CREATE INDEX `creator_discovery_run_searches_queue` ON `creator_discovery_run_searches` (`run_id`,`status`,`priority`,`created_at`);--> statement-breakpoint
ALTER TABLE `creator_discovery_runs` ADD `youtube_completed_at` text;--> statement-breakpoint
ALTER TABLE `youtube_api_requests` DROP COLUMN `response_json`;--> statement-breakpoint
ALTER TABLE `youtube_api_requests` DROP COLUMN `cache_expires_at`;
