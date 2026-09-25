require('dotenv').config();
const express = require('express');
require('express-async-errors'); // lets async route handlers throw -> error middleware, instead of crashing
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const db = require('./db/init');
require('./firebase-admin'); // verifies Firebase Auth ID tokens elsewhere in the app
const { attachChatSockets } = require('./sockets/chat');

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

// Uploaded media lives in a Private B2 bucket (Public buckets require a
// card on file with Backblaze) — this route authenticates to B2 on the
// server side and streams files back out, so the bucket never has to be
// Public for the app to work.
app.use('/files', require('./routes/files'));

// Keep-alive endpoint for UptimeRobot / self-ping (prevents the free tier from sleeping)
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Frontend (web version)
// Railway does NOT build Expo. The web app is already static and is served
// directly from /public. The Android Expo project is kept separate.
const webDir = path.join(__dirname, 'public');
app.use(express.static(webDir));

// SPA fallback is intentionally not used here because the existing web app
// uses multiple HTML entry points (index.html, feed.html, chat.html, etc.).

app.use((err, req, res, next) => {
  console.error(err);
  if (err.message && (err.message.includes('image or video') || err.message.includes('image file'))) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: 'Something went wrong on our end. Please try again.' });
});

const PORT = process.env.PORT || 4000;

(async () => {
  await db.ready; // make sure tables exist before accepting traffic
  server.listen(PORT, () => {
    console.log(`Vynx server running on http://localhost:${PORT}`);
  });

  // Backup keep-alive: self-ping every 10 min so the free instance doesn't spin down
  // even if the external pinger (UptimeRobot) has a hiccup. Only runs on Render.
  if (process.env.RENDER) {
    const selfUrl = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/health`;
    setInterval(() => {
      fetch(selfUrl).catch((err) => console.error('Self-ping failed:', err.message));
    }, 10 * 60 * 1000);
    console.log(`Self-ping enabled: pinging ${selfUrl} every 10 minutes`);
  }
})();
