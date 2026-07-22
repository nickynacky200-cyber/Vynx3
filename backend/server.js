require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');

require('./db/init'); // ensures tables exist on boot
require('./firebase-admin'); // verifies Firebase Auth ID tokens elsewhere in the app
const { attachChatSockets } = require('./sockets/chat');

// UPLOADS_DIR lets this point at a mounted persistent disk in production
// instead of the app's own code folder — same reasoning as DB_PATH above.
const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
['', 'chat', 'avatars'].forEach((sub) => {
  fs.mkdirSync(path.join(uploadsDir, sub), { recursive: true });
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.set('io', io);
attachChatSockets(io);

app.use(cors());
app.use(express.json());

app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/posts', require('./routes/posts'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/notifications', require('./routes/notifications'));
app.get('/api/push/public-key', (req, res) => res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || null }));

// Uploaded post media
app.use('/uploads', express.static(uploadsDir));
app.set('uploadsDir', uploadsDir);

// The service worker file itself must never be cached by the browser, or
// updates to it (and thus to the app shell it controls) won't take effect.
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// Frontend
app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  console.error(err);
  if (err.message && err.message.includes('image or video')) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: 'Something went wrong on our end. Please try again.' });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Vynx server running on http://localhost:${PORT}`);
});
