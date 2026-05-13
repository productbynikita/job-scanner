/**
 * Registry of all collectors and which scan modes activate them.
 * As new collectors are added (Phase 2-5), they get registered here.
 */

import type { Collector } from './base.js';
import { remoteOkCollector } from './remoteok.js';
import { weWorkRemotelyCollector } from './weworkremotely.js';
import { indeedCollector } from './indeed.js';
import { greenhouseCollector } from './greenhouse.js';
import { leverCollector } from './lever.js';
import { ashbyCollector } from './ashby.js';
import { workableCollector } from './workable.js';
import { stepstoneDeCollector } from './stepstoneDe.js';
import { stepstoneBeCollector } from './stepstoneBe.js';
import { jobsChCollector } from './jobsCh.js';
import { nlVacaturebankCollector } from './nlVacaturebank.js';
import { welcomeToJungleCollector } from './welcomeToJungle.js';
import { euresCollector } from './eures.js';
import { linkedinCollector } from './linkedin.js';
import { agenciesCollector } from './agency.js';
import { watchlistCollector } from './watchlist.js';

export const ALL_COLLECTORS: Collector[] = [
  // Tier 1 — remote-friendly aggregators
  remoteOkCollector,
  weWorkRemotelyCollector,
  indeedCollector,
  // Tier 2 — ATS APIs (Phase 2)
  greenhouseCollector,
  leverCollector,
  ashbyCollector,
  workableCollector,
  // Tier 3 — country leaders (Phase 3)
  stepstoneDeCollector,
  stepstoneBeCollector,
  jobsChCollector,
  nlVacaturebankCollector,
  welcomeToJungleCollector,
  euresCollector,
  // Tier 4 — LinkedIn via Apify (Phase 4)
  linkedinCollector,
  // Tier 5 — Recruiting agencies (Phase 5)
  agenciesCollector,
  // Tier 6 — Target company watchlist
  watchlistCollector,
];

export type ScanMode =
  | 'quick'
  | 'full'
  | 'remote'
  | 'deep'
  | 'agencies'
  | 'linkedin'
  | 'glassdoor'
  | 'ats'
  | 'country'
  | 'watchlist';

export type SourceCategory = 'job_board' | 'ats' | 'agency' | 'watchlist';

export const SOURCE_CATEGORY_MAP: Record<string, SourceCategory> = {
  remoteok:         'job_board',
  weworkremotely:   'job_board',
  indeed:           'job_board',
  stepstone_de:     'job_board',
  stepstone_be:     'job_board',
  jobs_ch:          'job_board',
  nl_vacaturebank:  'job_board',
  welcome_to_jungle:'job_board',
  eures:            'job_board',
  linkedin:         'job_board',
  greenhouse:       'ats',
  lever:            'ats',
  ashby:            'ats',
  workable:         'ats',
  watchlist:        'watchlist',
  agencies:         'agency',
};

// Common collector lists
const REMOTE_SOURCES = ['remoteok', 'weworkremotely'];
const ATS_SOURCES = ['greenhouse', 'lever', 'ashby', 'workable'];
const COUNTRY_SOURCES = [
  'stepstone_de',
  'stepstone_be',
  'jobs_ch',
  'nl_vacaturebank',
  'welcome_to_jungle',
  'eures',
];
const LINKEDIN_SOURCES = ['linkedin'];

/** Which collectors run for each mode. */
const MODE_TO_COLLECTORS: Record<ScanMode, string[]> = {
  // Lightweight: only remote-friendly aggregators
  quick: REMOTE_SOURCES,
  remote: REMOTE_SOURCES,

  // ATS-only mode (Phase 2): EU tech companies on Greenhouse/Lever/Ashby/Workable
  ats: ATS_SOURCES,

  // Country-only mode (Phase 3): the country-leader job boards
  country: COUNTRY_SOURCES,

  // LinkedIn-only mode (Phase 4): only run the LinkedIn collector
  linkedin: LINKEDIN_SOURCES,

  // Full scan: ATS + country + remote + LinkedIn + agencies
  full: [...ATS_SOURCES, ...COUNTRY_SOURCES, ...REMOTE_SOURCES, ...LINKEDIN_SOURCES, 'agencies'],

  // Deep scan: everything
  deep: [...ATS_SOURCES, ...COUNTRY_SOURCES, ...REMOTE_SOURCES, ...LINKEDIN_SOURCES, 'agencies'],

  // Phase 5 — Recruiting agencies
  agencies: ['agencies'],
  glassdoor: [], // intentionally never wired — user opted out
  // Target company watchlist — scans only your named target companies
  watchlist: ['watchlist'],
};

export function getCollectorsForMode(mode: ScanMode): Collector[] {
  const ids = MODE_TO_COLLECTORS[mode] ?? [];
  return ALL_COLLECTORS.filter((c) => ids.includes(c.id));
}

export function getCollectorById(id: string): Collector | undefined {
  return ALL_COLLECTORS.find((c) => c.id === id);
}
