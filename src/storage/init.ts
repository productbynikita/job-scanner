/**
 * Initialize the database — run once via `npm run init:db` or automatically
 * the first time the scanner runs.
 */

import { getDb, closeDb } from './db.js';

const db = getDb();
console.log('Database initialized at', db.name);
console.log('Tables:');
const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
  name: string;
}>;
for (const t of tables) {
  console.log('  -', t.name);
}
closeDb();
