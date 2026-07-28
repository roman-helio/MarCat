CREATE TABLE `creator_discovery_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text DEFAULT 'youtube' NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`handle` text,
	`channel_url` text NOT NULL,
	`thumbnail_url` text,
	`description` text,
	`country` text,
	`default_language` text,
	`subscriber_count` integer,
	`total_view_count` integer,
	`video_count` integer,
	`avg_views` integer,
	`cadence_per_month` real,
	`latest_video_at` text,
	`uploads_playlist_id` text,
	`fetched_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `creator_discovery_candidates_platform_external` ON `creator_discovery_candidates` (`platform`,`external_id`);--> statement-breakpoint
CREATE INDEX `creator_discovery_candidates_expiry` ON `creator_discovery_candidates` (`expires_at`);--> statement-breakpoint
CREATE TABLE `creator_discovery_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`candidate_id` text NOT NULL,
	`type` text NOT NULL,
	`value` text NOT NULL,
	`normalized_value` text NOT NULL,
	`source_url` text NOT NULL,
	`confidence` real DEFAULT 0.8 NOT NULL,
	`gated` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `creator_discovery_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`candidate_id`) REFERENCES `creator_discovery_candidates`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `creator_discovery_contacts_unique` ON `creator_discovery_contacts` (`run_id`,`candidate_id`,`type`,`normalized_value`);--> statement-breakpoint
CREATE INDEX `creator_discovery_contacts_candidate` ON `creator_discovery_contacts` (`candidate_id`);--> statement-breakpoint
CREATE TABLE `creator_discovery_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`candidate_id` text NOT NULL,
	`reference_id` text NOT NULL,
	`video_id` text NOT NULL,
	`video_title` text NOT NULL,
	`video_url` text NOT NULL,
	`published_at` text,
	`view_count` integer,
	`matched_terms_json` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `creator_discovery_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`candidate_id`) REFERENCES `creator_discovery_candidates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reference_id`) REFERENCES `creator_discovery_references`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `creator_discovery_evidence_unique` ON `creator_discovery_evidence` (`run_id`,`candidate_id`,`reference_id`,`video_id`);--> statement-breakpoint
CREATE INDEX `creator_discovery_evidence_run_candidate` ON `creator_discovery_evidence` (`run_id`,`candidate_id`);--> statement-breakpoint
CREATE TABLE `creator_discovery_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`name` text NOT NULL,
	`mode` text DEFAULT 'games' NOT NULL,
	`languages_json` text DEFAULT '[]' NOT NULL,
	`include_terms_json` text DEFAULT '[]' NOT NULL,
	`exclude_terms_json` text DEFAULT '[]' NOT NULL,
	`seed_channels_json` text DEFAULT '[]' NOT NULL,
	`max_search_requests` integer DEFAULT 10 NOT NULL,
	`max_channels` integer DEFAULT 500 NOT NULL,
	`recent_video_limit` integer DEFAULT 50 NOT NULL,
	`discover_contacts` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `creator_discovery_profiles_game` ON `creator_discovery_profiles` (`game_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `creator_discovery_references` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`label` text NOT NULL,
	`aliases_json` text DEFAULT '[]' NOT NULL,
	`query_terms_json` text DEFAULT '[]' NOT NULL,
	`weight` real DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `creator_discovery_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `creator_discovery_references_profile` ON `creator_discovery_references` (`profile_id`);--> statement-breakpoint
CREATE TABLE `creator_discovery_run_candidates` (
	`run_id` text NOT NULL,
	`candidate_id` text NOT NULL,
	`fit_score` integer NOT NULL,
	`matched_reference_count` integer DEFAULT 0 NOT NULL,
	`matched_references_json` text DEFAULT '[]' NOT NULL,
	`matched_video_count` integer DEFAULT 0 NOT NULL,
	`fit_reasons_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'staged' NOT NULL,
	`creator_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `creator_discovery_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`candidate_id`) REFERENCES `creator_discovery_candidates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`creator_id`) REFERENCES `creators`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `creator_discovery_run_candidates_unique` ON `creator_discovery_run_candidates` (`run_id`,`candidate_id`);--> statement-breakpoint
CREATE INDEX `creator_discovery_run_candidates_score` ON `creator_discovery_run_candidates` (`run_id`,`fit_score`);--> statement-breakpoint
CREATE TABLE `creator_discovery_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`profile_hash` text NOT NULL,
	`profile_snapshot_json` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`phase` text DEFAULT 'queued' NOT NULL,
	`search_requests_used` integer DEFAULT 0 NOT NULL,
	`data_units_used` integer DEFAULT 0 NOT NULL,
	`channels_found` integer DEFAULT 0 NOT NULL,
	`channels_scanned` integer DEFAULT 0 NOT NULL,
	`videos_scanned` integer DEFAULT 0 NOT NULL,
	`candidates_staged` integer DEFAULT 0 NOT NULL,
	`contacts_found` integer DEFAULT 0 NOT NULL,
	`error` text,
	`heartbeat_at` text,
	`started_at` text,
	`finished_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `creator_discovery_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `creator_discovery_runs_game` ON `creator_discovery_runs` (`game_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `creator_discovery_runs_profile_hash` ON `creator_discovery_runs` (`profile_id`,`profile_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `creator_discovery_runs_status` ON `creator_discovery_runs` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `youtube_api_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`last_run_id` text,
	`key_fingerprint` text NOT NULL,
	`endpoint` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`quota_bucket` text NOT NULL,
	`quota_cost` integer NOT NULL,
	`quota_date` text NOT NULL,
	`response_json` text,
	`cache_expires_at` text,
	`error` text,
	`reserved_at` text,
	`requested_at` text,
	`completed_at` text,
	`updated_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`last_run_id`) REFERENCES `creator_discovery_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `youtube_api_requests_key_hash` ON `youtube_api_requests` (`key_fingerprint`,`request_hash`);--> statement-breakpoint
CREATE INDEX `youtube_api_requests_run` ON `youtube_api_requests` (`last_run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `youtube_api_requests_status` ON `youtube_api_requests` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `youtube_quota_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`key_fingerprint` text NOT NULL,
	`quota_date` text NOT NULL,
	`bucket` text NOT NULL,
	`used` integer DEFAULT 0 NOT NULL,
	`limit` integer NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `youtube_quota_usage_unique` ON `youtube_quota_usage` (`key_fingerprint`,`quota_date`,`bucket`);--> statement-breakpoint
ALTER TABLE `creators` ADD `youtube_channel_id` text;--> statement-breakpoint
ALTER TABLE `creators` ADD `thumbnail_url` text;--> statement-breakpoint
ALTER TABLE `creators` ADD `data_refreshed_at` text;--> statement-breakpoint
ALTER TABLE `creators` ADD `data_expires_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `creators_youtube_channel_id` ON `creators` (`youtube_channel_id`);