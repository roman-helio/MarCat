PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `workspace_configs_new` (
  `game_id` text PRIMARY KEY NOT NULL,
  `root_path` text NOT NULL,
  `workspace_folder` text DEFAULT 'MarCat' NOT NULL,
  `enabled` integer DEFAULT false NOT NULL,
  `schema_version` integer DEFAULT 1 NOT NULL,
  `last_scan_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `workspace_configs_new` SELECT * FROM `workspace_configs`;
--> statement-breakpoint
CREATE TABLE `workspace_files_new` (
  `id` text PRIMARY KEY NOT NULL,
  `game_id` text NOT NULL,
  `entity_type` text NOT NULL,
  `entity_id` text NOT NULL,
  `relative_path` text NOT NULL,
  `content_hash` text NOT NULL,
  `base_hash` text NOT NULL,
  `base_content` text NOT NULL,
  `revision` integer DEFAULT 1 NOT NULL,
  `status` text DEFAULT 'synced' NOT NULL,
  `missing_since` text,
  `mtime_ms` integer,
  `size` integer,
  `last_synced_at` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `workspace_files_new` SELECT * FROM `workspace_files`;
--> statement-breakpoint
CREATE TABLE `workspace_sync_issues_new` (
  `id` text PRIMARY KEY NOT NULL,
  `game_id` text NOT NULL,
  `workspace_file_id` text,
  `kind` text NOT NULL,
  `severity` text DEFAULT 'error' NOT NULL,
  `relative_path` text,
  `message` text NOT NULL,
  `details_json` text DEFAULT '{}' NOT NULL,
  `resolved_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_file_id`) REFERENCES `workspace_files_new`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `workspace_sync_issues_new` SELECT * FROM `workspace_sync_issues`;
--> statement-breakpoint
CREATE TABLE `workspace_outbox_new` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `game_id` text NOT NULL,
  `entity_type` text NOT NULL,
  `entity_id` text NOT NULL,
  `operation` text DEFAULT 'upsert' NOT NULL,
  `payload_json` text DEFAULT '{}' NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL,
  `next_attempt_at` text,
  `claimed_at` text,
  `last_error` text,
  `created_at` text NOT NULL,
  `processed_at` text
);
--> statement-breakpoint
INSERT INTO `workspace_outbox_new` SELECT * FROM `workspace_outbox`;
--> statement-breakpoint
DROP TABLE `workspace_sync_issues`;
--> statement-breakpoint
DROP TABLE `workspace_outbox`;
--> statement-breakpoint
DROP TABLE `workspace_files`;
--> statement-breakpoint
DROP TABLE `workspace_configs`;
--> statement-breakpoint
ALTER TABLE `workspace_configs_new` RENAME TO `workspace_configs`;
--> statement-breakpoint
ALTER TABLE `workspace_files_new` RENAME TO `workspace_files`;
--> statement-breakpoint
ALTER TABLE `workspace_sync_issues_new` RENAME TO `workspace_sync_issues`;
--> statement-breakpoint
ALTER TABLE `workspace_outbox_new` RENAME TO `workspace_outbox`;
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_files_game_path_unique` ON `workspace_files` (`game_id`,`relative_path`);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_files_game_entity_unique` ON `workspace_files` (`game_id`,`entity_type`,`entity_id`);
--> statement-breakpoint
CREATE INDEX `workspace_files_game_status` ON `workspace_files` (`game_id`,`status`);
--> statement-breakpoint
CREATE INDEX `workspace_sync_issues_game_open` ON `workspace_sync_issues` (`game_id`,`resolved_at`);
--> statement-breakpoint
CREATE INDEX `workspace_sync_issues_file` ON `workspace_sync_issues` (`workspace_file_id`);
--> statement-breakpoint
CREATE INDEX `workspace_outbox_pending` ON `workspace_outbox` (`processed_at`,`next_attempt_at`,`id`);
--> statement-breakpoint
CREATE INDEX `workspace_outbox_entity` ON `workspace_outbox` (`game_id`,`entity_type`,`entity_id`);
--> statement-breakpoint
CREATE TABLE `workspace_import_guard` (`game_id` text NOT NULL, `owner` text NOT NULL, `created_at` text NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_import_guard_identity` ON `workspace_import_guard` (`game_id`,`owner`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint

-- Managed root entities. Triggers only pay the outbox cost for enabled projects.
CREATE TRIGGER `workspace_games_update` AFTER UPDATE ON `games`
WHEN EXISTS (SELECT 1 FROM workspace_configs c WHERE c.game_id=NEW.id AND c.enabled=1)
 AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g WHERE g.game_id=NEW.id)
BEGIN
  INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at)
  SELECT NEW.id,'project',NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=NEW.id AND o.entity_type='project' AND o.entity_id=NEW.id AND o.processed_at IS NULL);
  INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at)
  SELECT NEW.id,'task',t.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM tasks t WHERE t.game_id=NEW.id
    AND NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=NEW.id AND o.entity_type='task' AND o.entity_id=t.id AND o.processed_at IS NULL);
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_games_delete` BEFORE DELETE ON `games`
WHEN EXISTS (SELECT 1 FROM workspace_configs c WHERE c.game_id=OLD.id AND c.enabled=1)
BEGIN
  INSERT INTO workspace_outbox(game_id,entity_type,entity_id,operation,payload_json,created_at)
  SELECT OLD.id,f.entity_type,f.entity_id,'quarantine',json_object('reason','project_deleted'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM workspace_files f WHERE f.game_id=OLD.id AND f.status<>'quarantined'
    AND NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=OLD.id AND o.entity_type=f.entity_type AND o.entity_id=f.entity_id AND o.operation='quarantine' AND o.processed_at IS NULL);
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_project_cards_insert` AFTER INSERT ON `project_cards`
WHEN EXISTS (SELECT 1 FROM workspace_configs c WHERE c.game_id=NEW.game_id AND c.enabled=1)
 AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g WHERE g.game_id=NEW.game_id)
BEGIN
  INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at)
  SELECT NEW.game_id,'project',NEW.game_id,strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=NEW.game_id AND o.entity_type='project' AND o.entity_id=NEW.game_id AND o.processed_at IS NULL);
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_project_cards_update` AFTER UPDATE ON `project_cards`
WHEN EXISTS (SELECT 1 FROM workspace_configs c WHERE c.game_id=NEW.game_id AND c.enabled=1)
 AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g WHERE g.game_id=NEW.game_id)
BEGIN
  INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at)
  SELECT NEW.game_id,'project',NEW.game_id,strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=NEW.game_id AND o.entity_type='project' AND o.entity_id=NEW.game_id AND o.processed_at IS NULL);
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_project_cards_delete` AFTER DELETE ON `project_cards`
WHEN EXISTS (SELECT 1 FROM workspace_configs c WHERE c.game_id=OLD.game_id AND c.enabled=1)
BEGIN
  INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at)
  SELECT OLD.game_id,'project',OLD.game_id,strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=OLD.game_id AND o.entity_type='project' AND o.entity_id=OLD.game_id AND o.processed_at IS NULL);
END;
--> statement-breakpoint

CREATE TRIGGER `workspace_insights_insert` AFTER INSERT ON `insights`
WHEN EXISTS (SELECT 1 FROM workspace_configs c WHERE c.game_id=NEW.game_id AND c.enabled=1) AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g WHERE g.game_id=NEW.game_id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT NEW.game_id,'insight',NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=NEW.game_id AND o.entity_type='insight' AND o.entity_id=NEW.id AND o.processed_at IS NULL); END;
--> statement-breakpoint
CREATE TRIGGER `workspace_insights_update` AFTER UPDATE ON `insights`
WHEN EXISTS (SELECT 1 FROM workspace_configs c WHERE c.game_id=NEW.game_id AND c.enabled=1) AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g WHERE g.game_id=NEW.game_id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT NEW.game_id,'insight',NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=NEW.game_id AND o.entity_type='insight' AND o.entity_id=NEW.id AND o.processed_at IS NULL); END;
--> statement-breakpoint
CREATE TRIGGER `workspace_insights_delete` BEFORE DELETE ON `insights`
WHEN EXISTS (SELECT 1 FROM workspace_configs c WHERE c.game_id=OLD.game_id AND c.enabled=1)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,operation,payload_json,created_at) SELECT OLD.game_id,'insight',OLD.id,'quarantine',json_object('title',OLD.title,'body',OLD.body,'createdBy',OLD.created_by,'createdAt',OLD.created_at,'updatedAt',OLD.updated_at),strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=OLD.game_id AND o.entity_type='insight' AND o.entity_id=OLD.id AND o.operation='quarantine' AND o.processed_at IS NULL); END;
--> statement-breakpoint

CREATE TRIGGER `workspace_tasks_insert` AFTER INSERT ON `tasks`
WHEN EXISTS (SELECT 1 FROM workspace_configs c WHERE c.game_id=NEW.game_id AND c.enabled=1) AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g WHERE g.game_id=NEW.game_id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT NEW.game_id,'task',NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=NEW.game_id AND o.entity_type='task' AND o.entity_id=NEW.id AND o.processed_at IS NULL); END;
--> statement-breakpoint
CREATE TRIGGER `workspace_tasks_update` AFTER UPDATE ON `tasks`
WHEN EXISTS (SELECT 1 FROM workspace_configs c WHERE c.game_id=NEW.game_id AND c.enabled=1) AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g WHERE g.game_id=NEW.game_id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT NEW.game_id,'task',NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=NEW.game_id AND o.entity_type='task' AND o.entity_id=NEW.id AND o.processed_at IS NULL); END;
--> statement-breakpoint
CREATE TRIGGER `workspace_tasks_delete` BEFORE DELETE ON `tasks`
WHEN EXISTS (SELECT 1 FROM workspace_configs c WHERE c.game_id=OLD.game_id AND c.enabled=1)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,operation,payload_json,created_at) SELECT OLD.game_id,'task',OLD.id,'quarantine',json_object('seq',OLD.seq,'title',OLD.title,'description',OLD.description,'status',OLD.status,'priority',OLD.priority,'startDate',OLD.start_date,'dueDate',OLD.due_date,'reminderAt',OLD.reminder_at,'completedAt',OLD.completed_at,'sortOrder',OLD.sort_order,'createdAt',OLD.created_at,'updatedAt',OLD.updated_at),strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=OLD.game_id AND o.entity_type='task' AND o.entity_id=OLD.id AND o.operation='quarantine' AND o.processed_at IS NULL); END;
--> statement-breakpoint

CREATE TRIGGER `workspace_checklist_insert` AFTER INSERT ON `task_checklist_items`
WHEN EXISTS (SELECT 1 FROM tasks t JOIN workspace_configs c ON c.game_id=t.game_id AND c.enabled=1 WHERE t.id=NEW.task_id) AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g JOIN tasks t ON t.game_id=g.game_id WHERE t.id=NEW.task_id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT t.game_id,'task',t.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM tasks t WHERE t.id=NEW.task_id AND NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=t.game_id AND o.entity_type='task' AND o.entity_id=t.id AND o.processed_at IS NULL); END;
--> statement-breakpoint
CREATE TRIGGER `workspace_checklist_update` AFTER UPDATE ON `task_checklist_items`
WHEN EXISTS (SELECT 1 FROM tasks t JOIN workspace_configs c ON c.game_id=t.game_id AND c.enabled=1 WHERE t.id=NEW.task_id) AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g JOIN tasks t ON t.game_id=g.game_id WHERE t.id=NEW.task_id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT t.game_id,'task',t.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM tasks t WHERE t.id=NEW.task_id AND NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=t.game_id AND o.entity_type='task' AND o.entity_id=t.id AND o.processed_at IS NULL); END;
--> statement-breakpoint
CREATE TRIGGER `workspace_checklist_delete` BEFORE DELETE ON `task_checklist_items`
WHEN EXISTS (SELECT 1 FROM tasks t JOIN workspace_configs c ON c.game_id=t.game_id AND c.enabled=1 WHERE t.id=OLD.task_id) AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g JOIN tasks t ON t.game_id=g.game_id WHERE t.id=OLD.task_id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT t.game_id,'task',t.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM tasks t WHERE t.id=OLD.task_id AND NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=t.game_id AND o.entity_type='task' AND o.entity_id=t.id AND o.processed_at IS NULL); END;
--> statement-breakpoint

CREATE TRIGGER `workspace_dependencies_insert` AFTER INSERT ON `task_dependencies`
WHEN EXISTS (SELECT 1 FROM tasks t JOIN workspace_configs c ON c.game_id=t.game_id AND c.enabled=1 WHERE t.id=NEW.blocked_task_id) AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g JOIN tasks t ON t.game_id=g.game_id WHERE t.id=NEW.blocked_task_id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT t.game_id,'task',t.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM tasks t WHERE t.id=NEW.blocked_task_id AND NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=t.game_id AND o.entity_type='task' AND o.entity_id=t.id AND o.processed_at IS NULL); END;
--> statement-breakpoint
CREATE TRIGGER `workspace_dependencies_delete` BEFORE DELETE ON `task_dependencies`
WHEN EXISTS (SELECT 1 FROM tasks t JOIN workspace_configs c ON c.game_id=t.game_id AND c.enabled=1 WHERE t.id=OLD.blocked_task_id) AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g JOIN tasks t ON t.game_id=g.game_id WHERE t.id=OLD.blocked_task_id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT t.game_id,'task',t.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM tasks t WHERE t.id=OLD.blocked_task_id AND NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=t.game_id AND o.entity_type='task' AND o.entity_id=t.id AND o.processed_at IS NULL); END;
--> statement-breakpoint

CREATE TRIGGER `workspace_task_tags_insert` AFTER INSERT ON `task_tag_links`
WHEN EXISTS (SELECT 1 FROM tasks t JOIN workspace_configs c ON c.game_id=t.game_id AND c.enabled=1 WHERE t.id=NEW.task_id) AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g JOIN tasks t ON t.game_id=g.game_id WHERE t.id=NEW.task_id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT t.game_id,'task',t.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM tasks t WHERE t.id=NEW.task_id AND NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=t.game_id AND o.entity_type='task' AND o.entity_id=t.id AND o.processed_at IS NULL); END;
--> statement-breakpoint
CREATE TRIGGER `workspace_task_tags_delete` BEFORE DELETE ON `task_tag_links`
WHEN EXISTS (SELECT 1 FROM tasks t JOIN workspace_configs c ON c.game_id=t.game_id AND c.enabled=1 WHERE t.id=OLD.task_id) AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g JOIN tasks t ON t.game_id=g.game_id WHERE t.id=OLD.task_id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT t.game_id,'task',t.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM tasks t WHERE t.id=OLD.task_id AND NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=t.game_id AND o.entity_type='task' AND o.entity_id=t.id AND o.processed_at IS NULL); END;
--> statement-breakpoint

CREATE TRIGGER `workspace_tags_insert` AFTER INSERT ON `tags`
WHEN EXISTS (SELECT 1 FROM workspace_configs c WHERE c.game_id=NEW.game_id AND c.enabled=1) AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g WHERE g.game_id=NEW.game_id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT NEW.game_id,'tag',NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=NEW.game_id AND o.entity_type='tag' AND o.entity_id=NEW.id AND o.processed_at IS NULL); END;
--> statement-breakpoint
CREATE TRIGGER `workspace_tags_update` AFTER UPDATE ON `tags`
WHEN EXISTS (SELECT 1 FROM workspace_configs c WHERE c.game_id=NEW.game_id AND c.enabled=1) AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g WHERE g.game_id=NEW.game_id)
BEGIN
 INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT NEW.game_id,'tag',NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=NEW.game_id AND o.entity_type='tag' AND o.entity_id=NEW.id AND o.processed_at IS NULL);
 INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT NEW.game_id,'task',l.task_id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM task_tag_links l WHERE l.tag_id=NEW.id AND NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=NEW.game_id AND o.entity_type='task' AND o.entity_id=l.task_id AND o.processed_at IS NULL);
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_tags_delete` BEFORE DELETE ON `tags`
WHEN EXISTS (SELECT 1 FROM workspace_configs c WHERE c.game_id=OLD.game_id AND c.enabled=1)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,operation,payload_json,created_at) SELECT OLD.game_id,'tag',OLD.id,'quarantine',json_object('name',OLD.name,'color',OLD.color,'colorEnabled',OLD.color_enabled,'targetDate',OLD.target_date,'tagType',OLD.type),strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=OLD.game_id AND o.entity_type='tag' AND o.entity_id=OLD.id AND o.operation='quarantine' AND o.processed_at IS NULL); END;
--> statement-breakpoint

CREATE TRIGGER `workspace_events_insert` AFTER INSERT ON `events`
WHEN EXISTS (SELECT 1 FROM workspace_configs c WHERE c.game_id=NEW.game_id AND c.enabled=1) AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g WHERE g.game_id=NEW.game_id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT NEW.game_id,'activity',NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=NEW.game_id AND o.entity_type='activity' AND o.entity_id=NEW.id AND o.processed_at IS NULL); END;
--> statement-breakpoint
CREATE TRIGGER `workspace_events_update` AFTER UPDATE ON `events`
WHEN EXISTS (SELECT 1 FROM workspace_configs c WHERE c.game_id=NEW.game_id AND c.enabled=1) AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g WHERE g.game_id=NEW.game_id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT NEW.game_id,'activity',NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=NEW.game_id AND o.entity_type='activity' AND o.entity_id=NEW.id AND o.processed_at IS NULL); END;
--> statement-breakpoint
CREATE TRIGGER `workspace_events_delete` BEFORE DELETE ON `events`
WHEN EXISTS (SELECT 1 FROM workspace_configs c WHERE c.game_id=OLD.game_id AND c.enabled=1)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,operation,payload_json,created_at) SELECT OLD.game_id,'activity',OLD.id,'quarantine',json_object('occurredAt',OLD.occurred_at,'subjectType',OLD.subject_type,'subjectId',OLD.subject_id,'subjectLabel',OLD.subject_label,'showOnWishlist',OLD.show_on_wishlist,'direction',OLD.direction,'channel',OLD.channel,'statusAfter',OLD.status_after,'templateId',OLD.template_id,'activityType',OLD.type,'platform',OLD.platform,'placement',OLD.placement,'title',OLD.title,'description',OLD.description,'url',OLD.url,'views',OLD.views,'likes',OLD.likes,'comments',OLD.comments,'isOwn',OLD.is_own,'sourceId',OLD.source_id,'externalId',OLD.external_id,'creatorId',OLD.creator_id,'createdBy',OLD.created_by,'createdAt',OLD.created_at,'updatedAt',OLD.updated_at),strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=OLD.game_id AND o.entity_type='activity' AND o.entity_id=OLD.id AND o.operation='quarantine' AND o.processed_at IS NULL); END;
