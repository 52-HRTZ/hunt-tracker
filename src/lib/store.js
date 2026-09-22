/**
 * chrome.storage.local — the small, hot state that both the popup and the
 * service worker need to read instantly.
 *
 * Why not IndexedDB for the running timer? Because the ONLY thing that makes a
 * timer survive a browser restart is a persisted start timestamp: elapsed time
 * is always recomputed as `now - startTime`, never counted up in memory. Keeping
 * that one record in chrome.storage.local makes it readable from the service
 * worker on wake with a single cheap call.
 */

const KEY_ACTIVE = 'activeSession';
const KEY_PREFS = 'prefs';
const KEY_LAST_SAVED = 'lastSavedSession';

const DEFAULT_PREFS = {
  lastProgramId: null,
  lastActivity: 'hunt',
  dashboardPeriod: 'month',
};

function area() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    throw new Error('chrome.storage is unavailable — is this running as an extension?');
  }
  return chrome.storage.local;
}

async function readKey(key, fallback) {
  const res = await area().get(key);
  return res?.[key] ?? fallback;
}

/* -------------------------------------------------------- active session -- */

/**
 * The running timer, or null.
 * Shape: { id, programId, activity, startTime }
 */
export async function getActiveSession() {
  return readKey(KEY_ACTIVE, null);
}

export async function setActiveSession(session) {
  await area().set({ [KEY_ACTIVE]: session });
  return session;
}

export async function clearActiveSession() {
  await area().remove(KEY_ACTIVE);
}

/* ----------------------------------------------------------------- prefs -- */

export async function getPrefs() {
  return { ...DEFAULT_PREFS, ...(await readKey(KEY_PREFS, {})) };
}

export async function setPrefs(patch) {
  const next = { ...(await getPrefs()), ...patch };
  await area().set({ [KEY_PREFS]: next });
  return next;
}

/* ----------------------------------------------- last saved session note -- */

/** Drives the "Session saved ✓ 1h 42m" confirmation after STOP. */
export async function setLastSaved(summary) {
  await area().set({ [KEY_LAST_SAVED]: summary });
}

export async function getLastSaved() {
  return readKey(KEY_LAST_SAVED, null);
}

export async function clearLastSaved() {
  await area().remove(KEY_LAST_SAVED);
}

/** Subscribe to changes in local storage (keeps popup and worker in sync). */
export function onChange(handler) {
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return () => {};
  const listener = (changes, areaName) => {
    if (areaName === 'local') handler(changes);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
