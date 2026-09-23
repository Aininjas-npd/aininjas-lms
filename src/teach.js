'use strict';
/*
 * Teaching a course to a class.
 *
 * A teacher stands at the front, opens the lesson on the projector, gets through four slides, and
 * the bell goes. Next week she needs to carry on from slide five — with THAT class. The class
 * after lunch is three slides behind, and the same teacher is teaching them the same course.
 *
 * So the place a lesson was left is a property of the CLASS, not of the teacher and not of any
 * student:
 *
 *   sco_progress    (user, sco)             a student's own work, and a teacher's own if she
 *                                           opens a course as herself. Untouched by teaching.
 *   class_lessons   (school, class, sco)    where the class got to when it was taught together
 *
 * Keying on the class rather than the teacher means a cover teacher picks up exactly where the
 * regular one stopped, which is the whole point of writing it down. `last_taught_by` records who
 * ran it, so the class page can say "you", or name a colleague.
 *
 * Nothing here touches a student's record. Projecting a lesson has never marked it done for the
 * class — students complete it themselves, at home or on their own machine — and that stays true.
 */
const { db, q } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS class_lessons (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  school_slug    TEXT NOT NULL,
  class_name     TEXT NOT NULL,
  course_id      INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  sco_id         INTEGER NOT NULL REFERENCES scos(id) ON DELETE CASCADE,
  lesson_status  TEXT NOT NULL DEFAULT 'not attempted',
  lesson_location TEXT DEFAULT '',
  suspend_data   TEXT DEFAULT '',
  total_seconds  INTEGER NOT NULL DEFAULT 0,
  exit_mode      TEXT DEFAULT '',
  cmi_json       TEXT,
  times_taught   INTEGER NOT NULL DEFAULT 0,
  last_taught_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  first_taught_at TEXT,
  last_taught_at TEXT,
  UNIQUE(school_slug, class_name, sco_id)
);
/* Steps that are not a SCORM lesson — a Colab, a quiz run live, a note — are simply ticked off as
   covered in class, with no runtime behind them. */
CREATE TABLE IF NOT EXISTS class_steps (
  school_slug    TEXT NOT NULL,
  class_name     TEXT NOT NULL,
  step_id        INTEGER NOT NULL REFERENCES path_steps(id) ON DELETE CASCADE,
  covered_at     TEXT NOT NULL DEFAULT (datetime('now')),
  covered_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (school_slug, class_name, step_id)
);
CREATE INDEX IF NOT EXISTS idx_class_lessons_course ON class_lessons(school_slug, class_name, course_id);
`);

const DONE = new Set(['completed', 'passed']);

const rowFor = (school, className, scoId) => db.prepare(
  'SELECT * FROM class_lessons WHERE school_slug=? AND class_name=? AND sco_id=?').get(school, className, scoId) || null;

/** The class's row for this lesson, created on first use. */
function open(school, className, courseId, scoId, byUserId) {
  let r = rowFor(school, className, scoId);
  if (!r) {
    db.prepare(`INSERT INTO class_lessons (school_slug, class_name, course_id, sco_id, first_taught_at, last_taught_at, times_taught, last_taught_by)
                VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), 1, ?)`)
      .run(school, className, courseId, scoId, byUserId || null);
    r = rowFor(school, className, scoId);
  } else {
    db.prepare(`UPDATE class_lessons SET times_taught = times_taught + 1, last_taught_at = datetime('now'), last_taught_by=? WHERE id=?`)
      .run(byUserId || null, r.id);
    r = db.prepare('SELECT * FROM class_lessons WHERE id=?').get(r.id);
  }
  return r;
}

/**
 * The same entry rule the student player uses: a lesson stopped part-way resumes, a finished one
 * starts clean, a fresh one is ab-initio. This is what makes "carry on from slide five" work.
 */
function entryFor(r) {
  if (!r) return 'ab-initio';
  if (r.exit_mode === 'suspend' || r.lesson_status === 'incomplete' || r.lesson_status === 'browsed') return 'resume';
  return r.first_taught_at && r.lesson_status !== 'not attempted' ? '' : 'ab-initio';
}

const coveredSteps = (school, className) => new Set(db.prepare(
  'SELECT step_id FROM class_steps WHERE school_slug=? AND class_name=?').all(school, className).map(r => r.step_id));

function markStep(school, className, stepId, byUserId) {
  db.prepare(`INSERT INTO class_steps (school_slug, class_name, step_id, covered_by) VALUES (?, ?, ?, ?)
              ON CONFLICT(school_slug, class_name, step_id) DO UPDATE SET covered_at=datetime('now'), covered_by=excluded.covered_by`)
    .run(school, className, stepId, byUserId || null);
}
const unmarkStep = (school, className, stepId) =>
  db.prepare('DELETE FROM class_steps WHERE school_slug=? AND class_name=? AND step_id=?').run(school, className, stepId);

/**
 * The class's way through one course: every step, whether it has been taught, and where to pick up.
 *
 * `next` is the first step not yet covered — the one the Resume button goes to. A lesson stopped
 * part-way counts as not covered, so Resume returns to it rather than skipping ahead.
 */
function courseProgress(school, className, courseId, viewer) {
  const pathLib = require('./path');
  const steps = pathLib.stepsFor(courseId);
  const covered = coveredSteps(school, className);

  const items = steps.map(st => {
    if (st.type === 'sco') {
      const scoId = st.config && st.config.sco_id;
      const r = scoId ? rowFor(school, className, scoId) : null;
      const done = !!(r && DONE.has(r.lesson_status));
      return {
        step: st, kind: 'sco', scoId,
        started: !!r, done,
        partway: !!(r && !done && r.lesson_status !== 'not attempted'),
        status: r ? r.lesson_status : 'not attempted',
        lastTaughtAt: r ? r.last_taught_at : null,
        lastTaughtBy: r && r.last_taught_by ? (q.userById ? q.userById.get(r.last_taught_by) : null) : null,
        timesTaught: r ? r.times_taught : 0,
      };
    }
    const done = covered.has(st.id);
    return { step: st, kind: st.type, started: done, done, partway: false, status: done ? 'covered' : 'not attempted' };
  });

  const total = items.length;
  const doneCount = items.filter(i => i.done).length;
  const next = items.find(i => !i.done) || null;
  return {
    items, total, done: doneCount,
    percent: total ? Math.round(100 * doneCount / total) : 0,
    next,
    started: items.some(i => i.started),
    viewer: viewer || null,
  };
}

/** Every course this class has been given, with how far the class has been taught through each. */
function coursesFor(school, className) {
  const rows = db.prepare(`
    SELECT DISTINCT c.* FROM courses c
    JOIN enrollments e ON e.course_id = c.id
    JOIN users u ON u.id = e.user_id
    WHERE u.school_slug=? AND u.class_name=? AND u.role='learner' AND e.status='active'
    ORDER BY c.title COLLATE NOCASE`).all(school, className);

  /* A course the class is taught from but nobody is enrolled in (a teacher-only pack, say) still
     belongs here once someone has started teaching it. */
  const taught = db.prepare(`
    SELECT DISTINCT c.* FROM courses c JOIN class_lessons cl ON cl.course_id = c.id
    WHERE cl.school_slug=? AND cl.class_name=?`).all(school, className);
  for (const t of taught) if (!rows.some(r => r.id === t.id)) rows.push(t);

  return rows.map(c => ({ course: c, progress: courseProgress(school, className, c.id) }));
}

module.exports = { open, rowFor, entryFor, courseProgress, coursesFor, coveredSteps, markStep, unmarkStep, DONE };
