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

// Adaptive-bitrate ladder, best first. The server holds HD and downscales
// to give weaker clients something they can sustain without buffering.
// Trimmed to two rungs (480p/360p) to fit CPU-bound transcoding on a modest
// VPS — add a 720p rung back here if you have CPU/GPU headroom.
const LADDER = [
  { name: '480p', width: 854, height: 480, vbitrate: '1400k', maxrate: '1500k', bufsize: '2100k', abitrate: '128k' },
  { name: '360p', width: 640, height: 360, vbitrate: '700k', maxrate: '750k', bufsize: '1100k', abitrate: '96k' },
];

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
let restarts = 0;
const logBuffer = [];

function pushLog(line) {
  logBuffer.push(line);
  if (logBuffer.length > 80) logBuffer.shift();
}

function cleanMedia() {
  try {
    // Empty the directory's CONTENTS rather than removing MEDIA_DIR itself —
    // in Docker it's a volume mount point and rmdir-ing it fails ("Resource busy").
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    for (const entry of fs.readdirSync(MEDIA_DIR)) {
      fs.rmSync(path.join(MEDIA_DIR, entry), { recursive: true, force: true });
    }
    LADDER.forEach((_, i) => fs.mkdirSync(path.join(MEDIA_DIR, 'v' + i), { recursive: true }));
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

function buildArgs(streamUrl) {
  const n = LADDER.length;

  // Split the decoded video into N copies, then scale+pad each to an exact size.
  let fc = `[0:v]split=${n}${LADDER.map((_, i) => `[v${i}]`).join('')};`;
  LADDER.forEach((r, i) => {
    fc +=
      `[v${i}]scale=w=${r.width}:h=${r.height}:force_original_aspect_ratio=decrease,` +
      `pad=${r.width}:${r.height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}out];`;
  });
  fc = fc.replace(/;$/, '');

  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    // --- input robustness for flaky IPTV sources ---
    '-analyzeduration', '10M',
    '-probesize', '10M',
    '-fflags', '+genpts+discardcorrupt',
    '-err_detect', 'ignore_err',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-rw_timeout', '20000000',
    '-i', streamUrl,
    '-filter_complex', fc,
  ];

  // One video encoder per rung.
  LADDER.forEach((r, i) => {
    args.push(
      '-map', `[v${i}out]`,
      `-c:v:${i}`, 'libx264',
      `-b:v:${i}`, r.vbitrate,
      `-maxrate:v:${i}`, r.maxrate,
      `-bufsize:v:${i}`, r.bufsize,
    );
  });

  // One audio encoder per rung (same source audio, re-encoded to AAC for HLS).
  LADDER.forEach((r, i) => {
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

  // HLS output: one master playlist + one media playlist/segment folder per rung.
  args.push(
    '-f', 'hls',
    '-hls_time', HLS_TIME,
    '-hls_list_size', HLS_LIST_SIZE,
    '-hls_flags', 'independent_segments+delete_segments+omit_endlist',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', 'v%v/seg_%05d.ts',
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', LADDER.map((_, i) => `v:${i},a:${i}`).join(' '),
    'v%v/index.m3u8',
  );

  return args;
}

function spawnFfmpeg(streamUrl) {
  const args = buildArgs(streamUrl);
  pushLog('[ffmpeg] ' + FFMPEG + ' ' + args.join(' '));

  const child = spawn(FFMPEG, args, { cwd: MEDIA_DIR, windowsHide: true });

  child.stderr.on('data', (d) => {
    String(d).split(/\r?\n/).forEach((ln) => {
      if (ln.trim()) pushLog('[ffmpeg] ' + ln.trim());
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
  // source that drops will self-heal whenever it comes back. Exponential backoff
  // capped at 30s keeps a persistently-dead source from hammering logs/CPU.
  state.status = 'reconnecting';
  state.error = `Reconnecting to "${intended.channel?.name ?? 'channel'}" (attempt ${restarts})…`;
  const delay = Math.min(2000 * restarts, 30000);
  pushLog(`[broadcast] reconnect attempt #${restarts} in ${delay}ms`);
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
        try { p.kill('SIGKILL'); } catch {}
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
  proc = spawnFfmpeg(intended.streamUrl);
  watchForLive();
}

// --- public API ---

export async function start(channel, streamUrl) {
  stop(); // hard-stop whatever is running
  intended = { channel, streamUrl };
  restarts = 0;
  logBuffer.length = 0;
  state = { status: 'starting', channel, startedAt: Date.now(), error: null };
  pushLog(`[broadcast] starting "${channel.name}" (${streamUrl})`);
  launch({ fresh: true });
  return getStatus();
}

export function stop() {
  intended = null;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (liveWatch) { clearInterval(liveWatch); liveWatch = null; }
  if (proc) {
    const p = proc;
    proc = null;
    try { p.kill('SIGKILL'); } catch {}
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
    ladder: LADDER.map((r) => ({ name: r.name, height: r.height, vbitrate: r.vbitrate })),
  };
}

export function getLogs() {
  return logBuffer.slice(-80);
}
