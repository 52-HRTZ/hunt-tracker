/**
 * Goals view — one metric, one period, optionally one program.
 *
 * Progress is never stored: every card recomputes from the raw sessions and
 * findings on render via `goalProgress`, so a goal can never disagree with the
 * dashboard it is measured against.
 */

import { el, sectionCard, money, num, toast, reportError } from '../ui.js';
import {
  GOAL_METRICS, GOAL_PERIODS, GOAL_METRIC_BY_ID, GOAL_PERIOD_BY_ID,
} from '../../lib/models.js';
import { formatDuration } from '../../lib/time.js';
import { goalProgress } from '../../lib/analytics.js';
import * as repo from '../../lib/repo.js';

const ui = { editingId: null, creating: false };

/** Render a goal value in the units of its metric. */
function formatValue(metric, value, currency) {
  if (metric === 'bounty') return money(value, currency);
  if (metric === 'hours') return formatDuration((Number(value) || 0) * 3600000);
  return num(Math.round(Number(value) || 0));
}

/** The unit shown beside the target input, e.g. "Target (bugs)". */
function targetUnitLabel(metricId) {
  const metric = GOAL_METRIC_BY_ID[metricId];
  if (!metric) return 'Target';
  return metric.unit === 'money' ? 'Target ($)' : `Target (${metric.unit})`;
}

export function renderGoals(root, ctx) {
  const { programs, sessions, findings, goals, settings, reload } = ctx;
  const currency = settings.defaultCurrency;
  const active = (goals ?? []).filter((g) => g.active);
  const programName = (id) => (id
    ? (programs.find((p) => p.id === id)?.name ?? 'Deleted program')
    : 'All programs');

  /* --------------------------------------------------------------- card -- */

  function goalCard(goal) {
    const progress = goalProgress(goal, sessions, findings);
    const metric = GOAL_METRIC_BY_ID[goal.metric];
    const period = GOAL_PERIOD_BY_ID[goal.period];
    const fill = Math.min(progress.ratio, 1) * 100;

    async function removeGoal() {
      if (!confirm('Delete this goal?')) return;
      try {
        await repo.deleteGoal(goal.id);
        if (ui.editingId === goal.id) { ui.editingId = null; ui.creating = false; }
        toast('Goal deleted');
        await reload();
      } catch (err) {
        reportError(err, 'deleting goal');
      }
    }

    return el('div', { class: 'card goal-card', style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
      el('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px' } },
        el('div', { style: { minWidth: '0' } },
          el('div', { style: { fontSize: '13.5px', fontWeight: '650' } },
            `${metric?.icon ?? ''} ${metric?.label ?? goal.metric} · ${period?.label ?? goal.period}`),
          el('div', { class: 'dim truncate', style: { fontSize: '11.5px', marginTop: '2px' } },
            programName(goal.programId)),
          goal.label
            ? el('div', { class: 'muted truncate', style: { fontSize: '12px', marginTop: '3px' } }, goal.label)
            : null),
        progress.done
          ? el('span', { class: 'pill', style: { color: 'var(--go-hi)' } },
            el('span', { class: 'dot' }), 'Achieved')
          : null),

      el('div', { class: 'bar-track' },
        el('div', {
          class: 'bar-fill',
          style: {
            width: `${fill}%`,
            background: progress.done ? 'var(--go)' : 'var(--accent)',
          },
        })),

      el('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px' } },
        el('div', { class: 'mono', style: { fontSize: '14px', fontWeight: '650' } },
          formatValue(goal.metric, progress.current, currency),
          el('span', { class: 'dim', style: { fontWeight: '400' } },
            ` / ${formatValue(goal.metric, goal.target, currency)}`)),
        el('div', { class: 'btn-row' },
          el('button', {
            class: 'btn-sm',
            onClick: () => { ui.editingId = goal.id; ui.creating = false; ctx.rerender(); },
          }, 'Edit'),
          el('button', { class: 'btn-danger btn-sm', onClick: removeGoal }, 'Delete'))));
  }

  /* --------------------------------------------------------------- body -- */

  const body = active.length
    ? el('div', {
      style: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(270px, 1fr))',
        gap: '14px',
      },
    }, active.map(goalCard))
    : el('div', { class: 'empty' },
      el('div', { style: { fontSize: '26px', marginBottom: '6px' } }, '🎯'),
      el('div', { style: { fontSize: '13px', color: 'var(--text-dim)' } }, 'No goals yet'),
      el('div', { style: { marginTop: '4px' } }, 'Press "+ New Goal" to set your first target.'));

  root.append(
    el('div', { class: 'view-head' },
      el('div', {}, el('h2', {}, 'Goals'),
        el('div', { class: 'dim' }, 'One metric, one period — progress is measured, never entered')),
      el('button', {
        class: 'btn-primary btn-sm',
        onClick: () => { ui.creating = true; ui.editingId = null; ctx.rerender(); },
      }, '+ New Goal')),
    sectionCard('Active Goals', body),
  );

  if (ui.creating) root.append(renderEditor(null, ctx));
  else if (ui.editingId) {
    const goal = (goals ?? []).find((g) => g.id === ui.editingId);
    if (goal) root.append(renderEditor(goal, ctx));
    else ui.editingId = null;
  }
}

/* ------------------------------------------------------------- editor -- */

function renderEditor(goal, ctx) {
  const { programs, reload } = ctx;
  const isNew = !goal;
  const values = goal ?? { label: '', metric: 'findings', period: 'monthly', target: '', programId: null };

  const labelInput = el('input', { type: 'text', value: values.label ?? '', maxlength: '60', placeholder: 'e.g. Monthly grind' });

  const metricSelect = el('select', {},
    GOAL_METRICS.map((m) => el('option', {
      value: m.id, selected: values.metric === m.id || null,
    }, `${m.icon} ${m.label}`)));

  const periodSelect = el('select', {},
    GOAL_PERIODS.map((p) => el('option', {
      value: p.id, selected: values.period === p.id || null,
    }, p.label)));

  const targetInput = el('input', {
    type: 'number', min: '1', step: 'any',
    value: values.target ? String(values.target) : '',
    placeholder: '10',
  });

  const programSelect = el('select', {},
    el('option', { value: '' }, 'All programs'),
    programs.filter((p) => p.active || (values.programId ?? '') === p.id).map((p) => el('option', {
      value: p.id, selected: (values.programId ?? '') === p.id || null,
    }, p.active ? p.name : `${p.name} (inactive)`)));

  // The target's unit follows the chosen metric, so "10" is never ambiguous.
  const targetLabel = el('label', {}, targetUnitLabel(values.metric));
  metricSelect.addEventListener('change', () => {
    targetLabel.textContent = targetUnitLabel(metricSelect.value);
  });

  const close = () => { ui.editingId = null; ui.creating = false; ctx.rerender(); };

  async function save() {
    const target = Number(targetInput.value);
    if (!target || target <= 0) {
      toast('Target must be a positive number', 'err');
      targetInput.focus();
      return;
    }
    try {
      await repo.saveGoal({
        id: goal?.id,
        label: labelInput.value,
        metric: metricSelect.value,
        period: periodSelect.value,
        target,
        programId: programSelect.value || null,
      });
      toast(isNew ? 'Goal created' : 'Goal updated');
      ui.creating = false;
      ui.editingId = null;
      await reload();
    } catch (err) {
      reportError(err, 'saving goal');
    }
  }

  const field = (label, control) => el('div', { class: 'field' }, el('label', {}, label), control);

  return el('div', { class: 'editor-wrap' },
    sectionCard(isNew ? 'New goal' : 'Edit goal',
      el('div', { class: 'editor-form' },
        field('Label (optional)', labelInput),
        el('div', { class: 'field-row' },
          field('Metric', metricSelect),
          field('Period', periodSelect)),
        el('div', { class: 'field-row' },
          el('div', { class: 'field' }, targetLabel, targetInput),
          field('Program', programSelect)),
        el('div', { class: 'editor-actions' },
          el('span', { style: { flex: '1' } }),
          el('button', { class: 'btn-sm', onClick: close }, 'Cancel'),
          el('button', { class: 'btn-primary btn-sm', onClick: save }, isNew ? 'Create goal' : 'Save goal')))));
}
