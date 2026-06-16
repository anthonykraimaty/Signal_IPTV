import { db } from './db.js';
import * as broadcast from './broadcast.js';
import * as xtream from './xtream.js';
import { isConfigured } from './config.js';

const TICK_MS = 15_000;
let timer = null;
const log = [];

function pushLog(line) {
  log.push(`[${nowStamp()}] ${line}`);
  if (log.length > 60) log.shift();
}

// --- local-time helpers (server's timezone) ---
function pad(n) {
  return String(n).padStart(2, '0');
}
function nowStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function todayDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function hhmm(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// --- (de)serialization ---
function rowToSchedule(r) {
  if (!r) return null;
  return {
    id: r.id,
    streamId: r.stream_id,
    name: r.name,
    icon: r.icon,
    startTime: r.start_time,
    stopTime: r.stop_time,
    recurrence: r.recurrence,
    date: r.date,
    days: r.days ? r.days.split(',').map(Number) : [],
    enabled: !!r.enabled,
    createdBy: r.created_by,
    createdAt: r.created_at,
    lastFired: r.last_fired,
  };
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// "HH:MM" -> minutes since midnight; minutes -> "HH:MM" (wrapping past midnight).
function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function minutesToTime(mins) {
  const wrapped = ((mins % 1440) + 1440) % 1440;
  return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
}

// A stop can be given as an explicit stopTime OR as a durationMinutes added to the
// start. Either way the DB stores a single canonical stop_time ("HH:MM" or NULL).
function resolveStopTime(startTime, input) {
  if (input.stopTime) {
    if (!TIME_RE.test(input.stopTime)) throw new Error('Stop time must be HH:MM (24h) or empty');
    return input.stopTime;
  }
  if (input.durationMinutes === undefined || input.durationMinutes === null || input.durationMinutes === '') {
    return null; // open-ended
  }
  const dur = Number(input.durationMinutes);
  if (!Number.isInteger(dur) || dur <= 0) throw new Error('Duration must be a whole number of minutes (> 0)');
  if (dur >= 1440) throw new Error('Duration must be under 24 hours');
  return minutesToTime(timeToMinutes(startTime) + dur);
}

function validate(input) {
  const streamId = Number(input.streamId);
  if (!Number.isInteger(streamId)) throw new Error('A channel (streamId) is required');
  if (!input.name) throw new Error('Channel name is required');
  if (!TIME_RE.test(input.startTime || '')) throw new Error('Start time must be HH:MM (24h)');
  const stopTime = resolveStopTime(input.startTime, input);
  const recurrence = input.recurrence === 'weekly' ? 'weekly' : 'once';
  let date = null;
  let days = null;
  if (recurrence === 'once') {
    if (!DATE_RE.test(input.date || '')) throw new Error('A date (YYYY-MM-DD) is required for one-time schedules');
    date = input.date;
  } else {
    const list = (Array.isArray(input.days) ? input.days : [])
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
    if (!list.length) throw new Error('Pick at least one weekday for a weekly schedule');
    days = [...new Set(list)].sort().join(',');
  }
  return {
    streamId,
    name: String(input.name),
    icon: input.icon ? String(input.icon) : null,
    startTime: input.startTime,
    stopTime,
    recurrence,
    date,
    days,
    enabled: input.enabled === undefined ? 1 : input.enabled ? 1 : 0,
  };
}

// --- CRUD ---
export function listSchedules() {
  return db
    .prepare('SELECT * FROM schedules ORDER BY enabled DESC, start_time')
    .all()
    .map(rowToSchedule);
}

export function getSchedule(id) {
  return rowToSchedule(db.prepare('SELECT * FROM schedules WHERE id = ?').get(id));
}

export function createSchedule(input, createdBy = null) {
  const v = validate(input);
  const info = db
    .prepare(
      `INSERT INTO schedules
        (stream_id, name, icon, start_time, stop_time, recurrence, date, days, enabled, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(v.streamId, v.name, v.icon, v.startTime, v.stopTime, v.recurrence, v.date, v.days, v.enabled, createdBy);
  return getSchedule(Number(info.lastInsertRowid));
}

export function updateSchedule(id, input) {
  if (!getSchedule(id)) throw new Error('Schedule not found');
  const v = validate(input);
  db.prepare(
    `UPDATE schedules SET
       stream_id = ?, name = ?, icon = ?, start_time = ?, stop_time = ?,
       recurrence = ?, date = ?, days = ?, enabled = ?, last_fired = NULL
     WHERE id = ?`,
  ).run(v.streamId, v.name, v.icon, v.startTime, v.stopTime, v.recurrence, v.date, v.days, v.enabled, id);
  return getSchedule(id);
}

export function setEnabled(id, enabled) {
  if (!getSchedule(id)) throw new Error('Schedule not found');
  db.prepare('UPDATE schedules SET enabled = ?, last_fired = NULL WHERE id = ?').run(enabled ? 1 : 0, id);
  return getSchedule(id);
}

export function deleteSchedule(id) {
  if (!getSchedule(id)) throw new Error('Schedule not found');
  db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
  return true;
}

export function getLog() {
  return log.slice(-60);
}

// --- the tick loop ---

function activeToday(s, now) {
  if (!s.enabled) return false;
  if (s.recurrence === 'once') return s.date === todayDate(now);
  return s.days.includes(now.getDay()); // weekly
}

// True if this schedule's START fell on the given calendar day, ignoring the
// enabled flag. Used for the stop check: a one-time schedule disables itself
// after firing, but its stop still has to land — possibly on the next day.
function startedOnDate(s, dayDate, dayDow) {
  if (s.recurrence === 'once') return s.date === dayDate;
  return s.days.includes(dayDow); // weekly
}

// A stop "wraps" past midnight when its time is at/before the start time, so the
// window ends on the day AFTER the one it started on.
function stopWrapsMidnight(s) {
  return timeToMinutes(s.stopTime) <= timeToMinutes(s.startTime);
}

async function fireStart(s, marker) {
  // Mark first so a slow start doesn't double-fire on the next tick.
  db.prepare('UPDATE schedules SET last_fired = ? WHERE id = ?').run(marker, s.id);
  if (!isConfigured()) {
    pushLog(`SKIP "${s.name}" — no Xtream source configured`);
    return;
  }
  try {
    const url = xtream.buildStreamUrl(s.streamId);
    await broadcast.start({ id: s.streamId, name: s.name, icon: s.icon }, url);
    pushLog(`START "${s.name}" (schedule #${s.id})`);
    // One-time schedules disable themselves once fired.
    if (s.recurrence === 'once') {
      db.prepare('UPDATE schedules SET enabled = 0 WHERE id = ?').run(s.id);
      pushLog(`schedule #${s.id} was one-time → disabled`);
    }
  } catch (e) {
    pushLog(`ERROR starting "${s.name}": ${e.message}`);
  }
}

function fireStop(s) {
  const b = broadcast.getStatus();
  // Only stop if THIS schedule's channel is what's currently live (latest-start-wins).
  if (b.channel && b.channel.id === s.streamId && b.status !== 'idle') {
    broadcast.stop();
    pushLog(`STOP "${s.name}" (schedule #${s.id})`);
  }
}

async function tick() {
  let now;
  try {
    now = new Date();
  } catch {
    return; // (defensive; Date is available in normal runtime)
  }
  const cur = hhmm(now);
  const startMarker = `${todayDate(now)}T${cur}`;

  // Yesterday, for stops that wrap past midnight.
  const yesterday = new Date(now.getTime() - 86_400_000);
  const yDate = todayDate(yesterday);
  const yDow = yesterday.getDay();

  for (const s of listSchedules()) {
    // START at exact minute, once per occurrence (guarded by last_fired marker).
    if (activeToday(s, now) && s.startTime === cur && s.lastFired !== startMarker) {
      await fireStart(s, startMarker);
    }

    // STOP at exact minute. Decoupled from activeToday/enabled so it survives the
    // one-time self-disable, and matched against the day the window OPENED:
    //   - same-day window (stop > start): the window opened today.
    //   - cross-midnight window (stop <= start): the window opened yesterday.
    // fireStop only acts if this schedule still owns the live broadcast.
    if (s.stopTime && s.stopTime === cur) {
      const openedDay = stopWrapsMidnight(s)
        ? startedOnDate(s, yDate, yDow)
        : startedOnDate(s, todayDate(now), now.getDay());
      if (openedDay) fireStop(s);
    }
  }
}

export function startScheduler() {
  if (timer) return;
  pushLog('scheduler started');
  // Run on a fixed cadence; minute-granularity matching makes missed sub-minute drift harmless.
  timer = setInterval(() => {
    tick().catch((e) => pushLog('tick error: ' + e.message));
  }, TICK_MS);
  if (timer.unref) timer.unref();
  // Kick once on boot so an in-window start is honored promptly.
  tick().catch(() => {});
}

export function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
