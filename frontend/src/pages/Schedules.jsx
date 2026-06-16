import { useEffect, useState, useCallback } from 'react';
import * as api from '../api.js';

const WEEKDAYS = [
  { n: 1, label: 'Mon' },
  { n: 2, label: 'Tue' },
  { n: 3, label: 'Wed' },
  { n: 4, label: 'Thu' },
  { n: 5, label: 'Fri' },
  { n: 6, label: 'Sat' },
  { n: 0, label: 'Sun' },
];

const EMPTY = {
  channelKey: '', // "streamId|name|icon" from favorites picker
  streamId: '',
  name: '',
  icon: '',
  startTime: '20:00',
  endMode: 'time', // 'time' | 'duration'
  stopTime: '',
  durationMinutes: '', // minutes, used when endMode === 'duration'
  recurrence: 'once',
  date: '',
  days: [],
};

function fmtDays(days) {
  if (!days?.length) return '';
  return WEEKDAYS.filter((d) => days.includes(d.n)).map((d) => d.label).join(' ');
}

// Project "start + N minutes" to a readable "at HH:MM" hint (wraps past midnight).
function durationLabel(startTime, minutes) {
  const mins = Number(minutes);
  if (!/^\d{1,2}:\d{2}$/.test(startTime || '') || !Number.isFinite(mins) || mins <= 0) {
    return 'after the chosen number of minutes';
  }
  const [h, m] = startTime.split(':').map(Number);
  const total = ((h * 60 + m + mins) % 1440 + 1440) % 1440;
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `at ${hh}:${mm}`;
}

function describe(s) {
  const when =
    s.recurrence === 'once'
      ? s.date
      : `weekly · ${fmtDays(s.days)}`;
  const window = s.stopTime ? `${s.startTime}–${s.stopTime}` : `${s.startTime} → open`;
  return `${window} · ${when}`;
}

export default function Schedules() {
  const [schedules, setSchedules] = useState([]);
  const [log, setLog] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [editingId, setEditingId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [ok, setOk] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await api.getSchedules();
      setSchedules(d.schedules);
      setLog(d.log || []);
    } catch (e) {
      setErr(e.message);
    }
  }, []);

  useEffect(() => {
    load();
    api.getFavorites().then(setFavorites).catch(() => {});
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  function flash(m) {
    setOk(m);
    setErr(null);
    setTimeout(() => setOk(null), 3000);
  }

  function resetForm() {
    setForm(EMPTY);
    setEditingId(null);
  }

  function pickChannel(key) {
    if (!key) return setForm((f) => ({ ...f, channelKey: '', streamId: '', name: '', icon: '' }));
    const fav = favorites.find((x) => String(x.streamId) === key);
    if (fav) {
      setForm((f) => ({
        ...f,
        channelKey: key,
        streamId: fav.streamId,
        name: fav.name,
        icon: fav.icon || '',
      }));
    }
  }

  function toggleDay(n) {
    setForm((f) => ({
      ...f,
      days: f.days.includes(n) ? f.days.filter((d) => d !== n) : [...f.days, n],
    }));
  }

  function startEdit(s) {
    setEditingId(s.id);
    setForm({
      channelKey: favorites.some((f) => f.streamId === s.streamId) ? String(s.streamId) : '',
      streamId: s.streamId,
      name: s.name,
      icon: s.icon || '',
      startTime: s.startTime,
      endMode: 'time',
      stopTime: s.stopTime || '',
      durationMinutes: '',
      recurrence: s.recurrence,
      date: s.date || '',
      days: s.days || [],
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const body = {
      streamId: Number(form.streamId),
      name: form.name,
      icon: form.icon || null,
      startTime: form.startTime,
      // End is sent one way or the other; the backend resolves both to a stop time.
      stopTime: form.endMode === 'time' ? form.stopTime || null : null,
      durationMinutes:
        form.endMode === 'duration' && form.durationMinutes !== ''
          ? Number(form.durationMinutes)
          : null,
      recurrence: form.recurrence,
      date: form.recurrence === 'once' ? form.date : null,
      days: form.recurrence === 'weekly' ? form.days : [],
    };
    try {
      if (!body.streamId) throw new Error('Pick a channel (or enter a stream ID)');
      if (!body.name) throw new Error('Channel name is required');
      if (editingId) {
        await api.updateSchedule(editingId, body);
        flash('Schedule updated');
      } else {
        await api.createSchedule(body);
        flash('Schedule created');
      }
      resetForm();
      await load();
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  }

  async function onToggle(s) {
    try {
      await api.setScheduleEnabled(s.id, !s.enabled);
      await load();
    } catch (e) {
      setErr(e.message);
    }
  }

  async function onDelete(s) {
    if (!window.confirm(`Delete schedule for “${s.name}”?`)) return;
    try {
      await api.deleteSchedule(s.id);
      flash('Schedule deleted');
      if (editingId === s.id) resetForm();
      await load();
    } catch (e) {
      setErr(e.message);
    }
  }

  const usingManual = !form.channelKey;

  return (
    <div className="sched-page">
      {err && <div className="banner-err">{err}</div>}
      {ok && <div className="banner-ok">✓ {ok}</div>}

      <div className="sched-grid">
        {/* ---- left: create / edit form ---- */}
        <section className="panel">
          <div className="panel-head">
            <h2>{editingId ? 'Edit schedule' : 'New schedule'}</h2>
            <span className="chip chip-wait">admin only</span>
          </div>
          <form className="form" onSubmit={onSubmit}>
            <label className="field">
              <span>Channel {favorites.length === 0 && '(favorite a channel first, or enter an ID below)'}</span>
              <select value={form.channelKey} onChange={(e) => pickChannel(e.target.value)}>
                <option value="">— pick from favorites —</option>
                {favorites.map((f) => (
                  <option key={f.streamId} value={String(f.streamId)}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>

            {usingManual && (
              <div className="field-row">
                <label className="field">
                  <span>Stream ID</span>
                  <input
                    type="number"
                    value={form.streamId}
                    onChange={(e) => setForm({ ...form, streamId: e.target.value })}
                    placeholder="e.g. 441832"
                  />
                </label>
                <label className="field">
                  <span>Channel name</span>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="e.g. BBC One HD"
                  />
                </label>
              </div>
            )}
            {!usingManual && (
              <div className="sched-picked">
                Broadcasting <b>{form.name}</b> <span className="muted">#{form.streamId}</span>
              </div>
            )}

            <div className="field-row">
              <label className="field">
                <span>Start time</span>
                <input
                  type="time"
                  value={form.startTime}
                  onChange={(e) => setForm({ ...form, startTime: e.target.value })}
                  required
                />
              </label>
              <label className="field">
                <span>Ends by</span>
                <select
                  value={form.endMode}
                  onChange={(e) => setForm({ ...form, endMode: e.target.value })}
                >
                  <option value="time">Stop time</option>
                  <option value="duration">Duration</option>
                </select>
              </label>
            </div>

            {form.endMode === 'time' ? (
              <label className="field">
                <span>Stop time (optional)</span>
                <input
                  type="time"
                  value={form.stopTime}
                  onChange={(e) => setForm({ ...form, stopTime: e.target.value })}
                />
                <small className="muted">Leave empty to keep the channel open-ended.</small>
              </label>
            ) : (
              <label className="field">
                <span>Duration (minutes)</span>
                <input
                  type="number"
                  min="1"
                  max="1439"
                  step="1"
                  value={form.durationMinutes}
                  onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })}
                  placeholder="e.g. 90"
                />
                <small className="muted">Stops {form.durationMinutes ? durationLabel(form.startTime, form.durationMinutes) : 'after the chosen number of minutes'}.</small>
              </label>
            )}

            <label className="field">
              <span>Repeat</span>
              <select
                value={form.recurrence}
                onChange={(e) => setForm({ ...form, recurrence: e.target.value })}
              >
                <option value="once">One time (on a date)</option>
                <option value="weekly">Weekly (chosen days)</option>
              </select>
            </label>

            {form.recurrence === 'once' ? (
              <label className="field">
                <span>Date</span>
                <input
                  type="date"
                  value={form.date}
                  onChange={(e) => setForm({ ...form, date: e.target.value })}
                  required
                />
              </label>
            ) : (
              <div className="field">
                <span>Days</span>
                <div className="daypick">
                  {WEEKDAYS.map((d) => (
                    <button
                      type="button"
                      key={d.n}
                      className={'daybtn' + (form.days.includes(d.n) ? ' on' : '')}
                      onClick={() => toggleDay(d.n)}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="sched-formactions">
              <button className="btn btn-primary" type="submit" disabled={busy}>
                {busy ? 'Saving…' : editingId ? 'Save changes' : 'Add schedule'}
              </button>
              {editingId && (
                <button type="button" className="btn btn-ghost" onClick={resetForm}>
                  Cancel
                </button>
              )}
            </div>
            <p className="login-sub" style={{ marginTop: 8 }}>
              Times are in the server&rsquo;s local timezone. If two schedules overlap, the most
              recently started one takes over the single broadcast.
            </p>
          </form>
        </section>

        {/* ---- right: schedule list + activity ---- */}
        <section className="panel">
          <div className="panel-head">
            <h2>Schedules</h2>
            <span className="muted-count">{schedules.length}</span>
          </div>

          {schedules.length === 0 && (
            <div className="empty big">No schedules yet. Create one on the left.</div>
          )}

          <div className="sched-list">
            {schedules.map((s) => (
              <div className={'sched-card' + (s.enabled ? '' : ' is-off')} key={s.id}>
                <div className="sched-logo">
                  {s.icon ? (
                    <img src={s.icon} alt="" onError={(e) => (e.target.style.display = 'none')} />
                  ) : (
                    <span className="chlogo-fallback">{(s.name || '?').slice(0, 2)}</span>
                  )}
                </div>
                <div className="sched-main">
                  <div className="sched-name">{s.name}</div>
                  <div className="sched-when">{describe(s)}</div>
                </div>
                <div className="sched-actions">
                  <span className={'chip ' + (s.enabled ? 'chip-ok' : 'chip-off')}>
                    {s.enabled ? 'on' : 'off'}
                  </span>
                  <button className="btn btn-ghost btn-sm" onClick={() => onToggle(s)}>
                    {s.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => startEdit(s)}>
                    Edit
                  </button>
                  <button className="btn btn-stop btn-sm" onClick={() => onDelete(s)}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>

          {log.length > 0 && (
            <>
              <div className="panel-head" style={{ marginTop: 18 }}>
                <h2>Activity</h2>
              </div>
              <pre className="logbox">{log.join('\n')}</pre>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
