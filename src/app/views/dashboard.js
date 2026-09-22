/**
 * Dashboard view — every number on this page is derived at render time from
 * the raw sessions and findings. Nothing here is stored or hand-maintained.
 */

import {
  el, statTile, sectionCard, barList, columnChart, table,
  money, num, pct, coarseDuration, pill,
} from '../ui.js';
import {
  summarize, timeByActivity, byProgram, byType, bySeverity, byStatus,
  dailySeries, monthlySeries, lifecycle, programResponse, currentStreak,
} from '../../lib/analytics.js';
import {
  periodRange, formatDuration, formatDayShort, formatMonthLong,
  dateKey, hoursOf, dateKeyToTs,
} from '../../lib/time.js';

const PERIODS = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This Week' },
  { id: 'month', label: 'This Month' },
  { id: 'quarter', label: 'This Quarter' },
  { id: 'all', label: 'All Time' },
];

/** Day keys spanning the selected period, clamped to days that have data. */
function seriesBounds(period, range, sessions, findings) {
  const today = dateKey();
  if (period === 'all') {
    const keys = [
      ...sessions.map((s) => s.date),
      ...findings.map((f) => dateKey(f.createdAt)),
    ].sort();
    const first = keys[0] ?? today;
    // Cap an all-time daily chart so a multi-year history stays readable.
    const fromTs = Math.max(dateKeyToTs(first), Date.now() - 180 * 86400000);
    return { fromKey: dateKey(fromTs), toKey: today };
  }
  return { fromKey: dateKey(range.from), toKey: today };
}

export function renderDashboard(root, ctx) {
  const { programs, sessions, findings, settings, period, onPeriodChange } = ctx;
  const range = periodRange(period, Date.now(), settings.weekStartsOn);
  const currency = settings.defaultCurrency;

  const inSessions = sessions.filter((s) => s.startTime >= range.from && s.startTime < range.to);
  const createdFindings = findings.filter((f) => f.createdAt >= range.from && f.createdAt < range.to);
  const s = summarize({ sessions, findings, from: range.from, to: range.to });

  /* ---------------------------------------------------------- filter row -- */
  const filters = el('div', { class: 'period-bar' },
    PERIODS.map((p) => el('button', {
      class: `period-btn${p.id === period ? ' is-active' : ''}`,
      onClick: () => onPeriodChange(p.id),
    }, p.label)));

  /* ------------------------------------------------------------- headline -- */
  const streak = currentStreak(sessions);
  const kpis = el('div', { class: 'stat-grid' },
    statTile('Focused Time', formatDuration(s.focusedMs), {
      sub: s.activeDays ? `${s.activeDays} active day${s.activeDays === 1 ? '' : 's'}` : null,
    }),
    statTile('Sessions', num(s.sessions), {
      sub: s.sessions ? `avg ${formatDuration(s.avgSessionMs)}` : null,
    }),
    statTile('Findings', num(s.findings)),
    statTile('Reports', num(s.reports), {
      sub: s.signalRate != null ? `${pct(s.signalRate)} accepted` : null,
      title: 'Findings submitted to a program in this period',
    }),
    statTile('Paid Findings', num(s.paidFindings), {
      sub: s.avgBounty != null ? `avg ${money(s.avgBounty, currency)}` : null,
    }),
    statTile('Paid Bounty', money(s.paidBounty, currency, { compact: true }), { tone: 'money' }),
    statTile('$ / Focused Hour', s.perHour != null ? money(s.perHour, currency) : '—', {
      tone: 'money',
      title: 'Bounty paid in this period divided by hours focused in this period',
    }),
    statTile('Hours / Finding', s.hoursPerFinding != null ? num(s.hoursPerFinding, 1) : '—', {
      title: 'Focused hours spent per finding discovered',
    }));

  const context = el('div', { class: 'dash-context dim' },
    range.label,
    streak > 1 ? el('span', { class: 'streak-badge' }, `🔥 ${streak} day streak`) : null);

  /* -------------------------------------------------------------- charts -- */
  const { fromKey, toKey } = seriesBounds(period, range, sessions, findings);
  const daily = dailySeries(sessions, findings, fromKey, toKey);

  const focusChart = sectionCard('Daily Focused Hours',
    columnChart(
      daily.map((d) => ({
        label: formatDayShort(d.key),
        value: hoursOf(d.focusedMs),
        highlight: d.key === dateKey(),
      })),
      { format: (v) => formatDuration(v * 3600000), color: 'var(--accent)' },
    ));

  const findingsChart = sectionCard('Findings Over Time',
    columnChart(
      daily.map((d) => ({ label: formatDayShort(d.key), value: d.findings })),
      { format: (v) => `${v} finding${v === 1 ? '' : 's'}`, color: 'var(--info)' },
    ));

  const bountyChart = sectionCard('Bounty Over Time (paid)',
    columnChart(
      daily.map((d) => ({ label: formatDayShort(d.key), value: d.bounty })),
      { format: (v) => money(v, currency), color: 'var(--money)', emptyText: 'No bounties paid yet' },
    ));

  /* ---------------------------------------------------------- breakdowns -- */
  const activityRows = timeByActivity(inSessions, settings.activities);
  const activityPanel = sectionCard('Time by Activity',
    barList(activityRows, {
      format: (v, row) => `${formatDuration(v)}${row.sessions ? ` · ${row.sessions}` : ''}`,
    }));

  const programRows = byProgram(inSessions, createdFindings, programs);
  const programPanel = sectionCard('Time by Program',
    barList(programRows.map((r) => ({
      ...r,
      color: 'var(--info)',
      note: r.findings ? `${r.findings}F` : null,
    })), { format: (v) => formatDuration(v), emptyText: 'No sessions in this period' }));

  const typeRows = byType(createdFindings);
  const typePanel = sectionCard('Findings by Type',
    barList(typeRows.map((r) => ({
      ...r,
      color: 'var(--warn)',
      note: r.bounty ? money(r.bounty, currency, { compact: true }) : null,
    })), { format: (v) => num(v), emptyText: 'No findings in this period' }));

  const severityPanel = sectionCard('Findings by Severity',
    barList(bySeverity(createdFindings), { format: (v) => num(v), emptyText: 'No findings in this period' }));

  const statusPanel = sectionCard('Finding Pipeline (all time)',
    barList(byStatus(findings), { format: (v) => num(v), emptyText: 'No findings yet' }));

  /* ------------------------------------------------- bounty by dimension -- */
  const bountyByProgram = programRows
    .filter((r) => r.bounty > 0)
    .map((r) => ({ ...r, value: r.bounty, color: 'var(--money)' }));
  const bountyProgramPanel = sectionCard('Bounty by Program',
    barList(bountyByProgram, {
      format: (v) => money(v, currency),
      emptyText: 'No paid bounties in this period',
    }));

  const bountyByType = typeRows
    .filter((r) => r.bounty > 0)
    .map((r) => ({ ...r, value: r.bounty, color: 'var(--money)' }));
  const bountyTypePanel = sectionCard('Bounty by Type',
    barList(bountyByType, {
      format: (v) => money(v, currency),
      emptyText: 'No paid bounties in this period',
    }));

  /* --------------------------------------------------------- lifecycle --- */
  const lc = lifecycle(findings);
  const lifecyclePanel = sectionCard('Finding Lifecycle (all time)',
    el('div', { class: 'mini-grid' },
      statTile('Discovery → Report', coarseDuration(lc.avgTimeToReportMs), { sub: `${lc.counted.report} findings` }),
      statTile('Report → Triage', coarseDuration(lc.avgTimeToTriageMs), { sub: `${lc.counted.triage} findings` }),
      statTile('Triage → Payment', coarseDuration(lc.avgTimeToPaymentMs), { sub: `${lc.counted.payment} findings` }),
      statTile('Discovery → Paid', coarseDuration(lc.avgDiscoveryToPaidMs), { sub: `${lc.counted.discoveryToPaid} findings` })));

  const responseRows = programResponse(findings, programs);
  const responsePanel = sectionCard('Program Response Time',
    barList(responseRows.map((r) => ({ ...r, color: 'var(--info)', note: `n=${r.n}` })), {
      format: (v) => coarseDuration(v),
      emptyText: 'Needs findings that reached triage',
    }));

  /* ----------------------------------------------------------- by month -- */
  const months = monthlySeries(sessions, findings).slice(-14).reverse();
  const monthTable = sectionCard('Monthly Rollup',
    table(
      ['Month',
        { label: 'Focused', align: 'right' },
        { label: 'Sessions', align: 'right' },
        { label: 'Findings', align: 'right' },
        { label: 'Reports', align: 'right' },
        { label: 'Bounty', align: 'right' },
        { label: '$/Hour', align: 'right' }],
      months.map((m) => {
        const hours = hoursOf(m.focusedMs);
        return [
          formatMonthLong(m.key),
          formatDuration(m.focusedMs),
          num(m.sessions),
          num(m.findings),
          num(m.reports),
          el('span', { class: m.bounty ? 'tone-money' : 'dim' }, money(m.bounty, currency)),
          hours > 0 ? money(m.bounty / hours, currency) : '—',
        ];
      }),
      { emptyText: 'Start a session to see monthly totals' },
    ));

  root.append(
    el('div', { class: 'view-head' },
      el('div', {}, el('h2', {}, 'Dashboard'), context),
      filters),
    kpis,
    focusChart,
    el('div', { class: 'grid-2' }, findingsChart, bountyChart),
    el('div', { class: 'grid-3' }, activityPanel, programPanel, typePanel),
    el('div', { class: 'grid-3' }, severityPanel, bountyProgramPanel, bountyTypePanel),
    el('div', { class: 'grid-2' }, lifecyclePanel, el('div', { class: 'stack' }, statusPanel, responsePanel)),
    monthTable,
  );
}
