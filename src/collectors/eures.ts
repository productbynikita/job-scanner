import { buildCountryLeaderCollector } from './countryLeader.js';

export const euresCollector = buildCountryLeaderCollector({
  collectorId: 'eures',
  sourceKey: 'eures',
  name: 'EURES (EU official)',
});
