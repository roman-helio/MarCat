CREATE TABLE `festival_picks` (
	`game_id` text NOT NULL,
	`industry_event_id` text NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`industry_event_id`) REFERENCES `industry_events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `festival_picks_game_event` ON `festival_picks` (`game_id`,`industry_event_id`);--> statement-breakpoint
CREATE TABLE `industry_events` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'festival' NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`url` text,
	`organizer` text,
	`notes` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` text NOT NULL
);
