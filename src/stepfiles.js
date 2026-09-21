'use strict';
/*
 * Files attached to a learning-path step — the CSVs, JSON, images and zips a notebook needs, a
 * worksheet, a teacher's answer set.
 *
 * They hang off a step rather than the course, so:
 *   - they appear exactly where they are needed ("download these, then upload them to Colab"),
 *   - and the step's audience decides who may have them. Attach the answer key to a
 *     teachers-only step and no learner can reach it, by link or otherwise.
 *
 * Stored under DATA_DIR/stepfiles/<random>.<ext> with the original name kept in the row, so two
 * courses can both have a "data.csv" without colliding, and a filename from a browser can never
 * steer the write.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, DATA_DIR } = require('./db');

const DIR = path.join(DATA_DIR, 'stepfiles');
fs.mkdirSync(DIR, { recursive: true });

db.exec(`
CREATE TABLE IF NOT EXISTS step_files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id    INTEGER NOT NULL REFERENCES path_steps(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,          -- what the person sees and downloads
  stored     TEXT NOT NULL,          -- basename on disk
  bytes      INTEGER NOT NULL DEFAULT 0,
  note       TEXT,                   -- optional "what this is"
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_step_files_step ON step_files(step_id);
`);

/* What a class actually needs alongside a notebook. Anything executable that a browser might run
   if it were ever served inline (.html, .svg, .js) is deliberately absent. */
const ALLOWED = new Set(['.csv', '.tsv', '.json', '.jsonl', '.txt', '.md', '.xlsx', '.xls', '.parquet',
  '.zip', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.ipynb', '.py', '.wav', '.mp3', '.mp4']);
const MAX_BYTES = 100 * 1024 * 1024;

const human = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

const forStep = stepId => db.prepare('SELECT * FROM step_files WHERE step_id=? ORDER BY sort_order, id').all(stepId)
  .map(r => ({ ...r, human: human(r.bytes) }));

/** Files for many steps at once, as { [stepId]: [file, …] }. */
function forSteps(stepIds) {
  const out = {};
  if (!stepIds.length) return out;
  const marks = stepIds.map(() => '?').join(',');
  for (const r of db.prepare(`SELECT * FROM step_files WHERE step_id IN (${marks}) ORDER BY sort_order, id`).all(...stepIds)) {
    (out[r.step_id] = out[r.step_id] || []).push({ ...r, human: human(r.bytes) });
  }
  return out;
}

const byId = (stepId, fileId) => db.prepare('SELECT * FROM step_files WHERE id=? AND step_id=?').get(fileId, stepId);
const diskPath = row => path.join(DIR, path.basename(row.stored));

/** Take an uploaded file (multer, disk storage) and attach it to a step. */
function attach(stepId, upload, { note } = {}) {
  const original = String(upload.originalname || 'file');
  const ext = path.extname(original).toLowerCase();
  const clean = () => { try { fs.rmSync(upload.path, { force: true }); } catch {} };

  if (!ALLOWED.has(ext)) { clean(); throw new Error(`${original}: ${ext || 'that type'} is not an allowed data file. Allowed: ${[...ALLOWED].join(' ')}`); }
  if (upload.size > MAX_BYTES) { clean(); throw new Error(`${original} is ${human(upload.size)} — the limit for a data file is ${human(MAX_BYTES)}.`); }

  const stored = crypto.randomBytes(8).toString('hex') + ext;
  fs.renameSync(upload.path, path.join(DIR, stored));
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM step_files WHERE step_id=?').get(stepId).m;
  const id = db.prepare('INSERT INTO step_files (step_id, filename, stored, bytes, note, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
    .run(stepId, original.replace(/[\\/]/g, '_').slice(0, 200), stored, upload.size, String(note || '').trim().slice(0, 300) || null, max + 1).lastInsertRowid;
  return db.prepare('SELECT * FROM step_files WHERE id=?').get(id);
}

function remove(stepId, fileId) {
  const row = byId(stepId, fileId);
  if (!row) return false;
  try { fs.rmSync(diskPath(row), { force: true }); } catch { /* already gone */ }
  db.prepare('DELETE FROM step_files WHERE id=?').run(row.id);
  return true;
}

/** Copy a step's files when a course is versioned (each version owns its own copies). */
function copyToStep(fromStepId, toStepId) {
  for (const r of db.prepare('SELECT * FROM step_files WHERE step_id=? ORDER BY sort_order, id').all(fromStepId)) {
    const ext = path.extname(r.stored);
    const stored = crypto.randomBytes(8).toString('hex') + ext;
    try { fs.copyFileSync(path.join(DIR, r.stored), path.join(DIR, stored)); } catch { continue; }
    db.prepare('INSERT INTO step_files (step_id, filename, stored, bytes, note, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
      .run(toStepId, r.filename, stored, r.bytes, r.note, r.sort_order);
  }
}

module.exports = { forStep, forSteps, byId, diskPath, attach, remove, copyToStep, ALLOWED, MAX_BYTES, human, DIR };
