-- A desktop/MCP process started before 0.2.0 writes legacy game-wide guards
-- with the new columns' empty defaults. During a rolling upgrade, remove the
-- outbox row emitted by those older imports so their watcher cannot loop.
-- New processes use exact entity guards and are suppressed by the domain
-- triggers themselves; project/tag propagation to related tasks remains intact.
CREATE TRIGGER `workspace_outbox_import_guard_cleanup` AFTER INSERT ON `workspace_outbox`
WHEN NEW.operation='upsert' AND EXISTS (
  SELECT 1 FROM workspace_import_guard g
  WHERE g.game_id=NEW.game_id
    AND (
      (g.entity_type=NEW.entity_type AND g.entity_id=NEW.entity_id)
      OR (g.entity_type='' AND g.entity_id='')
    )
)
BEGIN DELETE FROM workspace_outbox WHERE id=NEW.id; END;
