import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MEDIA_DIR = path.join(__dirname, '..', 'media');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const X264_PRESET = process.env.X264_PRESET || 'ultrafast';
const HLS_TIME = process.env.HLS_TIME || '4';
const HLS_LIST_SIZE = process.env.HLS_LIST_SIZE || '6';

// Catalog of every transcode rung we can produce, best first. The admin picks
// which of these to include per broadcast (the "ladder"); more rungs = more
// adaptive-bitrate options for clients but more CPU. 720p is heavy on a modest
// VPS — include it only with CPU/GPU headroom.
const RUNG_CATALOG = {
  '720p': { name: '720p', width: 1280, height: 720, vbitrate: '2800k', maxrate: '3000k', bufsize: '4200k', abitrate: '128k' },
  '480p': { name: '480p', width: 854, height: 480, vbitrate: '1400k', maxrate: '1500k', bufsize: '2100k', abitrate: '128k' },
  '360p': { name: '360p', width: 640, height: 360, vbitrate: '700k', maxrate: '750k', bufsize: '1100k', abitrate: '96k' },
};
const DEFAULT_RUNGS = ['480p', '360p']; // matches the previous hard-coded ladder

// Resolve a requested rung list (e.g. ['720p','480p']) to catalog entries,
// best-first, ignoring unknown names; falls back to the default ladder if empty.
function resolveRungs(names) {
  const order = Object.keys(RUNG_CATALOG); // already best→worst
  const want = new Set((names && names.length ? names : DEFAULT_RUNGS).map(String));
  const picked = order.filter((k) => want.has(k)).map((k) => RUNG_CATALOG[k]);
  return picked.length ? picked : DEFAULT_RUNGS.map((k) => RUNG_CATALOG[k]);
}

// The broadcast mode in effect for the *current* run. 'transcode' builds the
// HLS ABR ladder (re-encodes); 'copy' is pass-through (no re-encode, single
// quality). Set per launch from `intended.mode` / `intended.rungs`.
let activeLadder = DEFAULT_RUNGS.map((k) => RUNG_CATALOG[k]);
let activeMode = 'transcode';

let state = {
  status: 'idle', // idle | starting | live | error
  channel: null, // { id, name, icon }
  startedAt: null,
  error: null,
};

let proc = null; // current ffmpeg child
let intended = null; // { channel, streamUrl } — set means "keep it running"
let restartTimer = null;
let liveWatch = null;
let restarts = 0; // consecutive failed (re)connect attempts since last LIVE
let rejections = 0; // consecutive attempts that ended in an active server rejection
let sawRejection = false; // did the *current* ffmpeg run get rejected by the server?
const logBuffer = [];

// Backoff tuning. Two regimes:
//  - normal failures (network blip, source dropped): fast recovery, low ceiling
//  - active rejection (403/401/429/509/503, "Forbidden", "Too many"…): the
//    server is telling us to back off. Retrying through that is what turns a
//    temporary throttle into a ban, so we wait MUCH longer.
// Minimum gap between tearing down one connection and opening the next. On a
// max_connections=1 line the server keeps counting the old session as "active"
// for a few seconds after our socket drops, so reconnecting too fast trips its
// own connection limit and we reject ourselves. Never reconnect faster than this.
const RECONNECT_FLOOR = 6000; // ≥ 6s lets the upstream slot free up first
const BACKOFF_BASE = 3000; // first normal retry ≈ 3s (then floored to 6s)
const BACKOFF_CEIL = 60_000; // normal retries cap at ~60s (fast recovery)
// Rejection cooldown. Tuned for live sport on a max_connections=1 line: the
// usual cause of a rejection here is a momentary self-clash (our previous
// session not yet released by the server), which clears in seconds — so a short
// 1–3 min cooldown recovers you mid-match. It's still far too slow to look like
// a DoS. If the provider genuinely blocks aggressively, raise these back up.
const REJECT_MIN = 60_000; // rejection cooldown: 1 min …
const REJECT_MAX = 3 * 60_000; // … to 3 min, randomized
const KILL_GRACE = 4000; // wait this long for a clean exit before SIGKILL

// Lines in ffmpeg's stderr that mean the server actively refused us, as opposed
// to a transient/network failure. Matched case-insensitively.
const REJECTION_RE =
  /\b(401|403|429|503|509)\b|forbidden|unauthorized|too many requests|server returned 4\d\d|service unavailable|connection limit|max.*connection/i;

// Symmetric jitter: returns ms in [base*0.7, base*1.3], so retries never land
// on an exact grid (deterministic clockwork reconnects are easy to fingerprint
// as a bot). Uses Date-free randomness so it stays deterministic-safe here.
function jitter(ms) {
  const spread = ms * 0.3;
  return Math.round(ms - spread + Math.random() * spread * 2);
}

function pushLog(line) {
  logBuffer.push(line);
  if (logBuffer.length > 80) logBuffer.shift();
}

// Stop an ffmpeg child as politely as possible: SIGTERM first so it closes the
// upstream HTTP connection cleanly (the server then frees our slot right away),
// with a SIGKILL fallback if it ignores us. Detaching it from `proc` is the
// caller's job *before* calling this, so the exit handler treats it as superseded.
function killChild(child) {
  if (!child) return;
  try { child.kill('SIGTERM'); } catch {}
  const t = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch {}
  }, KILL_GRACE);
  // Don't keep the event loop alive just for the fallback timer.
  if (typeof t.unref === 'function') t.unref();
  child.once('exit', () => clearTimeout(t));
}

function cleanMedia() {
  try {
    // Empty the directory's CONTENTS rather than removing MEDIA_DIR itself —
    // in Docker it's a volume mount point and rmdir-ing it fails ("Resource busy").
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    for (const entry of fs.readdirSync(MEDIA_DIR)) {
      fs.rmSync(path.join(MEDIA_DIR, entry), { recursive: true, force: true });
    }
    // One folder per output variant: the ladder rungs when transcoding, or a
    // single v0 in copy (pass-through) mode.
    const variants = activeMode === 'copy' ? 1 : activeLadder.length;
    for (let i = 0; i < variants; i++) {
      fs.mkdirSync(path.join(MEDIA_DIR, 'v' + i), { recursive: true });
    }
  } catch (e) {
    console.error('[broadcast] clean media failed:', e.message);
  }
}

// True once ffmpeg has produced the master playlist and at least one segment.
function masterReady() {
  if (!fs.existsSync(path.join(MEDIA_DIR, 'master.m3u8'))) return false;
  try {
    return fs.readdirSync(path.join(MEDIA_DIR, 'v0')).some((f) => f.endsWith('.ts'));
  } catch {
    return false;
  }
}

// Shared input args: robustness flags for flaky IPTV sources + the reconnect
// behaviour that hands HTTP rejections to our outer cooldown loop.
function inputArgs(streamUrl) {
  return [
    '-hide_banner',
    '-loglevel', 'warning',
    '-analyzeduration', '10M',
    '-probesize', '10M',
    '-fflags', '+genpts+discardcorrupt',
    '-err_detect', 'ignore_err',
    // ffmpeg's own reconnect rides out brief mid-stream network drops without a
    // full process restart (polite — one TCP reconnect, not a new player_api
    // session). We DON'T reconnect on HTTP *error* responses: a 4xx/5xx means
    // the server actively refused us, so ffmpeg exits and scheduleRestart()
    // applies the long rejection cooldown instead of re-poking every few seconds.
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_on_network_error', '1',
    '-reconnect_delay_max', '8',
    '-rw_timeout', '20000000',
    '-i', streamUrl,
  ];
}

// Shared HLS output options (segment naming, live window, etc). The caller
// supplies the variant count and the var_stream_map.
function hlsOutputArgs(varStreamMap) {
  return [
    '-f', 'hls',
    '-hls_time', HLS_TIME,
    '-hls_list_size', HLS_LIST_SIZE,
    '-hls_flags', 'independent_segments+delete_segments+omit_endlist',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', 'v%v/seg_%05d.ts',
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', varStreamMap,
    'v%v/index.m3u8',
  ];
}

function buildArgs(streamUrl) {
  return activeMode === 'copy' ? buildCopyArgs(streamUrl) : buildTranscodeArgs(streamUrl);
}

// Pass-through ("as is"): remux the source straight into HLS with NO re-encode.
// Lowest CPU by far, single quality (no ABR). Only safe when the source video
// codec is browser-playable (H.264) — the caller guarantees that via the probe
// auto-fallback, so here we just copy.
function buildCopyArgs(streamUrl) {
  return [
    ...inputArgs(streamUrl),
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c', 'copy',
    // Keep timestamps sane when copying a live MPEG-TS into HLS.
    '-copyts',
    '-muxpreload', '0',
    '-muxdelay', '0',
    ...hlsOutputArgs('v:0,a:0'),
  ];
}

// Transcode: decode once, fan out into the chosen ABR ladder (re-encoded H.264).
function buildTranscodeArgs(streamUrl) {
  const ladder = activeLadder;
  const n = ladder.length;

  // Split the decoded video into N copies, then scale+pad each to an exact size.
  let fc = `[0:v]split=${n}${ladder.map((_, i) => `[v${i}]`).join('')};`;
  ladder.forEach((r, i) => {
    fc +=
      `[v${i}]scale=w=${r.width}:h=${r.height}:force_original_aspect_ratio=decrease,` +
      `pad=${r.width}:${r.height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}out];`;
  });
  fc = fc.replace(/;$/, '');

  const args = [...inputArgs(streamUrl), '-filter_complex', fc];

  // One video encoder per rung.
  ladder.forEach((r, i) => {
    args.push(
      '-map', `[v${i}out]`,
      `-c:v:${i}`, 'libx264',
      `-b:v:${i}`, r.vbitrate,
      `-maxrate:v:${i}`, r.maxrate,
      `-bufsize:v:${i}`, r.bufsize,
    );
  });

  // One audio encoder per rung (same source audio, re-encoded to AAC for HLS).
  ladder.forEach((r, i) => {
    args.push(
      '-map', 'a:0?',
      `-c:a:${i}`, 'aac',
      `-b:a:${i}`, r.abitrate,
      '-ac', '2',
    );
  });

  // Global encoder settings — aligned GOPs so clients can switch rungs cleanly.
  args.push(
    '-preset', X264_PRESET,
    '-profile:v', 'main',
    '-g', '48',
    '-keyint_min', '48',
    '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p',
  );

  args.push(...hlsOutputArgs(ladder.map((_, i) => `v:${i},a:${i}`).join(' ')));
  return args;
}

function spawnFfmpeg(streamUrl) {
  const args = buildArgs(streamUrl);
  pushLog('[ffmpeg] ' + FFMPEG + ' ' + args.join(' '));

  const child = spawn(FFMPEG, args, { cwd: MEDIA_DIR, windowsHide: true });

  child.stderr.on('data', (d) => {
    String(d).split(/\r?\n/).forEach((ln) => {
      const t = ln.trim();
      if (!t) return;
      pushLog('[ffmpeg] ' + t);
      // Flag if the source actively rejected this connection. Only meaningful
      // for the current process; superseded ones are ignored on exit anyway.
      if (proc === child && REJECTION_RE.test(t)) sawRejection = true;
    });
  });
  child.stdout.on('data', () => {});

  child.on('error', (err) => {
    if (proc !== child) return;
    pushLog('[ffmpeg] spawn error: ' + err.message);
    state.status = 'error';
    state.error = 'Failed to launch ffmpeg: ' + err.message + ' (is ffmpeg installed / on PATH?)';
  });

  child.on('exit', (code, signal) => {
    if (proc !== child) {
      pushLog(`[ffmpeg] superseded process exited (code=${code} signal=${signal})`);
      return;
    }
    proc = null;
    pushLog(`[ffmpeg] exited code=${code} signal=${signal}`);
    if (intended) {
      // scheduleRestart() sets status to 'reconnecting' and keeps retrying the
      // same channel forever; we never transition to a terminal 'error' here.
      scheduleRestart();
    } else {
      state.status = 'idle';
    }
  });

  return child;
}

function scheduleRestart() {
  if (restartTimer || !intended) return;
  restarts += 1;

  // Auto-reconnect to the same channel indefinitely — never give up on our own.
  // Only an explicit stop() (or selecting a new channel) halts the loop, so a
  // source that drops will self-heal whenever it comes back.
  //
  // Two backoff regimes keep us from looking like a DoS / getting IP-banned:
  //  - if the last run was actively REJECTED by the server, wait a long,
  //    randomized cooldown (10–30 min). Hammering through a "you're blocked /
  //    too many connections" response is what escalates a throttle into a ban.
  //  - otherwise (transient drop) use jittered exponential backoff capped at
  //    ~60s for fast recovery when the source comes back.
  const channelName = intended.channel?.name ?? 'channel';
  let delay;
  if (sawRejection) {
    rejections += 1;
    delay = jitter(REJECT_MIN + Math.random() * (REJECT_MAX - REJECT_MIN));
    const mins = Math.round(delay / 60_000);
    state.status = 'reconnecting';
    state.error = `Source refused the connection — cooling down ~${mins} min before retrying "${channelName}" (rejection #${rejections})…`;
    pushLog(`[broadcast] server rejection — cooldown ${Math.round(delay / 1000)}s before retry`);
  } else {
    rejections = 0;
    // Exponential: base * 2^(n-1), then jittered, then clamped to
    // [RECONNECT_FLOOR, BACKOFF_CEIL]. The floor guarantees we never reconnect
    // before the upstream has released our previous connection slot.
    const raw = Math.min(BACKOFF_BASE * 2 ** (restarts - 1), BACKOFF_CEIL);
    delay = Math.min(Math.max(jitter(raw), RECONNECT_FLOOR), BACKOFF_CEIL);
    state.status = 'reconnecting';
    state.error = `Reconnecting to "${channelName}" (attempt ${restarts})…`;
    pushLog(`[broadcast] reconnect attempt #${restarts} in ${Math.round(delay / 1000)}s`);
  }

  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (intended) launch();
  }, delay);
}

function watchForLive() {
  if (liveWatch) clearInterval(liveWatch);
  const startedAt = Date.now();
  liveWatch = setInterval(() => {
    if (!intended) {
      clearInterval(liveWatch);
      liveWatch = null;
      return;
    }
    if (masterReady()) {
      state.status = 'live';
      state.error = null;
      restarts = 0;
      rejections = 0;
      clearInterval(liveWatch);
      liveWatch = null;
      pushLog('[broadcast] LIVE — segments are flowing');
    } else if (Date.now() - startedAt > 45000) {
      // No output after 45s: kick ffmpeg so the restart loop tries again.
      pushLog('[broadcast] no segments after 45s — restarting ffmpeg');
      clearInterval(liveWatch);
      liveWatch = null;
      if (proc) {
        const p = proc;
        proc = null;
        killChild(p); // graceful — lets the upstream slot free before we retry
        if (intended) scheduleRestart();
      }
    }
  }, 1000);
}

function launch({ fresh = false } = {}) {
  // Only wipe media/ on a brand-new broadcast. On a reconnect we keep the last
  // segments in place so the player can ride out a brief source drop without
  // blanking; ffmpeg's delete_segments flag rolls the live window forward once
  // new segments start flowing.
  if (fresh) cleanMedia();
  sawRejection = false; // fresh per-run flag; set by stderr scanning if rejected
  proc = spawnFfmpeg(intended.streamUrl);
  watchForLive();
}

// --- public API ---

// opts: { mode: 'transcode' | 'copy', rungs: ['480p','360p', …] }
export async function start(channel, streamUrl, opts = {}) {
  const hadProc = Boolean(proc);
  stop(); // hard-stop whatever is running (graceful: sends SIGTERM, frees the slot)
  // On a max_connections=1 line we must not open the new connection while the
  // old one is still closing, or the server rejects us for exceeding the limit.
  // Give the previous process a moment to release its upstream slot first.
  if (hadProc) {
    pushLog('[broadcast] waiting for previous connection to release before switching…');
    await waitForSlotRelease();
  }

  // Lock in the broadcast mode + ladder for this run.
  activeMode = opts.mode === 'copy' ? 'copy' : 'transcode';
  activeLadder = resolveRungs(opts.rungs);

  intended = { channel, streamUrl, mode: activeMode, rungs: activeLadder.map((r) => r.name) };
  restarts = 0;
  rejections = 0;
  sawRejection = false;
  logBuffer.length = 0;
  state = { status: 'starting', channel, startedAt: Date.now(), error: null };
  const desc =
    activeMode === 'copy'
      ? 'pass-through (as-is, no re-encode)'
      : `transcode → ${activeLadder.map((r) => r.name).join(' / ')}`;
  pushLog(`[broadcast] starting "${channel.name}" [${desc}] (${streamUrl})`);
  launch({ fresh: true });
  return getStatus();
}

// Small pause to let the upstream free the previous connection slot. Short
// enough to feel instant to the admin, long enough that a 1-connection line
// doesn't reject the new session. Date-free so it stays deterministic-safe.
function waitForSlotRelease() {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, RECONNECT_FLOOR);
    if (typeof t.unref === 'function') t.unref();
  });
}

export function stop() {
  intended = null;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (liveWatch) { clearInterval(liveWatch); liveWatch = null; }
  if (proc) {
    const p = proc;
    proc = null;
    killChild(p);
  }
  state = { status: 'idle', channel: null, startedAt: null, error: null };
  return getStatus();
}

export function getStatus() {
  return {
    status: state.status,
    channel: state.channel,
    startedAt: state.startedAt,
    error: state.error,
    masterUrl: '/media/master.m3u8',
    mode: activeMode, // 'transcode' | 'copy'
    ladder:
      activeMode === 'copy'
        ? [] // pass-through has no ABR ladder
        : activeLadder.map((r) => ({ name: r.name, height: r.height, vbitrate: r.vbitrate })),
  };
}

// Is a broadcast currently holding (or trying to hold) the upstream connection?
// Used to avoid probing a different channel on a max_connections=1 line, which
// would trip the limit. Returns the live channel id, or null when idle.
export function activeChannelId() {
  return intended ? intended.channel?.id ?? null : null;
}

// The full rung catalog the UI offers (best→worst), for the broadcast-mode panel.
export function getRungCatalog() {
  return Object.values(RUNG_CATALOG).map((r) => ({
    name: r.name,
    height: r.height,
    width: r.width,
    vbitrate: r.vbitrate,
  }));
}

export function getLogs() {
  return logBuffer.slice(-80);
}
