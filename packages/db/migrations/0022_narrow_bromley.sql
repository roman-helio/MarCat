CREATE TABLE `workspace_configs` (
	`game_id` text PRIMARY KEY NOT NULL,
	`root_path` text NOT NULL,
	`workspace_folder` text DEFAULT 'MarCat' NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`last_scan_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `workspace_files` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`relative_path` text NOT NULL,
	`content_hash` text NOT NULL,
	`base_hash` text NOT NULL,
	`base_content` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'synced' NOT NULL,
	`missing_since` text,
	`mtime_ms` integer,
	`size` integer,
	`last_synced_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_files_game_path_unique` ON `workspace_files` (`game_id`,`relative_path`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_files_game_entity_unique` ON `workspace_files` (`game_id`,`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `workspace_files_game_status` ON `workspace_files` (`game_id`,`status`);--> statement-breakpoint
CREATE TABLE `workspace_outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`operation` text DEFAULT 'upsert' NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`claimed_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`processed_at` text,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workspace_outbox_pending` ON `workspace_outbox` (`processed_at`,`next_attempt_at`,`id`);--> statement-breakpoint
CREATE INDEX `workspace_outbox_entity` ON `workspace_outbox` (`game_id`,`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `workspace_sync_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`workspace_file_id` text,
	`kind` text NOT NULL,
	`severity` text DEFAULT 'error' NOT NULL,
	`relative_path` text,
	`message` text NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL,
	`resolved_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_file_id`) REFERENCES `workspace_files`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `workspace_sync_issues_game_open` ON `workspace_sync_issues` (`game_id`,`resolved_at`);--> statement-breakpoint
CREATE INDEX `workspace_sync_issues_file` ON `workspace_sync_issues` (`workspace_file_id`);