import { spawn } from 'node:child_process';

const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// Probe a (live) stream URL with ffprobe and return its first video/audio
// characteristics: codec, resolution, fps and bitrate. Xtream's API exposes
// none of this — it only lives in the actual stream — so we have to open it.
//
// Live sources never end, so ffprobe would hang; we cap it with -timeout and an
// external kill. We only need the stream metadata, not to read the whole thing.
// opts.measureBitrate: also run the (slower) throughput measurement for live
// MPEG-TS that doesn't advertise a bitrate. Off by default so the panel gets
// codec/resolution/fps quickly and holds the upstream connection only briefly.
export function probeStream(url, { timeoutMs = 12000, measureBitrate = false } = {}) {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner',
      '-v', 'error',
      '-user_agent', 'IPTV-Restream/1.0',
      // Bail if the connection stalls (microseconds).
      '-rw_timeout', String(timeoutMs * 1000),
      '-analyzeduration', '2M',
      '-probesize', '2M',
      '-show_entries',
      'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,bit_rate:format=bit_rate,format_name',
      '-of', 'json',
      url,
    ];

    let out = '';
    let err = '';
    let done = false;
    const child = spawn(FFPROBE, args, { windowsHide: true });

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(killer);
      try { child.kill('SIGKILL'); } catch {}
      resolve(result);
    };

    // Hard wall: ffprobe on a live source can ignore -rw_timeout, so kill it.
    const killer = setTimeout(() => finish({ ok: false, error: 'probe timed out' }), timeoutMs + 2000);
    if (typeof killer.unref === 'function') killer.unref();

    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => finish({ ok: false, error: 'ffprobe not available: ' + e.message }));
    child.on('close', async () => {
      if (done) return;
      let info;
      try {
        info = summarize(JSON.parse(out));
      } catch {
        finish({ ok: false, error: err.trim() || 'could not read stream info' });
        return;
      }
      // ffprobe is done — its hard-wall killer no longer applies. Clear it so it
      // can't fire a spurious "timed out" while the (slower) bitrate estimate,
      // which manages its own timeout, is still running.
      clearTimeout(killer);
      // Live MPEG-TS usually carries no bitrate tag, so ffprobe reports null.
      // Measure it directly over a short window — but only when asked, since it
      // adds several seconds and holds the upstream connection longer.
      if (info.bitrateKbps == null && measureBitrate) {
        const est = await estimateBitrate(url, timeoutMs);
        if (est) {
          info.bitrateKbps = est;
          info.bitrateEstimated = true;
        }
      }
      finish({ ok: true, info });
    });
  });
}

// Measure real throughput for a live source by copying a few seconds of it to
// stdout and counting the bytes ourselves. The only reliable way to get a
// bitrate for MPEG-TS that doesn't advertise one (the null muxer reports
// total_size=N/A, so we read the actual output stream). Returns kbps or null.
function estimateBitrate(url, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const seconds = 3;
    const args = [
      '-hide_banner',
      '-v', 'error',
      '-user_agent', 'IPTV-Restream/1.0',
      '-rw_timeout', String(timeoutMs * 1000),
      '-i', url,
      '-t', String(seconds),
      '-c', 'copy',
      '-f', 'mpegts',
      'pipe:1',
    ];
    let totalBytes = 0;
    let done = false;
    const child = spawn(FFMPEG, args, { windowsHide: true });

    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(killer);
      try { child.kill('SIGKILL'); } catch {}
      resolve(val);
    };
    // ffmpeg exits on its own after capturing `seconds` of stream; we normally
    // resolve in the 'close' handler. This killer is only a safety net for a
    // hung connection, so give it plenty of room for slow connection setup
    // (this host can take ~4s just to start sending) — firing it early would
    // truncate the capture and report 0/partial bytes.
    const killer = setTimeout(() => finish(bytesToKbps(totalBytes, seconds)), timeoutMs + seconds * 1000);
    if (typeof killer.unref === 'function') killer.unref();

    child.stdout.on('data', (d) => (totalBytes += d.length));
    child.stdout.on('error', () => {}); // ignore EPIPE if we kill mid-write
    child.on('error', () => finish(null));
    child.on('close', () => finish(bytesToKbps(totalBytes, seconds)));
  });
}

function bytesToKbps(bytes, seconds) {
  if (!bytes || !seconds) return null;
  return Math.round((bytes * 8) / seconds / 1000);
}

// Reduce raw ffprobe JSON to the fields the UI shows.
function summarize(j) {
  const streams = Array.isArray(j.streams) ? j.streams : [];
  const v = streams.find((s) => s.codec_type === 'video') || {};
  const a = streams.find((s) => s.codec_type === 'audio') || {};

  const width = v.width || null;
  const height = v.height || null;
  const fps = parseFps(v.avg_frame_rate) || parseFps(v.r_frame_rate) || null;

  // Prefer the video stream's own bitrate; fall back to the container's.
  const vBitrate = toKbps(v.bit_rate);
  const containerBitrate = toKbps(j.format?.bit_rate);
  const bitrateKbps = vBitrate || containerBitrate || null;

  return {
    video: {
      codec: v.codec_name || null, // e.g. h264, hevc
      width,
      height,
      resolution: height ? labelResolution(height) : null, // e.g. "1080p (FHD)"
      fps,
      bitrateKbps: vBitrate || null,
    },
    audio: {
      codec: a.codec_name || null, // e.g. aac, mp2
      bitrateKbps: toKbps(a.bit_rate),
    },
    // Total/container bitrate — what the source actually pushes over the wire.
    bitrateKbps,
    container: j.format?.format_name || null,
    // Convenience flag for the UI: can a browser play this codec directly?
    browserPlayable: isBrowserPlayable(v.codec_name),
  };
}

function parseFps(s) {
  if (!s || s === '0/0') return null;
  const [n, d] = String(s).split('/').map(Number);
  if (!d) return null;
  return Math.round((n / d) * 100) / 100;
}

function toKbps(b) {
  const n = Number(b);
  return Number.isFinite(n) && n > 0 ? Math.round(n / 1000) : null;
}

function labelResolution(h) {
  if (h >= 2160) return '2160p (4K)';
  if (h >= 1080) return '1080p (FHD)';
  if (h >= 720) return '720p (HD)';
  if (h >= 576) return '576p';
  if (h >= 480) return '480p';
  if (h >= 360) return '360p';
  return h + 'p';
}

// Browsers (via MSE/HLS) reliably play H.264 video; HEVC/H.265 generally fails.
export function isBrowserPlayable(codec) {
  if (!codec) return false;
  return /^(h264|avc)/i.test(codec);
}
