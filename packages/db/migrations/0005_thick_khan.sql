ALTER TABLE `tags` ADD `target_date` text;--> statement-breakpoint
ALTER TABLE `tags` ADD `type` text DEFAULT 'track' NOT NULL;--> statement-breakpoint
-- Migrate former milestones into dated tags, and their task links into tag links.
INSERT INTO `tags` (`id`, `game_id`, `name`, `color`, `target_date`, `type`)
  SELECT `id`, `game_id`, `name`, '#FF6A3D', `date`, `type` FROM `milestones`;--> statement-breakpoint
INSERT INTO `task_tag_links` (`task_id`, `tag_id`)
  SELECT `id`, `milestone_id` FROM `tasks` WHERE `milestone_id` IS NOT NULL;