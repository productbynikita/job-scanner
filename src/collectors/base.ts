/**
 * Base collector interface — every source collector implements this.
 * Collectors are autonomous: they make their own HTTP calls, handle their
 * own errors, and return normalized RawJob[] without involving any AI.
 */

import type { CollectorResult, RawJob } from '../types/job.js';

export interface Collector {
  /** Stable ID used in the sources array on each job. */
  id: string;
  /** Human-readable name for logs and summaries. */
  name: string;
  /** Whether this collector is an agency (results go to is_agency=1). */
  isAgency?: boolean;
  /** Run the collector. Should never throw — return errors in the result. */
  collect(opts?: CollectorOptions): Promise<CollectorResult>;
}

export interface CollectorOptions {
  maxResults?: number;
  countries?: string[];
  /** If a collector caches data, force refresh */
  forceRefresh?: boolean;
}

/**
 * Helper to wrap collector logic with timing and error handling.
 * Collectors call this to ensure they always return a CollectorResult
 * even when they crash mid-run.
 */
export async function runCollector<T>(
  id: string,
  isAgency: boolean,
  fn: () => Promise<{ jobs: RawJob[]; errors?: string[] }>,
): Promise<CollectorResult> {
  const startedAt = Date.now();
  try {
    const { jobs, errors = [] } = await fn();
    return {
      sourceId: id,
      jobsFound: jobs.length,
      errors,
      durationMs: Date.now() - startedAt,
      jobs,
      isAgency,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      sourceId: id,
      jobsFound: 0,
      errors: [`collector crashed: ${message}`],
      durationMs: Date.now() - startedAt,
      jobs: [],
      isAgency,
    };
  }
}

/**
 * Shared HTTP helper with sane defaults. Times out after 30s.
 * Returns null on any failure rather than throwing.
 */
export async function fetchText(
  url: string,
  opts: {
    timeoutMs?: number;
    userAgent?: string;
    accept?: string;
    logger?: { trace: (msg: string, fields?: Record<string, unknown>) => void };
  } = {},
): Promise<{ status: 'ok' | 'error' | 'blocked'; text: string; statusCode?: number }> {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  opts.logger?.trace('http GET', { url, timeoutMs });
  const startedAt = Date.now();

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent':
          opts.userAgent ?? 'Mozilla/5.0 (compatible; JobScanner/0.1; +personal-use)',
        Accept: opts.accept ?? 'text/html,application/json,application/xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
    });

    const durationMs = Date.now() - startedAt;
    opts.logger?.trace('http response', {
      url,
      status: resp.status,
      durationMs,
    });

    if (resp.status === 403 || resp.status === 429) {
      return { status: 'blocked', text: '', statusCode: resp.status };
    }
    if (!resp.ok) {
      return { status: 'error', text: '', statusCode: resp.status };
    }
    const text = await resp.text();
    return { status: 'ok', text, statusCode: resp.status };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    opts.logger?.trace('http error', { url, durationMs, message });
    return { status: 'error', text: message };
  } finally {
    clearTimeout(timeout);
  }
}

/** Try to infer a 2-letter country code from a free-text location string. */
export function countryFromLocation(loc: string): string {
  if (!loc) return '';
  const lower = loc.toLowerCase();
  const map: Array<[RegExp, string]> = [
    [/germany|deutschland|berlin|munich|münchen|hamburg|frankfurt|stuttgart|köln|cologne|düsseldorf/, 'DE'],
    [/netherlands|nederland|amsterdam|rotterdam|utrecht|the hague|den haag|eindhoven/, 'NL'],
    [/switzerland|schweiz|suisse|zurich|zürich|geneva|genève|basel|bern|lausanne|zug/, 'CH'],
    [/belgium|belgique|brussels|bruxelles|brussel|antwerp|antwerpen|ghent|gent|leuven|louvain/, 'BE'],
    [/remote/, 'remote'],
  ];
  for (const [re, code] of map) {
    if (re.test(lower)) return code;
  }
  return '';
}

/** Strip HTML tags + collapse whitespace. */
export function cleanText(s: string | null | undefined, maxLen = 6000): string {
  if (!s) return '';
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, maxLen);
}
