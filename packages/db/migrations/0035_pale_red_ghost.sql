CREATE TABLE `campaign_touchpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`canonical_key` text NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`campaign` text DEFAULT '' NOT NULL,
	`medium` text DEFAULT '' NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`term` text DEFAULT '' NOT NULL,
	`event_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `marketing_campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `campaign_touchpoints_campaign` ON `campaign_touchpoints` (`campaign_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_touchpoints_game_tuple` ON `campaign_touchpoints` (`game_id`,`canonical_key`);--> statement-breakpoint
CREATE TABLE `marketing_campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`name` text NOT NULL,
	`objective` text DEFAULT 'wishlist_growth' NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`planned_start` text,
	`planned_end` text,
	`evaluation_window_days` integer DEFAULT 3 NOT NULL,
	`budget_cents` integer,
	`spend_cents` integer,
	`currency` text DEFAULT 'USD' NOT NULL,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `marketing_campaigns_game_status` ON `marketing_campaigns` (`game_id`,`status`,`updated_at`);