/**
 * Industry inference for jobs.
 *
 * Two angles per job:
 *   - inferRoleIndustry(job)    — what the role/product is about (title + snippet, title-weighted)
 *   - inferCompanyIndustry(job) — what the company does (lookup → enrichment → company-name keywords)
 *
 * Tags reuse the slug taxonomy already established in data/inputs/companies.json
 * and data/inputs/watchlist.json (fintech, data, devtools, ai, saas, …) and add
 * a handful more (crypto, industrial, ecommerce, climate, gov, security, gaming).
 *
 * `displayIndustry(tag)` converts a slug to a short human label (≤12 chars).
 */

import type { Job } from '../types/job.js';
import { loadCompanies, loadWatchlist } from '../config/loader.js';

export type IndustryTag = string;

interface IndustryRule {
  tag: IndustryTag;
  patterns: RegExp[];
}

/**
 * Order matters: more specific tags first so they win ties.
 * (e.g. 'crypto' before 'fintech' — Chainlink mentions "payments" but is crypto.)
 */
const INDUSTRY_RULES: IndustryRule[] = [
  {
    tag: 'crypto',
    patterns: [
      /\bcrypto\w*/i,
      /\bblockchain\b/i,
      /\bweb ?3\b/i,
      /\bdefi\b/i,
      /\beth(ereum)?\b/i,
      /\bbitcoin\b/i,
      /\btokeni[sz](ation|e|ed)\b/i,
      /\bchainlink\b/i,
      /\bnft\b/i,
      /\bonchain\b/i,
      /\bsmart contract\b/i,
    ],
  },
  {
    tag: 'ai',
    patterns: [
      /\bllm\b/i,
      /\bgenai\b/i,
      /\bfoundation model\b/i,
      /\bmachine learning\b/i,
      /\bml ?ops\b/i,
      /\bnlp\b/i,
      /\bcomputer vision\b/i,
      /\bagentic\b/i,
      /\bgenerative ai\b/i,
      /\bdeep learning\b/i,
    ],
  },
  {
    tag: 'healthtech',
    patterns: [
      /\bhealth(care|tech)?\b/i,
      /\bmed(ical|tech)\b/i,
      /\bpharma\b/i,
      /\bbiotech\b/i,
      /\bclinical\b/i,
      /\bpatient(s)?\b/i,
      /\bfhir\b/i,
      /\bhl7\b/i,
      /\bhospital\b/i,
      /\btelemedicine\b/i,
    ],
  },
  {
    tag: 'insurtech',
    patterns: [/\binsur(ance|tech)\b/i, /\bunderwriting\b/i, /\bclaim(s)?\b/i, /\bactuari(al|es)\b/i],
  },
  {
    tag: 'regtech',
    patterns: [/\bregtech\b/i, /\bcompliance\b/i, /\baml\b/i, /\bkyc\b/i, /\bsanction(s)?\b/i],
  },
  {
    tag: 'fintech',
    patterns: [
      /\bfintech\b/i,
      /\bbank(ing)?\b/i,
      /\bpayment(s)?\b/i,
      /\btrading\b/i,
      /\blending\b/i,
      /\bwealth\b/i,
      /\btreasury\b/i,
      /\bneobank\b/i,
      /\bcheckout\b/i,
      /\bremittance\b/i,
      /\bcapital markets\b/i,
      /\bfinance processes?\b/i,
    ],
  },
  {
    tag: 'data',
    patterns: [
      /\bdata (platform|warehouse|lake|engineer|infrastructure|product)\b/i,
      /\bsnowflake\b/i,
      /\bdatabricks\b/i,
      /\banalytics\b/i,
      /\bobservab(ility|le)\b/i,
      /\bbi (tools|platform)\b/i,
    ],
  },
  {
    tag: 'devtools',
    patterns: [
      /\bdev ?tools\b/i,
      /\bdeveloper (experience|productivity|platform)\b/i,
      /\bapi platform\b/i,
      /\bdevex\b/i,
      /\bdevrel\b/i,
      /\bsdk\b/i,
      /\bide\b/i,
      /\bide plugin\b/i,
    ],
  },
  {
    tag: 'infra',
    patterns: [
      /\binfrastructure\b/i,
      /\bkubernetes\b/i,
      /\bk8s\b/i,
      /\bcloud platform\b/i,
      /\bnetworking\b/i,
      /\bcdn\b/i,
      /\bnode (infrastructure|operator)\b/i,
      /\bdevops\b/i,
    ],
  },
  {
    tag: 'cloud',
    patterns: [/\b(public|private|hybrid) cloud\b/i, /\baws\b/i, /\bazure\b/i, /\bgcp\b/i, /\bgoogle cloud\b/i],
  },
  {
    tag: 'security',
    patterns: [/\bcyber ?security\b/i, /\binfo ?sec\b/i, /\bvulnerabilit(y|ies)\b/i, /\bsecops\b/i, /\bzero trust\b/i],
  },
  {
    tag: 'hrtech',
    patterns: [
      /\bhr ?tech\b/i,
      /\bpeople ops\b/i,
      /\brecruit(ing|ment)\b/i,
      /\btalent acquisition\b/i,
      /\bhuman resources\b/i,
      /\bhiring platform\b/i,
      /\bworkforce\b/i,
    ],
  },
  {
    tag: 'ecommerce',
    patterns: [
      /\be ?commerce\b/i,
      /\bonline retail\b/i,
      /\bmarketplace platform\b/i,
      /\bshopify\b/i,
      /\bdtc\b/i,
      /\bd2c\b/i,
      /\bcart\b/i,
      /\bstorefront\b/i,
    ],
  },
  {
    tag: 'marketplace',
    patterns: [/\bmarketplace\b/i, /\btwo[- ]sided\b/i, /\bsupply (and|&) demand\b/i],
  },
  {
    tag: 'logistics',
    patterns: [
      /\blogistics\b/i,
      /\bsupply chain\b/i,
      /\bfreight\b/i,
      /\bdelivery\b/i,
      /\bwarehouse\b/i,
      /\bshipping\b/i,
      /\blast-mile\b/i,
    ],
  },
  {
    tag: 'automotive',
    patterns: [/\bautomotive\b/i, /\bvehicle\b/i, /\bcar (platform|software)\b/i, /\bev charging\b/i, /\badas\b/i],
  },
  {
    tag: 'industrial',
    patterns: [
      /\bmanufacturing\b/i,
      /\bindustrial\b/i,
      /\bfactory\b/i,
      /\bplant operations\b/i,
      /\bhardware\b/i,
      /\bgrain\b/i,
      /\bprocessing equipment\b/i,
    ],
  },
  {
    tag: 'iot',
    patterns: [/\biot\b/i, /\binternet of things\b/i, /\bsmart (home|building|city)\b/i, /\bedge devices?\b/i],
  },
  {
    tag: 'gaming',
    patterns: [/\bgam(ing|e studio)\b/i, /\besports\b/i, /\bvideo gam(e|es)\b/i],
  },
  {
    tag: 'media',
    patterns: [/\bmedia\b/i, /\bstreaming\b/i, /\bpublish(ing)?\b/i, /\badvertising\b/i, /\bcontent platform\b/i],
  },
  {
    tag: 'climate',
    patterns: [/\bclimate\b/i, /\bcarbon\b/i, /\bsustainabilit(y|ies)\b/i, /\brenewable\b/i, /\bclean ?tech\b/i, /\bnet zero\b/i],
  },
  {
    tag: 'travel',
    patterns: [/\btravel\b/i, /\bhospitality\b/i, /\bbooking\b/i, /\bairline\b/i, /\bhotel\b/i],
  },
  {
    tag: 'gov',
    patterns: [/\bgovernment\b/i, /\bpublic sector\b/i, /\beducation\b/i, /\bed ?tech\b/i, /\buniversit(y|ies)\b/i],
  },
  {
    tag: 'telco',
    patterns: [/\btelco\b/i, /\btelecom(munications)?\b/i, /\b5g\b/i, /\bmobile network\b/i],
  },
  {
    tag: 'consulting',
    patterns: [/\bconsulting\b/i, /\badvisory\b/i, /\bsystem integrator\b/i, /\bdigital transformation\b/i],
  },
  {
    tag: 'consumer',
    patterns: [/\bconsumer\b/i, /\bb2c\b/i, /\bcpg\b/i, /\bfood (delivery|brand)\b/i, /\bfashion\b/i],
  },
  {
    tag: 'enterprise-saas',
    patterns: [/\benterprise saas\b/i, /\benterprise platform\b/i, /\berp\b/i, /\bsap\b/i],
  },
  {
    tag: 'saas',
    patterns: [/\bsaas\b/i, /\bb2b platform\b/i, /\bworkflow automation\b/i, /\bcrm\b/i, /\bproductivity tools?\b/i],
  },
];

/** Supplemental company → industry overrides for companies not (yet) in companies.json/watchlist.json. */
const COMPANY_OVERRIDES: Record<string, IndustryTag> = {
  'chainlink labs': 'crypto',
  'chainlink': 'crypto',
  'bühler group': 'industrial',
  'bühler': 'industrial',
  'buhler group': 'industrial',
  'buhler': 'industrial',
  'jobgether': 'hrtech',
  'noir': 'fintech', // recruiter specialising in fintech/funds
  'snowflake': 'data',
  'datadog': 'devtools',
  'databricks': 'data',
  'mongodb': 'devtools',
  'cloudflare': 'infra',
  'github': 'devtools',
  'gitlab': 'devtools',
  'stripe': 'fintech',
  'wise': 'fintech',
  'klarna': 'fintech',
  'adyen': 'fintech',
  'doctolib': 'healthtech',
  'spotify': 'media',
  'openai': 'ai',
  'anthropic': 'ai',
  'cohere': 'ai',
  'mistral': 'ai',
  'hugging face': 'ai',
  'linear': 'devtools',
  'ramp': 'fintech',
  'vercel': 'devtools',
  'supabase': 'devtools',
  'deel': 'hrtech',
  'remote': 'hrtech',
  'personio': 'hrtech',
};

/**
 * LinkedIn returns canonical industry labels that don't always overlap with our
 * keyword vocabulary. Map them directly. Keys are lowercased for case-insensitive lookup.
 */
const LINKEDIN_INDUSTRY_MAP: Record<string, IndustryTag> = {
  'financial services': 'fintech',
  'banking': 'fintech',
  'investment banking': 'fintech',
  'capital markets': 'fintech',
  'insurance': 'insurtech',
  'hospital & health care': 'healthtech',
  'hospitals and health care': 'healthtech',
  'pharmaceuticals': 'healthtech',
  'medical devices': 'healthtech',
  'biotechnology': 'healthtech',
  'computer software': 'saas',
  'software development': 'saas',
  'information technology and services': 'saas',
  'it services and it consulting': 'consulting',
  'management consulting': 'consulting',
  'internet': 'saas',
  'computer & network security': 'security',
  'computer and network security': 'security',
  'artificial intelligence': 'ai',
  'machine learning': 'ai',
  'retail': 'ecommerce',
  'consumer goods': 'consumer',
  'food & beverages': 'consumer',
  'apparel & fashion': 'consumer',
  'transportation/trucking/railroad': 'logistics',
  'logistics and supply chain': 'logistics',
  'transportation, logistics, supply chain and storage': 'logistics',
  'automotive': 'automotive',
  'industrial automation': 'industrial',
  'mechanical or industrial engineering': 'industrial',
  'machinery manufacturing': 'industrial',
  'manufacturing': 'industrial',
  'oil & energy': 'climate',
  'renewables & environment': 'climate',
  'environmental services': 'climate',
  'telecommunications': 'telco',
  'wireless': 'telco',
  'broadcast media': 'media',
  'online media': 'media',
  'publishing': 'media',
  'marketing & advertising': 'media',
  'advertising services': 'media',
  'computer games': 'gaming',
  'computer & video games': 'gaming',
  'gambling & casinos': 'gaming',
  'higher education': 'gov',
  'education management': 'gov',
  'government administration': 'gov',
  'public policy': 'gov',
  'staffing & recruiting': 'hrtech',
  'human resources': 'hrtech',
  'leisure, travel & tourism': 'travel',
  'airlines/aviation': 'travel',
  'hospitality': 'travel',
  'cryptocurrency': 'crypto',
  'blockchain services': 'crypto',
};

/** Map tag → short display label (≤12 chars). */
const DISPLAY_LABELS: Record<string, string> = {
  ai: 'AI/ML',
  automotive: 'Automotive',
  cloud: 'Cloud',
  climate: 'Climate',
  consulting: 'Consulting',
  consumer: 'Consumer',
  crypto: 'Crypto/Web3',
  data: 'Data',
  devtools: 'DevTools',
  ecommerce: 'E-commerce',
  enterprise: 'Enterprise',
  'enterprise-saas': 'Ent. SaaS',
  fintech: 'Fintech',
  gaming: 'Gaming',
  gov: 'Gov/Edu',
  healthtech: 'Health',
  hrtech: 'HR Tech',
  industrial: 'Industrial',
  infra: 'Infra',
  insurtech: 'Insurtech',
  iot: 'IoT',
  logistics: 'Logistics',
  marketplace: 'Marketplace',
  media: 'Media',
  regtech: 'RegTech',
  saas: 'SaaS',
  security: 'Security',
  telco: 'Telco',
  travel: 'Travel',
};

export function displayIndustry(tag: IndustryTag | null): string {
  if (!tag) return '—';
  return DISPLAY_LABELS[tag] ?? tag.charAt(0).toUpperCase() + tag.slice(1);
}

/**
 * Score every industry tag against a text blob.
 * Returns the tag with the highest match count, or null if nothing matched.
 */
function topTagByMatches(text: string): IndustryTag | null {
  if (!text) return null;
  let bestTag: IndustryTag | null = null;
  let bestScore = 0;
  for (const rule of INDUSTRY_RULES) {
    let score = 0;
    for (const pat of rule.patterns) if (pat.test(text)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      bestTag = rule.tag;
    }
  }
  return bestTag;
}

/**
 * Title-weighted score: matches in title count 3×, matches in snippet 1×.
 * Picks the tag with the highest combined score. Returns null if nothing matched.
 */
export function inferRoleIndustry(job: Pick<Job, 'title' | 'descriptionSnippet'>): IndustryTag | null {
  const title = job.title ?? '';
  const snippet = job.descriptionSnippet ?? '';
  if (!title && !snippet) return null;

  let bestTag: IndustryTag | null = null;
  let bestScore = 0;
  for (const rule of INDUSTRY_RULES) {
    let score = 0;
    for (const pat of rule.patterns) {
      if (pat.test(title)) score += 3;
      if (pat.test(snippet)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestTag = rule.tag;
    }
  }
  return bestTag;
}

// ─── company lookup (cached) ─────────────────────────────────────────────
let companyLookupCache: Map<string, IndustryTag> | null = null;

function buildCompanyLookup(): Map<string, IndustryTag> {
  const map = new Map<string, IndustryTag>();
  // Watchlist takes priority — it has tier/note context tied to the user's targeting
  try {
    const wl = loadWatchlist();
    for (const c of wl.companies ?? []) {
      if (c.name && c.industry) map.set(c.name.toLowerCase(), c.industry);
    }
  } catch {
    /* file may be missing in a fresh setup — silent fallback */
  }
  try {
    const cs = loadCompanies();
    for (const platform of ['greenhouse', 'lever', 'ashby', 'workable'] as const) {
      for (const entry of cs[platform] ?? []) {
        if (entry.name && entry.industry && !map.has(entry.name.toLowerCase())) {
          map.set(entry.name.toLowerCase(), entry.industry);
        }
      }
    }
  } catch {
    /* same as above */
  }
  // Overrides win over both, since they target companies that aren't in either file yet
  for (const [name, tag] of Object.entries(COMPANY_OVERRIDES)) map.set(name, tag);
  return map;
}

function getCompanyLookup(): Map<string, IndustryTag> {
  if (!companyLookupCache) companyLookupCache = buildCompanyLookup();
  return companyLookupCache;
}

/** Reset the cache. Tests use this so they can construct an isolated lookup. */
export function _resetIndustryCache(): void {
  companyLookupCache = null;
}

/**
 * Resolve the company's industry through a cascade:
 *   1. lookup map (watchlist + companies.json + overrides)
 *   2. LinkedIn enrichment industries[0], mapped onto our taxonomy if possible
 *   3. keyword scan over the company name itself
 *   4. null
 */
export function inferCompanyIndustry(job: Job): IndustryTag | null {
  const company = (job.company ?? '').trim();
  if (!company) return null;

  const lookup = getCompanyLookup();
  const direct = lookup.get(company.toLowerCase());
  if (direct) return direct;

  const enriched = job.enrichment?.linkedin?.industries?.[0];
  if (enriched) {
    const fromMap = LINKEDIN_INDUSTRY_MAP[enriched.toLowerCase()];
    if (fromMap) return fromMap;
    const fromKeywords = topTagByMatches(enriched);
    if (fromKeywords) return fromKeywords;
  }

  return topTagByMatches(company);
}
