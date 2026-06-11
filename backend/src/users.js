import { db } from './db.js';
import { hashPassword, destroyUserSessions } from './auth.js';

export const ROLES = ['admin', 'control', 'view'];

function rowToUser(r) {
  if (!r) return null;
  return {
    id: r.id,
    username: r.username,
    role: r.role,
    disabled: !!r.disabled,
    mustChange: !!r.must_change,
    createdAt: r.created_at,
  };
}

export function listUsers() {
  return db
    .prepare('SELECT id, username, role, disabled, must_change, created_at FROM users ORDER BY id')
    .all()
    .map(rowToUser);
}

export function getUserByUsername(username) {
  return db
    .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
    .get(String(username).trim());
}

export function getUserById(id) {
  return rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

export function createUser({ username, password, role = 'view' }) {
  username = String(username ?? '').trim();
  password = String(password ?? '');
  if (!username) throw new Error('Username is required');
  if (!/^[\w.\-@]{2,40}$/.test(username)) {
    throw new Error('Username must be 2–40 chars (letters, digits, . _ - @)');
  }
  if (password.length < 6) throw new Error('Password must be at least 6 characters');
  if (!ROLES.includes(role)) throw new Error('Invalid role');

  if (getUserByUsername(username)) throw new Error('That username is already taken');

  const info = db
    .prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(username, hashPassword(password), role);
  return getUserById(Number(info.lastInsertRowid));
}

export function deleteUser(id) {
  const user = getUserById(id);
  if (!user) throw new Error('User not found');
  if (user.role === 'admin' && countAdmins() <= 1) {
    throw new Error('Cannot delete the last remaining admin');
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id); // sessions cascade-delete
  return true;
}

export function resetPassword(id, newPassword) {
  const user = getUserById(id);
  if (!user) throw new Error('User not found');
  if (String(newPassword).length < 6) throw new Error('Password must be at least 6 characters');
  db.prepare('UPDATE users SET password_hash = ?, must_change = 1 WHERE id = ?').run(
    hashPassword(newPassword),
    id,
  );
  destroyUserSessions(id); // force re-login with the new password
  return true;
}

// A user changing their own password clears the must_change flag and keeps them logged in elsewhere is fine.
export function changeOwnPassword(id, newPassword) {
  if (String(newPassword).length < 6) throw new Error('Password must be at least 6 characters');
  db.prepare('UPDATE users SET password_hash = ?, must_change = 0 WHERE id = ?').run(
    hashPassword(newPassword),
    id,
  );
  return true;
}

export function setRole(id, role) {
  const user = getUserById(id);
  if (!user) throw new Error('User not found');
  if (!ROLES.includes(role)) throw new Error('Invalid role');
  if (user.role === 'admin' && role !== 'admin' && countAdmins() <= 1) {
    throw new Error('Cannot demote the last remaining admin');
  }
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  return getUserById(id);
}

export function setDisabled(id, disabled) {
  const user = getUserById(id);
  if (!user) throw new Error('User not found');
  if (user.role === 'admin' && disabled && countAdmins() <= 1) {
    throw new Error('Cannot disable the last remaining admin');
  }
  db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
  if (disabled) destroyUserSessions(id);
  return getUserById(id);
}

export function countAdmins() {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get().n;
}

export function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

// Seed the very first admin from env on a fresh DB (no self-registration anywhere).
export function seedAdmin() {
  if (countUsers() > 0) return;
  const username = (process.env.ADMIN_USERNAME || 'admin').trim();
  const password = process.env.ADMIN_PASSWORD || 'admin';
  createUser({ username, password, role: 'admin' });
  const usingDefaults = !process.env.ADMIN_PASSWORD;
  console.log(
    `[users] seeded first admin "${username}"` +
      (usingDefaults
        ? ' with DEFAULT password "admin" — set ADMIN_PASSWORD in backend/.env and change it after first login!'
        : ' from ADMIN_USERNAME/ADMIN_PASSWORD'),
  );
}
