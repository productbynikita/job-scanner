import { buildCountryLeaderCollector } from './countryLeader.js';

export const jobsChCollector = buildCountryLeaderCollector({
  collectorId: 'jobs_ch',
  sourceKey: 'jobs_ch',
  name: 'jobs.ch',
});
