/**
 * Dashboard shell: loads everything once, routes between views via the URL
 * hash, and re-renders from a single in-memory snapshot.
 *
 * The data set for a personal tracker is small (a year of hard hunting is a few
 * thousand rows), so loading it all and filtering in memory keeps every view
 * instant and every metric consistent with every other metric on screen.
 */

import { el, clear, $, $$, toast, reportError, errorPanel } from './ui.js';
import * as repo from '../lib/repo.js';
import * as store from '../lib/store.js';
import { VULN_TYPES } from '../lib/models.js';
import { formatClock, dateKey } from '../lib/time.js';

import { renderDashboard } from './views/dashboard.js';
import { renderDay } from './views/day.js';
import { renderFindings } from './views/findings.js';
import { renderPrograms } from './views/programs.js';
import { renderGoals } from './views/goals.js';
import { renderData } from './views/data.js';

const VIEWS = {
  dashboard: renderDashboard,
  day: renderDay,
  findings: renderFindings,
  programs: renderPrograms,
  goals: renderGoals,
  data: renderData,
};

const state = {
  view: 'dashboard',
  period: 'month',
  dayKey: dateKey(),
  data: null,
  active: null,
  tickHandle: null,
};

/* ----------------------------------------------------------------- data -- */

async function loadData() {
  state.data = await repo.loadAll();
  state.active = state.data.active;
  state.period = state.data.prefs.dashboardPeriod ?? state.period;
}

async function reload() {
  await loadData();
  render();
}

/* --------------------------------------------------------------- render -- */

function render() {
  const root = clear($('#view'));
  const renderer = VIEWS[state.view] ?? renderDashboard;

  for (const btn of $$('.nav-btn')) {
    btn.classList.toggle('is-active', btn.dataset.view === state.view);
  }

  if (!state.data) {
    root.append(el('div', { class: 'empty' }, 'Loading…'));
    return;
  }

  const ctx = {
    ...state.data,
    period: state.period,
    dayKey: state.dayKey,
    reload,
    rerender: render,
    onPeriodChange: async (period) => {
      state.period = period;
      render();
      try {
        await store.setPrefs({ dashboardPeriod: period });
      } catch (err) {
        // A failed preference write is not worth interrupting the user over.
        console.warn('[bug-hunt-tracker] could not persist period', err);
      }
    },
    onDayChange: (key) => {
      state.dayKey = key;
      render();
    },
  };

  try {
    renderer(root, ctx);
  } catch (err) {
    // One bad view must not leave a blank page with no way back.
    clear(root).append(errorPanel(`the ${state.view} view`, err));
    console.error('[bug-hunt-tracker] render failed', err);
  }
}

/* --------------------------------------------------------------- routing -- */

function applyHash() {
  const raw = location.hash.replace(/^#/, '');
  const [view, param] = raw.split('/');
  if (view && VIEWS[view]) state.view = view;
  if (view === 'day' && param && /^\d{4}-\d{2}-\d{2}$/.test(param)) state.dayKey = param;
  render();
}

function navigate(view) {
  state.view = view;
  location.hash = view === 'day' ? `day/${state.dayKey}` : view;
  // hashchange fires and calls render(); set it here too for the no-change case.
  render();
}

/* ------------------------------------------------------ running-timer chip -- */

function renderTimerChip() {
  const host = $('#timer-status');
  clear(host);
  if (!state.active) {
    host.append(el('span', { class: 'dim' }, 'No session running'));
    return;
  }
  const programName = state.data?.programs.find((p) => p.id === state.active.programId)?.name ?? 'No program';
  host.append(el('span', { class: 'timer-live' },
    el('span', { class: 'live-dot' }),
    el('span', { class: 'mono', id: 'chip-clock' }, formatClock(repo.elapsedOf(state.active))),
    el('span', { class: 'dim' }, `· ${programName}`)));
}

function startChipTicking() {
  stopChipTicking();
  state.tickHandle = setInterval(() => {
    const node = $('#chip-clock');
    if (!node || !state.active) return;
    node.textContent = formatClock(repo.elapsedOf(state.active));
  }, 1000);
}

function stopChipTicking() {
  if (state.tickHandle) clearInterval(state.tickHandle);
  state.tickHandle = null;
}

function syncTimerChip() {
  renderTimerChip();
  if (state.active) startChipTicking(); else stopChipTicking();
}

/* ------------------------------------------------------------------ boot -- */

async function boot() {
  const list = $('#vuln-types-app');
  for (const t of VULN_TYPES) list.append(el('option', { value: t }));

  try {
    await loadData();
  } catch (err) {
    clear($('#view')).append(errorPanel('your data', err));
    reportError(err, 'loading data');
    return;
  }

  applyHash();
  syncTimerChip();

  // The popup writes the timer; mirror its state here without a page reload.
  store.onChange(async (changes) => {
    if (!('activeSession' in changes)) return;
    state.active = changes.activeSession.newValue ?? null;
    syncTimerChip();
    // A finished session changes every total on screen.
    if (!state.active) await reload();
  });
}

$('#nav').addEventListener('click', (event) => {
  const btn = event.target.closest('.nav-btn');
  if (btn) navigate(btn.dataset.view);
});

window.addEventListener('hashchange', applyHash);

// The popup can add findings and sessions while this tab sits in the
// background, and a tab left open overnight would otherwise still be showing
// yesterday. Re-read on focus so the page is never quietly stale.
window.addEventListener('focus', async () => {
  syncTimerChip();
  try {
    await reload();
  } catch (err) {
    console.warn('[bug-hunt-tracker] refresh on focus failed', err);
  }
});

boot();
