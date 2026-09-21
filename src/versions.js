'use strict';
/*
 * Course versions.
 *
 * Updating a course that people are already working through is the awkward case: change the
 * lessons under a class mid-term and their progress stops meaning anything. So an update makes a
 * COPY instead — v2 — and leaves v1 exactly as it was:
 *
 *   v1  closed to new enrolment, its learners carry on, their progress untouched
 *   v2  published, and it is what new learners enrol in
 *
 * Versions of one course are tied together by `version_group` (the original course's id) and
 * numbered with `version_no`. `superseded_by` points from a version to the one that replaced it,
 * which is how a learner is told a newer version exists.
 *
 * Everything is copied: the course row, its learning path, its SCO rows and the unpacked package
 * files on disk. That costs disk space — one copy per version — and it is the price of never
 * having to reason about a learner half-way through a lesson that changed underneath them.
 */
const fs = require('fs');
const path = require('path');
const { db, q, DATA_DIR } = require('./db');

function columns() {
  const cols = db.prepare('PRAGMA table_info(courses)').all().map(c => c.name);
  if (!cols.includes('version_no')) db.exec('ALTER TABLE courses ADD COLUMN version_no INTEGER NOT NULL DEFAULT 1');
  if (!cols.includes('version_group')) db.exec('ALTER TABLE courses ADD COLUMN version_group INTEGER');
  if (!cols.includes('superseded_by')) db.exec('ALTER TABLE courses ADD COLUMN superseded_by INTEGER');
  if (!cols.includes('version_note')) db.exec('ALTER TABLE courses ADD COLUMN version_note TEXT');
  // every existing course is version 1 of its own family
  db.exec('UPDATE courses SET version_group = id WHERE version_group IS NULL');
}
columns();

const courseDir = slug => path.join(DATA_DIR, 'courses', slug);

/** Free space check — a copy needs as much room as the original. */
function roomFor(slug) {
  let need = 0;
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    try { if (e.isDirectory()) walk(p); else need += fs.statSync(p).size; } catch { /* skip */ }
  } };
  try { walk(courseDir(slug)); } catch { return { need: 0 }; }
  let free = NaN;
  try { const st = fs.statfsSync(DATA_DIR); free = st.bavail * st.bsize; } catch { return { need }; }
  return { need, free, ok: !Number.isFinite(free) || need + 50 * 1024 * 1024 < free };
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

/** All versions of a course's family, oldest first, each with its live enrolment count. */
function family(courseId) {
  const c = q.courseById.get(courseId);
  if (!c) return [];
  const group = c.version_group || c.id;
  return db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = c.id AND e.status = 'active') AS active_learners
                     FROM courses c WHERE COALESCE(c.version_group, c.id) = ? ORDER BY c.version_no`).all(group);
}

/** The newest version of whichever family this course belongs to. */
function latest(courseId) {
  const rows = family(courseId);
  return rows.length ? rows[rows.length - 1] : null;
}

/**
 * Copy `courseId` into a new version. The old one is closed to new enrolment (its learners keep
 * working); the new one is published. Returns the new course row.
 */
function newVersion(courseId, { note } = {}) {
  const src = q.courseById.get(courseId);
  if (!src) throw new Error('Course not found');
  const group = src.version_group || src.id;
  const top = db.prepare('SELECT MAX(version_no) n FROM courses WHERE COALESCE(version_group, id) = ?').get(group).n || 1;
  const nextNo = top + 1;

  const room = roomFor(src.slug);
  if (room.ok === false) {
    const mb = n => `${(n / 1048576).toFixed(0)} MB`;
    throw new Error(`copying this course needs ${mb(room.need)} and only ${mb(room.free)} is free on the data volume. Clear space (Admin dashboard → Storage) or grow the volume, then try again.`);
  }

  let slug = `${String(src.slug).replace(/-v\d+$/, '')}-v${nextNo}`, n = 1;
  while (q.courseBySlug.get(slug)) slug = `${String(src.slug).replace(/-v\d+$/, '')}-v${nextNo}-${++n}`;

  // files first: if the disk gives out, no half-made course row is left behind
  const from = courseDir(src.slug), to = courseDir(slug);
  let copied = false;
  if (fs.existsSync(from)) {
    try { copyDir(from, to); copied = true; }
    catch (e) { try { fs.rmSync(to, { recursive: true, force: true }); } catch {} throw e; }
  }

  try {
    return db.transaction(() => {
      const info = db.prepare(`INSERT INTO courses (slug, title, description, version, manifest_json, is_published, open_enrollment, sequential, version_no, version_group, version_note)
                               VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
        .run(slug, src.title, src.description, src.version, src.manifest_json, src.open_enrollment, src.sequential || 0, nextNo, group, String(note || '').trim() || null);
      const newId = info.lastInsertRowid;

      // SCO rows, remembering how the old ids map to the new ones so path steps can follow
      const scoMap = new Map();
      for (const s of db.prepare('SELECT * FROM scos WHERE course_id=? ORDER BY sort_order, id').all(src.id)) {
        const r = db.prepare(`INSERT INTO scos (course_id, identifier, title, launch_href, sort_order, mastery_score, max_time_allowed, data_from_lms, package, package_title)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(newId, s.identifier, s.title, s.launch_href, s.sort_order, s.mastery_score, s.max_time_allowed, s.data_from_lms, s.package, s.package_title);
        scoMap.set(s.id, r.lastInsertRowid);
      }

      for (const st of db.prepare('SELECT * FROM path_steps WHERE course_id=? ORDER BY sort_order, id').all(src.id)) {
        let cfg = {};
        try { cfg = JSON.parse(st.config || '{}'); } catch { cfg = {}; }
        if (cfg.sco_id && scoMap.has(cfg.sco_id)) cfg.sco_id = scoMap.get(cfg.sco_id);
        const newStepId = db.prepare('INSERT INTO path_steps (course_id, sort_order, type, title, config, audience) VALUES (?, ?, ?, ?, ?, ?)')
          .run(newId, st.sort_order, st.type, st.title, JSON.stringify(cfg), st.audience || 'student').lastInsertRowid;
        try { require('./stepfiles').copyToStep(st.id, newStepId); } catch (e) { /* attachments are best-effort */ }
      }

      // which schools the course is offered to (see enrol.js: course_schools)
      try {
        for (const a of db.prepare('SELECT school_slug FROM course_schools WHERE course_id=?').all(src.id))
          db.prepare('INSERT OR IGNORE INTO course_schools (course_id, school_slug) VALUES (?, ?)').run(newId, a.school_slug);
      } catch { /* no such table in this install */ }

      db.prepare('UPDATE courses SET is_published=0, superseded_by=? WHERE id=?').run(newId, src.id);
      return q.courseById.get(newId);
    })();
  } catch (e) {
    if (copied) { try { fs.rmSync(to, { recursive: true, force: true }); } catch {} }
    throw e;
  }
}

/** For a learner: the newer version of a course they are on, or null. */
function newerThan(course) {
  if (!course || !course.superseded_by) return null;
  let next = q.courseById.get(course.superseded_by);
  while (next && next.superseded_by) next = q.courseById.get(next.superseded_by);   // jump straight to the newest
  return next && next.is_published ? next : null;
}

/**
 * Move a learner onto the newest version. Their old enrolment is ended (progress kept and still
 * visible in reports); a fresh enrolment starts on the new version at zero.
 */
function switchLearner(userId, fromCourseId) {
  const from = q.courseById.get(fromCourseId);
  const to = newerThan(from);
  if (!to) throw new Error('There is no newer version of this course.');
  const cur = q.enrollment.get(userId, from.id);
  if (!cur || cur.status !== 'active') throw new Error('You are not currently enrolled in that course.');

  return db.transaction(() => {
    db.prepare(`UPDATE enrollments SET status='ended', ended_at=datetime('now') WHERE id=?`).run(cur.id);
    const existing = q.enrollment.get(userId, to.id);
    if (existing) db.prepare(`UPDATE enrollments SET status='active', ended_at=NULL, ends_on=NULL, enrolled_at=datetime('now') WHERE id=?`).run(existing.id);
    else db.prepare(`INSERT INTO enrollments (user_id, course_id, status, source) VALUES (?, ?, 'active', ?)`).run(userId, to.id, cur.source || 'self');
    return to;
  })();
}

module.exports = { newVersion, family, latest, newerThan, switchLearner, roomFor };
