/**
 * Export / import. This is the safety net for data that exists in exactly one
 * place (this browser profile), so the JSON export is lossless and round-trips:
 * export -> wipe -> import must reproduce byte-identical entities.
 */

import * as db from './db.js';
import { SCHEMA_VERSION } from './models.js';
import { dateKey, formatDuration, formatTimeOfDay } from './time.js';

export const BACKUP_KIND = 'bug-hunt-tracker-backup';

export async function buildBackup() {
  const [programs, sessions, findings, history, settings, refCounter, goals] = await Promise.all([
    db.getAll(db.STORE.PROGRAMS),
    db.getAll(db.STORE.SESSIONS),
    db.getAll(db.STORE.FINDINGS),
    db.getAll(db.STORE.HISTORY),
    db.getSettings(),
    db.getMeta('findingRefCounter', 0),
    db.getAll(db.STORE.GOALS),
  ]);
  return {
    kind: BACKUP_KIND,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    counts: {
      programs: programs.length, sessions: sessions.length,
      findings: findings.length, history: history.length,
      goals: goals.length,
    },
    data: { programs, sessions, findings, history, goals, settings, findingRefCounter: refCounter },
  };
}

/**
 * Replace all local data with a backup file's contents.
 * Deliberately destructive and all-or-nothing: merging two histories would
 * silently duplicate sessions, which corrupts every time-based metric.
 */
export async function restoreBackup(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('File is not valid JSON');
  if (payload.kind !== BACKUP_KIND) throw new Error('Not a Bug Hunt Tracker backup file');
  if (Number(payload.schemaVersion) > SCHEMA_VERSION) {
    throw new Error(`Backup was made by a newer version (schema ${payload.schemaVersion}). Update the extension first.`);
  }
  const d = payload.data ?? {};
  for (const key of ['programs', 'sessions', 'findings', 'history']) {
    if (d[key] != null && !Array.isArray(d[key])) throw new Error(`Backup field "${key}" is malformed`);
  }

  await db.wipeAll();
  await db.putMany(db.STORE.PROGRAMS, d.programs ?? []);
  await db.putMany(db.STORE.SESSIONS, d.sessions ?? []);
  await db.putMany(db.STORE.FINDINGS, d.findings ?? []);
  await db.putMany(db.STORE.HISTORY, d.history ?? []);
  await db.putMany(db.STORE.GOALS, d.goals ?? []);
  if (d.settings) await db.saveSettings(d.settings);

  // Keep issuing finding numbers above anything already present, so a restored
  // database cannot mint a #23 that collides with an existing #23.
  const maxRef = (d.findings ?? []).reduce((m, f) => Math.max(m, f.ref | 0), 0);
  await db.setMeta('findingRefCounter', Math.max(maxRef, d.findingRefCounter | 0));

  return payload.counts ?? {
    programs: (d.programs ?? []).length, sessions: (d.sessions ?? []).length,
    findings: (d.findings ?? []).length, history: (d.history ?? []).length,
  };
}

/* ------------------------------------------------------------------ CSV -- */

/** RFC-4180 escaping: quote anything containing a comma, quote or newline. */
export function csvCell(value) {
  if (value == null) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return lines.join('\r\n');
}

const iso = (ts) => (ts == null ? '' : new Date(ts).toISOString());

export function sessionsCsv(sessions, programs) {
  const names = new Map(programs.map((p) => [p.id, p.name]));
  const rows = [...sessions]
    .sort((a, b) => a.startTime - b.startTime)
    .map((s) => [
      s.id, s.date, formatTimeOfDay(s.startTime), formatTimeOfDay(s.endTime),
      iso(s.startTime), iso(s.endTime),
      (s.durationMs / 60000).toFixed(2), formatDuration(s.durationMs),
      s.activity, names.get(s.programId) ?? '', s.programId ?? '', s.note ?? '',
    ]);
  return toCsv(
    ['id', 'date', 'start_local', 'end_local', 'start_iso', 'end_iso',
      'duration_minutes', 'duration_human', 'activity', 'program', 'program_id', 'note'],
    rows,
  );
}

export function findingsCsv(findings, programs) {
  const names = new Map(programs.map((p) => [p.id, p.name]));
  const rows = [...findings]
    .sort((a, b) => a.ref - b.ref)
    .map((f) => {
      const st = f.statusTimestamps ?? {};
      return [
        f.ref, f.id, f.title, f.type, names.get(f.programId) ?? '', f.programId ?? '',
        f.severity, f.status, f.bounty, f.currency,
        dateKey(f.createdAt), iso(f.createdAt), iso(f.updatedAt),
        iso(st.reported), iso(st.triaged), iso(f.paidAt ?? st.paid),
        (f.url ?? ''), (f.notes ?? '').replace(/\r?\n/g, ' '),
      ];
    });
  return toCsv(
    ['ref', 'id', 'title', 'type', 'program', 'program_id', 'severity', 'status',
      'bounty', 'currency', 'created_date', 'created_iso', 'updated_iso',
      'reported_iso', 'triaged_iso', 'paid_iso', 'url', 'notes'],
    rows,
  );
}

export function historyCsv(history, findings) {
  const refs = new Map(findings.map((f) => [f.id, f.ref]));
  const titles = new Map(findings.map((f) => [f.id, f.title]));
  const rows = [...history]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((h) => [
      h.id, refs.get(h.findingId) ?? '', titles.get(h.findingId) ?? '', h.findingId,
      iso(h.timestamp), dateKey(h.timestamp), h.field, h.oldValue ?? '', h.newValue ?? '',
    ]);
  return toCsv(
    ['id', 'finding_ref', 'finding_title', 'finding_id', 'timestamp_iso', 'date', 'field', 'old_value', 'new_value'],
    rows,
  );
}

export function programsCsv(programs) {
  const rows = [...programs].map((p) => [
    p.id, p.name, p.url, p.platform, p.active ? 'active' : 'inactive', dateKey(p.createdAt), p.notes ?? '',
  ]);
  return toCsv(['id', 'name', 'url', 'platform', 'state', 'created_date', 'notes'], rows);
}

/**
 * Daily rollup CSV — the shape a spreadsheet or a future report generator
 * wants: one row per day, already joined across sessions and findings.
 */
export function dailyCsv(dailyRows) {
  const rows = dailyRows.map((d) => [
    d.key, (d.focusedMs / 3600000).toFixed(3), formatDuration(d.focusedMs),
    d.sessions, d.findings, d.bounty,
  ]);
  return toCsv(['date', 'focused_hours', 'focused_human', 'sessions', 'findings', 'bounty_paid'], rows);
}

/* ------------------------------------------------------------- download -- */

/** Trigger a file download from an extension page. */
export function download(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the download a tick to start before releasing the object URL.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function stamp() {
  return dateKey().replace(/-/g, '');
}
