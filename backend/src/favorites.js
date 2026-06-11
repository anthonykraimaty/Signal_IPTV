import { db } from './db.js';

function rowToFav(r) {
  return {
    streamId: r.stream_id,
    name: r.name,
    icon: r.icon,
    categoryId: r.category_id,
    addedAt: r.added_at,
  };
}

export function listFavorites(userId) {
  return db
    .prepare(
      'SELECT stream_id, name, icon, category_id, added_at FROM favorites WHERE user_id = ? ORDER BY name COLLATE NOCASE',
    )
    .all(userId)
    .map(rowToFav);
}

export function addFavorite(userId, { streamId, name, icon, categoryId }) {
  const id = Number(streamId);
  if (!Number.isInteger(id)) throw new Error('streamId is required');
  db.prepare(
    `INSERT INTO favorites (user_id, stream_id, name, icon, category_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, stream_id) DO UPDATE SET
       name = excluded.name,
       icon = excluded.icon,
       category_id = excluded.category_id`,
  ).run(userId, id, name ?? null, icon ?? null, categoryId != null ? String(categoryId) : null);
  return listFavorites(userId);
}

export function removeFavorite(userId, streamId) {
  db.prepare('DELETE FROM favorites WHERE user_id = ? AND stream_id = ?').run(
    userId,
    Number(streamId),
  );
  return listFavorites(userId);
}
