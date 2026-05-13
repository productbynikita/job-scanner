# Job Scanner

Standalone Node.js scanner for Senior PM / Technical PM / Product Owner roles
across Germany, Netherlands, Switzerland, Belgium, and remote-EU.

**Zero AI tokens for daily scans.** AI is optional and only used when you
explicitly ask for analysis (Phase 6+).

## Status

- ✅ **Phase 1:** Foundation — SQLite, scoring/dedupe/language pipeline, CLI, RemoteOK + WeWorkRemotely.
- ✅ **Phase 2:** ATS API collectors (Greenhouse, Lever, Ashby, Workable) + structured logger.
- ✅ **Phase 3:** Country leaders — StepStone DE/BE, jobs.ch, NL Vacaturebank, Welcome to the Jungle, EURES.
- ✅ **Phase 4 (this build):** LinkedIn via Apify free actor + on-demand enrichment for shortlisted jobs. URL column now in `show:top` / `show:new`. New `show:job <id>` command for full job detail.
- ⏳ **Phase 5:** Recruiting agencies.
- ⏳ **Phase 6:** Optional Anthropic SDK for `assess`, `compare`, `tailor cv`.

## Quick start

```bash
# 1. Install (one-time)
npm install
npm run init:db

# 2. Set up Apify (for LinkedIn — free tier is enough)
cp .env.example .env
# Edit .env and paste your APIFY_TOKEN (https://console.apify.com/account/integrations)

# 3. Run a scan
npm run scan:full           # ATS + country + remote + LinkedIn
npm run scan:linkedin       # LinkedIn only — quick test of Apify setup
npm run scan:quick          # remote sources only — no Apify needed

# 4. See results — URLs are now in the table
npm run show:top
npm run show:new

# 5. Inspect a single job
npm run show:job -- abc12345

# 6. Enrich a LinkedIn job with applicant count + full description ($0.006/job)
npm run enrich -- abc12345
```

## LinkedIn — how it works

**Two-tier architecture for $0/low cost:**

| Tier | When | Actor | Cost |
|---|---|---|---|
| **Daily scan** | Every `scan:linkedin` / `scan:full` | `worldunboxer/rapid-linkedin-scraper` (free) | $0 + Apify free credit |
| **Enrichment** | Manual `npm run enrich -- <id>` per job | `piotrv1001/linkedin-job-details-scraper` (paid) | ~$0.006/job |

Daily scans return: title, company, location, posted date, **URL to apply**.
Enrichment adds: applicant count, full description, skills, seniority,
employment type, easy-apply flag, similar jobs.

**Why not enrich every job automatically?** Cost.
At $0.006 × ~100 jobs/scan × 30 scans/month = $18/month. The enrichment
data is only useful for jobs you're actually considering applying to —
maybe 5–10 per week. Manual enrichment caps your monthly spend at well
under $1.

**Top applicant** (your specific ask): this is *not* available from any
public actor. LinkedIn computes "you're a top applicant" inside their UI
based on YOUR logged-in profile relative to the applicant pool — it
doesn't exist server-side. The closest substitute is applicant count +
posted date, both available via `enrich`.

## Budget protection

The Apify wrapper tracks every paid call in `data/.apify-usage.json` and
refuses to make new paid calls when monthly spend would exceed
`APIFY_MONTHLY_BUDGET_USD` (default $5 in `.env`). Free actors aren't
budget-counted but are still logged so you can audit.

Every `enrich` command shows current spend, the call's cost, and the
total after — and asks for explicit confirmation unless you pass `-y`.

## Project layout

```
job-scanner/
├── src/
│   ├── cli/                # Commander entrypoint, query/enrich commands
│   ├── collectors/         # One file per source — autonomous TS code
│   │   ├── base.ts             # Shared HTTP + helpers
│   │   ├── atsHelpers.ts       # PM-role title filter
│   │   ├── htmlParsers.ts      # JSON-LD extractor + cheerio utils
│   │   ├── countryLeader.ts    # Generic country-board collector
│   │   ├── greenhouse.ts       # ...
│   │   ├── linkedin.ts         # LinkedIn daily scan (free Apify actor)
│   │   ├── linkedinEnrich.ts   # On-demand LinkedIn enrichment (paid)
│   │   └── ...
│   ├── apify/              # Apify SDK wrapper with cost tracking
│   ├── processors/         # dedupe, score, language detection
│   ├── storage/            # SQLite schema + queries
│   ├── config/             # JSON config loader
│   ├── types/              # Shared TypeScript types
│   ├── logger.ts           # Leveled colored structured logger
│   └── scanner.ts          # Main orchestration
├── data/
│   ├── inputs/             # YOUR config — edit freely
│   ├── jobs.db             # SQLite DB (created on first scan)
│   └── .apify-usage.json   # Apify cost ledger (gitignored)
├── .env                    # APIFY_TOKEN — DO NOT commit
├── .env.example            # Template
└── tests/
```

## Commands

### Scanning

```bash
npm run scan:quick                        # RemoteOK + WeWorkRemotely — no Apify, ~5s
npm run scan:full                         # Everything: ATS + country + LinkedIn + remote
npm run scan:ats                          # ATS APIs only (Greenhouse/Lever/Ashby/Workable)
npm run scan:country                      # Country job boards only (StepStone, jobs.ch, etc.)
npm run scan:linkedin                     # LinkedIn only — fast test of Apify setup
npm run scan:remote                       # Remote sources only (no country boards)
npm run scan:watchlist                    # Only your watchlist companies

# Filters and logging
npm run scan -- --country DE              # Limit any mode to one country (DE/NL/CH/BE/remote)
npm run scan -- --mode full --country CH  # Full scan, Swiss jobs only
npm run scan -- --mode ats --verbose      # Debug logging — see every HTTP call
npm run scan -- --mode full --quiet       # Errors and warnings only
npm run scan -- --mode remote --max-per-source 10  # Cap results per source (default 25)
```

### Job lifecycle — three views

The DB holds every job ever scanned. Three views slice it:

| View | What it shows | When jobs leave |
|------|---------------|-----------------|
| **Pool** (`show:top`) | All scored jobs you might still apply to. Sorted by score, drawn from every scan. | When you `mark` it `applied` or `passed`. |
| **Tracker** (`show:tracker`) | Jobs you've applied to. Grouped by stage (applied → screening → interview → offer). | Never auto-leaves — terminal stages stay visible (rejected/declined). |
| **New** (`show:new`) | Jobs whose first sighting was the latest scan. | Resets to the next scan. |

Each entry shows score, title, company, country, **posting date + age**, **scan date**, status, URL.

```bash
# The pool — your default view
npm run show:top                              # All high-fit (≥70) jobs across every scan
npm run show:top -- 20                        # Top 20 by score
npm run show:top -- --min-score 80            # Custom score threshold
npm run show:top -- --posted 7                # Postings ≤ 7 days old
npm run show:top -- --posted 1                # Postings from today only
npm run show:top -- --scanned 1               # Jobs first seen in the last day
npm run show:top -- --posted 3 --min-score 75 # Fresh postings, high bar
npm run show:top -- --include-agency          # Add recruiting agency jobs
npm run show:top -- --min-domain 15           # Strong domain fit only (cuts non-tech noise)
npm run show:top -- --all                     # Include applied + passed (otherwise hidden)
npm run show:top -- 10 --posted 2 --include-agency --min-domain 12   # Multiple filters

# Other queries
npm run show:new                              # Jobs added in the latest scan only
npm run show:tracker                          # Your application tracker (see below)
npm run show:watchlist                        # Jobs from your target company list + coverage gaps
npm run show:job -- abc12345                  # Full detail for one job (8-char prefix is enough)
npm run show:stats                            # Scan history — 30 runs, per-source cumulative
npm run show:summary                          # Latest scan summary
npm run compare -- <id1> <id2>               # Side-by-side comparison of two jobs
npm run where:best                            # Analytics: which sources surface highest scores
```

### Marking decisions and tracking applications

The `mark` command does double duty:

**Triage** (initial decision after reviewing a job):
```bash
npm run mark -- abc12345 shortlist            # Saved for later — stays in show:top, labeled
npm run mark -- abc12345 watch                # Monitoring — stays in show:top, labeled
npm run mark -- abc12345 passed               # Pass — hidden from show:top
npm run mark -- abc12345 applied              # Applied — moves to tracker
npm run mark -- abc12345 applied --note "Referral via Maria"
```

**Stage tracking** (after you've applied — auto-marks decision=applied):
```bash
npm run mark -- abc12345 screening            # Recruiter screen scheduled
npm run mark -- abc12345 interview            # In interview loop
npm run mark -- abc12345 onsite               # Onsite/final round
npm run mark -- abc12345 offer                # Got an offer
npm run mark -- abc12345 rejected             # Rejected by company
npm run mark -- abc12345 declined             # You declined the offer
npm run mark -- abc12345 ghosted              # No response after follow-up
npm run mark -- abc12345 interview --note "Round 2 on Friday with VP Product"
```

**View the tracker:**
```bash
npm run show:tracker                          # Grouped by stage, with days-since-applied
```

The tracker groups in-flight stages first (offer → onsite → interview → screening → applied) and closed stages at the bottom (ghosted → rejected → declined). Re-marking a job updates the stage and timestamps `stageUpdatedAt`, but preserves the original `appliedDate`.

### Enrichment (LinkedIn detail — paid Apify actor)

```bash
npm run enrich -- abc12345               # Fetch applicant count, full JD, skills (~$0.006)
npm run enrich -- abc12345 -y            # Skip the cost confirmation prompt
npm run show:job -- abc12345             # View enriched data after fetching
```

Enrichment is worth running on the 3–5 jobs you're seriously considering:
applicant count tells you how competitive a role is, skills pinpoints gaps.

### AI commands (optional — costs Anthropic credits)

```bash
npm run assess -- abc12345               # Deep fit analysis against your CV (~$0.11)
npm run tailor-cv -- abc12345            # Tailored CV bullet points (~$0.21)
npm run cover -- abc12345                # Cover letter draft (~$0.09)

npm run assess -- abc12345 -y            # Skip cost confirmation
npm run assess -- abc12345 --model claude-haiku-4-5-20251001  # Cheaper model
```

### Agency management

```bash
npm run agencies:list                    # All configured agencies + registration status
tsx src/cli/index.ts agencies register robert_walters --contact "Anna Schmidt"
tsx src/cli/index.ts agencies unregister hays
```

### Utilities

```bash
npm run rescore                          # Re-score all jobs in DB with current scoring config
npm run replay                           # Replay saved Apify datasets (for testing)
npm test                                 # Run unit tests
npm run lint                             # ESLint
npm run format                           # Prettier
```

---

Job IDs are SHA-1 hashes truncated to 16 chars. The first 8 chars work in every
command — the scanner matches by prefix and warns on ambiguity.

## Where to find the apply URL

`show:top` and `show:new` both include a `URL` column with the direct link
to the job posting (Apply page on LinkedIn, Greenhouse, etc.). For LinkedIn,
this is the public job URL — you'll need to sign in to actually apply.

## Career-ops integration

Every job record has a `career_ops` JSON column reserved for the future
career-ops module. Untouched by the scanner after creation.
