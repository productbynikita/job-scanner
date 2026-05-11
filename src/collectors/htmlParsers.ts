/**
 * Shared HTML parsing helpers for country-leader collectors.
 *
 * The primary strategy is JSON-LD extraction: most modern job boards embed
 * structured `JobPosting` objects in <script type="application/ld+json">
 * tags. This is far more stable than CSS selectors because the structured
 * data spec is fixed even when the surrounding HTML changes.
 *
 * Where JSON-LD isn't available, we fall back to cheerio with multiple
 * selector candidates. Selectors will need maintenance over time when sites
 * redesign — see the inline notes in each fallback.
 */

import * as cheerio from 'cheerio';
import { cleanText, countryFromLocation } from './base.js';
import type { RawJob } from '../types/job.js';

/**
 * Generic JobPosting type matching schema.org/JobPosting.
 * Most ATS and job board sites populate at least: title, hiringOrganization,
 * jobLocation, datePosted, description.
 */
interface JsonLdJobPosting {
  '@type'?: string | string[];
  title?: string;
  hiringOrganization?: { name?: string } | string;
  jobLocation?:
    | {
        address?: {
          addressLocality?: string;
          addressRegion?: string;
          addressCountry?: string | { name?: string };
        };
      }
    | Array<{
        address?: {
          addressLocality?: string;
          addressRegion?: string;
          addressCountry?: string | { name?: string };
        };
      }>;
  applicantLocationRequirements?: { name?: string } | Array<{ name?: string }>;
  jobLocationType?: string;
  datePosted?: string;
  validThrough?: string;
  description?: string;
  url?: string;
  identifier?: { value?: string };
  employmentType?: string;
  baseSalary?: {
    value?: { value?: number | string; minValue?: number; maxValue?: number; unitText?: string };
    currency?: string;
  };
}

/** Extract all @graph items or top-level JobPosting objects from JSON-LD. */
function flattenJsonLd(parsed: unknown): JsonLdJobPosting[] {
  const out: JsonLdJobPosting[] = [];
  const visit = (node: unknown): void => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }
    if (typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;

    if ('@graph' in obj && Array.isArray(obj['@graph'])) {
      for (const n of obj['@graph']) visit(n);
    }

    const type = obj['@type'];
    if (
      type === 'JobPosting' ||
      (Array.isArray(type) && type.includes('JobPosting'))
    ) {
      out.push(obj as JsonLdJobPosting);
    }
  };
  visit(parsed);
  return out;
}

/**
 * Extract every JSON-LD JobPosting from a page's HTML.
 * Returns an empty array if no structured data is present or all parsing
 * attempts fail. Never throws.
 */
export function extractJsonLdJobs(html: string): JsonLdJobPosting[] {
  if (!html) return [];
  const $ = cheerio.load(html);
  const out: JsonLdJobPosting[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      out.push(...flattenJsonLd(parsed));
    } catch {
      // Some pages embed slightly malformed JSON-LD. Try to recover by
      // stripping trailing commas — common authoring mistake.
      try {
        const cleaned = raw.replace(/,(\s*[}\]])/g, '$1');
        const parsed = JSON.parse(cleaned);
        out.push(...flattenJsonLd(parsed));
      } catch {
        // Silent — caller will fall back to selector parsing if needed.
      }
    }
  });
  return out;
}

interface JsonLdToJobOpts {
  source: string;
  fallbackCountry?: string;
  /** Optional URL prefix to prepend to relative URLs found in the JSON-LD. */
  urlBase?: string;
}

/**
 * Convert a JSON-LD JobPosting to our RawJob schema. Tolerant of missing
 * fields — returns null only if the title or company is missing entirely
 * (those are non-negotiable).
 */
export function jsonLdToRawJob(jp: JsonLdJobPosting, opts: JsonLdToJobOpts): RawJob | null {
  const title = (jp.title ?? '').trim();
  if (!title) return null;

  let company = '';
  if (typeof jp.hiringOrganization === 'string') {
    company = jp.hiringOrganization;
  } else if (jp.hiringOrganization && typeof jp.hiringOrganization === 'object') {
    company = jp.hiringOrganization.name ?? '';
  }
  company = company.trim();
  if (!company) return null;

  // Location may be a single object or an array
  const locArr = Array.isArray(jp.jobLocation) ? jp.jobLocation : jp.jobLocation ? [jp.jobLocation] : [];
  const first = locArr[0];
  const addr = first?.address;
  const locParts: string[] = [];
  let countryFromJsonLd = '';
  if (addr) {
    if (addr.addressLocality) locParts.push(addr.addressLocality);
    if (addr.addressRegion && addr.addressRegion !== addr.addressLocality) {
      locParts.push(addr.addressRegion);
    }
    if (typeof addr.addressCountry === 'string') {
      countryFromJsonLd = addr.addressCountry.length <= 3 ? addr.addressCountry.toUpperCase() : '';
    } else if (addr.addressCountry?.name) {
      countryFromJsonLd =
        addr.addressCountry.name.length <= 3 ? addr.addressCountry.name.toUpperCase() : '';
    }
  }
  const location = locParts.join(', ');
  const country = countryFromJsonLd || countryFromLocation(location) || opts.fallbackCountry || '';

  // Remote detection: schema.org JobPosting uses "TELECOMMUTE" jobLocationType for remote
  const jlt = (jp.jobLocationType ?? '').toUpperCase();
  let remote: RawJob['remote'] = '';
  if (jlt === 'TELECOMMUTE' || jlt.includes('REMOTE')) remote = 'remote';

  // Description — cap to 500 chars
  const description = cleanText(jp.description ?? '', 500);

  let url = (jp.url ?? '').trim();
  if (url && opts.urlBase && url.startsWith('/')) {
    url = opts.urlBase.replace(/\/$/, '') + url;
  }

  // Posted date — strip time component
  const postedDate = jp.datePosted ? (jp.datePosted.split('T')[0] ?? null) : null;

  // Salary — best-effort string representation
  let salary: string | null = null;
  if (jp.baseSalary?.value) {
    const v = jp.baseSalary.value;
    const currency = jp.baseSalary.currency ?? '';
    if (typeof v.value === 'number' || typeof v.value === 'string') {
      salary = `${currency} ${v.value}`.trim();
    } else if (v.minValue && v.maxValue) {
      salary = `${currency} ${v.minValue}-${v.maxValue}`.trim();
    }
  }

  return {
    title,
    company,
    location,
    country,
    remote,
    url,
    descriptionSnippet: description,
    salary,
    postedDate,
    source: opts.source,
    isAgency: false,
  };
}

/**
 * Try several CSS selectors in order and return the first cheerio collection
 * that has matches. Useful for sites that frequently change classnames.
 */
export function trySelectors(
  $: cheerio.CheerioAPI,
  selectors: string[],
): ReturnType<cheerio.CheerioAPI> | null {
  for (const sel of selectors) {
    const found = $(sel);
    if (found.length > 0) return found;
  }
  return null;
}

/** Polite delay between requests to avoid hammering a single host. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
