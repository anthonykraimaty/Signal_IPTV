import express from 'express';
import * as xtream from './xtream.js';
import * as broadcast from './broadcast.js';
import { probeStream } from './probe.js';
import { getXtream, setXtream, isConfigured } from './config.js';
import {
  verifyPassword,
  createSession,
  destroySession,
  activeSessions,
  destroyUserSessions,
  requireAuth,
  requireRole,
  setSessionCookie,
  clearSessionCookie,
} from './auth.js';
import * as users from './users.js';
import * as favorites from './favorites.js';
import * as scheduler from './scheduler.js';

const router = express.Router();

router.get('/health', (req, res) => res.json({ ok: true }));

// ============================================================
//  Auth
// ============================================================

router.post('/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  const user = users.getUserByUsername(username);
  if (!user || user.disabled || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const token = createSession(user.id, {
    userAgent: req.headers['user-agent'],
    ip: req.ip,
  });
  setSessionCookie(res, token);
  res.json({
    user: { id: user.id, username: user.username, role: user.role, mustChange: !!user.must_change },
  });
});

router.post('/auth/logout', (req, res) => {
  destroySession(req.sessionToken);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Who am I — drives the frontend auth state. 200 with user, or 401 if not logged in.
router.get('/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// Change my own password (clears the must_change flag).
router.post('/auth/password', requireAuth, (req, res) => {
  try {
    const { newPassword } = req.body || {};
    users.changeOwnPassword(req.user.id, newPassword);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ============================================================
//  User management (admin only)
// ============================================================

router.get('/users', requireRole('admin'), (req, res) => {
  res.json({ users: users.listUsers(), roles: users.ROLES });
});

router.post('/users', requireRole('admin'), (req, res) => {
  try {
    const { username, password, role } = req.body || {};
    const user = users.createUser({ username, password, role });
    res.status(201).json({ user });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/users/:id', requireRole('admin'), (req, res) => {
  try {
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete yourself' });
    users.deleteUser(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/users/:id/password', requireRole('admin'), (req, res) => {
  try {
    const { password } = req.body || {};
    users.resetPassword(Number(req.params.id), password);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/users/:id/role', requireRole('admin'), (req, res) => {
  try {
    const id = Number(req.params.id);
    const { role } = req.body || {};
    if (id === req.user.id && role !== 'admin') {
      return res.status(400).json({ error: 'You cannot change your own admin role' });
    }
    const user = users.setRole(id, role);
    res.json({ user });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/users/:id/disabled', requireRole('admin'), (req, res) => {
  try {
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: 'You cannot disable yourself' });
    const user = users.setDisabled(id, !!(req.body || {}).disabled);
    res.json({ user });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Who is logged in (active sessions). Admin only.
router.get('/sessions', requireRole('admin'), (req, res) => {
  const list = activeSessions().map((s) => ({
    userId: s.user_id,
    username: s.username,
    role: s.role,
    createdAt: s.created_at,
    lastSeen: s.last_seen,
    ip: s.ip,
    userAgent: s.user_agent,
    current: s.token === req.sessionToken,
  }));
  res.json({ sessions: list });
});

// Force-logout every session of a user (does not disable the account). Admin only.
router.delete('/sessions/user/:id', requireRole('admin'), (req, res) => {
  destroyUserSessions(Number(req.params.id));
  res.json({ ok: true });
});

// ============================================================
//  Status / logs  (any logged-in user can read)
// ============================================================

router.get('/status', requireAuth, (req, res) => {
  res.json({ configured: isConfigured(), broadcast: broadcast.getStatus() });
});

router.get('/logs', requireRole('control'), (req, res) =>
  res.json({ logs: broadcast.getLogs() }),
);

// ============================================================
//  Xtream credentials  (admin only — the "Source")
// ============================================================

router.get('/credentials', requireRole('admin'), (req, res) => {
  const x = getXtream();
  res.json({
    configured: isConfigured(),
    host: x.host || '',
    username: x.username || '',
    hasPassword: Boolean(x.password),
  });
});

router.post('/credentials', requireRole('admin'), async (req, res) => {
  try {
    const { host, username, password } = req.body || {};
    if (!host || !username || password === undefined || password === '') {
      return res.status(400).json({ error: 'host, username and password are all required' });
    }
    setXtream({ host, username, password });
    const info = await xtream.authenticate();
    res.json({ ok: true, userInfo: info.user_info, serverInfo: info.server_info });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ============================================================
//  Browse packages / channels  (control+ — needed to pick a channel)
// ============================================================

router.get('/categories', requireRole('control'), async (req, res) => {
  try {
    res.json({ categories: await xtream.getLiveCategories() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/categories/:id/streams', requireRole('control'), async (req, res) => {
  try {
    res.json({ streams: await xtream.getLiveStreams(req.params.id) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ============================================================
//  Channel info  (control+ — probe the live source for codec/res/bitrate)
// ============================================================

// Xtream's API exposes no codec/resolution/bitrate, so we open the stream and
// read it with ffprobe. This briefly opens ONE connection to the source — on a
// max_connections=1 line, don't probe while a broadcast of a different channel
// is live, or it will trip the connection limit.
router.get('/channels/:id/probe', requireRole('control'), async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(400).json({ error: 'Configure Xtream credentials first' });
    }
    // On a 1-connection line, probing a different channel while one is on air
    // trips the connection limit. Refuse rather than disrupt the live broadcast.
    const onAir = broadcast.activeChannelId();
    const reqId = req.params.id;
    if (onAir != null && String(onAir) !== String(reqId)) {
      return res
        .status(409)
        .json({ error: 'A broadcast is live — stop it before probing another channel.' });
    }
    const url = xtream.buildStreamUrl(reqId);
    const result = await probeStream(url, { measureBitrate: req.query.bitrate === '1' });
    if (!result.ok) {
      return res.status(502).json({ error: result.error || 'Could not read stream info' });
    }
    res.json({ info: result.info });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ============================================================
//  Broadcast control  (control+)
// ============================================================

// Expose the available transcode rungs + latency presets so the Control Room
// can render the broadcast-mode panel.
router.get('/broadcast/modes', requireRole('control'), (req, res) => {
  res.json({ rungs: broadcast.getRungCatalog(), buffers: broadcast.getBufferPresets() });
});

router.post('/broadcast/start', requireRole('control'), async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(400).json({ error: 'Configure Xtream credentials first' });
    }
    const { streamId, name, icon, mode, rungs, buffer } = req.body || {};
    if (!streamId && streamId !== 0) {
      return res.status(400).json({ error: 'streamId is required' });
    }
    const url = xtream.buildStreamUrl(streamId);

    // Resolve the effective mode. Both 'copy' (pass-through) and 'hybrid' (copy
    // the source as the top rung + transcode lower rungs) copy the source
    // untouched, so both need a browser-playable (H.264) source. If the source
    // is HEVC/other, auto-fall back to full transcode so it doesn't black-screen.
    let effectiveMode = ['copy', 'hybrid'].includes(mode) ? mode : 'transcode';
    let fallbackNote = null;
    if (effectiveMode === 'copy' || effectiveMode === 'hybrid') {
      const probe = await probeStream(url);
      if (probe.ok && probe.info && !probe.info.browserPlayable) {
        effectiveMode = 'transcode';
        fallbackNote = `Source is ${probe.info.video?.codec || 'an incompatible codec'} — not browser-playable as-is, transcoding instead.`;
      }
      // If the probe failed we still honor the request (the source may simply be
      // unprobeable here); the player will surface a problem if it can't decode.
    }

    const status = await broadcast.start(
      { id: streamId, name: name || `Channel ${streamId}`, icon: icon || null },
      url,
      { mode: effectiveMode, rungs, buffer },
    );
    res.json({ ok: true, broadcast: status, fallbackNote });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/broadcast/stop', requireRole('control'), (req, res) => {
  res.json({ ok: true, broadcast: broadcast.stop() });
});

// ============================================================
//  Favorite channels  (per-user; control+ — anyone who picks channels)
// ============================================================

router.get('/favorites', requireRole('control'), (req, res) => {
  res.json({ favorites: favorites.listFavorites(req.user.id) });
});

router.post('/favorites', requireRole('control'), (req, res) => {
  try {
    const { streamId, name, icon, categoryId } = req.body || {};
    const list = favorites.addFavorite(req.user.id, { streamId, name, icon, categoryId });
    res.json({ favorites: list });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/favorites/:streamId', requireRole('control'), (req, res) => {
  const list = favorites.removeFavorite(req.user.id, req.params.streamId);
  res.json({ favorites: list });
});

// ============================================================
//  Broadcast schedules  (admin only)
// ============================================================

router.get('/schedules', requireRole('admin'), (req, res) => {
  res.json({ schedules: scheduler.listSchedules(), log: scheduler.getLog() });
});

router.post('/schedules', requireRole('admin'), (req, res) => {
  try {
    const schedule = scheduler.createSchedule(req.body || {}, req.user.id);
    res.status(201).json({ schedule });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/schedules/:id', requireRole('admin'), (req, res) => {
  try {
    const schedule = scheduler.updateSchedule(Number(req.params.id), req.body || {});
    res.json({ schedule });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/schedules/:id/enabled', requireRole('admin'), (req, res) => {
  try {
    const schedule = scheduler.setEnabled(Number(req.params.id), !!(req.body || {}).enabled);
    res.json({ schedule });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/schedules/:id', requireRole('admin'), (req, res) => {
  try {
    scheduler.deleteSchedule(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
