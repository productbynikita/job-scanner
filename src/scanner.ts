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
import { getCollectorsForMode, SOURCE_CATEGORY_MAP, type ScanMode } from './collectors/registry.js';
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
  perSource: Record<string, { fetches: number; jobsFound: number; errors: string[]; category: string }>;
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
  {
    // Print a structured "what we're querying" table before collectors run
    const byCategory: Record<string, string[]> = {
      'Job boards':    [],
      'ATS companies': [],
      'Agencies':      [],
      'Watchlist':     [],
    };
    for (const c of collectors) {
      const cat = SOURCE_CATEGORY_MAP[c.id] ?? 'job_board';
      if (cat === 'job_board')  byCategory['Job boards']!.push(c.id);
      else if (cat === 'ats')   byCategory['ATS companies']!.push(c.id);
      else if (cat === 'agency') byCategory['Agencies']!.push(c.id);
      else if (cat === 'watchlist') byCategory['Watchlist']!.push(c.id);
    }

    const W = 62;
    const hr = '─'.repeat(W);
    console.log(`\n${kleur.bold().cyan(hr)}`);
    console.log(kleur.bold(`  Collection — ${collectors.length} source${collectors.length !== 1 ? 's' : ''}`));
    console.log(kleur.bold().cyan(hr));
    for (const [label, ids] of Object.entries(byCategory)) {
      if (ids.length === 0) continue;
      const pad = label.padEnd(16);
      console.log(`  ${kleur.dim(pad)} ${ids.join('  ')}`);
    }
    console.log();
  }

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

  // Aggregate per-source stats (category stored for display)
  const perSource: RunScanResult['perSource'] = {};
  for (const r of results) {
    perSource[r.sourceId] = {
      fetches: 1,
      jobsFound: r.jobsFound,
      errors: r.errors,
      category: SOURCE_CATEGORY_MAP[r.sourceId] ?? 'job_board',
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
    countryBreakdown: {},
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

    const cc = job.country || 'other';
    stats.countryBreakdown[cc] = (stats.countryBreakdown[cc] ?? 0) + 1;
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
    .filter((j) => j.score >= 70)
    .sort((a, b) => b.score - a.score || (b.postedDate ?? '').localeCompare(a.postedDate ?? ''));

  log.info('scan complete', {
    totalDurationMs: durationMs,
    durationSec: (durationMs / 1000).toFixed(1),
    new: stats.newSinceLast,
    updated: stats.updated,
    highFit: stats.highFit,
  });

  // ── Scan Summary ──────────────────────────────────────────────────────
  const W = 62;
  const hr = '─'.repeat(W);
  console.log();
  console.log(kleur.bold().cyan(hr));
  console.log(kleur.bold(`  Scan Summary — ${scanDate} · ${opts.mode} · ${(durationMs / 1000).toFixed(1)}s`));
  console.log(kleur.bold().cyan(hr));
  console.log();

  // Headline numbers
  const newStr    = kleur.green(`New: ${stats.newSinceLast}`);
  const updStr    = kleur.dim(`Updated: ${stats.updated}`);
  const highStr   = kleur.green(`High-fit (≥70): ${stats.highFit}`);
  const midStr    = kleur.yellow(`Mid-fit (50-69): ${stats.mediumFit}`);
  const langStr   = stats.languageRisk > 0 ? `  ${kleur.yellow(`⚠ lang-risk: ${stats.languageRisk}`)}` : '';
  console.log(`  ${newStr}    ${updStr}    ${highStr}    ${midStr}${langStr}`);
  console.log();

  // ── Source breakdown ─────────────────────────────────────────────────
  const catLabels: Record<string, string> = {
    job_board: 'Job boards',
    ats:       'ATS companies',
    agency:    'Agencies',
    watchlist: 'Watchlist',
  };
  const catOrder = ['job_board', 'ats', 'watchlist', 'agency'];
  const byCategory: Record<string, Array<{ id: string; found: number; errors: number }>> = {};
  for (const cat of catOrder) byCategory[cat] = [];
  for (const [id, src] of Object.entries(perSource)) {
    const cat = src.category ?? 'job_board';
    (byCategory[cat] ??= []).push({ id, found: src.jobsFound, errors: src.errors.length });
  }

  console.log(`  ${kleur.bold('By source')}`);
  console.log(`  ${kleur.dim('─'.repeat(W - 2))}`);
  let anySource = false;
  for (const cat of catOrder) {
    const entries = byCategory[cat];
    if (!entries || entries.length === 0) continue;
    anySource = true;
    const label = (catLabels[cat] ?? cat).padEnd(14);
    const parts = entries.map((e) => {
      const errBadge = e.errors > 0 ? kleur.red(` (${e.errors} err)`) : '';
      return `${kleur.cyan(e.id)}: ${e.found}${errBadge}`;
    });
    console.log(`  ${kleur.dim(label)} ${parts.join('   ')}`);
  }
  if (!anySource) console.log(kleur.dim('  (no sources ran)'));
  console.log();

  // ── Country breakdown ────────────────────────────────────────────────
  const countryOrder = ['DE', 'NL', 'CH', 'BE', 'remote', 'other'];
  const cb = stats.countryBreakdown;
  const allCountries = [
    ...countryOrder.filter((c) => cb[c] != null),
    ...Object.keys(cb).filter((c) => !countryOrder.includes(c)),
  ];
  if (allCountries.length > 0) {
    console.log(`  ${kleur.bold('By country')}`);
    console.log(`  ${kleur.dim('─'.repeat(W - 2))}`);
    const countryParts = allCountries.map((c) => `${kleur.cyan(c)}: ${cb[c]}`);
    console.log(`  ${countryParts.join('   ')}`);
    console.log();
  }

  // ── High-fit jobs ────────────────────────────────────────────────────
  if (topJobs.length > 0) {
    const todayMs = new Date(scanDate + 'T00:00:00Z').getTime();
    const daysSince = (iso: string | null | undefined): string => {
      if (!iso) return '   ?';
      const t = new Date(iso + 'T00:00:00Z').getTime();
      const d = Math.max(0, Math.floor((todayMs - t) / (1000 * 60 * 60 * 24)));
      return `${String(d).padStart(2)}d`;
    };

    console.log(`  ${kleur.bold(`High-fit jobs (≥70) — ${topJobs.length} found`)}`);
    console.log(`  ${kleur.dim('─'.repeat(W - 2))}`);
    for (const j of topJobs) {
      const risk = j.languageRisk ? kleur.yellow(' ⚠') : '';
      const titleTrunc = j.title.length > 38 ? j.title.substring(0, 35) + '…' : j.title.padEnd(38);
      const companyTrunc = j.company.length > 22 ? j.company.substring(0, 19) + '…' : j.company.padEnd(22);
      const posted = j.postedDate ? daysSince(j.postedDate) : '  ?';
      const scanned = daysSince(j.firstSeen);
      console.log(
        `  ${kleur.cyan(String(j.score).padStart(3))}  ${kleur.bold(titleTrunc)}  ${companyTrunc} ${kleur.dim(`(${j.country})`)}${risk}`,
      );
      console.log(
        `       ${kleur.dim(`posted ${posted} ago · scanned ${scanned} ago · status ${j.status}`)}`,
      );
      if (j.url) console.log(`       ${kleur.dim(j.url)}`);
    }
    console.log();
  }

  return { scanDate, durationMs, stats, perSource, topJobs };
}
