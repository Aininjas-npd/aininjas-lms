// Disk housekeeping for the data volume.
//
// Two jobs:
//   usage()      what is on /data and how much room is left, for the admin dashboard
//   sweepTemp()  delete abandoned upload temp files (a cancelled or timed-out SCORM upload
//                leaves multer's temp file behind, because the route never runs)
//
// Railway gives no shell, so without this a full volume is invisible until uploads start
// failing with ENOSPC.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./db');

const TMP_DIR = path.join(DATA_DIR, 'uploads');
const STALE_HOURS = 6;

const human = n => {
  if (!Number.isFinite(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
};

/** Total bytes under a directory (best effort — unreadable entries are skipped). */
function dirSize(dir) {
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSize(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    } catch { /* vanished mid-walk */ }
  }
  return total;
}

/** What is on the volume, biggest first, plus free space. */
function usage() {
  let free = NaN, total = NaN;
  try { const s = fs.statfsSync(DATA_DIR); free = s.bavail * s.bsize; total = s.blocks * s.bsize; }
  catch { /* statfs not available on this platform */ }

  const items = [];
  try {
    for (const e of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
      const p = path.join(DATA_DIR, e.name);
      const bytes = e.isDirectory() ? dirSize(p) : (() => { try { return fs.statSync(p).size; } catch { return 0; } })();
      items.push({ name: e.name, dir: e.isDirectory(), bytes, human: human(bytes) });
    }
  } catch { /* no data dir */ }
  items.sort((a, b) => b.bytes - a.bytes);

  const used = Number.isFinite(total) && Number.isFinite(free) ? total - free : items.reduce((a, i) => a + i.bytes, 0);
  const pct = Number.isFinite(total) && total > 0 ? Math.round(100 * used / total) : null;
  return {
    dir: DATA_DIR, items,
    free, total, used,
    freeHuman: human(free), totalHuman: human(total), usedHuman: human(used),
    pct,
    tight: Number.isFinite(free) ? free < 200 * 1024 * 1024 : false,     // under 200 MB left
    stale: staleTemp().length
  };
}

/** Upload temp files older than STALE_HOURS — multer leaves these when a request is aborted. */
function staleTemp() {
  const cut = Date.now() - STALE_HOURS * 3600 * 1000;
  let out = [];
  try {
    for (const e of fs.readdirSync(TMP_DIR, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      const p = path.join(TMP_DIR, e.name);
      try { const s = fs.statSync(p); if (s.mtimeMs < cut) out.push({ path: p, bytes: s.size }); } catch { /* gone */ }
    }
  } catch { /* no uploads dir yet */ }
  return out;
}

/** Delete those temp files. Returns what it reclaimed. */
function sweepTemp() {
  const files = staleTemp();
  let bytes = 0, n = 0;
  for (const f of files) {
    try { fs.rmSync(f.path, { force: true }); bytes += f.bytes; n++; } catch { /* in use */ }
  }
  return { files: n, bytes, human: human(bytes) };
}

/** Sweep now, then every 6 hours. */
function start() {
  const run = () => {
    const r = sweepTemp();
    if (r.files) console.log(`[storage] cleared ${r.files} abandoned upload temp file(s), ${r.human} reclaimed`);
    const u = usage();
    if (u.tight) console.warn(`[storage] only ${u.freeHuman} free on ${u.dir} — uploads will fail with ENOSPC. Grow the volume or remove old courses.`);
  };
  run();
  setInterval(run, 6 * 3600 * 1000).unref();
}

module.exports = { usage, sweepTemp, staleTemp, start, human, dirSize };
