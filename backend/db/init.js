const Database = require('better-sqlite3');
const path = require('path');

// SQLite is fine to get started. Once you have real traffic (lots of posts,
// likes, and messages happening concurrently), migrate to Postgres — see
// README "Going to production".
// DB_PATH lets this point at a mounted persistent disk in production
// (e.g. Render's paid disk feature) instead of the app's own code folder,
// which gets wiped on every deploy/restart on free/ephemeral hosting.
const dbPath = process.env.DB_PATH || path.join(__dirname, 'vynx.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    handle TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE,
    password_hash TEXT,
    firebase_uid TEXT UNIQUE,
    bio TEXT DEFAULT '',
    avatar_color TEXT DEFAULT '#35f0c8',
    avatar_url TEXT,
    is_seed_account INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS follows (
    follower_id INTEGER NOT NULL,
    followee_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (follower_id, followee_id)
  );

  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    media_type TEXT NOT NULL, -- 'image' | 'video'
    media_url TEXT NOT NULL,
    caption TEXT DEFAULT '',
    playback_rate REAL NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS likes (
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (post_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- A conversation is either a 1:1 DM (is_group = 0, user_a_id/user_b_id set)
  -- or a group (is_group = 1, title/avatar_color set, members live in
  -- conversation_members). Keeping both shapes in one table means the rest
  -- of the app (messages, sockets) doesn't need to branch on chat type.
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    is_group INTEGER NOT NULL DEFAULT 0,
    user_a_id INTEGER,
    user_b_id INTEGER,
    title TEXT,
    avatar_color TEXT DEFAULT '#5b6bff',
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_a_id, user_b_id)
  );

  CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (conversation_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    message_type TEXT NOT NULL DEFAULT 'text', -- 'text' | 'image' | 'voice' | 'file'
    body TEXT,
    media_url TEXT,
    media_name TEXT,
    media_duration INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Follow + like alerts shown on the notifications page. 'comment' is
  -- reserved for later even though nothing inserts it yet.
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    actor_id INTEGER NOT NULL,
    type TEXT NOT NULL, -- 'follow' | 'like' | 'comment'
    post_id INTEGER,
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_convo ON messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);
`);

// Databases created before a given migration won't have these columns/
// tables yet — CREATE TABLE IF NOT EXISTS only applies to brand-new
// databases, so patch existing ones here.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

ensureColumn('users', 'firebase_uid', 'firebase_uid TEXT UNIQUE');
ensureColumn('users', 'avatar_url', 'avatar_url TEXT');
ensureColumn('posts', 'playback_rate', 'playback_rate REAL NOT NULL DEFAULT 1');
ensureColumn('conversations', 'is_group', 'is_group INTEGER NOT NULL DEFAULT 0');
ensureColumn('conversations', 'title', 'title TEXT');
ensureColumn('conversations', 'avatar_color', "avatar_color TEXT DEFAULT '#5b6bff'");
ensureColumn('conversations', 'created_by', 'created_by INTEGER');
ensureColumn('messages', 'message_type', "message_type TEXT NOT NULL DEFAULT 'text'");
ensureColumn('messages', 'media_url', 'media_url TEXT');
ensureColumn('messages', 'media_name', 'media_name TEXT');
ensureColumn('messages', 'media_duration', 'media_duration INTEGER');

module.exports = db;
