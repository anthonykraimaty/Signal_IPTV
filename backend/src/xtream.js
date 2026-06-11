import { getXtream } from './config.js';

// Build/validate credentials are present, then return them.
function creds() {
  const x = getXtream();
  if (!x.host || !x.username || !x.password) {
    throw new Error('Xtream credentials are not configured');
  }
  return x;
}

// Call the Xtream Codes player_api.php endpoint.
async function playerApi(action, params = {}) {
  const x = creds();
  const url = new URL(x.host + '/player_api.php');
  url.searchParams.set('username', x.username);
  url.searchParams.set('password', x.password);
  if (action) url.searchParams.set('action', action);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }

  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'IPTV-Restream/1.0' },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new Error(`Cannot reach IPTV server (${e.message})`);
  }
  if (!res.ok) throw new Error(`IPTV server responded HTTP ${res.status}`);

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('IPTV server returned invalid data — check the host URL and credentials');
  }
}

// Verify the account and return user/server info.
export async function authenticate() {
  const data = await playerApi(null);
  if (!data || !data.user_info || Number(data.user_info.auth) === 0) {
    throw new Error('Authentication failed — wrong username/password or host');
  }
  if (data.user_info.status && String(data.user_info.status).toLowerCase() !== 'active') {
    throw new Error(`Account is "${data.user_info.status}" (not active)`);
  }
  return data;
}

export async function getLiveCategories() {
  const data = await playerApi('get_live_categories');
  return Array.isArray(data) ? data : [];
}

export async function getLiveStreams(categoryId) {
  const params = categoryId ? { category_id: categoryId } : {};
  const data = await playerApi('get_live_streams', params);
  return Array.isArray(data) ? data : [];
}

// Direct live stream URL for ffmpeg to ingest (MPEG-TS).
export function buildStreamUrl(streamId, ext = 'ts') {
  const x = creds();
  return `${x.host}/live/${encodeURIComponent(x.username)}/${encodeURIComponent(x.password)}/${streamId}.${ext}`;
}
