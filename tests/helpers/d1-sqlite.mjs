// A D1-shaped adapter over Node's built-in SQLite (node:sqlite), loaded with
// the project's REAL migrations. D1 is SQLite, so tests written against this
// exercise the actual SQL, unique indexes, CHECK constraints and foreign keys
// the Worker runs in production — not a hand-written imitation of them.
//
// Mirrors the parts of the D1 API the Worker uses: prepare().bind() with
// first() / all() / run(), and batch() (executed atomically, like D1's).

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

// Migrations that belong to features that are not part of the core schema
// under test can be skipped by name if ever needed; by default all apply.
export function createTestD1({ migrateThrough } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');

  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (migrateThrough && file > migrateThrough) break;
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }

  function statement(sql) {
    const stmt = { sql, args: [] };
    stmt.bind = (...args) => { stmt.args = args; return stmt; };
    stmt._exec = () => {
      const prepared = db.prepare(sql);
      if (prepared.columns().length > 0) {
        return { results: prepared.all(...stmt.args), success: true, meta: {} };
      }
      const info = prepared.run(...stmt.args);
      return { results: [], success: true, meta: { changes: Number(info.changes) } };
    };
    stmt.first = async () => {
      const row = db.prepare(sql).get(...stmt.args);
      return row === undefined ? null : row;
    };
    stmt.all = async () => ({ results: db.prepare(sql).all(...stmt.args), success: true, meta: {} });
    stmt.run = async () => stmt._exec();
    return stmt;
  }

  return {
    prepare: statement,
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const out = statements.map(s => s._exec());
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    // Test-only conveniences (not part of D1's API).
    exec: sql => db.exec(sql),
    query: (sql, ...args) => db.prepare(sql).all(...args),
    raw: db
  };
}

// Minimal Workers-style KV and R2 fakes for tests that go through the API layer.
export function fakeKV() {
  const store = new Map();
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    _store: store
  };
}

export function fakeR2() {
  const objects = new Map();
  return {
    async put(key, value) { objects.set(key, value); },
    async delete(key) { objects.delete(key); },
    async get(key) { return objects.has(key) ? { body: objects.get(key) } : null; },
    _objects: objects
  };
}

export function seedUser(d1, id, extra = {}) {
  d1.prepare(`INSERT INTO users (id, display_name, profile_visibility) VALUES (?, ?, 'public')`)
    .bind(id, extra.displayName || null)._exec();
  return id;
}
