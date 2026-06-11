import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'iptv.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Single shared SQLite connection for the whole backend (credentials + users + sessions).
export const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// --- schema ---
db.exec(`
  CREATE TABLE IF NOT EXISTS credentials (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    host     TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL DEFAULT '',
    password TEXT NOT NULL DEFAULT '',
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'view' CHECK (role IN ('admin','control','view')),
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    must_change   INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
    user_agent  TEXT,
    ip          TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS favorites (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stream_id   INTEGER NOT NULL,
    name        TEXT,
    icon        TEXT,
    category_id TEXT,
    added_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, stream_id)
  );

  CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);

  CREATE TABLE IF NOT EXISTS schedules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id   INTEGER NOT NULL,
    name        TEXT NOT NULL,
    icon        TEXT,
    start_time  TEXT NOT NULL,             -- "HH:MM" (24h, server-local)
    stop_time   TEXT,                       -- "HH:MM" or NULL (open-ended)
    recurrence  TEXT NOT NULL DEFAULT 'once' CHECK (recurrence IN ('once','weekly')),
    date        TEXT,                       -- "YYYY-MM-DD" for one-time runs
    days        TEXT,                       -- CSV of weekday numbers 0..6 (Sun=0) for weekly
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_fired  TEXT                        -- "YYYY-MM-DDTHH:MM" marker to avoid double-firing
  );
`);

export { DATA_DIR, DB_FILE };
