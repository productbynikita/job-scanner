/**
 * Ashby ATS collector.
 *
 * Ashby exposes a public JSON API:
 *   https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true
 *
 * Returns { jobs: [...], apiVersion: ... }
 */

import { type Collector, runCollector, fetchText, cleanText, countryFromLocation } from './base.js';
import { isProductRole } from './atsHelpers.js';
import { loadCompanies } from '../config/loader.js';
import { createLogger } from '../logger.js';
import type { RawJob } from '../types/job.js';

interface AshbyJob {
  id: string;
  title: string;
  jobUrl?: string;
  applyUrl?: string;
  publishedDate?: string;
  updatedAt?: string;
  isRemote?: boolean;
  location?: string;
  locationName?: string;
  secondaryLocations?: Array<{ location?: string; locationName?: string }>;
  employmentType?: string;
  department?: string;
  team?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
  compensation?: { compensationTierSummary?: string };
}

interface AshbyResponse {
  jobs?: AshbyJob[];
  apiVersion?: string;
}

const log = createLogger('ashby');

export const ashbyCollector: Collector = {
  id: 'ashby',
  name: 'Ashby ATS',
  isAgency: false,

  async collect(opts = {}) {
    return runCollector('ashby', false, async () => {
      const companies = loadCompanies().ashby;
      log.info('starting collector', { companies: companies.length });

      const allJobs: RawJob[] = [];
      const errors: string[] = [];
      let companiesOk = 0;
      let companiesEmpty = 0;
      let companiesError = 0;
      let totalRaw = 0;
      let totalAfterFilter = 0;

      for (const company of companies) {
        const url = `https://api.ashbyhq.com/posting-api/job-board/${company.slug}?includeCompensation=true`;
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

        let parsed: AshbyResponse;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          errors.push(`${company.slug}: parse error: ${(err as Error).message}`);
          companiesError++;
          cLog.error('json parse failed', { error: (err as Error).message });
          continue;
        }

        const jobs = parsed.jobs ?? [];
        totalRaw += jobs.length;

        if (jobs.length === 0) {
          companiesEmpty++;
          cLog.debug('no jobs returned');
          continue;
        }

        let kept = 0;
        let dropped = 0;
        for (const j of jobs) {
          if (!isProductRole(j.title)) {
            dropped++;
            continue;
          }

          const locationName = j.locationName ?? j.location ?? '';
          const country = countryFromLocation(locationName) || company.country;
          const postedDate = (j.publishedDate ?? j.updatedAt ?? '').split('T')[0] || null;
          const remote = j.isRemote ? 'remote' : '';

          allJobs.push({
            title: j.title,
            company: company.name,
            location: locationName,
            country,
            remote,
            url: j.jobUrl ?? j.applyUrl ?? '',
            descriptionSnippet: cleanText(j.descriptionPlain ?? j.descriptionHtml ?? '', 500),
            salary: j.compensation?.compensationTierSummary ?? null,
            postedDate,
            source: 'ashby',
            isAgency: false,
          });
          kept++;
        }

        totalAfterFilter += kept;
        companiesOk++;
        cLog.info('company scanned', { total: jobs.length, kept, dropped });

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
