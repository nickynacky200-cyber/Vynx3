const express = require('express');
const multer = require('multer');
const db = require('../db/init');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { uploadBuffer } = require('../storage/backblaze');

const router = express.Router();

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('image/');
    cb(ok ? null : new Error('Please choose an image file.'), ok);
  },
});

async function getStats(userId) {
  const following = (await db.prepare('SELECT COUNT(*) c FROM follows WHERE follower_id = ?').get(userId)).c;
  const followers = (await db.prepare('SELECT COUNT(*) c FROM follows WHERE followee_id = ?').get(userId)).c;
  const totalLikes = (
    await db
      .prepare(`SELECT COALESCE(SUM(lc.c), 0) total FROM posts p
              LEFT JOIN (SELECT post_id, COUNT(*) c FROM likes GROUP BY post_id) lc ON lc.post_id = p.id
              WHERE p.user_id = ?`)
      .get(userId)
  ).total;
  return { following, followers, totalLikes };
}

router.get('/:handle', optionalAuth, async (req, res) => {
  const user = await db.prepare('SELECT * FROM users WHERE handle = ?').get(req.params.handle.toLowerCase());
  if (!user) return res.status(404).json({ error: 'This account doesn\u2019t exist.' });

  const stats = await getStats(user.id);
  const isFollowing = req.userId
    ? !!(await db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(req.userId, user.id))
    : false;

  const rawPosts = await db
    .prepare('SELECT id, media_type, media_url, caption, playback_rate, created_at FROM posts WHERE user_id = ? ORDER BY created_at DESC')
    .all(user.id);
  const posts = await Promise.all(
    rawPosts.map(async (p) => ({
      ...p,
      likeCount: (await db.prepare('SELECT COUNT(*) c FROM likes WHERE post_id = ?').get(p.id)).c,
    }))
  );

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

// Update the logged-in user's editable profile fields (name + bio).
router.patch('/me', requireAuth, async (req, res) => {
  const fullName = (req.body.fullName || '').trim();
  const bio = (req.body.bio || '').trim().slice(0, 150);
  if (!fullName) return res.status(400).json({ error: 'Name can\u2019t be empty.' });

  await db.prepare('UPDATE users SET full_name = ?, bio = ? WHERE id = ?').run(fullName, bio, req.userId);
  const updated = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  res.json({
    user: { id: updated.id, fullName: updated.full_name, handle: updated.handle, bio: updated.bio, avatarColor: updated.avatar_color, avatarUrl: updated.avatar_url },
  });
});

// Upload/replace the logged-in user's profile photo.
router.post('/me/avatar', requireAuth, avatarUpload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please choose an image.' });
  const extension = req.file.originalname.match(/\.[a-z0-9]+$/i)?.[0] || '.jpg';
  const avatarUrl = await uploadBuffer(req.file.buffer, { folder: 'avatars', extension, contentType: req.file.mimetype });
  await db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatarUrl, req.userId);
  res.json({ avatarUrl });
});

router.post('/:handle/follow', requireAuth, async (req, res) => {
  const target = await db.prepare('SELECT id FROM users WHERE handle = ?').get(req.params.handle.toLowerCase());
  if (!target) return res.status(404).json({ error: 'This account doesn\u2019t exist.' });
  if (target.id === req.userId) return res.status(400).json({ error: 'You can\u2019t follow yourself.' });

  const inserted = await db.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)').run(req.userId, target.id);

  if (inserted.changes > 0) {
    const notif = await db
      .prepare("INSERT INTO notifications (user_id, actor_id, type) VALUES (?, ?, 'follow')")
      .run(target.id, req.userId);
    const io = req.app.get('io');
    io.to(`user:${target.id}`).emit('notification:new', { id: notif.lastInsertRowid, type: 'follow' });
  }

  res.json({ following: true, stats: await getStats(target.id) });
});

router.post('/:handle/unfollow', requireAuth, async (req, res) => {
  const target = await db.prepare('SELECT id FROM users WHERE handle = ?').get(req.params.handle.toLowerCase());
  if (!target) return res.status(404).json({ error: 'This account doesn\u2019t exist.' });

  await db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(req.userId, target.id);
  res.json({ following: false, stats: await getStats(target.id) });
});

router.get('/:handle/followers', async (req, res) => {
  const target = await db.prepare('SELECT id FROM users WHERE handle = ?').get(req.params.handle.toLowerCase());
  if (!target) return res.status(404).json({ error: 'This account doesn\u2019t exist.' });
  const rows = await db
    .prepare(`SELECT u.handle, u.full_name, u.avatar_color, u.avatar_url FROM follows f
              JOIN users u ON u.id = f.follower_id WHERE f.followee_id = ? ORDER BY f.created_at DESC`)
    .all(target.id);
  res.json({ users: rows });
});

router.get('/:handle/following', async (req, res) => {
  const target = await db.prepare('SELECT id FROM users WHERE handle = ?').get(req.params.handle.toLowerCase());
  if (!target) return res.status(404).json({ error: 'This account doesn\u2019t exist.' });
  const rows = await db
    .prepare(`SELECT u.handle, u.full_name, u.avatar_color, u.avatar_url FROM follows f
              JOIN users u ON u.id = f.followee_id WHERE f.follower_id = ? ORDER BY f.created_at DESC`)
    .all(target.id);
  res.json({ users: rows });
});

module.exports = router;
