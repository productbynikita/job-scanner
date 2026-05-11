/**
 * Deduplicate raw jobs by (normalized company, title, location).
 * Duplicates from different sources are merged: sources lists union, freshest
 * date wins, longest description snippet wins.
 */

import { createHash } from 'node:crypto';
import type { RawJob, Job } from '../types/job.js';

function normalize(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function makeJobId(company: string, title: string, location: string): string {
  const key = `${normalize(company)}|${normalize(title)}|${normalize(location)}`;
  return createHash('sha1').update(key).digest('hex').substring(0, 16);
}

interface DedupedJob extends RawJob {
  id: string;
  sources: string[];
}

export function dedupeAndMerge(jobs: RawJob[]): DedupedJob[] {
  const byId = new Map<string, DedupedJob>();

  for (const job of jobs) {
    const id = makeJobId(job.company, job.title, job.location);
    const sources = job.sources ?? [job.source];

    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, { ...job, id, sources: [...sources] });
      continue;
    }

    // Merge sources
    const merged = new Set([...existing.sources, ...sources]);
    existing.sources = Array.from(merged);

    // Keep freshest date
    if (job.postedDate && (!existing.postedDate || job.postedDate > existing.postedDate)) {
      existing.postedDate = job.postedDate;
    }

    // Keep longest snippet
    if ((job.descriptionSnippet?.length ?? 0) > (existing.descriptionSnippet?.length ?? 0)) {
      existing.descriptionSnippet = job.descriptionSnippet;
    }

    // Keep first non-empty URL
    if (!existing.url && job.url) {
      existing.url = job.url;
    }
  }

  return Array.from(byId.values());
}
