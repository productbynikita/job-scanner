/**
 * Watchlist collector.
 *
 * Reads data/inputs/watchlist.json and queries the ATS API for every company
 * that has a known slug (greenhouse / ashby / lever). Companies on Workday,
 * custom portals, or with unknown ATS are skipped and reported at the end.
 *
 * Designed to run as `scan:watchlist` — a focused scan of your target companies
 * rather than a broad market sweep. The DB deduplicates on URL, so overlap with
 * the main ATS scan is harmless.
 */

import { type Collector, runCollector, fetchText, cleanText, countryFromLocation } from './base.js';
import { isProductRole } from './atsHelpers.js';
import { loadWatchlist } from '../config/loader.js';
import { createLogger } from '../logger.js';
import type { RawJob } from '../types/job.js';
import type { WatchlistEntry } from '../types/config.js';

const log = createLogger('watchlist');

// ── Greenhouse ──────────────────────────────────────────────────────────────

interface GhJob {
  id: number;
  title: string;
  absolute_url: string;
  updated_at?: string;
  location?: { name: string };
  content?: string;
}

async function fetchGreenhouse(company: WatchlistEntry): Promise<{ jobs: RawJob[]; error?: string }> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${company.slug}/jobs`;
  const { status, text, statusCode } = await fetchText(url, { accept: 'application/json' });
  if (status !== 'ok') return { jobs: [], error: `${company.name}: fetch ${status} (${statusCode})` };

  let parsed: { jobs?: GhJob[] };
  try { parsed = JSON.parse(text); } catch { return { jobs: [], error: `${company.name}: json parse failed` }; }

  const jobs: RawJob[] = [];
  for (const j of parsed.jobs ?? []) {
    if (!isProductRole(j.title)) continue;
    const loc = j.location?.name ?? '';
    jobs.push({
      title: j.title,
      company: company.name,
      location: loc,
      country: countryFromLocation(loc) || company.country,
      remote: loc.toLowerCase().includes('remote') ? 'remote' : '',
      url: j.absolute_url,
      descriptionSnippet: cleanText(j.content ?? ''),
      salary: null,
      postedDate: j.updated_at ? j.updated_at.split('T')[0] ?? null : null,
      source: 'watchlist',
      isAgency: false,
    });
  }
  return { jobs };
}

// ── Ashby ────────────────────────────────────────────────────────────────────

interface AshbyJob {
  id: string;
  title: string;
  jobUrl?: string;
  applyUrl?: string;
  publishedDate?: string;
  updatedAt?: string;
  isRemote?: boolean;
  locationName?: string;
  location?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
  compensation?: { compensationTierSummary?: string };
}

async function fetchAshby(company: WatchlistEntry): Promise<{ jobs: RawJob[]; error?: string }> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${company.slug}?includeCompensation=true`;
  const { status, text, statusCode } = await fetchText(url, { accept: 'application/json' });
  if (status !== 'ok') return { jobs: [], error: `${company.name}: fetch ${status} (${statusCode})` };

  let parsed: { jobs?: AshbyJob[] };
  try { parsed = JSON.parse(text); } catch { return { jobs: [], error: `${company.name}: json parse failed` }; }

  const jobs: RawJob[] = [];
  for (const j of parsed.jobs ?? []) {
    if (!isProductRole(j.title)) continue;
    const loc = j.locationName ?? j.location ?? '';
    jobs.push({
      title: j.title,
      company: company.name,
      location: loc,
      country: countryFromLocation(loc) || company.country,
      remote: j.isRemote ? 'remote' : '',
      url: j.jobUrl ?? j.applyUrl ?? '',
      descriptionSnippet: cleanText(j.descriptionPlain ?? j.descriptionHtml ?? ''),
      salary: j.compensation?.compensationTierSummary ?? null,
      postedDate: (j.publishedDate ?? j.updatedAt ?? '').split('T')[0] || null,
      source: 'watchlist',
      isAgency: false,
    });
  }
  return { jobs };
}

// ── Lever ────────────────────────────────────────────────────────────────────

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt?: number;
  categories?: { location?: string };
  workplaceType?: string;
  descriptionPlain?: string;
  description?: string;
}

async function fetchLever(company: WatchlistEntry): Promise<{ jobs: RawJob[]; error?: string }> {
  const url = `https://api.lever.co/v0/postings/${company.slug}?mode=json`;
  const { status, text, statusCode } = await fetchText(url, { accept: 'application/json' });
  if (status !== 'ok') return { jobs: [], error: `${company.name}: fetch ${status} (${statusCode})` };

  let postings: LeverPosting[];
  try {
    postings = JSON.parse(text);
    if (!Array.isArray(postings)) throw new Error('expected array');
  } catch { return { jobs: [], error: `${company.name}: json parse failed` }; }

  const jobs: RawJob[] = [];
  for (const p of postings) {
    if (!isProductRole(p.text)) continue;
    const loc = p.categories?.location ?? '';
    const workplace = (p.workplaceType ?? '').toLowerCase();
    jobs.push({
      title: p.text,
      company: company.name,
      location: loc,
      country: countryFromLocation(loc) || company.country,
      remote: workplace.includes('remote') ? 'remote' : workplace.includes('hybrid') ? 'hybrid' : '',
      url: p.hostedUrl,
      descriptionSnippet: cleanText(p.descriptionPlain ?? p.description ?? ''),
      salary: null,
      postedDate: p.createdAt ? new Date(p.createdAt).toISOString().split('T')[0]! : null,
      source: 'watchlist',
      isAgency: false,
    });
  }
  return { jobs };
}

// ── Collector ────────────────────────────────────────────────────────────────

export const watchlistCollector: Collector = {
  id: 'watchlist',
  name: 'Target Company Watchlist',
  isAgency: false,

  async collect(opts = {}) {
    return runCollector('watchlist', false, async () => {
      const { companies } = loadWatchlist();
      const queryable = companies.filter((c) => c.slug && ['greenhouse', 'ashby', 'lever'].includes(c.ats));
      const noApi = companies.filter((c) => !c.slug || !['greenhouse', 'ashby', 'lever'].includes(c.ats));

      log.info('starting collector', {
        total: companies.length,
        queryable: queryable.length,
        noApiCoverage: noApi.length,
      });

      const allJobs: RawJob[] = [];
      const errors: string[] = [];
      let ok = 0;
      let empty = 0;

      for (const company of queryable) {
        const cLog = log.child(company.name);

        let result: { jobs: RawJob[]; error?: string };
        if (company.ats === 'greenhouse') result = await fetchGreenhouse(company);
        else if (company.ats === 'ashby') result = await fetchAshby(company);
        else result = await fetchLever(company);

        if (result.error) {
          errors.push(result.error);
          cLog.warn('fetch failed', { error: result.error });
          continue;
        }

        if (result.jobs.length === 0) {
          empty++;
          cLog.debug('no product roles found');
        } else {
          ok++;
          cLog.info('found roles', { count: result.jobs.length });
          allJobs.push(...result.jobs);
        }

        if (opts.maxResults && allJobs.length >= opts.maxResults) break;
      }

      // Report companies with no API coverage
      const workdayCompanies = noApi.filter((c) => c.ats === 'workday').map((c) => c.name);
      const customCompanies = noApi.filter((c) => c.ats === 'custom').map((c) => c.name);
      const unknownCompanies = noApi.filter((c) => c.ats === 'unknown').map((c) => c.name);

      log.info('collector complete', {
        queried: queryable.length,
        withRoles: ok,
        empty,
        errors: errors.length,
        finalJobs: allJobs.length,
        workdayCount: workdayCompanies.length,
        customCount: customCompanies.length,
        unknownCount: unknownCompanies.length,
      });

      if (workdayCompanies.length > 0) {
        log.warn('workday companies skipped (requires browser session)', {
          count: workdayCompanies.length,
          companies: workdayCompanies.join(', '),
        });
      }
      if (customCompanies.length > 0) {
        log.warn('custom-portal companies skipped', {
          count: customCompanies.length,
          companies: customCompanies.join(', '),
        });
      }
      if (unknownCompanies.length > 0) {
        log.warn('unknown ATS companies skipped (check manually)', {
          count: unknownCompanies.length,
          companies: unknownCompanies.join(', '),
        });
      }

      return { jobs: allJobs, errors };
    });
  },
};
