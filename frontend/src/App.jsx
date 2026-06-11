import { Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import { useState } from 'react';
import Home from './pages/Home.jsx';
import Admin from './pages/Admin.jsx';
import Users from './pages/Users.jsx';
import Schedules from './pages/Schedules.jsx';
import Login from './pages/Login.jsx';
import { AuthProvider, useAuth } from './auth.jsx';
import * as api from './api.js';

const ROLE_LABEL = { admin: 'Admin', control: 'Control', view: 'Viewer' };

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}

function Shell() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="app">
        <div className="scanlines" aria-hidden="true" />
        <div className="boot">Loading…</div>
      </div>
    );
  }

  if (!user) return <Login />;

  return (
    <div className="app">
      <div className="scanlines" aria-hidden="true" />
      <ForcePasswordChange />
      <TopBar />
      <main className="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route
            path="/admin"
            element={
              <RequireRole min="control">
                <Admin />
              </RequireRole>
            }
          />
          <Route
            path="/users"
            element={
              <RequireRole min="admin">
                <Users />
              </RequireRole>
            }
          />
          <Route
            path="/schedule"
            element={
              <RequireRole min="admin">
                <Schedules />
              </RequireRole>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function TopBar() {
  const { user, logout, is } = useAuth();
  return (
    <header className="topbar">
      <NavLink to="/" className="brand">
        <span className="brand-mark" />
        <span className="brand-name">SIGNAL</span>
        <span className="brand-sub">re&middot;stream</span>
      </NavLink>
      <nav className="nav">
        <NavLink to="/" end className={({ isActive }) => 'navlink' + (isActive ? ' active' : '')}>
          Watch
        </NavLink>
        {is('control') && (
          <NavLink
            to="/admin"
            className={({ isActive }) => 'navlink' + (isActive ? ' active' : '')}
          >
            Control&nbsp;Room
          </NavLink>
        )}
        {is('admin') && (
          <NavLink
            to="/schedule"
            className={({ isActive }) => 'navlink' + (isActive ? ' active' : '')}
          >
            Schedule
          </NavLink>
        )}
        {is('admin') && (
          <NavLink
            to="/users"
            className={({ isActive }) => 'navlink' + (isActive ? ' active' : '')}
          >
            Users
          </NavLink>
        )}
      </nav>
      <div className="user-chip">
        <span className="user-name">{user.username}</span>
        <span className={'role-pill role-' + user.role}>{ROLE_LABEL[user.role] || user.role}</span>
        <button className="btn btn-ghost btn-sm" onClick={logout}>
          Sign out
        </button>
      </div>
    </header>
  );
}

function RequireRole({ min, children }) {
  const { is } = useAuth();
  const location = useLocation();
  if (!is(min)) {
    return (
      <div className="forbidden">
        <h1>No access</h1>
        <p>
          Your account doesn&rsquo;t have permission to view <code>{location.pathname}</code>.
        </p>
        <NavLink to="/" className="ghost-btn">
          ← Back to Watch
        </NavLink>
      </div>
    );
  }
  return children;
}

// Shown when an admin reset this user's password — they must set a new one.
function ForcePasswordChange() {
  const { user, refresh } = useAuth();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  if (!user?.mustChange) return null;

  async function submit(e) {
    e.preventDefault();
    if (pw.length < 6) return setErr('Password must be at least 6 characters');
    if (pw !== pw2) return setErr('Passwords do not match');
    setBusy(true);
    setErr(null);
    try {
      await api.changeMyPassword(pw);
      await refresh();
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="modal-card" onSubmit={submit}>
        <h2>Set a new password</h2>
        <p className="login-sub">An administrator reset your password. Choose a new one to continue.</p>
        <label className="field">
          <span>New password</span>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        </label>
        <label className="field">
          <span>Confirm password</span>
          <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        </label>
        {err && <div className="banner-err">{err}</div>}
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save & continue'}
        </button>
      </form>
    </div>
  );
}
