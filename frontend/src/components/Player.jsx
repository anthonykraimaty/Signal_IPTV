import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

// Adaptive HLS player. hls.js measures bandwidth and auto-switches the rung
// (720p/480p/360p) so weak connections downgrade instead of buffering.

// Normal playback deliberately sits behind the true live edge (the buffer runway
// that rides out hiccups) — roughly liveSyncDurationCount × segment length, plus
// a segment of slack so the pill doesn't flicker. We only flag "drifted" (amber)
// when we're further behind than this. ~26s covers the default 5×~4s window + 6s.
const LIVE_EDGE_SLACK = 26;

// End of the seekable range = the live edge for native HLS (Safari/iOS), which
// doesn't expose hls.js's liveSyncPosition.
function seekableEnd(video) {
  try {
    return video.seekable.length ? video.seekable.end(video.seekable.length - 1) : null;
  } catch {
    return null;
  }
}

export default function Player({ src }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const [levels, setLevels] = useState([]);
  const [currentLevel, setCurrentLevel] = useState(-1); // -1 = auto
  const [auto, setAuto] = useState(true);
  const [quality, setQuality] = useState('');
  const [notice, setNotice] = useState('connecting…');
  const [atLive, setAtLive] = useState(true); // is playback at the live edge?

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    let retryTimer = null;
    let cleanups = []; // per-setup listeners; flushed on retry and on unmount

    function teardown() {
      cleanups.forEach((fn) => {
        try { fn(); } catch {}
      });
      cleanups = [];
      if (hlsRef.current) {
        try { hlsRef.current.destroy(); } catch {}
        hlsRef.current = null;
      }
    }

    function setup() {
      if (cancelled) return;

      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          // Forward buffer the player tries to keep ahead of playback. A deeper
          // buffer lets the player ride out a source drop/discontinuity (common
          // on flaky IPTV feeds) without the spinner — at the cost of starting
          // further behind live. 36s fwd / 90s cap absorbs ~9 segments.
          maxBufferLength: 36,
          maxMaxBufferLength: 90,
          backBufferLength: 30,
          // Start ~5 segments (≈20s at HLS_TIME=4) behind the live edge so there
          // is buffered runway when the source hiccups.
          liveSyncDurationCount: 5,
          // DON'T let hls.js auto-snap back to live. After a source drop/reconnect
          // the new live edge is behind our buffered position, and the old default
          // (12) yanked playback backward — the visible "62 → 60" rewind. With a
          // very high ceiling the player keeps playing FORWARD from where it is and
          // only ever re-syncs when the user hits the LIVE button. The cost is a
          // slow drift further behind live across many reconnects, which the LIVE
          // button (and the pill that lights up when we've drifted) lets you fix.
          liveMaxLatencyDurationCount: 600,
          // Don't stall waiting on one bad segment — skip past a gap the source
          // left rather than buffering forever on it.
          nudgeMaxRetry: 8,
          abrEwmaDefaultEstimate: 1_200_000,
          startLevel: -1,
          capLevelToPlayerSize: true,
        });
        hlsRef.current = hls;
        hls.loadSource(src);
        hls.attachMedia(video);

        // Track distance from the TRUE live edge (end of the seekable window).
        // Normal playback sits ~a live-sync window behind it, so only flag drift
        // (amber) when we're further back than LIVE_EDGE_SLACK — e.g. after a
        // reconnect we chose not to snap back. goLive() seeks to this same edge.
        const onTime = () => {
          const edge = seekableEnd(video);
          if (edge == null) return;
          setAtLive(edge - video.currentTime <= LIVE_EDGE_SLACK);
        };
        video.addEventListener('timeupdate', onTime);
        cleanups.push(() => video.removeEventListener('timeupdate', onTime));

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
            teardown();
            if (!cancelled) retryTimer = setTimeout(setup, 3000);
          }
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Safari / iOS play HLS natively (ABR handled by the OS).
        video.src = src;
        setNotice('');
        video.play().catch(() => {});
        // Drift tracking via the seekable range, since there's no hls.js here.
        const onTime = () => {
          const end = seekableEnd(video);
          if (end == null) return;
          setAtLive(end - video.currentTime <= LIVE_EDGE_SLACK);
        };
        video.addEventListener('timeupdate', onTime);
        cleanups.push(() => video.removeEventListener('timeupdate', onTime));
      } else {
        setNotice('This browser cannot play HLS.');
      }
    }

    setup();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      teardown();
    };
  }, [src]);

  // Jump to the live edge on demand — the manual resync the high latency ceiling
  // leaves up to the user. Seek to the true edge (end of the seekable/buffered
  // window) minus a small margin, NOT hls.liveSyncPosition (which is still ~5
  // segments behind and would leave us registering as "behind live"). Works for
  // both hls.js and Safari's native HLS.
  function goLive() {
    const video = videoRef.current;
    if (!video) return;
    const edge = seekableEnd(video);
    if (edge == null) return;
    // Sit a hair back from the very end so we don't stall on the last, still-
    // growing segment; well within LIVE_EDGE_SLACK so the pill turns green.
    video.currentTime = Math.max(0, edge - 1);
    video.play().catch(() => {});
    setAtLive(true);
  }

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
          {/* At live = static green badge; drifted behind = amber button that
              snaps back to the live edge on click. */}
          <button
            className={'livebtn' + (atLive ? ' on' : '')}
            onClick={goLive}
            disabled={atLive}
            title={atLive ? 'Playing at the live edge' : 'Behind live — click to jump to live'}
          >
            <span className="livebtn-dot" /> LIVE
          </button>
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
