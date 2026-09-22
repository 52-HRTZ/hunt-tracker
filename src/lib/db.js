/**
 * IndexedDB access layer.
 *
 * IndexedDB (not chrome.storage) holds the growing structured data —
 * sessions, findings, history — because it survives browser/extension/computer
 * restarts, has no practical quota ceiling with "unlimitedStorage", and can be
 * queried by index instead of deserialising everything on each read.
 *
 * chrome.storage.local holds only the tiny hot state (the running timer,
 * last-used selections) — see store.js.
 */

import { DEFAULT_SETTINGS, SCHEMA_VERSION, makeHistoryEntry } from './models.js';

const DB_NAME = 'bug-hunt-tracker';
const DB_VERSION = 2;

export const STORE = {
  PROGRAMS: 'programs',
  SESSIONS: 'sessions',
  FINDINGS: 'findings',
  HISTORY: 'history',
  META: 'meta',
  GOALS: 'goals',
};

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = req.result;
      const from = event.oldVersion;

      if (from < 1) {
        const programs = db.createObjectStore(STORE.PROGRAMS, { keyPath: 'id' });
        programs.createIndex('name', 'name', { unique: false });
        programs.createIndex('active', 'active', { unique: false });

        const sessions = db.createObjectStore(STORE.SESSIONS, { keyPath: 'id' });
        sessions.createIndex('date', 'date', { unique: false });
        sessions.createIndex('startTime', 'startTime', { unique: false });
        sessions.createIndex('programId', 'programId', { unique: false });
        sessions.createIndex('activity', 'activity', { unique: false });

        const findings = db.createObjectStore(STORE.FINDINGS, { keyPath: 'id' });
        findings.createIndex('createdAt', 'createdAt', { unique: false });
        findings.createIndex('programId', 'programId', { unique: false });
        findings.createIndex('status', 'status', { unique: false });
        findings.createIndex('ref', 'ref', { unique: false });

        const history = db.createObjectStore(STORE.HISTORY, { keyPath: 'id' });
        history.createIndex('findingId', 'findingId', { unique: false });
        history.createIndex('timestamp', 'timestamp', { unique: false });

        db.createObjectStore(STORE.META, { keyPath: 'key' });
      }

      if (from < 2) {
        // Goals: one metric over one period, optionally scoped to a program.
        const goals = db.createObjectStore(STORE.GOALS, { keyPath: 'id' });
        goals.createIndex('period',    'period',    { unique: false });
        goals.createIndex('metric',    'metric',    { unique: false });
        goals.createIndex('programId', 'programId', { unique: false });
        goals.createIndex('active',    'active',    { unique: false });
      }
      // Future migrations append `if (from < N) { ... }` blocks here.
    };

    req.onsuccess = () => {
      const db = req.result;
      // If another tab upgrades the schema, close this handle so it can proceed.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('Could not open IndexedDB'));
    req.onblocked = () => reject(new Error('Database upgrade blocked by another open tab'));
  });
  return dbPromise;
}

function tx(db, stores, mode) {
  const t = db.transaction(stores, mode);
  const done = new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error ?? new Error('Transaction failed'));
    t.onabort = () => reject(t.error ?? new Error('Transaction aborted'));
  });
  return { t, done };
}

function reqAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getAll(storeName, query = null) {
  const db = await openDB();
  const { t } = tx(db, [storeName], 'readonly');
  return reqAsPromise(t.objectStore(storeName).getAll(query));
}

export async function getAllByIndex(storeName, indexName, query) {
  const db = await openDB();
  const { t } = tx(db, [storeName], 'readonly');
  return reqAsPromise(t.objectStore(storeName).index(indexName).getAll(query));
}

export async function get(storeName, key) {
  const db = await openDB();
  const { t } = tx(db, [storeName], 'readonly');
  return reqAsPromise(t.objectStore(storeName).get(key));
}

export async function put(storeName, value) {
  const db = await openDB();
  const { t, done } = tx(db, [storeName], 'readwrite');
  t.objectStore(storeName).put(value);
  await done;
  return value;
}

export async function putMany(storeName, values) {
  if (!values.length) return 0;
  const db = await openDB();
  const { t, done } = tx(db, [storeName], 'readwrite');
  const store = t.objectStore(storeName);
  for (const v of values) store.put(v);
  await done;
  return values.length;
}

export async function remove(storeName, key) {
  const db = await openDB();
  const { t, done } = tx(db, [storeName], 'readwrite');
  t.objectStore(storeName).delete(key);
  await done;
}

export async function clearStore(storeName) {
  const db = await openDB();
  const { t, done } = tx(db, [storeName], 'readwrite');
  t.objectStore(storeName).clear();
  await done;
}

export async function count(storeName) {
  const db = await openDB();
  const { t } = tx(db, [storeName], 'readonly');
  return reqAsPromise(t.objectStore(storeName).count());
}

/* ---------------------------------------------------------------- meta ---- */

export async function getMeta(key, fallback = null) {
  const row = await get(STORE.META, key);
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  await put(STORE.META, { key, value });
  return value;
}

export async function getSettings() {
  const stored = await getMeta('settings');
  // Merge so a settings object written by an older version still gains new keys.
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}), schemaVersion: SCHEMA_VERSION };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await setMeta('settings', next);
  return next;
}

/**
 * Next human-facing finding number (#1, #2, ...), allocated in its own
 * transaction so two rapid creations cannot collide on the same ref.
 */
export async function nextFindingRef() {
  const db = await openDB();
  const { t, done } = tx(db, [STORE.META], 'readwrite');
  const store = t.objectStore(STORE.META);
  const row = await reqAsPromise(store.get('findingRefCounter'));
  const next = ((row?.value ?? 0) | 0) + 1;
  store.put({ key: 'findingRefCounter', value: next });
  await done;
  return next;
}

/**
 * Write a finding and its history entries in ONE transaction, so a finding can
 * never end up updated without the matching audit trail (or vice versa).
 */
export async function putFindingWithHistory(finding, historyEntries = []) {
  const db = await openDB();
  const { t, done } = tx(db, [STORE.FINDINGS, STORE.HISTORY], 'readwrite');
  t.objectStore(STORE.FINDINGS).put(finding);
  const hist = t.objectStore(STORE.HISTORY);
  for (const entry of historyEntries) hist.put(makeHistoryEntry(entry));
  await done;
  return finding;
}

/** Deleting a finding must not orphan its history rows. */
export async function deleteFindingCascade(findingId) {
  const db = await openDB();
  const { t, done } = tx(db, [STORE.FINDINGS, STORE.HISTORY], 'readwrite');
  t.objectStore(STORE.FINDINGS).delete(findingId);
  const idx = t.objectStore(STORE.HISTORY).index('findingId');
  const cursorReq = idx.openCursor(IDBKeyRange.only(findingId));
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };
  await done;
}

/** Reset everything (used by Settings -> Erase all data, and by JSON import). */
export async function wipeAll() {
  const db = await openDB();
  const names = [STORE.PROGRAMS, STORE.SESSIONS, STORE.FINDINGS, STORE.HISTORY, STORE.META, STORE.GOALS];
  const { t, done } = tx(db, names, 'readwrite');
  for (const n of names) t.objectStore(n).clear();
  await done;
}
