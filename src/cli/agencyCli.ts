/**
 * Agency management CLI helpers.
 * list / register / unregister — all mutate data/inputs/agencies.json.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgencyEntry } from '../types/config.js';

const AGENCIES_FILE = resolve(process.cwd(), 'data/inputs/agencies.json');

// Raw JSON shape (snake_case, before camelize)
interface RawAgencyEntry {
  id: string;
  name: string;
  tier: string;
  country?: string;
  specialty: string;
  search_urls: Record<string, string>;
  registered: boolean;
  registration_url: string | null;
  contact: string | null;
  notes: string;
}

function loadRaw(): { agencies: RawAgencyEntry[] } {
  return JSON.parse(readFileSync(AGENCIES_FILE, 'utf-8')) as { agencies: RawAgencyEntry[] };
}

function saveRaw(data: { agencies: RawAgencyEntry[] }): void {
  writeFileSync(AGENCIES_FILE, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

export function listAgencies(): string {
  const { agencies } = loadRaw();

  const lines = [
    '# Configured recruiting agencies',
    '',
    '| ID | Name | Tier | Countries | Registered | Specialty |',
    '|----|------|------|-----------|------------|-----------|',
  ];

  for (const a of agencies) {
    const countries = Object.keys(a.search_urls).join(', ');
    const reg = a.registered
      ? `✅${a.contact ? ` (${a.contact})` : ''}`
      : '❌';
    lines.push(`| \`${a.id}\` | ${a.name} | ${a.tier} | ${countries} | ${reg} | ${a.specialty} |`);
  }

  const registered = agencies.filter((a) => a.registered).length;
  lines.push('');
  lines.push(`**${registered}/${agencies.length} registered**`);
  lines.push('');
  lines.push('Register with: `npm run agencies:register -- <id>`');
  lines.push('Registration URLs:');
  for (const a of agencies.filter((a) => !a.registered)) {
    lines.push(`  ${a.id}: ${a.registration_url ?? '(no URL)'}`);
  }

  return lines.join('\n');
}

export function registerAgency(id: string, contact?: string): string {
  const data = loadRaw();
  const agency = data.agencies.find((a) => a.id === id);

  if (!agency) {
    return `Agency '${id}' not found. Run \`npm run agencies:list\` to see valid IDs.`;
  }

  agency.registered = true;
  if (contact) agency.contact = contact;
  saveRaw(data);

  return `✅ Marked ${agency.name} as registered${contact ? ` (contact: ${contact})` : ''}.`;
}

export function unregisterAgency(id: string): string {
  const data = loadRaw();
  const agency = data.agencies.find((a) => a.id === id);

  if (!agency) {
    return `Agency '${id}' not found.`;
  }

  agency.registered = false;
  saveRaw(data);

  return `❌ Marked ${agency.name} as not registered.`;
}
