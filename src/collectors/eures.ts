/**
 * EURES collector — currently disabled.
 *
 * The EURES portal migrated in 2023. The new job-search API at
 * europa.eu/eures/api/jv-searchengine requires session-based authentication
 * (returns 401 for unauthenticated requests). There is no public search endpoint.
 *
 * LinkedIn's EU-wide searches provide equivalent coverage.
 * Re-enable this collector once a working public endpoint is confirmed.
 */

import { type Collector } from './base.js';
import { createLogger } from '../logger.js';

const log = createLogger('eures');

export const euresCollector: Collector = {
  id: 'eures',
  name: 'EURES (EU official)',
  isAgency: false,
  async collect() {
    log.info('collector disabled — EURES API requires authentication since 2023 portal migration');
    return {
      sourceId: 'eures',
      jobsFound: 0,
      errors: [],
      durationMs: 0,
      jobs: [],
    };
  },
};
