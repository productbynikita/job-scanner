/**
 * Load configuration from data/inputs/*.json.
 *
 * The JSON files use snake_case (carried over from the Python Skill).
 * This module converts to camelCase TypeScript objects matching our types.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Preferences, Roles, Agencies, Companies, CountrySources } from '../types/config.js';

const INPUTS_DIR = resolve(process.cwd(), 'data/inputs');

function loadJson<T>(filename: string): T {
  const path = resolve(INPUTS_DIR, filename);
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as T;
}

/** snake_case keys -> camelCase. Recursive. */
function camelize(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(camelize);
  if (obj === null || typeof obj !== 'object') return obj;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
    result[camelKey] = camelize(value);
  }
  return result;
}

export function loadPreferences(): Preferences {
  return camelize(loadJson('preferences.json')) as Preferences;
}

export function loadRoles(): Roles {
  // The roles.json has nested structure with keys that don't camelize cleanly.
  // We patch them after the generic camelize() pass.
  const raw = loadJson<Record<string, unknown>>('roles.json');
  const camelized = camelize(raw) as Record<string, unknown>;

  // Remap senioritySignal.{senior,junior,executive}Keywords to seniorityKeywords.{senior,junior,executive}
  const senioritySignal = camelized.senioritySignal as
    | Record<string, string[]>
    | undefined;
  if (senioritySignal) {
    camelized.seniorityKeywords = {
      senior: senioritySignal.seniorKeywords ?? [],
      junior: senioritySignal.juniorKeywords ?? [],
      executive: senioritySignal.executiveKeywords ?? [],
    };
  }

  // Fix the recency keys (e.g. "1To3Days" -> "d1to3")
  const scoringRules = camelized.scoringRules as Record<string, unknown>;
  if (scoringRules && typeof scoringRules === 'object') {
    const recency = scoringRules.recency as Record<string, number> | undefined;
    if (recency) {
      const remapped: Record<string, number> = {
        under24Hours: recency.under24Hours ?? recency['under_24_hours'] ?? 5,
        d1to3: recency['1To3Days'] ?? recency['1_to_3_days'] ?? 4,
        d4to7: recency['4To7Days'] ?? recency['4_to_7_days'] ?? 3,
        d8to14: recency['8To14Days'] ?? recency['8_to_14_days'] ?? 2,
        d15to30: recency['15To30Days'] ?? recency['15_to_30_days'] ?? 1,
        over30Days: recency.over30Days ?? recency['over_30_days'] ?? 0,
      };
      scoringRules.recency = remapped;
    }
  }

  return camelized as unknown as Roles;
}

export function loadAgencies(): Agencies {
  return camelize(loadJson('agencies.json')) as Agencies;
}

export function loadCompanies(): Companies {
  // companies.json doesn't need camelization — its top-level keys are ATS names
  // and entries are already in {slug, name, country, industry} form.
  const raw = loadJson<Record<string, unknown>>('companies.json');
  // Filter out the _comment and _howToFindSlugs keys
  const result: Companies = { greenhouse: [], lever: [], ashby: [], workable: [] };
  for (const platform of ['greenhouse', 'lever', 'ashby', 'workable'] as const) {
    const entries = raw[platform];
    if (Array.isArray(entries)) {
      result[platform] = entries as Companies[typeof platform];
    }
  }
  return result;
}

export function loadCv(): string {
  const path = resolve(INPUTS_DIR, 'cv.md');
  return readFileSync(path, 'utf-8');
}

export function loadCountrySources(): CountrySources {
  // Filter out comment-only keys (those starting with _)
  const raw = loadJson<Record<string, unknown>>('country_sources.json');
  const result: CountrySources = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('_')) continue;
    result[key] = value as CountrySources[string];
  }
  return result;
}

export interface AppConfig {
  preferences: Preferences;
  roles: Roles;
  agencies: Agencies;
  companies: Companies;
  countrySources: CountrySources;
  cv: string;
}

export function loadAllConfig(): AppConfig {
  return {
    preferences: loadPreferences(),
    roles: loadRoles(),
    agencies: loadAgencies(),
    companies: loadCompanies(),
    countrySources: loadCountrySources(),
    cv: loadCv(),
  };
}
