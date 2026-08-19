UPDATE `creator_discovery_runs`
SET `youtube_completed_at` = COALESCE(`finished_at`, `heartbeat_at`, `created_at`)
WHERE `youtube_completed_at` IS NULL
	AND (
		`status` = 'completed'
		OR `phase` IN ('searching_social', 'enriching_social', 'staging_social')
	);--> statement-breakpoint
DELETE FROM `youtube_api_requests`
WHERE `status` IN ('planned', 'succeeded', 'failed');--> statement-breakpoint
INSERT INTO `settings` (`key`, `value`, `updated_at`)
VALUES ('maintenance.youtube_storage_v1', 'pending', CURRENT_TIMESTAMP)
ON CONFLICT (`key`) DO UPDATE SET `value` = 'pending', `updated_at` = CURRENT_TIMESTAMP;
