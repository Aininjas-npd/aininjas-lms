// Class views for teachers and school admins: who is in which class, how far along each student is,
// and one student's full picture. Scope rules:
//   teacher      → students of their school in their classes (users.classes)
//   school_admin → every student of their school
//   admin        → every school (pick one)
const { db, q } = require('./db');
const pathLib = require('./path');
const brand = require('./brand');

function parseClasses(u) { try { const a = JSON.parse(u.classes || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }

/** Which school and classes may this staff member see? `schoolSlug` is only honoured for admins. */
async function scopeFor(user, schoolSlug) {
  const schools = await brand.listSchools();
  if (user.role === 'admin') {
    const slug = schoolSlug || (schools[0] && schools[0].slug) || null;
    const sch = schools.find(s => s.slug === slug) || null;
    return { school: sch, schools, classes: sch ? sch.classes : [], all: true };
  }
  const sch = schools.find(s => s.slug === user.school_slug) || (user.school_slug ? { slug: user.school_slug, name: user.organization || user.school_slug, classes: [] } : null);
  const classes = user.role === 'teacher' ? parseClasses(user) : (sch ? sch.classes : []);
  return { school: sch, schools: sch ? [sch] : [], classes, all: user.role === 'school_admin' };
}

/** Students of a school (optionally one class), each with course progress + last activity. */
function students(schoolSlug, className) {
  const rows = db.prepare(`SELECT * FROM users WHERE role='learner' AND status='approved' AND school_slug=? ${className ? 'AND class_name=?' : ''} ORDER BY name COLLATE NOCASE`)
    .all(...(className ? [schoolSlug, className] : [schoolSlug]));
  return rows.map(u => studentSummary(u));
}

function lastActivity(userId) {
  const a = db.prepare('SELECT MAX(COALESCE(completed_at, last_accessed_at)) t FROM sco_progress WHERE user_id=?').get(userId).t;
  const b = db.prepare('SELECT MAX(COALESCE(completed_at, started_at)) t FROM step_progress WHERE user_id=?').get(userId).t;
  const c = q.userById.get(userId).last_login_at;
  return [a, b, c].filter(Boolean).sort().pop() || null;
}

/** One student: every active course with its path summary, overall percent, quiz average. */
function studentSummary(u) {
  const enr = db.prepare(`SELECT e.*, c.title FROM enrollments e JOIN courses c ON c.id=e.course_id WHERE e.user_id=? AND e.status='active' ORDER BY e.enrolled_at`).all(u.id);
  const courses = enr.map(e => ({ ...e, summary: pathLib.pathSummary(u.id, e.course_id) }));
  const total = courses.reduce((n, c) => n + c.summary.total, 0), done = courses.reduce((n, c) => n + c.summary.done, 0);
  const quiz = [];
  courses.forEach(c => c.summary.steps.forEach(s => { if (s.type === 'quiz' && s.status === 'done' && typeof s.score === 'string') { const m = /^(\d+)\/(\d+)$/.exec(s.score); if (m && +m[2]) quiz.push(100 * +m[1] / +m[2]); } }));
  return {
    user: u, courses, total, done,
    percent: total ? Math.round(100 * done / total) : 0,
    completed: courses.filter(c => c.summary.status === 'completed').length,
    quizAvg: quiz.length ? Math.round(quiz.reduce((a, b) => a + b, 0) / quiz.length) : null,
    lastActive: lastActivity(u.id),
  };
}

/** Per-class roll-up for the overview cards. */
function classStats(schoolSlug, className) {
  const list = students(schoolSlug, className);
  const withWork = list.filter(s => s.total > 0);
  const avg = withWork.length ? Math.round(withWork.reduce((n, s) => n + s.percent, 0) / withWork.length) : 0;
  const q = list.filter(s => s.quizAvg != null);
  const week = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  return {
    name: className, students: list.length, avgPercent: avg,
    completedAll: list.filter(s => s.total > 0 && s.done === s.total).length,
    notStarted: list.filter(s => s.done === 0).length,
    activeWeek: list.filter(s => s.lastActive && s.lastActive >= week).length,
    quizAvg: q.length ? Math.round(q.reduce((n, s) => n + s.quizAvg, 0) / q.length) : null,
  };
}

/** May this staff member see this student? */
function canSee(user, student) {
  if (user.role === 'admin') return true;
  if (!student || student.school_slug !== user.school_slug) return false;
  if (user.role === 'school_admin') return true;
  if (user.role === 'teacher') return parseClasses(user).includes(student.class_name || '');
  return false;
}

module.exports = { scopeFor, students, studentSummary, classStats, canSee, parseClasses };
