/**
 * RemoteOK collector. Public JSON feed, no auth. The first array element
 * is metadata; the rest are job postings. We filter to product-related roles.
 */

import { type Collector, runCollector, fetchText, cleanText } from './base.js';
import { createLogger } from '../logger.js';
import type { RawJob } from '../types/job.js';

interface RemoteOkItem {
  position?: string;
  company?: string;
  location?: string;
  description?: string;
  date?: string;
  url?: string;
  apply_url?: string;
  salary_min?: number;
  tags?: string[];
}

const log = createLogger('remoteok');

export const remoteOkCollector: Collector = {
  id: 'remoteok',
  name: 'RemoteOK',
  isAgency: false,
  async collect(opts = {}) {
    return runCollector('remoteok', false, async () => {
      log.info('starting collector');
      const t = log.timer('fetch');
      const { status, text, statusCode } = await fetchText('https://remoteok.com/api', {
        accept: 'application/json',
        logger: log,
      });
      t.end({ status, statusCode });

      if (status !== 'ok') {
        log.warn('fetch failed', { status, statusCode });
        return { jobs: [], errors: [`fetch ${status}`] };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        log.error('json parse failed', { error: (err as Error).message });
        return { jobs: [], errors: [`parse error: ${(err as Error).message}`] };
      }

      if (!Array.isArray(parsed)) {
        log.error('unexpected response shape');
        return { jobs: [], errors: ['unexpected response shape'] };
      }

      const items = parsed as RemoteOkItem[];
      const jobs: RawJob[] = [];
      let raw = 0;
      let droppedNoTitle = 0;
      let droppedNotProduct = 0;

      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        raw++;
        const title = item.position;
        if (!title) {
          droppedNoTitle++;
          continue;
        }

        const tagText = (item.tags ?? []).join(' ').toLowerCase();
        const titleLower = title.toLowerCase();
        if (!titleLower.includes('product') && !tagText.includes('product')) {
          droppedNotProduct++;
          continue;
        }

        const postedDate = item.date ? item.date.split('T')[0] ?? null : null;

        jobs.push({
          title,
          company: item.company ?? '',
          location: item.location ?? 'Remote',
          country: 'remote',
          remote: 'remote',
          url: item.url ?? item.apply_url ?? '',
          descriptionSnippet: cleanText(item.description),
          salary: item.salary_min ? String(item.salary_min) : null,
          postedDate,
          source: 'remoteok',
          isAgency: false,
        });

        if (opts.maxResults && jobs.length >= opts.maxResults) {
          log.debug('hit max results', { max: opts.maxResults });
          break;
        }
      }

      log.info('collector complete', {
        raw,
        droppedNoTitle,
        droppedNotProduct,
        kept: jobs.length,
      });
      return { jobs };
    });
  },
};
