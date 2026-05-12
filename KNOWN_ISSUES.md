# Known Issues & Fixes Log

Tracks bugs discovered during development, their root causes, and the fixes applied.

| # | Date | Severity | Component | Title | Root Cause | Fix | Status |
|---|------|----------|-----------|-------|------------|-----|--------|
| 1 | 2026-05-12 | 🔴 Critical | `collectors/linkedin.ts` | All 1,982 LinkedIn jobs dropped | Wrong field mapping (`item.title` instead of `item.job_title`) AND wrong actor input (`keyword`/`"Germany"` instead of `job_title`/`"DE"`) — every item failed validation | Updated `LinkedInActorJob` interface with correct field names; fixed actor input schema | ✅ Fixed |
| 2 | 2026-05-12 | 🟡 Medium | `processors/score.ts` | `HIS` keyword matches "this" in every description | `containsAny()` does plain substring matching, so `"HIS"` hit the `his` in "this", "analysis", "sophisticated", etc., giving false healthcare domain scores | Removed bare `"HIS"` from secondary keywords; added `"hospital information system"` (full phrase); added `re:\bHIS\b` (word-boundary regex) via new `re:` prefix support in `containsAny()` | ✅ Fixed |
| 3 | 2026-05-12 | 🟡 Medium | `cli/replay-datasets.ts` | Relative posted dates shifted by replay lag | `parsePostedDate()` resolved relative strings like "23 hours ago" against `new Date()` (today) instead of the actor run date — a job posted "23 hours ago" on April 29 was timestamped May 11 when replayed on May 12 | Added optional `referenceDate: Date` param to `parsePostedDate()`; replay loop now passes `new Date(run.startedAt)` as the reference | ✅ Fixed |
| 4 | 2026-05-12 | 🟠 Low | `processors/score.ts` | Recency weight too low — stale jobs ranked alongside fresh ones | `recency` weight was 5/100; `over_30_days` also gave 2 points, meaning a month-old posting was virtually indistinguishable from a 3-day-old one | Increased `recency` weight to 15; new scale: `<24h`→15, `1-3d`→12, `4-7d`→8, `8-14d`→3, `15-30d`→1, `>30d`→0 | ✅ Fixed |
| 5 | 2026-05-12 | 🟠 Low | `cli/queries.ts` | Physical PM roles (deSter, packaging) ranking in top 10 | These jobs had non-tech titles but scored domain:20 via the false `HIS→"this"` hit (Issue 2) | Fixed by Issue 2 fix above; added `--min-domain <n>` CLI flag to `show top` to filter by minimum domain score | ✅ Fixed |
| 6 | 2026-05-12 | 🟠 Low | `data/inputs/roles.json` | `generalTech` too narrow — real tech PM roles (logistics SaaS, e-commerce, fintech) not surfacing | Only 8 keywords, none covering SaaS verticals | Expanded to 31 keywords: added `digital product`, `AI-powered`, `machine learning`, `automation platform`, `API`, `ERP`, `e-commerce`, `marketplace`, `payments platform`, `fintech`, `data platform`, `IoT`, etc. | ✅ Fixed |

## Fix Legend

| Icon | Meaning |
|------|---------|
| 🔴 Critical | Data loss / zero results |
| 🟡 Medium | Incorrect scores / misleading output |
| 🟠 Low | Sub-optimal ranking / cosmetic |
| ✅ Fixed | Deployed to main |
| 🔧 In Progress | Fix in development |
| 🔵 Known | Acknowledged, not yet fixed |
