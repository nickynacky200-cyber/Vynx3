const path = require('path');
const { createClient } = require('@libsql/client');

// libSQL (the engine behind Turso) speaks the same SQL dialect as SQLite,
// so the schema and every query below is unchanged from the old
// better-sqlite3 version. What changes is *how* we talk to it: libSQL is
// always async, and it can point at either a local file (for local dev,
// no account needed) or a remote Turso database (for production, so data
// survives the free host sleeping/restarting).
//
// Local dev:  no env vars needed — uses a local file, just like before.
// Production: set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN (from
//             `turso db show` / `turso db tokens create`).
const client = createClient({
  url: process.env.TURSO_DATABASE_URL || `file:${path.join(__dirname, 'vynx.db')}`,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

function rowsToObjects(result) {
  return result.rows.map((row) => {
    const obj = {};
    result.columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
}

// A thin shim that mimics better-sqlite3's db.prepare(sql).get/all/run API
// (same call sites everywhere else in the app) but async under the hood.
function prepare(sql) {
  return {
    async get(...args) {
      const result = await client.execute({ sql, args });
      return rowsToObjects(result)[0];
    },
    async all(...args) {
      const result = await client.execute({ sql, args });
      return rowsToObjects(result);
    },
    async run(...args) {
      const result = await client.execute({ sql, args });
      return {
        changes: result.rowsAffected,
        // BigInt -> Number: our ids never get remotely close to needing
        // BigInt precision, and BigInt breaks JSON.stringify on responses.
        lastInsertRowid: result.lastInsertRowid === undefined ? undefined : Number(result.lastInsertRowid),
      };
    },
  };
}

async function exec(sql) {
  await client.executeMultiple(sql);
}

async function ensureColumn(table, column, ddl) {
  const result = await client.execute(`PRAGMA table_info(${table})`);
  const cols = rowsToObjects(result).map((c) => c.name);
  if (!cols.includes(column)) await client.execute(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

const ready = (async () => {
  await exec(`
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
      media_type TEXT NOT NULL,
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
      message_type TEXT NOT NULL DEFAULT 'text',
      body TEXT,
      media_url TEXT,
      media_name TEXT,
      media_duration INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      actor_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      post_id INTEGER,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS follow_requests (
      requester_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (requester_id, target_id)
    );

    CREATE TABLE IF NOT EXISTS blocks (
      blocker_id INTEGER NOT NULL,
      blocked_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (blocker_id, blocked_id)
    );

    -- Extra media items for a carousel post beyond the first one (which
    -- still lives on posts.media_url/media_type for backward compat).
    CREATE TABLE IF NOT EXISTS post_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      media_type TEXT NOT NULL,
      media_url TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS close_friends (
      owner_id INTEGER NOT NULL,
      friend_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (owner_id, friend_id)
    );

    CREATE TABLE IF NOT EXISTS reposts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      post_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, post_id)
    );

    CREATE TABLE IF NOT EXISTS message_reactions (
      message_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      emoji TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (message_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS conversation_reads (
      conversation_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      last_read_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (conversation_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_convo ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_post_media_post ON post_media(post_id, position);
    CREATE INDEX IF NOT EXISTS idx_reposts_post ON reposts(post_id);
    CREATE INDEX IF NOT EXISTS idx_reposts_user ON reposts(user_id, created_at);
  `);

  await ensureColumn('users', 'firebase_uid', 'firebase_uid TEXT UNIQUE');
  await ensureColumn('users', 'avatar_url', 'avatar_url TEXT');
  await ensureColumn('users', 'is_private', 'is_private INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'comment_privacy', "comment_privacy TEXT NOT NULL DEFAULT 'everyone'");
  await ensureColumn('users', 'message_privacy', "message_privacy TEXT NOT NULL DEFAULT 'everyone'");
  await ensureColumn('users', 'muted_words', "muted_words TEXT NOT NULL DEFAULT '[]'");
  await ensureColumn('users', 'profile_theme', 'profile_theme TEXT');
  await ensureColumn('users', 'pinned_post_id', 'pinned_post_id INTEGER');
  await ensureColumn('posts', 'playback_rate', 'playback_rate REAL NOT NULL DEFAULT 1');
  await ensureColumn('posts', 'visibility', "visibility TEXT NOT NULL DEFAULT 'public'");
  await ensureColumn('posts', 'reply_to_post_id', 'reply_to_post_id INTEGER');
  await ensureColumn('conversations', 'is_group', 'is_group INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('conversations', 'title', 'title TEXT');
  await ensureColumn('conversations', 'avatar_color', "avatar_color TEXT DEFAULT '#5b6bff'");
  await ensureColumn('conversations', 'created_by', 'created_by INTEGER');
  await ensureColumn('conversations', 'disappearing_seconds', 'disappearing_seconds INTEGER');
  await ensureColumn('conversations', 'description', "description TEXT NOT NULL DEFAULT ''");
  await ensureColumn('conversations', 'icon_url', 'icon_url TEXT');
  await ensureColumn('conversations', 'invite_token', 'invite_token TEXT');
  await ensureColumn('conversations', 'edit_info_permission', "edit_info_permission TEXT NOT NULL DEFAULT 'admins'");
  await ensureColumn('conversations', 'send_messages_permission', "send_messages_permission TEXT NOT NULL DEFAULT 'all'");
  await ensureColumn('conversations', 'add_members_permission', "add_members_permission TEXT NOT NULL DEFAULT 'admins'");
  await ensureColumn('messages', 'message_type', "message_type TEXT NOT NULL DEFAULT 'text'");
  await ensureColumn('messages', 'media_url', 'media_url TEXT');
  await ensureColumn('messages', 'media_name', 'media_name TEXT');
  await ensureColumn('messages', 'media_duration', 'media_duration INTEGER');
  await ensureColumn('messages', 'shared_post_id', 'shared_post_id INTEGER');
  await ensureColumn('messages', 'expires_at', 'expires_at TEXT');
  await ensureColumn('conversation_members', 'role', "role TEXT NOT NULL DEFAULT 'member'");
  await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_invite_token ON conversations(invite_token)');
  await client.execute("UPDATE conversation_members SET role = 'owner' WHERE conversation_id IN (SELECT id FROM conversations WHERE is_group = 1 AND created_by IS NOT NULL AND created_by = conversation_members.user_id) AND role = 'member'");
})();

module.exports = { prepare, ready };
