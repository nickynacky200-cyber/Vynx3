# Deploying Vynx for free, permanently — no card required

This backend stores nothing on local disk — the database and all
uploaded media live on services with permanent free tiers, so it's safe
to run on a host that sleeps/restarts without losing data, and nothing
here requires a credit card.

| Piece | Was | Now | Why |
|---|---|---|---|
| Database | local SQLite file (`better-sqlite3`) | **Turso** (`@libsql/client`) | Same SQL dialect as SQLite — barely any query changes — but hosted, so it survives restarts. Free forever, no card. |
| Uploads (posts, avatars, chat files) | local `/uploads` folder | **Backblaze B2** (Private bucket) | Free tier: 10GB storage, no card — as long as the bucket stays Private (B2 only asks for a card to flip a bucket to Public). |
| Serving uploaded files | Express static `/uploads` | Your own `/files` route (`routes/files.js`) | Since the B2 bucket is Private, the app authenticates to B2 itself and streams the file back out — so nothing needs to be publicly exposed on B2's side. |
| Compute | — | Render (free) or Railway (paid, always-on) | Wherever you deploy the Node app itself. |

Local development still works exactly as before — if `TURSO_DATABASE_URL`
isn't set, it falls back to a local SQLite file automatically. You'll
still need B2 configured even locally, since there's no local-disk
fallback for uploads anymore.

## 1. Set up Turso (database)

Easiest from a phone/browser: sign up at **turso.tech**, click **Create
Database** on the dashboard, name it `vynx`. The database page shows
your connection URL (`TURSO_DATABASE_URL`) and a place to generate a
token (`TURSO_AUTH_TOKEN`). No card required.

## 2. Set up Backblaze B2 (file storage) — keep it Private

1. Sign up at **backblaze.com/b2** — no card required
2. **Buckets** → **Create a Bucket** → name it `vynx` → leave it set to
   **Private** (picking Public is what triggers B2 asking for a card —
   skip that entirely, the app doesn't need it)
3. Click into the bucket → note the **Endpoint** (something like
   `s3.us-west-004.backblazeb2.com`) — that's `B2_ENDPOINT`
4. **App Keys** (left sidebar) → **Add a New Application Key** → name
   it, scope it to the `vynx` bucket, allow Read & Write → copy the
   `keyID` (→ `B2_KEY_ID`) and `applicationKey` (→ `B2_APPLICATION_KEY`,
   only shown once — save it immediately)

## 3. Fill in `.env`

```
TURSO_DATABASE_URL=libsql://vynx-yourname.turso.io
TURSO_AUTH_TOKEN=ey...
B2_KEY_ID=...
B2_APPLICATION_KEY=...
B2_BUCKET=vynx
B2_ENDPOINT=s3.us-west-004.backblazeb2.com
```
(plus the Firebase vars you already had). Note there's no
`B2_PUBLIC_URL` — the app serves files itself now, so it isn't needed.

## 4. Deploy

Push `backend/` to GitHub (via `git`, or drag-and-drop upload on
github.com if you don't have `git` available), then connect that repo
to Render or Railway, adding all the variables above under
Environment/Variables. Generate a public domain, and point
`vynx-mobile/src/api/config.js` at it.

## How file URLs work now

When something's uploaded, the app stores a URL like
`/files/posts/<uuid>.jpg` in the database — a path on *your own*
backend, not a direct B2 link. When a client requests that path, your
server fetches the actual file from the private B2 bucket (using your
app's credentials) and streams it straight through. Video scrubbing
still works — the route supports HTTP range requests, which is what
video players use to seek without downloading the whole file first.

The trade-off: file traffic now flows through your own server's
bandwidth instead of B2's directly. For a small/early-stage app this is
a non-issue; if the app gets large, that's the point where paying for a
Public bucket (or a CDN in front of it) starts to make sense.

## What "restarts" now actually mean

On a free host that sleeps when idle, waking up no longer wipes your
data: Turso and B2 are separate, always-on services, so accounts,
posts, likes, and messages are exactly as they were before the nap.
