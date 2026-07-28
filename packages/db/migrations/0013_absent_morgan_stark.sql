CREATE TABLE `creator_picks` (
	`game_id` text NOT NULL,
	`creator_id` text NOT NULL,
	`pipeline_status` text DEFAULT 'prospect' NOT NULL,
	`closed_reason` text,
	`agreed_cost_usd` integer,
	`added_by` text DEFAULT 'manual' NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`creator_id`) REFERENCES `creators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `creator_picks_game_creator` ON `creator_picks` (`game_id`,`creator_id`);--> statement-breakpoint
CREATE TABLE `creator_touches` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`creator_id` text NOT NULL,
	`occurred_at` text NOT NULL,
	`direction` text NOT NULL,
	`channel` text DEFAULT 'email' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`body` text,
	`template_id` text,
	`status_after` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`creator_id`) REFERENCES `creators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `creator_touches_game_creator` ON `creator_touches` (`game_id`,`creator_id`);--> statement-breakpoint
CREATE TABLE `creators` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`handle` text,
	`kind` text DEFAULT 'youtuber' NOT NULL,
	`primary_platform` text,
	`channel_key` text,
	`channels_json` text,
	`audience` integer,
	`avg_views` integer,
	`engagement_rate` real,
	`last_active_at` text,
	`cadence_per_month` real,
	`topics_json` text,
	`language` text,
	`region` text,
	`contacts_json` text,
	`rate_usd` integer,
	`accepts_keys_only` integer,
	`currency` text,
	`rate_note` text,
	`do_not_contact` integer DEFAULT false NOT NULL,
	`notes` text,
	`description` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `creators_channel_key` ON `creators` (`channel_key`);--> statement-breakpoint
CREATE TABLE `outreach_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `events` ADD `creator_id` text;