/**
 * Tests for HTML parsing helpers used by Phase 3 country-leader collectors.
 * We feed synthetic HTML with embedded JSON-LD / __NEXT_DATA__ / EURES
 * structures and verify the right shape comes out.
 */

import { describe, it, expect } from 'vitest';
import { extractJsonLdJobs, jsonLdToRawJob } from '../src/collectors/htmlParsers.js';

describe('extractJsonLdJobs', () => {
  it('extracts a single JobPosting from a page', () => {
    const html = `
      <html><head><script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "JobPosting",
        "title": "Senior Product Manager",
        "hiringOrganization": { "@type": "Organization", "name": "Acme" },
        "jobLocation": {
          "@type": "Place",
          "address": {
            "addressLocality": "Berlin",
            "addressCountry": "DE"
          }
        },
        "datePosted": "2026-05-06T00:00:00",
        "description": "Looking for a senior PM with API platform experience.",
        "url": "https://example.com/job/1"
      }
      </script></head><body></body></html>
    `;
    const jobs = extractJsonLdJobs(html);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.title).toBe('Senior Product Manager');
  });

  it('extracts multiple postings from @graph arrays', () => {
    const html = `
      <html><script type="application/ld+json">
      {
        "@graph": [
          { "@type": "JobPosting", "title": "PM 1", "hiringOrganization": { "name": "A" } },
          { "@type": "JobPosting", "title": "PM 2", "hiringOrganization": { "name": "B" } },
          { "@type": "Organization", "name": "Not a job" }
        ]
      }
      </script></html>
    `;
    const jobs = extractJsonLdJobs(html);
    expect(jobs).toHaveLength(2);
  });

  it('handles multiple <script> tags', () => {
    const html = `
      <script type="application/ld+json">{"@type":"JobPosting","title":"A","hiringOrganization":{"name":"X"}}</script>
      <script type="application/ld+json">{"@type":"JobPosting","title":"B","hiringOrganization":{"name":"Y"}}</script>
    `;
    const jobs = extractJsonLdJobs(html);
    expect(jobs).toHaveLength(2);
  });

  it('returns empty array on malformed JSON and does not throw', () => {
    const html = `<script type="application/ld+json">{ not valid json </script>`;
    expect(() => extractJsonLdJobs(html)).not.toThrow();
    expect(extractJsonLdJobs(html)).toHaveLength(0);
  });

  it('recovers from trailing commas', () => {
    const html = `
      <script type="application/ld+json">
      {
        "@type": "JobPosting",
        "title": "PM",
        "hiringOrganization": { "name": "Acme" },
      }
      </script>
    `;
    const jobs = extractJsonLdJobs(html);
    expect(jobs).toHaveLength(1);
  });

  it('returns empty when no JSON-LD scripts present', () => {
    const html = `<html><body><h1>No structured data here</h1></body></html>`;
    expect(extractJsonLdJobs(html)).toEqual([]);
  });
});

describe('jsonLdToRawJob', () => {
  it('converts a full JobPosting', () => {
    const job = jsonLdToRawJob(
      {
        '@type': 'JobPosting',
        title: 'Senior Product Manager - Platform',
        hiringOrganization: { name: 'Mollie' },
        jobLocation: {
          address: { addressLocality: 'Amsterdam', addressCountry: 'NL' },
        },
        datePosted: '2026-05-06T08:00:00Z',
        description: 'Build the API platform. <strong>FHIR a plus.</strong>',
        url: 'https://example.com/jobs/1',
      },
      { source: 'test' },
    );

    expect(job).not.toBeNull();
    expect(job!.title).toBe('Senior Product Manager - Platform');
    expect(job!.company).toBe('Mollie');
    expect(job!.country).toBe('NL');
    expect(job!.location).toContain('Amsterdam');
    expect(job!.postedDate).toBe('2026-05-06');
    expect(job!.descriptionSnippet).not.toContain('<strong>');
    expect(job!.descriptionSnippet).toContain('FHIR');
  });

  it('returns null when title is missing', () => {
    expect(
      jsonLdToRawJob(
        { '@type': 'JobPosting', hiringOrganization: { name: 'X' } } as never,
        { source: 'test' },
      ),
    ).toBeNull();
  });

  it('returns null when company is missing', () => {
    expect(jsonLdToRawJob({ '@type': 'JobPosting', title: 'PM' }, { source: 'test' })).toBeNull();
  });

  it('detects remote from jobLocationType=TELECOMMUTE', () => {
    const job = jsonLdToRawJob(
      {
        '@type': 'JobPosting',
        title: 'PM',
        hiringOrganization: { name: 'X' },
        jobLocationType: 'TELECOMMUTE',
      },
      { source: 'test' },
    );
    expect(job?.remote).toBe('remote');
  });

  it('uses fallback country when address country missing', () => {
    const job = jsonLdToRawJob(
      {
        '@type': 'JobPosting',
        title: 'PM',
        hiringOrganization: { name: 'X' },
        jobLocation: { address: { addressLocality: 'Generic' } },
      },
      { source: 'test', fallbackCountry: 'DE' },
    );
    expect(job?.country).toBe('DE');
  });
});
