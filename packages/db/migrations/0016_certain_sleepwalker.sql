CREATE TABLE `task_counters` (
	`game_id` text PRIMARY KEY NOT NULL,
	`last_seq` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
/* Heal legacy duplicates before enforcing invariants. The normal startup backfill
   assigns fresh values to rows whose conflicting key/sequence is cleared here. */
WITH ranked AS (
	SELECT `id`, row_number() OVER (PARTITION BY `key` ORDER BY `created_at`, `id`) AS rn
	FROM `games` WHERE `key` IS NOT NULL
)
UPDATE `games` SET `key` = NULL WHERE `id` IN (SELECT `id` FROM ranked WHERE rn > 1);--> statement-breakpoint
WITH ranked AS (
	SELECT `id`, row_number() OVER (PARTITION BY `game_id`, `seq` ORDER BY `created_at`, `id`) AS rn
	FROM `tasks` WHERE `seq` IS NOT NULL
)
UPDATE `tasks` SET `seq` = NULL WHERE `id` IN (SELECT `id` FROM ranked WHERE rn > 1);--> statement-breakpoint
DELETE FROM `task_dependencies`
WHERE rowid NOT IN (SELECT min(rowid) FROM `task_dependencies` GROUP BY `blocker_task_id`, `blocked_task_id`);--> statement-breakpoint
DELETE FROM `task_links`
WHERE rowid NOT IN (SELECT min(rowid) FROM `task_links` GROUP BY `task_id`, `related_task_id`, `relation`);--> statement-breakpoint
DELETE FROM `task_tag_links`
WHERE rowid NOT IN (SELECT min(rowid) FROM `task_tag_links` GROUP BY `task_id`, `tag_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `games_key_unique` ON `games` (`key`);--> statement-breakpoint
CREATE INDEX `milestones_game_date` ON `milestones` (`game_id`,`date`);--> statement-breakpoint
CREATE INDEX `tags_game_name` ON `tags` (`game_id`,`name`);--> statement-breakpoint
CREATE INDEX `task_checklist_task_order` ON `task_checklist_items` (`task_id`,`sort_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_dependencies_pair_unique` ON `task_dependencies` (`blocker_task_id`,`blocked_task_id`);--> statement-breakpoint
CREATE INDEX `task_dependencies_blocked` ON `task_dependencies` (`blocked_task_id`);--> statement-breakpoint
CREATE INDEX `task_dependencies_blocker` ON `task_dependencies` (`blocker_task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_links_pair_unique` ON `task_links` (`task_id`,`related_task_id`,`relation`);--> statement-breakpoint
CREATE INDEX `task_links_related` ON `task_links` (`related_task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_tag_links_pair_unique` ON `task_tag_links` (`task_id`,`tag_id`);--> statement-breakpoint
CREATE INDEX `task_tag_links_tag` ON `task_tag_links` (`tag_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_game_seq_unique` ON `tasks` (`game_id`,`seq`);--> statement-breakpoint
CREATE INDEX `tasks_game_order` ON `tasks` (`game_id`,`sort_order`,`created_at`);--> statement-breakpoint
CREATE INDEX `tasks_game_status` ON `tasks` (`game_id`,`status`);--> statement-breakpoint
CREATE INDEX `tasks_milestone` ON `tasks` (`milestone_id`);
