#!/usr/bin/env node
/* Restore DATA_DIR from a backup. Usage:
     node scripts/restore.js list              show the backups in the bucket
     node scripts/restore.js latest --yes      restore the newest one into DATA_DIR
     node scripts/restore.js <key> --yes       restore a specific one
   Stop the app first (or restart it right after): the restore replaces the database file and everything under DATA_DIR
   that the backup contains. On Railway: open a shell on the service (railway ssh), run this, then redeploy/restart. */
try { require('dotenv').config(); } catch {}   // local .env when present (Railway injects variables directly)
const path = require('path');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const backup = require('../src/backup');
const [cmd, ...rest] = process.argv.slice(2);
(async () => {
  if (!cmd || cmd === 'list') {
    const all = await backup.listBackups('lms');
    if (!all.length) console.log('no backups found');
    for (const b of all) console.log(b.modified ? b.modified.toISOString() : '?', String(b.size).padStart(10), b.key);
    return;
  }
  if (!rest.includes('--yes')) { console.error('Add --yes to confirm: this overwrites ' + DATA_DIR); process.exit(2); }
  await backup.restore({ dataDir: DATA_DIR, dbFile: 'lms.sqlite', service: 'lms', key: cmd });
})().catch(e => { console.error(e.message); process.exit(1); });
