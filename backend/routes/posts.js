const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/init');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { sendPushToUser } = require('../push');

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, req.app.get('uploadsDir')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || (file.mimetype.startsWith('video') ? '.mp4' : '.jpg');
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: (Number(process.env.MAX_UPLOAD_MB) || 50) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/');
    cb(ok ? null : new Error('Only image or video files are allowed.'), ok);
  },
});

function attachLikeInfo(posts, userId) {
  return posts.map((p) => ({
    ...p,
    likeCount: db.prepare('SELECT COUNT(*) c FROM likes WHERE post_id = ?').get(p.id).c,
    commentCount: db.prepare('SELECT COUNT(*) c FROM comments WHERE post_id = ?').get(p.id).c,
    likedByMe: userId ? !!db.prepare('SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?').get(p.id, userId) : false,
    isFollowingCreator: userId
      ? !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = (SELECT user_id FROM posts WHERE id = ?)').get(userId, p.id)
      : false,
    isOwnPost: userId ? db.prepare('SELECT user_id FROM posts WHERE id = ?').get(p.id).user_id === userId : false,
  }));
}

// The "For You" feed. For a real recommendation system you'd rank by
// engagement/recency/affinity — this starter shows newest first, which is
// enough to launch with and iterate on once you have real usage data.
router.get('/feed', optionalAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const before = req.query.before || new Date().toISOString();

  const posts = db
    .prepare(
      `SELECT p.id, p.media_type, p.media_url, p.caption, p.playback_rate, p.created_at,
              u.handle, u.full_name, u.avatar_color, u.avatar_url
       FROM posts p JOIN users u ON u.id = p.user_id
       WHERE p.created_at < ?
       ORDER BY p.created_at DESC LIMIT ?`
    )
    .all(before, limit);

  res.json({ posts: attachLikeInfo(posts, req.userId) });
});

router.post('/', requireAuth, upload.single('media'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please choose an image or video to post.' });

  const mediaType = req.file.mimetype.startsWith('video') ? 'video' : 'image';
  const mediaUrl = `/uploads/${req.file.filename}`;
  const caption = (req.body.caption || '').slice(0, 500);
  // Client-chosen playback speed for videos captured in the camera tool
  // (0.5x–2x). Clamped here so a tampered request can't post nonsense.
  let playbackRate = Number(req.body.playbackRate) || 1;
  playbackRate = Math.min(Math.max(playbackRate, 0.5), 2);

  const result = db
    .prepare('INSERT INTO posts (user_id, media_type, media_url, caption, playback_rate) VALUES (?, ?, ?, ?, ?)')
    .run(req.userId, mediaType, mediaUrl, caption, playbackRate);

  res.status(201).json({ postId: result.lastInsertRowid, mediaUrl });
});

router.post('/:id/like', requireAuth, (req, res) => {
  const inserted = db.prepare('INSERT OR IGNORE INTO likes (post_id, user_id) VALUES (?, ?)').run(req.params.id, req.userId);
  const count = db.prepare('SELECT COUNT(*) c FROM likes WHERE post_id = ?').get(req.params.id).c;

  // Only notify the post owner on a genuinely new like (INSERT OR IGNORE
  // means a repeat like/unlike/like won't spam them), and never for
  // liking your own post.
  if (inserted.changes > 0) {
    const post = db.prepare('SELECT user_id FROM posts WHERE id = ?').get(req.params.id);
    if (post && post.user_id !== req.userId) {
      const notif = db
        .prepare('INSERT INTO notifications (user_id, actor_id, type, post_id) VALUES (?, ?, \'like\', ?)')
        .run(post.user_id, req.userId, req.params.id);
      const io = req.app.get('io');
      io.to(`user:${post.user_id}`).emit('notification:new', { id: notif.lastInsertRowid, type: 'like' });
      sendPushToUser(post.user_id, { title: 'New like', body: 'Someone liked your post', url: '/notifications.html' });
    }
  }

  res.json({ liked: true, likeCount: count });
});

router.post('/:id/unlike', requireAuth, (req, res) => {
  db.prepare('DELETE FROM likes WHERE post_id = ? AND user_id = ?').run(req.params.id, req.userId);
  const count = db.prepare('SELECT COUNT(*) c FROM likes WHERE post_id = ?').get(req.params.id).c;
  res.json({ liked: false, likeCount: count });
});

router.get('/:id/comments', (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.id, c.body, c.created_at, u.handle, u.full_name, u.avatar_color, u.avatar_url
       FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.post_id = ? ORDER BY c.created_at ASC`
    )
    .all(req.params.id);
  res.json({ comments: rows });
});

router.post('/:id/comments', requireAuth, (req, res) => {
  const body = (req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Comment can\u2019t be empty.' });
  const result = db.prepare('INSERT INTO comments (post_id, user_id, body) VALUES (?, ?, ?)').run(req.params.id, req.userId, body.slice(0, 300));

  const post = db.prepare('SELECT user_id FROM posts WHERE id = ?').get(req.params.id);
  if (post && post.user_id !== req.userId) {
    const notif = db
      .prepare('INSERT INTO notifications (user_id, actor_id, type, post_id) VALUES (?, ?, \'comment\', ?)')
      .run(post.user_id, req.userId, req.params.id);
    const io = req.app.get('io');
    io.to(`user:${post.user_id}`).emit('notification:new', { id: notif.lastInsertRowid, type: 'comment' });
    sendPushToUser(post.user_id, { title: 'New comment', body: 'Someone commented on your post', url: '/notifications.html' });
  }

  res.status(201).json({ commentId: result.lastInsertRowid });
});

module.exports = router;
