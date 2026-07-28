CREATE TABLE `utm_links` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`label` text NOT NULL,
	`base_url` text NOT NULL,
	`utm_source` text NOT NULL,
	`utm_medium` text NOT NULL,
	`utm_campaign` text NOT NULL,
	`utm_content` text,
	`utm_term` text,
	`full_url` text NOT NULL,
	`event_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
