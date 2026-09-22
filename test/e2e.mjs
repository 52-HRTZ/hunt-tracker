/**
 * End-to-end test: loads the real unpacked extension into Chromium and drives
 * the actual UI. Run with: npm run test:e2e
 *
 * Covers the workflows that pure unit tests cannot: the timer surviving a popup
 * close and a full browser restart, IndexedDB persistence, and the dashboard
 * rendering real aggregates.
 */

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';

const EXT = path.dirname(fileURLToPath(new URL('../manifest.json', import.meta.url)));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'bht-profile-'));

let passed = 0;
let failed = 0;
const results = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    results.push(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    const detail = err.message.split('\n').filter(Boolean).slice(0, 4).join(' | ');
    results.push(`  FAIL ${name}\n       ${detail}`);
  }
}

function dumpAndExit(code) {
  console.log(results.join('\n'));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(code);
}

// Without this, one unexpected throw would hide every result collected so far.
process.on('uncaughtException', (err) => {
  results.push(`  FATAL ${err.message.split('\n')[0]}`);
  dumpAndExit(1);
});
process.on('unhandledRejection', (err) => {
  results.push(`  FATAL ${String(err?.message ?? err).split('\n')[0]}`);
  dumpAndExit(1);
});

async function launch() {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const id = new URL(sw.url()).host;
  return { ctx, id };
}

/** Clear any lingering toast so the next assertion cannot read a stale one. */
async function clearToast(p) {
  await p.evaluate(() => {
    const t = document.getElementById('toast');
    if (t) { t.hidden = true; t.textContent = ''; }
  });
}

/** Wait for a toast matching `re`, and report what was actually shown if not. */
async function expectToast(p, re) {
  try {
    await p.waitForFunction(({ source, flags }) => {
      const t = document.getElementById('toast');
      return !!t && !t.hidden && new RegExp(source, flags).test(t.textContent);
    }, { source: re.source, flags: re.flags }, { timeout: 6000 });
  } catch {
    const seen = await p.textContent('#toast').catch(() => '(no toast element)');
    throw new Error(`expected a toast matching ${re}, saw: "${seen}"`);
  }
}

const popupUrl = (id) => `chrome-extension://${id}/src/popup/popup.html`;
const appUrl = (id, hash = '') => `chrome-extension://${id}/src/app/app.html${hash}`;

async function openPopup(ctx, id) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(popupUrl(id));
  await page.waitForSelector('#view-idle:not([hidden]), #view-running:not([hidden])');
  page.__errors = errors;
  return page;
}

/* -------------------------------------------------------------------------- */

let session = await launch();
console.log(`extension id: ${session.id}\n`);

let page = await openPopup(session.ctx, session.id);

/* 1. Programs -------------------------------------------------------------- */

await check('creating a program from the popup', async () => {
  await page.click('#new-program');
  await page.fill('#np-name', 'Walmart');
  await page.fill('#np-url', 'hackerone.com/walmart');
  await page.click('#program-form button[type=submit]');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#program option')].some((o) => o.textContent === 'Walmart'));
  assert.equal(await page.inputValue('#program'), await page.evaluate(() =>
    [...document.querySelectorAll('#program option')].find((o) => o.textContent === 'Walmart').value));
});

await check('a second program can be added', async () => {
  await page.click('#new-program');
  await page.fill('#np-name', 'Shopify');
  await page.click('#program-form button[type=submit]');
  await page.waitForFunction(() => document.querySelectorAll('#program option').length >= 2);
});

await check('duplicate program names are rejected', async () => {
  await clearToast(page);
  await page.click('#new-program');
  await page.fill('#np-name', 'walmart'); // different case, same program
  await page.click('#program-form button[type=submit]');
  await expectToast(page, /already exists/i);
  await page.click('#np-cancel');
});

/* 2. Timer ----------------------------------------------------------------- */

await check('START creates a running session', async () => {
  await page.selectOption('#program', { label: 'Walmart' });
  await page.selectOption('#activity', 'hunt');
  await page.click('#start');
  await page.waitForSelector('#view-running:not([hidden])');
  const ctxText = await page.textContent('#running-context');
  assert.match(ctxText, /Walmart/);
  assert.match(ctxText, /Hunt/);
});

await check('the running timer counts up', async () => {
  const first = await page.textContent('#clock');
  await page.waitForFunction(
    (prev) => document.getElementById('clock').textContent !== prev,
    first, { timeout: 4000 },
  );
  assert.match(await page.textContent('#clock'), /^00:00:0\d$/);
});

await check('the toolbar badge shows the running timer', async () => {
  const [sw] = session.ctx.serviceWorkers();
  const text = await sw.evaluate(() => chrome.action.getBadgeText({}));
  assert.equal(text, '0m');
});

await check('closing and reopening the popup keeps the timer running', async () => {
  await page.close();
  page = await openPopup(session.ctx, session.id);
  await page.waitForSelector('#view-running:not([hidden])');
  const clock = await page.textContent('#clock');
  assert.match(clock, /^00:00:\d\d$/);
  assert.notEqual(clock, '00:00:00');
});

await check('a full browser restart keeps the timer running', async () => {
  // Simulates quitting Chrome (and the machine) mid-session: the elapsed time
  // must be recomputed from the persisted start timestamp, not from memory.
  await session.ctx.close();
  session = await launch();
  page = await openPopup(session.ctx, session.id);
  await page.waitForSelector('#view-running:not([hidden])');
  assert.notEqual(await page.textContent('#clock'), '00:00:00');
});

await check('STOP saves the session and shows the confirmation, not a form', async () => {
  // The default 30s floor would discard a 2-second test session.
  await page.evaluate(async () => {
    const db = await import('../lib/db.js');
    await db.saveSettings({ minSessionMs: 0 });
  });
  await page.click('#stop');
  await page.waitForSelector('#view-idle:not([hidden])');
  const banner = await page.textContent('#saved-banner');
  assert.match(banner, /Session saved/);
  assert.match(banner, /Hunt/);
  assert.match(banner, /Walmart/);
  assert.equal(await page.textContent('#start'), 'START AGAIN');
  // No modal, no form: the idle view is immediately ready for the next START.
  assert.equal(await page.isVisible('#finding-sheet'), false);
});

await check('the last-used program and activity stay selected', async () => {
  const selected = await page.evaluate(() =>
    document.querySelector('#program').selectedOptions[0].textContent);
  assert.equal(selected, 'Walmart');
  assert.equal(await page.inputValue('#activity'), 'hunt');
});

await check('the badge clears when no session is running', async () => {
  const [sw] = session.ctx.serviceWorkers();
  await page.waitForTimeout(200);
  assert.equal(await sw.evaluate(() => chrome.action.getBadgeText({})), '');
});

await check('several sessions on the same day aggregate', async () => {
  for (const activity of ['recon', 'testing']) {
    await page.selectOption('#activity', activity);
    await page.click('#start');
    await page.waitForSelector('#view-running:not([hidden])');
    await page.waitForTimeout(1100);
    await page.click('#stop');
    await page.waitForSelector('#view-idle:not([hidden])');
  }
  assert.equal(await page.textContent('#t-sessions'), '3');
  const chips = await page.textContent('#today-activities');
  assert.match(chips, /Hunt/);
  assert.match(chips, /Recon/);
  assert.match(chips, /Testing/);
});

await check('discarding a running session saves nothing', async () => {
  page.once('dialog', (d) => d.accept());
  await page.click('#start');
  await page.waitForSelector('#view-running:not([hidden])');
  await page.click('#discard');
  await page.waitForSelector('#view-idle:not([hidden])');
  assert.equal(await page.textContent('#t-sessions'), '3');
});

/* 3. Findings -------------------------------------------------------------- */

await check('a finding is created from the popup with no bounty required', async () => {
  await clearToast(page);
  await page.click('#add-finding');
  await page.fill('#fs-title', 'Broken Access Control in Nutrition Hub');
  await page.fill('#fs-type', 'IDOR / BOLA');
  await page.selectOption('#fs-severity', 'high');
  await page.click('#finding-form button[type=submit]');
  await expectToast(page, /Finding #1 saved/);
  await page.waitForFunction(() => document.getElementById('t-findings').textContent === '1');
  assert.equal(await page.isVisible('#finding-sheet'), false);
});

/* 4. Seeded history for the analytics views -------------------------------- */

await check('a multi-day backup imports cleanly', async () => {
  const app = await session.ctx.newPage();
  await app.goto(appUrl(session.id, '#data'));
  await app.waitForSelector('.view-head');

  const counts = await app.evaluate(async () => {
    const { restoreBackup } = await import('./../lib/backup.js');
    const { makeSession, makeFinding, DEFAULT_SETTINGS } = await import('./../lib/models.js');

    const day = 86400000;
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    const at = (daysAgo, h, m) => base.getTime() - daysAgo * day + h * 3600000 + m * 60000;

    const programs = [
      { id: 'p_walmart', name: 'Walmart', url: '', platform: 'HackerOne', active: true, notes: '', createdAt: at(30, 9, 0), updatedAt: at(30, 9, 0) },
      { id: 'p_shopify', name: 'Shopify', url: '', platform: 'HackerOne', active: true, notes: '', createdAt: at(28, 9, 0), updatedAt: at(28, 9, 0) },
      { id: 'p_mozilla', name: 'Mozilla', url: '', platform: 'Private', active: true, notes: '', createdAt: at(20, 9, 0), updatedAt: at(20, 9, 0) },
    ];

    const sessions = [];
    const acts = ['hunt', 'hunt', 'recon', 'testing', 'reporting', 'study'];
    for (let d = 25; d >= 1; d--) {
      if (d % 7 === 0) continue; // a rest day, so gaps are exercised too
      const n = 2 + (d % 3);
      for (let i = 0; i < n; i++) {
        const startH = 9 + i * 3;
        const mins = 40 + ((d * 7 + i * 13) % 70);
        sessions.push(makeSession({
          programId: programs[(d + i) % 3].id,
          activity: acts[(d + i) % acts.length],
          startTime: at(d, startH, 0),
          endTime: at(d, startH, mins),
        }));
      }
    }

    const findings = [];
    const history = [];
    const spec = [
      { ref: 1, title: 'IDOR in order history', type: 'IDOR / BOLA', prog: 'p_walmart', sev: 'high', found: 22, reported: 20, triaged: 17, paid: 14, bounty: 1500 },
      { ref: 2, title: 'Stored XSS in profile bio', type: 'XSS (Stored)', prog: 'p_shopify', sev: 'medium', found: 18, reported: 17, triaged: 15, paid: 11, bounty: 750 },
      { ref: 3, title: 'SSRF via webhook URL', type: 'SSRF', prog: 'p_mozilla', sev: 'critical', found: 15, reported: 14, triaged: 12, paid: null, bounty: 0, status: 'triaged' },
      { ref: 4, title: 'Open redirect in login flow', type: 'Open Redirect', prog: 'p_walmart', sev: 'low', found: 12, reported: 11, triaged: null, paid: null, bounty: 0, status: 'duplicate' },
      { ref: 5, title: 'Rate limit bypass on OTP', type: 'Rate Limiting', prog: 'p_shopify', sev: 'medium', found: 8, reported: 7, triaged: null, paid: null, bounty: 0, status: 'reported' },
      { ref: 6, title: 'Business logic flaw in cart', type: 'Business Logic', prog: 'p_walmart', sev: 'high', found: 4, reported: null, triaged: null, paid: null, bounty: 0, status: 'confirmed' },
    ];
    for (const s of spec) {
      const createdAt = at(s.found, 14, 0);
      const stamps = { new: createdAt };
      if (s.reported) stamps.reported = at(s.reported, 10, 0);
      if (s.triaged) stamps.triaged = at(s.triaged, 10, 0);
      if (s.paid) stamps.paid = at(s.paid, 10, 0);
      const status = s.status ?? 'paid';
      findings.push(makeFinding({
        id: `f_seed_${s.ref}`, ref: s.ref + 100, title: s.title, type: s.type,
        programId: s.prog, severity: s.sev, status,
        bounty: s.bounty, currency: 'USD', createdAt,
        statusTimestamps: stamps, paidAt: s.paid ? at(s.paid, 10, 0) : null,
      }));
      history.push({ id: `h_${s.ref}_c`, findingId: `f_seed_${s.ref}`, timestamp: createdAt, field: 'created', oldValue: null, newValue: 'new' });
      if (s.reported) history.push({ id: `h_${s.ref}_r`, findingId: `f_seed_${s.ref}`, timestamp: stamps.reported, field: 'status', oldValue: 'new', newValue: 'reported' });
      if (s.paid) history.push({ id: `h_${s.ref}_b`, findingId: `f_seed_${s.ref}`, timestamp: stamps.paid, field: 'bounty', oldValue: 0, newValue: s.bounty });
    }

    const payload = {
      kind: 'bug-hunt-tracker-backup',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      counts: { programs: programs.length, sessions: sessions.length, findings: findings.length, history: history.length },
      data: { programs, sessions, findings, history, settings: { ...DEFAULT_SETTINGS, minSessionMs: 0 }, findingRefCounter: 106 },
    };
    return restoreBackup(payload);
  });

  assert.ok(counts.sessions > 40, `expected a seeded history, got ${counts.sessions} sessions`);
  await app.close();
});

await check('the popup recovers after an import replaced its selected program', async () => {
  // Import wipes and replaces everything, so the remembered program id is now
  // dangling. The popup must fall back to a valid selection, not break.
  await page.reload();
  await page.waitForSelector('#view-idle:not([hidden])');
  const options = await page.$$eval('#program option', (ns) => ns.map((n) => n.textContent));
  assert.ok(options.includes('Walmart'), `expected the imported programs, saw ${options.join(', ')}`);
});

await check('finding numbers continue from the imported counter', async () => {
  // The seed's counter ended at 106; the next finding must not reuse a ref.
  await clearToast(page);
  await page.click('#add-finding');
  await page.fill('#fs-title', 'Broken Access Control in Nutrition Hub');
  await page.fill('#fs-type', 'IDOR / BOLA');
  await page.selectOption('#fs-program', { label: 'Walmart' });
  await page.selectOption('#fs-severity', 'high');
  await page.click('#finding-form button[type=submit]');
  await expectToast(page, /Finding #107 saved/);
});

/* 5. Dashboard ------------------------------------------------------------- */

const appErrors = [];
let app = await session.ctx.newPage();
function watchApp(p) {
  p.on('pageerror', (e) => appErrors.push(String(e)));
  p.on('console', (m) => { if (m.type() === 'error') appErrors.push(m.text()); });
}
watchApp(app);

await check('the dashboard renders every KPI', async () => {
  await app.goto(appUrl(session.id, '#dashboard'));
  await app.waitForSelector('.stat-grid .stat');
  await app.click('.period-btn:text("All Time")');
  await app.waitForTimeout(150);
  const labels = await app.$$eval('.stat-label', (ns) => ns.map((n) => n.textContent));
  for (const expected of ['Focused Time', 'Sessions', 'Findings', 'Reports',
    'Paid Findings', 'Paid Bounty', '$ / Focused Hour', 'Hours / Finding']) {
    assert.ok(labels.includes(expected), `missing KPI: ${expected}`);
  }
});

await check('the KPI values are computed, not blank', async () => {
  const values = await app.$$eval('.stat-grid .stat', (nodes) => Object.fromEntries(
    nodes.map((n) => [n.querySelector('.stat-label').textContent, n.querySelector('.stat-value').textContent])));
  assert.match(values['Focused Time'], /\d+h/);
  assert.ok(Number(values.Sessions.replace(/\D/g, '')) > 40);
  assert.equal(values['Paid Bounty'], '$2,250');   // 1500 + 750, paid only
  assert.equal(values['Paid Findings'], '2');
  assert.equal(values.Findings, '7');              // 6 seeded + 1 created in the popup
  assert.match(values['$ / Focused Hour'], /^\$\d/);
  assert.match(values['Hours / Finding'], /^\d/);
});

await check('breakdown panels render with data', async () => {
  const panels = await app.$$eval('.panel-head h3', (ns) => ns.map((n) => n.textContent));
  for (const expected of ['Time by Activity', 'Time by Program', 'Findings by Type',
    'Findings by Severity', 'Bounty by Program', 'Bounty by Type',
    'Finding Lifecycle (all time)', 'Program Response Time', 'Monthly Rollup']) {
    assert.ok(panels.includes(expected), `missing panel: ${expected}`);
  }
  const activityBars = await app.$$eval('.panel:has(h3:text("Time by Activity")) .bar-row', (ns) => ns.length);
  assert.ok(activityBars >= 5, `expected the five activities, saw ${activityBars}`);
});

await check('charts draw bars from the seeded history', async () => {
  const bars = await app.$$eval('.chart-svg rect[fill]:not([fill="transparent"])', (ns) => ns.length);
  assert.ok(bars > 10, `expected chart bars, saw ${bars}`);
});

await check('the lifecycle panel computes real timings', async () => {
  const text = await app.textContent('.panel:has(h3:text("Finding Lifecycle (all time)"))');
  assert.match(text, /Discovery → Report/);
  assert.match(text, /\dd/); // e.g. "2d"
});

await check('period filters change the numbers', async () => {
  const readFocused = () => app.$eval('.stat-grid .stat:first-child .stat-value', (n) => n.textContent);
  const all = await readFocused();
  await app.click('.period-btn:text("Today")');
  await app.waitForTimeout(150);
  const today = await readFocused();
  assert.notEqual(all, today);
  await app.click('.period-btn:text("All Time")');
});

await check('the monthly rollup lists months', async () => {
  const rows = await app.$$eval('.panel:has(h3:text("Monthly Rollup")) tbody tr', (ns) => ns.length);
  assert.ok(rows >= 1, 'expected at least one month');
});

/* 6. Day view -------------------------------------------------------------- */

await check('the day view lists the raw sessions', async () => {
  await app.goto(appUrl(session.id, '#day'));
  await app.waitForSelector('.session-list, .empty');
  const days = await app.$$eval('.day-picker option', (ns) => ns.map((n) => n.value));
  assert.ok(days.length > 5, 'expected several active days');
  // Pick a seeded day (not today) which is guaranteed to have sessions.
  await app.selectOption('.day-picker', days[1]);
  await app.waitForTimeout(150);
  const rows = await app.$$eval('.session-row', (ns) => ns.length);
  assert.ok(rows > 0, 'expected sessions listed for a seeded day');
  const text = await app.textContent('.session-list');
  assert.match(text, /\d\d:\d\d → \d\d:\d\d/);
});

await check('day totals equal the sum of that day\'s sessions', async () => {
  const total = await app.$eval('.stat-grid .stat:first-child .stat-value', (n) => n.textContent);
  const parse = (s) => {
    const h = /(\d+)h/.exec(s); const m = /(\d+)m/.exec(s);
    return (h ? +h[1] * 60 : 0) + (m ? +m[1] : 0);
  };
  const rows = await app.$$eval('.session-row .session-dur', (ns) => ns.map((n) => n.textContent));
  const sum = rows.reduce((acc, r) => acc + parse(r), 0);
  assert.equal(parse(total), sum);
});

/* 7. Finding lifecycle through the UI -------------------------------------- */

await check('a finding status change is persisted and recorded in history', async () => {
  await app.goto(appUrl(session.id, '#findings'));
  await app.waitForSelector('.table tbody tr');
  // Address the finding by title: row order depends on creation time.
  await app.click('.link-btn:text("Broken Access Control in Nutrition Hub")');
  await app.waitForSelector('.editor-wrap');
  await app.click('.quick-status button:text("→ Confirmed")');
  await expectToast(app, /Confirmed/);
  await app.waitForTimeout(300);
  const timeline = await app.textContent('.panel:has(h3:text("History"))');
  assert.match(timeline, /Status/);
  assert.match(timeline, /Confirmed/);
});

await check('a bounty and Paid status update the money metrics', async () => {
  await app.click('.quick-status button:text("→ Paid")');
  await app.waitForTimeout(400);
  await app.fill('.editor-form input[type=number]', '500');
  await app.click('button:text("Save changes")');
  await app.waitForTimeout(400);
  const timeline = await app.textContent('.panel:has(h3:text("History"))');
  assert.match(timeline, /Bounty/);
  assert.match(timeline, /\$500/);
  const timings = await app.textContent('.panel:has(h3:text("Timings"))');
  assert.match(timings, /Paid/);
});

await check('the dashboard picks up the new bounty', async () => {
  await app.goto(appUrl(session.id, '#dashboard'));
  await app.waitForSelector('.stat-grid .stat');
  await app.click('.period-btn:text("All Time")');
  await app.waitForTimeout(200);
  const paid = await app.$$eval('.stat-grid .stat', (nodes) => nodes
    .map((n) => [n.querySelector('.stat-label').textContent, n.querySelector('.stat-value').textContent])
    .find(([l]) => l === 'Paid Bounty')[1]);
  assert.equal(paid, '$2,750'); // 2250 + the 500 just entered
});

await check('finding filters narrow the list', async () => {
  await app.goto(appUrl(session.id, '#findings'));
  await app.waitForSelector('.table tbody tr');
  const before = await app.$$eval('.table tbody tr', (ns) => ns.length);
  await app.selectOption('.filter-select >> nth=0', 'paid');
  await app.waitForTimeout(150);
  const after = await app.$$eval('.table tbody tr', (ns) => ns.length);
  assert.ok(after < before && after >= 2, `expected fewer rows, got ${after} of ${before}`);
});

/* 8. Programs -------------------------------------------------------------- */

await check('programs list their own time, findings and bounty', async () => {
  await app.goto(appUrl(session.id, '#programs'));
  await app.waitForSelector('.table tbody tr');
  const text = await app.textContent('.table');
  assert.match(text, /Walmart/);
  assert.match(text, /Shopify/);
  assert.match(text, /Mozilla/);
  assert.match(text, /\d+h \d+m/);
});

await check('a program in use cannot be silently deleted', async () => {
  await app.click('.table tbody tr:first-child .link-btn');
  await app.waitForSelector('.editor-form');
  const dialogs = [];
  // Accept the "really delete?" prompt; the refusal is the SECOND dialog.
  app.on('dialog', async (d) => {
    dialogs.push(d.message());
    if (dialogs.length === 1) await d.accept(); else await d.dismiss();
  });
  await app.click('button:text("Delete")');
  await app.waitForTimeout(600);
  assert.ok(dialogs.some((m) => /In use by/.test(m)), `expected a refusal, saw: ${dialogs.join(' | ')}`);
  // Refusing must leave the program intact.
  await app.waitForTimeout(200);
  assert.match(await app.textContent('.table'), /Mozilla/);
});

/* 9. Export / import ------------------------------------------------------- */

await check('the JSON export round-trips losslessly', async () => {
  await app.goto(appUrl(session.id, '#data'));
  await app.waitForSelector('.view-head');
  const ok = await app.evaluate(async () => {
    const { buildBackup, restoreBackup } = await import('./../lib/backup.js');
    const before = await buildBackup();
    await restoreBackup(before);
    const after = await buildBackup();
    const norm = (b) => JSON.stringify({
      programs: b.data.programs.sort((x, y) => x.id.localeCompare(y.id)),
      sessions: b.data.sessions.sort((x, y) => x.id.localeCompare(y.id)),
      findings: b.data.findings.sort((x, y) => x.id.localeCompare(y.id)),
      history: b.data.history.sort((x, y) => x.id.localeCompare(y.id)),
    });
    return { equal: norm(before) === norm(after), counts: after.counts };
  });
  assert.ok(ok.equal, 'export -> import -> export changed the data');
  assert.ok(ok.counts.sessions > 40);
});

await check('a foreign JSON file is rejected', async () => {
  const message = await app.evaluate(async () => {
    const { restoreBackup } = await import('./../lib/backup.js');
    try {
      await restoreBackup({ hello: 'world' });
      return null;
    } catch (err) {
      return err.message;
    }
  });
  assert.match(message ?? '', /not a Bug Hunt Tracker backup/i);
});

await check('CSV export escapes commas and quotes', async () => {
  const csv = await app.evaluate(async () => {
    const { findingsCsv } = await import('./../lib/backup.js');
    const { makeFinding } = await import('./../lib/models.js');
    return findingsCsv([makeFinding({
      title: 'IDOR, with a "quote"', type: 'IDOR / BOLA', status: 'new', ref: 1,
    })], []);
  });
  assert.match(csv, /"IDOR, with a ""quote"""/);
  assert.match(csv.split('\r\n')[0], /^ref,id,title/);
});

await check('the data page reports what is stored', async () => {
  const text = await app.textContent('.panel:has(h3:text("Export & Backup"))');
  assert.match(text, /\d+ programs · \d+ sessions · \d+ findings/);
});

/* 10. Persistence across a restart ----------------------------------------- */

await check('all data survives a full browser restart', async () => {
  const before = await app.evaluate(async () => {
    const { buildBackup } = await import('./../lib/backup.js');
    return (await buildBackup()).counts;
  });
  await session.ctx.close();

  session = await launch();
  app = await session.ctx.newPage();
  watchApp(app);
  await app.goto(appUrl(session.id, '#dashboard'));
  await app.waitForSelector('.stat-grid .stat');
  const after = await app.evaluate(async () => {
    const { buildBackup } = await import('./../lib/backup.js');
    return (await buildBackup()).counts;
  });
  assert.deepEqual(after, before);
});

await check('no uncaught page errors during the run', async () => {
  const all = [...(page.__errors ?? []), ...appErrors]
    // Chrome logs a benign favicon 404 for extension pages.
    .filter((e) => !/favicon/i.test(e));
  assert.deepEqual(all, [], `page errors:\n${all.join('\n')}`);
});

/* -------------------------------------------------------------------------- */

await session.ctx.close().catch(() => {});
fs.rmSync(PROFILE, { recursive: true, force: true });

dumpAndExit(failed ? 1 : 0);
