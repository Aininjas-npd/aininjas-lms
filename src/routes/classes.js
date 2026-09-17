// Teacher / school-admin pages: /classes (overview), /classes/:name (one class), /students/:id (one student),
// plus the one-time class picker for students (/pick-class).
const express = require('express');
const { db, q } = require('../db');
const { requireLogin, requireStaff, flash } = require('../auth');
const classesLib = require('../classes');
const pathLib = require('../path');
const brand = require('../brand');

const router = express.Router();

/* ---------- students: choose your class once ---------- */
router.get('/pick-class', requireLogin, (req, res) => {
  const classes = (res.locals.brand && res.locals.brand.classes) || [];
  if (req.user.role !== 'learner' || !classes.length) return res.redirect('/dashboard');
  res.render('pick-class', { title: 'Your class', classes });
});
router.post('/pick-class', requireLogin, (req, res) => {
  const classes = (res.locals.brand && res.locals.brand.classes) || [];
  const c = String(req.body.class_name || '');
  if (!classes.includes(c)) { flash(req, 'error', 'Pick one of the classes in the list.'); return res.redirect('/pick-class'); }
  db.prepare('UPDATE users SET class_name=? WHERE id=?').run(c, req.user.id);
  const dest = req.session.returnTo && !req.session.returnTo.startsWith('/pick-class') ? req.session.returnTo : '/dashboard';
  delete req.session.returnTo;
  res.redirect(dest);
});

/* ---------- staff: overview of classes ---------- */
router.get('/classes', requireStaff, async (req, res) => {
  const scope = await classesLib.scopeFor(req.user, String(req.query.school || ''));
  if (!scope.school) return res.render('classes/index', { title: 'Classes', sc: scope, cards: [], unassigned: [], noSchool: true });
  // classes = the school's list, plus any class name students already carry that isn't on it
  const names = new Set(scope.classes);
  if (scope.all) db.prepare(`SELECT DISTINCT class_name FROM users WHERE role='learner' AND school_slug=? AND class_name IS NOT NULL AND class_name<>''`).all(scope.school.slug).forEach(r => names.add(r.class_name));
  const cards = [...names].map(n => classesLib.classStats(scope.school.slug, n));
  const unassigned = scope.all ? classesLib.students(scope.school.slug, null).filter(s => !s.user.class_name) : [];
  /* search: a name or email across every class this person may see */
  const qtext = String(req.query.q || '').trim();
  const found = qtext ? classesLib.search(scope, qtext) : null;
  res.render('classes/index', { title: 'Classes', sc: scope, cards, unassigned, noSchool: false, qtext, found });
});

/* ---------- school admins / admins: the whole school, one row per class ---------- */
router.get('/classes/school', requireStaff, async (req, res) => {
  const scope = await classesLib.scopeFor(req.user, String(req.query.school || ''));
  if (!scope.school || !scope.all) return res.status(403).render('error', { title: 'School admins only', message: 'The school overview is for school admins and AI Ninjas admins.' });
  const st = await classesLib.schoolStats(scope.school.slug, scope.classes);
  res.render('classes/school', { title: scope.school.name, sc: scope, st });
});

/* ---------- staff: one class ---------- */
router.get('/classes/:name', requireStaff, async (req, res) => {
  const scope = await classesLib.scopeFor(req.user, String(req.query.school || ''));
  const name = req.params.name;
  if (!scope.school || !(scope.all || scope.classes.includes(name))) return res.status(403).render('error', { title: 'Not your class', message: 'You can only see the classes assigned to you.' });
  const qtext = String(req.query.q || '').trim();
  const all = await classesLib.withOutside(scope.school.slug, classesLib.students(scope.school.slug, name));
  const list = qtext ? all.filter(s => classesLib.matches(s.user, qtext)) : all;
  const courses = q.courses.all().filter(c => all.some(s => s.courses.some(x => x.course_id === c.id)));
  res.render('classes/class', { title: name, sc: scope, name, list, courses, stats: classesLib.classStats(scope.school.slug, name, all), canMove: scope.all, qtext, totalStudents: all.length });
});

router.get('/classes/:name/export.csv', requireStaff, async (req, res) => {
  const scope = await classesLib.scopeFor(req.user, String(req.query.school || ''));
  const name = req.params.name;
  if (!scope.school || !(scope.all || scope.classes.includes(name))) return res.sendStatus(403);
  const list = await classesLib.withOutside(scope.school.slug, classesLib.students(scope.school.slug, name));
  const courses = q.courses.all().filter(c => list.some(s => s.courses.some(x => x.course_id === c.id)));
  const csv = v => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const lines = [['Student', 'Email', 'Class', ...courses.map(c => c.title + ' %'), 'Overall %', 'Steps done', 'Steps total', 'Lessons %', 'Lessons done', 'Lessons total', 'Code %', 'Code done', 'Code total', 'Quizzes done', 'Quizzes total', 'Quiz avg %', 'Outside-Academy quizzes', 'Last active'].map(csv).join(',')];
  list.forEach(s => lines.push([s.user.name, s.user.email, s.user.class_name || '', ...courses.map(c => { const e = s.courses.find(x => x.course_id === c.id); return e ? e.summary.percent : ''; }), s.percent, s.done, s.total,
    s.lessons.percent ?? '', s.lessons.done, s.lessons.total, s.code.percent ?? '', s.code.done, s.code.total, s.quizSteps.done, s.quizSteps.total, s.quizAvg ?? '', s.outside.map(a => `${a.title} ${a.points}/${a.max}`).join('; '), s.lastActive || ''].map(csv).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${scope.school.slug}-${name.replace(/[^a-z0-9]+/gi, '-')}.csv"`);
  res.send(lines.join('\n'));
});

/* ---------- staff: one student ---------- */
router.get('/students/:id', requireStaff, async (req, res) => {
  const u = q.userById.get(req.params.id);
  if (!u || !classesLib.canSee(req.user, u)) return res.status(403).render('error', { title: 'Not your student', message: 'You can only see students in your classes.' });
  const [s] = await classesLib.withOutside(u.school_slug, [classesLib.studentSummary(u)]);
  const scope = await classesLib.scopeFor(req.user, u.school_slug || '');
  const assign = require('../assign');
  const assignments = u.class_name ? assign.listFor(u.school_slug, u.class_name, { includeDrafts: false }).map(a => ({ ...a, mine: assign.statusFor(a, u.id) })) : [];
  res.render('classes/student', { title: u.name, s, sc: scope, quizUrl: pathLib.QUIZ_URL, outsideCounts: require('../quizpull').COUNTS, assignments });
});

/* ---------- school admins / AI Ninjas admins: move a student to another class ---------- */
router.post('/students/:id/class', requireStaff, async (req, res) => {
  const u = q.userById.get(req.params.id);
  if (!u || !classesLib.canSee(req.user, u) || req.user.role === 'teacher') return res.status(403).render('error', { title: 'Not allowed', message: 'Only a school admin can move students between classes.' });
  const scope = await classesLib.scopeFor(req.user, u.school_slug || '');
  const c = String(req.body.class_name || '');
  if (c && !(scope.classes.includes(c))) { flash(req, 'error', 'That class is not on the school\'s list.'); return res.redirect(req.get('Referer') || '/classes'); }
  db.prepare('UPDATE users SET class_name=? WHERE id=?').run(c || null, u.id);
  flash(req, 'success', c ? `${u.name} moved to ${c}.` : `${u.name} removed from their class.`);
  res.redirect(req.get('Referer') || '/classes');
});

module.exports = router;
