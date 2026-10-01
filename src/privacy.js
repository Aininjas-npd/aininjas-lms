'use strict';
/* Data-subject operations (NDPA 2.2 / 4.6) for the Academy.
   - purgeUser(user)      hard-deletes everything the Academy holds about a person (FK cascades + the tables without
                          one: events, leaderboard_points, sessions) and asks Quiz Studio to purge the student's
                          attempts/profile (keyed by this user id). Returns counts for the disposition log.
   - exportUser(user)     the same data as JSON, plus Quiz Studio's part, for a parent/school request.
   - purgeSchool(slug)    every person of a school (through Accounts, which fans back out to every app), then the
                          school's batches/course links here, then Quiz Studio's school record and results.
   Row counts are returned rather than names: the caller logs what was deleted, not who. */
const { db, q } = require('./db');
const onesite = require('./onesite');

const QUIZ_API = onesite.quiz.api;
const LAUNCH_SECRET = process.env.QUIZ_LAUNCH_SECRET || '';

async function quiz(path, { method = 'GET', body } = {}) {
  if (!QUIZ_API || !LAUNCH_SECRET) return { skipped: 'quiz studio not configured' };
  const r = await fetch(QUIZ_API + path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LAUNCH_SECRET },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Quiz Studio ${path}: HTTP ${r.status} ${data.error || ''}`.trim());
  return data;
}

const tableExists = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const del = (sql, ...args) => db.prepare(sql).run(...args).changes;

/** Local hard delete, in one transaction. */
function purgeLocal(user) {
  return db.transaction(() => {
    const c = {};
    c.events = del('DELETE FROM events WHERE user_id=?', user.id);
    if (tableExists('leaderboard_points')) c.leaderboard_points = del('DELETE FROM leaderboard_points WHERE user_id=?', user.id);
    if (tableExists('sessions')) c.sessions = del('DELETE FROM sessions WHERE sess LIKE ?', `%"userId":${user.id}%`);
    if (tableExists('grades')) c.grades_given = del('UPDATE grades SET graded_by=NULL WHERE graded_by=?', user.id);
    c.enrollments = db.prepare('SELECT COUNT(*) n FROM enrollments WHERE user_id=?').get(user.id).n;
    c.sco_progress = db.prepare('SELECT COUNT(*) n FROM sco_progress WHERE user_id=?').get(user.id).n;
    if (tableExists('step_progress')) c.step_progress = db.prepare('SELECT COUNT(*) n FROM step_progress WHERE user_id=?').get(user.id).n;
    if (tableExists('assignment_submissions')) c.assignment_submissions = db.prepare('SELECT COUNT(*) n FROM assignment_submissions WHERE user_id=?').get(user.id).n;
    if (tableExists('orders')) c.orders_anonymised = require('./partners').anonymiseOrders(user.id, user.email);   // financial record kept, identity removed
    c.users = del('DELETE FROM users WHERE id=?', user.id);   // ON DELETE CASCADE: enrollments, sco_progress, step_progress, submissions, grades
    return c;
  })();
}

async function purgeUser(user, { by = 'system' } = {}) {
  const out = { academy: purgeLocal(user) };
  try { out.quiz_studio = (await quiz('/api/sso/purge-student', { method: 'POST', body: { student_ref: String(user.id) } })).purged || null; }
  catch (e) { out.quiz_studio_error = e.message; }
  // the disposition record carries no name or email — just that a user id was erased, when, and by whom
  q.logEvent.run(null, null, null, 'user_purged', JSON.stringify({ ref: user.id, by, counts: out.academy, quiz: out.quiz_studio || out.quiz_studio_error || null }));
  return out;
}

function rows(sql, ...args) { try { return db.prepare(sql).all(...args); } catch { return []; } }

async function exportUser(user) {
  const { password_hash, google_id, sso_sub, ...profile } = user;   // never export credentials
  const data = {
    exported_at: new Date().toISOString(),
    profile,
    enrollments: rows('SELECT e.id, c.title AS course, e.status, e.enrolled_at, e.completed_at FROM enrollments e JOIN courses c ON c.id=e.course_id WHERE e.user_id=? ORDER BY e.enrolled_at', user.id),
    lesson_progress: rows('SELECT c.title AS course, s.title AS lesson, p.lesson_status, p.score_raw, p.score_min, p.score_max, p.total_seconds, p.updated_at FROM sco_progress p JOIN scos s ON s.id=p.sco_id JOIN courses c ON c.id=s.course_id WHERE p.user_id=? ORDER BY c.title, s.sort_order', user.id),
    step_progress: rows('SELECT sp.*, c.title AS course FROM step_progress sp LEFT JOIN path_steps ps ON ps.id=sp.step_id LEFT JOIN courses c ON c.id=ps.course_id WHERE sp.user_id=? ORDER BY sp.id', user.id),
    assignment_submissions: rows('SELECT s.id, a.title AS assignment, s.status, s.submitted_at, s.notebook_url, s.note, s.auto_score, s.auto_max FROM assignment_submissions s JOIN assignment_items i ON i.id=s.assignment_item_id JOIN assignments a ON a.id=i.assignment_id WHERE s.user_id=? ORDER BY s.id', user.id),
    grades: rows('SELECT g.points, g.max_points, g.comment, g.source, g.graded_at, a.title AS assignment FROM grades g LEFT JOIN assignments a ON a.id=g.assignment_id WHERE g.user_id=? ORDER BY g.graded_at', user.id),
    leaderboard_points: rows('SELECT reason, points, created_at FROM leaderboard_points WHERE user_id=? ORDER BY created_at', user.id),
    events: rows('SELECT type, course_id, sco_id, created_at FROM events WHERE user_id=? ORDER BY created_at', user.id),
  };
  try { data.quiz_studio = await quiz('/api/sso/export-student?student_ref=' + encodeURIComponent(String(user.id))); }
  catch (e) { data.quiz_studio = { error: e.message }; }
  return data;
}

/** Everyone whose Academy record belongs to the school, students and staff alike. */
function schoolMembers(slug) {
  return db.prepare('SELECT id, email, name, role FROM users WHERE school_slug=?').all(slug);
}

/** @param accountsDelete  async (email) => result — provided by the caller (the SSO client), null when SSO is off. */
async function purgeSchool(slug, { by = 'system', accountsDelete } = {}) {
  const members = schoolMembers(slug);
  const out = { slug, people: [], academy: {}, quiz_studio: null };
  for (const m of members) {
    const rec = { ref: m.id, role: m.role };
    try {
      if (accountsDelete) rec.accounts = await accountsDelete(m.email);          // Accounts fans out user.deleted to every app, including us
      if (q.userById.get(m.id)) rec.academy = await purgeUser(m, { by });         // still here (SSO off, or the fan-out missed us)
    } catch (e) { rec.error = e.message; }
    out.people.push(rec);
  }
  out.academy = db.transaction(() => ({
    enrollment_batches: tableExists('enrollment_batches') ? del('DELETE FROM enrollment_batches WHERE school_slug=?', slug) : 0,
    course_schools: tableExists('course_schools') ? del('DELETE FROM course_schools WHERE school_slug=?', slug) : 0,
    curriculum_schools: tableExists('curriculum_schools') ? del('DELETE FROM curriculum_schools WHERE school_slug=?', slug) : 0,
  }))();
  try { out.quiz_studio = (await quiz('/api/sso/purge-school', { method: 'POST', body: { slug } })).purged || null; }
  catch (e) { out.quiz_studio_error = e.message; }
  q.logEvent.run(null, null, null, 'school_purged', JSON.stringify({ slug, by, people: out.people.length, academy: out.academy, quiz: out.quiz_studio || out.quiz_studio_error || null }));
  return out;
}

module.exports = { purgeUser, exportUser, purgeSchool, schoolMembers };
