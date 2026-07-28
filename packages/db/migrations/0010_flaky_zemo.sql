CREATE TABLE `ai_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `ai_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `ai_runs` ADD `session_id` text;--> statement-breakpoint
ALTER TABLE `ai_runs` ADD `archived` integer DEFAULT false NOT NULL;