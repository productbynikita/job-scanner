/**
 * SQLite connection + typed queries.
 *
 * better-sqlite3 is synchronous which is what we want: scans are batch
 * processes, not concurrent web servers. Synchronous code is simpler
 * and faster for this use case.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA } from './schema.js';
import type { Job, ScanStats } from '../types/job.js';

let dbInstance: Database.Database | null = null;

export function getDb(dbPath?: string): Database.Database {
  if (dbInstance) return dbInstance;

  const path = dbPath ?? process.env.JOB_SCANNER_DB ?? 'data/jobs.db';
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  // Migrations: add columns introduced in later phases. ALTER TABLE ADD COLUMN
  // throws if the column already exists, so we catch and ignore.
  const migrations = [
    `ALTER TABLE jobs ADD COLUMN enrichment TEXT DEFAULT '{}'`,
  ];
  for (const sql of migrations) {
    try {
      db.exec(sql);
    } catch (err) {
      // Column already exists — expected on subsequent runs.
      if (!(err instanceof Error && err.message.includes('duplicate column name'))) {
        throw err;
      }
    }
  }

  dbInstance = db;
  return db;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

// --------------------------------------------------------------------------
// Job CRUD
// --------------------------------------------------------------------------

interface JobRow {
  id: string;
  title: string;
  company: string;
  location: string;
  country: string;
  remote: string;
  url: string;
  description_snippet: string;
  language: string;
  hard_language_requirement: string;
  salary: string | null;
  posted_date: string | null;
  sources: string;
  first_seen: string;
  last_seen: string;
  scan_count: number;
  score: number;
  score_breakdown: string;
  score_reasons: string;
  language_risk: number;
  status: string;
  is_agency: number;
  career_ops: string;
  enrichment: string | null;
}

function rowToJob(row: JobRow): Job {
  const enrichmentRaw = row.enrichment ?? '{}';
  let enrichment: Job['enrichment'];
  try {
    const parsed = JSON.parse(enrichmentRaw);
    enrichment = Object.keys(parsed).length > 0 ? parsed : undefined;
  } catch {
    enrichment = undefined;
  }

  return {
    id: row.id,
    title: row.title,
    company: row.company,
    location: row.location,
    country: row.country,
    remote: row.remote as Job['remote'],
    url: row.url,
    descriptionSnippet: row.description_snippet,
    language: row.language as Job['language'],
    hardLanguageRequirement: row.hard_language_requirement,
    salary: row.salary,
    postedDate: row.posted_date,
    sources: JSON.parse(row.sources),
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    scanCount: row.scan_count,
    score: row.score,
    scoreBreakdown: JSON.parse(row.score_breakdown || '{}'),
    scoreReasons: JSON.parse(row.score_reasons || '[]'),
    languageRisk: row.language_risk === 1,
    status: row.status as Job['status'],
    isAgency: row.is_agency === 1,
    careerOps: JSON.parse(row.career_ops || '{}'),
    enrichment,
  };
}

export function getAllJobs(includeAgency = false): Job[] {
  const db = getDb();
  const sql = includeAgency
    ? `SELECT * FROM jobs ORDER BY score DESC, posted_date DESC`
    : `SELECT * FROM jobs WHERE is_agency = 0 ORDER BY score DESC, posted_date DESC`;
  const rows = db.prepare(sql).all() as JobRow[];
  return rows.map(rowToJob);
}

export function getAgencyJobs(): Job[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM jobs WHERE is_agency = 1 ORDER BY score DESC, posted_date DESC`)
    .all() as JobRow[];
  return rows.map(rowToJob);
}

export function getJobById(id: string): Job | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRow | undefined;
  return row ? rowToJob(row) : null;
}

export function getJobsByStatus(status: Job['status']): Job[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM jobs WHERE status = ? ORDER BY score DESC`)
    .all(status) as JobRow[];
  return rows.map(rowToJob);
}

export function getNewJobIdsSet(): Set<string> {
  const db = getDb();
  const rows = db.prepare(`SELECT id FROM jobs`).all() as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/**
 * Upsert a job — insert if new, update last_seen + scan_count + status if existing.
 * Critically: never overwrites career_ops on existing rows.
 */
export function upsertJob(job: Job, scanDate: string): 'inserted' | 'updated' {
  const db = getDb();
  const existing = db.prepare(`SELECT id FROM jobs WHERE id = ?`).get(job.id);

  if (existing) {
    db.prepare(
      `UPDATE jobs SET
        last_seen = ?,
        scan_count = scan_count + 1,
        status = 'active',
        sources = ?,
        score = ?,
        score_breakdown = ?,
        score_reasons = ?,
        language_risk = ?,
        posted_date = COALESCE(?, posted_date),
        description_snippet = CASE WHEN length(?) > length(description_snippet)
                                   THEN ? ELSE description_snippet END
      WHERE id = ?`,
    ).run(
      scanDate,
      JSON.stringify(job.sources),
      job.score,
      JSON.stringify(job.scoreBreakdown),
      JSON.stringify(job.scoreReasons),
      job.languageRisk ? 1 : 0,
      job.postedDate,
      job.descriptionSnippet,
      job.descriptionSnippet,
      job.id,
    );
    return 'updated';
  }

  db.prepare(
    `INSERT INTO jobs (
      id, title, company, location, country, remote, url, description_snippet,
      language, hard_language_requirement, salary, posted_date, sources,
      first_seen, last_seen, scan_count, score, score_breakdown, score_reasons,
      language_risk, status, is_agency, career_ops
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    job.id,
    job.title,
    job.company,
    job.location,
    job.country,
    job.remote,
    job.url,
    job.descriptionSnippet,
    job.language,
    job.hardLanguageRequirement ?? '',
    job.salary,
    job.postedDate,
    JSON.stringify(job.sources),
    scanDate,
    scanDate,
    1,
    job.score,
    JSON.stringify(job.scoreBreakdown),
    JSON.stringify(job.scoreReasons),
    job.languageRisk ? 1 : 0,
    'new',
    job.isAgency ? 1 : 0,
    JSON.stringify(job.careerOps ?? {}),
  );
  return 'inserted';
}

/** Mark jobs not seen in this scan as 'not_in_latest_scan' (only for board OR agency separately). */
export function markStaleJobs(scanDate: string, isAgency: boolean): number {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE jobs SET status = 'not_in_latest_scan'
       WHERE last_seen < ? AND status != 'archived' AND is_agency = ?`,
    )
    .run(scanDate, isAgency ? 1 : 0);
  return result.changes;
}

/** Reset all 'new' jobs to 'active' before a new scan starts (so 'new' only reflects this scan). */
export function clearNewStatus(): void {
  const db = getDb();
  db.prepare(`UPDATE jobs SET status = 'active' WHERE status = 'new'`).run();
}

/**
 * Merge enrichment data into a job's `enrichment` JSON column.
 * Other fields on the job remain untouched. Used by the `enrich` command.
 */
export function updateEnrichment(
  id: string,
  source: 'linkedin',
  data: Record<string, unknown>,
): boolean {
  const db = getDb();
  const row = db.prepare(`SELECT enrichment FROM jobs WHERE id = ?`).get(id) as
    | { enrichment: string | null }
    | undefined;
  if (!row) return false;

  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(row.enrichment ?? '{}');
  } catch {
    existing = {};
  }
  existing[source] = data;

  db.prepare(`UPDATE jobs SET enrichment = ? WHERE id = ?`).run(JSON.stringify(existing), id);
  return true;
}

// --------------------------------------------------------------------------
// Scan log
// --------------------------------------------------------------------------

export interface ScanLogEntry {
  scanDate: string;
  timestamp: string;
  mode: string;
  countryFilter: string | null;
  stats: ScanStats;
  perSource: Record<string, { fetches: number; jobsFound: number; errors: string[] }>;
  durationMs: number;
}

export function insertScanLog(entry: ScanLogEntry): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO scan_log (scan_date, timestamp, mode, country_filter, stats, per_source, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.scanDate,
    entry.timestamp,
    entry.mode,
    entry.countryFilter,
    JSON.stringify(entry.stats),
    JSON.stringify(entry.perSource),
    entry.durationMs,
  );
}

export function getRecentScans(limit = 30): ScanLogEntry[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM scan_log ORDER BY id DESC LIMIT ?`)
    .all(limit) as Array<{
    scan_date: string;
    timestamp: string;
    mode: string;
    country_filter: string | null;
    stats: string;
    per_source: string;
    duration_ms: number;
  }>;
  return rows.map((r) => ({
    scanDate: r.scan_date,
    timestamp: r.timestamp,
    mode: r.mode,
    countryFilter: r.country_filter,
    stats: JSON.parse(r.stats),
    perSource: JSON.parse(r.per_source || '{}'),
    durationMs: r.duration_ms,
  }));
}
