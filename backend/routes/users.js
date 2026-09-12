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

function toFullProfile(u) {
  return {
    id: u.id,
    fullName: u.full_name,
    handle: u.handle,
    bio: u.bio,
    avatarColor: u.avatar_color,
    avatarUrl: u.avatar_url,
    isPrivate: !!u.is_private,
    commentPrivacy: u.comment_privacy,
    messagePrivacy: u.message_privacy,
    mutedWords: JSON.parse(u.muted_words || '[]'),
    profileTheme: u.profile_theme,
    pinnedPostId: u.pinned_post_id,
  };
}

// ---- "me" routes first: these must be registered before GET /:handle, or
// a request to e.g. /me/blocked would incorrectly be swallowed by the
// generic handle-based routes lower down. ----

router.get('/me/full', requireAuth, async (req, res) => {
  const me = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  res.json({ user: toFullProfile(me) });
});

// Update the logged-in user's editable profile fields (name + bio).
router.patch('/me', requireAuth, async (req, res) => {
  const fullName = (req.body.fullName || '').trim();
  const bio = (req.body.bio || '').trim().slice(0, 150);
  if (!fullName) return res.status(400).json({ error: 'Name can\u2019t be empty.' });

  await db.prepare('UPDATE users SET full_name = ?, bio = ? WHERE id = ?').run(fullName, bio, req.userId);
  const updated = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  res.json({ user: toFullProfile(updated) });
});

router.patch('/me/privacy', requireAuth, async (req, res) => {
  const isPrivate = !!req.body.isPrivate;
  await db.prepare('UPDATE users SET is_private = ? WHERE id = ?').run(isPrivate ? 1 : 0, req.userId);
  res.json({ isPrivate });
});

router.patch('/me/audience', requireAuth, async (req, res) => {
  const commentPrivacy = ['everyone', 'followers', 'none'].includes(req.body.commentPrivacy) ? req.body.commentPrivacy : 'everyone';
  const messagePrivacy = ['everyone', 'followers'].includes(req.body.messagePrivacy) ? req.body.messagePrivacy : 'everyone';
  await db.prepare('UPDATE users SET comment_privacy = ?, message_privacy = ? WHERE id = ?').run(commentPrivacy, messagePrivacy, req.userId);
  res.json({ commentPrivacy, messagePrivacy });
});

router.patch('/me/muted-words', requireAuth, async (req, res) => {
  const words = Array.isArray(req.body.words)
    ? req.body.words.map((w) => String(w).trim().toLowerCase()).filter(Boolean).slice(0, 50)
    : [];
  await db.prepare('UPDATE users SET muted_words = ? WHERE id = ?').run(JSON.stringify(words), req.userId);
  res.json({ words });
});

router.patch('/me/theme', requireAuth, async (req, res) => {
  const color = req.body.color;
  if (!/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(color || '')) {
    return res.status(400).json({ error: 'Please provide a valid hex color.' });
  }
  await db.prepare('UPDATE users SET profile_theme = ? WHERE id = ?').run(color, req.userId);
  res.json({ profileTheme: color });
});

router.get('/me/close-friends', requireAuth, async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT u.handle, u.full_name, u.avatar_color, u.avatar_url FROM close_friends cf
       JOIN users u ON u.id = cf.friend_id WHERE cf.owner_id = ? ORDER BY cf.created_at DESC`
    )
    .all(req.userId);
  res.json({ users: rows });
});

// Permanently deletes the account and everything owned by it. The
// Firebase Auth user itself is deleted client-side after this succeeds
// (see EditProfile/Settings in the mobile app) — this route only cleans
// up app data.
router.delete('/me', requireAuth, async (req, res) => {
  const userId = req.userId;
  await db.prepare('DELETE FROM likes WHERE user_id = ?').run(userId);
  await db.prepare('DELETE FROM comments WHERE user_id = ?').run(userId);
  await db
    .prepare('DELETE FROM post_media WHERE post_id IN (SELECT id FROM posts WHERE user_id = ?)')
    .run(userId);
  await db.prepare('DELETE FROM posts WHERE user_id = ?').run(userId);
  await db.prepare('DELETE FROM follows WHERE follower_id = ? OR followee_id = ?').run(userId, userId);
  await db.prepare('DELETE FROM follow_requests WHERE requester_id = ? OR target_id = ?').run(userId, userId);
  await db.prepare('DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?').run(userId, userId);
  await db.prepare('DELETE FROM close_friends WHERE owner_id = ? OR friend_id = ?').run(userId, userId);
  await db.prepare('DELETE FROM message_reactions WHERE user_id = ?').run(userId);
  await db.prepare('DELETE FROM conversation_reads WHERE user_id = ?').run(userId);
  await db.prepare('DELETE FROM notifications WHERE user_id = ? OR actor_id = ?').run(userId, userId);
  await db.prepare('DELETE FROM conversation_members WHERE user_id = ?').run(userId);
  await db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  res.json({ deleted: true });
});

// Upload/replace the logged-in user's profile photo.
router.post('/me/avatar', requireAuth, avatarUpload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please choose an image.' });
  const extension = req.file.originalname.match(/\.[a-z0-9]+$/i)?.[0] || '.jpg';
  const avatarUrl = await uploadBuffer(req.file.buffer, { folder: 'avatars', extension, contentType: req.file.mimetype });
  await db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatarUrl, req.userId);
  res.json({ avatarUrl });
});

// Incoming follow requests on a private account, waiting for approval.
router.get('/me/follow-requests', requireAuth, async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT u.handle, u.full_name, u.avatar_color, u.avatar_url, fr.created_at
       FROM follow_requests fr JOIN users u ON u.id = fr.requester_id
       WHERE fr.target_id = ? ORDER BY fr.created_at DESC`
    )
    .all(req.userId);
  res.json({ requests: rows });
});

router.get('/me/blocked', requireAuth, async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT u.handle, u.full_name, u.avatar_color, u.avatar_url FROM blocks b
       JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ? ORDER BY b.created_at DESC`
    )
    .all(req.userId);
  res.json({ users: rows });
});

router.post('/follow-requests/:handle/accept', requireAuth, async (req, res) => {
  const requester = await db.prepare('SELECT id FROM users WHERE handle = ?').get(req.params.handle.toLowerCase());
  if (!requester) return res.status(404).json({ error: 'This account doesn\u2019t exist.' });

  const existed = await db.prepare('DELETE FROM follow_requests WHERE requester_id = ? AND target_id = ?').run(requester.id, req.userId);
  if (existed.changes === 0) return res.status(404).json({ error: 'No pending request from this account.' });

  await db.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)').run(requester.id, req.userId);
  const notif = await db.prepare("INSERT INTO notifications (user_id, actor_id, type) VALUES (?, ?, 'follow')").run(requester.id, req.userId);
  req.app.get('io').to(`user:${requester.id}`).emit('notification:new', { id: notif.lastInsertRowid, type: 'follow' });
  res.json({ accepted: true });
});

router.post('/follow-requests/:handle/decline', requireAuth, async (req, res) => {
  const requester = await db.prepare('SELECT id FROM users WHERE handle = ?').get(req.params.handle.toLowerCase());
  if (!requester) return res.status(404).json({ error: 'This account doesn\u2019t exist.' });
  await db.prepare('DELETE FROM follow_requests WHERE requester_id = ? AND target_id = ?').run(requester.id, req.userId);
  res.json({ declined: true });
});

// ---- Generic handle-based routes ----

router.get('/:handle', optionalAuth, async (req, res) => {
  const user = await db.prepare('SELECT * FROM users WHERE handle = ?').get(req.params.handle.toLowerCase());
  if (!user) return res.status(404).json({ error: 'This account doesn\u2019t exist.' });

  const isSelf = req.userId === user.id;

  if (req.userId && !isSelf) {
    const blockedByThem = !!(await db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(user.id, req.userId));
    if (blockedByThem) return res.status(404).json({ error: 'This account doesn\u2019t exist.' });
  }

  const stats = await getStats(user.id);
  const isFollowing = req.userId
    ? !!(await db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(req.userId, user.id))
    : false;
  const hasPendingRequest =
    req.userId && !isSelf
      ? !!(await db.prepare('SELECT 1 FROM follow_requests WHERE requester_id = ? AND target_id = ?').get(req.userId, user.id))
      : false;
  const iBlockedThem =
    req.userId && !isSelf
      ? !!(await db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(req.userId, user.id))
      : false;

  const canSeePosts = isSelf || !user.is_private || isFollowing;
  const isCloseFriend =
    req.userId && !isSelf ? !!(await db.prepare('SELECT 1 FROM close_friends WHERE owner_id = ? AND friend_id = ?').get(req.userId, user.id)) : false;

  let posts = [];
  if (canSeePosts) {
    const rawPosts = await db
      .prepare(
        `SELECT id, media_type, media_url, caption, playback_rate, created_at FROM posts WHERE user_id = ?
         ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, created_at DESC`
      )
      .all(user.id, user.pinned_post_id);
    posts = await Promise.all(
      rawPosts.map(async (p) => ({
        ...p,
        isPinned: p.id === user.pinned_post_id,
        likeCount: (await db.prepare('SELECT COUNT(*) c FROM likes WHERE post_id = ?').get(p.id)).c,
      }))
    );
  }

  res.json({
    user: {
      id: user.id,
      fullName: user.full_name,
      handle: user.handle,
      bio: user.bio,
      avatarColor: user.avatar_color,
      avatarUrl: user.avatar_url,
      profileTheme: user.profile_theme,
    },
    stats,
    isFollowing,
    hasPendingRequest,
    isSelf,
    isPrivate: !!user.is_private,
    canSeePosts,
    iBlockedThem,
    isCloseFriend,
    posts,
  });
});

router.post('/:handle/follow', requireAuth, async (req, res) => {
  const target = await db.prepare('SELECT * FROM users WHERE handle = ?').get(req.params.handle.toLowerCase());
  if (!target) return res.status(404).json({ error: 'This account doesn\u2019t exist.' });
  if (target.id === req.userId) return res.status(400).json({ error: 'You can\u2019t follow yourself.' });

  const blockedEitherWay = await db
    .prepare('SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)')
    .get(req.userId, target.id, target.id, req.userId);
  if (blockedEitherWay) return res.status(403).json({ error: 'You can\u2019t follow this account.' });

  // Private accounts require approval — record a pending request instead
  // of following immediately.
  if (target.is_private) {
    const inserted = await db.prepare('INSERT OR IGNORE INTO follow_requests (requester_id, target_id) VALUES (?, ?)').run(req.userId, target.id);
    if (inserted.changes > 0) {
      const notif = await db
        .prepare("INSERT INTO notifications (user_id, actor_id, type) VALUES (?, ?, 'follow_request')")
        .run(target.id, req.userId);
      req.app.get('io').to(`user:${target.id}`).emit('notification:new', { id: notif.lastInsertRowid, type: 'follow_request' });
    }
    return res.json({ following: false, requested: true, stats: await getStats(target.id) });
  }

  const inserted = await db.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)').run(req.userId, target.id);
  if (inserted.changes > 0) {
    const notif = await db.prepare("INSERT INTO notifications (user_id, actor_id, type) VALUES (?, ?, 'follow')").run(target.id, req.userId);
    req.app.get('io').to(`user:${target.id}`).emit('notification:new', { id: notif.lastInsertRowid, type: 'follow' });
  }
  res.json({ following: true, requested: false, stats: await getStats(target.id) });
});

// Also cancels a pending follow request, if there is one — so the same
// button ("Following"/"Requested" -> tap -> unfollow/cancel) works for both.
router.post('/:handle/unfollow', requireAuth, async (req, res) => {
  const target = await db.prepare('SELECT id FROM users WHERE handle = ?').get(req.params.handle.toLowerCase());
  if (!target) return res.status(404).json({ error: 'This account doesn\u2019t exist.' });

  await db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(req.userId, target.id);
  await db.prepare('DELETE FROM follow_requests WHERE requester_id = ? AND target_id = ?').run(req.userId, target.id);
  res.json({ following: false, requested: false, stats: await getStats(target.id) });
});

router.post('/:handle/block', requireAuth, async (req, res) => {
  const target = await db.prepare('SELECT id FROM users WHERE handle = ?').get(req.params.handle.toLowerCase());
  if (!target) return res.status(404).json({ error: 'This account doesn\u2019t exist.' });
  if (target.id === req.userId) return res.status(400).json({ error: 'You can\u2019t block yourself.' });

  await db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)').run(req.userId, target.id);
  // Blocking severs any existing follow relationship in either direction,
  // plus any pending follow request.
  await db
    .prepare('DELETE FROM follows WHERE (follower_id = ? AND followee_id = ?) OR (follower_id = ? AND followee_id = ?)')
    .run(req.userId, target.id, target.id, req.userId);
  await db
    .prepare('DELETE FROM follow_requests WHERE (requester_id = ? AND target_id = ?) OR (requester_id = ? AND target_id = ?)')
    .run(req.userId, target.id, target.id, req.userId);
  res.json({ blocked: true });
});

router.post('/:handle/unblock', requireAuth, async (req, res) => {
  const target = await db.prepare('SELECT id FROM users WHERE handle = ?').get(req.params.handle.toLowerCase());
  if (!target) return res.status(404).json({ error: 'This account doesn\u2019t exist.' });
  await db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(req.userId, target.id);
  res.json({ blocked: false });
});

router.post('/:handle/close-friend', requireAuth, async (req, res) => {
  const target = await db.prepare('SELECT id FROM users WHERE handle = ?').get(req.params.handle.toLowerCase());
  if (!target) return res.status(404).json({ error: 'This account doesn\u2019t exist.' });
  if (target.id === req.userId) return res.status(400).json({ error: 'You can\u2019t add yourself.' });
  await db.prepare('INSERT OR IGNORE INTO close_friends (owner_id, friend_id) VALUES (?, ?)').run(req.userId, target.id);
  res.json({ isCloseFriend: true });
});

router.post('/:handle/close-friend/remove', requireAuth, async (req, res) => {
  const target = await db.prepare('SELECT id FROM users WHERE handle = ?').get(req.params.handle.toLowerCase());
  if (!target) return res.status(404).json({ error: 'This account doesn\u2019t exist.' });
  await db.prepare('DELETE FROM close_friends WHERE owner_id = ? AND friend_id = ?').run(req.userId, target.id);
  res.json({ isCloseFriend: false });
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
