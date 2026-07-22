const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT n.id, n.type, n.post_id, n.is_read, n.created_at,
              u.id AS actor_user_id, u.handle, u.full_name, u.avatar_color, u.avatar_url
       FROM notifications n
       JOIN users u ON u.id = n.actor_id
       WHERE n.user_id = ?
       ORDER BY n.created_at DESC LIMIT 100`
    )
    .all(req.userId);

  const notifications = rows.map((n) => ({
    id: n.id,
    type: n.type,
    postId: n.post_id,
    isRead: !!n.is_read,
    createdAt: n.created_at,
    actor: { handle: n.handle, fullName: n.full_name, avatarColor: n.avatar_color, avatarUrl: n.avatar_url },
    // So the UI can offer "Follow back" only where it makes sense.
    amFollowingActor: !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(req.userId, n.actor_user_id),
  }));

  const unreadCount = db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND is_read = 0').get(req.userId).c;
  res.json({ notifications, unreadCount });
});

router.post('/read-all', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.userId);
  res.json({ ok: true });
});

module.exports = router;
