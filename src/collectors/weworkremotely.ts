/**
 * WeWorkRemotely collector. Uses the public RSS feed for product jobs.
 * Titles are formatted "Company: Job Title" so we split on the colon.
 */

import { XMLParser } from 'fast-xml-parser';
import { type Collector, runCollector, fetchText, cleanText } from './base.js';
import { createLogger } from '../logger.js';
import type { RawJob } from '../types/job.js';

interface RssItem {
  title?: string;
  link?: string;
  description?: string;
  pubDate?: string;
}

const FEED_URL = 'https://weworkremotely.com/categories/remote-product-jobs.rss';
const log = createLogger('weworkremotely');

export const weWorkRemotelyCollector: Collector = {
  id: 'weworkremotely',
  name: 'WeWorkRemotely',
  isAgency: false,
  async collect(opts = {}) {
    return runCollector('weworkremotely', false, async () => {
      log.info('starting collector');
      const t = log.timer('fetch');
      const { status, text, statusCode } = await fetchText(FEED_URL, {
        accept: 'application/rss+xml,application/xml,text/xml',
        logger: log,
      });
      t.end({ status, statusCode });

      if (status !== 'ok') {
        log.warn('fetch failed', { status, statusCode });
        return { jobs: [], errors: [`fetch ${status}`] };
      }

      const parser = new XMLParser({
        ignoreAttributes: false,
        cdataPropName: '_cdata',
        textNodeName: '_text',
        processEntities: false,
      });

      let parsed: unknown;
      try {
        parsed = parser.parse(text);
      } catch (err) {
        log.error('xml parse failed', { error: (err as Error).message });
        return { jobs: [], errors: [`xml parse error: ${(err as Error).message}`] };
      }

      const channel = (parsed as { rss?: { channel?: { item?: RssItem | RssItem[] } } })?.rss
        ?.channel;
      if (!channel) {
        log.warn('no channel in RSS');
        return { jobs: [], errors: ['no channel in RSS'] };
      }

      const itemsRaw = channel.item ?? [];
      const items: RssItem[] = Array.isArray(itemsRaw) ? itemsRaw : [itemsRaw];
      const jobs: RawJob[] = [];
      let raw = 0;
      let droppedNoTitle = 0;
      let droppedNotProduct = 0;

      for (const item of items) {
        raw++;
        const titleRaw = String(item.title ?? '').trim();
        if (!titleRaw) {
          droppedNoTitle++;
          continue;
        }

        let company = '';
        let title = titleRaw;
        if (titleRaw.includes(':')) {
          const [companyPart, ...rest] = titleRaw.split(':');
          company = (companyPart ?? '').trim();
          title = rest.join(':').trim();
        }

        if (!title.toLowerCase().includes('product')) {
          droppedNotProduct++;
          continue;
        }

        let postedDate: string | null = null;
        if (item.pubDate) {
          const d = new Date(item.pubDate);
          if (!isNaN(d.getTime())) postedDate = d.toISOString().split('T')[0] ?? null;
        }

        jobs.push({
          title,
          company,
          location: 'Remote',
          country: 'remote',
          remote: 'remote',
          url: String(item.link ?? '').trim(),
          descriptionSnippet: cleanText(String(item.description ?? '')),
          salary: null,
          postedDate,
          source: 'weworkremotely',
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
