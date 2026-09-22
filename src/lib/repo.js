/**
 * Domain operations. The UI talks to this module only — it never touches
 * IndexedDB or chrome.storage directly. Every write that changes a finding
 * goes through `updateFinding`, which is the single place history is recorded.
 */

import * as db from './db.js';
import * as store from './store.js';
import {
  makeProgram, makeSession, makeFinding, makeGoal, newId,
  STATUS_BY_ID, SEVERITY_BY_ID,
} from './models.js';
import { dateKey } from './time.js';

/* -------------------------------------------------------------- programs -- */

export async function listPrograms({ includeInactive = true } = {}) {
  const all = await db.getAll(db.STORE.PROGRAMS);
  const filtered = includeInactive ? all : all.filter((p) => p.active);
  return filtered.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getProgram(id) {
  if (!id) return null;
  return (await db.get(db.STORE.PROGRAMS, id)) ?? null;
}

export async function saveProgram(input) {
  const name = (input.name ?? '').trim();
  if (!name) throw new Error('Program name is required');

  const existing = input.id ? await getProgram(input.id) : null;
  const all = await listPrograms();
  const clash = all.find(
    (p) => p.id !== input.id && p.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) throw new Error(`A program named "${clash.name}" already exists`);

  const program = makeProgram({ ...existing, ...input, name });
  await db.put(db.STORE.PROGRAMS, program);
  return program;
}

/**
 * Programs are permanent entities, so deletion is deliberately conservative:
 * a program that any session or finding points at can only be deactivated,
 * never removed — otherwise historical analytics would silently lose a label.
 */
export async function deleteProgram(id) {
  const sessions = await db.getAllByIndex(db.STORE.SESSIONS, 'programId', IDBKeyRange.only(id));
  const findings = await db.getAllByIndex(db.STORE.FINDINGS, 'programId', IDBKeyRange.only(id));
  if (sessions.length || findings.length) {
    const err = new Error(
      `In use by ${sessions.length} session(s) and ${findings.length} finding(s). Set it to inactive instead.`,
    );
    err.code = 'PROGRAM_IN_USE';
    throw err;
  }
  await db.remove(db.STORE.PROGRAMS, id);
}

/* --------------------------------------------------------------- timer ---- */

/**
 * START. Records the start timestamp and nothing else — the whole point is
 * that pressing START costs one click and asks zero questions.
 */
export async function startSession({ programId, activity }) {
  const running = await store.getActiveSession();
  if (running) {
    const err = new Error('A session is already running');
    err.code = 'ALREADY_RUNNING';
    throw err;
  }
  const active = {
    id: newId('s_'),
    programId: programId ?? null,
    activity: activity ?? 'hunt',
    startTime: Date.now(),
  };
  await store.setActiveSession(active);
  await store.setPrefs({ lastProgramId: active.programId, lastActivity: active.activity });
  await store.clearLastSaved();
  return active;
}

/**
 * STOP. Computes the duration, writes the session, and returns a summary for
 * the confirmation line. No form, ever.
 */
export async function stopSession({ note = '' } = {}) {
  const active = await store.getActiveSession();
  if (!active) {
    const err = new Error('No session is running');
    err.code = 'NOT_RUNNING';
    throw err;
  }
  const settings = await db.getSettings();
  const endTime = Date.now();
  const durationMs = Math.max(0, endTime - active.startTime);

  // A mis-tap (start then immediately stop) is discarded rather than polluting
  // the session count, which would quietly skew sessions-per-day and $/session.
  if (durationMs < settings.minSessionMs) {
    await store.clearActiveSession();
    return { discarded: true, durationMs };
  }

  const session = makeSession({
    id: active.id,
    programId: active.programId,
    activity: active.activity,
    startTime: active.startTime,
    endTime,
    note,
  });
  await db.put(db.STORE.SESSIONS, session);
  await store.clearActiveSession();
  await store.setLastSaved({
    durationMs: session.durationMs,
    date: session.date,
    activity: session.activity,
    programId: session.programId,
    at: endTime,
  });
  return { discarded: false, session };
}

/** Abandon the running timer without saving anything. */
export async function cancelSession() {
  await store.clearActiveSession();
}

/** Elapsed time of the running session, always derived from the stored start. */
export function elapsedOf(active, now = Date.now()) {
  if (!active) return 0;
  return Math.max(0, now - active.startTime);
}

/* ------------------------------------------------------------- sessions -- */

export async function listSessions({ from = 0, to = Number.MAX_SAFE_INTEGER } = {}) {
  const range = from === 0 && to === Number.MAX_SAFE_INTEGER
    ? null
    : IDBKeyRange.bound(from, to, false, true);
  const rows = await db.getAllByIndex(db.STORE.SESSIONS, 'startTime', range);
  return rows.sort((a, b) => a.startTime - b.startTime);
}

export async function sessionsForDay(key) {
  const rows = await db.getAllByIndex(db.STORE.SESSIONS, 'date', IDBKeyRange.only(key));
  return rows.sort((a, b) => a.startTime - b.startTime);
}

export async function updateSession(id, patch) {
  const existing = await db.get(db.STORE.SESSIONS, id);
  if (!existing) throw new Error('Session not found');
  const merged = makeSession({ ...existing, ...patch });
  merged.createdAt = existing.createdAt;
  await db.put(db.STORE.SESSIONS, merged);
  return merged;
}

export async function deleteSession(id) {
  await db.remove(db.STORE.SESSIONS, id);
}

/* ------------------------------------------------------------- findings -- */

export async function listFindings() {
  const rows = await db.getAll(db.STORE.FINDINGS);
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getFinding(id) {
  return (await db.get(db.STORE.FINDINGS, id)) ?? null;
}

export async function createFinding(input) {
  const title = (input.title ?? '').trim();
  if (!title) throw new Error('Finding title is required');

  const settings = await db.getSettings();
  const ref = await db.nextFindingRef();
  const finding = makeFinding({
    ...input,
    title,
    ref,
    currency: input.currency || settings.defaultCurrency,
  });

  // The creation event is itself history, so "time to X" can always be measured
  // from a real recorded event rather than from an implicit createdAt.
  const history = [{
    findingId: finding.id,
    timestamp: finding.createdAt,
    field: 'created',
    oldValue: null,
    newValue: finding.status,
  }];
  await db.putFindingWithHistory(finding, history);
  return finding;
}

/** Fields whose changes are worth an audit-trail entry. */
const TRACKED_FIELDS = ['status', 'bounty', 'severity', 'title', 'type', 'programId', 'currency'];

/**
 * The only mutation path for findings. Diffs the tracked fields, appends the
 * history rows, and maintains the denormalised status milestones — all inside
 * one transaction.
 */
export async function updateFinding(id, patch) {
  const existing = await getFinding(id);
  if (!existing) throw new Error('Finding not found');

  const next = makeFinding({ ...existing, ...patch });
  next.id = existing.id;
  next.ref = existing.ref;
  next.createdAt = existing.createdAt;
  next.statusTimestamps = { ...(existing.statusTimestamps ?? {}) };
  next.paidAt = existing.paidAt ?? null;

  const now = Date.now();
  const history = [];
  for (const field of TRACKED_FIELDS) {
    if (!(field in patch)) continue;
    const before = existing[field];
    const after = next[field];
    if (before === after) continue;
    history.push({ findingId: id, timestamp: now, field, oldValue: before, newValue: after });
  }

  if (history.some((h) => h.field === 'status')) {
    // Record the FIRST time a status is reached. Re-entering a status later
    // (e.g. reopened, reported again) must not move the original milestone,
    // or time-to-report would shrink retroactively.
    if (!next.statusTimestamps[next.status]) next.statusTimestamps[next.status] = now;
    if (next.status === 'paid' && !next.paidAt) next.paidAt = now;
  }

  // A bounty entered while already in "paid" still needs a payment date.
  if (next.status === 'paid' && next.bounty > 0 && !next.paidAt) next.paidAt = now;
  if (next.status !== 'paid' && next.bounty === 0) next.paidAt = existing.paidAt;

  next.updatedAt = history.length ? now : existing.updatedAt;
  await db.putFindingWithHistory(next, history);
  return next;
}

export async function deleteFinding(id) {
  await db.deleteFindingCascade(id);
}

export async function historyFor(findingId) {
  const rows = await db.getAllByIndex(db.STORE.HISTORY, 'findingId', IDBKeyRange.only(findingId));
  return rows.sort((a, b) => a.timestamp - b.timestamp);
}

export async function allHistory() {
  const rows = await db.getAll(db.STORE.HISTORY);
  return rows.sort((a, b) => a.timestamp - b.timestamp);
}

/* -------------------------------------------------------------- goals ---- */

export async function listGoals({ includeInactive = false } = {}) {
  const all = await db.getAll(db.STORE.GOALS);
  const rows = includeInactive ? all : all.filter((g) => g.active);
  return rows.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getGoal(id) {
  return (await db.get(db.STORE.GOALS, id)) ?? null;
}

export async function saveGoal(input) {
  if (!input.target || Number(input.target) <= 0)
    throw new Error('Target must be a positive number');
  if (!input.metric) throw new Error('Metric is required');
  if (!input.period) throw new Error('Period is required');

  const existing = input.id ? await getGoal(input.id) : null;
  const goal = makeGoal({ ...existing, ...input });
  await db.put(db.STORE.GOALS, goal);
  return goal;
}

export async function deleteGoal(id) {
  await db.remove(db.STORE.GOALS, id);
}

export async function toggleGoalActive(id) {
  const goal = await getGoal(id);
  if (!goal) throw new Error('Goal not found');
  return saveGoal({ ...goal, active: !goal.active });
}

/* ------------------------------------------------------------ formatting -- */

export function statusLabel(id) {
  return STATUS_BY_ID[id]?.label ?? id ?? '—';
}

export function severityLabel(id) {
  return SEVERITY_BY_ID[id]?.label ?? id ?? '—';
}

/** Everything the dashboard needs, in one round trip. */
export async function loadAll() {
  const [programs, sessions, findings, history, goals, settings, prefs, active] = await Promise.all([
    listPrograms(),
    listSessions(),
    listFindings(),
    allHistory(),
    listGoals({ includeInactive: true }),
    db.getSettings(),
    store.getPrefs(),
    store.getActiveSession(),
  ]);
  return { programs, sessions, findings, history, goals, settings, prefs, active, today: dateKey() };
}
