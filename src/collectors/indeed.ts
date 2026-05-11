/**
 * Indeed collector — DEFERRED to Phase 2.
 *
 * The Indeed Publisher API was discontinued in 2023, so there are three options:
 *   1. Apify actor (e.g. misceres/indeed-scraper) — costs ~$0.001/job
 *   2. RapidAPI Indeed scrapers — paid third-party services
 *   3. Skip Indeed entirely — ATS APIs (Greenhouse, Lever) cover ~70% of the
 *      same companies that post on Indeed, with cleaner data
 *
 * This collector returns an empty result with a note. We'll wire it up in
 * Phase 2 once you've decided which path to take.
 */

import { type Collector, runCollector } from './base.js';

export const indeedCollector: Collector = {
  id: 'indeed',
  name: 'Indeed (deferred)',
  isAgency: false,
  async collect() {
    return runCollector('indeed', false, async () => ({
      jobs: [],
      errors: [
        'Indeed collector not yet implemented. Indeed Publisher API was discontinued in 2023.',
        'Phase 2 options: (a) Apify actor, (b) RapidAPI scraper, (c) skip and rely on ATS APIs.',
      ],
    }));
  },
};
