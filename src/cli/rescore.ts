#!/usr/bin/env node
/**
 * rescore — re-run the scoring engine on every job already in jobs.db.
 *
 * Use this after editing data/inputs/roles.json or data/inputs/profile.json
 * to tune keywords/weights to your background. No API calls, no cost, instant.
 *
 * Usage:
 *   npm run rescore            # rescore all jobs, show summary
 *   npm run rescore -- --dry   # preview score changes without writing
 *   npm run rescore -- --show  # rescore + immediately open HTML report
 */

import 'dotenv/config';
import { Command } from 'commander';
import kleur from 'kleur';
import { exec } from 'node:child_process';
import { getDb } from '../storage/db.js';
import { loadAllConfig } from '../config/loader.js';
import { scoreJob } from '../processors/score.js';
import { detectLanguage, hasHardLanguageRequirement } from '../processors/language.js';
import type { Job, Language } from '../types/job.js';

interface JobRow {
  id: string;
  title: string;
  company: string;
  location: string;
  country: string;
  remote: string;
  url: string;
  description_snippet: string;
  salary: string | null;
  posted_date: string | null;
  source: string;
  is_agency: number;
  language: string | null;
  hard_language_requirement: string | null;
  score: number;
  score_breakdown: string;
  score_reasons: string;
  language_risk: number;
  status: string;
  first_seen: string;
  last_seen: string;
  scan_count: number;
  sources: string;
  enrichment: string | null;
  career_ops: string | null;
}

function rowToPartialJob(row: JobRow): Parameters<typeof scoreJob>[0] {
  return {
    title: row.title,
    company: row.company,
    location: row.location,
    country: row.country,
    remote: row.remote as Job['remote'],
    url: row.url,
    descriptionSnippet: row.description_snippet,
    salary: row.salary,
    postedDate: row.posted_date,
    source: row.source,
    isAgency: Boolean(row.is_agency),
    language: (row.language as Language | null) ?? undefined,
  };
}

function tierLabel(score: number): string {
  if (score >= 70) return kleur.green('high  ');
  if (score >= 50) return kleur.yellow('medium');
  return kleur.dim('low   ');
}

function delta(before: number, after: number): string {
  const d = after - before;
  if (d === 0) return kleur.dim('  ±0');
  if (d > 0) return kleur.green(`  +${d}`);
  return kleur.red(`  ${d}`);
}

async function rescore(opts: { dry: boolean; show: boolean }) {
  const config = loadAllConfig();
  const db = getDb();

  const rows = db.prepare('SELECT * FROM jobs ORDER BY score DESC').all() as JobRow[];
  if (rows.length === 0) {
    console.log(kleur.yellow('No jobs in DB. Run `npm run scan` or `npm run replay` first.'));
    return;
  }

  console.log(kleur.bold().cyan(`\nRescoring ${rows.length} jobs with current config…\n`));

  const updateStmt = db.prepare(`
    UPDATE jobs
    SET score = ?, score_breakdown = ?, score_reasons = ?, language_risk = ?, language = ?, hard_language_requirement = ?
    WHERE id = ?
  `);

  let unchanged = 0;
  let improved = 0;
  let worsened = 0;
  let highCount = 0;
  let medCount = 0;
  let lowCount = 0;
  const changes: Array<{ title: string; company: string; before: number; after: number }> = [];

  const rescoreAll = db.transaction(() => {
    for (const row of rows) {
      const job = rowToPartialJob(row);

      // Re-detect language from title + snippet in case language model changed
      const fullText = `${row.title} ${row.description_snippet ?? ''}`;
      const lang: Language = (row.language as Language | null) ?? detectLanguage(fullText);
      const hardReq = row.hard_language_requirement ?? hasHardLanguageRequirement(fullText);

      const result = scoreJob({ ...job, language: lang as Language }, config.roles);

      if (!opts.dry) {
        updateStmt.run(
          result.score,
          JSON.stringify(result.breakdown),
          JSON.stringify(result.reasons),
          result.languageRisk ? 1 : 0,
          lang,
          hardReq || null,
          row.id,
        );
      }

      // Track stats
      const before = row.score;
      const after = result.score;
      if (after >= 70) highCount++;
      else if (after >= 50) medCount++;
      else lowCount++;

      if (before === after) {
        unchanged++;
      } else {
        if (after > before) improved++;
        else worsened++;
        changes.push({ title: row.title, company: row.company, before, after });
      }
    }
  });

  rescoreAll();

  // Sort changes by absolute delta descending
  changes.sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before));

  // Show biggest movers
  if (changes.length > 0) {
    console.log(kleur.bold('Biggest score changes:'));
    console.log('');
    const top = changes.slice(0, 20);
    for (const c of top) {
      const company = c.company.substring(0, 22).padEnd(22);
      const title = c.title.substring(0, 40).padEnd(40);
      console.log(
        `  ${tierLabel(c.after)}  ${delta(c.before, c.after)}  ${kleur.dim(String(c.before).padStart(3))} → ${String(c.after).padStart(3)}  ${kleur.cyan(company)}  ${title}`,
      );
    }
    console.log('');
  }

  // Summary
  console.log(kleur.bold().cyan('────────────────────────────────────────'));
  console.log(kleur.bold('  Rescore Summary'));
  console.log(kleur.bold().cyan('────────────────────────────────────────'));
  console.log(`  Jobs rescored:    ${rows.length}`);
  console.log(`  ${kleur.green('Improved:')} ${improved}    ${kleur.red('Worsened:')} ${worsened}    ${kleur.dim('Unchanged:')} ${unchanged}`);
  console.log('');
  console.log(`  ${kleur.green().bold('High-fit  (≥70):')} ${String(highCount).padStart(4)}  jobs`);
  console.log(`  ${kleur.yellow().bold('Medium-fit(50-69):')} ${String(medCount).padStart(3)}  jobs`);
  console.log(`  ${kleur.dim().bold('Low-fit   (<50):')} ${String(lowCount).padStart(4)}  jobs`);

  if (opts.dry) {
    console.log(kleur.yellow('\n  DRY RUN — nothing written to DB'));
  } else {
    console.log(kleur.dim('\n  Scores updated. Run `npm run show:open` to browse results.'));
  }
  console.log();

  if (opts.show && !opts.dry) {
    exec('npm run show:open', (err) => {
      if (err) console.error(kleur.red('Could not open browser report:'), err.message);
    });
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('rescore')
  .description('Re-score all jobs in DB using current roles.json config')
  .option('--dry', 'Preview score changes without writing to DB')
  .option('--show', 'Open HTML report in browser after rescoring')
  .action(async (opts: { dry?: boolean; show?: boolean }) => {
    await rescore({ dry: opts.dry ?? false, show: opts.show ?? false });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(kleur.red('Fatal:'), err);
  process.exit(1);
});
