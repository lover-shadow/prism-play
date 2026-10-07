CREATE TABLE discovery_cards (
  work_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL CHECK(provider_id IN ('provider_s1', 'provider_m1')),
  source_id TEXT NOT NULL,
  candidate_json TEXT NOT NULL CHECK(json_valid(candidate_json)),
  card_json TEXT NOT NULL CHECK(json_valid(card_json)),
  updated_at INTEGER NOT NULL,
  UNIQUE(provider_id, source_id)
);
CREATE TRIGGER discovery_card_insert AFTER INSERT ON discovery_cards BEGIN
  INSERT INTO discovery_changes(work_id, operation, card_json, updated_at)
  VALUES(NEW.work_id, 'upsert', NEW.card_json, NEW.updated_at);
END;
CREATE TRIGGER discovery_card_update AFTER UPDATE ON discovery_cards
WHEN OLD.card_json != NEW.card_json BEGIN
  INSERT INTO discovery_changes(work_id, operation, card_json, updated_at)
  VALUES(NEW.work_id, 'upsert', NEW.card_json, NEW.updated_at);
END;
