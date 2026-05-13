/**
 * Read-only query commands. Used by `show top`, `show new`, etc.
 * These never make HTTP calls — they only read SQLite.
 */

import {
  getAllJobs,
  getReviewableJobs,
  getAppliedJobs,
  getAgencyJobs,
  getJobById,
  getJobsByStatus,
  getRecentScans,
  getDb,
} from '../storage/db.js';
import type { Job } from '../types/job.js';
import { loadWatchlist } from '../config/loader.js';

/**
 * Wrap text in an OSC 8 terminal hyperlink.
 * Works in iTerm2, Warp, VS Code terminal, modern macOS Terminal.
 * In terminals that don't support it, the text is shown as plain text.
 */
function osc8Link(text: string, url: string): string {
  if (!url || url === '-') return text;
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/**
 * Render one job as two lines: dense header (score + title + company + dates + status) + URL.
 * Dates use relative form ("5d", "today") for scannability.
 */
function formatJobEntry(job: Job, _idx: number): string[] {
  const risk = job.languageRisk ? ' ⚠' : '';
  const url = job.url || '';
  const shortId = job.id.substring(0, 8);
  const titleTrunc = job.title.length > 40 ? job.title.substring(0, 37) + '…' : job.title.padEnd(40);
  const companyTrunc = job.company.length > 24 ? job.company.substring(0, 21) + '…' : job.company.padEnd(24);
  const scoreStr = String(job.score).padStart(3);
  const decision = job.careerOps?.decision ? ` [${job.careerOps.decision}]` : '';

  const postedAge = job.postedDate ? relDays(job.postedDate) : '   ?';
  const scannedAge = relDays(job.firstSeen);
  const statusShort = shortStatus(job.status);

  const header = `  ${scoreStr}  ${titleTrunc}  ${companyTrunc} (${job.country})${risk}${decision}`;
  const meta = `       posted ${postedAge}  scanned ${scannedAge}  ${statusShort}  [${shortId}]`;

  const lines = [header, meta];
  if (url) lines.push(`       ${osc8Link(url, url)}`);
  return lines;
}

/** Compact single-line variant. URL uses OSC8 — title doubles as the click target on modern terminals. */
function formatJobLine(job: Job): string {
  const risk = job.languageRisk ? '⚠' : ' ';
  const shortId = job.id.substring(0, 8);
  const titleTrunc = job.title.length > 44 ? job.title.substring(0, 41) + '…' : job.title.padEnd(44);
  const companyTrunc = job.company.length > 22 ? job.company.substring(0, 19) + '…' : job.company.padEnd(22);
  const scoreStr = String(job.score).padStart(3);
  const postedAge = (job.postedDate ? relDays(job.postedDate) : '   ?').padEnd(6);
  const scannedAge = relDays(job.firstSeen).padEnd(6);
  const statusShort = shortStatus(job.status).padEnd(6);
  const decision = job.careerOps?.decision ? `[${(job.careerOps.decision as string).substring(0, 4)}]` : '      ';
  const titleClickable = job.url ? osc8Link(titleTrunc, job.url) : titleTrunc;
  return `  ${scoreStr} ${risk} ${titleClickable}  ${companyTrunc} ${job.country.padEnd(6)} ${postedAge} ${scannedAge} ${statusShort} ${decision} ${shortId}`;
}

/** "today" | "1d" | "12d" | "?" — short relative-day form for tables. */
function relDays(iso: string | null | undefined): string {
  if (!iso) return '   ?';
  const d = daysAgo(iso);
  if (d === 0) return 'today';
  return `${d}d`;
}

/** Compact status label: new / live / stale / arch. */
function shortStatus(s: string): string {
  if (s === 'new') return 'new';
  if (s === 'active') return 'live';
  if (s === 'not_in_latest_scan') return 'stale';
  if (s === 'archived') return 'arch';
  return s;
}

/** Whole days between an ISO date string (YYYY-MM-DD) and today. */
function daysAgo(isoDate: string): number {
  const then = new Date(isoDate + 'T00:00:00Z').getTime();
  const now = Date.now();
  return Math.max(0, Math.floor((now - then) / (1000 * 60 * 60 * 24)));
}

export interface ShowTopOptions {
  n?: number | null;
  includeAgency?: boolean;
  minDomain?: number;
  /** Only jobs posted within the last N days (uses postedDate). */
  postedWithin?: number;
  /** Only jobs first scanned within the last N days. */
  scannedWithin?: number;
  /** Include jobs you've already passed/applied to. */
  all?: boolean;
  /** Minimum score to include. Defaults to 70 (high-fit) when n is null. */
  minScore?: number;
  /** One line per job (no URL line; title is OSC8-linked). */
  compact?: boolean;
}

const DEFAULT_TOP_LIMIT = 20;

export function showTop(opts: ShowTopOptions = {}): string {
  const {
    n = null,
    includeAgency = false,
    minDomain = 0,
    postedWithin,
    scannedWithin,
    all = false,
    minScore,
    compact = false,
  } = opts;

  let jobs: Job[];
  if (all) {
    jobs = includeAgency
      ? [...getAllJobs(false), ...getAgencyJobs()].sort((a, b) => b.score - a.score)
      : getAllJobs(false);
  } else {
    jobs = includeAgency
      ? [...getReviewableJobs(false), ...getAgencyJobs()].sort((a, b) => b.score - a.score)
      : getReviewableJobs(false);
  }

  if (minDomain > 0) {
    jobs = jobs.filter((j) => (j.scoreBreakdown.domainFit ?? 0) >= minDomain);
  }
  if (postedWithin !== undefined) {
    jobs = jobs.filter((j) => j.postedDate && daysAgo(j.postedDate) <= postedWithin);
  }
  if (scannedWithin !== undefined) {
    jobs = jobs.filter((j) => daysAgo(j.firstSeen) <= scannedWithin);
  }

  const threshold = minScore ?? 70;
  if (threshold > 0) {
    jobs = jobs.filter((j) => j.score >= threshold);
  }

  const totalMatched = jobs.length;
  const limit = n !== null ? n : DEFAULT_TOP_LIMIT;
  const top = jobs.slice(0, limit);
  if (top.length === 0) {
    return all
      ? 'No jobs match your criteria.'
      : 'No jobs match. Try a wider window (e.g. `--posted 14`) or `--all` to include applied/passed.';
  }

  const filters: string[] = [];
  if (postedWithin !== undefined) filters.push(`posted ≤${postedWithin}d`);
  if (scannedWithin !== undefined) filters.push(`scanned ≤${scannedWithin}d`);
  if (minDomain > 0) filters.push(`domain ≥${minDomain}`);
  if (all) filters.push('incl. applied/passed');
  const filterNote = filters.length > 0 ? ` · ${filters.join(', ')}` : '';

  const truncated = totalMatched > top.length;
  const headline = n !== null
    ? `Top ${top.length} jobs (score ≥${threshold})${filterNote}`
    : `Pool — showing ${top.length} of ${totalMatched} (score ≥${threshold})${filterNote}`;

  const hr = '─'.repeat(78);
  const lines: string[] = [];
  lines.push(`# ${headline}`);
  lines.push(hr);

  if (compact) {
    // Column header
    lines.push(
      `  sco   ${'title'.padEnd(44)}  ${'company'.padEnd(22)} ${'ctry'.padEnd(6)} ${'posted'.padEnd(6)} ${'scan'.padEnd(6)} ${'state'.padEnd(6)} mark   id`,
    );
    lines.push(hr);
    for (const j of top) {
      lines.push(formatJobLine(j));
    }
  } else {
    top.forEach((j, i) => {
      lines.push(`${(i + 1).toString().padStart(3)}. ${formatJobEntry(j, i + 1).join('\n')}`);
    });
  }

  lines.push(hr);
  if (truncated) {
    lines.push(
      `  Showing top ${top.length}. Pass a number to see more, e.g. \`npm run show:top -- ${totalMatched}\``,
    );
  }
  lines.push('  scores 0-100  ·  ⚠ = language risk  ·  posted/scan = days ago  ·  state: new|live|stale');
  lines.push('  mark a job:  npm run mark -- <id> applied|screening|interview|offer|passed|shortlist|watch');
  return lines.join('\n');
}

/**
 * Application tracker — every job you've marked as 'applied'.
 * Groups by stage so active pipelines surface first.
 */
export function showTracker(): string {
  const jobs = getAppliedJobs();
  if (jobs.length === 0) {
    return 'No applications tracked yet.\nMark a job with `npm run mark -- <id> applied` to start.';
  }

  // Stages ordered from "in-flight" → "closed"
  const stageOrder: Array<NonNullable<Job['careerOps']['stage']>> = [
    'offer',
    'onsite',
    'interview',
    'screening',
    'applied',
    'ghosted',
    'rejected',
    'declined',
  ];
  const stageLabels: Record<string, string> = {
    applied: '📤 Applied',
    screening: '📞 Screening',
    interview: '💬 Interview',
    onsite: '🏢 Onsite',
    offer: '🎉 Offer',
    ghosted: '👻 Ghosted',
    rejected: '❌ Rejected',
    declined: '🙅 Declined',
  };

  const byStage = new Map<string, Job[]>();
  for (const j of jobs) {
    const stage = (j.careerOps?.stage as string) ?? 'applied';
    const list = byStage.get(stage) ?? [];
    list.push(j);
    byStage.set(stage, list);
  }

  const lines: string[] = [];
  lines.push(`# Application tracker — ${jobs.length} total`);
  lines.push('');

  // Summary line
  const summary = stageOrder
    .map((s) => {
      const count = byStage.get(s)?.length ?? 0;
      return count > 0 ? `${stageLabels[s] ?? s}: ${count}` : null;
    })
    .filter(Boolean)
    .join('   ');
  lines.push(summary);
  lines.push('');

  for (const stage of stageOrder) {
    const stageJobs = byStage.get(stage);
    if (!stageJobs || stageJobs.length === 0) continue;
    lines.push(`## ${stageLabels[stage] ?? stage} (${stageJobs.length})`);
    lines.push('');
    for (const j of stageJobs) {
      const applied = (j.careerOps?.appliedDate as string) ?? j.careerOps?.decisionDate ?? '?';
      const updated = (j.careerOps?.stageUpdatedAt as string) ?? '';
      const daysSince = typeof applied === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(applied)
        ? `${daysAgo(applied)}d ago`
        : applied;
      const note = j.careerOps?.notes ? ` — ${j.careerOps.notes}` : '';
      const shortId = j.id.substring(0, 8);
      const titleTrunc = j.title.length > 38 ? j.title.substring(0, 35) + '…' : j.title;
      lines.push(
        `  ${String(j.score).padStart(3)}  ${titleTrunc.padEnd(38)} @ ${j.company}  applied ${applied} (${daysSince})${updated && updated !== applied ? `, updated ${updated}` : ''}  [${shortId}]${note}`,
      );
      if (j.url) lines.push(`       ${osc8Link(j.url, j.url)}`);
      lines.push('');
    }
  }

  lines.push('(update a stage: npm run mark -- <id> screening|interview|onsite|offer|rejected|declined|ghosted)');
  return lines.join('\n');
}

export function showNew(): string {
  const board = getJobsByStatus('new').filter((j) => !j.isAgency);
  const agency = getJobsByStatus('new').filter((j) => j.isAgency);

  const lines = [`# New since last scan`, ''];
  lines.push(`**Job board: ${board.length} new** | **Agencies: ${agency.length} new**`);
  lines.push('');

  if (board.length > 0) {
    lines.push('## New on job boards', '');
    for (const j of board.slice(0, 30)) {
      lines.push(...formatJobEntry(j, 0));
      lines.push('');
    }
  }

  if (agency.length > 0) {
    lines.push('## New from agencies', '');
    for (const j of agency.slice(0, 30)) {
      lines.push(...formatJobEntry(j, 0));
      lines.push('');
    }
  }

  if (board.length === 0 && agency.length === 0) {
    lines.push('No new jobs since the last scan.');
  }
  return lines.join('\n');
}

export function showStats(): string {
  const scans = getRecentScans(30);
  if (scans.length === 0) return 'No scans recorded yet.';

  const lines = ['# Scan history', ''];
  lines.push('| Date | Mode | Country | High-fit | Medium-fit | Language-risk | Sources |');
  lines.push('|------|------|---------|----------|------------|---------------|---------|');
  for (const s of scans) {
    const nSources = Object.keys(s.perSource).length;
    lines.push(
      `| ${s.scanDate} | ${s.mode} | ${s.countryFilter ?? '-'} | ${s.stats.highFit} | ${s.stats.mediumFit} | ${s.stats.languageRisk} | ${nSources} |`,
    );
  }

  // Cumulative per-source
  const totals = new Map<string, { fetches: number; jobs: number; errors: number }>();
  for (const s of scans) {
    for (const [sid, info] of Object.entries(s.perSource)) {
      const t = totals.get(sid) ?? { fetches: 0, jobs: 0, errors: 0 };
      t.fetches += info.fetches;
      t.jobs += info.jobsFound;
      t.errors += info.errors.length;
      totals.set(sid, t);
    }
  }

  if (totals.size > 0) {
    // Build category map from latest scan's perSource (best effort)
    const catMap: Record<string, string> = {};
    for (const s of scans) {
      for (const [sid, info] of Object.entries(s.perSource)) {
        const cat = (info as { category?: string }).category;
        if (cat) catMap[sid] = cat;
      }
    }

    const catLabels: Record<string, string> = {
      job_board: 'Job boards',
      ats: 'ATS companies',
      agency: 'Agencies',
      watchlist: 'Watchlist',
    };
    const catOrder = ['job_board', 'ats', 'watchlist', 'agency'];
    const byCategory: Record<string, Array<[string, { fetches: number; jobs: number; errors: number }]>> = {};
    for (const cat of catOrder) byCategory[cat] = [];
    for (const [sid, t] of totals) {
      const cat = catMap[sid] ?? 'job_board';
      (byCategory[cat] ??= []).push([sid, t]);
    }

    lines.push('', '## Cumulative per-source performance', '');
    lines.push('| Category | Source | Fetches | Jobs | Errors | Jobs/fetch |');
    lines.push('|----------|--------|---------|------|--------|------------|');
    for (const cat of catOrder) {
      const entries = byCategory[cat];
      if (!entries || entries.length === 0) continue;
      entries.sort((a, b) => b[1].jobs - a[1].jobs);
      for (const [sid, t] of entries) {
        const ratio = t.fetches ? (t.jobs / t.fetches).toFixed(2) : '0';
        lines.push(`| ${catLabels[cat] ?? cat} | ${sid} | ${t.fetches} | ${t.jobs} | ${t.errors} | ${ratio} |`);
      }
    }
  }
  return lines.join('\n');
}

export function showSummary(): string {
  const scans = getRecentScans(1);
  if (scans.length === 0) return 'No scans yet.';
  const s = scans[0]!;

  const filterNote = s.countryFilter ? ` · country=${s.countryFilter}` : '';
  const lines = [
    `# Scan summary — ${s.scanDate} · ${s.mode}${filterNote} · ${(s.durationMs / 1000).toFixed(1)}s`,
    '',
    `**New:** ${s.stats.newSinceLast}    **Updated:** ${s.stats.updated}    **High-fit (≥70):** ${s.stats.highFit}    **Mid-fit (50–69):** ${s.stats.mediumFit}`,
    s.stats.languageRisk > 0 ? `**⚠ Language-risk:** ${s.stats.languageRisk}` : '',
    '',
    '## By source',
    '',
  ];

  // Group per-source by category
  const catLabels: Record<string, string> = {
    job_board: 'Job boards',
    ats:       'ATS companies',
    agency:    'Agencies',
    watchlist: 'Watchlist',
  };
  const catOrder = ['job_board', 'ats', 'watchlist', 'agency'];
  const byCategory: Record<string, Array<[string, { jobsFound: number; errors: string[] }]>> = {};
  for (const cat of catOrder) byCategory[cat] = [];
  for (const [sid, info] of Object.entries(s.perSource)) {
    const cat = (info as { category?: string }).category ?? SOURCE_CATEGORY_MAP[sid] ?? 'job_board';
    (byCategory[cat] ??= []).push([sid, info]);
  }

  lines.push('| Category | Source | Jobs found | Errors |');
  lines.push('|----------|--------|-----------|--------|');
  let anyRows = false;
  for (const cat of catOrder) {
    const entries = byCategory[cat];
    if (!entries || entries.length === 0) continue;
    for (const [sid, info] of entries) {
      lines.push(`| ${catLabels[cat] ?? cat} | ${sid} | ${info.jobsFound} | ${info.errors.length} |`);
      anyRows = true;
    }
  }
  if (!anyRows) lines.push('| — | — | — | — |');

  // Country breakdown
  const cb = (s.stats as ScanStats).countryBreakdown ?? {};
  const countryOrder = ['DE', 'NL', 'CH', 'BE', 'remote', 'other'];
  const allCountries = [
    ...countryOrder.filter((c) => cb[c] != null),
    ...Object.keys(cb).filter((c) => !countryOrder.includes(c)),
  ];
  if (allCountries.length > 0) {
    lines.push('', '## By country', '');
    lines.push('| Country | Jobs |');
    lines.push('|---------|------|');
    for (const c of allCountries) {
      lines.push(`| ${c} | ${cb[c]} |`);
    }
  }

  return lines.filter((l) => l !== '').join('\n');
}

// Import ScanStats for type assertion above
import type { ScanStats } from '../types/job.js';
import { SOURCE_CATEGORY_MAP } from '../collectors/registry.js';

export function compare(id1: string, id2: string): string {
  const a = getJobById(id1);
  const b = getJobById(id2);
  if (!a) return `Job ID '${id1}' not found.`;
  if (!b) return `Job ID '${id2}' not found.`;

  const fields: Array<keyof Job> = [
    'title',
    'company',
    'location',
    'country',
    'score',
    'language',
    'postedDate',
    'firstSeen',
    'remote',
    'salary',
  ];
  const lines = [
    '# Comparison',
    '',
    `| Field | A (${id1.substring(0, 8)}) | B (${id2.substring(0, 8)}) |`,
    '|-------|---|---|',
  ];
  for (const f of fields) {
    const va = String(a[f] ?? '-');
    const vb = String(b[f] ?? '-');
    const marker = va === vb ? ' 🟢' : '';
    lines.push(`| ${f} | ${va} | ${vb}${marker} |`);
  }

  lines.push('', '## Score breakdown', '', '| Component | A | B |', '|-----------|---|---|');
  const components = Object.keys({ ...a.scoreBreakdown, ...b.scoreBreakdown }) as Array<
    keyof Job['scoreBreakdown']
  >;
  for (const c of components) {
    lines.push(`| ${c} | ${a.scoreBreakdown[c] ?? 0} | ${b.scoreBreakdown[c] ?? 0} |`);
  }

  lines.push('', '## Reasons', '', `**A:** ${a.scoreReasons.join(', ')}`, '');
  lines.push(`**B:** ${b.scoreReasons.join(', ')}`);
  return lines.join('\n');
}

export function showJob(idOrPrefix: string): string {
  const lookup = ((): Job | null | 'ambiguous' => {
    if (idOrPrefix.length === 16) return getJobById(idOrPrefix);
    const dbObj = getDb();
    const rows = dbObj
      .prepare(`SELECT id FROM jobs WHERE id LIKE ? LIMIT 2`)
      .all(`${idOrPrefix}%`) as Array<{ id: string }>;
    if (rows.length === 0) return null;
    if (rows.length > 1) return 'ambiguous';
    return getJobById(rows[0]!.id);
  })();

  if (lookup === null) return `No job found with ID '${idOrPrefix}'.`;
  if (lookup === 'ambiguous')
    return `ID prefix '${idOrPrefix}' is ambiguous — use a longer prefix.`;

  const job = lookup;
  const lines: string[] = [];
  lines.push(`# ${job.title}`);
  lines.push('');
  lines.push(`**Company:** ${job.company}`);
  lines.push(`**Location:** ${job.location} (${job.country})`);
  if (job.remote) lines.push(`**Remote:** ${job.remote}`);
  lines.push(`**Posted:** ${job.postedDate ?? 'unknown'}`);
  lines.push(`**Score:** ${job.score}${job.languageRisk ? ' ⚠ language risk' : ''}`);
  lines.push(`**Sources:** ${job.sources.join(', ')}`);
  lines.push(`**Status:** ${job.status}    First seen: ${job.firstSeen}    Last seen: ${job.lastSeen}`);
  if (job.salary) lines.push(`**Salary (raw):** ${job.salary}`);
  if (job.language && job.language !== 'en') lines.push(`**Language:** ${job.language}`);
  if (job.hardLanguageRequirement)
    lines.push(`**Hard language requirement:** ${job.hardLanguageRequirement}`);
  lines.push('');
  if (job.url) {
    lines.push(`**URL:** ${osc8Link(job.url, job.url)}`);
  } else {
    lines.push('**URL:** (no URL stored)');
  }
  lines.push('');
  lines.push('## Snippet');
  lines.push('');
  lines.push((job.descriptionSnippet || '(none)').substring(0, 800));
  lines.push('');
  lines.push('## Score breakdown');
  lines.push('');
  for (const [k, v] of Object.entries(job.scoreBreakdown)) {
    lines.push(`- ${k}: ${v}`);
  }
  if (job.scoreReasons.length > 0) {
    lines.push('');
    lines.push('**Reasons:** ' + job.scoreReasons.join(', '));
  }

  if (job.enrichment?.linkedin) {
    const e = job.enrichment.linkedin;
    lines.push('');
    lines.push('## LinkedIn enrichment');
    lines.push('');
    if (e.applicantCount !== null && e.applicantCount !== undefined)
      lines.push(`- **Applicants:** ${e.applicantCount}`);
    if (e.seniorityLevel) lines.push(`- **Seniority:** ${e.seniorityLevel}`);
    if (e.employmentType) lines.push(`- **Employment type:** ${e.employmentType}`);
    if (e.salary) lines.push(`- **Salary:** ${e.salary}`);
    if (e.easyApply !== undefined) lines.push(`- **Easy Apply:** ${e.easyApply ? 'yes' : 'no'}`);
    if (e.industries && e.industries.length > 0)
      lines.push(`- **Industries:** ${e.industries.join(', ')}`);
    if (e.jobFunctions && e.jobFunctions.length > 0)
      lines.push(`- **Functions:** ${e.jobFunctions.join(', ')}`);
    if (e.skills && e.skills.length > 0)
      lines.push(`- **Skills:** ${e.skills.join(', ')}`);
    if (e.posterName) lines.push(`- **Posted by:** ${e.posterName}`);
    if (e.fullDescription) {
      lines.push('');
      lines.push('### Full description');
      lines.push('');
      lines.push(e.fullDescription);
    }
    if (e.similarJobs && e.similarJobs.length > 0) {
      lines.push('');
      lines.push('### Similar jobs');
      for (const s of e.similarJobs) {
        lines.push(`- ${s.title} @ ${s.company} — ${s.url}`);
      }
    }
    lines.push('');
    lines.push(`fetched ${e.fetchedAt} • $${e.costEstimateUsd.toFixed(4)}`);
  } else if (job.sources.includes('linkedin')) {
    lines.push('');
    lines.push(`(not yet enriched — run \`npm run enrich -- ${job.id.substring(0, 8)}\`)`);
  }

  return lines.join('\n');
}

export function whereBest(): string {
  const all = [...getAllJobs(false), ...getAgencyJobs()];
  if (all.length === 0) return 'No jobs in DB yet.';

  const bySource = new Map<string, number[]>();
  for (const j of all) {
    for (const s of j.sources) {
      const list = bySource.get(s) ?? [];
      list.push(j.score);
      bySource.set(s, list);
    }
  }

  const rows: Array<[string, number, number, number, number]> = [];
  for (const [sid, scores] of bySource) {
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const hi = scores.filter((s) => s >= 70).length;
    const top = Math.max(...scores);
    rows.push([sid, scores.length, Number(avg.toFixed(1)), hi, top]);
  }
  rows.sort((a, b) => b[2] - a[2]);

  const lines = [
    '# Source quality analytics',
    '',
    '| Source | Jobs | Avg score | High-fit | Top |',
    '|--------|------|-----------|----------|-----|',
  ];
  for (const [sid, n, avg, hi, top] of rows) {
    lines.push(`| ${sid} | ${n} | ${avg} | ${hi} | ${top} |`);
  }
  return lines.join('\n');
}

export function showWatchlist(): string {
  const { companies } = loadWatchlist();
  const watchlistNames = new Set(companies.map((c) => c.name.toLowerCase()));

  const allJobs = [...getAllJobs(false)].filter((j) =>
    watchlistNames.has(j.company.toLowerCase()),
  );

  const noApiCompanies = companies
    .filter((c) => !c.slug || !['greenhouse', 'ashby', 'lever'].includes(c.ats))
    .sort((a, b) => a.tier.localeCompare(b.tier) || a.name.localeCompare(b.name));

  const lines: string[] = [];
  lines.push('# Watchlist — jobs from your target companies');
  lines.push('');

  if (allJobs.length === 0) {
    lines.push('No jobs found from watchlist companies yet.');
    lines.push('Run `npm run scan:watchlist` or `npm run scan:full` first.');
  } else {
    lines.push(`**${allJobs.length} jobs found** from ${new Set(allJobs.map((j) => j.company)).size} companies`);
    lines.push('');

    const withTier = allJobs.map((j) => {
      const entry = companies.find((c) => c.name.toLowerCase() === j.company.toLowerCase());
      return { job: j, tier: entry?.tier ?? '?' };
    });
    withTier.sort((a, b) => a.tier.localeCompare(b.tier) || b.job.score - a.job.score);

    withTier.forEach(({ job: j, tier }, i) => {
      const risk = j.languageRisk ? ' ⚠' : '';
      const shortId = j.id.substring(0, 8);
      lines.push(
        `${(i + 1).toString().padStart(2)}.  ${String(j.score).padStart(3)}${risk}  ${j.title.substring(0, 44).padEnd(44)} @ ${j.company} (${j.country}) [${tier}]  [${shortId}]`,
      );
      if (j.url) lines.push(`       ${osc8Link(j.url, j.url)}`);
      lines.push('');
    });
  }

  if (noApiCompanies.length > 0) {
    lines.push('');
    lines.push('## No API coverage — check manually');
    lines.push('');
    lines.push('These companies use Workday, custom portals, or have unknown ATS.');
    lines.push('Check LinkedIn or visit their careers page directly.');
    lines.push('');
    lines.push('| Company | Tier | ATS | Note |');
    lines.push('|---------|------|-----|------|');
    for (const c of noApiCompanies) {
      lines.push(`| ${c.name} | ${c.tier} | ${c.ats} | ${c.note ?? ''} |`);
    }
  }

  return lines.join('\n');
}
