const express = require('express');
const multer = require('multer');
const db = require('../db/init');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { uploadBuffer } = require('../storage/backblaze');

const router = express.Router();

// Files land in memory, not on local disk — the host's disk doesn't
// survive a free-tier restart, so every upload goes straight to B2.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (Number(process.env.MAX_UPLOAD_MB) || 50) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/');
    cb(ok ? null : new Error('Only image or video files are allowed.'), ok);
  },
});

async function attachLikeInfo(posts, userId) {
  return Promise.all(
    posts.map(async (p) => ({
      ...p,
      likeCount: (await db.prepare('SELECT COUNT(*) c FROM likes WHERE post_id = ?').get(p.id)).c,
      commentCount: (await db.prepare('SELECT COUNT(*) c FROM comments WHERE post_id = ?').get(p.id)).c,
      likedByMe: userId ? !!(await db.prepare('SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?').get(p.id, userId)) : false,
    }))
  );
}

// The "For You" feed. For a real recommendation system you'd rank by
// engagement/recency/affinity — this starter shows newest first, which is
// enough to launch with and iterate on once you have real usage data.
router.get('/feed', optionalAuth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const before = req.query.before || new Date().toISOString();

  const posts = await db
    .prepare(
      `SELECT p.id, p.media_type, p.media_url, p.caption, p.playback_rate, p.created_at,
              u.handle, u.full_name, u.avatar_color, u.avatar_url
       FROM posts p JOIN users u ON u.id = p.user_id
       WHERE p.created_at < ?
       ORDER BY p.created_at DESC LIMIT ?`
    )
    .all(before, limit);

  res.json({ posts: await attachLikeInfo(posts, req.userId) });
});

router.post('/', requireAuth, upload.single('media'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please choose an image or video to post.' });

  const mediaType = req.file.mimetype.startsWith('video') ? 'video' : 'image';
  const extension = req.file.originalname.match(/\.[a-z0-9]+$/i)?.[0] || (mediaType === 'video' ? '.mp4' : '.jpg');
  const mediaUrl = await uploadBuffer(req.file.buffer, { folder: 'posts', extension, contentType: req.file.mimetype });

  const caption = (req.body.caption || '').slice(0, 500);
  // Client-chosen playback speed for videos captured in the camera tool
  // (0.5x–2x). Clamped here so a tampered request can't post nonsense.
  let playbackRate = Number(req.body.playbackRate) || 1;
  playbackRate = Math.min(Math.max(playbackRate, 0.5), 2);

  const result = await db
    .prepare('INSERT INTO posts (user_id, media_type, media_url, caption, playback_rate) VALUES (?, ?, ?, ?, ?)')
    .run(req.userId, mediaType, mediaUrl, caption, playbackRate);

  // Notify everyone who follows this account so their notifications feed
  // (and, on mobile, a push notification) reflects the new post.
  const io = req.app.get('io');
  const followerIds = await db.prepare('SELECT follower_id FROM follows WHERE followee_id = ?').all(req.userId);
  const insertNotif = db.prepare("INSERT INTO notifications (user_id, actor_id, type, post_id) VALUES (?, ?, 'post', ?)");
  for (const { follower_id } of followerIds) {
    const notif = await insertNotif.run(follower_id, req.userId, result.lastInsertRowid);
    io.to(`user:${follower_id}`).emit('notification:new', { id: notif.lastInsertRowid, type: 'post' });
  }

  res.status(201).json({ postId: result.lastInsertRowid, mediaUrl });
});

router.post('/:id/like', requireAuth, async (req, res) => {
  const inserted = await db.prepare('INSERT OR IGNORE INTO likes (post_id, user_id) VALUES (?, ?)').run(req.params.id, req.userId);
  const count = (await db.prepare('SELECT COUNT(*) c FROM likes WHERE post_id = ?').get(req.params.id)).c;

  // Only notify the post owner on a genuinely new like (INSERT OR IGNORE
  // means a repeat like/unlike/like won't spam them), and never for
  // liking your own post.
  if (inserted.changes > 0) {
    const post = await db.prepare('SELECT user_id FROM posts WHERE id = ?').get(req.params.id);
    if (post && post.user_id !== req.userId) {
      const notif = await db
        .prepare("INSERT INTO notifications (user_id, actor_id, type, post_id) VALUES (?, ?, 'like', ?)")
        .run(post.user_id, req.userId, req.params.id);
      const io = req.app.get('io');
      io.to(`user:${post.user_id}`).emit('notification:new', { id: notif.lastInsertRowid, type: 'like' });
    }
  }

  res.json({ liked: true, likeCount: count });
});

router.post('/:id/unlike', requireAuth, async (req, res) => {
  await db.prepare('DELETE FROM likes WHERE post_id = ? AND user_id = ?').run(req.params.id, req.userId);
  const count = (await db.prepare('SELECT COUNT(*) c FROM likes WHERE post_id = ?').get(req.params.id)).c;
  res.json({ liked: false, likeCount: count });
});

router.get('/:id/comments', async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT c.id, c.body, c.created_at, u.handle, u.avatar_color, u.avatar_url
       FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.post_id = ? ORDER BY c.created_at ASC`
    )
    .all(req.params.id);
  res.json({ comments: rows });
});

router.post('/:id/comments', requireAuth, async (req, res) => {
  const body = (req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Comment can\u2019t be empty.' });
  const result = await db.prepare('INSERT INTO comments (post_id, user_id, body) VALUES (?, ?, ?)').run(req.params.id, req.userId, body.slice(0, 300));

  // Notify the post owner (never for commenting on your own post).
  const post = await db.prepare('SELECT user_id FROM posts WHERE id = ?').get(req.params.id);
  if (post && post.user_id !== req.userId) {
    const notif = await db
      .prepare("INSERT INTO notifications (user_id, actor_id, type, post_id) VALUES (?, ?, 'comment', ?)")
      .run(post.user_id, req.userId, req.params.id);
    const io = req.app.get('io');
    io.to(`user:${post.user_id}`).emit('notification:new', { id: notif.lastInsertRowid, type: 'comment' });
  }

  const created = await db
    .prepare(`SELECT c.id, c.body, c.created_at, u.handle, u.avatar_color, u.avatar_url
              FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?`)
    .get(result.lastInsertRowid);
  res.status(201).json({ comment: created });
});

module.exports = router;
