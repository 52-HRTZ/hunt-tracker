/**
 * Day view — "September 6, 2026" with its totals and the raw session list.
 * This is the audit surface: if a dashboard number looks wrong, this is where
 * you see the individual sessions it was built from (and fix or delete one).
 */

import { el, statTile, sectionCard, barList, money, num, toast, reportError } from '../ui.js';
import { dayReport, activeDayKeys } from '../../lib/analytics.js';
import { formatDuration, formatDayLong, formatTimeOfDay, dateKey, addDays } from '../../lib/time.js';
import * as repo from '../../lib/repo.js';

export function renderDay(root, ctx) {
  const { programs, sessions, findings, settings, dayKey, onDayChange, reload } = ctx;
  const key = dayKey ?? dateKey();
  const report = dayReport(key, sessions, findings, settings.activities);
  const currency = settings.defaultCurrency;
  const programName = (id) => (id ? (programs.find((p) => p.id === id)?.name ?? 'Deleted program') : 'No program');
  const activityLabel = (id) => settings.activities.find((a) => a.id === id)?.label ?? id;

  const days = activeDayKeys(sessions, findings);
  const picker = el('select', {
    class: 'day-picker',
    onChange: (e) => onDayChange(e.target.value),
  },
    // Today is always offered even before it has any data.
    [dateKey(), ...days.filter((d) => d !== dateKey())]
      .sort((a, b) => b.localeCompare(a))
      .map((d) => el('option', { value: d, selected: d === key || null }, formatDayLong(d))));

  const nav = el('div', { class: 'day-nav' },
    el('button', { class: 'btn-sm', onClick: () => onDayChange(addDays(key, -1)) }, '←'),
    picker,
    el('button', {
      class: 'btn-sm',
      disabled: key >= dateKey() || null,
      onClick: () => onDayChange(addDays(key, 1)),
    }, '→'),
    key !== dateKey() ? el('button', { class: 'btn-sm', onClick: () => onDayChange(dateKey()) }, 'Today') : null);

  const stats = el('div', { class: 'stat-grid' },
    statTile('Focused Time', formatDuration(report.focusedMs)),
    statTile('Sessions', num(report.sessions)),
    statTile('Findings', num(report.findings)),
    statTile('Reports', num(report.reports)),
    statTile('Paid', money(report.paidBounty, currency), { tone: 'money' }));

  const activityPanel = sectionCard('Time by Activity',
    barList(report.activities, {
      format: (v, row) => `${formatDuration(v)}${row.sessions ? ` · ${row.sessions}` : ''}`,
      emptyText: 'No sessions on this day',
    }));

  async function removeSession(session) {
    if (!confirm(`Delete the ${formatTimeOfDay(session.startTime)} session (${formatDuration(session.durationMs)})?`)) return;
    try {
      await repo.deleteSession(session.id);
      toast('Session deleted');
      await reload();
    } catch (err) {
      reportError(err, 'deleting session');
    }
  }

  const sessionList = report.sessionList.length
    ? el('div', { class: 'session-list' },
      report.sessionList.map((s) => el('div', { class: 'session-row' },
        el('div', { class: 'session-time mono' },
          `${formatTimeOfDay(s.startTime)} → ${formatTimeOfDay(s.endTime)}`),
        el('div', { class: 'session-meta truncate' },
          el('span', { class: 'session-activity' }, activityLabel(s.activity)),
          el('span', { class: 'sep' }, '·'),
          programName(s.programId),
          s.note ? el('span', { class: 'dim' }, ` — ${s.note}`) : null),
        el('div', { class: 'session-dur mono' }, formatDuration(s.durationMs)),
        el('button', {
          class: 'btn-ghost btn-sm', title: 'Delete this session',
          onClick: () => removeSession(s),
        }, '✕'))))
    : el('div', { class: 'empty' }, 'No sessions recorded on this day');

  const findingList = report.findingList.length
    ? el('div', { class: 'session-list' },
      report.findingList.map((f) => el('div', { class: 'session-row' },
        el('div', { class: 'session-time mono' }, `#${f.ref}`),
        el('div', { class: 'session-meta truncate' },
          f.title,
          el('span', { class: 'sep' }, '·'),
          el('span', { class: 'dim' }, programName(f.programId))),
        el('div', { class: 'session-dur mono' }, f.type || '—'))))
    : el('div', { class: 'empty' }, 'No findings created on this day');

  root.append(
    el('div', { class: 'view-head' },
      el('div', {}, el('h2', {}, formatDayLong(key)),
        el('div', { class: 'dim' }, `${report.sessions} session${report.sessions === 1 ? '' : 's'} · ${formatDuration(report.focusedMs)} focused`)),
      nav),
    stats,
    el('div', { class: 'grid-2' },
      sectionCard('Sessions', sessionList),
      el('div', { class: 'stack' }, activityPanel, sectionCard('Findings Created', findingList))),
  );
}
