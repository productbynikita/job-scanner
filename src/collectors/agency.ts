/**
 * Phase 5 — Generic agency collector.
 *
 * Iterates over all entries in data/inputs/agencies.json, fetches each
 * search URL, and tries the same three parser strategies used by
 * countryLeader.ts (JSON-LD → next-data → plain text heuristic).
 *
 * Most agency sites render job listings server-side and embed JSON-LD
 * schema.org/JobPosting blocks — the same pattern as StepStone/WTTJ.
 * For sites that don't, we log a warning and move on (no crash).
 *
 * Per-agency override hooks allow custom parsing for stubborn sites.
 * Add an entry to AGENCY_OVERRIDES keyed by agency id.
 */

import * as cheerio from 'cheerio';
import type { Collector, CollectorOptions } from './base.js';
import { runCollector, fetchText, countryFromLocation, cleanText } from './base.js';
import { isProductRole } from './atsHelpers.js';
import { extractJsonLdJobs, jsonLdToRawJob, sleep } from './htmlParsers.js';
// JsonLdToJobOpts is not exported — replicate the shape inline
type JsonLdToJobOptsLocal = { source: string; fallbackCountry?: string; urlBase?: string };
import { loadAgencies } from '../config/loader.js';
import { createLogger } from '../logger.js';
import type { RawJob } from '../types/job.js';
import type { AgencyEntry } from '../types/config.js';

const log = createLogger('agency');
const POLITE_DELAY_MS = 1800;

// ---------------------------------------------------------------------------
// Per-agency override hooks
// ---------------------------------------------------------------------------
// If an agency site doesn't emit JSON-LD, add a custom extractor here.
// The function receives the raw HTML and the country code, returns RawJob[].

type AgencyOverride = (html: string, country: string, agency: AgencyEntry) => RawJob[];

const AGENCY_OVERRIDES: Record<string, AgencyOverride> = {
  // Example — add overrides as needed per agency:
  // orange_quarter: (html, country, agency) => { ... }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseWithJsonLd(html: string, country: string, sourceId: string): RawJob[] {
  const jobs = extractJsonLdJobs(html);
  const opts: JsonLdToJobOptsLocal = { source: sourceId, fallbackCountry: country };
  return jobs
    .map((j) => jsonLdToRawJob(j, opts as Parameters<typeof jsonLdToRawJob>[1]))
    .filter((j): j is RawJob => j !== null)
    .filter((j) => isProductRole(j.title));
}

function parseHeuristicLinks(html: string, country: string, baseUrl: string): RawJob[] {
  // Last-resort: look for <a> tags that look like job listing links
  // and extract title from anchor text. Very coarse — only catches obvious cases.
  const $ = cheerio.load(html);
  const jobs: RawJob[] = [];
  const seen = new Set<string>();

  $('a[href]').each((_i, el) => {
    const href = $(el).attr('href') ?? '';
    const text = $(el).text().trim();
    if (!text || text.length < 10 || text.length > 120) return;
    if (!isProductRole(text)) return;

    // Build absolute URL
    let url = href;
    if (href.startsWith('/')) {
      try {
        const base = new URL(baseUrl);
        url = `${base.origin}${href}`;
      } catch {
        return;
      }
    }
    if (!url.startsWith('http')) return;
    if (seen.has(url)) return;
    seen.add(url);

    jobs.push({
      title: cleanText(text, 120),
      company: '', // agency name added by caller
      location: country,
      country,
      remote: '',
      url,
      descriptionSnippet: '',
      salary: null,
      postedDate: null,
      source: 'agency',
      isAgency: true,
    });
  });

  return jobs;
}

// ---------------------------------------------------------------------------
// Per-URL fetch + parse
// ---------------------------------------------------------------------------

async function fetchAgencyUrl(
  url: string,
  country: string,
  agency: AgencyEntry,
): Promise<{ jobs: RawJob[]; error?: string }> {
  const urlLog = log.child(`${agency.id}/${country}`);

  const fetchResult = await fetchText(url);
  if (fetchResult.status !== 'ok') {
    urlLog.warn('fetch failed', { url, status: fetchResult.status });
    return { jobs: [], error: `fetch ${fetchResult.status}: ${url}` };
  }
  const html = fetchResult.text;

  // 1. Per-agency override
  const override = AGENCY_OVERRIDES[agency.id];
  if (override) {
    urlLog.debug('using override parser');
    const jobs = override(html, country, agency).map((j) => ({ ...j, isAgency: true as const }));
    urlLog.info('override parsed', { count: jobs.length });
    return { jobs };
  }

  // 2. JSON-LD
  const jsonLdJobs = parseWithJsonLd(html, country, `agency_${agency.id}`);
  if (jsonLdJobs.length > 0) {
    urlLog.info('json-ld parsed', { count: jsonLdJobs.length });
    return {
      jobs: jsonLdJobs.map((j) => ({
        ...j,
        isAgency: true as const,
        // Prefer the agency name as company if the listing didn't include one
        company: j.company || agency.name,
      })),
    };
  }

  // 3. Heuristic link scan (last resort)
  const heuristicJobs = parseHeuristicLinks(html, country, url);
  if (heuristicJobs.length > 0) {
    urlLog.info('heuristic-links parsed', { count: heuristicJobs.length });
    return {
      jobs: heuristicJobs.map((j) => ({
        ...j,
        isAgency: true as const,
        company: agency.name,
      })),
    };
  }

  urlLog.debug('no jobs extracted (JS-rendered or unsupported format)', { url });
  return { jobs: [] };
}

// ---------------------------------------------------------------------------
// Collector factory
// ---------------------------------------------------------------------------

export function buildAgencyCollectors(): Collector[] {
  const { agencies } = loadAgencies();

  return agencies.map((agency) => ({
    id: `agency_${agency.id}`,
    name: agency.name,
    isAgency: true,

    async collect(opts: CollectorOptions = {}): ReturnType<Collector['collect']> {
      return runCollector(`agency_${agency.id}`, true, async () => {
        const agencyLog = log.child(agency.id);
        agencyLog.info('starting', { urls: Object.keys(agency.searchUrls).length });

        const allJobs: RawJob[] = [];
        const errors: string[] = [];
        const urlEntries = Object.entries(agency.searchUrls);

        for (let i = 0; i < urlEntries.length; i++) {
          const [country, url] = urlEntries[i]!;
          const { jobs, error } = await fetchAgencyUrl(url, country, agency);

          if (error) errors.push(`${country}: ${error}`);
          allJobs.push(...jobs);

          if (opts.maxResults && allJobs.length >= opts.maxResults) break;
          if (i < urlEntries.length - 1) await sleep(POLITE_DELAY_MS);
        }

        agencyLog.info('done', { kept: allJobs.length, errors: errors.length });
        return { jobs: allJobs, errors };
      });
    },
  }));
}

// Single aggregate collector that runs all agencies in sequence
// (used by the 'agencies' scan mode)
export const agenciesCollector: Collector = {
  id: 'agencies',
  name: 'Recruiting agencies (all)',
  isAgency: true,

  async collect(opts: CollectorOptions = {}): ReturnType<Collector['collect']> {
    return runCollector('agencies', true, async () => {
      const collectors = buildAgencyCollectors();
      const allJobs: RawJob[] = [];
      const errors: string[] = [];

      for (const c of collectors) {
        const result = await c.collect(opts);
        allJobs.push(...result.jobs);
        errors.push(...result.errors);
        if (opts.maxResults && allJobs.length >= opts.maxResults) break;
      }

      return { jobs: allJobs, errors };
    });
  },
};
