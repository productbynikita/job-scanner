/**
 * Core types for job records.
 *
 * The Job interface mirrors the schema we designed in the Skill — every
 * field maps to a SQLite column. The `careerOps` field is reserved for
 * the future career-ops module and is never touched by the scanner after
 * initial creation.
 */

export type CountryCode = 'DE' | 'NL' | 'CH' | 'BE' | 'remote' | (string & {});

export type JobStatus = 'new' | 'active' | 'not_in_latest_scan' | 'archived';

export type Language = 'en' | 'de' | 'nl' | 'fr' | 'unknown';

export type RemoteMode = '' | 'remote' | 'hybrid' | 'onsite';

export interface ScoreBreakdown {
  roleTitle: number;
  domainFit: number;
  language: number;
  location: number;
  seniority: number;
  recency: number;
  bonus: number;
}

/** Initial triage decision after reviewing a job. */
export type Decision = 'applied' | 'passed' | 'shortlist' | 'watch';

/** Application progress stage. Only relevant when decision='applied'. */
export type Stage =
  | 'applied'
  | 'screening'
  | 'interview'
  | 'onsite'
  | 'offer'
  | 'rejected'
  | 'declined'
  | 'ghosted';

/** Career-ops handoff namespace. Scanner creates empty, never modifies after. */
export interface CareerOps {
  decision?: Decision;
  stage?: Stage;
  decisionDate?: string;
  appliedDate?: string;
  stageUpdatedAt?: string;
  followUpDue?: string;
  notes?: string;
  contact?: {
    name?: string;
    email?: string;
    channel?: string;
  };
  // Loose typing on purpose — career-ops module owns the shape.
  [key: string]: unknown;
}

/**
 * Optional per-source enrichment data. Populated by `npm run enrich`.
 * Currently only LinkedIn fills this in, via the paid Apify actor.
 */
export interface JobEnrichment {
  linkedin?: {
    applicantCount?: number | null;
    fullDescription?: string;
    seniorityLevel?: string;
    employmentType?: string;
    jobFunctions?: string[];
    industries?: string[];
    skills?: string[];
    easyApply?: boolean;
    salary?: string;
    posterName?: string;
    posterUrl?: string;
    similarJobs?: Array<{ title: string; company: string; url: string }>;
    fetchedAt: string;
    actor: string;
    costEstimateUsd: number;
  };
}

/** A single normalized job posting. */
export interface Job {
  id: string;
  title: string;
  company: string;
  location: string;
  country: CountryCode;
  remote: RemoteMode;
  url: string;
  descriptionSnippet: string;
  language: Language;
  hardLanguageRequirement?: string;
  salary: string | null;
  postedDate: string | null;
  sources: string[];
  firstSeen: string;
  lastSeen: string;
  scanCount: number;
  score: number;
  scoreBreakdown: ScoreBreakdown;
  scoreReasons: string[];
  languageRisk: boolean;
  status: JobStatus;
  isAgency: boolean;
  careerOps: CareerOps;
  enrichment?: JobEnrichment;
}

/** Raw job from a collector before scoring/dedup. */
export type RawJob = Omit<
  Job,
  | 'id'
  | 'firstSeen'
  | 'lastSeen'
  | 'scanCount'
  | 'score'
  | 'scoreBreakdown'
  | 'scoreReasons'
  | 'languageRisk'
  | 'status'
  | 'careerOps'
  | 'language'
  | 'sources'
> & {
  source: string;
  sources?: string[];
  language?: Language;
};

/** Result returned by every collector. */
export interface CollectorResult {
  sourceId: string;
  jobsFound: number;
  errors: string[];
  durationMs: number;
  jobs: RawJob[];
  isAgency?: boolean;
}

/** Statistics from a scan run. */
export interface ScanStats {
  rawCount: number;
  afterCountryFilter: number;
  afterDedupe: number;
  afterLanguageFilter: number;
  languageDropped: number;
  scored: number;
  highFit: number;
  mediumFit: number;
  lowFit: number;
  languageRisk: number;
  newSinceLast: number;
  updated: number;
  /** Jobs found per country code (DE/NL/CH/BE/remote/other). */
  countryBreakdown: Record<string, number>;
}
