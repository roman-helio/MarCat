CREATE TABLE `gmass_campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'prepared' NOT NULL,
	`send_mode` text DEFAULT 'draft' NOT NULL,
	`send_at` text,
	`from_email` text NOT NULL,
	`subject_template` text NOT NULL,
	`body_template` text NOT NULL,
	`message_type` text DEFAULT 'plain' NOT NULL,
	`address_categories_json` text DEFAULT '[]' NOT NULL,
	`open_tracking` integer DEFAULT true NOT NULL,
	`click_tracking` integer DEFAULT true NOT NULL,
	`emails_per_day` integer,
	`requested_by` text DEFAULT 'manual' NOT NULL,
	`recipient_count` integer DEFAULT 0 NOT NULL,
	`content_hash` text NOT NULL,
	`approved_at` text,
	`sync_requested_at` text,
	`last_synced_at` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gmass_campaigns_game_created` ON `gmass_campaigns` (`game_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `gmass_recipients` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`creator_id` text NOT NULL,
	`email` text NOT NULL,
	`address_category` text NOT NULL,
	`verified` integer DEFAULT false NOT NULL,
	`keys_json` text DEFAULT '[]' NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'prepared' NOT NULL,
	`gmass_draft_id` text,
	`gmass_campaign_id` integer,
	`remote_status` text,
	`sent_at` text,
	`opened_at` text,
	`clicked_at` text,
	`replied_at` text,
	`bounced_at` text,
	`unsubscribed_at` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `gmass_campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`creator_id`) REFERENCES `creators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gmass_recipients_campaign_email` ON `gmass_recipients` (`campaign_id`,`email`);--> statement-breakpoint
CREATE INDEX `gmass_recipients_remote_campaign` ON `gmass_recipients` (`gmass_campaign_id`);