# Phases

## ✅ Phase 1 — Foundation

TypeScript + Node 20+, SQLite via `better-sqlite3`. Types, schema + DB layer,
config loader, processors (dedupe / language / score), collector framework,
RemoteOK + WeWorkRemotely collectors, CLI, 16 tests.

## ✅ Phase 2 — ATS API collectors + structured logging

- `greenhouse.ts`, `lever.ts`, `ashby.ts`, `workable.ts`
- `data/inputs/companies.json` (36 EU companies)
- `atsHelpers.isProductRole`
- Logger with 5 levels + scoping + timers + banners
- 20 tests passing.

## ✅ Phase 3 — Country leaders via cheerio

- Generic `htmlParsers.ts` (JSON-LD extractor, `@graph` flattening, trailing-comma recovery)
- Generic `countryLeader.ts` orchestrator with 3 parser strategies (jsonld / nextdata / eures)
- 6 thin-wrapper collectors: stepstoneDe/Be, jobsCh, nlVacaturebank, welcomeToJungle, eures
- `data/inputs/country_sources.json`
- Polite rate limiting (1500ms default)
- 31 tests passing.

## ✅ Phase 4 — LinkedIn via Apify + on-demand enrichment

**Free tier (daily scan):**
- [x] `linkedin.ts` — uses `worldunboxer/rapid-linkedin-scraper` (free)
- [x] Queries 4 PM titles × 5 EU locations = 20 actor calls per scan
- [x] Internal URL-based dedup within the collector run
- [x] Maps to RawJob with title, company, location, posted date, **URL**

**Paid enrichment (on-demand only):**
- [x] `linkedinEnrich.ts` — uses `piotrv1001/linkedin-job-details-scraper` ($0.006/job)
- [x] Returns applicant count, full description, skills, seniority, employment type,
      easy-apply flag, similar jobs
- [x] `npm run enrich -- <jobId>` CLI command with cost confirmation prompt
- [x] Skip-confirm flag (`-y`) for automation

**Infrastructure:**
- [x] `apify/client.ts` — thin wrapper around ApifyClient SDK
- [x] Cost tracking — every call logged to `data/.apify-usage.json` per month
- [x] Pre-flight budget guard — refuses paid calls when projected spend exceeds `APIFY_MONTHLY_BUDGET_USD`
- [x] `BudgetExceededError` with diagnostic fields
- [x] `.env` support via `dotenv`, `.env.example` template
- [x] Schema migration: `enrichment TEXT DEFAULT '{}'` JSON column on `jobs` table
- [x] `updateEnrichment()` merge helper (preserves career-ops handshake separation)

**CLI / UX:**
- [x] **URL column** in `show:top` and `show:new` tables
- [x] **ID column** with 8-char prefix for use in compare/enrich commands
- [x] `show:job <id>` command — full detail incl. score breakdown + enrichment data
- [x] `scan:linkedin` mode + `npm run scan:linkedin` script
- [x] `enrich` subcommand wired into commander

**Tests:** 37 passing (6 new for apify client budget logic).

## ⏳ Phase 5 — Recruiting agencies

Most agency websites publish public JSON-LD on their listings pages and can
reuse the Phase 3 `htmlParsers.ts` + `countryLeader.ts` infrastructure.

- [ ] Generic agency collector (mostly a thin wrapper over countryLeader)
- [ ] Per-agency URL templates + per-agency override hooks
- [ ] Agency results go to `is_agency=1` in same DB (already supported by schema)
- [ ] CLI: `agencies list`, `agencies register <id>`, `scan agencies`
- [ ] 12 agencies in `data/inputs/agencies.json` already configured

## ⏳ Phase 6 — Optional AI integration

- [ ] `@anthropic-ai/sdk` dependency
- [ ] `npm run assess -- <id>` — deep job analysis using `cv.md`
- [ ] `npm run tailor-cv -- <id>`
- [ ] `npm run cover -- <id>`
- [ ] Per-call cost estimate before sending

## ⏳ Phase 7 — Notifications + analytics

- [ ] Telegram notifier for high-fit new jobs
- [ ] Email digest
- [ ] CSV/JSON export
