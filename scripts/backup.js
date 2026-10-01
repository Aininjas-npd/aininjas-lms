#!/usr/bin/env node
/* One backup, now: node scripts/backup.js   (same BACKUP_* variables as the nightly job; prints the object key) */
try { require('dotenv').config(); } catch {}   // local .env when present (Railway injects variables directly)
const { db, DATA_DIR } = require('../src/db');
require('../src/backup').runBackup({ db, dataDir: DATA_DIR, dbFile: 'lms.sqlite', service: 'lms' })
  .then(r => { console.log(r.skipped ? 'skipped: ' + r.reason : 'done: ' + r.key); process.exit(0); })
  .catch(e => { console.error(e.message); process.exit(1); });
