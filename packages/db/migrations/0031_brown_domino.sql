ALTER TABLE `events` ADD `idempotency_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `events_idempotency_key_unique` ON `events` (`idempotency_key`);