require('../firebase-admin');
const { getAuth } = require('firebase-admin/auth');
const db = require('../db/init');

function findLocalUser(firebaseUid) {
  return db.prepare('SELECT id FROM users WHERE firebase_uid = ?').get(firebaseUid);
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const idToken = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!idToken) return res.status(401).json({ error: 'Please log in to continue.' });

  try {
    const decoded = await getAuth().verifyIdToken(idToken);
    const localUser = findLocalUser(decoded.uid);
    if (!localUser) {
      return res.status(401).json({ error: 'Please finish setting up your account.' });
    }
    req.userId = localUser.id;
    req.firebaseUid = decoded.uid;
    next();
  } catch {
    return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  }
}

// Verifies a token if present, but doesn't block the request if not —
// used for pages like a public profile that behave slightly differently
// when the visitor is logged in (e.g. showing a Follow vs Edit button).
async function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const idToken = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (idToken) {
    try {
      const decoded = await getAuth().verifyIdToken(idToken);
      const localUser = findLocalUser(decoded.uid);
      if (localUser) {
        req.userId = localUser.id;
        req.firebaseUid = decoded.uid;
      }
    } catch {
      /* ignore invalid token, treat as logged out */
    }
  }
  next();
}

module.exports = { requireAuth, optionalAuth };
