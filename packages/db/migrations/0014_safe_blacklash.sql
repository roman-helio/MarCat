CREATE TABLE `project_cards` (
	`game_id` text PRIMARY KEY NOT NULL,
	`one_liner` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`audience` text DEFAULT '' NOT NULL,
	`positioning` text DEFAULT '' NOT NULL,
	`repository` text DEFAULT '' NOT NULL,
	`branch` text DEFAULT '' NOT NULL,
	`devhub_wiki_url` text DEFAULT '' NOT NULL,
	`agent_notes` text DEFAULT '' NOT NULL,
	`links_json` text DEFAULT '[]' NOT NULL,
	`docs_json` text DEFAULT '[]' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
