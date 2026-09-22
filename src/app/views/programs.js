/**
 * Programs view — create once, reuse forever.
 *
 * A program is never silently removed while anything references it; the repo
 * refuses and the UI offers deactivation instead, so historical sessions keep
 * their label and analytics stay honest.
 */

import { el, sectionCard, table, money, num, toast, reportError } from '../ui.js';
import { PLATFORMS } from '../../lib/models.js';
import { formatDuration, dateKey } from '../../lib/time.js';
import { byProgram } from '../../lib/analytics.js';
import * as repo from '../../lib/repo.js';

const ui = { editingId: null, creating: false };

export function renderPrograms(root, ctx) {
  const { programs, sessions, findings, settings, reload } = ctx;
  const currency = settings.defaultCurrency;
  const stats = new Map(byProgram(sessions, findings, programs).map((r) => [r.id, r]));

  const rows = programs.map((p) => {
    const s = stats.get(p.id) ?? { value: 0, sessions: 0, findings: 0, bounty: 0 };
    return [
      el('button', {
        class: 'link-btn', onClick: () => { ui.editingId = p.id; ui.creating = false; ctx.rerender(); },
      }, p.name),
      el('span', { class: 'dim' }, p.platform || '—'),
      el('span', { class: p.active ? 'tone-go' : 'dim' }, p.active ? 'Active' : 'Inactive'),
      formatDuration(s.value),
      num(s.sessions),
      num(s.findings),
      el('span', { class: s.bounty ? 'tone-money' : 'dim' }, money(s.bounty, currency)),
      el('span', { class: 'dim' }, s.perHour != null && s.value > 0 ? money(s.perHour, currency) : '—'),
      el('span', { class: 'dim nowrap' }, dateKey(p.createdAt)),
    ];
  });

  const list = table(
    ['Program', 'Platform', 'State',
      { label: 'Focused', align: 'right' },
      { label: 'Sessions', align: 'right' },
      { label: 'Findings', align: 'right' },
      { label: 'Bounty', align: 'right' },
      { label: '$/Hour', align: 'right' },
      'Created'],
    rows,
    { emptyText: 'No programs yet — add your first target' },
  );

  root.append(
    el('div', { class: 'view-head' },
      el('div', {}, el('h2', {}, 'Programs'),
        el('div', { class: 'dim' }, 'Persistent targets — created once, selected forever')),
      el('button', {
        class: 'btn-primary btn-sm',
        onClick: () => { ui.creating = true; ui.editingId = null; ctx.rerender(); },
      }, '+ New program')),
    sectionCard('All Programs', list),
  );

  if (ui.creating) root.append(renderEditor(null, ctx));
  else if (ui.editingId) {
    const program = programs.find((p) => p.id === ui.editingId);
    if (program) root.append(renderEditor(program, ctx));
    else ui.editingId = null;
  }
}

function renderEditor(program, ctx) {
  const { reload } = ctx;
  const isNew = !program;
  const values = program ?? { name: '', url: '', platform: '', active: true, notes: '' };

  const nameInput = el('input', { type: 'text', value: values.name, maxlength: '80', placeholder: 'Enter target name' });
  const urlInput = el('input', { type: 'text', value: values.url, placeholder: 'https://hackerone.com/your-program' });
  const platformSelect = el('select', {},
    el('option', { value: '' }, '—'),
    PLATFORMS.map((p) => el('option', { value: p, selected: values.platform === p || null }, p)));
  const activeSelect = el('select', {},
    el('option', { value: 'true', selected: values.active !== false || null }, 'Active'),
    el('option', { value: 'false', selected: values.active === false || null }, 'Inactive'));
  const notesInput = el('textarea', { rows: '3', placeholder: 'Scope notes, payout ranges, quirks…' }, values.notes ?? '');

  const close = () => { ui.editingId = null; ui.creating = false; ctx.rerender(); };

  async function save() {
    try {
      await repo.saveProgram({
        id: program?.id,
        name: nameInput.value,
        url: urlInput.value,
        platform: platformSelect.value,
        active: activeSelect.value === 'true',
        notes: notesInput.value,
      });
      toast(isNew ? 'Program created' : 'Program updated');
      ui.creating = false;
      ui.editingId = null;
      await reload();
    } catch (err) {
      reportError(err, 'saving program');
    }
  }

  async function remove() {
    if (!confirm(`Delete "${program.name}"?`)) return;
    try {
      await repo.deleteProgram(program.id);
      toast('Program deleted');
      close();
      await reload();
    } catch (err) {
      if (err.code === 'PROGRAM_IN_USE') {
        // Offer the safe alternative rather than just refusing.
        if (confirm(`${err.message}\n\nSet it to inactive now?`)) {
          try {
            await repo.saveProgram({ ...program, active: false });
            toast('Program set to inactive');
            close();
            await reload();
            return;
          } catch (inner) {
            reportError(inner, 'deactivating program');
            return;
          }
        }
        return;
      }
      reportError(err, 'deleting program');
    }
  }

  const field = (label, control) => el('div', { class: 'field' }, el('label', {}, label), control);

  return el('div', { class: 'editor-wrap' },
    sectionCard(isNew ? 'New program' : `Edit ${program.name}`,
      el('div', { class: 'editor-form' },
        field('Name', nameInput),
        el('div', { class: 'field-row' },
          field('Platform', platformSelect),
          field('State', activeSelect)),
        field('URL', urlInput),
        field('Notes', notesInput),
        el('div', { class: 'editor-actions' },
          program ? el('button', { class: 'btn-danger btn-sm', onClick: remove }, 'Delete') : null,
          el('span', { style: { flex: '1' } }),
          el('button', { class: 'btn-sm', onClick: close }, 'Cancel'),
          el('button', { class: 'btn-primary btn-sm', onClick: save }, isNew ? 'Create program' : 'Save')))));
}
