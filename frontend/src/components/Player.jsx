import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

// Adaptive HLS player. hls.js measures bandwidth and auto-switches the rung
// (720p/480p/360p) so weak connections downgrade instead of buffering.
export default function Player({ src }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const [levels, setLevels] = useState([]);
  const [currentLevel, setCurrentLevel] = useState(-1); // -1 = auto
  const [auto, setAuto] = useState(true);
  const [quality, setQuality] = useState('');
  const [notice, setNotice] = useState('connecting…');

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    let retryTimer = null;

    function setup() {
      if (cancelled) return;

      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          maxBufferLength: 24,
          maxMaxBufferLength: 60,
          backBufferLength: 30,
          liveSyncDurationCount: 3,
          abrEwmaDefaultEstimate: 1_200_000,
          startLevel: -1,
          capLevelToPlayerSize: true,
        });
        hlsRef.current = hls;
        hls.loadSource(src);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
          if (cancelled) return;
          setLevels(
            data.levels.map((l, i) => ({
              i,
              height: l.height,
              bitrate: l.bitrate,
            })),
          );
          setNotice('');
          video.play().catch(() => {});
        });

        hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
          const lvl = hls.levels[data.level];
          if (lvl) {
            const h = lvl.height ? `${lvl.height}p` : 'auto';
            setQuality(`${h} · ${Math.round(lvl.bitrate / 1000)}kbps`);
          }
          setAuto(hls.autoLevelEnabled);
          setCurrentLevel(hls.autoLevelEnabled ? -1 : data.level);
        });

        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            setNotice('network hiccup — reconnecting…');
            try { hls.startLoad(); } catch {}
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            setNotice('recovering video…');
            try { hls.recoverMediaError(); } catch {}
          } else {
            setNotice('stream dropped — retrying…');
            try { hls.destroy(); } catch {}
            if (!cancelled) retryTimer = setTimeout(setup, 3000);
          }
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Safari / iOS play HLS natively (ABR handled by the OS).
        video.src = src;
        setNotice('');
        video.play().catch(() => {});
      } else {
        setNotice('This browser cannot play HLS.');
      }
    }

    setup();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (hlsRef.current) {
        try { hlsRef.current.destroy(); } catch {}
        hlsRef.current = null;
      }
    };
  }, [src]);

  function pick(i) {
    const hls = hlsRef.current;
    if (!hls) return;
    hls.currentLevel = i; // -1 restores auto ABR
    setCurrentLevel(i);
    setAuto(i === -1);
  }

  return (
    <div className="player">
      <video ref={videoRef} className="video" playsInline controls autoPlay muted />
      <div className="player-hud">
        <div className="hud-left">
          {notice ? (
            <span className="hud-note">{notice}</span>
          ) : (
            <span className="hud-q">
              <span className="hud-dot" /> {quality || 'buffering…'}
            </span>
          )}
        </div>
        {levels.length > 0 && (
          <div className="hud-right">
            <span className="hud-cap">quality</span>
            <button className={'qbtn' + (auto ? ' on' : '')} onClick={() => pick(-1)}>
              AUTO
            </button>
            {levels.map((l) => (
              <button
                key={l.i}
                className={'qbtn' + (!auto && currentLevel === l.i ? ' on' : '')}
                onClick={() => pick(l.i)}
              >
                {l.height ? l.height + 'p' : '?'}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
