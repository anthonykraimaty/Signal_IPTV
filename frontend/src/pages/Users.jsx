import { useEffect, useState, useCallback } from 'react';
import * as api from '../api.js';
import { useAuth } from '../auth.jsx';

const ROLE_LABEL = {
  admin: 'Admin',
  control: 'Control channels',
  view: 'View only',
};
const ROLE_HINT = {
  admin: 'Manage users + source + broadcast',
  control: 'Change channels / start-stop the broadcast',
  view: 'Watch the live feed only',
};

function timeAgo(ts) {
  if (!ts) return '—';
  // SQLite stores UTC "YYYY-MM-DD HH:MM:SS"
  const t = Date.parse(ts.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(t)) return ts;
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function Users() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState(['admin', 'control', 'view']);
  const [sessions, setSessions] = useState([]);
  const [err, setErr] = useState(null);
  const [ok, setOk] = useState(null);

  // create form
  const [nu, setNu] = useState({ username: '', password: '', role: 'view' });
  const [creating, setCreating] = useState(false);

  const loadUsers = useCallback(async () => {
    try {
      const d = await api.listUsers();
      setUsers(d.users);
      if (d.roles) setRoles(d.roles);
    } catch (e) {
      setErr(e.message);
    }
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const d = await api.listSessions();
      setSessions(d.sessions);
    } catch {
      /* ignore polling errors */
    }
  }, []);

  useEffect(() => {
    loadUsers();
    loadSessions();
    const id = setInterval(loadSessions, 5000);
    return () => clearInterval(id);
  }, [loadUsers, loadSessions]);

  function flash(msg) {
    setOk(msg);
    setErr(null);
    setTimeout(() => setOk(null), 3000);
  }
  function fail(e) {
    setErr(typeof e === 'string' ? e : e.message);
    setOk(null);
  }

  async function onCreate(e) {
    e.preventDefault();
    setCreating(true);
    setErr(null);
    try {
      const d = await api.createUser({
        username: nu.username.trim(),
        password: nu.password,
        role: nu.role,
      });
      setNu({ username: '', password: '', role: 'view' });
      flash(`Created “${d.user.username}” (${ROLE_LABEL[d.user.role]})`);
      await Promise.all([loadUsers(), loadSessions()]);
    } catch (e2) {
      fail(e2);
    } finally {
      setCreating(false);
    }
  }

  async function onRole(u, role) {
    try {
      await api.setUserRole(u.id, role);
      flash(`${u.username} is now ${ROLE_LABEL[role]}`);
      await loadUsers();
    } catch (e) {
      fail(e);
    }
  }

  async function onReset(u) {
    const pw = window.prompt(`New password for “${u.username}” (min 6 chars):`);
    if (pw == null) return;
    try {
      await api.resetUserPassword(u.id, pw);
      flash(`Password reset for ${u.username} — they were logged out.`);
      await loadSessions();
    } catch (e) {
      fail(e);
    }
  }

  async function onToggleDisabled(u) {
    try {
      await api.setUserDisabled(u.id, !u.disabled);
      flash(`${u.username} ${u.disabled ? 'enabled' : 'disabled'}`);
      await Promise.all([loadUsers(), loadSessions()]);
    } catch (e) {
      fail(e);
    }
  }

  async function onDelete(u) {
    if (!window.confirm(`Delete user “${u.username}”? This cannot be undone.`)) return;
    try {
      await api.deleteUser(u.id);
      flash(`Deleted ${u.username}`);
      await Promise.all([loadUsers(), loadSessions()]);
    } catch (e) {
      fail(e);
    }
  }

  async function onKick(u) {
    try {
      await api.kickUser(u.id);
      flash(`Logged out all sessions for ${u.username}`);
      await loadSessions();
    } catch (e) {
      fail(e);
    }
  }

  // userId -> { count, lastSeen } for the online badge
  const online = new Map();
  for (const s of sessions) {
    const cur = online.get(s.userId) || { count: 0, lastSeen: s.lastSeen };
    cur.count += 1;
    if (s.lastSeen > cur.lastSeen) cur.lastSeen = s.lastSeen;
    online.set(s.userId, cur);
  }

  return (
    <div className="users-page">
      {err && <div className="banner-err">{err}</div>}
      {ok && <div className="banner-ok">✓ {ok}</div>}

      <div className="users-grid">
        {/* ---- left: create + who's online ---- */}
        <div className="col-left">
          <section className="panel">
            <div className="panel-head">
              <h2>New user</h2>
              <span className="chip chip-wait">admin only</span>
            </div>
            <form className="form" onSubmit={onCreate}>
              <label className="field">
                <span>Username</span>
                <input
                  type="text"
                  value={nu.username}
                  onChange={(e) => setNu({ ...nu, username: e.target.value })}
                  placeholder="e.g. operator1"
                  autoComplete="off"
                  spellCheck="false"
                />
              </label>
              <label className="field">
                <span>Temporary password</span>
                <input
                  type="text"
                  value={nu.password}
                  onChange={(e) => setNu({ ...nu, password: e.target.value })}
                  placeholder="min 6 characters"
                  autoComplete="off"
                  spellCheck="false"
                />
              </label>
              <label className="field">
                <span>Rights</span>
                <select value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })}>
                  {roles.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]} — {ROLE_HINT[r]}
                    </option>
                  ))}
                </select>
              </label>
              <button className="btn btn-primary" type="submit" disabled={creating}>
                {creating ? 'Creating…' : 'Create user'}
              </button>
            </form>
          </section>

          <section className="panel grow">
            <div className="panel-head">
              <h2>Who&rsquo;s online</h2>
              <span className="muted-count">{sessions.length}</span>
            </div>
            <div className="sesslist">
              {sessions.length === 0 && <div className="empty">No active sessions.</div>}
              {sessions.map((s, i) => (
                <div className="sessrow" key={s.userId + '-' + i}>
                  <span className="sess-dot" />
                  <div className="sess-main">
                    <div className="sess-name">
                      {s.username}
                      {s.current && <span className="sess-you">you</span>}
                    </div>
                    <div className="sess-meta">
                      {ROLE_LABEL[s.role]} · {timeAgo(s.lastSeen)} · {s.ip || '—'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* ---- right: user table ---- */}
        <section className="panel col-right">
          <div className="panel-head">
            <h2>Users</h2>
            <span className="muted-count">{users.length}</span>
          </div>

          <div className="utable">
            <div className="utable-head">
              <span>User</span>
              <span>Rights</span>
              <span>Status</span>
              <span className="ucol-actions">Actions</span>
            </div>
            {users.map((u) => {
              const on = online.get(u.id);
              const isMe = u.id === me?.id;
              return (
                <div className={'urow' + (u.disabled ? ' is-disabled' : '')} key={u.id}>
                  <div className="ucell-user">
                    <span className={'u-status-dot' + (on ? ' on' : '')} />
                    <div>
                      <div className="u-name">
                        {u.username}
                        {isMe && <span className="sess-you">you</span>}
                      </div>
                      <div className="u-sub">
                        {on ? `online · ${timeAgo(on.lastSeen)}` : 'offline'}
                      </div>
                    </div>
                  </div>

                  <div className="ucell-role">
                    <select
                      value={u.role}
                      disabled={isMe}
                      title={isMe ? 'You cannot change your own role' : ROLE_HINT[u.role]}
                      onChange={(e) => onRole(u, e.target.value)}
                    >
                      {roles.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="ucell-status">
                    {u.disabled ? (
                      <span className="chip chip-off">disabled</span>
                    ) : (
                      <span className="chip chip-ok">active</span>
                    )}
                  </div>

                  <div className="ucell-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => onReset(u)}>
                      Reset PW
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => onKick(u)}
                      disabled={!on}
                      title={on ? 'Force log out all sessions' : 'No active session'}
                    >
                      Log out
                    </button>
                    {!isMe && (
                      <button className="btn btn-ghost btn-sm" onClick={() => onToggleDisabled(u)}>
                        {u.disabled ? 'Enable' : 'Disable'}
                      </button>
                    )}
                    {!isMe && (
                      <button className="btn btn-stop btn-sm" onClick={() => onDelete(u)}>
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
