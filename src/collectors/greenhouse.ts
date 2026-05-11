/**
 * Greenhouse ATS collector.
 *
 * Greenhouse exposes a public, free, structured JSON API for any company
 * that uses its job board. No auth, no rate limits at our scale.
 *
 *   https://boards-api.greenhouse.io/v1/boards/{slug}/jobs
 *   https://boards-api.greenhouse.io/v1/boards/{slug}/jobs/{id}  (full detail)
 *
 * We fetch the list endpoint per company. If a company isn't on Greenhouse
 * we get a 404 and log it; the scan continues.
 */

import { type Collector, runCollector, fetchText, cleanText, countryFromLocation } from './base.js';
import { isProductRole } from './atsHelpers.js';
import { loadCompanies } from '../config/loader.js';
import { createLogger } from '../logger.js';
import type { RawJob } from '../types/job.js';

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  updated_at?: string;
  location?: { name: string };
  offices?: Array<{ name: string; location?: string }>;
  metadata?: Array<{ name: string; value: unknown }>;
  content?: string;
  departments?: Array<{ name: string }>;
}

interface GreenhouseResponse {
  jobs?: GreenhouseJob[];
  meta?: { total: number };
}

const log = createLogger('greenhouse');

export const greenhouseCollector: Collector = {
  id: 'greenhouse',
  name: 'Greenhouse ATS',
  isAgency: false,

  async collect(opts = {}) {
    return runCollector('greenhouse', false, async () => {
      const companies = loadCompanies().greenhouse;
      log.info('starting collector', { companies: companies.length });

      const allJobs: RawJob[] = [];
      const errors: string[] = [];
      let companiesOk = 0;
      let companiesEmpty = 0;
      let companiesError = 0;
      let totalRaw = 0;
      let totalAfterFilter = 0;

      for (const company of companies) {
        const url = `https://boards-api.greenhouse.io/v1/boards/${company.slug}/jobs`;
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

        let parsed: GreenhouseResponse;
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

          const locationName = j.location?.name ?? j.offices?.[0]?.name ?? '';
          const country = countryFromLocation(locationName) || company.country;
          const postedDate = j.updated_at ? j.updated_at.split('T')[0] ?? null : null;

          allJobs.push({
            title: j.title,
            company: company.name,
            location: locationName,
            country,
            remote: locationName.toLowerCase().includes('remote') ? 'remote' : '',
            url: j.absolute_url,
            descriptionSnippet: cleanText(j.content ?? '', 500),
            salary: null,
            postedDate,
            source: 'greenhouse',
            isAgency: false,
          });
          kept++;
        }

        totalAfterFilter += kept;
        companiesOk++;
        cLog.info('company scanned', {
          total: jobs.length,
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
