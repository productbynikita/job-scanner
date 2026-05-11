/**
 * Language detection for job postings.
 * Keyword heuristics — good enough for distinguishing English from DE/NL/FR.
 * Conservative defaults: returns 'en' if no strong non-English signal.
 */

import type { Language } from '../types/job.js';

const GERMAN_INDICATORS = [
  'wir suchen',
  'deine aufgaben',
  'dein profil',
  'wir bieten',
  'stellenangebot',
  'voraussetzungen',
  'anforderungen',
  'berufserfahrung',
  'kenntnisse',
  'fähigkeiten',
  'muttersprache',
  'verhandlungssicher',
  'fließend in deutsch',
  'deutschkenntnisse',
];

const DUTCH_INDICATORS = [
  'wij zoeken',
  'jouw taken',
  'jouw profiel',
  'wij bieden',
  'vacature',
  'ervaring',
  'vereisten',
  'kennis',
  'vaardigheden',
  'moedertaal',
  'vloeiend nederlands',
  'nederlandstalig',
];

const FRENCH_INDICATORS = [
  'nous recherchons',
  'votre profil',
  'vos missions',
  'nous offrons',
  "offre d'emploi",
  'compétences',
  'expérience requise',
  'exigences',
  'langue maternelle',
  'français courant',
];

const HARD_LANGUAGE_REQUIREMENTS: Record<string, string[]> = {
  german: [
    'fluent german',
    'native german',
    'german native',
    'muttersprache deutsch',
    'verhandlungssicheres deutsch',
    'perfect german',
    'german mandatory',
    'deutsch als muttersprache',
    'sehr gute deutschkenntnisse',
  ],
  dutch: [
    'fluent dutch',
    'native dutch',
    'dutch native',
    'moedertaal nederlands',
    'vloeiend nederlands',
    'perfect dutch',
    'dutch mandatory',
  ],
  french: [
    'fluent french',
    'native french',
    'french native',
    'langue maternelle française',
    'français courant',
    'perfect french',
    'french mandatory',
  ],
};

export function detectLanguage(text: string): Language {
  if (!text) return 'unknown';
  const lower = text.toLowerCase();

  const deHits = GERMAN_INDICATORS.filter((i) => lower.includes(i)).length;
  const nlHits = DUTCH_INDICATORS.filter((i) => lower.includes(i)).length;
  const frHits = FRENCH_INDICATORS.filter((i) => lower.includes(i)).length;

  if (deHits >= 2 && deHits >= nlHits && deHits >= frHits) return 'de';
  if (nlHits >= 2 && nlHits >= deHits && nlHits >= frHits) return 'nl';
  if (frHits >= 2) return 'fr';
  return 'en';
}

export function hasHardLanguageRequirement(text: string): string {
  if (!text) return '';
  const lower = text.toLowerCase();
  for (const [lang, phrases] of Object.entries(HARD_LANGUAGE_REQUIREMENTS)) {
    if (phrases.some((p) => lower.includes(p))) return lang;
  }
  return '';
}
