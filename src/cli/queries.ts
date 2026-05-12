/**
 * Read-only query commands. Used by `show top`, `show new`, etc.
 * These never make HTTP calls — they only read SQLite.
 */

import {
  getAllJobs,
  getAgencyJobs,
  getJobById,
  getJobsByStatus,
  getRecentScans,
  getDb,
} from '../storage/db.js';
import type { Job } from '../types/job.js';

/**
 * OSC 8 terminal hyperlink — works in iTerm2, modern terminals, VS Code terminal.
 * Falls back to plain text in environments that don't support it.
 */
function osc8Link(text: string, url: string): string {
  if (!url || url === '-') return text;
  return `]8;;${url}\\${text}]8;;\\`;
}

function formatJobRow(job: Job, idx: number): string {
  const risk = job.languageRisk ? ' ⚠' : '';
  const url = job.url || '';
  const shortId = job.id.substring(0, 8);
  // Title becomes a clickable hyperlink in supported terminals
  const titleCell = url ? osc8Link(job.title, url) : job.title;
  const urlCell = url ? osc8Link('→ open', url) : '-';
  return `| ${idx} | \`${shortId}\` | ${job.score}${risk} | ${titleCell} | ${job.company} | ${job.country} | ${job.postedDate ?? '?'} | ${job.status} | ${urlCell} |`;
}

export function showTop(n = 10, includeAgency = false, minDomain = 0): string {
  const jobs = includeAgency
    ? [...getAllJobs(false), ...getAgencyJobs()].sort((a, b) => b.score - a.score)
    : getAllJobs(false);

  const filtered = minDomain > 0
    ? jobs.filter((j) => (j.scoreBreakdown.domainFit ?? 0) >= minDomain)
    : jobs;

  const top = filtered.slice(0, n);
  if (top.length === 0) return 'No jobs in DB yet. Run `npm run scan` first.';

  const lines = [
    `# Top ${top.length} jobs`,
    '',
    '| # | ID | Score | Title | Company | Country | Posted | Status | URL |',
    '|---|----|-------|-------|---------|---------|--------|--------|-----|',
    ...top.map((j, i) => formatJobRow(j, i + 1)),
  ];
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
    lines.push('| ID | Score | Title | Company | Country | Posted | First seen | URL |');
    lines.push('|----|-------|-------|---------|---------|--------|------------|-----|');
    for (const j of board.slice(0, 30)) {
      const shortId = j.id.substring(0, 8);
      const url = j.url || '-';
      lines.push(
        `| \`${shortId}\` | ${j.score} | ${j.title} | ${j.company} | ${j.country} | ${j.postedDate ?? '?'} | ${j.firstSeen} | ${url} |`,
      );
    }
    lines.push('');
  }

  if (agency.length > 0) {
    lines.push('## New from agencies', '');
    lines.push('| ID | Score | Title | Company | Country | Sources | URL |');
    lines.push('|----|-------|-------|---------|---------|---------|-----|');
    for (const j of agency.slice(0, 30)) {
      const shortId = j.id.substring(0, 8);
      const url = j.url || '-';
      lines.push(
        `| \`${shortId}\` | ${j.score} | ${j.title} | ${j.company} | ${j.country} | ${j.sources.join(', ')} | ${url} |`,
      );
    }
    lines.push('');
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
    lines.push('', '## Cumulative per-source performance', '');
    lines.push('| Source | Fetches | Jobs | Errors | Jobs/fetch |');
    lines.push('|--------|---------|------|--------|------------|');
    const sorted = Array.from(totals.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    for (const [sid, t] of sorted) {
      const ratio = t.fetches ? (t.jobs / t.fetches).toFixed(2) : '0';
      lines.push(`| ${sid} | ${t.fetches} | ${t.jobs} | ${t.errors} | ${ratio} |`);
    }
  }
  return lines.join('\n');
}

export function showSummary(): string {
  const scans = getRecentScans(1);
  if (scans.length === 0) return 'No scans yet.';
  const s = scans[0]!;

  const lines = [
    `# Latest scan — ${s.scanDate}`,
    '',
    `**Mode:** ${s.mode}`,
    s.countryFilter ? `**Country filter:** ${s.countryFilter}` : '',
    `**Duration:** ${(s.durationMs / 1000).toFixed(1)}s`,
    `**Raw collected:** ${s.stats.rawCount}`,
    `**After dedupe:** ${s.stats.afterDedupe}`,
    `**High-fit:** ${s.stats.highFit}    **Medium-fit:** ${s.stats.mediumFit}`,
    `**New since last:** ${s.stats.newSinceLast}    **Updated:** ${s.stats.updated}`,
    `**Language-risk:** ${s.stats.languageRisk}`,
    '',
    '## Per-source',
    '',
    '| Source | Jobs | Errors |',
    '|--------|------|--------|',
  ];
  for (const [sid, info] of Object.entries(s.perSource)) {
    lines.push(`| ${sid} | ${info.jobsFound} | ${info.errors.length} |`);
  }
  return lines.filter(Boolean).join('\n');
}

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
  lines.push(`**URL:** ${job.url || '(no URL stored)'}`);
  lines.push('');
  lines.push('## Snippet');
  lines.push('');
  lines.push(job.descriptionSnippet || '(none)');
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
    lines.push(kleurDim(`fetched ${e.fetchedAt} • $${e.costEstimateUsd.toFixed(4)}`));
  } else if (job.sources.includes('linkedin')) {
    lines.push('');
    lines.push(kleurDim(`(not yet enriched — run \`npm run enrich -- ${job.id.substring(0, 8)}\`)`));
  }

  return lines.join('\n');
}

// Tiny helper so we don't need to import kleur in this read-only module
function kleurDim(s: string): string {
  return s;
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
