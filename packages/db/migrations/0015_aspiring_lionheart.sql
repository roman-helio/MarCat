ALTER TABLE `events` ADD `subject_type` text DEFAULT 'project' NOT NULL;--> statement-breakpoint
ALTER TABLE `events` ADD `subject_id` text;--> statement-breakpoint
ALTER TABLE `events` ADD `subject_label` text;--> statement-breakpoint
ALTER TABLE `events` ADD `show_on_wishlist` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `events` ADD `direction` text;--> statement-breakpoint
ALTER TABLE `events` ADD `channel` text;--> statement-breakpoint
ALTER TABLE `events` ADD `status_after` text;--> statement-breakpoint
ALTER TABLE `events` ADD `template_id` text;--> statement-breakpoint
CREATE INDEX `events_game_subject` ON `events` (`game_id`,`subject_type`,`subject_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `events_game_wishlist` ON `events` (`game_id`,`show_on_wishlist`,`occurred_at`);--> statement-breakpoint

/* Existing creator-attributed marketing events become creator activities. */
UPDATE `events`
SET
	`subject_type` = 'creator',
	`subject_id` = `creator_id`,
	`subject_label` = (SELECT `name` FROM `creators` WHERE `creators`.`id` = `events`.`creator_id`)
WHERE `creator_id` IS NOT NULL AND `subject_id` IS NULL;--> statement-breakpoint

/*
 * Fold the old creator-only correspondence into the universal journal. The
 * legacy table deliberately remains intact for one release as a rollback aid.
 */
INSERT OR IGNORE INTO `events` (
	`id`, `game_id`, `occurred_at`, `subject_type`, `subject_id`, `subject_label`,
	`show_on_wishlist`, `direction`, `channel`, `status_after`, `template_id`,
	`type`, `platform`, `title`, `description`, `is_own`, `creator_id`, `created_by`,
	`created_at`, `updated_at`
)
SELECT
	`creator_touches`.`id`,
	`creator_touches`.`game_id`,
	`creator_touches`.`occurred_at`,
	'creator',
	`creator_touches`.`creator_id`,
	`creators`.`name`,
	0,
	`creator_touches`.`direction`,
	`creator_touches`.`channel`,
	`creator_touches`.`status_after`,
	`creator_touches`.`template_id`,
	'other',
	NULL,
	CASE
		WHEN trim(`creator_touches`.`summary`) <> '' THEN `creator_touches`.`summary`
		WHEN `creator_touches`.`direction` = 'inbound' THEN 'Received reply'
		ELSE 'Sent message'
	END,
	coalesce(`creator_touches`.`body`, ''),
	CASE WHEN `creator_touches`.`direction` = 'outbound' THEN 1 ELSE 0 END,
	`creator_touches`.`creator_id`,
	'manual',
	`creator_touches`.`created_at`,
	`creator_touches`.`created_at`
FROM `creator_touches`
LEFT JOIN `creators` ON `creators`.`id` = `creator_touches`.`creator_id`;
