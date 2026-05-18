# Job Scanner — Command Reference

## Scanning

| Command | What it does |
|---------|-------------|
| `npm run scan` | Quick scan (default mode) |
| `npm run scan:quick` | Quick scan — fastest, fewest sources |
| `npm run scan:full` | Full scan — all sources |
| `npm run scan:ats` | ATS portals only (Greenhouse, Ashby, Lever, Workable) |
| `npm run scan:country` | Country-specific boards |
| `npm run scan:remote` | Remote-only sources |
| `npm run scan:linkedin` | LinkedIn only (costs Apify credits) |
| `npm run scan:agencies` | Recruiting agencies only |
| `npm run scan:watchlist` | Watchlist companies only |
| `npm run scan:debug` | Full scan with debug logging |

**Scan flags** (use with `tsx src/cli/index.ts scan`):

| Flag | Description |
|------|-------------|
| `-m, --mode <mode>` | `quick\|full\|remote\|ats\|country\|deep\|linkedin\|glassdoor\|agencies\|watchlist` |
| `-c, --country <code>` | Filter to one country: `DE\|NL\|CH\|BE\|remote` |
| `--max-per-source <n>` | Cap results per source |
| `-v, --verbose` | Debug logging |
| `--trace` | Trace logging (very verbose, logs every HTTP call) |
| `-q, --quiet` | Warnings and errors only |

---

## Viewing Results

| Command | What it does |
|---------|-------------|
| `npm run show:top` | Top jobs by score (excludes applied/passed) |
| `npm run show:new` | Jobs added since last scan |
| `npm run show:stats` | Scan history + per-source performance |
| `npm run show:summary` | Summary of the latest scan |
| `npm run show:watchlist` | Watchlist companies + coverage report |
| `npm run show:tracker` | Application tracker (applied jobs by stage) |
| `npm run show:open` | Open results in browser |
| `npm run show:job` | Full details for one job |

**`show top` flags** (use with `tsx src/cli/index.ts show top`):

| Flag | Description |
|------|-------------|
| `[n]` | Number of results to show |
| `--include-agency` | Include agency jobs |
| `--min-domain <n>` | Minimum domain fit score (0–25) |
| `--min-score <n>` | Minimum total score (default 70) |
| `--posted <days>` | Only postings ≤ N days old |
| `--scanned <days>` | Only jobs scanned within last N days |
| `--all` | Include applied + passed |
| `--compact` | One line per job (table view) |

---

## Tagging Jobs

```bash
npm run mark -- <jobId> <value>
```

**Triage values:** `applied` · `passed` · `shortlist` · `watch`

**Stage values** (auto-marks as applied): `screening` · `interview` · `onsite` · `offer` · `rejected` · `declined` · `ghosted`

| Flag | Description |
|------|-------------|
| `--note <text>` | Attach a note |

`jobId` can be a prefix — the scanner resolves it to the full ID.

---

## Comparing Jobs

```bash
npm run compare -- <id1> <id2>
```

Side-by-side comparison of two jobs.

---

## AI Commands (cost per call)

| Command | What it does | Cost |
|---------|-------------|------|
| `npm run assess -- <jobId>` | Deep fit analysis against your CV | ~$0.11 |
| `npm run tailor-cv -- <jobId>` | Tailored CV bullet points for the role | ~$0.21 |
| `npm run cover -- <jobId>` | Cover letter draft | ~$0.09 |

All AI commands prompt for cost confirmation. Add `-y` / `--yes` to skip.
Override the model with `--model <name>` (default: `claude-opus-4-5`).

---

## Enrichment

```bash
npm run enrich -- <jobId>
```

Fetches LinkedIn details (applicant count, full description, skills) for a job. Costs ~$0.006/job. Add `-y` to skip confirmation.

---

## Analytics

| Command | What it does |
|---------|-------------|
| `npm run where:best` | Which sources surface the highest-scored jobs |
| `npm run rescore` | Re-score all jobs against your current profile |
| `npm run replay` | Replay saved Apify datasets (no API cost) |

---

## Agencies

| Command | What it does |
|---------|-------------|
| `npm run agencies:list` | List all configured agencies + registration status |
| `npm run agencies:register -- <id>` | Mark an agency as registered |

`agencies:register` flags: `--contact <name>` to record recruiter name.

---

## Database

| Command | What it does |
|---------|-------------|
| `npm run init:db` | Initialise the SQLite database |

---

## Development

| Command | What it does |
|---------|-------------|
| `npm run build` | Compile TypeScript |
| `npm test` | Run test suite |
| `npm run test:watch` | Run tests in watch mode |
| `npm run lint` | Lint source files |
| `npm run format` | Format source files with Prettier |
