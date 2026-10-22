// Migration 0046 (users.google_avatar_url) on a database built exactly as
// production's schema is today (migrations 0001-0045), with riders of every
// kind: a Google picture shown, an upload, no picture, a private rider, and
// their XP, sightings and leaderboard row.
//   - it adds the column, backfills it only from a shown https (Google)
//     picture, and changes NOTHING else: every other column of every table is
//     byte-for-byte the same, including names, usernames, privacy, XP,
//     streak sightings and the stored leaderboard figures
//   - the result matches the schema the new Worker is tested against
//   - the backfill statement is safe to run twice
// Isolated: an in-memory database. Run: node tests/migration-0046.test.mjs

import fs from 'node:fs';
import { createTestD1 } from './helpers/d1-sqlite.mjs';
import { makeCheck } from './helpers/env.mjs';

const t = makeCheck();
const { check } = t;
const SQL = fs.readFileSync(new URL('../migrations/0046_google_avatar.sql', import.meta.url), 'utf8');
const GOOGLE = 'https://lh3.googleusercontent.com/a/g1=s96-c';
const UPLOAD = '/api/avatars/0123456789abcdef0123456789abcdef';

function seed(d1) {
  const user = (id, name, handle, avatar, optIn = 1) => d1.prepare(`INSERT INTO users (id, display_name, handle, avatar_url, profile_visibility, leaderboard_opt_in, bio) VALUES (?, ?, ?, ?, 'public', ?, ?)`).bind(id, name, handle, avatar, optIn, `bio of ${id}`)._exec();
  user('google', 'Gail Google', 'gail', GOOGLE);
  user('upload', 'Uma Upload', 'uma', UPLOAD);
  user('none', 'Nora None', 'nora', null);
  user('private', 'Pete Private', 'pete', 'https://lh3.googleusercontent.com/a/p=s96-c', 0);
  user('nohandle', null, null, null);
  d1.exec(`INSERT INTO user_xp (user_id, xp) VALUES ('google', 1200), ('upload', 300), ('private', 50)`);
  let n = 0;
  for (const u of ['google', 'upload', 'private']) for (let d = 1; d <= 3; d++) {
    const id = `m-${++n}`;
    d1.prepare(`INSERT INTO submissions (id, user_id, submission_type, status, submitted_at, evidence_type) VALUES (?, ?, 'vehicle_sighting', 'approved', ?, 'photo')`).bind(id, u, `2026-10-0${d} 16:00:00`)._exec();
    d1.prepare(`INSERT INTO vehicle_observations (id, submission_id, user_id, service_area) VALUES (?, ?, ?, 'Austin')`).bind(`mo-${n}`, id, u)._exec();
  }
  d1.prepare(`INSERT INTO community_summary (key, value, computed_at) VALUES ('leaderboard', ?, '2026-10-21T11:00:00.000Z')`).bind(JSON.stringify({ v: { metrics: [{ uid: 'google', display_name: 'Gail Google', xp: 1200 }] } }))._exec();
}

// Every table's rows (users without the new column), in a stable order.
function dump(d1) {
  const tables = d1.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).map(r => r.name);
  const out = {};
  for (const name of tables) {
    const cols = d1.query(`PRAGMA table_info(${name})`).map(c => c.name).filter(c => !(name === 'users' && c === 'google_avatar_url'));
    out[name] = d1.query(`SELECT ${cols.map(c => `"${c}"`).join(', ')} FROM ${name} ORDER BY ${cols.map(c => `"${c}"`).join(', ')}`);
  }
  return JSON.stringify(out);
}
const row = (d1, id) => d1.query('SELECT avatar_url, google_avatar_url FROM users WHERE id = ?', id)[0];
const usersSchema = d1 => JSON.stringify(d1.query('PRAGMA table_info(users)').map(c => [c.name, c.type, c.notnull, c.dflt_value]));

console.log('Migration 0046 on the current production schema (0001-0045)');
{
  const d1 = createTestD1({ migrateThrough: '0045_social_saves_notifications_pins.sql' });
  check('the starting schema has no google_avatar_url (as in production today)', !d1.query('PRAGMA table_info(users)').some(c => c.name === 'google_avatar_url'));
  seed(d1);
  const before = dump(d1);
  d1.exec(SQL);
  check('the column exists after the migration', d1.query('PRAGMA table_info(users)').some(c => c.name === 'google_avatar_url' && c.type === 'TEXT' && c.notnull === 0));
  check('every other column of every table is unchanged (names, usernames, bios, privacy, pictures, XP, sightings, stored leaderboard)', dump(d1) === before);
  check('a shown Google picture is recorded as the Google picture', row(d1, 'google').google_avatar_url === GOOGLE && row(d1, 'google').avatar_url === GOOGLE);
  check('a private rider\'s Google picture too (privacy is unchanged; nothing is made public)', row(d1, 'private').google_avatar_url === 'https://lh3.googleusercontent.com/a/p=s96-c' && d1.query(`SELECT leaderboard_opt_in FROM users WHERE id = 'private'`)[0].leaderboard_opt_in === 0);
  check('an upload stays the shown picture and is NOT recorded as Google', row(d1, 'upload').avatar_url === UPLOAD && row(d1, 'upload').google_avatar_url === null);
  check('riders without a picture: both empty', row(d1, 'none').avatar_url === null && row(d1, 'none').google_avatar_url === null && row(d1, 'nohandle').google_avatar_url === null);
  const backfill = SQL.slice(SQL.indexOf('UPDATE users'));
  d1.exec(backfill);
  check('the backfill is idempotent', dump(d1) === before && row(d1, 'google').google_avatar_url === GOOGLE);
  check('the result is the schema the new Worker is tested against', usersSchema(d1) === usersSchema(createTestD1()));
  let reapplied = null;
  try { d1.exec(SQL); reapplied = 'ran'; } catch (e) { reapplied = String(e.message); }
  check('applying it twice fails at once on ADD COLUMN (wrangler records it, so it never re-runs)', /duplicate column/i.test(reapplied));
  check('...and that failed second run changed nothing', dump(d1) === before);
}

console.log('Statement-level safety');
{
  const statements = SQL.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').split(';').map(s => s.trim()).filter(Boolean);
  check('exactly two statements: ADD COLUMN and one UPDATE', statements.length === 2 && /^ALTER TABLE users ADD COLUMN google_avatar_url TEXT$/.test(statements[0]) && /^UPDATE users SET google_avatar_url = avatar_url/.test(statements[1]));
  check('the UPDATE writes only the new column, only where it is empty, only from an https URL', /SET google_avatar_url = avatar_url\s+WHERE google_avatar_url IS NULL AND avatar_url LIKE 'https:\/\/%'$/.test(statements[1]));
  check('no DROP, DELETE, or write to any other column', !/\bDROP\b|\bDELETE\b|SET\s+(?!google_avatar_url)/i.test(statements.join(';')));
}

t.finish();
