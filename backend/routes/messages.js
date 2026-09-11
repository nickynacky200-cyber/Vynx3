const express = require('express');
const multer = require('multer');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const { uploadBuffer } = require('../storage/backblaze');

const router = express.Router();

const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (Number(process.env.MAX_UPLOAD_MB) || 50) * 1024 * 1024 },
});

async function findOrCreateDm(userA, userB) {
  const [a, b] = [userA, userB].sort((x, y) => x - y);
  let convo = await db.prepare('SELECT * FROM conversations WHERE is_group = 0 AND user_a_id = ? AND user_b_id = ?').get(a, b);
  if (!convo) {
    const result = await db.prepare('INSERT INTO conversations (is_group, user_a_id, user_b_id) VALUES (0, ?, ?)').run(a, b);
    convo = { id: result.lastInsertRowid, is_group: 0, user_a_id: a, user_b_id: b };
  }
  return convo;
}

// Membership check used before letting someone read/send/attach in a
// conversation they were given the id for (mainly matters for groups —
// DM conversation ids are only ever handed to the two people in them).
async function isMember(conversationId, userId) {
  const convo = await db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  if (!convo) return false;
  if (!convo.is_group) return convo.user_a_id === userId || convo.user_b_id === userId;
  return !!(await db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(conversationId, userId));
}

async function messageRoomsFor(conversationId) {
  const convo = await db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  if (!convo) return [];
  if (!convo.is_group) return [convo.user_a_id, convo.user_b_id].filter((id) => id !== undefined);
  return (await db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?').all(conversationId)).map((r) => r.user_id);
}

async function broadcastMessage(req, conversationId, message) {
  const io = req.app.get('io');
  const rooms = await messageRoomsFor(conversationId);
  rooms.forEach((userId) => io.to(`user:${userId}`).emit('message:new', message));
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
router.get('/', requireAuth, async (req, res) => {
  const dmRows = await db
    .prepare(`SELECT * FROM conversations WHERE is_group = 0 AND (user_a_id = ? OR user_b_id = ?)`)
    .all(req.userId, req.userId);
  const groupRows = await db
    .prepare(
      `SELECT c.* FROM conversations c
       JOIN conversation_members m ON m.conversation_id = c.id
       WHERE c.is_group = 1 AND m.user_id = ?`
    )
    .all(req.userId);

  const conversations = await Promise.all(
    [...dmRows, ...groupRows].map(async (c) => {
      const lastMessage = await db
        .prepare('SELECT body, message_type, sender_id, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(c.id);

      if (c.is_group) {
        const memberCount = (await db.prepare('SELECT COUNT(*) c FROM conversation_members WHERE conversation_id = ?').get(c.id)).c;
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
      const other = await db.prepare('SELECT handle, full_name, avatar_color, avatar_url FROM users WHERE id = ?').get(otherId);
      return { conversationId: c.id, isGroup: false, other, lastMessage: lastMessage || null };
    })
  );

  conversations.sort((x, y) => {
    const tx = x.lastMessage ? x.lastMessage.created_at : '';
    const ty = y.lastMessage ? y.lastMessage.created_at : '';
    return ty.localeCompare(tx);
  });

  res.json({ conversations });
});

// Create a group chat. memberHandles is the OTHER members — the creator
// is always added automatically.
router.post('/group', requireAuth, async (req, res) => {
  const title = (req.body.title || '').trim();
  const memberHandles = Array.isArray(req.body.memberHandles) ? req.body.memberHandles : [];
  if (!title) return res.status(400).json({ error: 'Please give the group a name.' });
  if (!memberHandles.length) return res.status(400).json({ error: 'Add at least one other person to the group.' });

  const memberIds = new Set([req.userId]);
  for (const handle of memberHandles) {
    const user = await db.prepare('SELECT id FROM users WHERE handle = ?').get(String(handle).toLowerCase());
    if (user) memberIds.add(user.id);
  }
  if (memberIds.size < 2) return res.status(400).json({ error: 'Couldn\u2019t find any of those handles.' });

  const AVATAR_COLORS = ['#35f0c8', '#ff3b79', '#5b6bff', '#e8a33d', '#35b0f0'];
  const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

  const result = await db
    .prepare('INSERT INTO conversations (is_group, title, avatar_color, created_by) VALUES (1, ?, ?, ?)')
    .run(title.slice(0, 60), color, req.userId);

  const addMember = db.prepare('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)');
  for (const id of memberIds) {
    await addMember.run(result.lastInsertRowid, id);
  }

  res.status(201).json({ conversationId: result.lastInsertRowid, title: title.slice(0, 60), avatarColor: color });
});

// Group message history + roster.
router.get('/group/:id', requireAuth, async (req, res) => {
  const convo = await db.prepare('SELECT * FROM conversations WHERE id = ? AND is_group = 1').get(req.params.id);
  if (!convo) return res.status(404).json({ error: 'This group doesn\u2019t exist.' });
  if (!(await isMember(convo.id, req.userId))) return res.status(403).json({ error: 'You\u2019re not in this group.' });

  const members = await db
    .prepare(
      `SELECT u.id, u.handle, u.full_name, u.avatar_color, u.avatar_url FROM conversation_members m
       JOIN users u ON u.id = m.user_id WHERE m.conversation_id = ?`
    )
    .all(convo.id);
  const messageRows = await db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 200')
    .all(convo.id);

  res.json({ conversationId: convo.id, title: convo.title, avatarColor: convo.avatar_color, members, messages: messageRows.map(serializeMessage) });
});

router.post('/group/:id', requireAuth, async (req, res) => {
  const convo = await db.prepare('SELECT * FROM conversations WHERE id = ? AND is_group = 1').get(req.params.id);
  if (!convo) return res.status(404).json({ error: 'This group doesn\u2019t exist.' });
  if (!(await isMember(convo.id, req.userId))) return res.status(403).json({ error: 'You\u2019re not in this group.' });

  const body = (req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message can\u2019t be empty.' });

  const result = await db
    .prepare("INSERT INTO messages (conversation_id, sender_id, message_type, body) VALUES (?, ?, 'text', ?)")
    .run(convo.id, req.userId, body.slice(0, 2000));

  const row = await db.prepare('SELECT * FROM messages WHERE id = ?').get(result.lastInsertRowid);
  const message = serializeMessage(row);
  await broadcastMessage(req, convo.id, message);
  res.status(201).json({ message });
});

// Message history with a specific person (by handle) — DMs only.
router.get('/:handle', requireAuth, async (req, res) => {
  const other = await db.prepare('SELECT id, handle, full_name, avatar_color, avatar_url FROM users WHERE handle = ?').get(req.params.handle.toLowerCase());
  if (!other) return res.status(404).json({ error: 'This account doesn\u2019t exist.' });

  const convo = await findOrCreateDm(req.userId, other.id);
  const messageRows = await db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 200')
    .all(convo.id);

  res.json({ other, conversationId: convo.id, messages: messageRows.map(serializeMessage) });
});

// Sending also happens over the socket for instant delivery — this REST
// endpoint is the fallback that guarantees the message is saved even if a
// socket event is missed, and is what the socket handler calls internally.
router.post('/:handle', requireAuth, async (req, res) => {
  const body = (req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message can\u2019t be empty.' });

  const other = await db.prepare('SELECT id FROM users WHERE handle = ?').get(req.params.handle.toLowerCase());
  if (!other) return res.status(404).json({ error: 'This account doesn\u2019t exist.' });

  const convo = await findOrCreateDm(req.userId, other.id);
  const result = await db
    .prepare("INSERT INTO messages (conversation_id, sender_id, message_type, body) VALUES (?, ?, 'text', ?)")
    .run(convo.id, req.userId, body.slice(0, 2000));

  const row = await db.prepare('SELECT * FROM messages WHERE id = ?').get(result.lastInsertRowid);
  const message = serializeMessage(row);
  await broadcastMessage(req, convo.id, message);
  res.status(201).json({ message });
});

// Attach & send a voice note, image, or document to any conversation
// (DM or group) the sender is a member of.
router.post('/conversation/:id/media', requireAuth, chatUpload.single('file'), async (req, res) => {
  const conversationId = Number(req.params.id);
  if (!(await isMember(conversationId, req.userId))) return res.status(403).json({ error: 'You\u2019re not part of this conversation.' });
  if (!req.file) return res.status(400).json({ error: 'No file was attached.' });

  const type = ['image', 'voice', 'file'].includes(req.body.type) ? req.body.type : 'file';
  const extension = req.file.originalname.match(/\.[a-z0-9]+$/i)?.[0] || '';
  const mediaUrl = await uploadBuffer(req.file.buffer, { folder: 'chat', extension, contentType: req.file.mimetype });
  const duration = req.body.duration ? Math.round(Number(req.body.duration)) : null;

  const result = await db
    .prepare(
      `INSERT INTO messages (conversation_id, sender_id, message_type, media_url, media_name, media_duration)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(conversationId, req.userId, type, mediaUrl, req.file.originalname, duration);

  const row = await db.prepare('SELECT * FROM messages WHERE id = ?').get(result.lastInsertRowid);
  const message = serializeMessage(row);
  await broadcastMessage(req, conversationId, message);
  res.status(201).json({ message });
});

module.exports = router;
