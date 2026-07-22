// Run with: node scripts/daily-post-scheduler.js
// Keep this running in the background (e.g. with pm2, a systemd service, or
// a cron job) so the feed keeps getting fresh content from your house
// accounts, even before you have real users posting regularly.
//
// Pulls real (freely licensed) photos and videos from the Pexels API —
// https://www.pexels.com/api/ — free to use, no attribution legally
// required, but this script credits the photographer in the caption
// anyway since Pexels appreciates it and it looks better than a bare clip.
//
// Requires PEXELS_API_KEY in your .env (free — sign up at pexels.com/api,
// instant approval, 200 requests/hour and 20,000/month on the free tier,
// which is far more than this script needs).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/init');

const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

// Broad, safe, widely-appealing search terms — swap these for whatever fits
// Vynx's audience (e.g. add "afrobeats", "lagos street food", "naija fashion").
const SEARCH_TERMS = ['lifestyle', 'dance', 'music', 'street food', 'fashion', 'nature', 'city life', 'fitness', 'travel'];

const POSTS_PER_RUN = 3; // how many posts to add each time this runs
const RUN_EVERY_HOURS = 24; // set lower for testing, e.g. 1
const VIDEO_CHANCE = 0.6; // rest are photos

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function fetchRandomVideo(query) {
  const page = Math.floor(Math.random() * 5) + 1;
  const res = await fetch(
    `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&orientation=portrait&per_page=10&page=${page}`,
    { headers: { Authorization: PEXELS_API_KEY } }
  );
  if (!res.ok) throw new Error(`Pexels video search failed: ${res.status}`);
  const data = await res.json();
  if (!data.videos?.length) return null;
  const video = randomFrom(data.videos);
  // Prefer the smallest portrait rendition available — keeps downloads and
  // storage reasonable instead of grabbing the largest master file.
  const portraitFiles = video.video_files.filter((f) => f.height > f.width);
  const file = (portraitFiles.length ? portraitFiles : video.video_files).sort((a, b) => a.width - b.width)[0];
  return { url: file.link, ext: '.mp4', mediaType: 'video', photographer: video.user?.name || 'a Pexels creator' };
}

async function fetchRandomPhoto(query) {
  const page = Math.floor(Math.random() * 5) + 1;
  const res = await fetch(
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&orientation=portrait&per_page=10&page=${page}`,
    { headers: { Authorization: PEXELS_API_KEY } }
  );
  if (!res.ok) throw new Error(`Pexels photo search failed: ${res.status}`);
  const data = await res.json();
  if (!data.photos?.length) return null;
  const photo = randomFrom(data.photos);
  return { url: photo.src.large, ext: '.jpg', mediaType: 'image', photographer: photo.photographer || 'a Pexels creator' };
}

async function downloadTo(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
}

async function postOnce() {
  if (!PEXELS_API_KEY) {
    console.log('Set PEXELS_API_KEY in .env to enable this script (free key at pexels.com/api).');
    return;
  }
  const seedUsers = db.prepare('SELECT id, handle FROM users WHERE is_seed_account = 1').all();
  if (!seedUsers.length) {
    console.log('No seed accounts found. Run "npm run seed" first.');
    return;
  }

  const insertPost = db.prepare('INSERT INTO posts (user_id, media_type, media_url, caption) VALUES (?, ?, ?, ?)');

  for (let i = 0; i < POSTS_PER_RUN; i++) {
    const term = randomFrom(SEARCH_TERMS);
    try {
      const found = Math.random() < VIDEO_CHANCE ? await fetchRandomVideo(term) : await fetchRandomPhoto(term);
      if (!found) {
        console.log(`No Pexels results for "${term}", skipping this slot.`);
        continue;
      }
      const filename = `${uuidv4()}${found.ext}`;
      await downloadTo(found.url, path.join(uploadsDir, filename));

      const user = randomFrom(seedUsers);
      const caption = `${term[0].toUpperCase()}${term.slice(1)} vibes — clip by ${found.photographer} via Pexels`;
      insertPost.run(user.id, found.mediaType, `/uploads/${filename}`, caption);
      console.log(`Posted as @${user.handle}: ${term} (${found.mediaType})`);
    } catch (err) {
      console.error(`Failed to post for "${term}":`, err.message);
    }
  }
}

// Run immediately, then on the configured interval. If you're using a
// system cron job instead, delete the setInterval block below and just
// let the script run postOnce() once per invocation.
postOnce();
setInterval(postOnce, RUN_EVERY_HOURS * 60 * 60 * 1000);
console.log(`Daily post scheduler running — posting ${POSTS_PER_RUN} items every ${RUN_EVERY_HOURS}h via Pexels. Leave this running in the background.`);
