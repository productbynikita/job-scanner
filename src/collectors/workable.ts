/**
 * Workable ATS collector.
 *
 * Workable exposes a public RSS feed and JSON API per company:
 *   https://apply.workable.com/api/v3/accounts/{slug}/jobs
 *
 * The legacy RSS URL also works:
 *   https://{slug}.workable.com/spi/v3/widget/feed?details=true
 *
 * We use the v3 API. Some companies are on apply.workable.com, others
 * have a custom subdomain — both eventually resolve to the same data.
 */

import { type Collector, runCollector, fetchText, cleanText, countryFromLocation } from './base.js';
import { isProductRole } from './atsHelpers.js';
import { loadCompanies } from '../config/loader.js';
import { createLogger } from '../logger.js';
import type { RawJob } from '../types/job.js';

interface WorkableJob {
  id: string;
  title: string;
  shortcode?: string;
  url?: string;
  application_url?: string;
  full_title?: string;
  location?: { country?: string; city?: string; region?: string };
  remote?: boolean;
  telecommuting?: boolean;
  employment_type?: string;
  department?: string;
  description?: string;
  benefits?: string;
  created_at?: string;
  published_on?: string;
  state?: string;
}

interface WorkableResponse {
  results?: WorkableJob[];
  jobs?: WorkableJob[];
  total?: number;
}

const log = createLogger('workable');

export const workableCollector: Collector = {
  id: 'workable',
  name: 'Workable ATS',
  isAgency: false,

  async collect(opts = {}) {
    return runCollector('workable', false, async () => {
      const companies = loadCompanies().workable;
      log.info('starting collector', { companies: companies.length });

      const allJobs: RawJob[] = [];
      const errors: string[] = [];
      let companiesOk = 0;
      let companiesEmpty = 0;
      let companiesError = 0;
      let totalRaw = 0;
      let totalAfterFilter = 0;

      for (const company of companies) {
        // Workable's modern public endpoint
        const url = `https://apply.workable.com/api/v3/accounts/${company.slug}/jobs`;
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

        let parsed: WorkableResponse;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          errors.push(`${company.slug}: parse error: ${(err as Error).message}`);
          companiesError++;
          cLog.error('json parse failed', { error: (err as Error).message });
          continue;
        }

        const jobs = parsed.results ?? parsed.jobs ?? [];
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

          const locParts = [j.location?.city, j.location?.region, j.location?.country].filter(Boolean);
          const locationName = locParts.join(', ');
          const country = countryFromLocation(locationName) || company.country;
          const postedDate = (j.published_on ?? j.created_at ?? '').split('T')[0] || null;
          const remote = j.remote || j.telecommuting ? 'remote' : '';
          const jobUrl = j.url
            ?? j.application_url
            ?? `https://apply.workable.com/${company.slug}/j/${j.shortcode ?? j.id}/`;

          allJobs.push({
            title: j.title,
            company: company.name,
            location: locationName,
            country,
            remote,
            url: jobUrl,
            descriptionSnippet: cleanText(j.description ?? ''),
            salary: null,
            postedDate,
            source: 'workable',
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
