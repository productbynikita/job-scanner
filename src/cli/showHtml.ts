#!/usr/bin/env node
/**
 * show:open — generate a clean HTML report and open it in the default browser.
 *
 * Usage:
 *   npm run show:open             # top 50 jobs
 *   npm run show:open -- -n 100  # top 100 jobs
 *   npm run show:open -- --new   # only new (unseen) jobs
 *   npm run show:open -- --min-domain 10  # filter by domain score
 */

import 'dotenv/config';
import { Command } from 'commander';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import { getAllJobs, getAgencyJobs, getJobsByStatus } from '../storage/db.js';
import type { Job } from '../types/job.js';

function scoreColor(score: number): string {
  if (score >= 70) return '#22c55e';   // green
  if (score >= 50) return '#f59e0b';   // amber
  return '#94a3b8';                     // slate (low)
}

function badge(score: number): string {
  const color = scoreColor(score);
  return `<span style="background:${color};color:#fff;border-radius:4px;padding:2px 7px;font-size:12px;font-weight:700">${score}</span>`;
}

function remoteIcon(remote: string): string {
  if (!remote) return '';
  if (remote === 'remote') return ' 🌍';
  if (remote === 'hybrid') return ' 🏠';
  return '';
}

function postedAge(dateStr: string | null): string {
  if (!dateStr) return '<span style="color:#94a3b8">?</span>';
  const posted = new Date(dateStr);
  const days = Math.floor((Date.now() - posted.getTime()) / 86_400_000);
  let color = '#22c55e';
  if (days > 14) color = '#f59e0b';
  if (days > 30) color = '#ef4444';
  const label = days === 0 ? 'today' : days === 1 ? '1d ago' : `${days}d ago`;
  return `<span style="color:${color}">${label}</span>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderRow(job: Job, idx: number): string {
  const shortId = job.id.substring(0, 8);
  const url = job.url || '#';
  const isLinkedIn = url.includes('linkedin.com');
  const linkIcon = isLinkedIn ? '🔗' : '↗';
  const risk = job.languageRisk ? ' <span title="Language risk" style="color:#f59e0b">⚠</span>' : '';
  const remote = remoteIcon(job.remote);
  const company = escapeHtml(job.company);
  const title = escapeHtml(job.title);
  const country = job.country || '?';
  const sourceTag = job.isAgency
    ? `<span style="font-size:10px;background:#7c3aed;color:#fff;border-radius:3px;padding:1px 5px">agency</span>`
    : '';

  // Domain breakdown tooltip
  const breakdown = Object.entries(job.scoreBreakdown)
    .map(([k, v]) => `${k}:${v}`)
    .join(' | ');

  return `
  <tr class="job-row" data-score="${job.score}" data-country="${country}" data-status="${job.status}">
    <td style="text-align:center;color:#94a3b8;font-size:12px">${idx}</td>
    <td>${badge(job.score)}${risk}</td>
    <td>
      <a href="${escapeHtml(url)}" target="_blank" rel="noopener" style="color:#3b82f6;text-decoration:none;font-weight:600" title="${breakdown}">
        ${title}${remote}
      </a>
      ${sourceTag}
    </td>
    <td style="color:#e2e8f0">${company}</td>
    <td style="text-align:center;font-size:13px">${country}</td>
    <td style="text-align:center;font-size:12px">${postedAge(job.postedDate)}</td>
    <td style="text-align:center;font-family:monospace;font-size:11px;color:#94a3b8">${shortId}</td>
    <td style="text-align:center">
      <a href="${escapeHtml(url)}" target="_blank" rel="noopener"
         style="display:inline-block;background:#1d4ed8;color:#fff;border-radius:5px;padding:3px 10px;font-size:12px;text-decoration:none">
        ${linkIcon} Open
      </a>
    </td>
  </tr>`;
}

function generateHtml(jobs: Job[], title: string): string {
  const rows = jobs.map((j, i) => renderRow(j, i + 1)).join('');
  const generated = new Date().toLocaleString();
  const highCount = jobs.filter((j) => j.score >= 70).length;
  const medCount = jobs.filter((j) => j.score >= 50 && j.score < 70).length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f172a; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 24px; }
  h1 { font-size: 22px; color: #f8fafc; margin-bottom: 6px; }
  .meta { font-size: 13px; color: #64748b; margin-bottom: 20px; }
  .stats { display: flex; gap: 16px; margin-bottom: 20px; }
  .stat { background: #1e293b; border-radius: 8px; padding: 12px 18px; }
  .stat-val { font-size: 24px; font-weight: 700; }
  .stat-lbl { font-size: 12px; color: #64748b; margin-top: 2px; }
  .filters { display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; align-items: center; }
  .filters label { font-size: 13px; color: #94a3b8; }
  .filters select, .filters input { background: #1e293b; color: #e2e8f0; border: 1px solid #334155; border-radius: 6px; padding: 5px 10px; font-size: 13px; }
  .filters input[type=range] { width: 120px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  thead th { background: #1e293b; color: #94a3b8; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; padding: 10px 12px; text-align: left; position: sticky; top: 0; z-index: 1; }
  tbody tr { border-bottom: 1px solid #1e293b; transition: background .1s; }
  tbody tr:hover { background: #1e293b; }
  tbody td { padding: 10px 12px; vertical-align: middle; }
  .hidden { display: none !important; }
  #count { font-size: 13px; color: #64748b; }
</style>
</head>
<body>
<h1>📋 ${escapeHtml(title)}</h1>
<div class="meta">Generated ${generated} · ${jobs.length} jobs total</div>

<div class="stats">
  <div class="stat"><div class="stat-val" style="color:#22c55e">${highCount}</div><div class="stat-lbl">High fit (≥70)</div></div>
  <div class="stat"><div class="stat-val" style="color:#f59e0b">${medCount}</div><div class="stat-lbl">Medium fit (50-69)</div></div>
  <div class="stat"><div class="stat-val" style="color:#94a3b8">${jobs.length - highCount - medCount}</div><div class="stat-lbl">Low fit (&lt;50)</div></div>
</div>

<div class="filters">
  <label>Country:
    <select id="filterCountry" onchange="applyFilters()">
      <option value="">All</option>
      <option value="DE">🇩🇪 DE</option>
      <option value="NL">🇳🇱 NL</option>
      <option value="CH">🇨🇭 CH</option>
      <option value="BE">🇧🇪 BE</option>
      <option value="">Other</option>
    </select>
  </label>
  <label>Min score:
    <input type="range" id="filterScore" min="0" max="100" value="0" oninput="scoreVal.textContent=this.value;applyFilters()">
    <span id="scoreVal">0</span>
  </label>
  <label>Search:
    <input type="text" id="filterSearch" placeholder="title or company…" oninput="applyFilters()" style="width:180px">
  </label>
  <span id="count"></span>
</div>

<table>
  <thead>
    <tr>
      <th>#</th>
      <th>Score</th>
      <th>Title</th>
      <th>Company</th>
      <th>Country</th>
      <th>Posted</th>
      <th>ID</th>
      <th>Link</th>
    </tr>
  </thead>
  <tbody id="tbody">
    ${rows}
  </tbody>
</table>

<script>
function applyFilters() {
  const country = document.getElementById('filterCountry').value;
  const minScore = parseInt(document.getElementById('filterScore').value, 10);
  const search = document.getElementById('filterSearch').value.toLowerCase();
  const rows = document.querySelectorAll('.job-row');
  let visible = 0;
  rows.forEach(row => {
    const score = parseInt(row.dataset.score, 10);
    const rc = row.dataset.country;
    const text = row.textContent.toLowerCase();
    const show =
      (!country || rc === country) &&
      score >= minScore &&
      (!search || text.includes(search));
    row.classList.toggle('hidden', !show);
    if (show) visible++;
  });
  document.getElementById('count').textContent = visible + ' shown';
}
applyFilters();
</script>
</body>
</html>`;
}

async function openInBrowser(filePath: string): Promise<void> {
  const url = `file://${filePath}`;
  const platform = process.platform;
  const cmd = platform === 'darwin' ? `open "${url}"`
    : platform === 'win32' ? `start "" "${url}"`
    : `xdg-open "${url}"`;

  return new Promise((resolve) => {
    exec(cmd, () => resolve());
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('show-open')
  .description('Generate HTML job report and open in browser')
  .option('-n, --num <n>', 'Number of jobs to show', '50')
  .option('--new', 'Only show new (unseen) jobs')
  .option('--min-domain <n>', 'Minimum domain score', '0')
  .option('--agency', 'Include agency jobs')
  .option('--out <path>', 'Write HTML to this file instead of a temp file')
  .action(async (opts: { num: string; new?: boolean; minDomain: string; agency?: boolean; out?: string }) => {
    const n = parseInt(opts.num, 10) || 50;
    const minDomain = parseInt(opts.minDomain, 10) || 0;

    let jobs: Job[];
    let title: string;

    if (opts.new) {
      jobs = getJobsByStatus('new');
      title = `New jobs — ${new Date().toLocaleDateString()}`;
    } else {
      jobs = opts.agency
        ? [...getAllJobs(false), ...getAgencyJobs()].sort((a, b) => b.score - a.score)
        : getAllJobs(false);
      title = `Top ${n} jobs — ${new Date().toLocaleDateString()}`;
    }

    if (minDomain > 0) {
      jobs = jobs.filter((j) => (j.scoreBreakdown.domainFit ?? 0) >= minDomain);
    }

    jobs = jobs.slice(0, n);

    if (jobs.length === 0) {
      console.error('No jobs found. Run `npm run scan` first.');
      process.exit(1);
    }

    const html = generateHtml(jobs, title);
    const outPath = opts.out ?? join(tmpdir(), `job-scanner-${Date.now()}.html`);
    writeFileSync(outPath, html, 'utf-8');

    console.log(`✅ Report: ${outPath}`);
    console.log(`📋 ${jobs.length} jobs`);
    await openInBrowser(outPath);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
