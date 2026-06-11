async function asJson(res, fallback) {
  let data;
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) {
    const err = new Error(data.error || fallback || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// All requests send the session cookie.
const opts = (extra = {}) => ({ credentials: 'include', ...extra });
const jsonBody = (method, body) =>
  opts({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

// ---------- auth ----------
export function login(username, password) {
  return fetch('/api/auth/login', jsonBody('POST', { username, password })).then((r) =>
    asJson(r, 'Login failed'),
  );
}
export function logout() {
  return fetch('/api/auth/logout', opts({ method: 'POST' })).then((r) => asJson(r));
}
export function me() {
  return fetch('/api/auth/me', opts()).then((r) => asJson(r, 'Not authenticated'));
}
export function changeMyPassword(newPassword) {
  return fetch('/api/auth/password', jsonBody('POST', { newPassword })).then((r) =>
    asJson(r, 'Failed to change password'),
  );
}

// ---------- user management (admin) ----------
export function listUsers() {
  return fetch('/api/users', opts()).then((r) => asJson(r, 'Failed to load users'));
}
export function createUser(body) {
  return fetch('/api/users', jsonBody('POST', body)).then((r) => asJson(r, 'Failed to create user'));
}
export function deleteUser(id) {
  return fetch(`/api/users/${id}`, opts({ method: 'DELETE' })).then((r) =>
    asJson(r, 'Failed to delete user'),
  );
}
export function resetUserPassword(id, password) {
  return fetch(`/api/users/${id}/password`, jsonBody('POST', { password })).then((r) =>
    asJson(r, 'Failed to reset password'),
  );
}
export function setUserRole(id, role) {
  return fetch(`/api/users/${id}/role`, jsonBody('POST', { role })).then((r) =>
    asJson(r, 'Failed to change role'),
  );
}
export function setUserDisabled(id, disabled) {
  return fetch(`/api/users/${id}/disabled`, jsonBody('POST', { disabled })).then((r) =>
    asJson(r, 'Failed to update user'),
  );
}
export function listSessions() {
  return fetch('/api/sessions', opts()).then((r) => asJson(r, 'Failed to load sessions'));
}
export function kickUser(id) {
  return fetch(`/api/sessions/user/${id}`, opts({ method: 'DELETE' })).then((r) =>
    asJson(r, 'Failed to log out user'),
  );
}

// ---------- xtream source / broadcast ----------
export function getStatus() {
  return fetch('/api/status', opts()).then((r) => asJson(r, 'Failed to load status'));
}
export function getCredentials() {
  return fetch('/api/credentials', opts()).then((r) => asJson(r, 'Failed to load credentials'));
}
export function saveCredentials(body) {
  return fetch('/api/credentials', jsonBody('POST', body)).then((r) =>
    asJson(r, 'Failed to save credentials'),
  );
}
export async function getCategories() {
  const d = await fetch('/api/categories', opts()).then((r) => asJson(r, 'Failed to load packages'));
  return d.categories;
}
export async function getStreams(categoryId) {
  const d = await fetch(`/api/categories/${categoryId}/streams`, opts()).then((r) =>
    asJson(r, 'Failed to load channels'),
  );
  return d.streams;
}
export function startBroadcast(body) {
  return fetch('/api/broadcast/start', jsonBody('POST', body)).then((r) =>
    asJson(r, 'Failed to start broadcast'),
  );
}
export function stopBroadcast() {
  return fetch('/api/broadcast/stop', opts({ method: 'POST' })).then((r) =>
    asJson(r, 'Failed to stop broadcast'),
  );
}
export async function getLogs() {
  const d = await fetch('/api/logs', opts()).then((r) => asJson(r, 'Failed to load logs'));
  return d.logs;
}
