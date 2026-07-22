const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/init');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { sendPushToUser } = require('../push');

const router = express.Router();

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(req.app.get('uploadsDir'), 'avatars')),
    filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname) || '.jpg'}`),
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('image/');
    cb(ok ? null : new Error('Please choose an image file.'), ok);
  },
});

function getStats(userId) {
  const following = db.prepare('SELECT COUNT(*) c FROM follows WHERE follower_id = ?').get(userId).c;
  const followers = db.prepare('SELECT COUNT(*) c FROM follows WHERE followee_id = ?').get(userId).c;
  const totalLikes = db
    .prepare(`SELECT COALESCE(SUM(lc.c), 0) total FROM posts p
              LEFT JOIN (SELECT post_id, COUNT(*) c FROM likes GROUP BY post_id) lc ON lc.post_id = p.id
              WHERE p.user_id = ?`)
    .get(userId).total;
  return { following, followers, totalLikes };
}

// Search by handle or name — must be registered before GET /:handle so the
// literal path "/search" isn't captured as someone's handle.
router.get('/search', optionalAuth, (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ users: [] });

  const rows = db
    .prepare(
      `SELECT id, handle, full_name, avatar_color, avatar_url FROM users
       WHERE (LOWER(handle) LIKE ? OR LOWER(full_name) LIKE ?) AND id != ?
       ORDER BY handle ASC LIMIT 30`
    )
    .all(`%${q}%`, `%${q}%`, req.userId || 0);

  const users = rows.map((u) => ({
    handle: u.handle,
    fullName: u.full_name,
    avatarColor: u.avatar_color,
    avatarUrl: u.avatar_url,
    isFollowing: req.userId ? !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(req.userId, u.id) : false,
  }));

  res.json({ users });
});

// Web Push subscription registration — the client sends the
// PushSubscription object it gets back from the browser's Push API.
router.post('/me/push-subscribe', requireAuth, (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: 'Invalid push subscription.' });

  db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`
  ).run(req.userId, endpoint, keys.p256dh, keys.auth);

  res.json({ ok: true });
});

router.post('/me/push-unsubscribe', requireAuth, (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, req.userId);
  res.json({ ok: true });
});

router.get('/:handle', optionalAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE handle = ?').get(req.params.handle.toLowerCase());
  if (!user) return res.status(404).json({ error: 'This account doesn\u2019t exist.' });

  const stats = getStats(user.id);
  const isFollowing = req.userId
    ? !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(req.userId, user.id)
    : false;

  const posts = db
    .prepare('SELECT id, media_type, media_url, caption, playback_rate, created_at FROM posts WHERE user_id = ? ORDER BY created_at DESC')
    .all(user.id)
    .map((p) => ({
      ...p,
      likeCount: db.prepare('SELECT COUNT(*) c FROM likes WHERE post_id = ?').get(p.id).c,
    }));

  res.json({
    user: {
      id: user.id,
      fullName: user.full_name,
      handle: user.handle,
      bio: user.bio,
      avatarColor: user.avatar_color,
      avatarUrl: user.avatar_url,
    },
    stats,
    isFollowing,
    isSelf: req.userId === user.id,
    posts,
  });
});

// Upload/replace the logged-in user's profile photo.
router.post('/me/avatar', requireAuth, avatarUpload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please choose an image.' });
  const avatarUrl = `/uploads/avatars/${req.file.filename}`;
  db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatarUrl, req.userId);
  res.json({ avatarUrl });
});

router.post('/:handle/follow', requireAuth, (req, res) => {
  const target = db.prepare('SELECT id FROM users WHERE handle = ?').get(req.params.handle.toLowerCase());
  if (!target) return res.status(404).json({ error: 'This account doesn\u2019t exist.' });
  if (target.id === req.userId) return res.status(400).json({ error: 'You can\u2019t follow yourself.' });

  const inserted = db.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)').run(req.userId, target.id);

  if (inserted.changes > 0) {
    const notif = db
      .prepare('INSERT INTO notifications (user_id, actor_id, type) VALUES (?, ?, \'follow\')')
      .run(target.id, req.userId);
    const io = req.app.get('io');
    io.to(`user:${target.id}`).emit('notification:new', { id: notif.lastInsertRowid, type: 'follow' });
    sendPushToUser(target.id, { title: 'New follower', body: 'Someone started following you', url: '/notifications.html' });
  }

  res.json({ following: true, stats: getStats(target.id) });
});

router.post('/:handle/unfollow', requireAuth, (req, res) => {
  const target = db.prepare('SELECT id FROM users WHERE handle = ?').get(req.params.handle.toLowerCase());
  if (!target) return res.status(404).json({ error: 'This account doesn\u2019t exist.' });

  db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(req.userId, target.id);
  res.json({ following: false, stats: getStats(target.id) });
});

router.get('/:handle/followers', (req, res) => {
  const target = db.prepare('SELECT id FROM users WHERE handle = ?').get(req.params.handle.toLowerCase());
  if (!target) return res.status(404).json({ error: 'This account doesn\u2019t exist.' });
  const rows = db
    .prepare(`SELECT u.handle, u.full_name, u.avatar_color, u.avatar_url FROM follows f
              JOIN users u ON u.id = f.follower_id WHERE f.followee_id = ? ORDER BY f.created_at DESC`)
    .all(target.id);
  res.json({ users: rows });
});

router.get('/:handle/following', (req, res) => {
  const target = db.prepare('SELECT id FROM users WHERE handle = ?').get(req.params.handle.toLowerCase());
  if (!target) return res.status(404).json({ error: 'This account doesn\u2019t exist.' });
  const rows = db
    .prepare(`SELECT u.handle, u.full_name, u.avatar_color, u.avatar_url FROM follows f
              JOIN users u ON u.id = f.followee_id WHERE f.follower_id = ? ORDER BY f.created_at DESC`)
    .all(target.id);
  res.json({ users: rows });
});

module.exports = router;
