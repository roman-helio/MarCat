CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`occurred_at` text NOT NULL,
	`type` text DEFAULT 'other' NOT NULL,
	`platform` text,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`url` text,
	`views` integer,
	`likes` integer,
	`comments` integer,
	`is_own` integer DEFAULT true NOT NULL,
	`source_id` text,
	`external_id` text,
	`created_by` text DEFAULT 'manual' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `wishlist_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`filename` text,
	`imported_at` text NOT NULL,
	`rows` integer DEFAULT 0 NOT NULL,
	`column_mapping` text,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `wishlist_points` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`date` text NOT NULL,
	`adds` integer,
	`deletes` integer,
	`gifts` integer,
	`balance` integer,
	`net` integer,
	`source` text DEFAULT 'manual' NOT NULL,
	`import_batch_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wishlist_points_game_date` ON `wishlist_points` (`game_id`,`date`);