CREATE INDEX `creator_picks_game_status` ON `creator_picks` (`game_id`,`pipeline_status`,`creator_id`);--> statement-breakpoint
CREATE INDEX `creators_name` ON `creators` (`name`,`id`);--> statement-breakpoint
CREATE INDEX `events_game_date` ON `events` (`game_id`,`occurred_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `industry_events_date` ON `industry_events` (`start_date`,`name`);