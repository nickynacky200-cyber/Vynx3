# Vynx — chat + short-video social app (starter)

A working first version of Vynx: accounts, follow/followers, real-time
1:1 chat, an image/video "For You" feed with likes, and a post-creation
flow. Plain HTML/CSS/JS frontend (matches the mockups) + a Node/Express +
Socket.io backend — no separate build step, and easy to swap in React
later if you want to.

## Running it locally

Login and registration use **Firebase Authentication**, so there's a
one-time setup step before `npm start` works:

1. Create a project at https://console.firebase.google.com (or reuse an
   existing one), then in **Authentication → Sign-in method**, enable the
   **Email/Password** provider.
2. **Client config**: Project settings → General → "Your apps" → add a Web
   app → copy the `firebaseConfig` object into
   `backend/public/js/firebase-config.js`.
3. **Server credentials**: Project settings → Service accounts → Generate
   new private key. Copy `project_id`, `client_email`, and `private_key`
   from the downloaded JSON into `.env` (see `.env.example` for the exact
   variable names and formatting).

```bash
cd backend
cp .env.example .env   # then fill in the FIREBASE_* values from step 3
npm install
npm start
```

Open http://localhost:4000 — you can register a real account and use the
app end to end (chat, post, follow, like).

## Populating the feed before you have real users

You said you want the feed to look alive with daily posts before opening
up to real users. Two scripts handle that:

```bash
# One-time: creates ~5 "house" accounts with a few starter posts each
npm run seed

# Keep running in the background: pulls real photos/videos from the
# Pexels API and posts a few as one of your house accounts every 24h
node scripts/daily-post-scheduler.js
```

**`daily-post-scheduler.js` needs `PEXELS_API_KEY` in your `.env`** — get
a free one at https://www.pexels.com/api (instant approval, no cost,
200 requests/hour / 20,000/month free tier). Without it, the script logs
a message and does nothing rather than failing silently.

Pexels content is free for commercial use, attribution not legally
required (the script credits the creator in the caption anyway — costs
nothing and Pexels appreciates it). It still can't be used to build a
*competing* stock-content service, or resold unaltered as posters/prints
— using it to seed a social feed is exactly the kind of use case it's
meant for. Full terms: https://www.pexels.com/license

**Read the comment at the top of `scripts/seed-demo-accounts.js`
regardless.** These are clearly-flagged house accounts
(`is_seed_account = 1`), not real people — keep it that way. Don't swap
in real celebrities' photos/videos without their permission or a proper
license; impersonating real people or posting unlicensed copyrighted
content is exactly what gets apps pulled from app stores and can expose
you to real legal liability (right of publicity, copyright infringement).
Safer paths to a lively feed beyond the Pexels content:
- Post your own original content under these house accounts.
- Reach out to willing local creators/comedians and ask them to post
  directly on Vynx (with their own real accounts).
- License content properly from a stock or creator marketplace.

To keep `daily-post-scheduler.js` running continuously on a server, use a
process manager like `pm2` (`pm2 start scripts/daily-post-scheduler.js`)
or a systemd service, rather than leaving a terminal window open.

## What's included

- **Auth** — register/login via Firebase Authentication (email/password).
  The backend never sees passwords — it just verifies the Firebase ID
  token on each request and keeps a local `users` row (handle, bio, avatar
  color) linked by `firebase_uid`.
- **Follow system** — follow/unfollow, with follower/following/likes
  counts shown on the profile page, matching the mockups.
- **Feed** — vertical scroll, autoplaying video for the card in view,
  like button, infinite scroll.
- **Chat** — real-time via Socket.io: instant delivery + a typing
  indicator. Falls back to the REST endpoint if a socket event is missed,
  so messages are never lost.
- **Posting** — upload an image or short video with a caption, stored on
  the server's disk (see below for why that changes at scale). Or use the
  built-in **camera tool** (`capture.html`) — filters, draggable text/emoji
  stickers, and a 0.5x/1x/2x speed control, all baked in the browser via
  Canvas + MediaRecorder (see note below on how "speed" actually works).
- **Group chats** — create a group from Chats → 👥＋, add anyone you
  follow or who follows you. Groups share the same message pipe as DMs
  (text, images, voice notes, documents), just fanned out to every member.
- **Chat attachments** — 📎 to send a photo or a document (preview screen
  shows the recipient's name + Send button together before it goes out),
  and press-and-hold the 🎤 to record and send a voice note.
- **Profile photo** — tap your avatar on your own profile to upload a
  replacement photo. Falls back to colored initials until you do.
- **Notifications** — a bell icon (Chats page + your own profile) shows
  follow and like alerts, with a one-tap "Follow back" on follow alerts.

### How video "speed" actually works

The camera tool's 0.5x/1x/2x control doesn't re-encode or re-time the
footage frame-by-frame (that needs a real video engine like ffmpeg,
which isn't practical to run client-side in a browser). Instead it
records at normal speed and stores the chosen rate with the post; every
place that plays the video (`feed.html`, the caption preview) sets the
`<video>` element's `playbackRate` to that value. This is a real,
noticeable speed change — audio pitch shifts too, same as scrubbing
speed on YouTube — it's just applied at playback time rather than baked
into the file. Good enough to ship with; worth revisiting with
ffmpeg.wasm or a server-side transcode step if you want the sped-up
version to be the actual exported file (e.g. for downloading a clip).

## Installing it as an app (PWA)

Vynx is a Progressive Web App — `manifest.json` + `sw.js` are already wired
into every page.

- **Android/Chrome**: visit the site, tap the browser menu → **Install app**
  (or tap the ⬇️ button on the Profile page once the browser is ready to
  offer it — that's the `beforeinstallprompt` flow in `public/js/pwa.js`)
- **iOS/Safari**: Share button → **Add to Home Screen** (iOS doesn't support
  the install-prompt API, so it's a manual step there)

Once installed it opens full-screen with its own icon, no browser chrome.
The service worker caches the static app shell (HTML/CSS/JS) for fast
loads — it never caches API calls, Firebase, or socket.io traffic, so
auth, chat, and posting always hit the live server.

If you want a real native app-store build later (APK/IPA), the natural
next step is wrapping this same frontend in **Capacitor** rather than a
rewrite — ask if you want that scaffolded.

## Known limitations to fix before a public launch

- **Video storage**: uploaded files sit in `backend/uploads/` on disk.
  Fine for testing, but won't scale — a real launch needs a service like
  Cloudflare Stream, Mux, or S3 + CloudFront for storage, compression, and
  fast delivery. This is usually the single biggest infrastructure cost
  for an app like this.
- **Database**: SQLite is fine for testing and early traffic. Move to
  Postgres once you have meaningful concurrent usage.
- **Content moderation**: there's no reporting, blocking, or automated
  moderation yet. Any app with public video + messaging needs this before
  going live on app stores — it's not optional, both Apple and Google
  will reject submissions without it.
- **"For You" ranking**: the feed is currently just newest-first. A real
  recommendation algorithm is a project of its own — newest-first is a
  reasonable placeholder to launch and learn from.
- **Push notifications**: not included. Add Firebase Cloud Messaging when
  you're ready for a native app wrapper.

## Project structure

```
backend/
  server.js                  entry point (Express + Socket.io)
  db/init.js                 SQLite schema
  firebase-admin.js          Firebase Admin SDK init (verifies ID tokens)
  middleware/auth.js         Firebase ID token auth (required + optional)
  sockets/chat.js            real-time chat delivery + typing indicator
  routes/                    auth, users (profile/follow), posts, messages
  scripts/
    seed-demo-accounts.js    creates house accounts + starter posts
    daily-post-scheduler.js  keeps adding posts over time
  uploads/                   uploaded post media (dev only, see above)
  public/                    the website (HTML/CSS/JS, matches the mockups)
```
