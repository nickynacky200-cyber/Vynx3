require('../firebase-admin');
const { getAuth } = require('firebase-admin/auth');
const db = require('../db/init');

// Each connected user joins a room named "user:<id>" so we can push
// messages to them from anywhere (including the REST send endpoint).
function attachChatSockets(io) {
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Missing auth token'));
    try {
      const decoded = await getAuth().verifyIdToken(token);
      const localUser = db.prepare('SELECT id FROM users WHERE firebase_uid = ?').get(decoded.uid);
      if (!localUser) return next(new Error('Please finish setting up your account.'));
      socket.userId = localUser.id;
      next();
    } catch {
      next(new Error('Invalid or expired session'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.userId}`);

    // { toUserId } for a DM, or { toConversationId } for a group — lets
    // the recipient's chat screen show "typing…"
    socket.on('typing', ({ toUserId, toConversationId }) => {
      if (toUserId) {
        socket.to(`user:${toUserId}`).emit('typing', { fromUserId: socket.userId });
        return;
      }
      if (toConversationId) {
        const memberIds = db
          .prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?')
          .all(toConversationId)
          .map((r) => r.user_id);
        memberIds
          .filter((id) => id !== socket.userId)
          .forEach((id) => socket.to(`user:${id}`).emit('typing', { fromUserId: socket.userId, conversationId: toConversationId }));
      }
    });

    socket.on('disconnect', () => {
      /* nothing to clean up — room membership is per-connection */
    });
  });
}

module.exports = { attachChatSockets };
