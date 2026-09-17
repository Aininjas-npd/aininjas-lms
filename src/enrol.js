// Enrolment by class and by date (Phase A).
//
//   Bulk:      pick a school, one or more classes and one or more courses → every matching student is enrolled at once
//              (students already on the course are skipped, ended ones are reactivated).
//   Scheduled: the same with a start date and/or an end date. A small scheduler (runs at boot and every few minutes)
//              applies batches on their start day and ends them the day after their end date.
//   Batches stay "active" for as long as they run, so a student who joins the class later is enrolled by the next tick.
//   Ending never deletes anything: the enrolment is marked `ended`, progress and scores stay for the reports, and a
//   batch can be extended (new end date) or a student re-enrolled, which simply reactivates the row.
//   Course availability: `course_schools` limits a course to some schools; a course with no rows is open to every school.
//
// Dates are calendar days in the school's timezone (SCHOOL_TZ, default America/New_York), stored as YYYY-MM-DD.
const { db, q } = require('./db');
const plugins = require('./plugins');

const TZ = process.env.SCHOOL_TZ || 'America/New_York';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date (YYYY-MM-DD) in the school timezone. */
function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
const parseJson = (t, d) => { try { const v = JSON.parse(t); return v == null ? d : v; } catch { return d; } };
const cleanDate = v => (DATE_RE.test(String(v || '').trim()) ? String(v).trim() : null);

/* ---------- course availability ---------- */
function schoolsForCourse(courseId) { return db.prepare('SELECT school_slug FROM course_schools WHERE course_id=? ORDER BY school_slug').all(courseId).map(r => r.school_slug); }
function setSchoolsForCourse(courseId, slugs) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM course_schools WHERE course_id=?').run(courseId);
    const ins = db.prepare('INSERT OR IGNORE INTO course_schools (course_id, school_slug) VALUES (?, ?)');
    for (const s of slugs) if (s) ins.run(courseId, s);
  });
  tx();
}
/** May this school use the course? (No restriction rows = every school.) Already-enrolled students are never affected by this. */
function courseOpenTo(courseId, schoolSlug) {
  const rows = schoolsForCourse(courseId);
  return rows.length === 0 || (!!schoolSlug && rows.includes(schoolSlug));
}
/** Published courses a school may enrol on. */
function coursesForSchool(schoolSlug) {
  return q.courses.all().filter(c => c.is_published && courseOpenTo(c.id, schoolSlug));
}

/* ---------- who is in a class ---------- */
function studentsIn(schoolSlug, classes) {
  if (!classes.length) return [];
  const marks = classes.map(() => '?').join(',');
  return db.prepare(`SELECT id, name, email, class_name FROM users WHERE role='learner' AND status='approved' AND school_slug=? AND class_name IN (${marks}) ORDER BY class_name, name COLLATE NOCASE`).all(schoolSlug, ...classes);
}

/** Every class name carried by a student of this school. */
function classNamesAt(schoolSlug) {
  return db.prepare(`SELECT DISTINCT class_name FROM users WHERE role='learner' AND school_slug=? AND class_name IS NOT NULL AND class_name<>'' ORDER BY class_name`).all(schoolSlug).map(r => r.class_name);
}

/* ---------- one enrolment ---------- */
/** Enrol (or reactivate) one student on one course. Returns 'enrolled' | 'reactivated' | 'skipped'. */
function enrolOne({ userId, courseId, startsOn, endsOn, source, batchId, by }) {
  const cur = q.enrollment.get(userId, courseId);
  if (cur && cur.status === 'active') {
    if (batchId && !cur.batch_id) db.prepare('UPDATE enrollments SET batch_id=?, ends_on=COALESCE(ends_on, ?) WHERE id=?').run(batchId, endsOn || null, cur.id);
    return 'skipped';
  }
  if (cur) {
    db.prepare(`UPDATE enrollments SET status='active', starts_on=?, ends_on=?, source=?, batch_id=?, ended_at=NULL, enrolled_at=datetime('now') WHERE id=?`).run(startsOn || null, endsOn || null, source, batchId || null, cur.id);
    q.logEvent.run(userId, courseId, null, 'enroll', JSON.stringify({ by, source, batch_id: batchId || null, reactivated: true }));
    plugins.emit('enrollment:created', { userId, courseId, status: 'active' });
    return 'reactivated';
  }
  db.prepare(`INSERT INTO enrollments (user_id, course_id, status, starts_on, ends_on, source, batch_id) VALUES (?, ?, 'active', ?, ?, ?, ?)`).run(userId, courseId, startsOn || null, endsOn || null, source, batchId || null);
  q.logEvent.run(userId, courseId, null, 'enroll', JSON.stringify({ by, source, batch_id: batchId || null }));
  plugins.emit('enrollment:created', { userId, courseId, status: 'active' });
  return 'enrolled';
}
/** Mark one enrolment ended (progress kept). */
function endOne(enrId, by, reason) {
  const e = db.prepare('SELECT * FROM enrollments WHERE id=?').get(enrId);
  if (!e || e.status !== 'active') return false;
  db.prepare(`UPDATE enrollments SET status='ended', ended_at=datetime('now') WHERE id=?`).run(enrId);
  q.logEvent.run(e.user_id, e.course_id, null, 'enroll_ended', JSON.stringify({ by, reason }));
  return true;
}

/* ---------- batches ---------- */
function batchById(id) { const b = db.prepare('SELECT * FROM enrollment_batches WHERE id=?').get(id); return b ? shape(b) : null; }
function shape(b) {
  const classes = parseJson(b.classes, []), courseIds = parseJson(b.course_ids, []), exclude = parseJson(b.exclude_user_ids, []);
  const courses = courseIds.map(id => q.courseById.get(id)).filter(Boolean);
  const counts = db.prepare(`SELECT status, COUNT(*) n FROM enrollments WHERE batch_id=? GROUP BY status`).all(b.id).reduce((o, r) => (o[r.status] = r.n, o), {});
  const creator = b.created_by ? q.userById.get(b.created_by) : null;
  const covered = studentsIn(b.school_slug, classes).filter(s => !exclude.includes(s.id)).length;   // students in those classes today
  return { ...b, classes, courseIds, exclude, courses, counts, covered, creator: creator ? creator.name : null, active: counts.active || 0, ended: counts.ended || 0 };
}
/** Batches a staff member may see: admin = all (optionally one school); school admin = the school; teacher = own classes only. */
function listBatches({ user, schoolSlug, classes, all }) {
  let rows = db.prepare('SELECT * FROM enrollment_batches ' + (schoolSlug ? 'WHERE school_slug=? ' : '') + 'ORDER BY CASE status WHEN \'pending\' THEN 0 WHEN \'active\' THEN 1 ELSE 2 END, COALESCE(starts_on, created_at) DESC, id DESC').all(...(schoolSlug ? [schoolSlug] : []));
  rows = rows.map(shape);
  if (!all) rows = rows.filter(b => b.classes.some(c => classes.includes(c)));
  return rows;
}

/** What a bulk enrolment would do, before doing it. */
function preview({ schoolSlug, classes, courseIds, excludeUserIds = [] }) {
  const students = studentsIn(schoolSlug, classes).filter(s => !excludeUserIds.includes(s.id));
  const courses = courseIds.map(id => q.courseById.get(id)).filter(c => c && c.is_published);
  let toEnrol = 0, already = 0, reactivate = 0;
  const perCourse = courses.map(c => {
    let e = 0, a = 0, r = 0;
    for (const s of students) { const cur = q.enrollment.get(s.id, c.id); if (cur && cur.status === 'active') a++; else if (cur) r++; else e++; }
    toEnrol += e; already += a; reactivate += r;
    return { course: c, enrol: e, already: a, reactivate: r };
  });
  return { students, courses, perCourse, toEnrol, already, reactivate };
}

/** Create a batch and, if it starts today or earlier, apply it now. */
function createBatch({ schoolSlug, classes, courseIds, startsOn, endsOn, excludeUserIds = [], note, by }) {
  startsOn = cleanDate(startsOn); endsOn = cleanDate(endsOn);
  if (!classes.length) throw new Error('Pick at least one class.');
  if (!courseIds.length) throw new Error('Pick at least one course.');
  if (startsOn && endsOn && endsOn < startsOn) throw new Error('The end date is before the start date.');
  if (endsOn && endsOn < today()) throw new Error('The end date is already in the past.');
  const info = db.prepare(`INSERT INTO enrollment_batches (school_slug, classes, course_ids, starts_on, ends_on, exclude_user_ids, status, note, created_by) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
    .run(schoolSlug, JSON.stringify(classes), JSON.stringify(courseIds.map(Number)), startsOn, endsOn, JSON.stringify(excludeUserIds.map(Number)), note || null, by || null);
  const b = batchById(info.lastInsertRowid);
  const result = tick(by);          // applies it at once when it is due
  return { batch: batchById(b.id), applied: result.applied.find(x => x.id === b.id) || null };
}

/** Apply one batch: enrol every matching student who isn't on the course yet. */
function applyBatch(b, by) {
  const students = studentsIn(b.school_slug, b.classes).filter(s => !b.exclude.includes(s.id));
  const out = { id: b.id, enrolled: 0, reactivated: 0, skipped: 0 };
  const tx = db.transaction(() => {
    for (const c of b.courses) for (const s of students) {
      const r = enrolOne({ userId: s.id, courseId: c.id, startsOn: b.starts_on, endsOn: b.ends_on, source: b.starts_on ? 'scheduled' : 'bulk', batchId: b.id, by });
      out[r === 'enrolled' ? 'enrolled' : r === 'reactivated' ? 'reactivated' : 'skipped']++;
    }
    if (b.status === 'pending') db.prepare(`UPDATE enrollment_batches SET status='active', applied_at=datetime('now') WHERE id=?`).run(b.id);
  });
  tx();
  return out;
}
/** End one batch: its active enrolments are marked ended. */
function endBatch(b, by, reason = 'ended') {
  const rows = db.prepare(`SELECT id FROM enrollments WHERE batch_id=? AND status='active'`).all(b.id);
  const tx = db.transaction(() => {
    for (const r of rows) endOne(r.id, by, reason);
    db.prepare(`UPDATE enrollment_batches SET status=?, ended_at=datetime('now') WHERE id=?`).run(reason === 'cancelled' ? 'cancelled' : 'ended', b.id);
  });
  tx();
  return rows.length;
}
/** Give a batch (and its enrolments) a later end date, or none. */
function extendBatch(b, newEndsOn, by) {
  newEndsOn = cleanDate(newEndsOn);
  if (newEndsOn && newEndsOn < today()) throw new Error('The new end date is already in the past.');
  const tx = db.transaction(() => {
    db.prepare(`UPDATE enrollment_batches SET ends_on=?, extended_from=COALESCE(?, extended_from), status=CASE WHEN status='ended' THEN 'active' ELSE status END, ended_at=NULL WHERE id=?`).run(newEndsOn, b.ends_on, b.id);
    db.prepare(`UPDATE enrollments SET ends_on=? WHERE batch_id=?`).run(newEndsOn, b.id);
    if (b.status === 'ended') {   // bring the ended enrolments back
      db.prepare(`UPDATE enrollments SET status='active', ended_at=NULL WHERE batch_id=? AND status='ended'`).run(b.id);
    }
  });
  tx();
  q.logEvent.run(by || null, null, null, 'batch_extended', JSON.stringify({ batch_id: b.id, from: b.ends_on, to: newEndsOn }));
  return batchById(b.id);
}
/** Change the dates of a batch that hasn't started yet. */
function rescheduleBatch(b, startsOn, endsOn) {
  if (b.status !== 'pending') throw new Error('Only a batch that has not started can be re-dated; extend or end it instead.');
  startsOn = cleanDate(startsOn); endsOn = cleanDate(endsOn);
  if (startsOn && endsOn && endsOn < startsOn) throw new Error('The end date is before the start date.');
  db.prepare('UPDATE enrollment_batches SET starts_on=?, ends_on=? WHERE id=?').run(startsOn, endsOn, b.id);
  return batchById(b.id);
}

/* ---------- the scheduler ---------- */
/** One pass: start what is due, keep active batches complete, end what has expired. Returns what it did. */
function tick(by = null) {
  const t = today();
  const applied = [], ended = [];
  for (const raw of db.prepare(`SELECT * FROM enrollment_batches WHERE status IN ('pending','active')`).all()) {
    const b = shape(raw);
    if (b.ends_on && b.ends_on < t) { if (b.status === 'active') { ended.push({ id: b.id, students: endBatch(b, by, 'ended') }); } else { db.prepare(`UPDATE enrollment_batches SET status='ended', ended_at=datetime('now') WHERE id=?`).run(b.id); } continue; }
    if (!b.starts_on || b.starts_on <= t) applied.push(applyBatch(b, by));
  }
  /* enrolments given an end date by hand (no batch) */
  for (const e of db.prepare(`SELECT id FROM enrollments WHERE status='active' AND batch_id IS NULL AND ends_on IS NOT NULL AND ends_on < ?`).all(t)) endOne(e.id, by, 'ended');
  return { applied, ended, today: t };
}
let timer = null;
function start(intervalMs = 5 * 60 * 1000) {
  const run = () => { try { const r = tick(null); const n = r.applied.filter(a => a.enrolled + a.reactivated).length + r.ended.length; if (n) console.log(`[enrol] ${r.today}: applied ${r.applied.filter(a => a.enrolled + a.reactivated).length} batch(es), ended ${r.ended.length}`); } catch (e) { console.error('[enrol] scheduler', e); } };
  run();
  timer = setInterval(run, intervalMs);
  if (timer.unref) timer.unref();
}

/* ---------- what a student sees ---------- */
/** Active enrolments only (what the dashboard shows). Ended ones are listed separately, read-only. */
function forStudent(userId) {
  const rows = db.prepare(`SELECT e.*, c.title, c.slug, c.description FROM enrollments e JOIN courses c ON c.id=e.course_id WHERE e.user_id=? ORDER BY e.enrolled_at DESC`).all(userId);
  return { active: rows.filter(e => e.status === 'active'), requested: rows.filter(e => e.status === 'requested'), ended: rows.filter(e => e.status === 'ended') };
}

module.exports = { today, TZ, cleanDate, schoolsForCourse, setSchoolsForCourse, courseOpenTo, coursesForSchool, studentsIn, classNamesAt, enrolOne, endOne, preview, createBatch, applyBatch, endBatch, extendBatch, rescheduleBatch, batchById, listBatches, tick, start, forStudent };
