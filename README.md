# Bug Hunt Tracker

A low-friction personal bug bounty tracker as a Chrome MV3 extension.

Press **START**, hunt, press **STOP**. Everything else — daily totals, weekly
and monthly rollups, `$`/focused hour, hours per finding, time-to-triage — is
derived from that raw data automatically. No backend, no account, no cloud:
all data lives in this browser profile's IndexedDB.

```
BUG HUNT TRACKER              HUNTING                Session saved ✓
Program  [ Walmart   ▼ ]      01:42:31               1h 42m
Activity [ Hunt      ▼ ]      Walmart · Hunt         September 6
                                                     [ START AGAIN ]
        START                     STOP
```

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `bug-hunt-tracker/` directory (the one containing `manifest.json`)
5. Pin the extension so the toolbar icon — and the running-timer badge — stays visible

There is no build step. The source is plain ES modules; what you load is what runs.

## Daily use

| Action | Where |
| --- | --- |
| Start / stop a session | Popup (`Space` also toggles it) |
| Add a program | Popup `+` next to the program picker, or Programs page |
| Log a finding | Popup **+ Finding** — title only is enough |
| Update a status or bounty | Dashboard → Findings → click the finding |
| See today's sessions | Dashboard → Day |
| Analytics | Dashboard |
| Backups | Dashboard → Data |

The toolbar badge shows elapsed time while a session runs, so you can tell at a
glance whether the clock is going.

## What it records

Three raw entities and one audit trail. Every metric is derived from them at
read time — nothing aggregated is ever stored, so a fix to an aggregation is a
code change, not a migration.

| Entity | Fields |
| --- | --- |
| `Program` | `id, name, url, platform, active, notes, createdAt, updatedAt` |
| `Session` | `id, programId, activity, startTime, endTime, durationMs, date, note, createdAt` |
| `Finding` | `id, ref, title, type, programId, severity, status, bounty, currency, notes, url, createdAt, updatedAt, statusTimestamps, paidAt` |
| `FindingHistory` | `id, findingId, timestamp, field, oldValue, newValue` |
| `Settings` | `defaultCurrency, weekStartsOn, activities[], minSessionMs` |

`statusTimestamps` records the first time a finding entered each status. That
single denormalised field is what makes time-to-report, time-to-triage,
time-to-payment and program response time computable without replaying history.

### Rules the data model enforces

- **Elapsed time is never counted in memory.** It is always `now - startTime`
  read from the persisted timer, which is why the clock survives closing the
  popup, Chrome suspending the service worker, and a machine reboot.
- **A session belongs to the local day it started on**, even if it crosses midnight.
- **Paid bounty means paid.** A finding contributes to revenue only at status
  `paid`, and only in the period it was paid in. Hoped-for numbers on a
  `reported` finding are worth nothing until the program pays.
- **A program that anything references cannot be deleted**, only deactivated —
  otherwise old sessions would lose their label and past analytics would change.
- **Mis-taps are discarded.** Sessions under the minimum length (default 30s)
  are dropped rather than inflating the session count.

## Metrics

Headline, per period (Today / Week / Month / Quarter / All Time):

`Focused Time` · `Sessions` · `Findings` · `Reports` · `Paid Findings` ·
`Paid Bounty` · `$/Focused Hour` · `Hours/Finding`

Breakdowns: time by activity, time by program, findings by type, findings by
severity, bounty by program, bounty by type, finding pipeline by status.

Time series: daily focused hours, findings over time, bounty over time (by
payment date), monthly rollup table.

Lifecycle: discovery → report, report → triage, triage → payment,
discovery → paid, and per-program response time.

## Backups

`Data` page → **Export JSON** is a lossless full backup that imports back
exactly. CSV exports (sessions, findings, history, programs, daily rollup) are
for spreadsheets and for feeding a report generator later.

Import **replaces** all local data rather than merging — merging two histories
would duplicate sessions and quietly corrupt every time-based metric.

> This data exists in one browser profile. Clearing site data or losing the
> profile loses the history. Export regularly.

## Tests

```bash
npm test                       # pure aggregation logic (Node, no browser)
npm install && npm run test:e2e  # loads the real extension in Chromium and drives the UI
```

`npm test` needs nothing installed. The E2E suite needs Playwright
(`npm install`), which is the only dev dependency — the extension itself ships
with zero runtime dependencies.

The E2E suite covers the workflows that matter: starting and stopping,
several sessions per day, sessions across days, the timer surviving a popup
close **and** a full browser restart, program reuse, finding creation, status
and bounty changes with history, dashboard aggregation, and export/import
round-tripping.

## Layout

```
manifest.json                 MV3 manifest
src/lib/time.js               local-date and duration helpers
src/lib/models.js             entity factories, statuses, severities
src/lib/db.js                 IndexedDB access + transactional writes
src/lib/store.js              chrome.storage: running timer, last-used picks
src/lib/repo.js               domain operations (the UI's only data API)
src/lib/analytics.js          pure aggregation engine
src/lib/backup.js             JSON/CSV export, JSON import
src/background/service-worker.js   badge only; not the timekeeper
src/popup/                    the START/STOP hot path
src/app/                      dashboard, day, findings, programs, data
```

## Limitations (V1)

- Single browser profile; no sync between machines (export/import is the bridge).
- One currency total at a time — findings store a currency each, but the
  dashboard sums in the default currency without conversion rates.
- No idle detection: if you forget to press STOP, the session runs until you do.
