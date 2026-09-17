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

/** One student: every active or ended course with its path summary, overall percent, and progress split by content
 *  type — lessons (SCORM), code (Colab) and quizzes — the way teachers read it. Ended courses stay in the reports. */
function studentSummary(u) {
  const enr = db.prepare(`SELECT e.*, c.title FROM enrollments e JOIN courses c ON c.id=e.course_id WHERE e.user_id=? AND e.status IN ('active','ended') ORDER BY CASE e.status WHEN 'active' THEN 0 ELSE 1 END, e.enrolled_at`).all(u.id);
  const courses = enr.map(e => ({ ...e, summary: pathLib.pathSummary(u.id, e.course_id) }));
  const total = courses.reduce((n, c) => n + c.summary.total, 0), done = courses.reduce((n, c) => n + c.summary.done, 0);
  const lessons = { done: 0, total: 0 }, code = { done: 0, total: 0 }, quiz = [], quizSteps = { done: 0, total: 0 };
  courses.forEach(c => c.summary.steps.forEach(s => {
    if (s.type === 'sco') { lessons.total++; if (s.status === 'done') lessons.done++; }
    else if (s.type === 'colab') { code.total++; if (s.status === 'done') code.done++; }
    else if (s.type === 'quiz') { quizSteps.total++; if (s.status === 'done') { quizSteps.done++; if (typeof s.score === 'string') { const m = /^(\d+)\/(\d+)$/.exec(s.score); if (m && +m[2]) quiz.push(100 * +m[1] / +m[2]); } } }
  }));
  const pct = o => (o.total ? Math.round(100 * o.done / o.total) : null);
  return {
    user: u, courses, total, done,
    percent: total ? Math.round(100 * done / total) : 0,
    completed: courses.filter(c => c.summary.status === 'completed').length,
    lessons: { ...lessons, percent: pct(lessons) }, code: { ...code, percent: pct(code) }, quizSteps: { ...quizSteps, percent: pct(quizSteps) },
    quizAvg: quiz.length ? Math.round(quiz.reduce((a, b) => a + b, 0) / quiz.length) : null,
    outside: [],                       // outside-Academy quiz attempts, filled by withOutside()
    lastActive: lastActivity(u.id),
  };
}
/** Attach outside-Academy quiz attempts (plain share links) to a list of summaries of one school. */
async function withOutside(schoolSlug, list) {
  const map = await require('./quizpull').outsideByStudent(schoolSlug, list.map(s => s.user));
  for (const s of list) {
    s.outside = map[s.user.id] || [];
    if (require('./quizpull').COUNTS && s.outside.length) {
      const all = [...(s.quizAvg != null ? [s.quizAvg] : []), ...s.outside.map(a => (a.max ? 100 * a.points / a.max : 0))];
      s.quizAvg = Math.round(all.reduce((a, b) => a + b, 0) / all.length);
    }
  }
  return list;
}

/** Per-class roll-up for the overview cards. */
function classStats(schoolSlug, className, list) {
  list = list || students(schoolSlug, className);
  const withWork = list.filter(s => s.total > 0);                       // students with nothing assigned don't drag the average down
  const avgOf = (arr, f) => { const v = arr.map(f).filter(x => x != null); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
  const week = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  return {
    name: className, students: list.length, withWork: withWork.length, avgPercent: avgOf(withWork, s => s.percent) || 0,
    lessonsPct: avgOf(withWork, s => s.lessons.percent), codePct: avgOf(withWork, s => s.code.percent), quizAvg: avgOf(list, s => s.quizAvg),
    completedAll: list.filter(s => s.total > 0 && s.done === s.total).length,
    notStarted: withWork.filter(s => s.done === 0).length,                // has a course, hasn't begun
    activeWeek: list.filter(s => s.lastActive && s.lastActive >= week).length,
    outsideAttempts: list.reduce((n, s) => n + (s.outside ? s.outside.length : 0), 0),
  };
}
/** Whole-school rollup: one row per class plus a total line. */
async function schoolStats(schoolSlug, classNames) {
  const all = await withOutside(schoolSlug, students(schoolSlug, null));
  const names = [...new Set([...classNames, ...all.map(s => s.user.class_name).filter(Boolean)])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const rows = names.map(n => classStats(schoolSlug, n, all.filter(s => s.user.class_name === n)));
  const unassigned = all.filter(s => !s.user.class_name);
  return { rows, total: { ...classStats(schoolSlug, 'All classes', all), name: 'All classes' }, unassigned: unassigned.length, students: all.length };
}

/** May this staff member see this student? */
function canSee(user, student) {
  if (user.role === 'admin') return true;
  if (!student || student.school_slug !== user.school_slug) return false;
  if (user.role === 'school_admin') return true;
  if (user.role === 'teacher') return parseClasses(user).includes(student.class_name || '');
  return false;
}

/** Does this student match a search string? Name, email or class, case-insensitive, every word must match. */
function matches(u, qtext) {
  const hay = `${u.name || ''} ${u.email || ''} ${u.class_name || ''}`.toLowerCase();
  return String(qtext || '').toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}
/** Students in the caller's scope whose name/email/class match. */
function search(scope, qtext) {
  if (!scope.school) return [];
  const rows = scope.all
    ? db.prepare(`SELECT * FROM users WHERE role='learner' AND status='approved' AND school_slug=? ORDER BY name COLLATE NOCASE`).all(scope.school.slug)
    : scope.classes.length ? db.prepare(`SELECT * FROM users WHERE role='learner' AND status='approved' AND school_slug=? AND class_name IN (${scope.classes.map(() => '?').join(',')}) ORDER BY name COLLATE NOCASE`).all(scope.school.slug, ...scope.classes) : [];
  return rows.filter(u => matches(u, qtext)).slice(0, 100).map(u => studentSummary(u));
}

module.exports = { scopeFor, students, studentSummary, withOutside, classStats, schoolStats, canSee, parseClasses, matches, search };
