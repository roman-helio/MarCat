ALTER TABLE `workspace_import_guard` ADD COLUMN `entity_type` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `workspace_import_guard` ADD COLUMN `entity_id` text NOT NULL DEFAULT '';
--> statement-breakpoint

-- Scope import suppression to the exact entity. A game-wide marker could hide
-- an unrelated desktop/MCP mutation committed while another process imported a file.
DROP TRIGGER `workspace_games_update`;
--> statement-breakpoint
CREATE TRIGGER `workspace_games_update` AFTER UPDATE ON `games`
WHEN EXISTS (SELECT 1 FROM workspace_configs c WHERE c.game_id=NEW.id AND c.enabled=1)
BEGIN
  INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at)
  SELECT NEW.id,'project',NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE NOT EXISTS (SELECT 1 FROM workspace_import_guard g WHERE g.game_id=NEW.id AND g.entity_type='project' AND g.entity_id=NEW.id)
    AND NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=NEW.id AND o.entity_type='project' AND o.entity_id=NEW.id AND o.processed_at IS NULL);
  INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at)
  SELECT NEW.id,'task',t.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM tasks t WHERE t.game_id=NEW.id
    AND NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=NEW.id AND o.entity_type='task' AND o.entity_id=t.id AND o.processed_at IS NULL);
END;
--> statement-breakpoint

DROP TRIGGER `workspace_project_cards_insert`;
--> statement-breakpoint
CREATE TRIGGER `workspace_project_cards_insert` AFTER INSERT ON `project_cards`
WHEN EXISTS (SELECT 1 FROM workspace_configs c WHERE c.game_id=NEW.game_id AND c.enabled=1)
 AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g WHERE g.game_id=NEW.game_id AND g.entity_type='project' AND g.entity_id=NEW.game_id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT NEW.game_id,'project',NEW.game_id,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=NEW.game_id AND o.entity_type='project' AND o.entity_id=NEW.game_id AND o.processed_at IS NULL); END;
--> statement-breakpoint
DROP TRIGGER `workspace_project_cards_update`;
--> statement-breakpoint
CREATE TRIGGER `workspace_project_cards_update` AFTER UPDATE ON `project_cards`
WHEN EXISTS (SELECT 1 FROM workspace_configs c WHERE c.game_id=NEW.game_id AND c.enabled=1)
 AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g WHERE g.game_id=NEW.game_id AND g.entity_type='project' AND g.entity_id=NEW.game_id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT NEW.game_id,'project',NEW.game_id,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=NEW.game_id AND o.entity_type='project' AND o.entity_id=NEW.game_id AND o.processed_at IS NULL); END;
--> statement-breakpoint

DROP TRIGGER `workspace_insights_insert`;
--> statement-breakpoint
CREATE TRIGGER `workspace_insights_insert` AFTER INSERT ON `insights`
WHEN EXISTS (SELECT 1 FROM workspace_configs c WHERE c.game_id=NEW.game_id AND c.enabled=1) AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g WHERE g.game_id=NEW.game_id AND g.entity_type='insight' AND g.entity_id=NEW.id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT NEW.game_id,'insight',NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=NEW.game_id AND o.entity_type='insight' AND o.entity_id=NEW.id AND o.processed_at IS NULL); END;
--> statement-breakpoint
DROP TRIGGER `workspace_insights_update`;
--> statement-breakpoint
CREATE TRIGGER `workspace_insights_update` AFTER UPDATE ON `insights`
WHEN EXISTS (SELECT 1 FROM workspace_configs c WHERE c.game_id=NEW.game_id AND c.enabled=1) AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g WHERE g.game_id=NEW.game_id AND g.entity_type='insight' AND g.entity_id=NEW.id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT NEW.game_id,'insight',NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=NEW.game_id AND o.entity_type='insight' AND o.entity_id=NEW.id AND o.processed_at IS NULL); END;
--> statement-breakpoint

DROP TRIGGER `workspace_tasks_insert`;
--> statement-breakpoint
CREATE TRIGGER `workspace_tasks_insert` AFTER INSERT ON `tasks`
WHEN EXISTS (SELECT 1 FROM workspace_configs c WHERE c.game_id=NEW.game_id AND c.enabled=1) AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g WHERE g.game_id=NEW.game_id AND g.entity_type='task' AND g.entity_id=NEW.id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT NEW.game_id,'task',NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=NEW.game_id AND o.entity_type='task' AND o.entity_id=NEW.id AND o.processed_at IS NULL); END;
--> statement-breakpoint
DROP TRIGGER `workspace_tasks_update`;
--> statement-breakpoint
CREATE TRIGGER `workspace_tasks_update` AFTER UPDATE ON `tasks`
WHEN EXISTS (SELECT 1 FROM workspace_configs c WHERE c.game_id=NEW.game_id AND c.enabled=1) AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g WHERE g.game_id=NEW.game_id AND g.entity_type='task' AND g.entity_id=NEW.id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT NEW.game_id,'task',NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=NEW.game_id AND o.entity_type='task' AND o.entity_id=NEW.id AND o.processed_at IS NULL); END;
--> statement-breakpoint

DROP TRIGGER `workspace_checklist_insert`;
--> statement-breakpoint
CREATE TRIGGER `workspace_checklist_insert` AFTER INSERT ON `task_checklist_items`
WHEN EXISTS (SELECT 1 FROM tasks t JOIN workspace_configs c ON c.game_id=t.game_id AND c.enabled=1 WHERE t.id=NEW.task_id) AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g JOIN tasks t ON t.game_id=g.game_id WHERE t.id=NEW.task_id AND g.entity_type='task' AND g.entity_id=NEW.task_id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT t.game_id,'task',t.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM tasks t WHERE t.id=NEW.task_id AND NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=t.game_id AND o.entity_type='task' AND o.entity_id=t.id AND o.processed_at IS NULL); END;
--> statement-breakpoint
DROP TRIGGER `workspace_checklist_update`;
--> statement-breakpoint
CREATE TRIGGER `workspace_checklist_update` AFTER UPDATE ON `task_checklist_items`
WHEN EXISTS (SELECT 1 FROM tasks t JOIN workspace_configs c ON c.game_id=t.game_id AND c.enabled=1 WHERE t.id=NEW.task_id) AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g JOIN tasks t ON t.game_id=g.game_id WHERE t.id=NEW.task_id AND g.entity_type='task' AND g.entity_id=NEW.task_id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT t.game_id,'task',t.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM tasks t WHERE t.id=NEW.task_id AND NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=t.game_id AND o.entity_type='task' AND o.entity_id=t.id AND o.processed_at IS NULL); END;
--> statement-breakpoint
DROP TRIGGER `workspace_checklist_delete`;
--> statement-breakpoint
CREATE TRIGGER `workspace_checklist_delete` BEFORE DELETE ON `task_checklist_items`
WHEN EXISTS (SELECT 1 FROM tasks t JOIN workspace_configs c ON c.game_id=t.game_id AND c.enabled=1 WHERE t.id=OLD.task_id) AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g JOIN tasks t ON t.game_id=g.game_id WHERE t.id=OLD.task_id AND g.entity_type='task' AND g.entity_id=OLD.task_id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT t.game_id,'task',t.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM tasks t WHERE t.id=OLD.task_id AND NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=t.game_id AND o.entity_type='task' AND o.entity_id=t.id AND o.processed_at IS NULL); END;
--> statement-breakpoint

DROP TRIGGER `workspace_dependencies_insert`;
--> statement-breakpoint
CREATE TRIGGER `workspace_dependencies_insert` AFTER INSERT ON `task_dependencies`
WHEN EXISTS (SELECT 1 FROM tasks t JOIN workspace_configs c ON c.game_id=t.game_id AND c.enabled=1 WHERE t.id=NEW.blocked_task_id) AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g JOIN tasks t ON t.game_id=g.game_id WHERE t.id=NEW.blocked_task_id AND g.entity_type='task' AND g.entity_id=NEW.blocked_task_id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT t.game_id,'task',t.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM tasks t WHERE t.id=NEW.blocked_task_id AND NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=t.game_id AND o.entity_type='task' AND o.entity_id=t.id AND o.processed_at IS NULL); END;
--> statement-breakpoint
DROP TRIGGER `workspace_dependencies_delete`;
--> statement-breakpoint
CREATE TRIGGER `workspace_dependencies_delete` BEFORE DELETE ON `task_dependencies`
WHEN EXISTS (SELECT 1 FROM tasks t JOIN workspace_configs c ON c.game_id=t.game_id AND c.enabled=1 WHERE t.id=OLD.blocked_task_id) AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g JOIN tasks t ON t.game_id=g.game_id WHERE t.id=OLD.blocked_task_id AND g.entity_type='task' AND g.entity_id=OLD.blocked_task_id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT t.game_id,'task',t.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM tasks t WHERE t.id=OLD.blocked_task_id AND NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=t.game_id AND o.entity_type='task' AND o.entity_id=t.id AND o.processed_at IS NULL); END;
--> statement-breakpoint

DROP TRIGGER `workspace_task_tags_insert`;
--> statement-breakpoint
CREATE TRIGGER `workspace_task_tags_insert` AFTER INSERT ON `task_tag_links`
WHEN EXISTS (SELECT 1 FROM tasks t JOIN workspace_configs c ON c.game_id=t.game_id AND c.enabled=1 WHERE t.id=NEW.task_id) AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g JOIN tasks t ON t.game_id=g.game_id WHERE t.id=NEW.task_id AND g.entity_type='task' AND g.entity_id=NEW.task_id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT t.game_id,'task',t.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM tasks t WHERE t.id=NEW.task_id AND NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=t.game_id AND o.entity_type='task' AND o.entity_id=t.id AND o.processed_at IS NULL); END;
--> statement-breakpoint
DROP TRIGGER `workspace_task_tags_delete`;
--> statement-breakpoint
CREATE TRIGGER `workspace_task_tags_delete` BEFORE DELETE ON `task_tag_links`
WHEN EXISTS (SELECT 1 FROM tasks t JOIN workspace_configs c ON c.game_id=t.game_id AND c.enabled=1 WHERE t.id=OLD.task_id) AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g JOIN tasks t ON t.game_id=g.game_id WHERE t.id=OLD.task_id AND g.entity_type='task' AND g.entity_id=OLD.task_id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT t.game_id,'task',t.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM tasks t WHERE t.id=OLD.task_id AND NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=t.game_id AND o.entity_type='task' AND o.entity_id=t.id AND o.processed_at IS NULL); END;
--> statement-breakpoint

DROP TRIGGER `workspace_tags_insert`;
--> statement-breakpoint
CREATE TRIGGER `workspace_tags_insert` AFTER INSERT ON `tags`
WHEN EXISTS (SELECT 1 FROM workspace_configs c WHERE c.game_id=NEW.game_id AND c.enabled=1) AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g WHERE g.game_id=NEW.game_id AND g.entity_type='tag' AND g.entity_id=NEW.id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT NEW.game_id,'tag',NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=NEW.game_id AND o.entity_type='tag' AND o.entity_id=NEW.id AND o.processed_at IS NULL); END;
--> statement-breakpoint
DROP TRIGGER `workspace_tags_update`;
--> statement-breakpoint
CREATE TRIGGER `workspace_tags_update` AFTER UPDATE ON `tags`
WHEN EXISTS (SELECT 1 FROM workspace_configs c WHERE c.game_id=NEW.game_id AND c.enabled=1)
BEGIN
 INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT NEW.game_id,'tag',NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM workspace_import_guard g WHERE g.game_id=NEW.game_id AND g.entity_type='tag' AND g.entity_id=NEW.id) AND NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=NEW.game_id AND o.entity_type='tag' AND o.entity_id=NEW.id AND o.processed_at IS NULL);
 INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT NEW.game_id,'task',l.task_id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM task_tag_links l WHERE l.tag_id=NEW.id AND NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=NEW.game_id AND o.entity_type='task' AND o.entity_id=l.task_id AND o.processed_at IS NULL);
END;
--> statement-breakpoint

DROP TRIGGER `workspace_events_insert`;
--> statement-breakpoint
CREATE TRIGGER `workspace_events_insert` AFTER INSERT ON `events`
WHEN EXISTS (SELECT 1 FROM workspace_configs c WHERE c.game_id=NEW.game_id AND c.enabled=1) AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g WHERE g.game_id=NEW.game_id AND g.entity_type='activity' AND g.entity_id=NEW.id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT NEW.game_id,'activity',NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=NEW.game_id AND o.entity_type='activity' AND o.entity_id=NEW.id AND o.processed_at IS NULL); END;
--> statement-breakpoint
DROP TRIGGER `workspace_events_update`;
--> statement-breakpoint
CREATE TRIGGER `workspace_events_update` AFTER UPDATE ON `events`
WHEN EXISTS (SELECT 1 FROM workspace_configs c WHERE c.game_id=NEW.game_id AND c.enabled=1) AND NOT EXISTS (SELECT 1 FROM workspace_import_guard g WHERE g.game_id=NEW.game_id AND g.entity_type='activity' AND g.entity_id=NEW.id)
BEGIN INSERT INTO workspace_outbox(game_id,entity_type,entity_id,created_at) SELECT NEW.game_id,'activity',NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM workspace_outbox o WHERE o.game_id=NEW.game_id AND o.entity_type='activity' AND o.entity_id=NEW.id AND o.processed_at IS NULL); END;
