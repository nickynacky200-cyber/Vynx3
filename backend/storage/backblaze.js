const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { randomUUID } = require('crypto');

// Backblaze B2 has an S3-compatible API, so the regular AWS SDK works
// against it — just point endpoint at your B2 account's S3 endpoint.
// Free tier: 10GB storage, no card required — as long as the bucket
// stays Private. B2 only asks for a card/payment history to flip a
// bucket to Public, so we keep it Private and serve files ourselves
// through routes/files.js instead (see server.js).
//
// Required env vars (from the Backblaze dashboard -> App Keys, and the
// bucket's details page):
//   B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET, B2_ENDPOINT
const s3 = new S3Client({
  region: 'us-west-004', // overridden by the endpoint below; B2 ignores this beyond routing
  endpoint: `https://${process.env.B2_ENDPOINT}`,
  credentials: {
    accessKeyId: process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APPLICATION_KEY,
  },
});

// Uploads a buffer (from multer's memoryStorage) under a folder prefix and
// returns a *relative* URL — served by our own /files route, not B2
// directly, since the bucket is Private. The mobile app and web frontend
// already know how to resolve a relative media URL against the API host.
async function uploadBuffer(buffer, { folder, extension, contentType }) {
  const key = `${folder}/${randomUUID()}${extension}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.B2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );
  return `/files/${key}`;
}

// Fetches an object (optionally a byte range, for video scrubbing) from
// the private bucket — used by routes/files.js to stream it back out.
async function getObject(key, range) {
  const result = await s3.send(
    new GetObjectCommand({
      Bucket: process.env.B2_BUCKET,
      Key: key,
      ...(range ? { Range: range } : {}),
    })
  );
  return result;
}

module.exports = { uploadBuffer, getObject };
