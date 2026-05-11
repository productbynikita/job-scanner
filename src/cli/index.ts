#!/usr/bin/env node
/**
 * job-scanner CLI entrypoint.
 *
 * Usage examples:
 *   npm run scan
 *   npm run scan:quick
 *   npm run show:top
 *   npm run show:new
 *   tsx src/cli/index.ts compare <id1> <id2>
 *   tsx src/cli/index.ts scan --mode full --country DE
 */

import { Command } from 'commander';
import kleur from 'kleur';
import { runScan } from '../scanner.js';
import type { ScanMode } from '../collectors/registry.js';
import { showTop, showNew, showStats, showSummary, compare, whereBest, showJob } from './queries.js';

const program = new Command();

program.name('job-scanner').description('Standalone job board scanner').version('0.1.0');

// ------------------------------------------------------------------ scan
program
  .command('scan')
  .description('Run a scan')
  .option(
    '-m, --mode <mode>',
    'scan mode (quick|full|remote|ats|country|deep|linkedin|glassdoor|agencies)',
    'quick',
  )
  .option('-c, --country <code>', 'filter to a single country (DE/NL/CH/BE/remote)')
  .option('--max-per-source <n>', 'max results per source', (v) => parseInt(v, 10))
  .option('-v, --verbose', 'enable debug logging (LOG_LEVEL=debug)')
  .option('--trace', 'enable trace logging (very verbose, includes every HTTP call)')
  .option('-q, --quiet', 'only log warnings and errors (LOG_LEVEL=warn)')
  .action(
    async (opts: {
      mode: string;
      country?: string;
      maxPerSource?: number;
      verbose?: boolean;
      trace?: boolean;
      quiet?: boolean;
    }) => {
      // Apply log level overrides BEFORE importing scanner (which constructs loggers).
      // Since this runs after imports, we set env and the logger reads it lazily.
      // The logger reads LOG_LEVEL at module load — so we have to re-read.
      // Simplest approach: set the env so child logger calls inherit, and dynamic-import scanner.
      if (opts.trace) process.env.LOG_LEVEL = 'trace';
      else if (opts.verbose) process.env.LOG_LEVEL = 'debug';
      else if (opts.quiet) process.env.LOG_LEVEL = 'warn';

      const validModes: ScanMode[] = [
        'quick',
        'full',
        'remote',
        'deep',
        'ats',
        'country',
        'linkedin',
        'glassdoor',
        'agencies',
      ];

      if (!validModes.includes(opts.mode as ScanMode)) {
        console.error(kleur.red(`Invalid mode: ${opts.mode}. Valid: ${validModes.join(', ')}`));
        process.exit(1);
      }

      console.log(
        kleur.bold(
          `\nScan starting (mode=${opts.mode}${opts.country ? ', country=' + opts.country : ''})\n`,
        ),
      );

      const result = await runScan({
        mode: opts.mode as ScanMode,
        countryFilter: opts.country,
        maxResultsPerSource: opts.maxPerSource,
      });

      if (result.topJobs.length > 0) {
        console.log(kleur.bold('Top 5'));
        for (const j of result.topJobs.slice(0, 5)) {
          const risk = j.languageRisk ? kleur.yellow(' ⚠') : '';
          console.log(
            `  ${kleur.cyan(String(j.score).padStart(3))} ${j.title.padEnd(40)} @ ${j.company} (${j.country})${risk}`,
          );
        }
        console.log();
      }

      console.log(kleur.dim('Use `npm run show:new` to see all new jobs.'));
      process.exit(0);
    },
  );

// ------------------------------------------------------------------ show
const show = program.command('show').description('Read-only commands (no scan)');

show
  .command('top [n]')
  .description('Show top N jobs by score')
  .option('--include-agency', 'include agency jobs')
  .option('--min-domain <n>', 'minimum domain fit score (0-25). Filters out non-tech roles', (v) => parseInt(v, 10))
  .action((n: string | undefined, opts: { includeAgency?: boolean; minDomain?: number }) => {
    const num = n ? parseInt(n, 10) : 10;
    console.log(showTop(num, opts.includeAgency ?? false, opts.minDomain ?? 0));
  });

show
  .command('new')
  .description('Show jobs added since the last scan')
  .action(() => console.log(showNew()));

show
  .command('stats')
  .description('Show scan history and per-source performance')
  .action(() => console.log(showStats()));

show
  .command('summary')
  .description('Show summary of the latest scan')
  .action(() => console.log(showSummary()));

show
  .command('job <jobId>')
  .description('Show full details for one job (inc. LinkedIn enrichment if present)')
  .action((jobId: string) => console.log(showJob(jobId)));

// ------------------------------------------------------------------ compare
program
  .command('compare <id1> <id2>')
  .description('Side-by-side comparison of two jobs')
  .action((id1: string, id2: string) => {
    console.log(compare(id1, id2));
  });

// ------------------------------------------------------------------ where-best
program
  .command('where-best')
  .description('Analytics: which sources surface the highest-scored jobs')
  .action(() => console.log(whereBest()));

// ------------------------------------------------------------------ agencies
const agencies = program.command('agencies').description('Manage recruiting agency sources');

agencies
  .command('list')
  .description('List all configured agencies and their registration status')
  .action(async () => {
    const { listAgencies } = await import('./agencyCli.js');
    console.log(listAgencies());
  });

agencies
  .command('register <id>')
  .description('Mark an agency as registered (updates agencies.json)')
  .option('--contact <name>', 'recruiter contact name')
  .action(async (id: string, opts: { contact?: string }) => {
    const { registerAgency } = await import('./agencyCli.js');
    console.log(registerAgency(id, opts.contact));
  });

agencies
  .command('unregister <id>')
  .description('Mark an agency as not registered')
  .action(async (id: string) => {
    const { unregisterAgency } = await import('./agencyCli.js');
    console.log(unregisterAgency(id));
  });

// ------------------------------------------------------------------ enrich
program
  .command('enrich <jobId>')
  .description('Fetch LinkedIn details (applicant count, full description, skills) for a job. Costs ~$0.006/job.')
  .option('-y, --yes', 'skip the cost confirmation prompt')
  .action(async (jobId: string, opts: { yes?: boolean }) => {
    const { runEnrich } = await import('./enrich.js');
    await runEnrich({ jobId, skipConfirm: opts.yes });
  });

// ------------------------------------------------------------------ AI commands (Phase 6)
program
  .command('assess <jobId>')
  .description('Deep fit analysis of a job against your CV (~$0.11/call)')
  .option('-y, --yes', 'skip cost confirmation')
  .option('--model <name>', 'Claude model override', 'claude-opus-4-5')
  .action(async (jobId: string, opts: { yes?: boolean; model?: string }) => {
    const { runAiCommand } = await import('./ai.js');
    await runAiCommand({ command: 'assess', jobId, skipConfirm: opts.yes, model: opts.model });
  });

program
  .command('tailor-cv <jobId>')
  .description('Tailored CV bullet points for a specific role (~$0.21/call)')
  .option('-y, --yes', 'skip cost confirmation')
  .option('--model <name>', 'Claude model override', 'claude-opus-4-5')
  .action(async (jobId: string, opts: { yes?: boolean; model?: string }) => {
    const { runAiCommand } = await import('./ai.js');
    await runAiCommand({ command: 'tailor-cv', jobId, skipConfirm: opts.yes, model: opts.model });
  });

program
  .command('cover <jobId>')
  .description('Cover letter draft for a specific role (~$0.09/call)')
  .option('-y, --yes', 'skip cost confirmation')
  .option('--model <name>', 'Claude model override', 'claude-opus-4-5')
  .action(async (jobId: string, opts: { yes?: boolean; model?: string }) => {
    const { runAiCommand } = await import('./ai.js');
    await runAiCommand({ command: 'cover', jobId, skipConfirm: opts.yes, model: opts.model });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(kleur.red('Fatal:'), err);
  process.exit(1);
});
