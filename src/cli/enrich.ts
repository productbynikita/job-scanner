/**
 * CLI handler for `npm run enrich -- <job_id>`.
 *
 * Flow:
 *   1. Load job from DB by ID (supports short ID prefix match — 8+ chars)
 *   2. Verify it's a LinkedIn job
 *   3. Show estimated cost + current month's Apify spend
 *   4. Ask for explicit confirmation (unless --yes flag passed)
 *   5. Call enrichLinkedInJob, save via updateEnrichment
 *   6. Print summary including applicant count, skills, etc.
 */

import kleur from 'kleur';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { getDb, getJobById, updateEnrichment, closeDb } from '../storage/db.js';
import { enrichLinkedInJob } from '../collectors/linkedinEnrich.js';
import {
  getCurrentMonthSpendUsd,
  getMonthlyBudgetUsd,
  hasApifyToken,
} from '../apify/client.js';
import type { Job } from '../types/job.js';

const ESTIMATED_COST_USD = 0.006;

/** Find a job by either full 16-char ID or 8+ char prefix. Returns null if ambiguous or missing. */
function findJobByIdOrPrefix(idOrPrefix: string): { job: Job | null; ambiguous: boolean } {
  if (idOrPrefix.length === 16) {
    return { job: getJobById(idOrPrefix), ambiguous: false };
  }

  const db = getDb();
  const rows = db
    .prepare(`SELECT id FROM jobs WHERE id LIKE ? LIMIT 2`)
    .all(`${idOrPrefix}%`) as Array<{ id: string }>;
  if (rows.length === 0) return { job: null, ambiguous: false };
  if (rows.length > 1) return { job: null, ambiguous: true };

  return { job: getJobById(rows[0]!.id), ambiguous: false };
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(prompt);
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

export interface RunEnrichOptions {
  jobId: string;
  skipConfirm?: boolean;
}

export async function runEnrich(opts: RunEnrichOptions): Promise<void> {
  if (!hasApifyToken()) {
    console.error(
      kleur.red(
        '✗ APIFY_TOKEN not set. Sign up at https://apify.com and add the token to .env (see .env.example).',
      ),
    );
    process.exit(1);
  }

  const { job, ambiguous } = findJobByIdOrPrefix(opts.jobId);

  if (ambiguous) {
    console.error(
      kleur.red(`✗ Job ID prefix '${opts.jobId}' matches multiple jobs. Use a longer prefix.`),
    );
    process.exit(1);
  }
  if (!job) {
    console.error(kleur.red(`✗ No job found with ID '${opts.jobId}'.`));
    console.error(kleur.dim('  Run `npm run show:top` to see job IDs.'));
    process.exit(1);
  }

  if (!job.sources.includes('linkedin')) {
    console.error(
      kleur.red(
        `✗ Enrichment only supports LinkedIn jobs. This job's sources: ${job.sources.join(', ') || 'unknown'}`,
      ),
    );
    process.exit(1);
  }
  if (!job.url || !job.url.includes('linkedin.com')) {
    console.error(
      kleur.red(`✗ Job has no usable LinkedIn URL. Stored URL: ${job.url || '<empty>'}`),
    );
    process.exit(1);
  }
  if (job.enrichment?.linkedin) {
    console.log(kleur.yellow('⚠ This job has already been enriched.'));
    console.log(
      kleur.dim(
        `  Previously fetched ${job.enrichment.linkedin.fetchedAt}. Re-enriching will overwrite.`,
      ),
    );
  }

  // Cost summary
  const currentSpend = getCurrentMonthSpendUsd();
  const budget = getMonthlyBudgetUsd();
  const projected = currentSpend + ESTIMATED_COST_USD;

  console.log();
  console.log(kleur.bold('LinkedIn job enrichment'));
  console.log(kleur.dim('─'.repeat(40)));
  console.log(`  Job:           ${kleur.cyan(job.title)} @ ${job.company}`);
  console.log(`  Location:      ${job.location || '-'} (${job.country || '?'})`);
  console.log(`  URL:           ${job.url}`);
  console.log(`  Current score: ${job.score}`);
  console.log();
  console.log(kleur.bold('Cost estimate'));
  console.log(kleur.dim('─'.repeat(40)));
  console.log(`  This call:     ${kleur.cyan('$' + ESTIMATED_COST_USD.toFixed(4))}`);
  console.log(`  Month so far:  $${currentSpend.toFixed(4)}`);
  console.log(`  After call:    $${projected.toFixed(4)} of $${budget.toFixed(2)} budget`);
  console.log();

  if (projected > budget) {
    console.error(
      kleur.red(
        `✗ This call would exceed your monthly budget ($${budget}). Raise APIFY_MONTHLY_BUDGET_USD in .env or wait.`,
      ),
    );
    process.exit(1);
  }

  if (!opts.skipConfirm) {
    const ok = await confirm(kleur.bold(`Proceed? [y/N] `));
    if (!ok) {
      console.log(kleur.dim('Cancelled.'));
      process.exit(0);
    }
  }

  console.log();
  console.log(kleur.dim('Calling actor...'));

  try {
    const { enrichment, costEstimateUsd } = await enrichLinkedInJob(job.url);
    const saved = updateEnrichment(job.id, 'linkedin', enrichment);

    if (!saved) {
      console.error(kleur.red('✗ DB write failed.'));
      process.exit(1);
    }

    console.log();
    console.log(kleur.green('✓ Enrichment saved.'));
    console.log(kleur.dim('─'.repeat(40)));
    console.log(
      `  Applicants:   ${enrichment.applicantCount !== null && enrichment.applicantCount !== undefined ? kleur.cyan(String(enrichment.applicantCount)) : kleur.dim('not exposed')}`,
    );
    if (enrichment.seniorityLevel) console.log(`  Seniority:    ${enrichment.seniorityLevel}`);
    if (enrichment.employmentType) console.log(`  Type:         ${enrichment.employmentType}`);
    if (enrichment.salary) console.log(`  Salary:       ${enrichment.salary}`);
    if (enrichment.easyApply !== undefined)
      console.log(`  Easy Apply:   ${enrichment.easyApply ? 'yes' : 'no'}`);
    if (enrichment.skills && enrichment.skills.length > 0)
      console.log(`  Skills:       ${enrichment.skills.slice(0, 8).join(', ')}`);
    if (enrichment.similarJobs && enrichment.similarJobs.length > 0)
      console.log(`  Similar:      ${enrichment.similarJobs.length} related jobs`);
    if (enrichment.fullDescription)
      console.log(`  Description:  ${enrichment.fullDescription.length} chars stored`);
    console.log();
    console.log(kleur.dim(`  Actual cost:  $${costEstimateUsd.toFixed(4)}`));
    console.log(
      kleur.dim(
        `  Month total:  $${getCurrentMonthSpendUsd().toFixed(4)} of $${budget.toFixed(2)}`,
      ),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(kleur.red(`✗ Enrichment failed: ${msg}`));
    process.exit(1);
  } finally {
    closeDb();
  }
}
