/**
 * Pure-logic tests for the aggregation engine. Run with: npm test
 * (No browser, no IndexedDB — analytics.js and time.js are deliberately pure.)
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as A from '../src/lib/analytics.js';
import * as T from '../src/lib/time.js';
import { makeSession, makeFinding, DEFAULT_ACTIVITIES } from '../src/lib/models.js';

const at = (y, m, d, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0).getTime();

/** The exact scenario from the spec: five sessions on September 6, 2026. */
function sept6Sessions() {
  const mk = (sh, sm, eh, em, activity, programId) =>
    makeSession({
      startTime: at(2026, 9, 6, sh, sm),
      endTime: at(2026, 9, 6, eh, em),
      activity,
      programId,
    });
  return [
    mk(10, 12, 11, 3, 'hunt', 'p_walmart'),
    mk(11, 20, 12, 5, 'hunt', 'p_walmart'),
    mk(13, 10, 14, 42, 'hunt', 'p_walmart'),
    mk(16, 0, 16, 47, 'recon', 'p_walmart'),
    mk(19, 20, 21, 5, 'study', null),
  ];
}

test('duration is derived from the two timestamps', () => {
  const [s] = sept6Sessions();
  assert.equal(s.durationMs, 51 * 60 * 1000);
  assert.equal(T.formatDuration(s.durationMs), '51m');
  assert.equal(s.date, '2026-09-06');
});

test('multiple sessions on one day aggregate to 5h 40m over 5 sessions', () => {
  const sessions = sept6Sessions();
  const day = A.dayReport('2026-09-06', sessions, [], DEFAULT_ACTIVITIES);
  assert.equal(day.sessions, 5);
  assert.equal(T.formatDuration(day.focusedMs), '5h 40m');
});

test('activity breakdown splits the same day correctly and covers zero-time activities', () => {
  const day = A.dayReport('2026-09-06', sept6Sessions(), [], DEFAULT_ACTIVITIES);
  const byId = Object.fromEntries(day.activities.map((a) => [a.id, T.formatDuration(a.value)]));
  assert.equal(byId.hunt, '3h 8m');   // 51 + 45 + 92
  assert.equal(byId.recon, '47m');
  assert.equal(byId.study, '1h 45m');
  assert.equal(byId.testing, '0m');
  assert.equal(byId.reporting, '0m');
  // The breakdown must always add up to the day total.
  const sum = day.activities.reduce((a, r) => a + r.value, 0);
  assert.equal(sum, day.focusedMs);
});

test('sessions on different days do not bleed into each other', () => {
  const sessions = [
    ...sept6Sessions(),
    makeSession({ startTime: at(2026, 9, 7, 9, 0), endTime: at(2026, 9, 7, 10, 30), activity: 'hunt' }),
  ];
  assert.equal(T.formatDuration(A.dayReport('2026-09-06', sessions, [], []).focusedMs), '5h 40m');
  assert.equal(T.formatDuration(A.dayReport('2026-09-07', sessions, [], []).focusedMs), '1h 30m');
});

test('a session crossing midnight is attributed to the day it started', () => {
  const s = makeSession({ startTime: at(2026, 9, 6, 23, 30), endTime: at(2026, 9, 7, 1, 0) });
  assert.equal(s.date, '2026-09-06');
  assert.equal(T.formatDuration(s.durationMs), '1h 30m');
});

test('period ranges select the right sessions', () => {
  const now = at(2026, 9, 6, 20, 0);
  const sessions = [
    makeSession({ startTime: at(2026, 9, 6, 10, 0), endTime: at(2026, 9, 6, 11, 0) }),
    makeSession({ startTime: at(2026, 9, 2, 10, 0), endTime: at(2026, 9, 2, 12, 0) }), // same week+month
    makeSession({ startTime: at(2026, 8, 20, 10, 0), endTime: at(2026, 8, 20, 12, 0) }), // prev month, same quarter
    makeSession({ startTime: at(2026, 1, 5, 10, 0), endTime: at(2026, 1, 5, 12, 0) }), // prev quarter
  ];
  const hours = (p) => {
    const { from, to } = T.periodRange(p, now, 1);
    return A.summarize({ sessions, from, to }).focusedHours;
  };
  assert.equal(hours('today'), 1);
  assert.equal(hours('week'), 3);     // Mon Aug 31 -> Sun; includes Sep 2 and Sep 6
  assert.equal(hours('month'), 3);
  assert.equal(hours('quarter'), 5);  // Q3 = Jul-Sep, adds Aug 20
  assert.equal(hours('all'), 7);
});

/* ---------------------------------------------------------------- money -- */

test('only paid findings count as paid bounty; drafts contribute nothing', () => {
  const findings = [
    makeFinding({ status: 'paid', bounty: 500, createdAt: at(2026, 9, 6), paidAt: at(2026, 9, 13) }),
    makeFinding({ status: 'reported', bounty: 2000, createdAt: at(2026, 9, 7) }), // hoped-for, not earned
    makeFinding({ status: 'new', bounty: 0, createdAt: at(2026, 9, 8) }),
  ];
  const { from, to } = T.periodRange('all');
  const s = A.summarize({ sessions: [], findings, from, to });
  assert.equal(s.paidBounty, 500);
  assert.equal(s.paidFindings, 1);
  assert.equal(s.findings, 3);
});

test('bounty is attributed to the month it was PAID, not the month it was found', () => {
  const findings = [
    makeFinding({ status: 'paid', bounty: 1250, createdAt: at(2026, 8, 28), paidAt: at(2026, 9, 13) }),
  ];
  const months = Object.fromEntries(A.monthlySeries([], findings).map((m) => [m.key, m.bounty]));
  assert.equal(months['2026-08'], 0);
  assert.equal(months['2026-09'], 1250);
});

test('$/focused hour and hours/finding are derived, not entered', () => {
  const sessions = sept6Sessions(); // 5h 40m = 5.666.. h
  const findings = [
    makeFinding({ status: 'paid', bounty: 500, createdAt: at(2026, 9, 6, 12), paidAt: at(2026, 9, 6, 18) }),
  ];
  const { from, to } = T.periodRange('all');
  const s = A.summarize({ sessions, findings, from, to });
  assert.equal(s.focusedHours.toFixed(4), (340 / 60).toFixed(4));
  assert.equal(s.perHour.toFixed(2), '88.24');       // 500 / 5.6667
  assert.equal(s.hoursPerFinding.toFixed(2), '5.67'); // 5.6667 / 1
  assert.equal(s.avgBounty, 500);
});

test('divide-by-zero guards return null instead of NaN/Infinity', () => {
  const s = A.summarize({ sessions: [], findings: [], from: 0, to: Number.MAX_SAFE_INTEGER });
  assert.equal(s.perHour, null);
  assert.equal(s.hoursPerFinding, null);
  assert.equal(s.avgBounty, null);
  assert.equal(s.signalRate, null);
  assert.equal(s.focusedMs, 0);
});

test('money totals do not drift on repeated fractional sums', () => {
  const cents = Array.from({ length: 300 }, () => 0.1);
  assert.equal(A.sumMoney(cents), 30);
});

/* ------------------------------------------------------------ lifecycle -- */

test('status milestones drive time-to-report / triage / payment', () => {
  const f = makeFinding({
    status: 'paid',
    bounty: 500,
    createdAt: at(2026, 9, 6, 12),
    statusTimestamps: {
      new: at(2026, 9, 6, 12),
      confirmed: at(2026, 9, 7, 12),
      reported: at(2026, 9, 8, 12),
      triaged: at(2026, 9, 12, 12),
      paid: at(2026, 9, 13, 12),
    },
    paidAt: at(2026, 9, 13, 12),
  });
  const lc = A.lifecycle([f]);
  const days = (ms) => ms / (24 * 3600 * 1000);
  assert.equal(days(lc.avgTimeToReportMs), 2);      // Sep 6 -> Sep 8
  assert.equal(days(lc.avgTimeToTriageMs), 4);      // Sep 8 -> Sep 12
  assert.equal(days(lc.avgTimeToPaymentMs), 1);     // Sep 12 -> Sep 13
  assert.equal(days(lc.avgDiscoveryToPaidMs), 7);   // Sep 6 -> Sep 13
});

test('a finding that skips "reported" still counts as reported at its first submitted status', () => {
  const f = makeFinding({
    status: 'triaged',
    createdAt: at(2026, 9, 6),
    statusTimestamps: { new: at(2026, 9, 6), triaged: at(2026, 9, 9) },
  });
  assert.equal(A.reportedAt(f), at(2026, 9, 9));
  const { from, to } = T.periodRange('all');
  assert.equal(A.summarize({ findings: [f], from, to }).reports, 1);
});

test('signal rate ignores findings that were never submitted', () => {
  const mk = (status, extra = {}) => makeFinding({
    status, createdAt: at(2026, 9, 1),
    statusTimestamps: { reported: at(2026, 9, 2), [status]: at(2026, 9, 5) },
    ...extra,
  });
  const findings = [
    mk('paid', { paidAt: at(2026, 9, 5), bounty: 100 }),
    mk('triaged'),
    mk('duplicate'),
    mk('rejected'),
    makeFinding({ status: 'new', createdAt: at(2026, 9, 3) }), // never submitted
  ];
  const { from, to } = T.periodRange('all');
  const s = A.summarize({ findings, from, to });
  assert.equal(s.resolved, 4);
  assert.equal(s.accepted, 2);
  assert.equal(s.signalRate, 0.5);
});

test('program response time averages report -> triage per program', () => {
  const day = 24 * 3600 * 1000;
  const f = (programId, repDay, triDay) => makeFinding({
    programId, status: 'triaged', createdAt: at(2026, 9, 1),
    statusTimestamps: { reported: at(2026, 9, repDay), triaged: at(2026, 9, triDay) },
  });
  const rows = A.programResponse(
    [f('p1', 1, 3), f('p1', 1, 5), f('p2', 1, 2)],
    [{ id: 'p1', name: 'Walmart' }, { id: 'p2', name: 'Shopify' }],
  );
  assert.equal(rows[0].label, 'Shopify');
  assert.equal(rows[0].value, 1 * day);
  assert.equal(rows[1].label, 'Walmart');
  assert.equal(rows[1].value, 3 * day); // (2d + 4d) / 2
});

/* ----------------------------------------------------------- breakdowns -- */

test('program breakdown joins time, findings and bounty', () => {
  const sessions = sept6Sessions();
  const findings = [
    makeFinding({ programId: 'p_walmart', status: 'paid', bounty: 500, paidAt: at(2026, 9, 13) }),
    makeFinding({ programId: 'p_walmart', status: 'new' }),
  ];
  const rows = A.byProgram(sessions, findings, [{ id: 'p_walmart', name: 'Walmart' }]);
  const walmart = rows.find((r) => r.id === 'p_walmart');
  assert.equal(T.formatDuration(walmart.value), '3h 55m'); // 51+45+92+47
  assert.equal(walmart.findings, 2);
  assert.equal(walmart.bounty, 500);
  // The study session had no program and must still be represented.
  assert.ok(rows.find((r) => r.label === 'No program'));
});

test('sessions pointing at a deleted program are still counted, under a label', () => {
  const rows = A.byProgram(
    [makeSession({ startTime: at(2026, 9, 6, 9), endTime: at(2026, 9, 6, 10), programId: 'gone' })],
    [], [],
  );
  assert.equal(rows[0].label, 'Deleted program');
  assert.equal(rows[0].value, 3600 * 1000);
});

test('vulnerability-type breakdown groups blanks as Unspecified', () => {
  const rows = A.byType([
    makeFinding({ type: 'IDOR / BOLA', status: 'paid', bounty: 500 }),
    makeFinding({ type: 'IDOR / BOLA' }),
    makeFinding({ type: '' }),
  ]);
  assert.equal(rows[0].label, 'IDOR / BOLA');
  assert.equal(rows[0].value, 2);
  assert.equal(rows[0].bounty, 500);
  assert.equal(rows[1].label, 'Unspecified');
});

test('daily series fills gap days with zeros', () => {
  const rows = A.dailySeries(sept6Sessions(), [], '2026-09-04', '2026-09-07');
  assert.equal(rows.length, 4);
  assert.equal(rows[0].focusedMs, 0);
  assert.equal(T.formatDuration(rows[2].focusedMs), '5h 40m');
  assert.equal(rows[3].focusedMs, 0);
});

test('monthly rollup matches the spec-style month summary', () => {
  const sessions = [];
  for (let d = 1; d <= 10; d++) {
    sessions.push(makeSession({
      startTime: at(2026, 9, d, 9, 0), endTime: at(2026, 9, d, 12, 0), activity: 'hunt',
    }));
  }
  const findings = [
    makeFinding({ createdAt: at(2026, 9, 3), status: 'paid', bounty: 750, paidAt: at(2026, 9, 20),
      statusTimestamps: { reported: at(2026, 9, 5), paid: at(2026, 9, 20) } }),
    makeFinding({ createdAt: at(2026, 9, 4), status: 'paid', bounty: 500, paidAt: at(2026, 9, 22),
      statusTimestamps: { reported: at(2026, 9, 6), paid: at(2026, 9, 22) } }),
  ];
  const sep = A.monthlySeries(sessions, findings).find((m) => m.key === '2026-09');
  assert.equal(T.formatDuration(sep.focusedMs), '30h 0m');
  assert.equal(sep.sessions, 10);
  assert.equal(sep.findings, 2);
  assert.equal(sep.reports, 2);
  assert.equal(sep.bounty, 1250);

  const { from, to } = T.periodRange('month', at(2026, 9, 15), 1);
  const s = A.summarize({ sessions, findings, from, to });
  assert.equal(s.perHour.toFixed(2), '0.00'); // paid later in the month than `to`
  assert.equal(s.activeDays, 10);
});

test('streak counts consecutive hunting days', () => {
  const s = (d) => makeSession({ startTime: at(2026, 9, d, 9), endTime: at(2026, 9, d, 10) });
  assert.equal(A.currentStreak([s(4), s(5), s(6)], '2026-09-06'), 3);
  assert.equal(A.currentStreak([s(1), s(2)], '2026-09-06'), 0); // streak broken
  assert.equal(A.currentStreak([s(5)], '2026-09-06'), 1);       // yesterday still counts
  assert.equal(A.currentStreak([], '2026-09-06'), 0);
});
