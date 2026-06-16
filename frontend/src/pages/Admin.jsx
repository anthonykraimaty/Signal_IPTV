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
  getFavorites,
  addFavorite,
  removeFavorite,
  getBroadcastModes,
  probeChannel,
} from '../api.js';
import { useAuth } from '../auth.jsx';

// Synthetic "package" representing the current user's favorites.
const FAV_CAT = { category_id: '__fav__', category_name: '★ Favorites' };

// Persist small UI prefs (broadcast mode, picked rungs) across page refreshes.
const PREF_NS = 'signal.';
function loadPref(key, fallback) {
  try {
    const raw = localStorage.getItem(PREF_NS + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function savePref(key, value) {
  try {
    localStorage.setItem(PREF_NS + key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode / quota) — non-fatal */
  }
}

export default function Admin() {
  const { is } = useAuth();
  const isAdmin = is('admin');

  const [cred, setCred] = useState({ host: '', username: '', password: '' });
  const [configured, setConfigured] = useState(false);
  const [credBusy, setCredBusy] = useState(false);
  const [credMsg, setCredMsg] = useState(null);

  const [categories, setCategories] = useState([]);
  const [catFilter, setCatFilter] = useState('');
  const [activeCat, setActiveCat] = useState(null);
  const [streams, setStreams] = useState([]);
  const [loadingStreams, setLoadingStreams] = useState(false);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(null);

  const [favorites, setFavorites] = useState([]); // [{streamId, name, icon, categoryId}]

  // Broadcast mode: 'hybrid' (source as-is + downscale rungs), 'transcode'
  // (re-encode all rungs), or 'copy' (pass-through only). Hybrid is the default:
  // full-quality top with almost no CPU, plus fallbacks for weak connections.
  // Persisted to localStorage so the choice survives a page refresh.
  const [bcMode, setBcMode] = useState(() => loadPref('bcMode', 'hybrid'));
  const [rungCatalog, setRungCatalog] = useState([]); // [{name,height,width,vbitrate}]
  const [pickedRungs, setPickedRungs] = useState(() => loadPref('pickedRungs', ['480p', '360p']));

  // Latency/buffer preset: 'low' | 'balanced' | 'safe' (closer-to-live vs smoother).
  const [bufferPresets, setBufferPresets] = useState([]); // [{name,label,hlsTime,approxLatency}]
  const [bcBuffer, setBcBuffer] = useState(() => loadPref('bcBuffer', 'balanced'));

  // Persist broadcast-mode prefs whenever they change.
  useEffect(() => savePref('bcMode', bcMode), [bcMode]);
  useEffect(() => savePref('pickedRungs', pickedRungs), [pickedRungs]);
  useEffect(() => savePref('bcBuffer', bcBuffer), [bcBuffer]);

  // Channel info from ffprobe, keyed by streamId: { loading, info, error }.
  const [chInfo, setChInfo] = useState({});

  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null); // transient notice (e.g. HEVC fallback)

  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState([]);

  useEffect(() => {
    // Admins manage the source; control users only browse, so guard the creds call.
    if (isAdmin) {
      getCredentials()
        .then((c) => {
          setCred({ host: c.host || '', username: c.username || '', password: '' });
          setConfigured(c.configured);
        })
        .catch(() => {});
    }
    // Everyone with control+ can list packages and favorites.
    loadCategories();
    loadFavorites();
    refreshStatus();
    getBroadcastModes()
      .then(({ rungs, buffers }) => {
        setRungCatalog(rungs);
        setBufferPresets(buffers);
      })
      .catch(() => {});
    const id = setInterval(refreshStatus, 4000);
    return () => clearInterval(id);
  }, [isAdmin]);

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
      const cats = await getCategories();
      setCategories(cats);
      // A successful package load means the source is linked (covers control users
      // who can't read /api/credentials).
      if (cats.length) setConfigured(true);
    } catch {
      // Not linked yet, or no permission — leave the list empty.
    }
  }

  async function loadFavorites() {
    try {
      setFavorites(await getFavorites());
    } catch {
      /* ignore */
    }
  }

  const isFav = (streamId) => favorites.some((f) => f.streamId === streamId);

  async function toggleFav(s, e) {
    if (e) e.stopPropagation();
    const streamId = s.stream_id ?? s.streamId;
    try {
      const next = isFav(streamId)
        ? await removeFavorite(streamId)
        : await addFavorite({
            streamId,
            name: s.name,
            icon: s.stream_icon ?? s.icon ?? null,
            categoryId: activeCat && activeCat !== FAV_CAT ? activeCat.category_id : s.categoryId,
          });
      setFavorites(next);
    } catch (e2) {
      setErr(e2.message);
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
    setFilter('');
    setSelected(null);
    setErr(null);

    // The favorites pseudo-package renders the saved list — no remote fetch.
    if (cat.category_id === FAV_CAT.category_id) {
      setStreams([]);
      setLoadingStreams(false);
      return;
    }

    setLoadingStreams(true);
    setStreams([]);
    try {
      setStreams(await getStreams(cat.category_id));
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoadingStreams(false);
    }
  }

  function toggleRung(name) {
    setPickedRungs((cur) =>
      cur.includes(name) ? cur.filter((r) => r !== name) : [...cur, name],
    );
  }

  // Probe a channel for codec/resolution (fast). Bitrate is measured only on
  // demand (withBitrate) since it's slower and holds the upstream connection.
  async function loadChannelInfo(stream, withBitrate = false) {
    const id = stream.stream_id ?? stream.streamId;
    const cached = chInfo[id];
    if (!withBitrate && (cached?.info || cached?.loading)) return; // cached / in flight
    if (withBitrate && cached?.measuring) return;
    setChInfo((m) => ({
      ...m,
      [id]: { ...cached, loading: !cached?.info, measuring: withBitrate },
    }));
    try {
      const info = await probeChannel(id, withBitrate);
      setChInfo((m) => ({ ...m, [id]: { loading: false, measuring: false, info } }));
    } catch (e) {
      setChInfo((m) => ({
        ...m,
        [id]: { ...m[id], loading: false, measuring: false, error: e.message },
      }));
    }
  }

  async function goLive(stream, modeOverride) {
    setBusy(true);
    setErr(null);
    setNote(null);
    // Pass-through with no rungs makes no sense; default to the picked ladder.
    const mode = modeOverride || bcMode;
    try {
      const res = await startBroadcast({
        streamId: stream.stream_id ?? stream.streamId,
        name: stream.name,
        icon: stream.stream_icon ?? stream.icon,
        mode,
        rungs: mode === 'copy' ? [] : pickedRungs,
        buffer: bcBuffer,
      });
      if (res?.fallbackNote) setNote(res.fallbackNote);
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
  // 'reconnecting' is a transitional state (source dropped, auto-retrying the
  // same channel) — treat it as warm like 'starting' so the UI doesn't read
  // "off air" while it's actively recovering.
  const reconnecting = b?.status === 'reconnecting';
  const starting = b?.status === 'starting' || reconnecting;
  const errored = b?.status === 'error';

  // The mode/rungs actually running, vs. what the picker now shows. Used to nudge
  // the user that a live change won't take effect until the channel is relaunched.
  const liveMode = b?.mode || null;
  const liveBuffer = b?.buffer || null;
  // For hybrid the status ladder is ['source', …encoded rungs]; strip 'source'.
  const liveRungs = (b?.ladder || []).map((r) => r.name).filter((n) => n !== 'source');
  const wantRungs = bcMode === 'copy' ? [] : pickedRungs;
  const sameSet = (a, c) => a.length === c.length && [...a].sort().join() === [...c].sort().join();
  const settingsDiffer =
    (live || starting) &&
    b?.channel &&
    (liveMode !== bcMode || liveBuffer !== bcBuffer || !sameSet(liveRungs, wantRungs));

  // Re-launch the currently-live channel with the picker's current settings.
  async function relaunchLive() {
    if (!b?.channel) return;
    await goLive({ stream_id: b.channel.id, name: b.channel.name, icon: b.channel.icon });
  }

  const viewingFavs = activeCat?.category_id === FAV_CAT.category_id;
  // In the favorites view, render the saved favorites as stream-shaped cards.
  const sourceStreams = viewingFavs
    ? favorites.map((f) => ({
        stream_id: f.streamId,
        name: f.name,
        stream_icon: f.icon,
        categoryId: f.categoryId,
      }))
    : streams;
  const filtered = sourceStreams.filter(
    (s) => !filter || (s.name || '').toLowerCase().includes(filter.toLowerCase()),
  );

  // Package list with the search box + the synthetic Favorites entry on top.
  const visibleCategories = categories.filter(
    (c) => !catFilter || (c.category_name || '').toLowerCase().includes(catFilter.toLowerCase()),
  );

  return (
    <div className="admin">
      {/* ---- live status strip ---- */}
      <div className={'onair ' + (live ? 'is-live' : starting ? 'is-warm' : errored ? 'is-err' : '')}>
        <div className="onair-state">
          <span className="onair-light" />
          <div>
            <div className="onair-label">
              {live ? 'ON AIR' : reconnecting ? 'RECONNECTING' : starting ? 'STARTING' : errored ? 'ERROR' : 'OFF AIR'}
            </div>
            <div className="onair-channel">{b?.channel?.name || '— no channel —'}</div>
          </div>
        </div>
        <div className="onair-meta">
          {b?.error && <span className="onair-errtext">{b.error}</span>}
          {(live || starting) && b?.mode === 'copy' && (
            <span className="onair-ladder">as-is (pass-through)</span>
          )}
          {(live || starting) && b?.mode !== 'copy' && b?.ladder?.length > 0 && (
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
      {note && <div className="banner-note">{note}</div>}

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

          <section className="panel">
            <div className="panel-head">
              <h2>Broadcast mode</h2>
              <span
                className={
                  'chip ' + (bcMode === 'copy' ? 'chip-wait' : bcMode === 'hybrid' ? 'chip-ok' : 'chip-ok')
                }
              >
                {bcMode === 'copy' ? 'as-is' : bcMode === 'hybrid' ? 'hybrid' : 'transcode'}
              </span>
            </div>
            <div className="bcmode">
              <label className="bcmode-opt">
                <input
                  type="radio"
                  name="bcmode"
                  checked={bcMode === 'hybrid'}
                  onChange={() => setBcMode('hybrid')}
                />
                <span>
                  <strong>Source as-is + downscale</strong>
                  <small>
                    Pass the original through untouched (top quality, ~no CPU) AND
                    add the lower rungs below for weak connections.
                  </small>
                </span>
              </label>
              <label className="bcmode-opt">
                <input
                  type="radio"
                  name="bcmode"
                  checked={bcMode === 'transcode'}
                  onChange={() => setBcMode('transcode')}
                />
                <span>
                  <strong>Compress down</strong>
                  <small>Re-encode every rung below (no full-quality top; more CPU).</small>
                </span>
              </label>
              <label className="bcmode-opt">
                <input
                  type="radio"
                  name="bcmode"
                  checked={bcMode === 'copy'}
                  onChange={() => setBcMode('copy')}
                />
                <span>
                  <strong>Broadcast as-is only</strong>
                  <small>
                    Pass through, no re-encode (lowest CPU, single quality, no fallback).
                    HEVC sources auto-transcode.
                  </small>
                </span>
              </label>

              {(bcMode === 'transcode' || bcMode === 'hybrid') && (
                <div className="bcmode-rungs">
                  <span className="bcmode-rungs-label">
                    {bcMode === 'hybrid' ? 'Downscale rungs (optional)' : 'Resolutions'}
                  </span>
                  <div className="rung-grid">
                    {rungCatalog.map((r) => {
                      const on = pickedRungs.includes(r.name);
                      return (
                        <button
                          key={r.name}
                          type="button"
                          className={'rung-chip' + (on ? ' on' : '')}
                          onClick={() => toggleRung(r.name)}
                          title={`${r.width}×${r.height} · ${r.vbitrate}`}
                        >
                          {r.name}
                        </button>
                      );
                    })}
                  </div>
                  {/* Transcode must encode something; hybrid is fine with none
                      (= just pass the source through, zero CPU). */}
                  {bcMode === 'transcode' && pickedRungs.length === 0 && (
                    <div className="bcmode-warn">Pick at least one resolution.</div>
                  )}
                  {bcMode === 'hybrid' && pickedRungs.length === 0 && (
                    <div className="bcmode-hint">
                      None selected → source passes through untouched (no CPU). Add rungs only if
                      weak connections need a fallback.
                    </div>
                  )}
                </div>
              )}

              {bufferPresets.length > 0 && (
                <div className="bcmode-rungs">
                  <span className="bcmode-rungs-label">Latency / buffer</span>
                  <div className="rung-grid">
                    {bufferPresets.map((p) => (
                      <button
                        key={p.name}
                        type="button"
                        className={'rung-chip' + (bcBuffer === p.name ? ' on' : '')}
                        onClick={() => setBcBuffer(p.name)}
                        title={`~${p.approxLatency}s behind live · ${p.hlsTime}s segments`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {settingsDiffer && (
                <div className="bcmode-apply">
                  <span>Changes apply on next Go live.</span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={relaunchLive}
                    disabled={busy || (bcMode === 'transcode' && pickedRungs.length === 0)}
                    title={`Re-launch "${b?.channel?.name}" with these settings (keeps playing — no black screen)`}
                  >
                    ↻ Apply now
                  </button>
                </div>
              )}
            </div>
          </section>

          <section className="panel grow">
            <div className="panel-head">
              <h2>Packages</h2>
              <span className="muted-count">{categories.length}</span>
            </div>
            {configured && categories.length > 0 && (
              <input
                className="search catsearch"
                placeholder="Search packages…"
                value={catFilter}
                onChange={(e) => setCatFilter(e.target.value)}
              />
            )}
            <div className="catlist">
              {!configured && <div className="empty">Link a source to load packages.</div>}

              {/* Favorites pseudo-package — always available once linked */}
              {configured && (
                <button
                  className={
                    'catitem catitem-fav' +
                    (activeCat?.category_id === FAV_CAT.category_id ? ' active' : '')
                  }
                  onClick={() => openCategory(FAV_CAT)}
                >
                  <span className="catname">{FAV_CAT.category_name}</span>
                  <span className="muted-count">{favorites.length}</span>
                </button>
              )}

              {configured && categories.length === 0 && (
                <div className="empty">No packages found.</div>
              )}
              {configured && categories.length > 0 && visibleCategories.length === 0 && (
                <div className="empty">No packages match “{catFilter}”.</div>
              )}
              {visibleCategories.map((c) => (
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
            {sourceStreams.length > 0 && (
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
          {viewingFavs && !loadingStreams && favorites.length === 0 && (
            <div className="empty big">
              No favorites yet. Open a package and tap the ★ on a channel to save it here.
            </div>
          )}
          {activeCat && !viewingFavs && !loadingStreams && filtered.length === 0 && (
            <div className="empty big">No channels match.</div>
          )}
          {viewingFavs && favorites.length > 0 && filtered.length === 0 && (
            <div className="empty big">No favorites match “{filter}”.</div>
          )}

          <div className="chgrid">
            {filtered.map((s) => {
              const isSel = selected?.stream_id === s.stream_id;
              const onAir = b?.channel?.id === s.stream_id && (live || starting);
              const fav = isFav(s.stream_id);
              return (
                <div
                  key={s.stream_id}
                  className={'chcard' + (isSel ? ' sel' : '') + (onAir ? ' onair-card' : '')}
                  onClick={() => {
                    setSelected(s);
                    loadChannelInfo(s);
                  }}
                >
                  <button
                    className={'chfav' + (fav ? ' on' : '')}
                    onClick={(e) => toggleFav(s, e)}
                    title={fav ? 'Remove from favorites' : 'Add to favorites'}
                    aria-label={fav ? 'Remove from favorites' : 'Add to favorites'}
                  >
                    {fav ? '★' : '☆'}
                  </button>
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
                  {isSel && (
                    <ChannelInfo
                      state={chInfo[s.stream_id]}
                      onMeasure={() => loadChannelInfo(s, true)}
                    />
                  )}
                  {onAir ? (
                    <span className="chbadge live">on air</span>
                  ) : (
                    <button
                      className="chgo"
                      onClick={(e) => {
                        e.stopPropagation();
                        goLive(s);
                      }}
                      disabled={busy || (bcMode === 'transcode' && pickedRungs.length === 0)}
                      title={
                        bcMode === 'transcode' && pickedRungs.length === 0
                          ? 'Pick at least one resolution'
                          : bcMode === 'copy'
                            ? 'Go live (as-is)'
                            : bcMode === 'hybrid'
                              ? `Go live (source${pickedRungs.length ? ' + ' + pickedRungs.join('/') : ' only'})`
                              : `Go live (${pickedRungs.join('/')})`
                      }
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

// Compact source-info readout for the selected channel: codec, resolution, fps
// and (on demand) bitrate, probed live — Xtream's API exposes none of this.
function ChannelInfo({ state, onMeasure }) {
  if (!state || (state.loading && !state.info)) {
    return <div className="chinfo chinfo-loading">reading stream…</div>;
  }
  if (state.error && !state.info) {
    return <div className="chinfo chinfo-err" title={state.error}>info unavailable</div>;
  }
  const i = state.info;
  if (!i) return null;
  const v = i.video || {};
  const codec = (v.codec || '?').toUpperCase();
  const res = v.resolution || (v.height ? v.height + 'p' : '?');
  const fps = v.fps ? `${v.fps}fps` : null;
  const rate = i.bitrateKbps ? `${(i.bitrateKbps / 1000).toFixed(1)} Mbps` : null;
  return (
    <div className="chinfo">
      <span
        className={'chinfo-tag' + (i.browserPlayable ? '' : ' warn')}
        title={i.browserPlayable ? 'Browser-playable' : 'Not browser-playable — will auto-transcode'}
      >
        {codec}
      </span>
      <span className="chinfo-tag">{res}</span>
      {fps && <span className="chinfo-tag">{fps}</span>}
      {rate ? (
        <span className="chinfo-tag" title={i.bitrateEstimated ? 'Measured' : 'Reported'}>
          {rate}
        </span>
      ) : state.measuring ? (
        <span className="chinfo-tag chinfo-measuring">measuring…</span>
      ) : (
        <button
          type="button"
          className="chinfo-btn"
          onClick={(e) => {
            e.stopPropagation();
            onMeasure?.();
          }}
          title="Measure bitrate (briefly opens the stream)"
        >
          measure bitrate
        </button>
      )}
    </div>
  );
}
