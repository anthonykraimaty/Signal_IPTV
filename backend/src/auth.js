import crypto from 'node:crypto';
import { db } from './db.js';

export const SESSION_COOKIE = 'sid';
// Idle timeout: a session not seen for this long is treated as logged out.
export const SESSION_IDLE_MS = 1000 * 60 * 60 * 12; // 12h

// --- password hashing (scrypt, salt stored inline) ---

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), salt, expected.length);
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// --- sessions ---

export function createSession(userId, { userAgent, ip } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(
    `INSERT INTO sessions (token, user_id, user_agent, ip) VALUES (?, ?, ?, ?)`,
  ).run(token, userId, userAgent || null, ip || null);
  return token;
}

export function destroySession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function destroyUserSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// Resolve a session token to its user, refreshing last_seen. Expired/disabled → null.
export function sessionUser(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT s.token, s.last_seen, u.id, u.username, u.role, u.disabled, u.must_change
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ?`,
    )
    .get(token);
  if (!row) return null;
  if (row.disabled) {
    destroySession(token);
    return null;
  }
  // Idle expiry check against last_seen.
  const lastSeenMs = Date.parse(row.last_seen + 'Z');
  if (Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs > SESSION_IDLE_MS) {
    destroySession(token);
    return null;
  }
  db.prepare(`UPDATE sessions SET last_seen = datetime('now') WHERE token = ?`).run(token);
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    mustChange: !!row.must_change,
  };
}

// List active (non-expired) sessions joined to their user — "who is logged in".
export function activeSessions() {
  const cutoff = new Date(Date.now() - SESSION_IDLE_MS).toISOString().slice(0, 19).replace('T', ' ');
  return db
    .prepare(
      `SELECT s.token, s.user_id, s.created_at, s.last_seen, s.user_agent, s.ip,
              u.username, u.role
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.last_seen >= ?
        ORDER BY s.last_seen DESC`,
    )
    .all(cutoff);
}

// --- express middleware ---

const ROLE_RANK = { view: 0, control: 1, admin: 2 };

export function attachUser(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  req.sessionToken = token || null;
  req.user = sessionUser(token);
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// requireRole('control') passes admin+control; requireRole('admin') passes admin only.
export function requireRole(minRole) {
  const min = ROLE_RANK[minRole] ?? 99;
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if ((ROLE_RANK[req.user.role] ?? -1) < min) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

export function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false, // set true behind HTTPS in production
    maxAge: SESSION_IDLE_MS,
    path: '/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}
