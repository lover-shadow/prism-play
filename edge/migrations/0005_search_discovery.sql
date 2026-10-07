-- Public discovery ledger only. Full facts live in a separately provisioned PRIVATE R2 bucket.
-- No references to deprecated content tables; timestamps are Unix seconds.
CREATE TABLE discovery_works (
  work_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  card_json TEXT NOT NULL CHECK(json_valid(card_json) AND length(card_json) <= 16384),
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
  fact_key TEXT NOT NULL,
  fact_hash TEXT NOT NULL CHECK(length(fact_hash) = 64),
  fact_bytes INTEGER NOT NULL CHECK(fact_bytes BETWEEN 1 AND 524288),
  UNIQUE(provider_id, source_id)
);
CREATE INDEX discovery_works_expiry ON discovery_works(enabled, expires_at);
CREATE TABLE discovery_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('upsert', 'withdraw')),
  card_json TEXT CHECK(card_json IS NULL OR json_valid(card_json)),
  updated_at INTEGER NOT NULL
);
CREATE TRIGGER discovery_insert_change AFTER INSERT ON discovery_works BEGIN
  INSERT INTO discovery_changes(work_id, operation, card_json, updated_at)
  VALUES(NEW.work_id, CASE WHEN NEW.enabled = 1 THEN 'upsert' ELSE 'withdraw' END,
    CASE WHEN NEW.enabled = 1 THEN NEW.card_json ELSE NULL END, NEW.updated_at);
END;
CREATE TRIGGER discovery_update_change AFTER UPDATE ON discovery_works
WHEN OLD.enabled != NEW.enabled OR OLD.fact_hash != NEW.fact_hash OR OLD.card_json != NEW.card_json
  OR OLD.expires_at != NEW.expires_at BEGIN
  INSERT INTO discovery_changes(work_id, operation, card_json, updated_at)
  VALUES(NEW.work_id, CASE WHEN NEW.enabled = 1 THEN 'upsert' ELSE 'withdraw' END,
    CASE WHEN NEW.enabled = 1 THEN NEW.card_json ELSE NULL END, NEW.updated_at);
END;
CREATE TABLE discovery_queries (
  qhash TEXT PRIMARY KEY,
  normalized_key TEXT NOT NULL CHECK(length(normalized_key) <= 1024),
  ids_json TEXT NOT NULL CHECK(json_valid(ids_json) AND length(ids_json) <= 32768),
  status TEXT NOT NULL CHECK(status IN ('success', 'empty')),
  fresh_until INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX discovery_queries_expiry ON discovery_queries(fresh_until);
CREATE TABLE discovery_leases (
  lease_key TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX discovery_leases_expiry ON discovery_leases(expires_at);
CREATE TABLE discovery_rate_windows (
  scope_key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL CHECK(hits >= 1),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(scope_key, window_start)
);
CREATE INDEX discovery_rate_expiry ON discovery_rate_windows(expires_at);
