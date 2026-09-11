// Run with: node scripts/daily-post-scheduler.js
// Keep this running in the background (e.g. with pm2, a systemd service, or
// a cron job that runs it once and exits) so the feed keeps getting new
// posts from your house accounts every day, even before you have real users
// posting regularly.
//
// Swap SAMPLE_VIDEOS / SAMPLE_IMAGES / SAMPLE_CAPTIONS for your own content
// as you get it — see the caveat in seed-demo-accounts.js about not using
// real celebrities' likeness or copyrighted clips.

require('dotenv').config();
const db = require('../db/init');

const SAMPLE_VIDEOS = [
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/SubaruOutbackOnStreetAndDirt.mp4',
];

const SAMPLE_IMAGES = [
  'https://picsum.photos/seed/vynxdaily1/720/1280',
  'https://picsum.photos/seed/vynxdaily2/720/1280',
  'https://picsum.photos/seed/vynxdaily3/720/1280',
];

const SAMPLE_CAPTIONS = [
  'New day, new clip 🎬',
  'This one\u2019s for the night owls 🌙',
  'Quick one before the week gets busy',
  'Rate this 1-10 in the comments',
  'Behind the scenes of today\u2019s shoot',
];

const POSTS_PER_RUN = 3; // how many posts to add each time this runs
const RUN_EVERY_HOURS = 24; // set to a smaller number for testing

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function postOnce() {
  const seedUsers = await db.prepare('SELECT id, handle FROM users WHERE is_seed_account = 1').all();
  if (!seedUsers.length) {
    console.log('No seed accounts found. Run "npm run seed" first.');
    return;
  }

  const insertPost = db.prepare('INSERT INTO posts (user_id, media_type, media_url, caption) VALUES (?, ?, ?, ?)');

  for (let i = 0; i < POSTS_PER_RUN; i++) {
    const user = randomFrom(seedUsers);
    const useVideo = Math.random() > 0.5;
    const mediaType = useVideo ? 'video' : 'image';
    const mediaUrl = useVideo ? randomFrom(SAMPLE_VIDEOS) : randomFrom(SAMPLE_IMAGES);
    await insertPost.run(user.id, mediaType, mediaUrl, randomFrom(SAMPLE_CAPTIONS));
    console.log(`Posted as @${user.handle} (${mediaType})`);
  }
}

// Run immediately, then on the configured interval. If you're using a
// system cron job instead, delete the setInterval block and just let the
// script run postOnce() once per invocation.
(async () => {
  await db.ready;
  await postOnce();
  setInterval(postOnce, RUN_EVERY_HOURS * 60 * 60 * 1000);
  console.log(`Daily post scheduler running — posting ${POSTS_PER_RUN} items every ${RUN_EVERY_HOURS}h. Leave this running in the background.`);
})();
