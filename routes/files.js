const express = require('express');
const { getObject } = require('../storage/backblaze');

const router = express.Router();

// Serves files out of the private B2 bucket at /files/<key>. The bucket
// itself is Private (Backblaze only requires a card for Public buckets),
// so this is what makes uploaded images/videos viewable in the app —
// this route has no auth check itself since post media, avatars, etc.
// are meant to be publicly viewable within the app.
router.get('/*', async (req, res) => {
  const key = req.params[0];
  if (!key) return res.status(400).json({ error: 'No file specified.' });

  try {
    const range = req.headers.range;
    const object = await getObject(key, range);

    res.status(range ? 206 : 200);
    if (object.ContentType) res.set('Content-Type', object.ContentType);
    if (object.ContentLength !== undefined) res.set('Content-Length', String(object.ContentLength));
    if (object.ContentRange) res.set('Content-Range', object.ContentRange);
    res.set('Accept-Ranges', 'bytes');
    // Uploaded media never changes once posted (new upload = new key), so
    // it's safe for browsers/CDNs to cache it indefinitely.
    res.set('Cache-Control', 'public, max-age=31536000, immutable');

    object.Body.pipe(res);
    object.Body.on('error', () => res.end());
  } catch {
    res.status(404).json({ error: 'File not found.' });
  }
});

module.exports = router;
