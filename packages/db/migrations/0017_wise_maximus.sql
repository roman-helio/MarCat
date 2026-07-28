ALTER TABLE `events` ADD `placement` text;
--> statement-breakpoint
UPDATE `events`
SET `placement` = `channel`
WHERE `placement` IS NULL
  AND lower(`platform`) = 'reddit'
  AND lower(`channel`) LIKE 'r/%';
--> statement-breakpoint
UPDATE `events`
SET `direction` = NULL,
    `channel` = NULL
WHERE lower(`platform`) = 'reddit'
  AND lower(`channel`) LIKE 'r/%';
--> statement-breakpoint
UPDATE `events`
SET `platform` = lower(`platform`)
WHERE lower(`platform`) IN ('youtube', 'twitter', 'tiktok', 'instagram', 'reddit', 'telegram', 'steam', 'press', 'other');
--> statement-breakpoint
UPDATE `events`
SET `type` = CASE
  WHEN `type` IN ('tweet', 'reddit', 'reddit_post', 'tiktok', 'instagram', 'telegram') THEN 'post'
  WHEN `type` IN ('youtube_own', 'youtube_external') THEN 'video'
  WHEN `type` IN ('steam_update', 'build', 'launch') THEN 'update'
  WHEN `type` IN ('post', 'video', 'stream', 'press', 'festival', 'update', 'other') THEN `type`
  ELSE 'other'
END;
--> statement-breakpoint
UPDATE `events`
SET `status_after` = NULL
WHERE `subject_type` NOT IN ('festival', 'creator');
--> statement-breakpoint
UPDATE `events`
SET `channel` = 'other'
WHERE `direction` IS NOT NULL
  AND `channel` NOT IN ('email', 'dm', 'form', 'call', 'meeting', 'other');
