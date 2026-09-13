// SQLite database layer (better-sqlite3). Single file, zero external services.
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'courses'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const db = new Database(path.join(DATA_DIR, 'lms.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT,                       -- NULL for Google-only accounts
  google_id     TEXT UNIQUE,
  role          TEXT NOT NULL DEFAULT 'learner',   -- learner | admin
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | disabled
  organization  TEXT,                       -- school / company (free text from the request form)
  request_note  TEXT,                       -- "why do you want access"
  display_handle TEXT,                      -- shown on leaderboard instead of real name
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at   TEXT
);

CREATE TABLE IF NOT EXISTS courses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT UNIQUE NOT NULL,       -- folder name under data/courses
  title         TEXT NOT NULL,
  description   TEXT,
  version       TEXT,                       -- schemaversion from manifest (e.g. "1.2")
  manifest_json TEXT NOT NULL,              -- parsed organization tree
  is_published  INTEGER NOT NULL DEFAULT 1,
  open_enrollment INTEGER NOT NULL DEFAULT 0, -- 1 = any approved learner may self-enroll
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id     INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  identifier    TEXT NOT NULL,              -- item identifier from manifest
  title         TEXT NOT NULL,
  launch_href   TEXT NOT NULL,              -- relative path inside course folder
  sort_order    INTEGER NOT NULL,
  mastery_score REAL,                       -- adlcp:masteryscore
  max_time_allowed TEXT,
  data_from_lms TEXT,
  UNIQUE(course_id, identifier)
);

CREATE TABLE IF NOT EXISTS enrollments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id     INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'requested', -- requested | active | revoked
  enrolled_at   TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT,
  UNIQUE(user_id, course_id)
);

-- One row per (user, SCO): the persisted SCORM 1.2 CMI data model.
CREATE TABLE IF NOT EXISTS sco_progress (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sco_id        INTEGER NOT NULL REFERENCES scos(id) ON DELETE CASCADE,
  lesson_status TEXT NOT NULL DEFAULT 'not attempted', -- passed|completed|failed|incomplete|browsed|not attempted
  lesson_location TEXT DEFAULT '',
  suspend_data  TEXT DEFAULT '',
  score_raw     REAL,
  score_min     REAL,
  score_max     REAL,
  total_time    TEXT NOT NULL DEFAULT '0000:00:00.00',
  total_seconds INTEGER NOT NULL DEFAULT 0,
  entry         TEXT NOT NULL DEFAULT 'ab-initio',  -- ab-initio | resume | ''
  exit_mode     TEXT DEFAULT '',
  cmi_json      TEXT,                       -- full CMI snapshot (interactions, objectives, etc.)
  attempts      INTEGER NOT NULL DEFAULT 0,
  first_launched_at TEXT,
  last_accessed_at TEXT,
  completed_at  TEXT,
  UNIQUE(user_id, sco_id)
);

-- Append-only event log (drives analytics + plugins such as the leaderboard).
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER,
  course_id     INTEGER,
  sco_id        INTEGER,
  type          TEXT NOT NULL,   -- launch | commit | complete | pass | fail | score | enroll | approve ...
  payload       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

-- Key/value store for plugins and app settings.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// ---- migrations (safe to re-run) ----
const ucols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
if (!ucols.includes('sso_sub')) db.exec('ALTER TABLE users ADD COLUMN sso_sub TEXT');
if (!ucols.includes('last_login_at')) db.exec('ALTER TABLE users ADD COLUMN last_login_at TEXT');
if (!ucols.includes('class_name')) db.exec('ALTER TABLE users ADD COLUMN class_name TEXT');
if (!ucols.includes('school_slug')) db.exec('ALTER TABLE users ADD COLUMN school_slug TEXT');   // school co-branding (slug from Quiz Studio)
if (!ucols.includes('classes')) db.exec("ALTER TABLE users ADD COLUMN classes TEXT NOT NULL DEFAULT '[]'");   // teacher: JSON list of the classes they may see
const ccols = db.prepare('PRAGMA table_info(courses)').all().map(c => c.name);
if (!ccols.includes('sequential')) db.exec('ALTER TABLE courses ADD COLUMN sequential INTEGER NOT NULL DEFAULT 0');   // 1 = steps must be completed in order
const scols = db.prepare('PRAGMA table_info(scos)').all().map(c => c.name);
if (!scols.includes('package')) db.exec("ALTER TABLE scos ADD COLUMN package TEXT");           // sub-folder of the package this SCO came from ('' = course root)
if (!scols.includes('package_title')) db.exec("ALTER TABLE scos ADD COLUMN package_title TEXT");

// ---- Seed the first admin from env ----
function seedAdmin() {
  const email = (process.env.ADMIN_EMAIL || 'admin@aininjas.com').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!existing) {
    db.prepare(`INSERT INTO users (email, name, password_hash, role, status, approved_at, display_handle)
                VALUES (?, ?, ?, 'admin', 'approved', datetime('now'), 'Sensei')`)
      .run(email, process.env.ADMIN_NAME || 'AI Ninjas Admin', bcrypt.hashSync(password, 10));
    console.log(`[db] Seeded admin account: ${email}`);
  }
}
seedAdmin();

// ---- Small helpers used across routes ----
const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByGoogleId: db.prepare('SELECT * FROM users WHERE google_id = ?'),
  courses: db.prepare('SELECT * FROM courses ORDER BY created_at DESC'),
  courseById: db.prepare('SELECT * FROM courses WHERE id = ?'),
  courseBySlug: db.prepare('SELECT * FROM courses WHERE slug = ?'),
  scosForCourse: db.prepare('SELECT * FROM scos WHERE course_id = ? ORDER BY sort_order'),
  scoById: db.prepare('SELECT * FROM scos WHERE id = ?'),
  enrollment: db.prepare('SELECT * FROM enrollments WHERE user_id = ? AND course_id = ?'),
  progress: db.prepare('SELECT * FROM sco_progress WHERE user_id = ? AND sco_id = ?'),
  progressForCourse: db.prepare(`
     SELECT p.*, s.id AS sco_id, s.title, s.identifier, s.sort_order, s.mastery_score
     FROM scos s LEFT JOIN sco_progress p ON p.sco_id = s.id AND p.user_id = ?
     WHERE s.course_id = ? ORDER BY s.sort_order`),
  logEvent: db.prepare('INSERT INTO events (user_id, course_id, sco_id, type, payload) VALUES (?, ?, ?, ?, ?)'),
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
};

/** Course-level completion summary for a user. */
function courseSummary(userId, courseId) {
  const rows = q.progressForCourse.all(userId, courseId);
  const total = rows.length;
  const done = rows.filter(r => ['completed', 'passed'].includes(r.lesson_status)).length;
  const started = rows.filter(r => r.first_launched_at).length;
  const scores = rows.filter(r => r.score_raw != null).map(r => r.score_raw);
  const seconds = rows.reduce((a, r) => a + (r.total_seconds || 0), 0);
  return {
    total, done, started, seconds,
    percent: total ? Math.round((done / total) * 100) : 0,
    avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    status: total && done === total ? 'completed' : started ? 'in_progress' : 'not_started',
    rows,
  };
}

module.exports = { db, q, DATA_DIR, courseSummary };
