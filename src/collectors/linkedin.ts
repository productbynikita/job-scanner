/**
 * LinkedIn collector — Tier 1 daily scans via Apify free actor.
 *
 * Uses worldunboxer/rapid-linkedin-scraper which is free to use; only
 * platform compute is counted against your Apify free credit ($5/month).
 * At our volumes (a few searches × tens of results each) this stays well
 * within the free tier.
 *
 * Cost model: enforceBudget=false because the actor is marketed free.
 * We still log every call into data/.apify-usage.json so you can audit.
 *
 * For applicant counts, full descriptions, skills, etc., use the on-demand
 * `npm run enrich -- <job_id>` command which calls a separate paid actor.
 */

import { type Collector, runCollector, cleanText, countryFromLocation } from './base.js';
import { isProductRole } from './atsHelpers.js';
import { hasApifyToken, runApifyActor } from '../apify/client.js';
import { createLogger } from '../logger.js';
import type { RawJob } from '../types/job.js';

const log = createLogger('linkedin');

const ACTOR = 'worldunboxer/rapid-linkedin-scraper';

// Target queries × locations. Each (query, location) pair triggers one actor
// call. Keep this modest to stay within the free tier. The actor itself
// handles pagination/dedup internally.
// The actor uses LinkedIn's search URL format.
// Use OR syntax for broader coverage per call (fewer API calls, same results).
const QUERIES = [
  'Product Manager OR Product Owner',
  'Senior Product Manager OR Technical Product Manager',
];

// The actor expects LinkedIn country/region codes, not full names.
// "r604800" = past week, "r86400" = past 24 hours
const LOCATIONS = [
  { code: 'DE', country: 'DE' },
  { code: 'NL', country: 'NL' },
  { code: 'CH', country: 'CH' },
  { code: 'BE', country: 'BE' },
];

interface LinkedInActorJob {
  // Actual field names from worldunboxer/rapid-linkedin-scraper
  job_title?: string;
  company_name?: string;
  job_url?: string;
  apply_url?: string;
  location?: string;
  time_posted?: string;       // e.g. "3 hours ago", "2 days ago"
  job_description?: string;
  salary_range?: string | null;
  seniority_level?: string;
  employment_type?: string;
  num_applicants?: string;
  // Legacy / fallback fields (keep for compatibility)
  title?: string;
  company?: string;
  companyName?: string;
  postedAt?: string;
  postedTimeAgo?: string;
  publishedAt?: string;
  link?: string;
  jobUrl?: string;
  applyLink?: string;
  applyUrl?: string;
  description?: string;
  descriptionText?: string;
  salary?: string;
  workType?: string;
}

function pickUrl(j: LinkedInActorJob): string {
  return j.apply_url ?? j.job_url ?? j.applyUrl ?? j.applyLink ?? j.jobUrl ?? j.link ?? '';
}

function pickCompany(j: LinkedInActorJob): string {
  return (j.company_name ?? j.companyName ?? j.company ?? '').trim();
}

function pickTitle(j: LinkedInActorJob): string {
  return (j.job_title ?? j.title ?? '').trim();
}

function parsePostedDate(j: LinkedInActorJob): string | null {
  // The actor sometimes returns ISO, sometimes "2 days ago" — try ISO first.
  const isoCandidate = j.postedAt ?? j.publishedAt ?? '';
  if (isoCandidate) {
    const m = isoCandidate.match(/^\d{4}-\d{2}-\d{2}/);
    if (m) return m[0];
    const d = new Date(isoCandidate);
    if (!isNaN(d.getTime())) return d.toISOString().substring(0, 10);
  }

  // Relative phrase fallback — actor uses time_posted: "3 hours ago", "2 days ago"
  const rel = j.time_posted ?? j.postedTimeAgo ?? j.postedAt ?? '';
  if (!rel) return null;
  const today = new Date();
  const lower = rel.toLowerCase();

  let daysAgo: number | null = null;
  let m = lower.match(/(\d+)\s*hour/);
  if (m) daysAgo = 0;
  m = lower.match(/(\d+)\s*day/);
  if (m) daysAgo = parseInt(m[1]!, 10);
  m = lower.match(/(\d+)\s*week/);
  if (m) daysAgo = parseInt(m[1]!, 10) * 7;
  m = lower.match(/(\d+)\s*month/);
  if (m) daysAgo = parseInt(m[1]!, 10) * 30;
  if (lower.includes('just') || lower.includes('today')) daysAgo = 0;
  if (lower.includes('yesterday')) daysAgo = 1;

  if (daysAgo === null) return null;
  const d = new Date(today.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  return d.toISOString().substring(0, 10);
}

function detectRemote(j: LinkedInActorJob, location: string): RawJob['remote'] {
  const haystack = `${j.workType ?? ''} ${j.employment_type ?? ''} ${location}`.toLowerCase();
  if (haystack.includes('remote')) return 'remote';
  if (haystack.includes('hybrid')) return 'hybrid';
  if (haystack.includes('on-site') || haystack.includes('onsite')) return 'onsite';
  return '';
}

export const linkedinCollector: Collector = {
  id: 'linkedin',
  name: 'LinkedIn (via Apify free actor)',
  isAgency: false,

  async collect(opts = {}) {
    return runCollector('linkedin', false, async () => {
      if (!hasApifyToken()) {
        log.warn('APIFY_TOKEN not set — LinkedIn collector skipped');
        return {
          jobs: [],
          errors: [
            'APIFY_TOKEN missing. Sign up at https://apify.com (free) and set APIFY_TOKEN in .env. See .env.example.',
          ],
        };
      }

      log.info('starting collector', {
        actor: ACTOR,
        queries: QUERIES.length,
        locations: LOCATIONS.length,
      });

      const allJobs: RawJob[] = [];
      const errors: string[] = [];
      let totalRaw = 0;
      let totalKept = 0;
      let totalDropped = 0;
      const seenUrls = new Set<string>();

      for (const loc of LOCATIONS) {
        for (const query of QUERIES) {
          const qLog = log.child(`${loc.code}/${query.replace(/\s+/g, '-').substring(0, 20)}`);
          qLog.info('searching', { query, location: loc.code });

          try {
            const result = await runApifyActor<LinkedInActorJob>({
              actor: ACTOR,
              input: {
                // Correct input schema for worldunboxer/rapid-linkedin-scraper
                job_title: query,
                location: loc.code,
                jobs_entries: 50,
                job_post_time: 'r604800', // past week
                start_jobs: 0,
              },
              // Free actor: not counted against per-item budget
              costPerItemUsd: 0,
              fixedCostUsd: 0,
              enforceBudget: false,
              expectedItems: 50,
              timeoutSecs: 180,
            });

            qLog.info('actor returned', {
              items: result.items.length,
              durationMs: result.durationMs,
            });

            totalRaw += result.items.length;

            for (const item of result.items) {
              const title = pickTitle(item);
              const company = pickCompany(item);
              const url = pickUrl(item);

              if (!title || !company) {
                totalDropped++;
                continue;
              }
              if (!isProductRole(title)) {
                totalDropped++;
                continue;
              }
              // Dedupe within this collector run by URL
              if (url && seenUrls.has(url)) {
                totalDropped++;
                continue;
              }
              if (url) seenUrls.add(url);

              const location = (item.location ?? loc.code).trim();
              const country = countryFromLocation(location) || loc.country || '';
              const remote = detectRemote(item, location);
              const postedDate = parsePostedDate(item);

              allJobs.push({
                title,
                company,
                location,
                country,
                remote,
                url,
                descriptionSnippet: cleanText(item.job_description ?? item.descriptionText ?? item.description ?? ''),
                salary: item.salary_range ?? item.salary ?? null,
                postedDate,
                source: 'linkedin',
                isAgency: false,
              });
              totalKept++;

              if (opts.maxResults && allJobs.length >= opts.maxResults) {
                log.warn('hit max results, stopping', { max: opts.maxResults });
                break;
              }
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`${loc.country || 'EU'}/${query}: ${msg}`);
            qLog.error('actor call failed', { error: msg });
          }

          if (opts.maxResults && allJobs.length >= opts.maxResults) break;
        }
        if (opts.maxResults && allJobs.length >= opts.maxResults) break;
      }

      log.info('collector complete', {
        totalRaw,
        totalKept,
        totalDropped,
        uniqueByUrl: seenUrls.size,
        errors: errors.length,
      });

      return { jobs: allJobs, errors };
    });
  },
};
