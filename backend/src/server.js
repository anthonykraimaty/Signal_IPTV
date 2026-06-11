import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import routes from './routes.js';
import { seedAdmin } from './users.js';
import { attachUser, requireAuth } from './auth.js';
import { MEDIA_DIR, stop as stopBroadcast } from './broadcast.js';
import { startScheduler, stopScheduler } from './scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;

loadConfig();
seedAdmin();
startScheduler();

const app = express();
app.set('trust proxy', true);

// CORS with credentials — allow the Vite dev origin to send the session cookie.
const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];
app.use(
  cors({
    origin: (origin, cb) => cb(null, !origin || DEV_ORIGINS.includes(origin)),
    credentials: true,
  }),
);
app.use(express.json());

// Minimal cookie parser (avoids adding the cookie-parser dependency).
app.use((req, res, next) => {
  const header = req.headers.cookie;
  const jar = {};
  if (header) {
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      if (k) jar[k] = decodeURIComponent(v);
    }
  }
  req.cookies = jar;
  next();
});

// res.cookie / res.clearCookie helpers (so auth.js can stay framework-light).
app.use((req, res, next) => {
  res.cookie = (name, value, opts = {}) => {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    if (opts.maxAge != null) parts.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
    parts.push(`Path=${opts.path || '/'}`);
    if (opts.httpOnly) parts.push('HttpOnly');
    if (opts.secure) parts.push('Secure');
    parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
    res.append('Set-Cookie', parts.join('; '));
    return res;
  };
  res.clearCookie = (name, opts = {}) => {
    res.append(
      'Set-Cookie',
      `${name}=; Max-Age=0; Path=${opts.path || '/'}; SameSite=Lax`,
    );
    return res;
  };
  next();
});

// Resolve the session cookie → req.user for every request.
app.use(attachUser);

// --- HLS media (the broadcast output) — gated: any logged-in user (incl. view-only) ---
app.use(
  '/media',
  requireAuth,
  express.static(MEDIA_DIR, {
    setHeaders: (res, p) => {
      if (p.endsWith('.m3u8')) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else if (p.endsWith('.ts')) {
        res.setHeader('Content-Type', 'video/mp2t');
        res.setHeader('Cache-Control', 'public, max-age=30');
      }
    },
  }),
);

// --- API ---
app.use('/api', routes);

// --- Optionally serve the built frontend (after `npm run build` in /frontend) ---
const clientDir = path.join(__dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(clientDir)) {
  app.use(express.static(clientDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/media')) return next();
    res.sendFile(path.join(clientDir, 'index.html'));
  });
}

const server = app.listen(PORT, () => {
  console.log(`\n  ▶  IPTV re-stream server   http://localhost:${PORT}`);
  console.log(`  ▶  HLS master playlist     http://localhost:${PORT}/media/master.m3u8`);
  console.log(`  ▶  API                     http://localhost:${PORT}/api/status\n`);
});

function shutdown() {
  console.log('\nShutting down…');
  try { stopScheduler(); } catch {}
  try { stopBroadcast(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
