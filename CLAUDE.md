# job-scanner

Standalone TypeScript/Node.js scanner for Senior PM / Technical PM / Product Owner roles
across DE, NL, CH, BE, and remote-EU. Zero AI tokens for daily scans; AI is opt-in for
`assess`, `tailor-cv`, and `cover` commands.

## Stack

- **Runtime:** Node 20+, ESM (`"type": "module"`)
- **Language:** TypeScript — strict, compiled with `tsc`, run with `tsx` in dev
- **DB:** SQLite via `better-sqlite3` — sync API, file at `data/jobs.db`
- **HTTP:** native `fetch` — no axios
- **HTML parsing:** cheerio + fast-xml-parser
- **CLI:** Commander
- **Apify:** `apify-client` SDK — wrapped in `src/apify/` with budget tracking
- **AI:** `@anthropic-ai/sdk` — only loaded when `assess`/`tailor-cv`/`cover` is called
- **Tests:** Vitest — run with `npm test`
- **Lint/format:** ESLint + Prettier

## Project layout

```
src/
  cli/           # Commander entrypoint (index.ts) + subcommand files
  collectors/    # One file per source — each exports a class extending BaseCollector
  apify/         # ApifyClient wrapper with per-month cost tracking
  processors/    # dedupe.ts, score.ts, language.ts — pure functions, no side effects
  storage/       # db.ts (query helpers), schema.ts (DDL), init.ts (one-shot setup)
  config/        # JSON config loader for companies.json, country_sources.json, etc.
  types/         # Shared TypeScript types (job.ts, config.ts)
  logger.ts      # Leveled colored structured logger — use this, not console.log
  scanner.ts     # Main orchestration — calls collectors, runs processors, persists

data/
  inputs/        # Config files the user edits (companies.json, country_sources.json, etc.)
  jobs.db        # SQLite DB — gitignored
  .apify-usage.json  # Cost ledger — gitignored

tests/           # Vitest unit tests — mirror src/ structure
```

## Architecture rules

- **Collectors are autonomous.** Each collector in `src/collectors/` handles its own HTTP,
  parsing, and rate limiting. They return `RawJob[]` — no DB access, no side effects.
- **Processors are pure.** `dedupe`, `score`, `language` take arrays and return arrays.
  No I/O, no globals.
- **Scanner orchestrates.** `scanner.ts` calls collectors, runs processors, writes to DB.
- **Storage is the only DB layer.** All SQL lives in `src/storage/db.ts` and `schema.ts`.
  Never write raw SQL elsewhere.
- **Logger everywhere.** Import from `src/logger.ts`. Never use `console.log` in src/.

## Adding a new collector

1. Create `src/collectors/{name}.ts` extending `BaseCollector` from `base.ts`.
2. Implement `collect(): Promise<RawJob[]>`.
3. Register it in `src/collectors/registry.ts` under the appropriate scan mode.
4. Add tests in `tests/collectors/{name}.test.ts`.

## Key config files (user-editable, don't overwrite)

| File | Purpose |
|------|---------|
| `data/inputs/companies.json` | ATS companies for Greenhouse/Lever/Ashby/Workable |
| `data/inputs/country_sources.json` | Country board sources |
| `.env` | `APIFY_TOKEN`, `APIFY_MONTHLY_BUDGET_USD` — never commit |

## Phases

| Phase | Status | What it added |
|-------|--------|---------------|
| 1 | ✅ | Foundation: SQLite, scoring, CLI, RemoteOK + WeWorkRemotely |
| 2 | ✅ | ATS APIs: Greenhouse, Lever, Ashby, Workable |
| 3 | ✅ | Country boards: StepStone DE/BE, jobs.ch, NL Vacaturebank, WTFJ, EURES |
| 4 | ✅ | LinkedIn via Apify (free scan + paid enrichment), URL column, `show:job` |
| 5 | ⏳ | Recruiting agencies |
| 6 | ⏳ | Anthropic AI: `assess`, `compare`, `tailor-cv` |

## Common commands

```bash
npm run scan:full          # Full scan — ATS + country + LinkedIn + remote
npm run scan:quick         # Remote only — no Apify, ~5s
npm run show:top           # High-fit jobs pool (≥70 score)
npm run show:new           # Jobs from latest scan only
npm run show:tracker       # Application tracker grouped by stage
npm run enrich -- <id>     # LinkedIn enrichment (~$0.006, asks for confirmation)
npm test                   # Vitest unit tests
npm run lint               # ESLint
```

## Budget protection

`src/apify/` tracks every paid Apify call in `data/.apify-usage.json` and throws
`BudgetExceededError` before making a call that would exceed `APIFY_MONTHLY_BUDGET_USD`.
Always check budget handling when adding new paid Apify actors.

## Job IDs

SHA-1 hashes truncated to 16 chars. First 8 chars are enough in any CLI command —
the DB queries by prefix and warns on ambiguity.

## Conventions

- No `console.log` — use `logger.ts`
- No raw SQL outside `src/storage/`
- No DB access in collectors or processors
- Collectors return `RawJob[]`, not `Job[]` — scoring/dedup happens in processors
- Tests live in `tests/` mirroring `src/` — add tests for every new collector
- `.env` is gitignored — update `.env.example` when adding new env vars
