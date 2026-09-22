/**
 * Entity shapes, vocabularies and factories.
 *
 * Design rule for V1: the timer collects raw facts (start/end timestamps),
 * findings carry a small state machine, and EVERY metric is derived at read
 * time. Nothing aggregated is ever stored, so a fixed aggregation bug can be
 * corrected by shipping new code — the raw data is never lossy.
 */

import { dateKey } from './time.js';

export const SCHEMA_VERSION = 1;

/** Default activity categories. User-editable in Settings. */
export const DEFAULT_ACTIVITIES = [
  { id: 'hunt', label: 'Hunt', color: '#f97316', archived: false },
  { id: 'recon', label: 'Recon', color: '#38bdf8', archived: false },
  { id: 'testing', label: 'Testing', color: '#a78bfa', archived: false },
  { id: 'reporting', label: 'Reporting', color: '#34d399', archived: false },
  { id: 'study', label: 'Study', color: '#fbbf24', archived: false },
];

/**
 * Finding lifecycle. `terminal` statuses stop the clock for time-to-* metrics.
 * `resolvedPositive` marks the outcomes that count as real signal.
 */
export const FINDING_STATUSES = [
  { id: 'new', label: 'New', color: '#94a3b8' },
  { id: 'testing', label: 'Testing', color: '#a78bfa' },
  { id: 'confirmed', label: 'Confirmed', color: '#38bdf8' },
  { id: 'reported', label: 'Reported', color: '#818cf8' },
  { id: 'triaged', label: 'Triaged', color: '#fbbf24' },
  { id: 'paid', label: 'Paid', color: '#34d399', terminal: true, resolvedPositive: true },
  { id: 'duplicate', label: 'Duplicate', color: '#f59e0b', terminal: true },
  { id: 'informative', label: 'Informative', color: '#64748b', terminal: true },
  { id: 'rejected', label: 'Rejected', color: '#f87171', terminal: true },
  { id: 'closed', label: 'Closed', color: '#475569', terminal: true, resolvedPositive: true },
];

export const STATUS_BY_ID = Object.fromEntries(FINDING_STATUSES.map((s) => [s.id, s]));

/** Statuses that mean "this was submitted to the program". */
export const REPORTED_STATUSES = ['reported', 'triaged', 'paid', 'duplicate', 'informative', 'rejected', 'closed'];

/** Statuses that mean "the program accepted it as a real issue". */
export const ACCEPTED_STATUSES = ['triaged', 'paid', 'closed'];

/** Statuses that mean "the program returned a negative verdict". */
export const REJECTED_STATUSES = ['duplicate', 'informative', 'rejected'];

export const SEVERITIES = [
  { id: 'critical', label: 'Critical', color: '#f43f5e', weight: 4 },
  { id: 'high', label: 'High', color: '#fb923c', weight: 3 },
  { id: 'medium', label: 'Medium', color: '#fbbf24', weight: 2 },
  { id: 'low', label: 'Low', color: '#38bdf8', weight: 1 },
  { id: 'info', label: 'Informational', color: '#94a3b8', weight: 0 },
];

export const SEVERITY_BY_ID = Object.fromEntries(SEVERITIES.map((s) => [s.id, s]));

/** Suggested vulnerability types. Free text is always allowed — this is only a datalist. */
export const VULN_TYPES = [
  'IDOR / BOLA', 'Broken Access Control', 'XSS (Reflected)', 'XSS (Stored)', 'XSS (DOM)',
  'SQL Injection', 'SSRF', 'CSRF', 'RCE', 'XXE', 'Open Redirect', 'Path Traversal',
  'Authentication Bypass', 'Business Logic', 'Information Disclosure', 'Subdomain Takeover',
  'Race Condition', 'Insecure Deserialization', 'Rate Limiting', 'Misconfiguration', 'Other',
];

export const PLATFORMS = ['HackerOne', 'Bugcrowd', 'Intigriti', 'YesWeHack', 'Synack', 'Private', 'Self-hosted', 'Other'];

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'INR', 'BRL'];

/** Collision-resistant id without pulling in a dependency. */
export function newId(prefix = '') {
  const rand = (crypto?.randomUUID?.() ?? `${Math.random()}`).replace(/-/g, '').slice(0, 12);
  return `${prefix}${Date.now().toString(36)}${rand}`;
}

export function makeProgram(input = {}) {
  const now = Date.now();
  return {
    id: input.id ?? newId('p_'),
    name: (input.name ?? '').trim(),
    url: (input.url ?? '').trim(),
    platform: input.platform ?? '',
    active: input.active !== false,
    notes: input.notes ?? '',
    createdAt: input.createdAt ?? now,
    updatedAt: now,
  };
}

export function makeSession(input = {}) {
  const startTime = input.startTime ?? Date.now();
  const endTime = input.endTime ?? Date.now();
  return {
    id: input.id ?? newId('s_'),
    programId: input.programId ?? null,
    activity: input.activity ?? 'hunt',
    startTime,
    endTime,
    // Stored redundantly with start/end so queries never have to recompute,
    // but always recomputable from the two timestamps if it ever drifts.
    durationMs: Math.max(0, endTime - startTime),
    // The local day the session STARTED on. A session that crosses midnight
    // is attributed to the day it began — that is how a hunter thinks about it.
    date: input.date ?? dateKey(startTime),
    note: input.note ?? '',
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function makeFinding(input = {}) {
  const now = Date.now();
  const status = input.status ?? 'new';
  return {
    id: input.id ?? newId('f_'),
    ref: input.ref ?? 0, // human-facing sequential number (#023)
    title: (input.title ?? '').trim(),
    type: input.type ?? '',
    programId: input.programId ?? null,
    severity: input.severity ?? 'medium',
    status,
    bounty: Number(input.bounty) || 0,
    currency: input.currency ?? 'USD',
    notes: input.notes ?? '',
    url: input.url ?? '',
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    // First time each status was entered. Denormalised from history so the
    // time-to-report / triage / payment metrics are a single lookup.
    statusTimestamps: input.statusTimestamps ?? { [status]: input.createdAt ?? now },
    // Day the bounty was actually paid; drives "bounty over time".
    paidAt: input.paidAt ?? null,
  };
}

export const GOAL_METRICS = [
  { id: 'findings', label: 'Findings',      unit: 'bugs',     icon: '🐛' },
  { id: 'bounty',   label: 'Paid Bounty',   unit: 'money',    icon: '💰' },
  { id: 'hours',    label: 'Focused Hours', unit: 'h',        icon: '⏱' },
  { id: 'sessions', label: 'Sessions',      unit: 'sessions', icon: '▶' },
];

export const GOAL_PERIODS = [
  { id: 'daily',     label: 'Daily'     },
  { id: 'weekly',    label: 'Weekly'    },
  { id: 'monthly',   label: 'Monthly'   },
  { id: 'quarterly', label: 'Quarterly' },
  { id: 'yearly',    label: 'Yearly'    },
];

export const GOAL_METRIC_BY_ID = Object.fromEntries(GOAL_METRICS.map((m) => [m.id, m]));
export const GOAL_PERIOD_BY_ID = Object.fromEntries(GOAL_PERIODS.map((p) => [p.id, p]));

export function makeGoal(input = {}) {
  const now = Date.now();
  return {
    id:        input.id        ?? newId('g_'),
    label:     (input.label    ?? '').trim(),
    metric:    input.metric    ?? 'findings',
    period:    input.period    ?? 'monthly',
    target:    Number(input.target) || 0,
    programId: input.programId ?? null,   // null = all programs
    active:    input.active    !== false,
    createdAt: input.createdAt ?? now,
    updatedAt: now,
  };
}

export function makeHistoryEntry(input = {}) {
  return {
    id: input.id ?? newId('h_'),
    findingId: input.findingId,
    timestamp: input.timestamp ?? Date.now(),
    field: input.field, // 'created' | 'status' | 'bounty' | 'severity' | 'title' | 'type' | 'program'
    oldValue: input.oldValue ?? null,
    newValue: input.newValue ?? null,
  };
}

export const DEFAULT_SETTINGS = {
  schemaVersion: SCHEMA_VERSION,
  defaultCurrency: 'USD',
  weekStartsOn: 1, // Monday
  activities: DEFAULT_ACTIVITIES,
  // Sessions shorter than this are discarded as mis-taps rather than saved.
  minSessionMs: 30 * 1000,
};
