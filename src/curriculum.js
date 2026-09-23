'use strict';
/*
 * Curricula — a named, ordered list of courses that a grade is given.
 *
 * A course is a container of steps; a curriculum is the level above: "Level 1 for Grade 8" is
 * Foundations Challenge → Python for AI → The Disciple → The Predictor, in that order. One course
 * can sit in any number of curricula, because most of them share the early material.
 *
 * ── Why inheritance ────────────────────────────────────────────────────────────────────────────
 *
 * The awkward case is that a grade's content depends on when the school started. In a school's
 * first year, Grade 9 does Level 1 *and* Pattern Apprentice, because they are starting from
 * nothing. The next year, that Grade 9 did Level 1 while they were in Grade 8, so their year is
 * only the new material. Same grade, different content.
 *
 * So a curriculum may EXTEND another: it inherits that one's courses, in order, and adds its own
 * after them.
 *
 *     Grade 8                     Foundations · Python for AI · Disciple · Predictor
 *     Grade 9 (2026 intake)       extends Grade 8, adds Pattern Apprentice
 *     Grade 9 (2027 onwards)      Pattern Apprentice · Controller
 *
 * Inheritance is resolved on read rather than copied, so correcting the Grade 8 list corrects
 * every curriculum built on it. A course that appears twice through two routes is kept once, at
 * its earliest position — that is what makes "all of Grade 8, plus one more" behave the way an
 * admin reading the screen expects.
 *
 * ── Why the enrolment lives elsewhere ──────────────────────────────────────────────────────────
 *
 * Applying a curriculum to a class does not enrol anyone directly. It resolves to a list of course
 * ids and hands them to enrol.js, which already knows how to preview a batch, exclude individual
 * students, schedule a start and end date, and end the batch later. One enrolment path, one place
 * where the rules about dates and exclusions live.
 */
const { db, q } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS curricula (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT UNIQUE NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT,
  extends_id    INTEGER REFERENCES curricula(id) ON DELETE SET NULL,  -- inherits this one's courses first
  school_slug   TEXT,                                   -- NULL = a template every school may use
  sequential    INTEGER NOT NULL DEFAULT 1,             -- 1 = a course opens only when the one before it is done
  is_published  INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS curriculum_courses (
  curriculum_id INTEGER NOT NULL REFERENCES curricula(id) ON DELETE CASCADE,
  course_id     INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  required      INTEGER NOT NULL DEFAULT 1,             -- 0 = enrichment; never blocks what follows
  PRIMARY KEY (curriculum_id, course_id)
);
-- Which curriculum is suggested for a grade. academic_year '' means "unless a later year says otherwise".
CREATE TABLE IF NOT EXISTS curriculum_grades (
  school_slug   TEXT NOT NULL,
  grade         TEXT NOT NULL,                          -- the class name as the school writes it, e.g. "Grade 8"
  academic_year TEXT NOT NULL DEFAULT '',
  curriculum_id INTEGER NOT NULL REFERENCES curricula(id) ON DELETE CASCADE,
  PRIMARY KEY (school_slug, grade, academic_year)
);
-- Which schools may use a curriculum. NO rows at all = every school, exactly as courses behave.
CREATE TABLE IF NOT EXISTS curriculum_schools (
  curriculum_id INTEGER NOT NULL REFERENCES curricula(id) ON DELETE CASCADE,
  school_slug   TEXT NOT NULL,
  PRIMARY KEY (curriculum_id, school_slug)
);
CREATE INDEX IF NOT EXISTS idx_curriculum_courses_c ON curriculum_courses(curriculum_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_curricula_extends ON curricula(extends_id);
`);

const slugify = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'curriculum';

/* ------------------------------------------------------------------ § crud -- */

const byId = id => db.prepare('SELECT * FROM curricula WHERE id=?').get(id) || null;
const bySlug = slug => db.prepare('SELECT * FROM curricula WHERE slug=?').get(slug) || null;

/* ---------------------------------------------------------- § availability -- */
/*
 * Who may use a curriculum, on the same footing as a course.
 *
 * A curriculum belongs to one school (school_slug) or to nobody, in which case it is a template.
 * A template is not automatically everybody's: `curriculum_schools` narrows it, and no rows at all
 * means every school — the way course_schools already works, so nothing that exists today changes
 * meaning when this ships.
 */
const schoolsFor = curriculumId => db.prepare(
  'SELECT school_slug FROM curriculum_schools WHERE curriculum_id=? ORDER BY school_slug').all(curriculumId).map(r => r.school_slug);

function setSchoolsFor(curriculumId, slugs) {
  db.transaction(() => {
    db.prepare('DELETE FROM curriculum_schools WHERE curriculum_id=?').run(curriculumId);
    const ins = db.prepare('INSERT OR IGNORE INTO curriculum_schools (curriculum_id, school_slug) VALUES (?, ?)');
    for (const s of slugs) if (s) ins.run(curriculumId, s);
  })();
}

/** May this school use it? Its own always; a template only if unrestricted or named. */
function openTo(curriculumId, schoolSlug) {
  const c = byId(curriculumId);
  if (!c) return false;
  if (c.school_slug) return !!schoolSlug && c.school_slug === schoolSlug;
  const rows = schoolsFor(curriculumId);
  return rows.length === 0 || (!!schoolSlug && rows.includes(schoolSlug));
}

/** Every curriculum, or only the ones a school may actually use. */
function list(schoolSlug) {
  const all = db.prepare('SELECT * FROM curricula ORDER BY title COLLATE NOCASE').all();
  return schoolSlug ? all.filter(c => openTo(c.id, schoolSlug)) : all;
}

/** What a teacher or school admin may enrol from: published, and offered to their school. */
const forSchool = schoolSlug => list(schoolSlug).filter(c => c.is_published);

function create({ title, description, extendsId, schoolSlug, sequential = 1 }) {
  const t = String(title || '').trim();
  if (!t) throw new Error('A curriculum needs a name.');
  if (extendsId && !byId(extendsId)) throw new Error('The curriculum it extends no longer exists.');
  let slug = slugify(t), n = 1;
  while (bySlug(slug)) slug = `${slugify(t)}-${++n}`;
  const info = db.prepare(`INSERT INTO curricula (slug, title, description, extends_id, school_slug, sequential)
                           VALUES (?, ?, ?, ?, ?, ?)`)
    .run(slug, t, String(description || '').trim() || null, extendsId || null, schoolSlug || null, sequential ? 1 : 0);
  return byId(info.lastInsertRowid);
}

function update(id, { title, description, extendsId, sequential, isPublished, schoolSlug }) {
  const c = byId(id);
  if (!c) throw new Error('Curriculum not found.');
  if (extendsId !== undefined && extendsId) {
    if (Number(extendsId) === Number(id)) throw new Error('A curriculum cannot extend itself.');
    if (!byId(extendsId)) throw new Error('The curriculum it extends no longer exists.');
    // Walking up from the proposed parent must not lead back here.
    let hop = byId(extendsId), guard = 0;
    while (hop && hop.extends_id && guard++ < 64) {
      if (Number(hop.extends_id) === Number(id)) {
        throw new Error(`That would make a loop: "${byId(extendsId).title}" already builds on "${c.title}".`);
      }
      hop = byId(hop.extends_id);
    }
  }
  db.prepare(`UPDATE curricula SET title=COALESCE(?, title), description=COALESCE(?, description),
              extends_id=?, school_slug=?, sequential=COALESCE(?, sequential), is_published=COALESCE(?, is_published) WHERE id=?`)
    .run(title === undefined ? null : String(title).trim(),
      description === undefined ? null : String(description).trim() || null,
      extendsId === undefined ? c.extends_id : (extendsId || null),
      schoolSlug === undefined ? c.school_slug : (schoolSlug || null),
      sequential === undefined ? null : (sequential ? 1 : 0),
      isPublished === undefined ? null : (isPublished ? 1 : 0), id);
  return byId(id);
}

function remove(id) {
  const kids = db.prepare('SELECT title FROM curricula WHERE extends_id=?').all(id);
  if (kids.length) throw new Error(`${kids.map(k => `"${k.title}"`).join(', ')} build${kids.length === 1 ? 's' : ''} on this one. Point ${kids.length === 1 ? 'it' : 'them'} elsewhere first.`);
  db.prepare('DELETE FROM curricula WHERE id=?').run(id);
}

/* --------------------------------------------------------------- § courses -- */

/** Add a course at the end, or move it if it is already there. */
function addCourse(curriculumId, courseId, { required = 1 } = {}) {
  if (!q.courseById.get(courseId)) throw new Error('Course not found.');
  const next = (db.prepare('SELECT MAX(sort_order) m FROM curriculum_courses WHERE curriculum_id=?').get(curriculumId).m ?? -1) + 1;
  db.prepare(`INSERT INTO curriculum_courses (curriculum_id, course_id, sort_order, required) VALUES (?, ?, ?, ?)
              ON CONFLICT(curriculum_id, course_id) DO UPDATE SET required=excluded.required`)
    .run(curriculumId, courseId, next, required ? 1 : 0);
}

const removeCourse = (curriculumId, courseId) =>
  db.prepare('DELETE FROM curriculum_courses WHERE curriculum_id=? AND course_id=?').run(curriculumId, courseId);

/** Reorder this curriculum's OWN courses (inherited ones keep the order they have where they live). */
function reorder(curriculumId, courseIds) {
  const set = db.prepare('UPDATE curriculum_courses SET sort_order=? WHERE curriculum_id=? AND course_id=?');
  db.transaction(() => courseIds.forEach((cid, i) => set.run(i, curriculumId, cid)))();
}

const ownCourses = curriculumId => db.prepare(
  `SELECT cc.course_id, cc.sort_order, cc.required FROM curriculum_courses cc
   WHERE cc.curriculum_id=? ORDER BY cc.sort_order, cc.course_id`).all(curriculumId);

/* ------------------------------------------------------------- § resolution -- */

/**
 * The full ordered course list: everything inherited, then everything of this curriculum's own.
 *
 * A course reachable by two routes is kept once, at its earliest position, and marked `required`
 * if ANY route requires it. Each entry says which curriculum contributed it, so the screen can
 * show "inherited from Grade 8" rather than a flat list an admin cannot reason about.
 *
 * Returns [{ course, courseId, required, from: {id, title}, inherited: bool }] in teaching order.
 */
function resolve(curriculumId, _seen) {
  const seen = _seen || new Set();
  if (seen.has(Number(curriculumId))) {
    // Guard rather than throw: a loop that somehow got stored should not take the page down.
    return [];
  }
  seen.add(Number(curriculumId));

  const c = byId(curriculumId);
  if (!c) return [];

  const out = [];
  const at = new Map();                                   // course_id → index in out

  const push = (row, from, inherited) => {
    const key = Number(row.course_id);
    if (at.has(key)) {
      // Already inherited from further up: keep its earlier position, but a later "required"
      // upgrade wins — an enrichment course promoted to required in a derived curriculum is
      // still required.
      if (row.required) out[at.get(key)].required = 1;
      return;
    }
    const course = q.courseById.get(key);
    if (!course) return;                                  // deleted course: drop it quietly
    at.set(key, out.length);
    out.push({ courseId: key, course, required: row.required ? 1 : 0, from, inherited });
  };

  if (c.extends_id) {
    for (const inh of resolve(c.extends_id, seen)) {
      // Keep the attribution of wherever it was first defined, not the intermediate curriculum.
      push({ course_id: inh.courseId, required: inh.required }, inh.from, true);
    }
  }
  const self = { id: c.id, title: c.title };
  for (const row of ownCourses(c.id)) push(row, self, false);

  return out;
}

/** The chain of curricula this one builds on, nearest first. */
function ancestry(curriculumId) {
  const chain = [];
  let hop = byId(curriculumId), guard = 0;
  while (hop && hop.extends_id && guard++ < 64) {
    hop = byId(hop.extends_id);
    if (!hop || chain.some(x => x.id === hop.id)) break;
    chain.push({ id: hop.id, title: hop.title });
  }
  return chain;
}

/** Curricula that build on this one, directly or otherwise. */
function descendants(curriculumId) {
  const out = [];
  const walk = id => {
    for (const k of db.prepare('SELECT id, title FROM curricula WHERE extends_id=?').all(id)) {
      if (out.some(x => x.id === k.id)) continue;
      out.push(k); walk(k.id);
    }
  };
  walk(curriculumId);
  return out;
}

/* ------------------------------------------------------------- § per grade -- */

/**
 * Which curriculum a grade is on. An entry for the given academic year wins; otherwise the
 * yearless default. That is how "Grade 9, 2026 intake" differs from Grade 9 thereafter without
 * anyone having to remember to change it back.
 */
function forGrade(schoolSlug, grade, academicYear = '') {
  const exact = academicYear && db.prepare(
    'SELECT * FROM curriculum_grades WHERE school_slug=? AND grade=? AND academic_year=?').get(schoolSlug, grade, academicYear);
  const row = exact || db.prepare(
    `SELECT * FROM curriculum_grades WHERE school_slug=? AND grade=? AND academic_year='' `).get(schoolSlug, grade);
  return row ? byId(row.curriculum_id) : null;
}

function setForGrade(schoolSlug, grade, curriculumId, academicYear = '') {
  if (!byId(curriculumId)) throw new Error('Curriculum not found.');
  db.prepare(`INSERT INTO curriculum_grades (school_slug, grade, academic_year, curriculum_id) VALUES (?, ?, ?, ?)
              ON CONFLICT(school_slug, grade, academic_year) DO UPDATE SET curriculum_id=excluded.curriculum_id`)
    .run(schoolSlug, grade, academicYear || '', curriculumId);
}

const clearForGrade = (schoolSlug, grade, academicYear = '') =>
  db.prepare('DELETE FROM curriculum_grades WHERE school_slug=? AND grade=? AND academic_year=?')
    .run(schoolSlug, grade, academicYear || '');

const gradesFor = schoolSlug => db.prepare(
  `SELECT cg.*, c.title AS curriculum_title FROM curriculum_grades cg
   JOIN curricula c ON c.id = cg.curriculum_id WHERE cg.school_slug=?
   ORDER BY cg.grade COLLATE NOCASE, cg.academic_year`).all(schoolSlug);

/* ------------------------------------------------------------- § the gate --- */

const completedCourseIds = userId => new Set(db.prepare(
  `SELECT course_id FROM enrollments WHERE user_id=? AND completed_at IS NOT NULL`).all(userId).map(r => r.course_id));

const activeCourseIds = userId => new Set(db.prepare(
  `SELECT course_id FROM enrollments WHERE user_id=? AND status='active'`).all(userId).map(r => r.course_id));

/**
 * One student's view of a curriculum: the courses in order, each marked done / open / locked.
 *
 * With `sequential` set, a course is locked until every REQUIRED course before it is complete;
 * enrichment courses never hold anyone up. `blockedBy` names the first thing still owed, so the
 * dashboard can say "finish The Disciple first" instead of showing a padlock with no explanation.
 */
function progressFor(userId, curriculumId) {
  const c = byId(curriculumId);
  if (!c) return { curriculum: null, items: [] };
  const done = completedCourseIds(userId);
  const active = activeCourseIds(userId);

  let blocker = null;
  const items = resolve(curriculumId).map(entry => {
    const isDone = done.has(entry.courseId);
    const locked = !!(c.sequential && blocker && !isDone);
    const item = {
      ...entry,
      done: isDone,
      enrolled: active.has(entry.courseId) || isDone,
      locked,
      blockedBy: locked ? blocker : null,
    };
    if (c.sequential && !isDone && entry.required && !blocker) blocker = entry.course.title;
    return item;
  });

  const total = items.length;
  const finished = items.filter(i => i.done).length;
  return {
    curriculum: c,
    items,
    total,
    done: finished,
    percent: total ? Math.round(100 * finished / total) : 0,
    next: items.find(i => !i.done && !i.locked) || null,
  };
}

/**
 * The academic year the school is currently in, as a school admin set it (Admin → Curricula).
 * Blank — the default — means "no year", and every grade simply uses its standing curriculum.
 * This is what makes a "Grade 9 · 2026-27" entry actually take effect for one year and then stop.
 */
const currentYear = () => {
  try { const r = q.getSetting.get('academic_year'); return (r && r.value) || ''; }
  catch { return ''; }
};
const setCurrentYear = y => q.setSetting.run('academic_year', String(y || '').trim());

/**
 * The curriculum a student is on: whatever their grade is suggested, for the current academic
 * year. Their class name IS the grade — that is how the school writes it when importing them.
 */
function forStudent(user) {
  if (!user || !user.school_slug || !user.class_name) return null;
  const c = forGrade(user.school_slug, user.class_name, currentYear());
  /* A curriculum withdrawn from a school stops laddering its students at once, rather than
     leaving them locked behind a list the school is no longer offered. */
  return c && c.is_published && openTo(c.id, user.school_slug) ? c : null;
}

/**
 * Is this course locked for this student right now? Staff are never gated — a teacher opens
 * anything their school is offered, which is how they prepare a lesson before the class reaches it.
 */
function lockedFor(user, courseId) {
  if (!user || user.role !== 'learner') return null;
  const c = forStudent(user);
  if (!c || !c.sequential) return null;
  const verdict = mayOpen(user.id, courseId, c.id);
  return verdict.ok ? null : { curriculum: c, reason: verdict.reason };
}

/** May this student open this course, given the curriculum their class is on? */
function mayOpen(userId, courseId, curriculumId) {
  const p = progressFor(userId, curriculumId);
  const item = p.items.find(i => i.courseId === Number(courseId));
  if (!item) return { ok: true };                          // not part of the curriculum: not ours to gate
  if (!item.locked) return { ok: true };
  return { ok: false, reason: `This opens once you have finished "${item.blockedBy}".` };
}

/* ---------------------------------------------------------------- § apply --- */

/**
 * What applying this curriculum to some classes would do — handed straight to enrol.js's own
 * preview, so the dates-and-exclusions rules stay in one place. Courses a student already has are
 * reported, not re-enrolled.
 */
function applyPreview({ curriculumId, schoolSlug, classes, excludeUserIds = [] }) {
  const enrol = require('./enrol');
  const items = resolve(curriculumId);
  const courseIds = items.map(i => i.courseId);
  const base = enrol.preview({ schoolSlug, classes, courseIds, excludeUserIds });

  // Which of these courses aren't offered to this school? Enrolling into them would be a surprise.
  const notOffered = items.filter(i => !enrol.courseOpenTo(i.courseId, schoolSlug))
    .map(i => ({ courseId: i.courseId, title: i.course.title }));

  const students = enrol.studentsIn(schoolSlug, classes).filter(s => !excludeUserIds.includes(s.id));
  const already = [];
  for (const s of students) {
    const have = activeCourseIds(s.id);
    const overlap = items.filter(i => have.has(i.courseId));
    if (overlap.length) already.push({ user: s, courses: overlap.map(i => i.course.title) });
  }

  return { ...base, curriculum: byId(curriculumId), items, courseIds, notOffered, already };
}

module.exports = {
  byId, bySlug, list, forSchool, create, update, remove,
  schoolsFor, setSchoolsFor, openTo,
  addCourse, removeCourse, reorder, ownCourses,
  resolve, ancestry, descendants,
  forGrade, setForGrade, clearForGrade, gradesFor,
  currentYear, setCurrentYear, forStudent, lockedFor,
  progressFor, mayOpen, applyPreview,
};
