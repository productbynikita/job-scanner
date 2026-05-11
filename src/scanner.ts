/**
 * Main scanner orchestration.
 *
 * Phase 2: now runs ATS collectors (Greenhouse, Lever, Ashby, Workable) in
 * addition to the remote sources. Heavy logging at every stage so it's
 * easy to see exactly what was searched, what passed each filter, and
 * what hit the database.
 */

import kleur from 'kleur';
import { loadAllConfig } from './config/loader.js';
import { dedupeAndMerge } from './processors/dedupe.js';
import { detectLanguage, hasHardLanguageRequirement } from './processors/language.js';
import { scoreJob } from './processors/score.js';
import {
  upsertJob,
  insertScanLog,
  markStaleJobs,
  clearNewStatus,
  getNewJobIdsSet,
  type ScanLogEntry,
} from './storage/db.js';
import { getCollectorsForMode, type ScanMode } from './collectors/registry.js';
import type { Job, RawJob, ScanStats } from './types/job.js';
import { createLogger, logBanner, logSection } from './logger.js';

export interface RunScanOptions {
  mode: ScanMode;
  countryFilter?: string;
  maxResultsPerSource?: number;
}

export interface RunScanResult {
  scanDate: string;
  durationMs: number;
  stats: ScanStats;
  perSource: Record<string, { fetches: number; jobsFound: number; errors: string[] }>;
  topJobs: Job[];
}

const DEFAULT_MAX_RESULTS = 50;
const log = createLogger('scanner');

export async function runScan(opts: RunScanOptions): Promise<RunScanResult> {
  const startedAt = Date.now();
  const scanDate = new Date().toISOString().split('T')[0]!;
  const config = loadAllConfig();
  const maxResultsPerSource =
    opts.maxResultsPerSource ?? config.preferences.scanBehavior.maxResultsPerSource ?? DEFAULT_MAX_RESULTS;

  logBanner(`Job scan — mode=${opts.mode}${opts.countryFilter ? ' country=' + opts.countryFilter : ''}`);

  log.info('scan starting', {
    mode: opts.mode,
    country: opts.countryFilter ?? null,
    scanDate,
    maxPerSource: maxResultsPerSource,
  });

  // Show what's configured
  log.info('config loaded', {
    targetCountries: config.preferences.geographies.primary.map((g) => g.country).join(','),
    targetRoles: config.roles.targetTitles.exactMatch.length + config.roles.targetTitles.strongMatch.length,
    excludedTitles: config.roles.targetTitles.exclude.length,
    atsCompanies: {
      greenhouse: config.companies.greenhouse.length,
      lever: config.companies.lever.length,
      ashby: config.companies.ashby.length,
      workable: config.companies.workable.length,
    },
    countrySources: Object.keys(config.countrySources).length,
  });

  const collectors = getCollectorsForMode(opts.mode);
  if (collectors.length === 0) {
    log.warn(`No collectors registered for mode '${opts.mode}'.`);
    log.warn('This mode will likely become functional in a later phase.');
  } else {
    log.info('collectors selected', {
      count: collectors.length,
      ids: collectors.map((c) => c.id).join(','),
    });
  }

  // Reset 'new' status before this scan
  clearNewStatus();
  log.debug('cleared previous "new" status flags');

  // ----------------------------------------------------------------------
  // Phase: COLLECTION
  // ----------------------------------------------------------------------
  logSection('Collection — fetching from sources');
  const collectorStartedAt = Date.now();

  const results = await Promise.all(
    collectors.map(async (c) => {
      log.debug('starting collector', { source: c.id });
      const result = await c.collect({ maxResults: maxResultsPerSource });
      log.info('collector finished', {
        source: c.id,
        jobsFound: result.jobsFound,
        errors: result.errors.length,
        durationMs: result.durationMs,
      });
      return result;
    }),
  );

  const collectorDurationMs = Date.now() - collectorStartedAt;
  log.info('all collectors finished', {
    totalJobs: results.reduce((sum, r) => sum + r.jobsFound, 0),
    totalErrors: results.reduce((sum, r) => sum + r.errors.length, 0),
    durationMs: collectorDurationMs,
  });

  // Aggregate per-source stats
  const perSource: RunScanResult['perSource'] = {};
  for (const r of results) {
    perSource[r.sourceId] = {
      fetches: 1,
      jobsFound: r.jobsFound,
      errors: r.errors,
    };
    if (r.errors.length > 0) {
      log.warn(`${r.sourceId} reported errors`, {
        count: r.errors.length,
        sample: r.errors.slice(0, 3),
      });
    }
  }

  const allRawJobs: RawJob[] = [];
  for (const r of results) {
    for (const job of r.jobs) {
      allRawJobs.push(job);
    }
  }
  log.info('raw jobs aggregated', { count: allRawJobs.length });

  const stats: ScanStats = {
    rawCount: allRawJobs.length,
    afterCountryFilter: 0,
    afterDedupe: 0,
    afterLanguageFilter: 0,
    languageDropped: 0,
    scored: 0,
    highFit: 0,
    mediumFit: 0,
    lowFit: 0,
    languageRisk: 0,
    newSinceLast: 0,
    updated: 0,
  };

  // ----------------------------------------------------------------------
  // Phase: COUNTRY FILTER
  // ----------------------------------------------------------------------
  let filtered = allRawJobs;
  if (opts.countryFilter) {
    logSection(`Country filter — ${opts.countryFilter}`);
    const cf = opts.countryFilter.toUpperCase();
    const before = filtered.length;
    filtered = allRawJobs.filter(
      (j) =>
        (j.country || '').toUpperCase() === cf ||
        (cf === 'REMOTE' && (j.remote || '').toLowerCase() === 'remote'),
    );
    log.info('country filter applied', {
      filter: cf,
      before,
      after: filtered.length,
      dropped: before - filtered.length,
    });
  }
  stats.afterCountryFilter = filtered.length;

  // ----------------------------------------------------------------------
  // Phase: DEDUPE
  // ----------------------------------------------------------------------
  logSection('Deduplication');
  const dedupeStartedAt = Date.now();
  const deduped = dedupeAndMerge(filtered);
  stats.afterDedupe = deduped.length;
  log.info('dedupe complete', {
    before: filtered.length,
    after: deduped.length,
    merged: filtered.length - deduped.length,
    durationMs: Date.now() - dedupeStartedAt,
  });

  // ----------------------------------------------------------------------
  // Phase: LANGUAGE DETECTION
  // ----------------------------------------------------------------------
  logSection('Language detection');
  const langStartedAt = Date.now();
  let nonEnglish = 0;
  let hardReqCount = 0;
  for (const dj of deduped) {
    const fullText = `${dj.title} ${dj.descriptionSnippet}`;
    const lang = detectLanguage(fullText);
    if (lang !== 'en' && lang !== 'unknown') nonEnglish++;
    const hardReq = hasHardLanguageRequirement(fullText);
    if (hardReq) hardReqCount++;
  }
  log.info('language detection complete', {
    total: deduped.length,
    nonEnglish,
    hardLanguageRequirement: hardReqCount,
    durationMs: Date.now() - langStartedAt,
  });

  // ----------------------------------------------------------------------
  // Phase: SCORING
  // ----------------------------------------------------------------------
  logSection('Scoring');
  const scoreStartedAt = Date.now();
  const existingIds = getNewJobIdsSet();
  const finalJobs: Job[] = [];

  for (const dj of deduped) {
    const fullText = `${dj.title} ${dj.descriptionSnippet}`;
    const detectedLang = detectLanguage(fullText);
    const hardReq = hasHardLanguageRequirement(fullText);

    const job: RawJob & { language: typeof detectedLang } = {
      ...dj,
      language: detectedLang,
    };

    const scoreResult = scoreJob(job, config.roles);

    finalJobs.push({
      id: dj.id,
      title: dj.title,
      company: dj.company,
      location: dj.location,
      country: dj.country,
      remote: dj.remote,
      url: dj.url,
      descriptionSnippet: dj.descriptionSnippet,
      language: detectedLang,
      hardLanguageRequirement: hardReq,
      salary: dj.salary,
      postedDate: dj.postedDate,
      sources: dj.sources,
      firstSeen: scanDate,
      lastSeen: scanDate,
      scanCount: 1,
      score: scoreResult.score,
      scoreBreakdown: scoreResult.breakdown,
      scoreReasons: scoreResult.reasons,
      languageRisk: scoreResult.languageRisk,
      status: 'new',
      isAgency: dj.isAgency,
      careerOps: {},
    });
  }

  stats.afterLanguageFilter = finalJobs.length;
  stats.scored = finalJobs.length;

  for (const job of finalJobs) {
    if (job.languageRisk) stats.languageRisk++;
    if (job.score >= 70) stats.highFit++;
    else if (job.score >= 50) stats.mediumFit++;
    else stats.lowFit++;
  }

  log.info('scoring complete', {
    total: finalJobs.length,
    highFit: stats.highFit,
    mediumFit: stats.mediumFit,
    lowFit: stats.lowFit,
    languageRisk: stats.languageRisk,
    durationMs: Date.now() - scoreStartedAt,
  });

  // ----------------------------------------------------------------------
  // Phase: PERSISTENCE
  // ----------------------------------------------------------------------
  logSection('Persistence — writing to SQLite');
  const persistStartedAt = Date.now();

  for (const job of finalJobs) {
    const action = upsertJob(job, scanDate);
    if (action === 'inserted' && !existingIds.has(job.id)) {
      stats.newSinceLast++;
    } else {
      stats.updated++;
    }
  }

  const staleBoard = markStaleJobs(scanDate, false);
  const staleAgency = markStaleJobs(scanDate, true);

  log.info('persistence complete', {
    inserted: stats.newSinceLast,
    updated: stats.updated,
    markedStaleBoard: staleBoard,
    markedStaleAgency: staleAgency,
    durationMs: Date.now() - persistStartedAt,
  });

  // ----------------------------------------------------------------------
  // Phase: SUMMARY
  // ----------------------------------------------------------------------
  const durationMs = Date.now() - startedAt;
  const logEntry: ScanLogEntry = {
    scanDate,
    timestamp: new Date().toISOString(),
    mode: opts.mode,
    countryFilter: opts.countryFilter ?? null,
    stats,
    perSource,
    durationMs,
  };
  insertScanLog(logEntry);

  const topJobs = finalJobs
    .sort((a, b) => b.score - a.score || (b.postedDate ?? '').localeCompare(a.postedDate ?? ''))
    .slice(0, 10);

  log.info('scan complete', {
    totalDurationMs: durationMs,
    durationSec: (durationMs / 1000).toFixed(1),
    new: stats.newSinceLast,
    updated: stats.updated,
    highFit: stats.highFit,
  });

  // Pretty terminal summary at the end
  console.log();
  console.log(kleur.bold().cyan('────────────────────────────────────────'));
  console.log(kleur.bold('  Scan Summary'));
  console.log(kleur.bold().cyan('────────────────────────────────────────'));
  console.log(`  Date:        ${scanDate}`);
  console.log(`  Duration:    ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`  Total jobs:  ${stats.scored}`);
  console.log(
    `  ${kleur.green('New:')} ${stats.newSinceLast}    ${kleur.dim('Updated:')} ${stats.updated}`,
  );
  console.log(
    `  ${kleur.green('High-fit (≥70):')} ${stats.highFit}    ${kleur.yellow('Medium-fit (50-69):')} ${stats.mediumFit}`,
  );
  if (stats.languageRisk > 0) {
    console.log(`  ${kleur.yellow('⚠ Language-risk flagged:')} ${stats.languageRisk}`);
  }
  console.log();

  return { scanDate, durationMs, stats, perSource, topJobs };
}
