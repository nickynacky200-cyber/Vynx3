const webpush = require('web-push');
const db = require('./db/init');

const configured = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (configured) {
  webpush.setVapidDetails('mailto:support@vynx.app', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}

// Fire-and-forget: pushes payload to every browser/device the user has
// subscribed on. Silently does nothing if VAPID keys aren't set (so the
// app still works without push configured), and prunes subscriptions the
// browser has revoked (404/410 from the push service = "this endpoint is
// gone", which happens when someone uninstalls or clears site data).
async function sendPushToUser(userId, payload) {
  if (!configured) return;
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  await Promise.all(
    subs.map(async (sub) => {
      const subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload));
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint);
        }
      }
    })
  );
}

module.exports = { sendPushToUser, pushConfigured: configured };
