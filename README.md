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

| Command | What it does |
|---------|-------------|
| `npm run scan` | Default scan (currently `quick`) |
| `npm run scan:quick` | RemoteOK + WeWorkRemotely (no Apify needed) |
| `npm run scan:full` | ATS + country + remote + LinkedIn — comprehensive |
| `npm run scan:ats` | ATS only — Greenhouse/Lever/Ashby/Workable |
| `npm run scan:country` | Country leaders only |
| `npm run scan:linkedin` | LinkedIn only |
| `npm run scan:remote` | Remote-only sources |
| `npm run scan -- --country DE` | Filter to Germany |
| `npm run scan -- --mode full --verbose` | Debug logging |
| `npm run show:top` | Top 10 jobs by score (with URL) |
| `npm run show:new` | Jobs added since last scan (with URL) |
| `npm run show:job -- abc12345` | Full detail for one job |
| `npm run show:stats` | Scan history + per-source performance |
| `npm run show:summary` | Latest scan summary |
| `npm run compare -- <id1> <id2>` | Side-by-side comparison |
| `npm run where:best` | Which sources surface the best jobs |
| `npm run enrich -- <id>` | LinkedIn enrichment (costs ~$0.006) |
| `npm run enrich -- <id> -y` | Same, skip confirmation prompt |
| `npm test` | Run unit tests |

Job IDs are SHA-1 hashes truncated to 16 chars. You can use the first 8
chars in any `compare`, `enrich`, or `show:job` command — the scanner
matches by prefix and warns on ambiguity.

## Where to find the apply URL

`show:top` and `show:new` both include a `URL` column with the direct link
to the job posting (Apply page on LinkedIn, Greenhouse, etc.). For LinkedIn,
this is the public job URL — you'll need to sign in to actually apply.

## Career-ops integration

Every job record has a `career_ops` JSON column reserved for the future
career-ops module. Untouched by the scanner after creation.
