/**
 * Phase 6 — AI-powered job analysis using Claude.
 *
 * Three commands:
 *   npm run assess -- <jobId>      Deep job-fit analysis against your CV
 *   npm run tailor-cv -- <jobId>   Tailored CV bullet points for the role
 *   npm run cover -- <jobId>       Cover letter draft
 *
 * All commands:
 *   - Show a cost estimate and ask for confirmation before calling the API
 *   - Stream the response to stdout
 *   - Accept -y / --yes to skip the confirmation prompt
 *   - Accept --model <name> to override the default model
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import kleur from 'kleur';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { getJobById, getDb } from '../storage/db.js';
import { loadCv } from '../config/loader.js';
import type { Job } from '../types/job.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = 'claude-opus-4-5';

// Approximate cost per 1M tokens (USD) — update if pricing changes
const COST_PER_1M_INPUT = 15.0;   // claude-opus-4-5 input
const COST_PER_1M_OUTPUT = 75.0;  // claude-opus-4-5 output

// Rough token budgets for each command
const TOKEN_ESTIMATES = {
  assess:    { inputK: 4, outputK: 1.5 },
  'tailor-cv': { inputK: 4, outputK: 2 },
  cover:     { inputK: 4, outputK: 1.2 },
};

export type AiCommand = 'assess' | 'tailor-cv' | 'cover';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function estimateCost(cmd: AiCommand): string {
  const { inputK, outputK } = TOKEN_ESTIMATES[cmd];
  const cost = (inputK / 1000) * COST_PER_1M_INPUT + (outputK / 1000) * COST_PER_1M_OUTPUT;
  return `~$${cost.toFixed(4)}`;
}

function resolveJob(idOrPrefix: string): Job | null {
  if (idOrPrefix.length === 16) return getJobById(idOrPrefix);
  const db = getDb();
  const rows = db.prepare('SELECT id FROM jobs WHERE id LIKE ? LIMIT 2').all(`${idOrPrefix}%`) as { id: string }[];
  if (rows.length !== 1) return null;
  return getJobById(rows[0]!.id);
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(prompt);
  rl.close();
  return answer.trim().toLowerCase().startsWith('y');
}

function buildJobContext(job: Job): string {
  return [
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    `Location: ${job.location} (${job.country})`,
    job.remote ? `Remote: ${job.remote}` : '',
    job.salary ? `Salary: ${job.salary}` : '',
    job.postedDate ? `Posted: ${job.postedDate}` : '',
    '',
    'Job description:',
    job.enrichment?.linkedin?.fullDescription ?? job.descriptionSnippet ?? '(no description)',
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function assessPrompt(job: Job, cv: string): string {
  return `You are a senior career coach helping a product manager evaluate a job opportunity.

## Candidate CV
${cv}

## Job Posting
${buildJobContext(job)}

## Your task
Provide a structured fit analysis covering:

1. **Overall fit** (1-5 score with rationale)
2. **Strengths match** — where the candidate's background directly maps to requirements
3. **Gaps** — missing skills or experience, and how critical each is
4. **Red flags** — anything that should give the candidate pause (culture, stability, scope)
5. **Differentiation** — what makes this candidate stand out for this specific role
6. **Interview prep** — 3 questions the interviewer will likely ask, with suggested answer angles
7. **Recommendation** — apply / apply with caveats / skip, with one clear reason

Be direct and specific. Reference actual CV details and job requirements.`;
}

function tailorCvPrompt(job: Job, cv: string): string {
  return `You are an expert CV writer specialising in product management roles.

## Current CV
${cv}

## Target Job
${buildJobContext(job)}

## Your task
Rewrite the candidate's experience bullet points to better match this specific role.
For each current role in the CV:
- Keep the same facts and metrics — do not invent anything
- Reorder and reframe bullets to emphasise what this job posting values most
- Use language from the job description naturally (don't stuff keywords awkwardly)
- Flag which bullets are strongest matches with ✓ and which are weaker with ~

Also provide:
- A suggested profile/summary paragraph (3-4 sentences) tailored to this role
- Skills section ordering recommendation

Format as markdown so it's easy to copy-paste.`;
}

function coverPrompt(job: Job, cv: string): string {
  return `You are a professional cover letter writer specialising in product management roles.

## Candidate CV
${cv}

## Target Job
${buildJobContext(job)}

## Your task
Write a compelling cover letter (3-4 paragraphs, under 350 words) that:
- Opens with a specific hook — reference something concrete about the company or role
- Paragraph 2: strongest alignment — 1-2 specific examples from CV that directly address their needs
- Paragraph 3: what you bring that others won't — unique angle or proof point
- Closes with a clear call to action

Tone: confident, direct, human. Not generic. No clichés like "I am writing to express my interest".
Format as plain text ready to paste into an application form.`;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runAiCommand(opts: {
  command: AiCommand;
  jobId: string;
  skipConfirm?: boolean;
  model?: string;
}): Promise<void> {
  const { command, jobId, skipConfirm = false, model = DEFAULT_MODEL } = opts;

  // Resolve job
  const job = resolveJob(jobId);
  if (!job) {
    console.error(kleur.red(`Job '${jobId}' not found. Run \`npm run show:top\` to find job IDs.`));
    process.exit(1);
  }

  // Load CV
  let cv: string;
  try {
    cv = loadCv();
  } catch {
    console.error(kleur.red('cv.md not found at data/inputs/cv.md. Add your CV first.'));
    process.exit(1);
  }

  // Check API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(kleur.red('ANTHROPIC_API_KEY not set in .env'));
    process.exit(1);
  }

  const cost = estimateCost(command);
  console.log();
  console.log(kleur.bold(`  ${command.toUpperCase()}  —  ${job.title} @ ${job.company}`));
  console.log(kleur.dim(`  Model: ${model}  |  Estimated cost: ${cost}`));
  console.log();

  if (!skipConfirm) {
    const ok = await confirm(kleur.yellow(`  Proceed? (${cost}) [y/N] `));
    if (!ok) {
      console.log(kleur.dim('  Aborted.'));
      process.exit(0);
    }
    console.log();
  }

  // Build prompt
  const promptFns: Record<AiCommand, (job: Job, cv: string) => string> = {
    assess: assessPrompt,
    'tailor-cv': tailorCvPrompt,
    cover: coverPrompt,
  };
  const userPrompt = promptFns[command](job, cv);

  // Stream
  const client = new Anthropic();
  process.stdout.write(kleur.dim('─'.repeat(60)) + '\n\n');

  const stream = client.messages.stream({
    model,
    max_tokens: Math.round(TOKEN_ESTIMATES[command].outputK * 1000),
    messages: [{ role: 'user', content: userPrompt }],
  });

  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      process.stdout.write(event.delta.text);
    }
  }

  const finalMsg = await stream.finalMessage();
  const inputTokens = finalMsg.usage.input_tokens;
  const outputTokens = finalMsg.usage.output_tokens;
  const actualCost =
    (inputTokens / 1_000_000) * COST_PER_1M_INPUT +
    (outputTokens / 1_000_000) * COST_PER_1M_OUTPUT;

  console.log('\n\n' + kleur.dim('─'.repeat(60)));
  console.log(
    kleur.dim(
      `  Tokens: ${inputTokens} in / ${outputTokens} out  |  Actual cost: $${actualCost.toFixed(4)}`,
    ),
  );
  console.log();
}
