/**
 * On-demand LinkedIn job enrichment.
 *
 * NOT a Collector — this runs against a single LinkedIn job URL and returns
 * the rich detail page (applicant count, full description, criteria, etc.)
 * using piotrv1001/linkedin-job-details-scraper.
 *
 * Cost: $0.006 per job. enforceBudget=true so the call refuses when monthly
 * Apify spend would exceed APIFY_MONTHLY_BUDGET_USD (default $5).
 *
 * Called by the CLI command: `npm run enrich -- <job_id>`.
 */

import { hasApifyToken, runApifyActor } from '../apify/client.js';
import { createLogger } from '../logger.js';
import { cleanText } from '../collectors/base.js';
import type { JobEnrichment } from '../types/job.js';

const log = createLogger('linkedin-enrich');

const ACTOR = 'piotrv1001/linkedin-job-details-scraper';
const COST_PER_ITEM_USD = 0.006;

interface LinkedInDetailsItem {
  title?: string;
  companyName?: string;
  companyUrl?: string;
  description?: string;
  descriptionText?: string;
  descriptionHtml?: string;
  applicantsCount?: number | string;
  applicants?: number | string;
  numberOfApplicants?: number | string;
  postedTimeAgo?: string;
  location?: string;
  seniorityLevel?: string;
  employmentType?: string;
  jobFunctions?: string[] | string;
  industries?: string[] | string;
  skills?: string[];
  easyApply?: boolean;
  salary?: string;
  posterName?: string;
  posterUrl?: string;
  similarJobs?: Array<{ title?: string; company?: string; companyName?: string; url?: string; link?: string }>;
  relatedJobs?: Array<{ title?: string; company?: string; companyName?: string; url?: string; link?: string }>;
}

function parseApplicantCount(item: LinkedInDetailsItem): number | null {
  const raw =
    item.applicantsCount ?? item.applicants ?? item.numberOfApplicants ?? null;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return raw;
  // Strings can be "Over 200 applicants" or "120 applicants" or just "120"
  const m = String(raw).match(/(\d+)/);
  return m ? parseInt(m[1]!, 10) : null;
}

function toStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.filter((v) => typeof v === 'string') as string[];
  if (typeof val === 'string') return [val];
  return [];
}

function normalizeSimilarJobs(items: LinkedInDetailsItem['similarJobs'] | LinkedInDetailsItem['relatedJobs']): JobEnrichment['linkedin'] extends infer L ? (L extends { similarJobs?: infer S } ? S : never) : never {
  // The narrow type above is just for the return; we know it's an array of objects.
  if (!Array.isArray(items)) return [] as never;
  return items
    .map((s) => ({
      title: (s.title ?? '').trim(),
      company: (s.company ?? s.companyName ?? '').trim(),
      url: (s.url ?? s.link ?? '').trim(),
    }))
    .filter((s) => s.title && s.url)
    .slice(0, 10) as never;
}

export interface EnrichResult {
  enrichment: NonNullable<JobEnrichment['linkedin']>;
  costEstimateUsd: number;
}

/**
 * Run the paid LinkedIn details actor for a single job URL.
 * Returns the normalized enrichment payload (NOT yet saved to DB).
 */
export async function enrichLinkedInJob(jobUrl: string): Promise<EnrichResult> {
  if (!hasApifyToken()) {
    throw new Error(
      'APIFY_TOKEN not set. Sign up at https://apify.com and add the token to .env (see .env.example).',
    );
  }
  if (!jobUrl || !jobUrl.includes('linkedin.com')) {
    throw new Error(`Not a LinkedIn job URL: ${jobUrl}`);
  }

  log.info('enriching job', { url: jobUrl, actor: ACTOR });

  const result = await runApifyActor<LinkedInDetailsItem>({
    actor: ACTOR,
    input: {
      // The actor accepts a `urls` array or a single `url`. The widely used
      // schema is `jobUrls`: [...]. We pass both for compatibility.
      jobUrls: [jobUrl],
      urls: [jobUrl],
    },
    costPerItemUsd: COST_PER_ITEM_USD,
    fixedCostUsd: 0,
    enforceBudget: true,
    expectedItems: 1,
    timeoutSecs: 180,
  });

  if (result.items.length === 0) {
    throw new Error(`Actor returned no items for URL: ${jobUrl}`);
  }

  const item = result.items[0]!;
  const enrichment: NonNullable<JobEnrichment['linkedin']> = {
    applicantCount: parseApplicantCount(item),
    fullDescription: cleanText(item.descriptionText ?? item.description ?? item.descriptionHtml ?? '', 10_000),
    seniorityLevel: item.seniorityLevel,
    employmentType: item.employmentType,
    jobFunctions: toStringArray(item.jobFunctions),
    industries: toStringArray(item.industries),
    skills: toStringArray(item.skills),
    easyApply: typeof item.easyApply === 'boolean' ? item.easyApply : undefined,
    salary: item.salary,
    posterName: item.posterName,
    posterUrl: item.posterUrl,
    similarJobs: normalizeSimilarJobs(item.similarJobs ?? item.relatedJobs),
    fetchedAt: new Date().toISOString(),
    actor: ACTOR,
    costEstimateUsd: result.estimatedCostUsd,
  };

  log.info('enrichment complete', {
    url: jobUrl,
    applicantCount: enrichment.applicantCount,
    descriptionLen: enrichment.fullDescription?.length ?? 0,
    skillsCount: enrichment.skills?.length ?? 0,
    similarCount: enrichment.similarJobs?.length ?? 0,
    costUsd: enrichment.costEstimateUsd.toFixed(4),
  });

  return {
    enrichment,
    costEstimateUsd: result.estimatedCostUsd,
  };
}
