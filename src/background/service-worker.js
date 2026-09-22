/**
 * MV3 service worker.
 *
 * It owns exactly one job: keeping the toolbar badge in sync with the running
 * timer. It is NOT the timekeeper — the elapsed time is always recomputed from
 * the persisted `startTime`, so it does not matter that Chrome suspends this
 * worker every ~30 seconds of idleness, nor that the browser was restarted.
 * chrome.alarms wakes it back up to refresh the badge.
 */

import { getActiveSession } from '../lib/store.js';
import { formatBadge } from '../lib/time.js';
import { getSettings } from '../lib/db.js';

const TICK_ALARM = 'timer-tick';
const BADGE_COLOR = '#16a34a';

async function refreshBadge() {
  try {
    const active = await getActiveSession();
    if (!active) {
      await chrome.action.setBadgeText({ text: '' });
      await chrome.action.setTitle({ title: 'Bug Hunt Tracker' });
      await chrome.alarms.clear(TICK_ALARM);
      return;
    }
    const elapsed = Date.now() - active.startTime;
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    await chrome.action.setBadgeText({ text: formatBadge(elapsed) });
    await chrome.action.setTitle({ title: `Hunting — ${formatBadge(elapsed)} elapsed. Click to stop.` });
    await ensureAlarm();
  } catch (err) {
    // A badge failure must never take the worker down; the timer data is safe
    // in storage regardless of what the toolbar shows.
    console.warn('[bug-hunt-tracker] badge refresh failed', err);
  }
}

async function ensureAlarm() {
  const existing = await chrome.alarms.get(TICK_ALARM);
  if (!existing) chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(async () => {
  // Touch settings so the defaults (activities, currency) exist from first run
  // and the popup never has to render an empty activity list.
  try {
    await getSettings();
  } catch (err) {
    console.warn('[bug-hunt-tracker] could not initialise settings', err);
  }
  refreshBadge();
});

chrome.runtime.onStartup.addListener(refreshBadge);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) refreshBadge();
});

// The popup writes the running session to storage; this keeps the badge in
// step the instant START or STOP is pressed rather than on the next minute.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'activeSession' in changes) refreshBadge();
});

// Also run on every cold start of the worker itself.
refreshBadge();
