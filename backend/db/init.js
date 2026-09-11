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

    CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_convo ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);
  `);

  await ensureColumn('users', 'firebase_uid', 'firebase_uid TEXT UNIQUE');
  await ensureColumn('users', 'avatar_url', 'avatar_url TEXT');
  await ensureColumn('posts', 'playback_rate', 'playback_rate REAL NOT NULL DEFAULT 1');
  await ensureColumn('conversations', 'is_group', 'is_group INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('conversations', 'title', 'title TEXT');
  await ensureColumn('conversations', 'avatar_color', "avatar_color TEXT DEFAULT '#5b6bff'");
  await ensureColumn('conversations', 'created_by', 'created_by INTEGER');
  await ensureColumn('messages', 'message_type', "message_type TEXT NOT NULL DEFAULT 'text'");
  await ensureColumn('messages', 'media_url', 'media_url TEXT');
  await ensureColumn('messages', 'media_name', 'media_name TEXT');
  await ensureColumn('messages', 'media_duration', 'media_duration INTEGER');
})();

module.exports = { prepare, ready };
