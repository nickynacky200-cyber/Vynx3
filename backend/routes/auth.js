require('../firebase-admin');
const express = require('express');
const { getAuth } = require('firebase-admin/auth');
const db = require('../db/init');

const router = express.Router();

const AVATAR_COLORS = ['#35f0c8', '#ff3b79', '#5b6bff', '#e8a33d', '#35b0f0'];
const randomColor = () => AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

async function verifyToken(req) {
  const header = req.headers.authorization || '';
  const idToken = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!idToken) return null;
  try {
    return await getAuth().verifyIdToken(idToken);
  } catch {
    return null;
  }
}

function toProfile(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    handle: row.handle,
    bio: row.bio,
    avatarColor: row.avatar_color,
    avatarUrl: row.avatar_url,
  };
}

// Called right after the client signs in or signs up with Firebase.
// Looks up the local profile row (handle, bio, avatar color, posts, etc.)
// tied to this Firebase user — or, for a brand-new Firebase account,
// creates it from the fullName/handle passed in the body.
router.post('/sync', async (req, res) => {
  const decoded = await verifyToken(req);
  if (!decoded) return res.status(401).json({ error: 'Your session has expired. Please log in again.' });

  const existing = db.prepare('SELECT * FROM users WHERE firebase_uid = ?').get(decoded.uid);
  if (existing) return res.json({ user: toProfile(existing) });

  // For a Google sign-in, Firebase already knows their name (from the
  // decoded token's `name` claim) — only ask for what we don't have,
  // which is the handle.
  const fullName = req.body.fullName || decoded.name;
  const { handle } = req.body;
  if (!fullName || !handle) {
    return res.status(400).json({
      error: 'Please provide your name and a handle to finish creating your account.',
      needsProfile: true,
      suggestedFullName: decoded.name || null,
    });
  }
  if (!/^[a-z0-9_.]{3,20}$/i.test(handle)) {
    return res.status(400).json({ error: 'Handle must be 3-20 characters: letters, numbers, dots, or underscores.' });
  }

  const handleTaken = db.prepare('SELECT id FROM users WHERE handle = ?').get(handle.toLowerCase());
  if (handleTaken) return res.status(409).json({ error: 'That handle is already taken.' });

  const result = db
    .prepare('INSERT INTO users (full_name, handle, email, firebase_uid, avatar_color, avatar_url) VALUES (?, ?, ?, ?, ?, ?)')
    .run(fullName, handle.toLowerCase(), decoded.email || null, decoded.uid, randomColor(), decoded.picture || null);

  const created = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ user: toProfile(created) });
});

module.exports = router;
