# SIGNAL — IPTV re-stream & broadcast server

Ingest **one** channel from your Xtream Codes IPTV account on the server, transcode it
into an **adaptive-bitrate HLS ladder** (720p / 480p / 360p), and broadcast that single
feed to **every** viewer who opens the home page. Clients auto-pick the quality their
connection can sustain, so weak links downscale instead of buffering.

```
Xtream IPTV  ──HTTP/TS──▶  Node + FFmpeg  ──▶  /media/master.m3u8  ──▶  all viewers
 (your creds)              transcode once       adaptive HLS           hls.js auto-ABR
```

## What it does

- **Admin "Control Room"** (`/admin`) — paste your Xtream host/username/password, browse
  **packages** (live categories) and channels, and hit **Go live** on one channel.
- **Viewer "Watch" page** (`/`) — anyone who opens it sees whatever is currently being
  broadcast. The broadcast keeps running until you press **Stop**.
- **Adaptive bitrate** — the server holds the HD feed and downscales it into three rungs.
  `hls.js` measures each client's bandwidth and switches rungs automatically (or the
  viewer can lock a quality with the AUTO / 720p / 480p / 360p buttons).
- **Resilient ingest** — FFmpeg auto-reconnects on source hiccups; the backend restarts
  the pipeline and reports status/logs to the admin.

## Requirements

- **Node.js 18+** (you have v24) — for `fetch` and `--watch`.
- **FFmpeg** with `libx264` on your `PATH` (you have FFmpeg 8). Check: `ffmpeg -version`.

## Run it (two terminals)

```powershell
# terminal 1 — backend (http://localhost:4000)
cd backend
npm install
npm run dev

# terminal 2 — frontend (http://localhost:5173)
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173**, go to **Control Room**, enter your Xtream credentials,
pick a package → a channel → **Go live**, then open the **Watch** page (or share the URL).

> One-shot launcher on Windows: `./start-dev.ps1` (opens both in new windows).

### Single-port production mode

```powershell
cd frontend && npm run build      # outputs frontend/dist
cd ../backend && npm start        # serves the built UI + API + HLS on :4000
```

Then everything is on **http://localhost:4000**.

## Configuration (`backend/.env`, optional — copy from `.env.example`)

| Var            | Default     | Purpose                                                     |
| -------------- | ----------- | ----------------------------------------------------------- |
| `PORT`         | `4000`      | Backend port                                                |
| `FFMPEG_PATH`  | `ffmpeg`    | Path to ffmpeg if not on PATH                               |
| `X264_PRESET`  | `veryfast`  | Lower (e.g. `ultrafast`) = less CPU, lower quality          |
| `HLS_TIME`     | `4`         | Segment length in seconds                                   |
| `HLS_LIST_SIZE`| `6`         | Segments kept in the live window                            |

The bitrate ladder itself lives in `backend/src/broadcast.js` (`LADDER`) — edit it to add
a 1080p rung, drop to two rungs, change bitrates, etc.

## Notes & limits

- **CPU**: transcoding three rungs of live HD is CPU-heavy. On a modest CPU, lower
  `X264_PRESET` to `ultrafast`/`superfast`, or trim the `LADDER` to two rungs. For serious
  load, swap `libx264` for a hardware encoder (`h264_nvenc`, `h264_qsv`, `h264_amf`).
- **Latency**: HLS adds ~10–20s of glass-to-glass delay (segment buffering). That's the
  trade-off for smooth, buffer-free adaptive playback over plain HTTP.
- **One channel at a time**: this is a single-broadcast model by design. Selecting a new
  channel replaces the current broadcast for everyone.
- **Credentials** are stored locally in `backend/data/config.json` (git-ignored).
- Use only IPTV credentials you are authorized to use.
```
