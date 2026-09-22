/**
 * Aggregation engine.
 *
 * Every function here is PURE — arrays in, numbers out — so the whole metric
 * surface is testable without a browser, and so no aggregate ever has to be
 * stored (and therefore can never go stale or disagree with the raw data).
 *
 * Money rule: paid bounty counts a finding only once it is actually `paid`,
 * and only in the period it was paid in. A finding sitting at "reported" with
 * an optimistic number in the bounty field contributes nothing to revenue —
 * potential value is deliberately NOT mixed into earned value.
 */

import {
  REPORTED_STATUSES, ACCEPTED_STATUSES, REJECTED_STATUSES, STATUS_BY_ID, SEVERITY_BY_ID,
} from './models.js';
import {
  MS, dateKey, monthKey, dayKeyRange, hoursOf,
  startOfDay, endOfDay, startOfWeek, startOfMonth, startOfQuarter, startOfYear,
} from './time.js';

const inRange = (ts, from, to) => ts != null && ts >= from && ts < to;

/** Sum money in integer cents, then convert back — avoids float drift on totals. */
export function sumMoney(values) {
  return values.reduce((acc, v) => acc + Math.round((Number(v) || 0) * 100), 0) / 100;
}

/**
 * When was this finding submitted to the program? Findings do not always pass
 * through "reported" — one can jump straight to "triaged" — so take the
 * earliest milestone among all statuses that imply submission.
 */
export function reportedAt(finding) {
  const stamps = finding.statusTimestamps ?? {};
  const times = REPORTED_STATUSES.map((s) => stamps[s]).filter((t) => t != null);
  return times.length ? Math.min(...times) : null;
}

export function triagedAt(finding) {
  const stamps = finding.statusTimestamps ?? {};
  const times = ['triaged', 'paid'].map((s) => stamps[s]).filter((t) => t != null);
  return times.length ? Math.min(...times) : null;
}

export function paidAtOf(finding) {
  return finding.paidAt ?? finding.statusTimestamps?.paid ?? null;
}

/* ------------------------------------------------------------------ KPIs -- */

/**
 * The headline block: Focused Time, Sessions, Findings, Reports,
 * Paid Findings, Paid Bounty, $/Focused Hour, Hours/Finding.
 */
export function summarize({ sessions = [], findings = [], from = 0, to = Number.MAX_SAFE_INTEGER } = {}) {
  const inSessions = sessions.filter((s) => inRange(s.startTime, from, to));
  const focusedMs = inSessions.reduce((acc, s) => acc + (s.durationMs || 0), 0);
  const hours = hoursOf(focusedMs);

  const created = findings.filter((f) => inRange(f.createdAt, from, to));
  const reported = findings.filter((f) => inRange(reportedAt(f), from, to));
  const paid = findings.filter((f) => f.status === 'paid' && inRange(paidAtOf(f), from, to));
  const paidBounty = sumMoney(paid.map((f) => f.bounty));

  // Signal rate is measured over submitted findings that have received a
  // verdict. Un-submitted drafts must not drag it down, and findings still
  // awaiting a verdict at "reported" are not counted either way yet — note
  // that "triaged" already IS the accept decision, even though the finding is
  // not finished until it is paid or closed.
  const resolved = findings.filter(
    (f) => inRange(reportedAt(f), from, to)
      && (ACCEPTED_STATUSES.includes(f.status) || REJECTED_STATUSES.includes(f.status)),
  );
  const accepted = resolved.filter((f) => ACCEPTED_STATUSES.includes(f.status));

  const activeDays = new Set(inSessions.map((s) => s.date)).size;

  return {
    focusedMs,
    focusedHours: hours,
    sessions: inSessions.length,
    activeDays,
    avgSessionMs: inSessions.length ? Math.round(focusedMs / inSessions.length) : 0,
    avgDayMs: activeDays ? Math.round(focusedMs / activeDays) : 0,
    findings: created.length,
    reports: reported.length,
    paidFindings: paid.length,
    paidBounty,
    // Guarded divisions: with no hours or no findings these read as null and the
    // UI shows "—" rather than Infinity or NaN.
    perHour: hours > 0 ? paidBounty / hours : null,
    hoursPerFinding: created.length > 0 ? hours / created.length : null,
    avgBounty: paid.length ? paidBounty / paid.length : null,
    signalRate: resolved.length ? accepted.length / resolved.length : null,
    resolved: resolved.length,
    accepted: accepted.length,
  };
}

/* ------------------------------------------------------------ breakdowns -- */

function toSortedRows(map, valueKey = 'value') {
  return [...map.values()].sort((a, b) => b[valueKey] - a[valueKey]);
}

/** Focused time per activity, including activities with zero time. */
export function timeByActivity(sessions, activities = []) {
  const map = new Map();
  for (const a of activities) {
    map.set(a.id, { id: a.id, label: a.label, color: a.color, value: 0, sessions: 0 });
  }
  for (const s of sessions) {
    if (!map.has(s.activity)) {
      // A session recorded under an activity that was later deleted still has
      // to appear, or the breakdown would not add up to the total.
      map.set(s.activity, { id: s.activity, label: s.activity, color: '#64748b', value: 0, sessions: 0 });
    }
    const row = map.get(s.activity);
    row.value += s.durationMs || 0;
    row.sessions += 1;
  }
  return [...map.values()].sort((a, b) => b.value - a.value);
}

/** Focused time per program, with the findings and bounty earned there. */
export function byProgram(sessions, findings, programs) {
  const names = new Map(programs.map((p) => [p.id, p.name]));
  const map = new Map();
  const row = (id) => {
    if (!map.has(id)) {
      map.set(id, {
        id,
        label: id ? (names.get(id) ?? 'Deleted program') : 'No program',
        value: 0, sessions: 0, findings: 0, paidFindings: 0, bounty: 0,
      });
    }
    return map.get(id);
  };
  for (const s of sessions) {
    const r = row(s.programId ?? null);
    r.value += s.durationMs || 0;
    r.sessions += 1;
  }
  for (const f of findings) {
    const r = row(f.programId ?? null);
    r.findings += 1;
    if (f.status === 'paid') {
      r.paidFindings += 1;
      r.bounty = sumMoney([r.bounty, f.bounty]);
    }
  }
  for (const r of map.values()) {
    r.perHour = r.value > 0 ? r.bounty / hoursOf(r.value) : null;
  }
  return toSortedRows(map);
}

/** Findings and bounty per vulnerability type. */
export function byType(findings) {
  const map = new Map();
  for (const f of findings) {
    const key = (f.type || '').trim() || 'Unspecified';
    if (!map.has(key)) map.set(key, { id: key, label: key, value: 0, paidFindings: 0, bounty: 0 });
    const r = map.get(key);
    r.value += 1;
    if (f.status === 'paid') {
      r.paidFindings += 1;
      r.bounty = sumMoney([r.bounty, f.bounty]);
    }
  }
  return toSortedRows(map);
}

export function bySeverity(findings) {
  const map = new Map();
  for (const f of findings) {
    const meta = SEVERITY_BY_ID[f.severity];
    const key = f.severity || 'unknown';
    if (!map.has(key)) {
      map.set(key, { id: key, label: meta?.label ?? key, color: meta?.color ?? '#64748b', value: 0, bounty: 0 });
    }
    const r = map.get(key);
    r.value += 1;
    if (f.status === 'paid') r.bounty = sumMoney([r.bounty, f.bounty]);
  }
  return toSortedRows(map);
}

export function byStatus(findings) {
  const map = new Map();
  for (const f of findings) {
    const meta = STATUS_BY_ID[f.status];
    if (!map.has(f.status)) {
      map.set(f.status, { id: f.status, label: meta?.label ?? f.status, color: meta?.color ?? '#64748b', value: 0 });
    }
    map.get(f.status).value += 1;
  }
  return toSortedRows(map);
}

/* --------------------------------------------------------- time series --- */

/** Focused ms + session/finding counts for every day in a range (gaps = 0). */
export function dailySeries(sessions, findings, fromKey, toKey) {
  const days = dayKeyRange(fromKey, toKey);
  const base = new Map(days.map((k) => [k, { key: k, focusedMs: 0, sessions: 0, findings: 0, bounty: 0 }]));
  for (const s of sessions) {
    const row = base.get(s.date);
    if (!row) continue;
    row.focusedMs += s.durationMs || 0;
    row.sessions += 1;
  }
  for (const f of findings) {
    const row = base.get(dateKey(f.createdAt));
    if (row) row.findings += 1;
    const paid = paidAtOf(f);
    if (f.status === 'paid' && paid != null) {
      const prow = base.get(dateKey(paid));
      if (prow) prow.bounty = sumMoney([prow.bounty, f.bounty]);
    }
  }
  return days.map((k) => base.get(k));
}

/** Same shape as dailySeries but bucketed by calendar month. */
export function monthlySeries(sessions, findings) {
  const map = new Map();
  const row = (key) => {
    if (!map.has(key)) map.set(key, { key, focusedMs: 0, sessions: 0, findings: 0, reports: 0, bounty: 0 });
    return map.get(key);
  };
  for (const s of sessions) {
    const r = row(monthKey(s.startTime));
    r.focusedMs += s.durationMs || 0;
    r.sessions += 1;
  }
  for (const f of findings) {
    row(monthKey(f.createdAt)).findings += 1;
    const rep = reportedAt(f);
    if (rep != null) row(monthKey(rep)).reports += 1;
    const paid = paidAtOf(f);
    if (f.status === 'paid' && paid != null) {
      const r = row(monthKey(paid));
      r.bounty = sumMoney([r.bounty, f.bounty]);
    }
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/* ------------------------------------------------------------ lifecycle -- */

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Funnel timings derived entirely from the status milestones:
 * discovery -> report -> triage -> payment.
 */
export function lifecycle(findings) {
  const toReport = [];
  const toTriage = [];
  const toPay = [];
  const discoveryToPay = [];

  for (const f of findings) {
    const rep = reportedAt(f);
    const tri = triagedAt(f);
    const paid = paidAtOf(f);
    if (rep != null) toReport.push(rep - f.createdAt);
    if (rep != null && tri != null && tri >= rep) toTriage.push(tri - rep);
    if (tri != null && paid != null && paid >= tri) toPay.push(paid - tri);
    if (paid != null) discoveryToPay.push(paid - f.createdAt);
  }

  return {
    avgTimeToReportMs: avg(toReport),
    avgTimeToTriageMs: avg(toTriage),
    avgTimeToPaymentMs: avg(toPay),
    avgDiscoveryToPaidMs: avg(discoveryToPay),
    counted: {
      report: toReport.length, triage: toTriage.length,
      payment: toPay.length, discoveryToPaid: discoveryToPay.length,
    },
  };
}

/** Program response time = how long the program takes from report to triage. */
export function programResponse(findings, programs) {
  const names = new Map(programs.map((p) => [p.id, p.name]));
  const map = new Map();
  for (const f of findings) {
    const rep = reportedAt(f);
    const tri = triagedAt(f);
    if (rep == null || tri == null || tri < rep) continue;
    const id = f.programId ?? null;
    if (!map.has(id)) {
      map.set(id, { id, label: id ? (names.get(id) ?? 'Deleted program') : 'No program', samples: [] });
    }
    map.get(id).samples.push(tri - rep);
  }
  return [...map.values()]
    .map((r) => ({ id: r.id, label: r.label, value: avg(r.samples), n: r.samples.length }))
    .sort((a, b) => a.value - b.value);
}

/* ------------------------------------------------------------- day view -- */

/** Everything the "September 6, 2026" panel shows. */
export function dayReport(key, sessions, findings, activities) {
  const daySessions = sessions.filter((s) => s.date === key).sort((a, b) => a.startTime - b.startTime);
  const dayFindings = findings.filter((f) => dateKey(f.createdAt) === key);
  const focusedMs = daySessions.reduce((acc, s) => acc + (s.durationMs || 0), 0);
  const reports = findings.filter((f) => {
    const rep = reportedAt(f);
    return rep != null && dateKey(rep) === key;
  }).length;
  const paid = findings.filter((f) => {
    const p = paidAtOf(f);
    return f.status === 'paid' && p != null && dateKey(p) === key;
  });

  return {
    key,
    focusedMs,
    sessions: daySessions.length,
    sessionList: daySessions,
    activities: timeByActivity(daySessions, activities),
    findings: dayFindings.length,
    findingList: dayFindings,
    reports,
    paidBounty: sumMoney(paid.map((f) => f.bounty)),
    paidFindings: paid.length,
  };
}

/** Day keys that have any session, newest first — the day picker's source. */
export function activeDayKeys(sessions, findings) {
  const keys = new Set(sessions.map((s) => s.date));
  for (const f of findings) keys.add(dateKey(f.createdAt));
  return [...keys].sort((a, b) => b.localeCompare(a));
}

/* -------------------------------------------------------------- streaks -- */

/** Consecutive days with at least one session, ending today or yesterday. */
export function currentStreak(sessions, today = dateKey()) {
  const days = new Set(sessions.map((s) => s.date));
  if (!days.size) return 0;
  const step = (k, n) => {
    const [y, m, d] = k.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + n);
    return dateKey(dt.getTime());
  };
  let cursor = days.has(today) ? today : step(today, -1);
  if (!days.has(cursor)) return 0;
  let streak = 0;
  while (days.has(cursor) && streak < 3650) {
    streak += 1;
    cursor = step(cursor, -1);
  }
  return streak;
}

export const HOUR_MS = MS.HOUR;

/* --------------------------------------------------------------- goals -- */

/**
 * Compute current-period progress for one goal. PURE — no DB calls.
 *
 * Returns:
 *   current      — measured value so far this period
 *   target       — goal.target
 *   ratio        — current / target  (>= 1.0 means achieved ✓)
 *   done         — ratio >= 1
 *   from, to     — epoch ms boundaries of the current period
 */
export function goalProgress(goal, sessions, findings, now = Date.now()) {
  const { from, to } = periodRangeForGoal(goal.period, now);

  const filtSessions = goal.programId
    ? sessions.filter((s) => s.programId === goal.programId)
    : sessions;
  const filtFindings = goal.programId
    ? findings.filter((f) => f.programId === goal.programId)
    : findings;

  let current = 0;

  switch (goal.metric) {
    case 'findings':
      current = filtFindings.filter((f) => inRange(f.createdAt, from, to)).length;
      break;
    case 'bounty': {
      const paid = filtFindings.filter(
        (f) => f.status === 'paid' && inRange(paidAtOf(f), from, to),
      );
      current = sumMoney(paid.map((f) => f.bounty));
      break;
    }
    case 'hours': {
      const ms = filtSessions
        .filter((s) => inRange(s.startTime, from, to))
        .reduce((acc, s) => acc + (s.durationMs || 0), 0);
      current = hoursOf(ms);
      break;
    }
    case 'sessions':
      current = filtSessions.filter((s) => inRange(s.startTime, from, to)).length;
      break;
    default:
      current = 0;
  }

  const ratio = goal.target > 0 ? current / goal.target : 0;
  return { current, target: goal.target, ratio, done: ratio >= 1, from, to };
}

/** {from, to} epoch ms for the current window of a goal period. */
export function periodRangeForGoal(period, now = Date.now()) {
  switch (period) {
    case 'daily':     return { from: startOfDay(now),     to: endOfDay(now) };
    case 'weekly':    return { from: startOfWeek(now, 1), to: endOfDay(now) };
    case 'monthly':   return { from: startOfMonth(now),   to: endOfDay(now) };
    case 'quarterly': return { from: startOfQuarter(now), to: endOfDay(now) };
    case 'yearly':    return { from: startOfYear(now),    to: endOfDay(now) };
    default:          return { from: startOfMonth(now),   to: endOfDay(now) };
  }
}
