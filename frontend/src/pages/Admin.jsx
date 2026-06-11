import { useEffect, useState } from 'react';
import {
  getCredentials,
  saveCredentials,
  getCategories,
  getStreams,
  startBroadcast,
  stopBroadcast,
  getStatus,
  getLogs,
} from '../api.js';

export default function Admin() {
  const [cred, setCred] = useState({ host: '', username: '', password: '' });
  const [configured, setConfigured] = useState(false);
  const [credBusy, setCredBusy] = useState(false);
  const [credMsg, setCredMsg] = useState(null);

  const [categories, setCategories] = useState([]);
  const [activeCat, setActiveCat] = useState(null);
  const [streams, setStreams] = useState([]);
  const [loadingStreams, setLoadingStreams] = useState(false);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(null);

  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState([]);

  useEffect(() => {
    getCredentials()
      .then((c) => {
        setCred({ host: c.host || '', username: c.username || '', password: '' });
        setConfigured(c.configured);
        if (c.configured) loadCategories();
      })
      .catch(() => {});
    refreshStatus();
    const id = setInterval(refreshStatus, 4000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!showLogs) return;
    let on = true;
    const tick = () => getLogs().then((l) => on && setLogs(l)).catch(() => {});
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      on = false;
      clearInterval(id);
    };
  }, [showLogs]);

  async function refreshStatus() {
    try {
      setStatus(await getStatus());
    } catch {
      /* ignore */
    }
  }

  async function loadCategories() {
    try {
      setCategories(await getCategories());
    } catch (e) {
      setErr(e.message);
    }
  }

  async function onSaveCred(e) {
    e.preventDefault();
    setCredBusy(true);
    setCredMsg(null);
    setErr(null);
    try {
      const res = await saveCredentials(cred);
      setConfigured(true);
      const exp = res.userInfo?.exp_date
        ? new Date(Number(res.userInfo.exp_date) * 1000).toLocaleDateString()
        : null;
      setCredMsg('Connected' + (exp ? ` · expires ${exp}` : ''));
      await loadCategories();
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setCredBusy(false);
    }
  }

  async function openCategory(cat) {
    setActiveCat(cat);
    setLoadingStreams(true);
    setStreams([]);
    setFilter('');
    setSelected(null);
    setErr(null);
    try {
      setStreams(await getStreams(cat.category_id));
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoadingStreams(false);
    }
  }

  async function goLive(stream) {
    setBusy(true);
    setErr(null);
    try {
      await startBroadcast({
        streamId: stream.stream_id,
        name: stream.name,
        icon: stream.stream_icon,
      });
      await refreshStatus();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      await stopBroadcast();
      await refreshStatus();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  const b = status?.broadcast;
  const live = b?.status === 'live';
  const starting = b?.status === 'starting';
  const errored = b?.status === 'error';
  const filtered = streams.filter(
    (s) => !filter || (s.name || '').toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="admin">
      {/* ---- live status strip ---- */}
      <div className={'onair ' + (live ? 'is-live' : starting ? 'is-warm' : errored ? 'is-err' : '')}>
        <div className="onair-state">
          <span className="onair-light" />
          <div>
            <div className="onair-label">
              {live ? 'ON AIR' : starting ? 'STARTING' : errored ? 'ERROR' : 'OFF AIR'}
            </div>
            <div className="onair-channel">{b?.channel?.name || '— no channel —'}</div>
          </div>
        </div>
        <div className="onair-meta">
          {b?.error && <span className="onair-errtext">{b.error}</span>}
          {b?.ladder && (live || starting) && (
            <span className="onair-ladder">{b.ladder.map((r) => r.name).join(' / ')}</span>
          )}
        </div>
        <div className="onair-actions">
          <button className="btn btn-ghost" onClick={() => setShowLogs((s) => !s)}>
            {showLogs ? 'Hide logs' : 'Logs'}
          </button>
          <button className="btn btn-stop" onClick={stop} disabled={busy || b?.status === 'idle'}>
            ◼ Stop
          </button>
        </div>
      </div>

      {showLogs && (
        <pre className="logbox">
          {logs.length ? logs.join('\n') : 'no logs yet…'}
        </pre>
      )}

      {err && <div className="banner-err">{err}</div>}

      <div className="admin-grid">
        {/* ---- left column ---- */}
        <div className="col-left">
          <section className="panel">
            <div className="panel-head">
              <h2>Source</h2>
              <span className={'chip ' + (configured ? 'chip-ok' : 'chip-wait')}>
                {configured ? 'linked' : 'not linked'}
              </span>
            </div>
            <form className="form" onSubmit={onSaveCred}>
              <label className="field">
                <span>Host URL</span>
                <input
                  type="text"
                  placeholder="http://your-portal.com:8080"
                  value={cred.host}
                  onChange={(e) => setCred({ ...cred, host: e.target.value })}
                  autoComplete="off"
                  spellCheck="false"
                />
              </label>
              <div className="field-row">
                <label className="field">
                  <span>Username</span>
                  <input
                    type="text"
                    value={cred.username}
                    onChange={(e) => setCred({ ...cred, username: e.target.value })}
                    autoComplete="off"
                    spellCheck="false"
                  />
                </label>
                <label className="field">
                  <span>Password</span>
                  <input
                    type="password"
                    placeholder={configured ? '•••••• (saved)' : ''}
                    value={cred.password}
                    onChange={(e) => setCred({ ...cred, password: e.target.value })}
                    autoComplete="off"
                  />
                </label>
              </div>
              <button className="btn btn-primary" type="submit" disabled={credBusy}>
                {credBusy ? 'Connecting…' : configured ? 'Reconnect' : 'Connect'}
              </button>
              {credMsg && <div className="form-ok">✓ {credMsg}</div>}
            </form>
          </section>

          <section className="panel grow">
            <div className="panel-head">
              <h2>Packages</h2>
              <span className="muted-count">{categories.length}</span>
            </div>
            <div className="catlist">
              {!configured && <div className="empty">Link a source to load packages.</div>}
              {configured && categories.length === 0 && (
                <div className="empty">No packages found.</div>
              )}
              {categories.map((c) => (
                <button
                  key={c.category_id}
                  className={'catitem' + (activeCat?.category_id === c.category_id ? ' active' : '')}
                  onClick={() => openCategory(c)}
                >
                  <span className="catname">{c.category_name}</span>
                  <span className="catarrow">→</span>
                </button>
              ))}
            </div>
          </section>
        </div>

        {/* ---- right column: channels ---- */}
        <section className="panel col-right">
          <div className="panel-head">
            <h2>{activeCat ? activeCat.category_name : 'Channels'}</h2>
            {streams.length > 0 && (
              <input
                className="search"
                placeholder="Filter channels…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            )}
          </div>

          {!activeCat && <div className="empty big">Pick a package to browse its channels.</div>}
          {loadingStreams && <div className="empty big">Loading channels…</div>}
          {activeCat && !loadingStreams && filtered.length === 0 && (
            <div className="empty big">No channels match.</div>
          )}

          <div className="chgrid">
            {filtered.map((s) => {
              const isSel = selected?.stream_id === s.stream_id;
              const onAir = b?.channel?.id === s.stream_id && (live || starting);
              return (
                <div
                  key={s.stream_id}
                  className={'chcard' + (isSel ? ' sel' : '') + (onAir ? ' onair-card' : '')}
                  onClick={() => setSelected(s)}
                >
                  <div className="chlogo">
                    {s.stream_icon ? (
                      <img src={s.stream_icon} alt="" loading="lazy" onError={(e) => (e.target.style.display = 'none')} />
                    ) : (
                      <span className="chlogo-fallback">{(s.name || '?').slice(0, 2)}</span>
                    )}
                  </div>
                  <div className="chname" title={s.name}>
                    {s.name}
                  </div>
                  {onAir ? (
                    <span className="chbadge live">on air</span>
                  ) : (
                    <button
                      className="chgo"
                      onClick={(e) => {
                        e.stopPropagation();
                        goLive(s);
                      }}
                      disabled={busy}
                    >
                      ▶ Go live
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
