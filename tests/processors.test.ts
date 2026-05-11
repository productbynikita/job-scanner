/**
 * Unit tests for processors. Run with `npm test`.
 */

import { describe, it, expect } from 'vitest';
import { dedupeAndMerge, makeJobId } from '../src/processors/dedupe.js';
import { detectLanguage, hasHardLanguageRequirement } from '../src/processors/language.js';
import { scoreJob } from '../src/processors/score.js';
import { loadRoles } from '../src/config/loader.js';
import type { RawJob } from '../src/types/job.js';

describe('makeJobId', () => {
  it('produces stable hashes', () => {
    const a = makeJobId('Acme', 'Senior PM', 'Berlin');
    const b = makeJobId('Acme', 'Senior PM', 'Berlin');
    expect(a).toBe(b);
  });

  it('normalizes case and punctuation', () => {
    const a = makeJobId('Acme, Inc.', 'Senior PM', 'Berlin');
    const b = makeJobId('acme inc', 'senior pm', 'berlin');
    expect(a).toBe(b);
  });

  it('returns 16-char IDs', () => {
    const id = makeJobId('Acme', 'Senior PM', 'Berlin');
    expect(id).toHaveLength(16);
  });
});

describe('dedupeAndMerge', () => {
  const baseJob: Omit<RawJob, 'source'> = {
    title: 'Senior Product Manager',
    company: 'Acme',
    location: 'Berlin, DE',
    country: 'DE',
    remote: 'hybrid',
    url: 'https://a.example.com',
    descriptionSnippet: 'Short description',
    salary: null,
    postedDate: '2026-05-06',
    isAgency: false,
  };

  it('keeps unique jobs', () => {
    const jobs: RawJob[] = [
      { ...baseJob, source: 'a' },
      { ...baseJob, title: 'Other Role', source: 'a' },
    ];
    const result = dedupeAndMerge(jobs);
    expect(result).toHaveLength(2);
  });

  it('merges duplicates from different sources', () => {
    const jobs: RawJob[] = [
      { ...baseJob, source: 'remoteok' },
      { ...baseJob, source: 'weworkremotely' },
    ];
    const result = dedupeAndMerge(jobs);
    expect(result).toHaveLength(1);
    expect(result[0]?.sources).toEqual(expect.arrayContaining(['remoteok', 'weworkremotely']));
  });

  it('keeps the longer description when merging', () => {
    const jobs: RawJob[] = [
      { ...baseJob, descriptionSnippet: 'short', source: 'a' },
      {
        ...baseJob,
        descriptionSnippet: 'a much longer description with more detail',
        source: 'b',
      },
    ];
    const result = dedupeAndMerge(jobs);
    expect(result[0]?.descriptionSnippet).toContain('longer description');
  });
});

describe('detectLanguage', () => {
  it('detects English by default', () => {
    expect(detectLanguage('Senior PM with API platform experience')).toBe('en');
  });

  it('detects German with strong signals', () => {
    expect(
      detectLanguage('Wir suchen einen erfahrenen Product Manager. Deine Aufgaben umfassen...'),
    ).toBe('de');
  });

  it('detects Dutch with strong signals', () => {
    expect(detectLanguage('Wij zoeken een Product Owner. Jouw profiel: ervaring met SaaS')).toBe('nl');
  });

  it('returns unknown for empty input', () => {
    expect(detectLanguage('')).toBe('unknown');
  });
});

describe('hasHardLanguageRequirement', () => {
  it('detects fluent German requirement', () => {
    expect(hasHardLanguageRequirement('Required: fluent german, native level')).toBe('german');
  });

  it('detects native Dutch', () => {
    expect(hasHardLanguageRequirement('Native dutch speaker required')).toBe('dutch');
  });

  it('returns empty when no hard requirement', () => {
    expect(hasHardLanguageRequirement('English working language, German nice to have')).toBe('');
  });
});

describe('scoreJob', () => {
  const roles = loadRoles();

  it('scores a perfect-fit Senior TPM with API platform high', () => {
    const job: RawJob & { language: 'en' } = {
      title: 'Senior Technical Product Manager',
      company: 'Mollie',
      location: 'Amsterdam, NL',
      country: 'NL',
      remote: 'hybrid',
      url: 'https://example.com',
      descriptionSnippet: 'API platform PM with FHIR experience. Visa sponsorship offered.',
      salary: null,
      postedDate: new Date().toISOString().split('T')[0]!,
      source: 'remoteok',
      isAgency: false,
      language: 'en',
    };
    const result = scoreJob(job, roles);
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.languageRisk).toBe(false);
  });

  it('scores a junior role low', () => {
    const job: RawJob & { language: 'en' } = {
      title: 'Junior Product Manager',
      company: 'StartupCo',
      location: 'Berlin',
      country: 'DE',
      remote: 'onsite',
      url: '',
      descriptionSnippet: 'Entry-level PM role for recent graduates',
      salary: null,
      postedDate: new Date().toISOString().split('T')[0]!,
      source: 'remoteok',
      isAgency: false,
      language: 'en',
    };
    const result = scoreJob(job, roles);
    expect(result.score).toBeLessThan(50);
  });

  it('flags language risk for non-English with strong domain match', () => {
    const job: RawJob & { language: 'de' } = {
      title: 'Senior Product Manager',
      company: 'SAP',
      location: 'Walldorf, DE',
      country: 'DE',
      remote: 'hybrid',
      url: '',
      descriptionSnippet: 'SAP BTP API Management. Wir suchen einen erfahrenen Product Manager.',
      salary: null,
      postedDate: new Date().toISOString().split('T')[0]!,
      source: 'remoteok',
      isAgency: false,
      language: 'de',
    };
    const result = scoreJob(job, roles);
    expect(result.languageRisk).toBe(true);
  });
});
