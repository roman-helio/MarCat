CREATE TABLE `analytics_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`kind` text NOT NULL,
	`filename` text,
	`date_from` text,
	`date_to` text,
	`rows` integer DEFAULT 0 NOT NULL,
	`rows_json` text DEFAULT '[]' NOT NULL,
	`imported_at` text NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `analytics_imports_game_kind` ON `analytics_imports` (`game_id`,`kind`,`imported_at`);