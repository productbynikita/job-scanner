# Install / Upgrade Guide

## Prerequisites

- **Node.js 22 LTS** — `nvm install 22 && nvm use 22`. Avoid Node 25.
- **C compiler** for `better-sqlite3`:
  - macOS: `xcode-select --install`
  - Linux: `sudo apt install build-essential python3`

## Fresh install

```bash
mkdir -p ~/projects && cd ~/projects
tar -xzf /path/to/job-scanner-node-phase4.tar.gz
cd job-scanner

npm install
npm run init:db

# Set up Apify (free tier — see below)
cp .env.example .env
# Open .env and paste your APIFY_TOKEN

npm run scan:full
```

## Apify setup (~3 minutes)

LinkedIn scanning needs a free Apify account.

1. Go to **https://apify.com** and click **Sign up free**. Email is enough.
2. After signup, go to **Console → Settings → Integrations**.
3. Copy your **Personal API token**.
4. In your project's `.env` file:
   ```
   APIFY_TOKEN=apify_api_XXXXXXXXXXXX
   APIFY_MONTHLY_BUDGET_USD=5
   ```

The free tier gives you ~$5/month in compute credits. The free LinkedIn
actor `worldunboxer/rapid-linkedin-scraper` is generous with that budget —
daily scans returning 50-100 jobs comfortably stay free.

**Verify it works:**

```bash
npm run scan:linkedin
```

You should see log lines like `[linkedin:DE/senior-product-manager] searching ...`
followed by `[linkedin] collector complete totalKept=N`.

## Upgrading from Phase 3

Your DB and configs are preserved:

```bash
cd ~/projects/job-scanner

# Backup just in case
cp -r data ~/job-scanner-data-backup-$(date +%F)

# Extract Phase 4 over the top — does NOT touch data/ or .env
cd ..
tar -xzf /path/to/job-scanner-node-phase4.tar.gz

cd job-scanner
npm install        # picks up apify-client + dotenv
cp .env.example .env  # only if you don't have .env yet
# Edit .env with your APIFY_TOKEN

npm run scan:linkedin
```

A **schema migration** runs automatically — your existing `jobs` table
gets a new `enrichment TEXT` column (default `'{}'`). All existing data
stays intact.

## Daily workflow

```bash
# Once per day — fast comprehensive scan
npm run scan:full

# See what's new
npm run show:new

# Look at a single job in detail
npm run show:job -- abc12345

# If you like it, enrich for applicant count + full description
npm run enrich -- abc12345
# Shows cost, asks for confirmation
```

## Where do I find the apply URL?

`show:top` and `show:new` now include a **URL column** with the direct
link. Click or paste into your browser to apply.

## Cost transparency

After any Apify call, you can check your monthly spend:

```bash
cat data/.apify-usage.json
```

Or, since every `enrich` call ends with a summary line:
```
Month total:  $0.012 of $5.00
```

If you ever hit your budget, the scanner refuses paid calls until next
month. Adjust `APIFY_MONTHLY_BUDGET_USD` in `.env` if you want a different
ceiling.

## Troubleshooting

### "APIFY_TOKEN not set"

`cp .env.example .env`, then paste your token. Confirm with `cat .env`.
The file must be in the project root.

### "BudgetExceededError"

Either you've hit your `APIFY_MONTHLY_BUDGET_USD` cap, or your expected
batch size × per-item cost would push you over. Raise the budget in `.env`
or reduce the batch.

### LinkedIn actor returns 0 jobs

Check `LOG_LEVEL=debug npm run scan:linkedin` for clues. Most common
causes: (a) the actor needs a paid plan when running too many queries
in a short window; (b) the location string isn't recognized — try
exact city names ("Berlin", "Amsterdam").

### Recent jobs missing from show:new

`show:new` filters to `status='new'`, which is set during the current
scan. After the next scan, those jobs move to `status='active'`. Use
`show:top` to see all jobs sorted by score regardless of status.

### "better-sqlite3 install fails — climits not found"

You're on Node 25 (current). Switch to Node 22 LTS:
```bash
nvm install 22 && nvm use 22
rm -rf node_modules package-lock.json
npm install
```

## What's next

Phase 5 adds recruiting agencies (Robert Walters, Michael Page, Hays,
etc.) which mostly reuse the Phase 3 JSON-LD infrastructure — should
be cheap to add.
