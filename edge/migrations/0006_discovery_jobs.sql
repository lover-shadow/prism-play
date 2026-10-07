-- Metadata only: resumable checkpoints (including media) belong to private DISCOVERY_BUCKET.
CREATE TABLE discovery_job_queries (
  qhash TEXT PRIMARY KEY,
  normalized_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'complete', 'failed')),
  search_failed INTEGER NOT NULL CHECK(search_failed IN (0, 1)),
  provider_has_more INTEGER NOT NULL CHECK(provider_has_more IN (0, 1)),
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE discovery_jobs (
  job_id TEXT PRIMARY KEY,
  qhash TEXT NOT NULL REFERENCES discovery_job_queries(qhash) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  provider_id TEXT NOT NULL CHECK(provider_id IN ('provider_s1', 'provider_m1')),
  work_id TEXT NOT NULL,
  candidate_json TEXT NOT NULL CHECK(json_valid(candidate_json) AND length(candidate_json) <= 8192),
  cursor_key TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending', 'published', 'skipped', 'failed')),
  updated_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  UNIQUE(qhash, work_id)
);
CREATE INDEX discovery_jobs_pending ON discovery_jobs(qhash, status, ordinal);
CREATE INDEX discovery_job_queries_expiry ON discovery_job_queries(status, expires_at);
