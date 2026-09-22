/**
 * Findings view — list, editor and audit trail.
 *
 * A finding is created with almost nothing (title only) and grows over days:
 * status moves, a bounty lands. Every one of those edits is recorded in
 * FindingHistory, which is what makes the lifecycle metrics possible later.
 */

import { el, sectionCard, table, money, num, pill, toast, reportError, coarseDuration } from '../ui.js';
import {
  FINDING_STATUSES, SEVERITIES, VULN_TYPES, STATUS_BY_ID, SEVERITY_BY_ID, CURRENCIES,
} from '../../lib/models.js';
import { formatDayLong, dateKey, parseDateInput } from '../../lib/time.js';
import { reportedAt, triagedAt, paidAtOf } from '../../lib/analytics.js';
import * as repo from '../../lib/repo.js';

const FIELD_LABELS = {
  created: 'Created',
  status: 'Status',
  bounty: 'Bounty',
  severity: 'Severity',
  title: 'Title',
  type: 'Type',
  programId: 'Program',
  currency: 'Currency',
};

/** Local UI state that must survive a re-render of the list. */
const ui = { statusFilter: 'all', programFilter: 'all', search: '', editingId: null, creating: false };

export function renderFindings(root, ctx) {
  const { programs, findings, settings, history, reload } = ctx;
  const currency = settings.defaultCurrency;
  const programName = (id) => (id ? (programs.find((p) => p.id === id)?.name ?? 'Deleted program') : '—');

  /* ---------------------------------------------------------- filtering -- */
  const search = ui.search.trim().toLowerCase();
  const visible = findings.filter((f) => {
    if (ui.statusFilter !== 'all' && f.status !== ui.statusFilter) return false;
    if (ui.programFilter !== 'all' && (f.programId ?? '') !== ui.programFilter) return false;
    if (search && !`${f.ref} ${f.title} ${f.type}`.toLowerCase().includes(search)) return false;
    return true;
  });

  const filters = el('div', { class: 'filter-bar' },
    el('input', {
      type: 'search', placeholder: 'Search findings…', value: ui.search, class: 'filter-search',
      onInput: (e) => { ui.search = e.target.value; ctx.rerender(); },
    }),
    el('select', {
      class: 'filter-select',
      onChange: (e) => { ui.statusFilter = e.target.value; ctx.rerender(); },
    },
      el('option', { value: 'all', selected: ui.statusFilter === 'all' || null }, 'All statuses'),
      FINDING_STATUSES.map((s) => el('option', {
        value: s.id, selected: ui.statusFilter === s.id || null,
      }, s.label))),
    el('select', {
      class: 'filter-select',
      onChange: (e) => { ui.programFilter = e.target.value; ctx.rerender(); },
    },
      el('option', { value: 'all', selected: ui.programFilter === 'all' || null }, 'All programs'),
      el('option', { value: '', selected: ui.programFilter === '' || null }, 'No program'),
      programs.map((p) => el('option', {
        value: p.id, selected: ui.programFilter === p.id || null,
      }, p.name))),
    el('button', {
      class: 'btn-primary btn-sm',
      onClick: () => { ui.creating = true; ui.editingId = null; ctx.rerender(); },
    }, '+ New finding'));

  /* --------------------------------------------------------------- rows -- */
  const rows = visible.map((f) => {
    const st = STATUS_BY_ID[f.status];
    const sv = SEVERITY_BY_ID[f.severity];
    return [
      el('span', { class: 'mono dim' }, `#${f.ref}`),
      el('button', {
        class: 'link-btn truncate',
        title: f.title,
        onClick: () => { ui.editingId = f.id; ui.creating = false; ctx.rerender(); },
      }, f.title),
      el('span', { class: 'dim truncate' }, f.type || '—'),
      programName(f.programId),
      pill(sv?.label ?? f.severity, sv?.color ?? '#64748b'),
      pill(st?.label ?? f.status, st?.color ?? '#64748b'),
      el('span', { class: f.status === 'paid' && f.bounty ? 'tone-money mono' : 'dim mono' },
        f.bounty ? money(f.bounty, f.currency) : '—'),
      el('span', { class: 'dim nowrap' }, dateKey(f.createdAt)),
    ];
  });

  const list = table(
    ['#', 'Title', 'Type', 'Program', 'Severity', 'Status',
      { label: 'Bounty', align: 'right' }, 'Created'],
    rows,
    { emptyText: findings.length ? 'No findings match these filters' : 'No findings yet — create one when you find something' },
  );

  const totals = (() => {
    const paid = visible.filter((f) => f.status === 'paid');
    const sum = paid.reduce((acc, f) => acc + Math.round((f.bounty || 0) * 100), 0) / 100;
    return el('div', { class: 'dim', style: { marginTop: '10px', fontSize: '12px' } },
      `${visible.length} of ${findings.length} findings shown · ${paid.length} paid · ${money(sum, currency)} total`);
  })();

  root.append(
    el('div', { class: 'view-head' },
      el('div', {}, el('h2', {}, 'Findings'),
        el('div', { class: 'dim' }, 'Created lightweight, updated over time')),
      filters),
    sectionCard('All Findings', el('div', {}, list, totals)),
  );

  if (ui.creating) root.append(renderEditor(null, ctx));
  else if (ui.editingId) {
    const finding = findings.find((f) => f.id === ui.editingId);
    if (finding) root.append(renderEditor(finding, ctx));
    else ui.editingId = null;
  }
}

/* -------------------------------------------------------------- editor -- */

function renderEditor(finding, ctx) {
  const { programs, settings, history, reload } = ctx;
  const isNew = !finding;
  const values = finding ?? {
    title: '', type: '', programId: '', severity: 'medium', status: 'new',
    bounty: 0, currency: settings.defaultCurrency, notes: '', url: '',
  };
  const tsToDateValue = (ts) => (ts ? dateKey(ts) : dateKey());

  const field = (label, control) => el('div', { class: 'field' }, el('label', {}, label), control);

  const titleInput = el('input', { type: 'text', value: values.title, maxlength: '200', placeholder: 'Broken access control in Nutrition Hub' });
  const typeInput = el('input', { type: 'text', value: values.type, list: 'vuln-types-app', placeholder: 'IDOR / BOLA' });
  const programSelect = el('select', {},
    el('option', { value: '' }, 'No program'),
    programs.map((p) => el('option', {
      value: p.id, selected: (values.programId ?? '') === p.id || null,
    }, p.active ? p.name : `${p.name} (inactive)`)));
  const severitySelect = el('select', {},
    SEVERITIES.map((s) => el('option', { value: s.id, selected: values.severity === s.id || null }, s.label)));
  const statusSelect = el('select', {},
    FINDING_STATUSES.map((s) => el('option', { value: s.id, selected: values.status === s.id || null }, s.label)));
  const bountyInput = el('input', { type: 'number', min: '0', step: '0.01', value: String(values.bounty ?? 0) });
  const currencySelect = el('select', {},
    CURRENCIES.map((c) => el('option', { value: c, selected: values.currency === c || null }, c)));
  const urlInput = el('input', { type: 'text', value: values.url ?? '', placeholder: 'https://…' });
  const notesInput = el('textarea', { rows: '4', placeholder: 'Endpoint, repro steps, triage notes…' }, values.notes ?? '');
  const discoveryDateInput = el('input', {
    type: 'date',
    value: tsToDateValue(values.createdAt),
    max: dateKey(),
  });

  const close = () => { ui.editingId = null; ui.creating = false; ctx.rerender(); };

  async function save() {
    const title = titleInput.value.trim();
    if (!title) { toast('A title is required', 'err'); titleInput.focus(); return; }
    const patch = {
      title,
      type: typeInput.value.trim(),
      programId: programSelect.value || null,
      severity: severitySelect.value,
      status: statusSelect.value,
      bounty: Math.max(0, Number(bountyInput.value) || 0),
      currency: currencySelect.value,
      url: urlInput.value.trim(),
      notes: notesInput.value,
    };
    if (isNew) {
      const picked = parseDateInput(discoveryDateInput.value);
      if (picked) patch.createdAt = picked;
    }
    try {
      if (isNew) {
        const created = await repo.createFinding(patch);
        toast(`Finding #${created.ref} created`);
        ui.creating = false;
        ui.editingId = created.id;
      } else {
        await repo.updateFinding(finding.id, patch);
        toast('Finding updated');
      }
      await reload();
    } catch (err) {
      reportError(err, 'saving finding');
    }
  }

  async function remove() {
    if (!confirm(`Delete finding #${finding.ref} "${finding.title}" and its history? This cannot be undone.`)) return;
    try {
      await repo.deleteFinding(finding.id);
      toast('Finding deleted');
      close();
      await reload();
    } catch (err) {
      reportError(err, 'deleting finding');
    }
  }

  /* Quick status buttons: the common path is one click, not a dropdown. */
  const quickStatus = finding
    ? el('div', { class: 'quick-status' },
      FINDING_STATUSES.filter((s) => s.id !== finding.status).slice(0, 6).map((s) => el('button', {
        class: 'btn-sm',
        title: `Move to ${s.label}`,
        onClick: async () => {
          try {
            await repo.updateFinding(finding.id, { status: s.id });
            toast(`#${finding.ref} → ${s.label}`);
            await reload();
          } catch (err) {
            reportError(err, 'changing status');
          }
        },
      }, `→ ${s.label}`)))
    : null;

  const form = el('div', { class: 'editor-form' },
    field('Title', titleInput),
    el('div', { class: 'field-row' },
      field('Vulnerability type', typeInput),
      field('Program', programSelect)),
    el('div', { class: 'field-row' },
      field('Severity', severitySelect),
      field('Status', statusSelect)),
    el('div', { class: 'field-row' },
      field('Bounty', bountyInput),
      field('Currency', currencySelect)),
    field('Reference URL', urlInput),
    isNew ? field('Discovery date', el('div', {},
      discoveryDateInput,
      el('span', { class: 'dim', style: { fontSize: '11px', marginTop: '4px', display: 'block' } },
        'Leave blank to use today. Set this if you found it on a different day.'))) : null,
    field('Notes', notesInput),
    el('div', { class: 'editor-actions' },
      finding ? el('button', { class: 'btn-danger btn-sm', onClick: remove }, 'Delete') : null,
      el('span', { style: { flex: '1' } }),
      el('button', { class: 'btn-sm', onClick: close }, 'Close'),
      el('button', { class: 'btn-primary btn-sm', onClick: save }, isNew ? 'Create finding' : 'Save changes')));

  const panels = [sectionCard(
    isNew ? 'New finding' : `Finding #${finding.ref}`,
    el('div', {}, quickStatus, form),
  )];

  if (finding) {
    panels.push(sectionCard('History', renderHistory(finding, history, programs)));
    panels.push(sectionCard('Timings', renderTimings(finding)));
  }

  return el('div', { class: finding ? 'grid-2 editor-wrap' : 'editor-wrap' }, panels);
}

/* ------------------------------------------------------------- history -- */

function renderHistory(finding, history, programs) {
  const rows = history
    .filter((h) => h.findingId === finding.id)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (!rows.length) return el('div', { class: 'empty' }, 'No changes recorded yet');

  const label = (field, value) => {
    if (value == null || value === '') return '—';
    if (field === 'status') return STATUS_BY_ID[value]?.label ?? value;
    if (field === 'severity') return SEVERITY_BY_ID[value]?.label ?? value;
    if (field === 'programId') return programs.find((p) => p.id === value)?.name ?? value;
    if (field === 'bounty') return money(Number(value) || 0, finding.currency);
    return String(value);
  };

  return el('div', { class: 'timeline' },
    rows.map((h) => el('div', { class: 'timeline-row' },
      el('div', { class: 'timeline-date dim mono nowrap' }, formatDayLong(dateKey(h.timestamp))),
      el('div', { class: 'timeline-body' },
        el('span', { class: 'timeline-field' }, FIELD_LABELS[h.field] ?? h.field),
        h.field === 'created'
          ? el('span', {}, ` → ${label('status', h.newValue)}`)
          : el('span', {},
            ' ', el('span', { class: 'dim' }, label(h.field, h.oldValue)),
            ' → ', el('strong', {}, label(h.field, h.newValue)))))));
}

function renderTimings(finding) {
  const created = finding.createdAt;
  const rep = reportedAt(finding);
  const tri = triagedAt(finding);
  const paid = paidAtOf(finding);
  const rows = [
    ['Discovered', formatDayLong(dateKey(created)), '—'],
    ['Reported', rep ? formatDayLong(dateKey(rep)) : '—', rep ? coarseDuration(rep - created) : '—'],
    ['Triaged', tri ? formatDayLong(dateKey(tri)) : '—', tri && rep ? coarseDuration(tri - rep) : '—'],
    ['Paid', paid ? formatDayLong(dateKey(paid)) : '—', paid && tri ? coarseDuration(paid - tri) : '—'],
  ];
  return table(['Milestone', 'Date', { label: 'Elapsed', align: 'right' }], rows);
}
