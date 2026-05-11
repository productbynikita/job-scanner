/**
 * Lever ATS collector.
 *
 * Lever's public postings API:
 *   https://api.lever.co/v0/postings/{slug}?mode=json
 *
 * Returns an array of postings directly (no wrapper object).
 */

import { type Collector, runCollector, fetchText, cleanText, countryFromLocation } from './base.js';
import { isProductRole } from './atsHelpers.js';
import { loadCompanies } from '../config/loader.js';
import { createLogger } from '../logger.js';
import type { RawJob } from '../types/job.js';

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl?: string;
  createdAt?: number;
  categories?: {
    location?: string;
    team?: string;
    department?: string;
    commitment?: string;
  };
  workplaceType?: string;
  description?: string;
  descriptionPlain?: string;
}

const log = createLogger('lever');

export const leverCollector: Collector = {
  id: 'lever',
  name: 'Lever ATS',
  isAgency: false,

  async collect(opts = {}) {
    return runCollector('lever', false, async () => {
      const companies = loadCompanies().lever;
      log.info('starting collector', { companies: companies.length });

      const allJobs: RawJob[] = [];
      const errors: string[] = [];
      let companiesOk = 0;
      let companiesEmpty = 0;
      let companiesError = 0;
      let totalRaw = 0;
      let totalAfterFilter = 0;

      for (const company of companies) {
        const url = `https://api.lever.co/v0/postings/${company.slug}?mode=json`;
        const cLog = log.child(company.slug);

        const t = cLog.timer('fetch');
        const { status, text, statusCode } = await fetchText(url, {
          accept: 'application/json',
          logger: cLog,
        });
        t.end({ status, statusCode });

        if (status !== 'ok') {
          errors.push(`${company.slug}: fetch ${status} (${statusCode ?? 'no code'})`);
          companiesError++;
          cLog.warn('fetch failed', { status, statusCode, url });
          continue;
        }

        let postings: LeverPosting[];
        try {
          postings = JSON.parse(text);
          if (!Array.isArray(postings)) {
            throw new Error('expected array');
          }
        } catch (err) {
          errors.push(`${company.slug}: parse error: ${(err as Error).message}`);
          companiesError++;
          cLog.error('json parse failed', { error: (err as Error).message });
          continue;
        }

        totalRaw += postings.length;

        if (postings.length === 0) {
          companiesEmpty++;
          cLog.debug('no jobs returned');
          continue;
        }

        let kept = 0;
        let dropped = 0;
        for (const p of postings) {
          if (!isProductRole(p.text)) {
            dropped++;
            continue;
          }

          const locationName = p.categories?.location ?? '';
          const country = countryFromLocation(locationName) || company.country;
          const postedDate = p.createdAt ? new Date(p.createdAt).toISOString().split('T')[0]! : null;
          const workplace = (p.workplaceType ?? '').toLowerCase();
          const remote = workplace.includes('remote')
            ? 'remote'
            : workplace.includes('hybrid')
              ? 'hybrid'
              : '';

          allJobs.push({
            title: p.text,
            company: company.name,
            location: locationName,
            country,
            remote,
            url: p.hostedUrl,
            descriptionSnippet: cleanText(p.descriptionPlain ?? p.description ?? '', 500),
            salary: null,
            postedDate,
            source: 'lever',
            isAgency: false,
          });
          kept++;
        }

        totalAfterFilter += kept;
        companiesOk++;
        cLog.info('company scanned', {
          total: postings.length,
          kept,
          dropped,
        });

        if (opts.maxResults && allJobs.length >= opts.maxResults) {
          log.warn('hit max results, stopping early', { max: opts.maxResults });
          break;
        }
      }

      log.info('collector complete', {
        companiesOk,
        companiesEmpty,
        companiesError,
        totalRaw,
        afterTitleFilter: totalAfterFilter,
        finalJobs: allJobs.length,
      });

      return { jobs: allJobs, errors };
    });
  },
};
