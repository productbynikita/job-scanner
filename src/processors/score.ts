/**
 * Scoring engine — 0-100 score with 7 weighted components.
 * Mirrors the Python scoring exactly so existing data stays comparable.
 */

import type { RawJob, ScoreBreakdown } from '../types/job.js';
import type { Roles } from '../types/config.js';

export interface ScoreResult {
  score: number;
  breakdown: ScoreBreakdown;
  reasons: string[];
  languageRisk: boolean;
}

function containsAny(text: string, keywords: string[]): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return keywords.some((kw) => {
    // Keywords prefixed with "re:" are treated as regex patterns (case-insensitive)
    if (kw.startsWith('re:')) {
      return new RegExp(kw.slice(3), 'i').test(text);
    }
    return lower.includes(kw.toLowerCase());
  });
}

function scoreRoleTitle(title: string, roles: Roles): { points: number; reason: string } {
  const rules = roles.scoringRules.roleTitleMatch;
  const titles = roles.targetTitles;
  const lower = (title || '').toLowerCase();

  if (titles.exclude.some((t) => lower.includes(t.toLowerCase()))) {
    return { points: 0, reason: 'excluded title' };
  }
  if (titles.exactMatch.some((t) => lower.includes(t.toLowerCase()))) {
    return { points: rules.exactMatch, reason: 'exact title match' };
  }
  if (titles.strongMatch.some((t) => lower.includes(t.toLowerCase()))) {
    return { points: rules.strongMatch, reason: 'strong title match' };
  }
  if (titles.weakMatch.some((t) => lower.includes(t.toLowerCase()))) {
    return { points: rules.weakMatch, reason: 'weak title match' };
  }
  return { points: rules.noMatch, reason: 'no title match' };
}

function scoreDomain(text: string, roles: Roles): { points: number; reason: string } {
  const rules = roles.scoringRules.domainFit;
  const d = roles.domainStrengths;

  if (containsAny(text, d.primary)) {
    return { points: rules.primaryKeywordHit, reason: 'primary domain match (API/platform)' };
  }
  if (containsAny(text, d.secondary)) {
    return { points: rules.secondaryKeywordHit, reason: 'secondary domain match (healthcare)' };
  }
  if (containsAny(text, d.tertiary)) {
    return { points: rules.tertiaryKeywordHit, reason: 'tertiary domain match (SAP)' };
  }
  if (containsAny(text, d.generalTech)) {
    return { points: rules.generalTechHit, reason: 'general tech match' };
  }
  return { points: rules.noTechSignal, reason: 'no domain signal' };
}

function scoreLanguage(
  language: string,
  roles: Roles,
  domainScore: number,
): { points: number; reason: string } {
  const rules = roles.scoringRules.language;
  const lower = (language || 'en').toLowerCase();

  if (!language || lower === 'en' || lower === 'english') {
    return { points: rules.englishPrimary, reason: 'english primary' };
  }
  if (lower === 'english_acceptable' || lower === 'english_ok') {
    return { points: rules.englishAcceptable, reason: 'english acceptable' };
  }
  if ((lower === 'de' || lower === 'german') && domainScore >= 20) {
    return { points: rules.languageRiskPerfectFit, reason: 'language risk - perfect domain fit' };
  }
  if (['nl', 'dutch', 'fr', 'french'].includes(lower) && domainScore >= 20) {
    return { points: rules.languageRiskPerfectFit, reason: 'language risk - perfect domain fit' };
  }
  return { points: rules.nonEnglishRequired, reason: 'non-english required' };
}

function scoreLocation(
  country: string,
  remote: string,
  roles: Roles,
): { points: number; reason: string } {
  const rules = roles.scoringRules.location;
  const targetCountries = ['DE', 'NL', 'CH', 'BE'];

  if (targetCountries.includes(country)) {
    return { points: rules.targetCountry, reason: `target country (${country})` };
  }
  if (remote && ['remote', 'remote-eu', 'fully remote'].includes(remote.toLowerCase())) {
    return { points: rules.remoteEu, reason: 'remote EU' };
  }
  const otherEu = ['AT', 'FR', 'ES', 'IT', 'PT', 'SE', 'DK', 'NO', 'FI', 'IE', 'PL', 'CZ'];
  if (otherEu.includes(country)) {
    return { points: rules.otherEu, reason: 'other EU country' };
  }
  return { points: rules.nonEu, reason: 'non-EU' };
}

function scoreSeniority(title: string, roles: Roles): { points: number; reason: string } {
  const rules = roles.scoringRules.seniority;
  const sig = roles.seniorityKeywords;
  const lower = (title || '').toLowerCase();

  if (sig.junior.some((kw) => lower.includes(kw))) {
    return { points: rules.juniorOrExecutive, reason: 'junior' };
  }
  if (sig.executive.some((kw) => lower.includes(kw))) {
    return { points: rules.juniorOrExecutive, reason: 'executive (not IC)' };
  }
  if (['lead', 'principal', 'staff'].some((kw) => lower.includes(kw))) {
    return { points: rules.leadPrincipalIc, reason: 'lead/principal IC' };
  }
  if (['senior', 'sr.'].some((kw) => lower.includes(kw))) {
    return { points: rules.seniorIc, reason: 'senior IC' };
  }
  return { points: rules.midLevel, reason: 'mid-level' };
}

function scoreRecency(postedDate: string | null, roles: Roles): { points: number; reason: string } {
  const rules = roles.scoringRules.recency;
  if (!postedDate) return { points: rules.over30Days, reason: 'no date' };

  let posted: Date;
  try {
    posted = new Date(postedDate.split('T')[0] ?? postedDate);
    if (isNaN(posted.getTime())) {
      return { points: rules.over30Days, reason: 'unparseable date' };
    }
  } catch {
    return { points: rules.over30Days, reason: 'unparseable date' };
  }

  const today = new Date();
  const days = Math.floor((today.getTime() - posted.getTime()) / (1000 * 60 * 60 * 24));

  if (days < 1) return { points: rules.under24Hours, reason: '< 24 hours' };
  if (days <= 3) return { points: rules.d1to3, reason: `${days} days ago` };
  if (days <= 7) return { points: rules.d4to7, reason: `${days} days ago` };
  if (days <= 14) return { points: rules.d8to14, reason: `${days} days ago` };
  if (days <= 30) return { points: rules.d15to30, reason: `${days} days ago` };
  return { points: rules.over30Days, reason: `${days} days ago (stale)` };
}

function scoreBonus(text: string, roles: Roles): { points: number; reasons: string[] } {
  const rules = roles.scoringRules.bonusSignals;
  let points = 0;
  const reasons: string[] = [];
  const lower = (text || '').toLowerCase();

  if (['visa sponsor', 'relocation', 'blue card'].some((kw) => lower.includes(kw))) {
    points += rules.visaSponsorship;
    reasons.push('visa sponsorship');
  }
  if (['fhir', 'hl7'].some((kw) => lower.includes(kw))) {
    points += rules.fhirOrHl7;
    reasons.push('FHIR/HL7');
  }
  if (['sap btp', 'sap cpi', 'sap api'].some((kw) => lower.includes(kw))) {
    points += rules.sapBtp;
    reasons.push('SAP BTP');
  }
  if (['remote', 'hybrid'].some((kw) => lower.includes(kw))) {
    points += rules.remoteOrHybrid;
    reasons.push('remote/hybrid');
  }
  if (
    ['healthtech', 'fintech', 'health tech', 'fin tech'].some((kw) => lower.includes(kw))
  ) {
    points += rules.healthtechOrFintech;
    reasons.push('healthtech/fintech');
  }
  if (['sap cx', 'sap customer experience', 'salesforce', 'crm platform', 'crm integration'].some((kw) => lower.includes(kw))) {
    points += rules.sapCxOrCrm ?? 0;
    reasons.push('SAP CX / CRM platform');
  }
  if (['llm', 'ai workflow', 'ai-assisted', 'generative ai', 'gen ai', 'copilot'].some((kw) => lower.includes(kw))) {
    points += rules.aiOrLlmProduct ?? 0;
    reasons.push('AI/LLM product');
  }
  if (['s/4hana', 's4hana', 'hana transformation'].some((kw) => lower.includes(kw))) {
    points += rules.s4hana ?? 0;
    reasons.push('S/4HANA');
  }
  if (['developer experience', 'devex', 'dx ', 'developer portal', 'developer platform'].some((kw) => lower.includes(kw))) {
    points += rules.developerExperience ?? 0;
    reasons.push('developer experience');
  }

  return { points, reasons };
}

/**
 * Penalty for off-target industries (biotech, defense, lab automation, etc.).
 * Counts unique anti-pattern keyword hits and subtracts a tunable amount per hit,
 * capped at max_total so a JD can't go below zero from this alone.
 */
function scoreAntiPatterns(text: string, roles: Roles): { points: number; reasons: string[] } {
  const list = roles.domainStrengths.antiPatterns ?? [];
  const rule = roles.scoringRules.antiPatternPenalty;
  if (list.length === 0 || !rule) return { points: 0, reasons: [] };

  const lower = (text || '').toLowerCase();
  const hits = new Set<string>();
  for (const kw of list) {
    if (!kw || kw.startsWith('_')) continue;
    if (lower.includes(kw.toLowerCase())) hits.add(kw);
  }
  if (hits.size === 0) return { points: 0, reasons: [] };

  const penalty = Math.min(rule.maxTotal, hits.size * rule.perHit);
  return {
    points: -penalty,
    reasons: [`off-target industry: ${[...hits].slice(0, 4).join(', ')}${hits.size > 4 ? '…' : ''} (-${penalty})`],
  };
}

export function scoreJob(job: RawJob & { language?: string }, roles: Roles): ScoreResult {
  const title = job.title || '';
  const desc = job.descriptionSnippet || '';
  const fullText = `${title} ${desc}`;
  const country = job.country || '';
  const remote = job.remote || '';
  const postedDate = job.postedDate ?? null;
  const language = job.language || 'en';

  const role = scoreRoleTitle(title, roles);
  const domain = scoreDomain(fullText, roles);
  const lang = scoreLanguage(language, roles, domain.points);
  const loc = scoreLocation(country, remote, roles);
  const sen = scoreSeniority(title, roles);
  const rec = scoreRecency(postedDate, roles);
  const bonus = scoreBonus(fullText, roles);
  const anti = scoreAntiPatterns(fullText, roles);

  const total = Math.max(
    0,
    Math.min(
      role.points + domain.points + lang.points + loc.points + sen.points + rec.points + bonus.points + anti.points,
      100,
    ),
  );

  return {
    score: total,
    breakdown: {
      roleTitle: role.points,
      domainFit: domain.points,
      language: lang.points,
      location: loc.points,
      seniority: sen.points,
      recency: rec.points,
      bonus: bonus.points + anti.points,
    },
    reasons: [
      role.reason,
      domain.reason,
      lang.reason,
      loc.reason,
      sen.reason,
      rec.reason,
      ...bonus.reasons,
      ...anti.reasons,
    ],
    languageRisk: lang.reason === 'language risk - perfect domain fit',
  };
}
