const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const { sendPushToUser } = require('../push');

const router = express.Router();

const chatUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(req.app.get('uploadsDir'), 'chat')),
    filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname) || ''}`),
  }),
  limits: { fileSize: (Number(process.env.MAX_UPLOAD_MB) || 50) * 1024 * 1024 },
});

function findOrCreateDm(userA, userB) {
  const [a, b] = [userA, userB].sort((x, y) => x - y);
  let convo = db.prepare('SELECT * FROM conversations WHERE is_group = 0 AND user_a_id = ? AND user_b_id = ?').get(a, b);
  if (!convo) {
    const result = db.prepare('INSERT INTO conversations (is_group, user_a_id, user_b_id) VALUES (0, ?, ?)').run(a, b);
    convo = { id: result.lastInsertRowid, is_group: 0, user_a_id: a, user_b_id: b };
  }
  return convo;
}

// Membership check used before letting someone read/send/attach in a
// conversation they were given the id for (mainly matters for groups —
// DM conversation ids are only ever handed to the two people in them).
function isMember(conversationId, userId) {
  const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  if (!convo) return false;
  if (!convo.is_group) return convo.user_a_id === userId || convo.user_b_id === userId;
  return !!db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(conversationId, userId);
}

function messageRoomsFor(conversationId) {
  const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  if (!convo) return [];
  if (!convo.is_group) return [convo.user_a_id, convo.user_b_id].filter((id) => id !== undefined);
  return db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?').all(conversationId).map((r) => r.user_id);
}

function broadcastMessage(req, conversationId, message) {
  const io = req.app.get('io');
  const sender = db.prepare('SELECT full_name FROM users WHERE id = ?').get(message.senderId);
  const previewText = message.type === 'text' ? message.body
    : message.type === 'image' ? '\u{1F4F7} Photo'
    : message.type === 'voice' ? '\u{1F3A4} Voice note'
    : '\u{1F4CE} Document';

  messageRoomsFor(conversationId).forEach((userId) => {
    io.to(`user:${userId}`).emit('message:new', message);
    if (userId !== message.senderId) {
      sendPushToUser(userId, {
        title: sender ? sender.full_name : 'New message',
        body: previewText ? previewText.slice(0, 100) : 'Sent you a message',
        url: '/chats.html',
      });
    }
  });
}

function serializeMessage(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    type: row.message_type,
    body: row.body,
    mediaUrl: row.media_url,
    mediaName: row.media_name,
    mediaDuration: row.media_duration,
    createdAt: row.created_at,
  };
}

// List of conversations (DMs + groups) for the logged-in user, each with
// a display name/avatar and the most recent message.
router.get('/', requireAuth, (req, res) => {
  const dmRows = db
    .prepare(`SELECT * FROM conversations WHERE is_group = 0 AND (user_a_id = ? OR user_b_id = ?)`)
    .all(req.userId, req.userId);
  const groupRows = db
    .prepare(
      `SELECT c.* FROM conversations c
       JOIN conversation_members m ON m.conversation_id = c.id
       WHERE c.is_group = 1 AND m.user_id = ?`
    )
    .all(req.userId);

  const conversations = [...dmRows, ...groupRows].map((c) => {
    const lastMessage = db
      .prepare('SELECT body, message_type, sender_id, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(c.id);

    if (c.is_group) {
      const memberCount = db.prepare('SELECT COUNT(*) c FROM conversation_members WHERE conversation_id = ?').get(c.id).c;
      return {
        conversationId: c.id,
        isGroup: true,
        title: c.title,
        avatarColor: c.avatar_color,
        memberCount,
        lastMessage: lastMessage || null,
      };
    }

    const otherId = c.user_a_id === req.userId ? c.user_b_id : c.user_a_id;
    const other = db.prepare('SELECT handle, full_name, avatar_color, avatar_url FROM users WHERE id = ?').get(otherId);
    return { conversationId: c.id, isGroup: false, other, lastMessage: lastMessage || null };
  });

  conversations.sort((x, y) => {
    const tx = x.lastMessage ? x.lastMessage.created_at : '';
    const ty = y.lastMessage ? y.lastMessage.created_at : '';
    return ty.localeCompare(tx);
  });

  res.json({ conversations });
});

// Create a group chat. memberHandles is the OTHER members — the creator
// is always added automatically.
router.post('/group', requireAuth, (req, res) => {
  const title = (req.body.title || '').trim();
  const memberHandles = Array.isArray(req.body.memberHandles) ? req.body.memberHandles : [];
  if (!title) return res.status(400).json({ error: 'Please give the group a name.' });
  if (!memberHandles.length) return res.status(400).json({ error: 'Add at least one other person to the group.' });

  const memberIds = new Set([req.userId]);
  for (const handle of memberHandles) {
    const user = db.prepare('SELECT id FROM users WHERE handle = ?').get(String(handle).toLowerCase());
    if (user) memberIds.add(user.id);
  }
  if (memberIds.size < 2) return res.status(400).json({ error: 'Couldn\u2019t find any of those handles.' });

  const AVATAR_COLORS = ['#35f0c8', '#ff3b79', '#5b6bff', '#e8a33d', '#35b0f0'];
  const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

  const result = db
    .prepare('INSERT INTO conversations (is_group, title, avatar_color, created_by) VALUES (1, ?, ?, ?)')
    .run(title.slice(0, 60), color, req.userId);

  const addMember = db.prepare('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)');
  memberIds.forEach((id) => addMember.run(result.lastInsertRowid, id));

  res.status(201).json({ conversationId: result.lastInsertRowid, title: title.slice(0, 60), avatarColor: color });
});

// Group message history + roster.
router.get('/group/:id', requireAuth, (req, res) => {
  const convo = db.prepare('SELECT * FROM conversations WHERE id = ? AND is_group = 1').get(req.params.id);
  if (!convo) return res.status(404).json({ error: 'This group doesn\u2019t exist.' });
  if (!isMember(convo.id, req.userId)) return res.status(403).json({ error: 'You\u2019re not in this group.' });

  const members = db
    .prepare(
      `SELECT u.id, u.handle, u.full_name, u.avatar_color, u.avatar_url FROM conversation_members m
       JOIN users u ON u.id = m.user_id WHERE m.conversation_id = ?`
    )
    .all(convo.id);
  const messages = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 200')
    .all(convo.id)
    .map(serializeMessage);

  res.json({ conversationId: convo.id, title: convo.title, avatarColor: convo.avatar_color, members, messages });
});

router.post('/group/:id', requireAuth, (req, res) => {
  const convo = db.prepare('SELECT * FROM conversations WHERE id = ? AND is_group = 1').get(req.params.id);
  if (!convo) return res.status(404).json({ error: 'This group doesn\u2019t exist.' });
  if (!isMember(convo.id, req.userId)) return res.status(403).json({ error: 'You\u2019re not in this group.' });

  const body = (req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message can\u2019t be empty.' });

  const result = db
    .prepare('INSERT INTO messages (conversation_id, sender_id, message_type, body) VALUES (?, ?, \'text\', ?)')
    .run(convo.id, req.userId, body.slice(0, 2000));

  const message = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(result.lastInsertRowid));
  broadcastMessage(req, convo.id, message);
  res.status(201).json({ message });
});

// Message history with a specific person (by handle) — DMs only.
router.get('/:handle', requireAuth, (req, res) => {
  const other = db.prepare('SELECT id, handle, full_name, avatar_color, avatar_url FROM users WHERE handle = ?').get(req.params.handle.toLowerCase());
  if (!other) return res.status(404).json({ error: 'This account doesn\u2019t exist.' });

  const convo = findOrCreateDm(req.userId, other.id);
  const messages = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 200')
    .all(convo.id)
    .map(serializeMessage);

  res.json({ other, conversationId: convo.id, messages });
});

// Sending also happens over the socket for instant delivery — this REST
// endpoint is the fallback that guarantees the message is saved even if a
// socket event is missed, and is what the socket handler calls internally.
router.post('/:handle', requireAuth, (req, res) => {
  const body = (req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message can\u2019t be empty.' });

  const other = db.prepare('SELECT id FROM users WHERE handle = ?').get(req.params.handle.toLowerCase());
  if (!other) return res.status(404).json({ error: 'This account doesn\u2019t exist.' });

  const convo = findOrCreateDm(req.userId, other.id);
  const result = db
    .prepare('INSERT INTO messages (conversation_id, sender_id, message_type, body) VALUES (?, ?, \'text\', ?)')
    .run(convo.id, req.userId, body.slice(0, 2000));

  const message = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(result.lastInsertRowid));
  broadcastMessage(req, convo.id, message);
  res.status(201).json({ message });
});

// Attach & send a voice note, image, or document to any conversation
// (DM or group) the sender is a member of.
router.post('/conversation/:id/media', requireAuth, chatUpload.single('file'), (req, res) => {
  const conversationId = Number(req.params.id);
  if (!isMember(conversationId, req.userId)) return res.status(403).json({ error: 'You\u2019re not part of this conversation.' });
  if (!req.file) return res.status(400).json({ error: 'No file was attached.' });

  const type = ['image', 'voice', 'file'].includes(req.body.type) ? req.body.type : 'file';
  const mediaUrl = `/uploads/chat/${req.file.filename}`;
  const duration = req.body.duration ? Math.round(Number(req.body.duration)) : null;

  const result = db
    .prepare(
      `INSERT INTO messages (conversation_id, sender_id, message_type, media_url, media_name, media_duration)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(conversationId, req.userId, type, mediaUrl, req.file.originalname, duration);

  const message = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(result.lastInsertRowid));
  broadcastMessage(req, conversationId, message);
  res.status(201).json({ message });
});

module.exports = router;
