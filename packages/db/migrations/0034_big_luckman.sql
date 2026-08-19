ALTER TABLE `analytics_imports` ADD `checksum` text;--> statement-breakpoint
ALTER TABLE `analytics_imports` ADD `warnings_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `analytics_imports` ADD `parser_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `wishlist_imports` ADD `checksum` text;--> statement-breakpoint
ALTER TABLE `wishlist_imports` ADD `warnings_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `wishlist_points` ADD `purchases_and_activations` integer;