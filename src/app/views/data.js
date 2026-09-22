/**
 * Data view — export, import, activity categories and settings.
 *
 * The export exists because this data lives in exactly one browser profile.
 * JSON is the lossless backup; the CSVs are for spreadsheets and for feeding a
 * future report generator without having to parse the internal shape.
 */

import { el, sectionCard, table, num, toast, reportError } from '../ui.js';
import {
  buildBackup, restoreBackup, download, stamp,
  sessionsCsv, findingsCsv, historyCsv, programsCsv, dailyCsv,
} from '../../lib/backup.js';
import { dailySeries } from '../../lib/analytics.js';
import { dateKey } from '../../lib/time.js';
import { CURRENCIES, DEFAULT_ACTIVITIES, newId } from '../../lib/models.js';
import { saveSettings, wipeAll } from '../../lib/db.js';

export function renderData(root, ctx) {
  const { programs, sessions, findings, history, settings, reload } = ctx;

  /* --------------------------------------------------------------- export -- */
  async function exportJson() {
    try {
      const backup = await buildBackup();
      download(`bug-hunt-tracker-${stamp()}.json`, JSON.stringify(backup, null, 2));
      toast('JSON backup downloaded');
    } catch (err) {
      reportError(err, 'exporting JSON');
    }
  }

  function exportCsv(kind) {
    try {
      switch (kind) {
        case 'sessions':
          download(`sessions-${stamp()}.csv`, sessionsCsv(sessions, programs), 'text/csv'); break;
        case 'findings':
          download(`findings-${stamp()}.csv`, findingsCsv(findings, programs), 'text/csv'); break;
        case 'history':
          download(`finding-history-${stamp()}.csv`, historyCsv(history, findings), 'text/csv'); break;
        case 'programs':
          download(`programs-${stamp()}.csv`, programsCsv(programs), 'text/csv'); break;
        case 'daily': {
          const keys = sessions.map((s) => s.date).sort();
          const rows = keys.length
            ? dailySeries(sessions, findings, keys[0], dateKey())
            : [];
          download(`daily-${stamp()}.csv`, dailyCsv(rows), 'text/csv');
          break;
        }
        default: return;
      }
      toast('CSV downloaded');
    } catch (err) {
      reportError(err, 'exporting CSV');
    }
  }

  const fileInput = el('input', {
    type: 'file', accept: 'application/json,.json', style: { display: 'none' },
    onChange: async (event) => {
      const file = event.target.files?.[0];
      event.target.value = ''; // allow re-picking the same file
      if (!file) return;
      try {
        const payload = JSON.parse(await file.text());
        const counts = payload?.counts ?? payload?.data ?? {};
        const summary = `programs: ${counts.programs ?? '?'}, sessions: ${counts.sessions ?? '?'}, findings: ${counts.findings ?? '?'}`;
        if (!confirm(`Import will REPLACE all current data with the backup (${summary}).\n\nContinue?`)) return;
        const done = await restoreBackup(payload);
        toast(`Imported ${done.sessions ?? 0} sessions and ${done.findings ?? 0} findings`);
        await reload();
      } catch (err) {
        reportError(err, 'importing backup');
      }
    },
  });

  const exportPanel = sectionCard('Export & Backup',
    el('div', {},
      el('p', { class: 'dim para' },
        'Everything lives in this browser profile only. Export regularly — a cleared profile takes the history with it.'),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn-primary btn-sm', onClick: exportJson }, 'Export JSON (full backup)'),
        el('button', { class: 'btn-sm', onClick: () => exportCsv('sessions') }, 'Sessions CSV'),
        el('button', { class: 'btn-sm', onClick: () => exportCsv('findings') }, 'Findings CSV'),
        el('button', { class: 'btn-sm', onClick: () => exportCsv('history') }, 'History CSV'),
        el('button', { class: 'btn-sm', onClick: () => exportCsv('programs') }, 'Programs CSV'),
        el('button', { class: 'btn-sm', onClick: () => exportCsv('daily') }, 'Daily rollup CSV')),
      el('div', { class: 'btn-row', style: { marginTop: '12px' } },
        el('button', { class: 'btn-sm', onClick: () => fileInput.click() }, 'Import JSON backup…'),
        fileInput),
      el('div', { class: 'dim', style: { marginTop: '10px', fontSize: '12px' } },
        `Currently stored: ${programs.length} programs · ${sessions.length} sessions · ${findings.length} findings · ${history.length} history entries`)));

  /* ----------------------------------------------------------- activities -- */
  const activityRows = settings.activities.map((a) => [
    el('span', { class: 'act-swatch', style: { background: a.color } }),
    a.label,
    el('span', { class: 'dim mono' }, a.id),
    el('span', { class: a.archived ? 'dim' : 'tone-go' }, a.archived ? 'Hidden' : 'Shown'),
    el('div', { class: 'btn-row' },
      el('button', {
        class: 'btn-sm',
        onClick: () => toggleActivity(a.id),
      }, a.archived ? 'Show' : 'Hide'),
      el('button', {
        class: 'btn-sm',
        onClick: () => renameActivity(a.id, a.label),
      }, 'Rename')),
  ]);

  async function toggleActivity(id) {
    try {
      const next = settings.activities.map((a) => (a.id === id ? { ...a, archived: !a.archived } : a));
      // Hiding is deliberately non-destructive: past sessions keep pointing at
      // the activity id, so old breakdowns stay intact.
      await saveSettings({ activities: next });
      await reload();
    } catch (err) {
      reportError(err, 'updating activities');
    }
  }

  async function renameActivity(id, current) {
    const label = prompt('Activity name', current);
    if (!label || !label.trim()) return;
    try {
      const next = settings.activities.map((a) => (a.id === id ? { ...a, label: label.trim() } : a));
      await saveSettings({ activities: next });
      await reload();
      toast('Activity renamed');
    } catch (err) {
      reportError(err, 'renaming activity');
    }
  }

  const newActivityInput = el('input', { type: 'text', placeholder: 'e.g. Automation', maxlength: '30' });
  async function addActivity() {
    const label = newActivityInput.value.trim();
    if (!label) return;
    try {
      const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || newId('a_');
      if (settings.activities.some((a) => a.id === id)) {
        toast('That activity already exists', 'err');
        return;
      }
      const palette = ['#f472b6', '#22d3ee', '#a3e635', '#c084fc', '#fb7185'];
      const color = palette[settings.activities.length % palette.length];
      await saveSettings({ activities: [...settings.activities, { id, label, color, archived: false }] });
      newActivityInput.value = '';
      await reload();
      toast(`${label} added`);
    } catch (err) {
      reportError(err, 'adding activity');
    }
  }

  const activitiesPanel = sectionCard('Activity Categories',
    el('div', {},
      table(['', 'Name', 'ID', 'In picker', ''], activityRows),
      el('div', { class: 'btn-row', style: { marginTop: '12px' } },
        newActivityInput,
        el('button', { class: 'btn-sm', onClick: addActivity }, 'Add activity'))));

  /* ------------------------------------------------------------- settings -- */
  const currencySelect = el('select', {
    onChange: async (e) => {
      try {
        await saveSettings({ defaultCurrency: e.target.value });
        await reload();
        toast('Default currency updated');
      } catch (err) {
        reportError(err, 'saving settings');
      }
    },
  }, CURRENCIES.map((c) => el('option', { value: c, selected: settings.defaultCurrency === c || null }, c)));

  const weekSelect = el('select', {
    onChange: async (e) => {
      try {
        await saveSettings({ weekStartsOn: Number(e.target.value) });
        await reload();
        toast('Week start updated');
      } catch (err) {
        reportError(err, 'saving settings');
      }
    },
  },
    el('option', { value: '1', selected: settings.weekStartsOn === 1 || null }, 'Monday'),
    el('option', { value: '0', selected: settings.weekStartsOn === 0 || null }, 'Sunday'));

  const minSessionSelect = el('select', {
    onChange: async (e) => {
      try {
        await saveSettings({ minSessionMs: Number(e.target.value) });
        await reload();
        toast('Minimum session length updated');
      } catch (err) {
        reportError(err, 'saving settings');
      }
    },
  }, [0, 30000, 60000, 300000].map((ms) => el('option', {
    value: String(ms), selected: settings.minSessionMs === ms || null,
  }, ms === 0 ? 'Save everything' : `${ms / 1000}s`)));

  async function erase() {
    if (!confirm('Erase ALL local data — programs, sessions, findings and history?')) return;
    if (!confirm('This cannot be undone. Export a backup first if you have not. Really erase everything?')) return;
    try {
      await wipeAll();
      await reload();
      toast('All data erased');
    } catch (err) {
      reportError(err, 'erasing data');
    }
  }

  const field = (label, control, hint) => el('div', { class: 'field' },
    el('label', {}, label), control,
    hint ? el('div', { class: 'dim', style: { marginTop: '4px', fontSize: '11.5px' } }, hint) : null);

  const settingsPanel = sectionCard('Settings',
    el('div', { class: 'editor-form' },
      el('div', { class: 'field-row' },
        field('Default currency', currencySelect),
        field('Week starts on', weekSelect)),
      field('Discard sessions shorter than', minSessionSelect,
        'Protects the session count from accidental start/stop taps.'),
      el('div', { class: 'danger-zone' },
        el('div', {},
          el('strong', {}, 'Erase all data'),
          el('div', { class: 'dim', style: { fontSize: '11.5px' } }, 'Irreversible. Export a backup first.')),
        el('button', { class: 'btn-danger btn-sm', onClick: erase }, 'Erase everything'))));

  root.append(
    el('div', { class: 'view-head' },
      el('div', {}, el('h2', {}, 'Data'),
        el('div', { class: 'dim' }, 'Backups, categories and preferences — all local'))),
    el('div', { class: 'grid-2' }, exportPanel, activitiesPanel),
    settingsPanel,
  );
}
