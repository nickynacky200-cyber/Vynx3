// Run with: npm run seed
//
// Creates a handful of "house" accounts and gives each a few posts, so the
// feed has content from day one instead of looking empty to your first
// real users.
//
// IMPORTANT: the media below is free-to-use placeholder/sample content
// (Lorem Picsum photos, and Google's public Blender Foundation sample
// videos), NOT real celebrities or licensed clips. Don't post real
// celebrity photos/videos here without their permission or a license —
// impersonation and copyright infringement are exactly the kind of thing
// that gets an app pulled from the App Store / Play Store, and can expose
// you to legal liability. Swap these captions/media for your own original
// content, licensed content, or content from creators who've agreed to
// post on Vynx.

require('dotenv').config();
const db = require('../db/init');

const SAMPLE_VIDEOS = [
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
];

const SAMPLE_IMAGES = [
  'https://picsum.photos/seed/vynx1/720/1280',
  'https://picsum.photos/seed/vynx2/720/1280',
  'https://picsum.photos/seed/vynx3/720/1280',
  'https://picsum.photos/seed/vynx4/720/1280',
  'https://picsum.photos/seed/vynx5/720/1280',
];

const DEMO_ACCOUNTS = [
  { fullName: 'Vynx Originals', handle: 'vynxoriginals', bio: 'Daily clips from the Vynx team 🎬', color: '#35f0c8' },
  { fullName: 'Naija Funny Bone', handle: 'naijafunnybone', bio: 'If e no make you laugh, refund available 😂', color: '#ff3b79' },
  { fullName: 'Trivia Corner', handle: 'trivia.corner', bio: 'One fact a day keeps boredom away', color: '#e8a33d' },
  { fullName: 'Street Style Lagos', handle: 'streetstylelagos', bio: 'What Lagos is wearing this week', color: '#5b6bff' },
  { fullName: 'Vynx Music', handle: 'vynxmusic', bio: 'New sounds, fresh drops', color: '#35b0f0' },
];

const SAMPLE_CAPTIONS = [
  'POV: it\u2019s Monday and the wifi just came back 💀',
  'Did you know? The first email was sent in 1971.',
  'This edit took me 6 hours, worth it though 🔥',
  'Rating street food from every bus stop, part 1',
  'When the beat drops and you\u2019re still at your desk 🎧',
  'Tag someone who needs to see this today',
  'Small studio, big dreams 🎛️',
  'Weekend recap in 15 seconds',
];

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function run() {
  await db.ready;

  const insertUser = db.prepare(
    'INSERT INTO users (full_name, handle, bio, avatar_color, is_seed_account) VALUES (?, ?, ?, ?, 1)'
  );
  const insertPost = db.prepare('INSERT INTO posts (user_id, media_type, media_url, caption) VALUES (?, ?, ?, ?)');

  for (const acc of DEMO_ACCOUNTS) {
    const existing = await db.prepare('SELECT id FROM users WHERE handle = ?').get(acc.handle);
    let userId;
    if (existing) {
      userId = existing.id;
      console.log(`Skipping existing account @${acc.handle}`);
    } else {
      const result = await insertUser.run(acc.fullName, acc.handle, acc.bio, acc.color);
      userId = result.lastInsertRowid;
      console.log(`Created @${acc.handle}`);
    }

    // Give each account 2-3 starter posts, mixing images and videos.
    const postCount = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < postCount; i++) {
      const useVideo = Math.random() > 0.5;
      const mediaType = useVideo ? 'video' : 'image';
      const mediaUrl = useVideo ? randomFrom(SAMPLE_VIDEOS) : randomFrom(SAMPLE_IMAGES);
      await insertPost.run(userId, mediaType, mediaUrl, randomFrom(SAMPLE_CAPTIONS));
    }
  }

  console.log('\nSeeding complete. These accounts have no password set (login disabled for them) —');
  console.log('they exist only to populate the feed. Use scripts/daily-post-scheduler.js to keep adding content.');
  process.exit(0);
}

run();
