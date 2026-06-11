import fs from 'node:fs';
import path from 'node:path';
import { db, DATA_DIR } from './db.js';

// In-memory mirror of the single credentials row, so the rest of the app
// can read synchronously without touching the DB on every call.
let state = {
  xtream: { host: '', username: '', password: '' },
};

export function loadConfig() {
  try {
    const row = db.prepare('SELECT host, username, password FROM credentials WHERE id = 1').get();
    if (row) {
      state.xtream = {
        host: row.host || '',
        username: row.username || '',
        password: row.password || '',
      };
    }
    maybeMigrateLegacyJson();
  } catch (e) {
    console.error('[config] failed to load:', e.message);
  }
  return state;
}

// One-time import of the old data/config.json into SQLite, if present.
function maybeMigrateLegacyJson() {
  const legacy = path.join(DATA_DIR, 'config.json');
  if (!fs.existsSync(legacy) || isConfigured()) return;
  try {
    const raw = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    const x = raw?.xtream;
    if (x && x.host && x.username && x.password) {
      setXtream(x);
      fs.renameSync(legacy, legacy + '.migrated');
      console.log('[config] migrated credentials from config.json → SQLite');
    }
  } catch (e) {
    console.error('[config] legacy migration failed:', e.message);
  }
}

export function getXtream() {
  return state.xtream;
}

export function setXtream({ host, username, password }) {
  state.xtream = {
    host: normalizeHost(host),
    username: String(username ?? '').trim(),
    password: String(password ?? '').trim(),
  };
  persist();
  return state.xtream;
}

export function isConfigured() {
  const x = state.xtream;
  return Boolean(x.host && x.username && x.password);
}

function persist() {
  try {
    db.prepare(
      `INSERT INTO credentials (id, host, username, password, updated_at)
       VALUES (1, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         host = excluded.host,
         username = excluded.username,
         password = excluded.password,
         updated_at = excluded.updated_at`,
    ).run(state.xtream.host, state.xtream.username, state.xtream.password);
  } catch (e) {
    console.error('[config] failed to persist:', e.message);
  }
}

// Accept "domain:port", "http://domain:port", trailing slashes, etc.
export function normalizeHost(host) {
  let h = String(host ?? '').trim();
  if (!h) return '';
  if (!/^https?:\/\//i.test(h)) h = 'http://' + h;
  h = h.replace(/\/+$/, '');
  return h;
}
