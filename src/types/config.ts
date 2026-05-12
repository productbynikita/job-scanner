/**
 * Types for input configuration files.
 * These mirror the JSON files in data/inputs/.
 */

export interface Preferences {
  geographies: {
    primary: Array<{
      country: string;
      name: string;
      cities: string[];
    }>;
    remote: {
      enabled: boolean;
      definition: string;
      excludeUsOnly: boolean;
    };
  };
  language: {
    required: string;
    exceptionTag: string;
    exceptionThresholdScore: number;
    note: string;
  };
  workAuthorization: {
    status: string;
    portableWithinEuAfterMonths: number;
    switzerlandRequiresSeparatePermit: boolean;
    highlightVisaSponsorship: boolean;
  };
  exclusions: {
    companies: string[];
    industries: string[];
    minCompanySize: number | null;
    maxCompanySize: number | null;
  };
  salary: {
    currencyPreferences: string[];
    minimumAnnualEur: number | null;
    showSalaryWhenAvailable: boolean;
  };
  freshness: {
    maxAgeDays: number;
    preferredAgeDays: number;
    urgencyThresholdsDays: {
      applyNow: number;
      fresh: number;
      open: number;
      aging: number;
      stale: number;
    };
  };
  scanBehavior: {
    defaultMode: string;
    maxResultsPerSource: number;
    skipIfNoResultsCount: number;
  };
}

export interface Roles {
  targetTitles: {
    exactMatch: string[];
    strongMatch: string[];
    weakMatch: string[];
    exclude: string[];
  };
  seniorityKeywords: {
    senior: string[];
    junior: string[];
    executive: string[];
  };
  domainStrengths: {
    primary: string[];
    secondary: string[];
    tertiary: string[];
    generalTech: string[];
  };
  industries: {
    preferred: string[];
    neutral: string[];
    avoid: string[];
  };
  scoringRules: {
    roleTitleMatch: { exactMatch: number; strongMatch: number; weakMatch: number; noMatch: number };
    domainFit: {
      primaryKeywordHit: number;
      secondaryKeywordHit: number;
      tertiaryKeywordHit: number;
      generalTechHit: number;
      noTechSignal: number;
    };
    language: {
      englishPrimary: number;
      englishAcceptable: number;
      germanB1Acceptable: number;
      languageRiskPerfectFit: number;
      nonEnglishRequired: number;
    };
    location: { targetCountry: number; remoteEu: number; otherEu: number; nonEu: number };
    seniority: {
      seniorIc: number;
      leadPrincipalIc: number;
      midLevel: number;
      juniorOrExecutive: number;
    };
    recency: {
      under24Hours: number;
      d1to3: number;
      d4to7: number;
      d8to14: number;
      d15to30: number;
      over30Days: number;
    };
    bonusSignals: {
      visaSponsorship: number;
      fhirOrHl7: number;
      sapBtp: number;
      remoteOrHybrid: number;
      healthtechOrFintech: number;
      sapCxOrCrm?: number;
      aiOrLlmProduct?: number;
      s4hana?: number;
      developerExperience?: number;
    };
  };
}

export interface AgencyEntry {
  id: string;
  name: string;
  tier: string;
  country?: string;
  specialty: string;
  searchUrls: Record<string, string>;
  registered: boolean;
  registrationUrl: string;
  contact: string | null;
  notes: string;
}

export interface Agencies {
  agencies: AgencyEntry[];
}

export interface CompanyEntry {
  slug: string;
  name: string;
  country: string;
  industry?: string;
}

export type AtsPlatform = 'greenhouse' | 'lever' | 'ashby' | 'workable';

export interface Companies {
  greenhouse: CompanyEntry[];
  lever: CompanyEntry[];
  ashby: CompanyEntry[];
  workable: CompanyEntry[];
}

export interface CountrySourceEntry {
  name: string;
  country: string;
  parser: 'jsonld' | 'nextdata' | 'eures';
  rateLimitMs: number;
  urls: string[];
}

export type CountrySources = Record<string, CountrySourceEntry>;
