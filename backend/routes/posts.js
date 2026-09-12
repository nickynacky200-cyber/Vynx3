const express = require('express');
const multer = require('multer');
const db = require('../db/init');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { uploadBuffer } = require('../storage/backblaze');

const router = express.Router();

// Files land in memory, not on local disk — the host's disk doesn't
// survive a free-tier restart, so every upload goes straight to B2.
// .array() accepts 1-10 files under the 'media' field, so the same
// upload path handles both a single post and a multi-photo carousel.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (Number(process.env.MAX_UPLOAD_MB) || 50) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/');
    cb(ok ? null : new Error('Only image or video files are allowed.'), ok);
  },
});

// Builds the visibility clause used by both the feed and the explore
// page: hide posts from accounts you've blocked (or that block you),
// hide private accounts' posts unless you follow them, and hide
// close-friends-only posts unless you're on that list (or it's your own).
function visibilitySql(paramOffset) {
  return `
    (u.is_private = 0 OR u.id = ? OR EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.followee_id = u.id))
    AND (p.visibility = 'public' OR p.user_id = ? OR EXISTS (SELECT 1 FROM close_friends cf WHERE cf.owner_id = p.user_id AND cf.friend_id = ?))
    AND NOT EXISTS (
      SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = ?)
    )
  `;
}

async function attachExtras(posts, userId) {
  return Promise.all(
    posts.map(async (p) => {
      const mediaRows = await db.prepare('SELECT media_type, media_url FROM post_media WHERE post_id = ? ORDER BY position ASC').all(p.id);
      const mediaItems = mediaRows.length ? mediaRows : [{ media_type: p.media_type, media_url: p.media_url }];

      let replyTo = null;
      if (p.reply_to_post_id) {
        const original = await db
          .prepare(
            `SELECT p2.id, p2.media_type, p2.media_url, p2.caption, u2.handle, u2.full_name
             FROM posts p2 JOIN users u2 ON u2.id = p2.user_id WHERE p2.id = ?`
          )
          .get(p.reply_to_post_id);
        if (original) {
          replyTo = {
            id: original.id,
            mediaType: original.media_type,
            mediaUrl: original.media_url,
            caption: original.caption,
            author: { handle: original.handle, fullName: original.full_name },
          };
        }
      }

      return {
        ...p,
        mediaItems: mediaItems.map((m) => ({ mediaType: m.media_type, mediaUrl: m.media_url })),
        replyTo,
        likeCount: (await db.prepare('SELECT COUNT(*) c FROM likes WHERE post_id = ?').get(p.id)).c,
        commentCount: (await db.prepare('SELECT COUNT(*) c FROM comments WHERE post_id = ?').get(p.id)).c,
        likedByMe: userId ? !!(await db.prepare('SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?').get(p.id, userId)) : false,
      };
    })
  );
}

const FEED_COLUMNS = `p.id, p.media_type, p.media_url, p.caption, p.playback_rate, p.created_at, p.reply_to_post_id, p.visibility,
                      u.handle, u.full_name, u.avatar_color, u.avatar_url`;

// The "For You" feed — newest first among what you're allowed to see.
router.get('/feed', optionalAuth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const before = req.query.before || new Date().toISOString();

  const posts = req.userId
    ? await db
        .prepare(
          `SELECT ${FEED_COLUMNS} FROM posts p JOIN users u ON u.id = p.user_id
           WHERE p.created_at < ? AND ${visibilitySql()}
           ORDER BY p.created_at DESC LIMIT ?`
        )
        .all(before, req.userId, req.userId, req.userId, req.userId, req.userId, req.userId, limit)
    : await db
        .prepare(
          `SELECT ${FEED_COLUMNS} FROM posts p JOIN users u ON u.id = p.user_id
           WHERE p.created_at < ? AND u.is_private = 0 AND p.visibility = 'public'
           ORDER BY p.created_at DESC LIMIT ?`
        )
        .all(before, limit);

  res.json({ posts: await attachExtras(posts, req.userId) });
});

// Explore/trending — same visibility rules as the feed, but ranked by
// recent engagement (likes + comments) instead of chronological order,
// and not limited to people you follow.
router.get('/explore', optionalAuth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 50);

  const posts = req.userId
    ? await db
        .prepare(
          `SELECT ${FEED_COLUMNS},
                  (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) +
                  (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) * 2 AS score
           FROM posts p JOIN users u ON u.id = p.user_id
           WHERE p.created_at > datetime('now', '-14 days') AND ${visibilitySql()}
           ORDER BY score DESC, p.created_at DESC LIMIT ?`
        )
        .all(req.userId, req.userId, req.userId, req.userId, req.userId, req.userId, limit)
    : await db
        .prepare(
          `SELECT ${FEED_COLUMNS},
                  (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) +
                  (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) * 2 AS score
           FROM posts p JOIN users u ON u.id = p.user_id
           WHERE p.created_at > datetime('now', '-14 days') AND u.is_private = 0 AND p.visibility = 'public'
           ORDER BY score DESC, p.created_at DESC LIMIT ?`
        )
        .all(limit);

  res.json({ posts: await attachExtras(posts, req.userId) });
});

// All posts whose caption contains the given hashtag (case-insensitive).
router.get('/hashtag/:tag', optionalAuth, async (req, res) => {
  const tag = `%#${req.params.tag.replace(/^#/, '').toLowerCase()}%`;

  const posts = req.userId
    ? await db
        .prepare(
          `SELECT ${FEED_COLUMNS} FROM posts p JOIN users u ON u.id = p.user_id
           WHERE LOWER(p.caption) LIKE ? AND ${visibilitySql()}
           ORDER BY p.created_at DESC LIMIT 50`
        )
        .all(tag, req.userId, req.userId, req.userId, req.userId, req.userId, req.userId)
    : await db
        .prepare(
          `SELECT ${FEED_COLUMNS} FROM posts p JOIN users u ON u.id = p.user_id
           WHERE LOWER(p.caption) LIKE ? AND u.is_private = 0 AND p.visibility = 'public'
           ORDER BY p.created_at DESC LIMIT 50`
        )
        .all(tag);

  res.json({ posts: await attachExtras(posts, req.userId) });
});

// Fetches a single post — used to render a preview when a post is
// shared into a chat message.
router.get('/:id', optionalAuth, async (req, res) => {
  const post = await db
    .prepare(`SELECT ${FEED_COLUMNS} FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?`)
    .get(req.params.id);
  if (!post) return res.status(404).json({ error: 'This post doesn\u2019t exist.' });
  const [full] = await attachExtras([post], req.userId);
  res.json({ post: full });
});

router.post('/', requireAuth, upload.array('media', 10), async (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'Please choose an image or video to post.' });

  const uploaded = await Promise.all(
    req.files.map(async (file) => {
      const mediaType = file.mimetype.startsWith('video') ? 'video' : 'image';
      const extension = file.originalname.match(/\.[a-z0-9]+$/i)?.[0] || (mediaType === 'video' ? '.mp4' : '.jpg');
      const mediaUrl = await uploadBuffer(file.buffer, { folder: 'posts', extension, contentType: file.mimetype });
      return { mediaType, mediaUrl };
    })
  );

  const caption = (req.body.caption || '').slice(0, 500);
  let playbackRate = Number(req.body.playbackRate) || 1;
  playbackRate = Math.min(Math.max(playbackRate, 0.5), 2);
  const visibility = req.body.visibility === 'close_friends' ? 'close_friends' : 'public';
  const replyToPostId = req.body.replyToPostId ? Number(req.body.replyToPostId) : null;

  const first = uploaded[0];
  const result = await db
    .prepare(
      'INSERT INTO posts (user_id, media_type, media_url, caption, playback_rate, visibility, reply_to_post_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(req.userId, first.mediaType, first.mediaUrl, caption, playbackRate, visibility, replyToPostId);

  if (uploaded.length > 1) {
    const insertMedia = db.prepare('INSERT INTO post_media (post_id, media_type, media_url, position) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < uploaded.length; i++) {
      await insertMedia.run(result.lastInsertRowid, uploaded[i].mediaType, uploaded[i].mediaUrl, i);
    }
  }

  // Notify followers of the new post (close-friends-only posts only
  // notify close friends, so the audience choice is respected end to end).
  const io = req.app.get('io');
  const followerIds = await db.prepare('SELECT follower_id FROM follows WHERE followee_id = ?').all(req.userId);
  const closeFriendIds =
    visibility === 'close_friends' ? new Set((await db.prepare('SELECT friend_id FROM close_friends WHERE owner_id = ?').all(req.userId)).map((r) => r.friend_id)) : null;
  const insertNotif = db.prepare("INSERT INTO notifications (user_id, actor_id, type, post_id) VALUES (?, ?, 'post', ?)");
  for (const { follower_id } of followerIds) {
    if (closeFriendIds && !closeFriendIds.has(follower_id)) continue;
    const notif = await insertNotif.run(follower_id, req.userId, result.lastInsertRowid);
    io.to(`user:${follower_id}`).emit('notification:new', { id: notif.lastInsertRowid, type: 'post' });
  }

  res.status(201).json({ postId: result.lastInsertRowid, mediaUrl: first.mediaUrl });
});

router.post('/:id/pin', requireAuth, async (req, res) => {
  const post = await db.prepare('SELECT user_id FROM posts WHERE id = ?').get(req.params.id);
  if (!post || post.user_id !== req.userId) return res.status(404).json({ error: 'This post doesn\u2019t exist.' });
  await db.prepare('UPDATE users SET pinned_post_id = ? WHERE id = ?').run(req.params.id, req.userId);
  res.json({ pinned: true });
});

router.post('/:id/unpin', requireAuth, async (req, res) => {
  await db.prepare('UPDATE users SET pinned_post_id = NULL WHERE id = ? AND pinned_post_id = ?').run(req.userId, req.params.id);
  res.json({ pinned: false });
});

router.post('/:id/like', requireAuth, async (req, res) => {
  const inserted = await db.prepare('INSERT OR IGNORE INTO likes (post_id, user_id) VALUES (?, ?)').run(req.params.id, req.userId);
  const count = (await db.prepare('SELECT COUNT(*) c FROM likes WHERE post_id = ?').get(req.params.id)).c;

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

  const post = await db
    .prepare('SELECT p.user_id, u.comment_privacy FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?')
    .get(req.params.id);
  if (!post) return res.status(404).json({ error: 'This post doesn\u2019t exist.' });

  if (post.user_id !== req.userId) {
    const blocked = await db
      .prepare('SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)')
      .get(post.user_id, req.userId, req.userId, post.user_id);
    if (blocked) return res.status(403).json({ error: 'You can\u2019t comment on this post.' });

    if (post.comment_privacy === 'none') {
      return res.status(403).json({ error: 'Comments are turned off for this account.' });
    }
    if (post.comment_privacy === 'followers') {
      const isFollower = await db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(req.userId, post.user_id);
      if (!isFollower) return res.status(403).json({ error: 'Only followers can comment on this account\u2019s posts.' });
    }
  }

  const result = await db.prepare('INSERT INTO comments (post_id, user_id, body) VALUES (?, ?, ?)').run(req.params.id, req.userId, body.slice(0, 300));

  if (post.user_id !== req.userId) {
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
