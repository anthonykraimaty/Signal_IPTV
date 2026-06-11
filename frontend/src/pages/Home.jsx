import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Player from '../components/Player.jsx';
import { getStatus } from '../api.js';
import { useAuth } from '../auth.jsx';

export default function Home() {
  const { is } = useAuth();
  const [status, setStatus] = useState(null);

  useEffect(() => {
    let on = true;
    async function tick() {
      try {
        const s = await getStatus();
        if (on) setStatus(s);
      } catch {
        /* keep last state */
      }
    }
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      on = false;
      clearInterval(id);
    };
  }, []);

  const b = status?.broadcast;
  const live = b?.status === 'live';
  // Show the warm "tuning in" state both while first starting and while the
  // server is auto-reconnecting to the same channel after a source drop.
  const starting = b?.status === 'starting' || b?.status === 'reconnecting';

  return (
    <div className="home">
      <section className="stage">
        {live ? (
          <Player src={`${b.masterUrl}?_=${b.startedAt || ''}`} />
        ) : (
          <div className="offair">
            <div className="offair-noise" aria-hidden="true" />
            <div className="offair-inner">
              <span className={'pill ' + (starting ? 'pill-warm' : 'pill-cold')}>
                <span className="pill-dot" />
                {starting ? 'ACQUIRING SIGNAL' : 'NO SIGNAL'}
              </span>
              <h1 className="offair-title">{starting ? 'Tuning in…' : 'Off air'}</h1>
              <p className="offair-sub">
                {starting
                  ? 'The broadcast is starting. Playback begins automatically — stand by.'
                  : 'Nothing is being broadcast right now.'}
              </p>
              {is('control') && (
                <Link to="/admin" className="ghost-btn">
                  Open the control room →
                </Link>
              )}
            </div>
          </div>
        )}
      </section>

      <aside className="nowbar">
        <div className="now-row">
          <span className={'tag ' + (live ? 'tag-live' : starting ? 'tag-warm' : 'tag-off')}>
            <span className="tag-dot" />
            {live ? 'ON AIR' : starting ? 'STARTING' : 'OFF AIR'}
          </span>
        </div>
        <div className="now-channel">{b?.channel?.name || 'No channel selected'}</div>
        <div className="now-meta">
          {live && b?.ladder
            ? b.ladder.map((r) => r.name).join(' / ') + ' · adaptive bitrate'
            : 'Anyone who opens this page sees the live channel.'}
        </div>

        <div className="now-foot">
          <div className="kv">
            <span>protocol</span>
            <b>HLS</b>
          </div>
          <div className="kv">
            <span>mode</span>
            <b>broadcast</b>
          </div>
          <div className="kv">
            <span>viewers</span>
            <b>shared feed</b>
          </div>
        </div>
      </aside>
    </div>
  );
}
