CREATE TABLE `creator_discovery_api_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`last_run_id` text,
	`provider` text NOT NULL,
	`key_fingerprint` text NOT NULL,
	`endpoint` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`response_json` text,
	`credits_charged` integer DEFAULT 0 NOT NULL,
	`credits_remaining` integer,
	`cache_expires_at` text,
	`error` text,
	`requested_at` text,
	`completed_at` text,
	`updated_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`last_run_id`) REFERENCES `creator_discovery_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `creator_discovery_api_requests_unique` ON `creator_discovery_api_requests` (`provider`,`key_fingerprint`,`request_hash`);--> statement-breakpoint
CREATE INDEX `creator_discovery_api_requests_run` ON `creator_discovery_api_requests` (`last_run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `creator_discovery_api_requests_status` ON `creator_discovery_api_requests` (`provider`,`status`,`updated_at`);