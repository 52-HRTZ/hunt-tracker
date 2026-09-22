/**
 * Time helpers. Everything is computed in the user's LOCAL timezone:
 * a hunting day is the day it felt like, not a UTC boundary.
 */

const MS_MIN = 60 * 1000;
const MS_HOUR = 60 * MS_MIN;
const MS_DAY = 24 * MS_HOUR;

export const MS = { MIN: MS_MIN, HOUR: MS_HOUR, DAY: MS_DAY };

/** 'YYYY-MM-DD' for a timestamp, in local time. This is the day key everything aggregates on. */
export function dateKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 'YYYY-MM' month key for a timestamp, local time. */
export function monthKey(ts = Date.now()) {
  return dateKey(ts).slice(0, 7);
}

/** Local midnight (start of day) for a timestamp. */
export function startOfDay(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function endOfDay(ts = Date.now()) {
  return startOfDay(ts) + MS_DAY;
}

/** Start of week. weekStartsOn: 0 = Sunday, 1 = Monday (default). */
export function startOfWeek(ts = Date.now(), weekStartsOn = 1) {
  const d = new Date(startOfDay(ts));
  const diff = (d.getDay() - weekStartsOn + 7) % 7;
  d.setDate(d.getDate() - diff);
  return d.getTime();
}

export function startOfMonth(ts = Date.now()) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

export function startOfQuarter(ts = Date.now()) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1).getTime();
}

export function startOfYear(ts = Date.now()) {
  return new Date(new Date(ts).getFullYear(), 0, 1).getTime();
}

/** Parse a 'YYYY-MM-DD' day key back into a local-midnight timestamp. */
export function dateKeyToTs(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/** Day key + n days (calendar-safe across DST). */
export function addDays(key, n) {
  const d = new Date(dateKeyToTs(key));
  d.setDate(d.getDate() + n);
  return dateKey(d.getTime());
}

/** Inclusive list of day keys from `fromKey` to `toKey`. */
export function dayKeyRange(fromKey, toKey) {
  const out = [];
  let cur = fromKey;
  // Guard against a pathological range so a bad input can never hang the UI.
  for (let i = 0; i < 4000 && cur <= toKey; i++) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

/**
 * Named period -> {from, to, label}. `to` is exclusive.
 * These are the dashboard's filter buttons.
 */
export function periodRange(period, now = Date.now(), weekStartsOn = 1) {
  switch (period) {
    case 'today':
      return { from: startOfDay(now), to: endOfDay(now), label: 'Today' };
    case 'week':
      return { from: startOfWeek(now, weekStartsOn), to: endOfDay(now), label: 'This Week' };
    case 'month':
      return { from: startOfMonth(now), to: endOfDay(now), label: 'This Month' };
    case 'quarter':
      return { from: startOfQuarter(now), to: endOfDay(now), label: 'This Quarter' };
    case 'year':
      return { from: startOfYear(now), to: endOfDay(now), label: 'This Year' };
    case 'all':
    default:
      return { from: 0, to: Number.MAX_SAFE_INTEGER, label: 'All Time' };
  }
}

/** 5_100_000 -> '1h 25m'. The house format for durations. */
export function formatDuration(ms) {
  if (!ms || ms < 0) ms = 0;
  const totalMin = Math.floor(ms / MS_MIN);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

/** 5_100_000 -> '01:25:00'. Used by the running timer only. */
export function formatClock(ms) {
  if (!ms || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/** Short badge form for the toolbar icon: '5m', '1h2'. */
export function formatBadge(ms) {
  const totalMin = Math.floor(Math.max(0, ms) / MS_MIN);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  if (h < 10) return `${h}h${Math.floor((totalMin % 60) / 10)}`;
  return `${h}h`;
}

export function formatTimeOfDay(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** '2026-09-06' -> 'September 6, 2026' */
export function formatDayLong(key) {
  const [y, m, d] = key.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** '2026-09-06' -> 'Sep 6' */
export function formatDayShort(key) {
  const [, m, d] = key.split('-').map(Number);
  return `${MONTHS[m - 1].slice(0, 3)} ${d}`;
}

/** '2026-09' -> 'September 2026' */
export function formatMonthLong(key) {
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export function hoursOf(ms) {
  return ms / MS_HOUR;
}

/**
 * Parse a value from <input type="date"> ("YYYY-MM-DD" or "") into an epoch-ms
 * timestamp at local midnight, or null if the string is empty / invalid.
 */
export function parseDateInput(value) {
  if (!value || typeof value !== 'string') return null;
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return null;
  const ts = new Date(y, m - 1, d).getTime();
  return Number.isFinite(ts) ? ts : null;
}
