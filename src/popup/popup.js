/**
 * Popup — the hot path.
 *
 * Everything here is optimised for the five-step loop: open, (maybe) pick a
 * program, pick an activity, START, ... STOP. The last used program and
 * activity are restored on open, so the common case is literally one click.
 */

import * as repo from '../lib/repo.js';
import * as store from '../lib/store.js';
import { getSettings } from '../lib/db.js';
import {
  SEVERITIES, VULN_TYPES, PLATFORMS,
} from '../lib/models.js';
import {
  formatClock, formatDuration, formatDayLong, formatTimeOfDay, dateKey, parseDateInput,
} from '../lib/time.js';
import { dayReport, currentStreak } from '../lib/analytics.js';

const $ = (id) => document.getElementById(id);

const state = {
  settings: null,
  programs: [],
  active: null,
  tickHandle: null,
};

/* ---------------------------------------------------------------- utils -- */

let toastTimer = null;
function toast(message, kind = 'ok') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'err' ? 4200 : 2200);
}

/** Any unexpected failure should say so plainly rather than freeze the UI. */
function fail(err, context) {
  console.error(`[bug-hunt-tracker] ${context}`, err);
  toast(err?.message ? `${err.message}` : `Something went wrong (${context})`, 'err');
}

function fillSelect(select, items, selectedValue, { placeholder = null } = {}) {
  select.textContent = '';
  if (placeholder) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = placeholder;
    select.appendChild(opt);
  }
  for (const item of items) {
    const opt = document.createElement('option');
    opt.value = item.value;
    opt.textContent = item.label;
    select.appendChild(opt);
  }
  select.value = selectedValue ?? '';
  // If the remembered value no longer exists, fall back to the first option
  // rather than silently sitting on an empty select.
  if (select.selectedIndex === -1) select.selectedIndex = 0;
}

function money(amount, currency = 'USD') {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency, maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

function openApp(hash = '') {
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/app/app.html${hash}`) });
  window.close();
}

/* ------------------------------------------------------------ rendering -- */

function renderProgramOptions() {
  const active = state.programs.filter((p) => p.active);
  // Inactive programs stay selectable only if one is currently chosen, so an
  // archived program never silently detaches from a session in progress.
  const items = active.map((p) => ({ value: p.id, label: p.name }));
  const prefsId = $('program').value || state.prefsProgramId;
  const chosen = state.programs.find((p) => p.id === prefsId);
  if (chosen && !chosen.active) items.unshift({ value: chosen.id, label: `${chosen.name} (inactive)` });

  fillSelect($('program'), items, prefsId, {
    placeholder: items.length ? 'No program' : 'No programs yet — add one →',
  });
}

function renderActivityOptions(selected) {
  const items = state.settings.activities
    .filter((a) => !a.archived)
    .map((a) => ({ value: a.id, label: a.label }));
  fillSelect($('activity'), items, selected);
}

function programName(id) {
  if (!id) return 'No program';
  return state.programs.find((p) => p.id === id)?.name ?? 'Deleted program';
}

function activityLabel(id) {
  return state.settings.activities.find((a) => a.id === id)?.label ?? id;
}

function showView(name) {
  $('view-idle').hidden = name !== 'idle';
  $('view-running').hidden = name !== 'running';
}

function renderRunning() {
  const { active } = state;
  showView('running');
  $('running-context').innerHTML = '';
  const ctx = $('running-context');
  ctx.append(programName(active.programId));
  const sep = document.createElement('span');
  sep.className = 'sep';
  sep.textContent = '·';
  ctx.append(sep, activityLabel(active.activity));
  $('running-since').textContent = `Started ${formatTimeOfDay(active.startTime)}`;
  tick();
  startTicking();
}

function tick() {
  if (!state.active) return;
  // Recomputed from the persisted timestamp on every frame — this is what makes
  // the timer survive the popup closing, the worker sleeping, or a reboot.
  $('clock').textContent = formatClock(repo.elapsedOf(state.active));
}

function startTicking() {
  stopTicking();
  state.tickHandle = setInterval(tick, 1000);
}

function stopTicking() {
  if (state.tickHandle) clearInterval(state.tickHandle);
  state.tickHandle = null;
}

async function renderSavedBanner() {
  const banner = $('saved-banner');
  const saved = await store.getLastSaved();
  // Only surface the confirmation for a couple of minutes after STOP; after
  // that it is stale news and just takes up space.
  if (!saved || Date.now() - saved.at > 120_000) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.innerHTML = '';
  const line = document.createElement('div');
  line.className = 'ok';
  line.textContent = `Session saved ✓  ${formatDuration(saved.durationMs)}`;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${formatDayLong(saved.date)} · ${activityLabel(saved.activity)} · ${programName(saved.programId)}`;
  banner.append(line, meta);
  $('start').textContent = 'START AGAIN';
}

async function renderToday() {
  const today = dateKey();
  const [sessions, findings] = await Promise.all([repo.sessionsForDay(today), repo.listFindings()]);
  const report = dayReport(today, sessions, findings, state.settings.activities);
  const allSessions = await repo.listSessions();

  $('today-date').textContent = formatDayLong(today);
  $('t-time').textContent = formatDuration(report.focusedMs);
  $('t-sessions').textContent = String(report.sessions);
  $('t-findings').textContent = String(report.findings);
  $('t-bounty').textContent = money(report.paidBounty, state.settings.defaultCurrency);

  const streak = currentStreak(allSessions, today);
  $('today-streak').textContent = streak > 1 ? `${streak} day streak` : '';

  const wrap = $('today-activities');
  wrap.textContent = '';
  for (const row of report.activities.filter((a) => a.value > 0)) {
    const chip = document.createElement('span');
    chip.className = 'act-chip';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = row.color;
    const v = document.createElement('span');
    v.className = 'v';
    v.textContent = formatDuration(row.value);
    chip.append(dot, document.createTextNode(row.label), v);
    wrap.appendChild(chip);
  }
}

async function render() {
  state.active = await store.getActiveSession();
  if (state.active) {
    renderRunning();
  } else {
    stopTicking();
    showView('idle');
    renderProgramOptions();
    renderActivityOptions(state.prefsActivity);
    await renderSavedBanner();
  }
  await renderToday();
}

/* -------------------------------------------------------------- actions -- */

async function onStart() {
  const btn = $('start');
  btn.disabled = true;
  try {
    const programId = $('program').value || null;
    const activity = $('activity').value;
    state.active = await repo.startSession({ programId, activity });
    await render();
  } catch (err) {
    fail(err, 'starting session');
    await render();
  } finally {
    btn.disabled = false;
  }
}

async function onStop() {
  const btn = $('stop');
  btn.disabled = true;
  try {
    const result = await repo.stopSession();
    stopTicking();
    state.active = null;
    const prefs = await store.getPrefs();
    state.prefsProgramId = prefs.lastProgramId;
    state.prefsActivity = prefs.lastActivity;
    await render();
    if (result.discarded) {
      toast('Too short to save — discarded', 'err');
    } else {
      toast(`Saved ${formatDuration(result.session.durationMs)}`);
    }
  } catch (err) {
    fail(err, 'stopping session');
    await render();
  } finally {
    btn.disabled = false;
  }
}

async function onDiscard() {
  if (!confirm('Discard this session without saving it?')) return;
  try {
    await repo.cancelSession();
    stopTicking();
    state.active = null;
    await render();
    toast('Session discarded');
  } catch (err) {
    fail(err, 'discarding session');
  }
}

async function onSaveProgram(event) {
  event.preventDefault();
  const name = $('np-name').value.trim();
  if (!name) {
    toast('Give the program a name', 'err');
    $('np-name').focus();
    return;
  }
  try {
    const program = await repo.saveProgram({
      name,
      platform: $('np-platform').value,
      url: $('np-url').value.trim(),
    });
    state.programs = await repo.listPrograms();
    state.prefsProgramId = program.id;
    await store.setPrefs({ lastProgramId: program.id });
    toggleProgramForm(false);
    renderProgramOptions();
    $('program').value = program.id;
    toast(`${program.name} added`);
  } catch (err) {
    fail(err, 'saving program');
  }
}

function toggleProgramForm(show) {
  $('program-form').hidden = !show;
  $('new-program').disabled = show;
  if (show) {
    $('np-name').value = '';
    $('np-url').value = '';
    $('np-name').focus();
  }
}

/* -------------------------------------------------------- finding sheet -- */

function openFindingSheet() {
  const sheet = $('finding-sheet');
  const items = state.programs.filter((p) => p.active).map((p) => ({ value: p.id, label: p.name }));
  fillSelect($('fs-program'), items, $('program').value || state.prefsProgramId, { placeholder: 'No program' });
  fillSelect($('fs-severity'), SEVERITIES.map((s) => ({ value: s.id, label: s.label })), 'medium');
  $('fs-title').value = '';
  $('fs-type').value = '';
  $('fs-notes').value = '';
  $('fs-date').value = '';
  sheet.hidden = false;
  $('fs-title').focus();
}

async function onSaveFinding(event) {
  event.preventDefault();
  const title = $('fs-title').value.trim();
  if (!title) {
    toast('A title is required', 'err');
    $('fs-title').focus();
    return;
  }
  try {
    const pickedDate = parseDateInput($('fs-date').value);
    const finding = await repo.createFinding({
      title,
      type: $('fs-type').value.trim(),
      programId: $('fs-program').value || null,
      severity: $('fs-severity').value,
      notes: $('fs-notes').value.trim(),
      status: 'new',
      bounty: 0,
      currency: state.settings.defaultCurrency,
      ...(pickedDate ? { createdAt: pickedDate } : {}),
    });
    $('finding-sheet').hidden = true;
    await renderToday();
    toast(`Finding #${finding.ref} saved`);
  } catch (err) {
    fail(err, 'saving finding');
  }
}

/* ----------------------------------------------------------------- boot -- */

async function boot() {
  try {
    const [settings, programs, prefs] = await Promise.all([
      getSettings(), repo.listPrograms(), store.getPrefs(),
    ]);
    state.settings = settings;
    state.programs = programs;
    state.prefsProgramId = prefs.lastProgramId;
    state.prefsActivity = prefs.lastActivity;

    fillSelect($('np-platform'), PLATFORMS.map((p) => ({ value: p, label: p })), 'HackerOne');
    const list = $('vuln-types');
    for (const t of VULN_TYPES) {
      const opt = document.createElement('option');
      opt.value = t;
      list.appendChild(opt);
    }

    await render();
  } catch (err) {
    fail(err, 'loading');
    showView('idle');
  }
}

$('start').addEventListener('click', onStart);
$('stop').addEventListener('click', onStop);
$('discard').addEventListener('click', onDiscard);
$('new-program').addEventListener('click', () => toggleProgramForm(true));
$('np-cancel').addEventListener('click', () => toggleProgramForm(false));
$('program-form').addEventListener('submit', onSaveProgram);

$('program').addEventListener('change', (e) => store.setPrefs({ lastProgramId: e.target.value || null }));
$('activity').addEventListener('change', (e) => store.setPrefs({ lastActivity: e.target.value }));

$('add-finding').addEventListener('click', openFindingSheet);
$('fs-close').addEventListener('click', () => { $('finding-sheet').hidden = true; });
$('fs-cancel').addEventListener('click', () => { $('finding-sheet').hidden = true; });
$('finding-form').addEventListener('submit', onSaveFinding);

$('open-dashboard').addEventListener('click', () => openApp('#dashboard'));
$('open-findings').addEventListener('click', () => openApp('#findings'));
$('open-programs').addEventListener('click', () => openApp('#programs'));

// Space toggles the timer, so the whole loop is reachable without the mouse.
document.addEventListener('keydown', (e) => {
  if (e.key !== ' ' || e.target.matches('input, textarea, select, button')) return;
  e.preventDefault();
  if (state.active) onStop(); else onStart();
});

// Another popup window or the worker may change the timer underneath us.
store.onChange((changes) => {
  if ('activeSession' in changes) render().catch((err) => fail(err, 'syncing'));
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopTicking();
  else if (state.active) startTicking();
});

boot();
