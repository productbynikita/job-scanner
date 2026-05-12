#!/usr/bin/env node
/**
 * replay-datasets — re-process cached Apify datasets into jobs.db.
 *
 * Useful when the local DB is empty due to a bug (e.g. wrong field mapping),
 * but Apify still has the raw datasets from previous runs. Fetches items,
 * re-runs dedup + language + scoring, and writes to the DB — no new API
 * calls to LinkedIn.
 *
 * Local cache: raw datasets are saved to data/cache/apify-datasets/<runId>.json
 * on first fetch. Subsequent replays read from disk, so data survives Apify's
 * 7-day dataset retention policy.
 *
 * Usage:
 *   npm run replay                       # replay all SUCCEEDED runs
 *   npm run replay -- --actor <name>     # replay runs from a specific actor
 *   npm run replay -- --since 2026-05-11 # only runs from this date onwards
 *   npm run replay -- --run <runId,...>  # replay specific run IDs
 *   npm run replay -- --dry-run          # show what would be written, don't write
 */

import 'dotenv/config';
import { Command } from 'commander';
import kleur from 'kleur';
import { ApifyClient } from 'apify-client';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadAllConfig } from '../config/loader.js';
import { dedupeAndMerge } from '../processors/dedupe.js';
import { detectLanguage, hasHardLanguageRequirement } from '../processors/language.js';
import { scoreJob } from '../processors/score.js';
import { upsertJob } from '../storage/db.js';
import { countryFromLocation, cleanText } from '../collectors/base.js';
import type { RawJob, Job } from '../types/job.js';
import { createLogger } from '../logger.js';

const log = createLogger('replay');

// ---------------------------------------------------------------------------
// Local dataset cache — avoids Apify 7-day retention cliff
// Saves data/cache/apify-datasets/<runId>.json on first fetch.
// Subsequent replays read from disk; Apify is never called again for that run.
// ---------------------------------------------------------------------------

const CACHE_DIR = resolve(process.cwd(), 'data/cache/apify-datasets');

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
    log.debug('created cache dir', { path: CACHE_DIR });
  }
}

interface CachedDataset {
  runId: string;
  startedAt: string;
  inputLabel: string;
  items: ApifyItem[];
  cachedAt: string;
}

function readCache(runId: string): CachedDataset | null {
  const path = resolve(CACHE_DIR, `${runId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as CachedDataset;
  } catch {
    return null;
  }
}

function writeCache(data: CachedDataset): void {
  ensureCacheDir();
  const path = resolve(CACHE_DIR, `${data.runId}.json`);
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}

const DEFAULT_ACTOR = 'worldunboxer/rapid-linkedin-scraper';

// ---------------------------------------------------------------------------
// Field extraction — mirrors the fixed linkedin.ts collector logic
// ---------------------------------------------------------------------------

interface ApifyItem {
  // worldunboxer/rapid-linkedin-scraper fields
  job_title?: string;
  company_name?: string;
  job_url?: string;
  apply_url?: string;
  location?: string;
  time_posted?: string;
  job_description?: string;
  salary_range?: string | null;
  seniority_level?: string;
  employment_type?: string;
  // Legacy fallback fields (older runs / other actors)
  title?: string;
  company?: string;
  companyName?: string;
  link?: string;
  jobUrl?: string;
  applyLink?: string;
  applyUrl?: string;
  description?: string;
  descriptionText?: string;
  salary?: string;
  postedAt?: string;
  postedTimeAgo?: string;
  publishedAt?: string;
  workType?: string;
  [key: string]: unknown;
}

function pickTitle(item: ApifyItem): string {
  return ((item.job_title ?? item.title ?? '') as string).trim();
}

function pickCompany(item: ApifyItem): string {
  return ((item.company_name ?? item.companyName ?? item.company ?? '') as string).trim();
}

function pickUrl(item: ApifyItem): string {
  return ((item.apply_url ?? item.job_url ?? item.applyUrl ?? item.applyLink ?? item.jobUrl ?? item.link ?? '') as string);
}

function pickDescription(item: ApifyItem): string {
  return ((item.job_description ?? item.descriptionText ?? item.description ?? '') as string);
}

function pickSalary(item: ApifyItem): string | null {
  return (item.salary_range ?? item.salary ?? null) as string | null;
}

/**
 * Parse a posted date from an actor item.
 * @param referenceDate - The date the actor RAN (not today). Critical for
 *   correct replay: relative strings like "23 hours ago" must be resolved
 *   against the run date, not the current date.
 */
function parsePostedDate(item: ApifyItem, referenceDate: Date = new Date()): string | null {
  const isoCandidate = ((item.postedAt ?? item.publishedAt ?? '') as string);
  if (isoCandidate) {
    const m = isoCandidate.match(/^\d{4}-\d{2}-\d{2}/);
    if (m) return m[0]!;
    const d = new Date(isoCandidate);
    if (!isNaN(d.getTime())) return d.toISOString().substring(0, 10);
  }
  const rel = ((item.time_posted ?? item.postedTimeAgo ?? item.postedAt ?? '') as string);
  if (!rel) return null;
  const lower = rel.toLowerCase();
  let daysAgo: number | null = null;
  let m = lower.match(/(\d+)\s*hour/);
  if (m) daysAgo = 0;
  m = lower.match(/(\d+)\s*day/);
  if (m) daysAgo = parseInt(m[1]!, 10);
  m = lower.match(/(\d+)\s*week/);
  if (m) daysAgo = parseInt(m[1]!, 10) * 7;
  m = lower.match(/(\d+)\s*month/);
  if (m) daysAgo = parseInt(m[1]!, 10) * 30;
  if (lower.includes('just') || lower.includes('today')) daysAgo = 0;
  if (lower.includes('yesterday')) daysAgo = 1;
  if (daysAgo === null) return null;
  const d = new Date(referenceDate.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  return d.toISOString().substring(0, 10);
}

function detectRemote(item: ApifyItem, location: string): RawJob['remote'] {
  const haystack = `${item.workType ?? ''} ${item.employment_type ?? ''} ${location}`.toLowerCase();
  if (haystack.includes('remote')) return 'remote';
  if (haystack.includes('hybrid')) return 'hybrid';
  if (haystack.includes('on-site') || haystack.includes('onsite')) return 'onsite';
  return '';
}

// Simple product-role title guard (same logic as atsHelpers.ts)
const PRODUCT_KEYWORDS = [
  'product manager', 'product owner', 'technical product', 'tpm',
  'group product manager', 'staff product', 'principal product',
  'lead product', 'senior product', 'sr. product', 'sr product', 'gpm',
];
const HARD_EXCLUDE = [
  'product designer', 'product design', 'ux', 'ui ', 'product marketing',
  'product analyst', 'data analyst', 'business analyst', 'sales',
  'account exec', 'account manager', 'recruiter', 'engineer', 'developer',
  'software', 'devops', 'sre',
];

function isProductRole(title: string): boolean {
  if (!title) return false;
  const lower = title.toLowerCase();
  for (const ex of HARD_EXCLUDE) {
    if (lower.includes(ex)) {
      if (lower.startsWith(ex) || (!lower.includes('product manager') && !lower.includes('product owner'))) {
        return false;
      }
    }
  }
  return PRODUCT_KEYWORDS.some((kw) => lower.includes(kw));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function replayDatasets(opts: {
  actor: string;
  since?: string;
  runIds?: string[];
  dryRun: boolean;
}) {
  const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
  const config = loadAllConfig();
  const scanDate = new Date().toISOString().split('T')[0]!;

  // Fetch run list
  log.info('fetching run list', { actor: opts.actor });
  const { items: allRuns } = await client.actor(opts.actor).runs().list({ limit: 200, desc: false });

  let runs = allRuns.filter((r) => r.status === 'SUCCEEDED');

  if (opts.runIds && opts.runIds.length > 0) {
    const ids = new Set(opts.runIds);
    runs = runs.filter((r) => ids.has(r.id));
    log.info('filtered to specific run IDs', { count: runs.length });
  } else if (opts.since) {
    runs = runs.filter((r) => (r.startedAt ? new Date(r.startedAt).toISOString().substring(0, 10) : '') >= opts.since!);
    log.info('filtered by date', { since: opts.since, count: runs.length });
  }

  if (runs.length === 0) {
    console.log(kleur.yellow('No matching runs found.'));
    return;
  }

  console.log(kleur.bold().cyan(`\nReplaying ${runs.length} Apify datasets\n`));

  const allRaw: RawJob[] = [];
  let totalFetched = 0;
  let totalDropped = 0;

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    // Get the input to label the log line
    let inputLabel = run.id;
    try {
      const inputRecord = await client.keyValueStore(run.defaultKeyValueStoreId).getRecord('INPUT');
      const inp = inputRecord?.value as Record<string, unknown> | undefined;
      if (inp) {
        inputLabel = `${inp.job_title ?? inp.keyword ?? '?'} / ${inp.location ?? '?'}`;
      }
    } catch {
      // ignore — label stays as run ID
    }

    process.stdout.write(
      kleur.dim(`  [${String(i + 1).padStart(2)}/${runs.length}] `) +
      kleur.cyan(inputLabel.substring(0, 50).padEnd(52)),
    );

    try {
      // --- Local cache lookup -------------------------------------------
      let cached = readCache(run.id);
      let items: ApifyItem[];
      let fromCache = false;

      if (cached) {
        items = cached.items;
        // Backfill inputLabel from cache if we couldn't read it from KV store
        if (inputLabel === run.id && cached.inputLabel) inputLabel = cached.inputLabel;
        fromCache = true;
      } else {
        const result = await client.dataset(run.defaultDatasetId).listItems({ limit: 200 });
        items = result.items as ApifyItem[];
        // Persist to disk so future replays survive Apify's 7-day retention
        writeCache({
          runId: run.id,
          startedAt: run.startedAt ? new Date(run.startedAt).toISOString() : new Date().toISOString(),
          inputLabel,
          items,
          cachedAt: new Date().toISOString(),
        });
      }
      // ------------------------------------------------------------------

      totalFetched += items.length;

      // Use the run's start date as reference for relative-time strings like
      // "23 hours ago" — NOT today, which would shift all dates by replay lag.
      const runDate = new Date(run.startedAt ?? Date.now());

      let kept = 0;
      for (const raw of items) {
        const title = pickTitle(raw);
        const company = pickCompany(raw);
        const url = pickUrl(raw);
        if (!title || !company) { totalDropped++; continue; }
        if (!isProductRole(title)) { totalDropped++; continue; }

        const location = (raw.location ?? '').trim();
        allRaw.push({
          title,
          company,
          location,
          country: countryFromLocation(location) || '',
          remote: detectRemote(raw, location),
          url,
          descriptionSnippet: cleanText(pickDescription(raw), 500),
          salary: pickSalary(raw),
          postedDate: parsePostedDate(raw, runDate),
          source: 'linkedin',
          isAgency: false,
        });
        kept++;
      }
      const cacheTag = fromCache ? kleur.dim(' [cache]') : kleur.dim(' [apify]');
      process.stdout.write(kleur.green(` ${items.length} fetched → ${kept} PM roles`) + cacheTag + '\n');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(kleur.red(` ERROR: ${msg}\n`));
    }
  }

  console.log();
  log.info('raw collection complete', { totalFetched, pmKept: allRaw.length, totalDropped });

  // Dedupe
  const deduped = dedupeAndMerge(allRaw);
  log.info('deduped', { before: allRaw.length, after: deduped.length });

  // Score
  let highFit = 0, medFit = 0, lowFit = 0, inserted = 0, updated = 0;
  const finalJobs: Job[] = [];

  for (const dj of deduped) {
    const fullText = `${dj.title} ${dj.descriptionSnippet}`;
    const lang = detectLanguage(fullText);
    const hardReq = hasHardLanguageRequirement(fullText);
    const scoreResult = scoreJob({ ...dj, language: lang }, config.roles);

    finalJobs.push({
      ...dj,
      language: lang,
      hardLanguageRequirement: hardReq,
      firstSeen: scanDate,
      lastSeen: scanDate,
      scanCount: 1,
      score: scoreResult.score,
      scoreBreakdown: scoreResult.breakdown,
      scoreReasons: scoreResult.reasons,
      languageRisk: scoreResult.languageRisk,
      status: 'new',
      careerOps: {},
    });

    if (scoreResult.score >= 70) highFit++;
    else if (scoreResult.score >= 50) medFit++;
    else lowFit++;
  }

  // Write to DB
  if (!opts.dryRun) {
    for (const job of finalJobs) {
      const action = upsertJob(job, scanDate);
      if (action === 'inserted') inserted++;
      else updated++;
    }
  }

  // Summary
  console.log(kleur.bold().cyan('────────────────────────────────────────'));
  console.log(kleur.bold('  Replay Summary'));
  console.log(kleur.bold().cyan('────────────────────────────────────────'));
  console.log(`  Runs replayed:   ${runs.length}`);
  console.log(`  Raw items:       ${totalFetched}`);
  console.log(`  After PM filter: ${allRaw.length}`);
  console.log(`  After dedupe:    ${deduped.length}`);
  console.log(`  ${kleur.green('High-fit (≥70):')} ${highFit}    ${kleur.yellow('Medium-fit (50-69):')} ${medFit}    ${kleur.dim('Low-fit:')} ${lowFit}`);
  if (opts.dryRun) {
    console.log(kleur.yellow('\n  DRY RUN — nothing written to DB'));
  } else {
    console.log(`  ${kleur.green('Inserted:')} ${inserted}    ${kleur.dim('Updated:')} ${updated}`);
    console.log(kleur.dim('\n  Use `npm run show:new` or `npm run show:top` to browse results.'));
  }
  console.log();
}

// ---------------------------------------------------------------------------
// CLI wiring
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('replay-datasets')
  .description('Re-process cached Apify datasets into jobs.db without making new API calls')
  .option('-a, --actor <name>', 'Apify actor slug to replay', DEFAULT_ACTOR)
  .option('-s, --since <date>', 'Only replay runs started on or after this date (YYYY-MM-DD)')
  .option('-r, --run <ids>', 'Comma-separated run IDs to replay')
  .option('--dry-run', 'Fetch and score but do not write to DB')
  .action(async (opts: { actor: string; since?: string; run?: string; dryRun?: boolean }) => {
    if (!process.env.APIFY_TOKEN) {
      console.error(kleur.red('APIFY_TOKEN not set in .env'));
      process.exit(1);
    }
    await replayDatasets({
      actor: opts.actor,
      since: opts.since,
      runIds: opts.run ? opts.run.split(',').map((s) => s.trim()) : undefined,
      dryRun: opts.dryRun ?? false,
    });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(kleur.red('Fatal:'), err);
  process.exit(1);
});
