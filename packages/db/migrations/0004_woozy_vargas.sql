CREATE TABLE `ai_proposal_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`op` text NOT NULL,
	`entity` text NOT NULL,
	`after_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `ai_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ai_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`mode` text DEFAULT 'freeform' NOT NULL,
	`prompt` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`raw_output` text DEFAULT '' NOT NULL,
	`model` text,
	`error` text,
	`created_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
