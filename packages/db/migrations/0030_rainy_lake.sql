CREATE TABLE `inbox_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`source_id` text NOT NULL,
	`platform` text NOT NULL,
	`external_id` text NOT NULL,
	`kind` text DEFAULT 'comment' NOT NULL,
	`author_name` text,
	`author_url` text,
	`body` text NOT NULL,
	`rating` integer,
	`language` text,
	`url` text NOT NULL,
	`published_at` text NOT NULL,
	`remote_updated_at` text,
	`developer_reply` text,
	`developer_replied_at` text,
	`status` text DEFAULT 'unread' NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_comments_source_external_unique` ON `inbox_comments` (`source_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `inbox_comments_game_status` ON `inbox_comments` (`game_id`,`status`,`published_at`);--> statement-breakpoint
CREATE INDEX `inbox_comments_source_date` ON `inbox_comments` (`source_id`,`published_at`);