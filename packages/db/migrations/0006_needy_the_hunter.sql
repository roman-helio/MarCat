CREATE TABLE `api_spend` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`date` text NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_spend_provider_date` ON `api_spend` (`provider`,`date`);--> statement-breakpoint
CREATE TABLE `event_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`captured_at` text NOT NULL,
	`views` integer,
	`likes` integer,
	`comments` integer,
	`shares` integer,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `provider_settings` (
	`provider` text PRIMARY KEY NOT NULL,
	`daily_budget_usd` real
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`platform` text NOT NULL,
	`handle` text NOT NULL,
	`display_name` text,
	`enabled` integer DEFAULT true NOT NULL,
	`last_synced_at` text,
	`last_status` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text DEFAULT 'running' NOT NULL,
	`imported` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`error` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
