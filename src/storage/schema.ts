/**
 * SQLite schema. Two main tables:
 *   - jobs: rolling DB of board jobs
 *   - agency_jobs: rolling DB of agency jobs (separate lifecycle)
 *   - scan_log: history of every scan with per-source stats
 *
 * Both job tables share the same shape — we use a flag (`is_agency`) and
 * separate tables for clean queries and to keep the agency lifecycle
 * (longer staleness tolerance) distinct from board jobs.
 */

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  location TEXT,
  country TEXT,
  remote TEXT,
  url TEXT,
  description_snippet TEXT,
  language TEXT DEFAULT 'en',
  hard_language_requirement TEXT DEFAULT '',
  salary TEXT,
  posted_date TEXT,
  sources TEXT NOT NULL,           -- JSON array
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  scan_count INTEGER DEFAULT 1,
  score INTEGER DEFAULT 0,
  score_breakdown TEXT,            -- JSON object
  score_reasons TEXT,              -- JSON array
  language_risk INTEGER DEFAULT 0, -- boolean (0/1)
  status TEXT DEFAULT 'new',
  is_agency INTEGER DEFAULT 0,     -- boolean (0/1)
  career_ops TEXT DEFAULT '{}',    -- JSON object, untouched by scanner after creation
  enrichment TEXT DEFAULT '{}'     -- JSON object, populated by enrich command
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_score ON jobs(score DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_country ON jobs(country);
CREATE INDEX IF NOT EXISTS idx_jobs_last_seen ON jobs(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_is_agency ON jobs(is_agency);

-- Migration: add enrichment column if upgrading from an older schema
-- (SQLite ignores ADD COLUMN if it already exists via CREATE TABLE IF NOT EXISTS,
-- so we run it conditionally below in db.ts).

CREATE TABLE IF NOT EXISTS scan_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_date TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  mode TEXT NOT NULL,
  country_filter TEXT,
  stats TEXT NOT NULL,             -- JSON object
  per_source TEXT,                 -- JSON object
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_scan_log_date ON scan_log(scan_date DESC);
`;
