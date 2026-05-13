/**
 * Generic country-leader collector.
 *
 * Phase 3 sources (StepStone, jobs.ch, NL Vacaturebank, EURES, WTTJ) all
 * follow the same pattern:
 *   1. Read URL list and parser type from `data/inputs/country_sources.json`
 *   2. Fetch each URL with a polite delay between requests
 *   3. Parse via JSON-LD extractor OR site-specific JSON-in-HTML extractor
 *   4. Filter to PM/PO titles via `isProductRole`
 *   5. Return normalized RawJob[]
 *
 * Per-source collectors (`stepstoneDe.ts`, `jobsCh.ts`, etc.) are thin
 * wrappers that select their config entry and call this generic runner.
 */

import * as cheerio from 'cheerio';
import { type Collector, runCollector, fetchText } from './base.js';
import { isProductRole } from './atsHelpers.js';
import { extractJsonLdJobs, jsonLdToRawJob, sleep } from './htmlParsers.js';
import { loadCountrySources } from '../config/loader.js';
import { createLogger } from '../logger.js';
import type { Logger } from '../logger.js';
import type { CountrySourceEntry } from '../types/config.js';
import type { RawJob } from '../types/job.js';

interface CountryLeaderConfig {
  collectorId: string;
  sourceKey: string;
  name: string;
}

/**
 * Build a Collector for one country-leader source.
 * `sourceKey` matches the top-level key in country_sources.json.
 */
export function buildCountryLeaderCollector(cfg: CountryLeaderConfig): Collector {
  const log = createLogger(cfg.collectorId);

  return {
    id: cfg.collectorId,
    name: cfg.name,
    isAgency: false,
    async collect(opts = {}) {
      return runCollector(cfg.collectorId, false, async () => {
        const allSources = loadCountrySources();
        const source = allSources[cfg.sourceKey];

        if (!source) {
          log.error('source missing from country_sources.json', { key: cfg.sourceKey });
          return {
            jobs: [],
            errors: [`source '${cfg.sourceKey}' not configured in country_sources.json`],
          };
        }

        log.info('starting collector', {
          urls: source.urls.length,
          country: source.country,
          parser: source.parser,
        });

        const allJobs: RawJob[] = [];
        const errors: string[] = [];
        let urlsOk = 0;
        let urlsBlocked = 0;
        let urlsError = 0;
        let urlsEmpty = 0;
        let totalRaw = 0;
        let totalKept = 0;

        for (const url of source.urls) {
          const uLog = log.child(new URL(url).pathname || 'root');

          const t = uLog.timer('fetch');
          const { status, text, statusCode } = await fetchText(url, {
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            extraHeaders: {
              'Sec-Fetch-Dest': 'document',
              'Sec-Fetch-Mode': 'navigate',
              'Sec-Fetch-Site': 'none',
              'Sec-Fetch-User': '?1',
              'Upgrade-Insecure-Requests': '1',
            },
            logger: uLog,
          });
          t.end({ status, statusCode });

          if (status === 'blocked') {
            urlsBlocked++;
            uLog.warn('fetch blocked', { status, statusCode, url });
            errors.push(`${url}: blocked (${statusCode})`);
            await sleep(source.rateLimitMs);
            continue;
          }
          if (status !== 'ok') {
            urlsError++;
            uLog.warn('fetch failed', { status, statusCode, url });
            errors.push(`${url}: ${status} (${statusCode ?? 'no code'})`);
            await sleep(source.rateLimitMs);
            continue;
          }

          const rawJobs = parsePage(text, source, cfg.collectorId, uLog);
          totalRaw += rawJobs.length;

          if (rawJobs.length === 0) {
            urlsEmpty++;
            uLog.debug('no jobs extracted from page');
          } else {
            urlsOk++;
          }

          let kept = 0;
          let dropped = 0;
          for (const job of rawJobs) {
            if (!isProductRole(job.title)) {
              dropped++;
              continue;
            }
            allJobs.push(job);
            kept++;
          }
          totalKept += kept;

          uLog.info('page parsed', {
            extracted: rawJobs.length,
            kept,
            droppedNonProduct: dropped,
          });

          // Polite delay before the next URL on the same host
          if (source.urls.length > 1) await sleep(source.rateLimitMs);

          if (opts.maxResults && allJobs.length >= opts.maxResults) {
            log.warn('hit max results, stopping early', { max: opts.maxResults });
            break;
          }
        }

        log.info('collector complete', {
          urlsOk,
          urlsEmpty,
          urlsBlocked,
          urlsError,
          totalRaw,
          finalJobs: allJobs.length,
        });

        return { jobs: allJobs, errors };
      });
    },
  };
}

/** Dispatch to the right parsing strategy for this source. */
function parsePage(
  html: string,
  source: CountrySourceEntry,
  collectorId: string,
  log: Logger,
): RawJob[] {
  switch (source.parser) {
    case 'jsonld':
      return parseJsonLdPage(html, collectorId, source.country, log);
    case 'nextdata':
      return parseNextDataPage(html, collectorId, source.country, log);
    case 'eures':
      return parseEuresPage(html, collectorId, log);
    default:
      log.warn('unknown parser', { parser: source.parser });
      return [];
  }
}

function parseJsonLdPage(
  html: string,
  source: string,
  fallbackCountry: string,
  log: Logger,
): RawJob[] {
  const postings = extractJsonLdJobs(html);
  log.debug('JSON-LD extraction', { found: postings.length });
  const jobs: RawJob[] = [];
  for (const jp of postings) {
    const job = jsonLdToRawJob(jp, { source, fallbackCountry });
    if (job) jobs.push(job);
  }
  return jobs;
}

/**
 * Welcome to the Jungle (and other Next.js sites) embed search results as
 * JSON in a <script id="__NEXT_DATA__"> tag. Walk it looking for objects
 * shaped like job postings.
 */
function parseNextDataPage(
  html: string,
  source: string,
  fallbackCountry: string,
  log: Logger,
): RawJob[] {
  const $ = cheerio.load(html);
  const raw = $('script#__NEXT_DATA__').contents().text().trim();
  if (!raw) {
    log.debug('no __NEXT_DATA__ script found');
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn('__NEXT_DATA__ parse failed', { error: (err as Error).message });
    return [];
  }

  const candidates: Record<string, unknown>[] = [];
  const walk = (node: unknown): void => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;

    const isJobLike =
      (obj['__typename'] === 'Job' || obj['__typename'] === 'JobOffer') ||
      ('name' in obj && 'organization' in obj) ||
      ('title' in obj && 'organization' in obj);

    if (isJobLike) candidates.push(obj);

    for (const v of Object.values(obj)) walk(v);
  };
  walk(parsed);

  log.debug('Next.js candidates found', { count: candidates.length });

  const jobs: RawJob[] = [];
  const seenUrls = new Set<string>();
  for (const c of candidates) {
    const title = String(c['name'] ?? c['title'] ?? '').trim();
    if (!title) continue;

    const org = c['organization'];
    let company = '';
    if (org && typeof org === 'object') {
      company = String((org as Record<string, unknown>)['name'] ?? '').trim();
    }
    if (!company) continue;

    const offices = c['offices'];
    let location = '';
    let country = fallbackCountry;
    if (Array.isArray(offices) && offices.length > 0) {
      const first = offices[0] as Record<string, unknown>;
      location = String(first['city'] ?? first['country'] ?? '').trim();
      const countryCode = String(first['country_code'] ?? '').trim();
      if (countryCode) country = countryCode;
    }

    const url = String(c['url_with_organization'] ?? c['url'] ?? '').trim();
    if (url && seenUrls.has(url)) continue;
    if (url) seenUrls.add(url);

    const published = String(c['published_at'] ?? '').trim();
    const postedDate = published ? (published.split('T')[0] ?? null) : null;

    const remoteVal = String(c['remote'] ?? '').toLowerCase();
    const remote: RawJob['remote'] = remoteVal.includes('full')
      ? 'remote'
      : remoteVal.includes('hybrid')
        ? 'hybrid'
        : '';

    jobs.push({
      title,
      company,
      location,
      country: country === 'multi' ? '' : country,
      remote,
      url,
      descriptionSnippet: '',
      salary: null,
      postedDate,
      source,
      isAgency: false,
    });
  }

  return jobs;
}

/**
 * EURES embeds search results as JSON in a property called "jvs" within
 * a larger state object. Look for that pattern.
 */
function parseEuresPage(html: string, source: string, log: Logger): RawJob[] {
  // First try JSON-LD (it's there on detail pages but rarely list pages)
  const ld = extractJsonLdJobs(html);
  if (ld.length > 0) {
    log.debug('EURES JSON-LD path', { found: ld.length });
    const jobs: RawJob[] = [];
    for (const jp of ld) {
      const job = jsonLdToRawJob(jp, { source });
      if (job) jobs.push(job);
    }
    return jobs;
  }

  // Fallback: extract embedded "jvs":[...] array from the page state
  const m = html.match(/"jvs"\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
  if (!m || !m[1]) {
    log.debug('EURES jvs array not found');
    return [];
  }

  let arr: unknown;
  try {
    arr = JSON.parse(m[1]);
  } catch (err) {
    log.warn('EURES jvs parse failed', { error: (err as Error).message });
    return [];
  }
  if (!Array.isArray(arr)) return [];

  const jobs: RawJob[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;

    const title = String(it['title'] ?? '').trim();
    if (!title) continue;

    const employer = it['employer'] as Record<string, unknown> | undefined;
    const company = String(employer?.['name'] ?? '').trim();
    if (!company) continue;

    const locations = it['locations'];
    let location = '';
    let country = '';
    if (Array.isArray(locations) && locations.length > 0) {
      const first = locations[0] as Record<string, unknown>;
      location = String(first['cityName'] ?? '').trim();
      country = String(first['countryCode'] ?? '').trim().toUpperCase();
    }

    const id = String(it['id'] ?? '').trim();
    const url = id ? `https://eures.europa.eu/eures-apps/searchengine/page/jv-details/${id}` : '';
    const published = String(it['publicationDate'] ?? '').trim();
    const postedDate = published ? (published.split('T')[0] ?? null) : null;

    jobs.push({
      title,
      company,
      location,
      country,
      remote: '',
      url,
      descriptionSnippet: '',
      salary: null,
      postedDate,
      source,
      isAgency: false,
    });
  }

  return jobs;
}
