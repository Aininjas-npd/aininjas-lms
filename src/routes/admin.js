// Admin: course upload, access requests, enrollments, progress reports, settings.
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { db, q, DATA_DIR, courseSummary } = require('../db');
const { requireAdmin, flash, syncAllFromAccounts } = require('../auth');
const { importPackage, createCourse, addPackageToCourse, removePackage, packagesFor, deleteCourse } = require('../scorm');
const plugins = require('../plugins');
const pathLib = require('../path');
const brand = require('../brand');

const router = express.Router();
router.use(requireAdmin);
const upload = multer({ dest: path.join(DATA_DIR, 'uploads'), limits: { fileSize: 1024 * 1024 * 1024 } }); // 1 GB

router.get('/', (req, res) => {
  const stats = {
    users: db.prepare(`SELECT COUNT(*) n FROM users WHERE status='approved'`).get().n,
    pending: db.prepare(`SELECT COUNT(*) n FROM users WHERE status='pending'`).get().n,
    pendingEnrollments: db.prepare(`SELECT COUNT(*) n FROM enrollments WHERE status='requested'`).get().n,
    courses: db.prepare(`SELECT COUNT(*) n FROM courses`).get().n,
    completions: db.prepare(`SELECT COUNT(*) n FROM enrollments WHERE completed_at IS NOT NULL`).get().n,
    launches7d: db.prepare(`SELECT COUNT(*) n FROM events WHERE type='launch' AND created_at > datetime('now','-7 days')`).get().n,
  };
  const recent = db.prepare(`SELECT e.*, u.name AS user_name, c.title AS course_title, s.title AS sco_title FROM events e
                             LEFT JOIN users u ON u.id=e.user_id LEFT JOIN courses c ON c.id=e.course_id LEFT JOIN scos s ON s.id=e.sco_id
                             ORDER BY e.id DESC LIMIT 25`).all();
  const courses = q.courses.all().map(c => ({ ...c, steps: pathLib.stepsFor(c.id).length, custom: pathLib.hasCustomPath(c.id),
    enrolled: db.prepare(`SELECT COUNT(*) n FROM enrollments WHERE course_id=? AND status='active'`).get(c.id).n }));
  res.render('admin/index', { title: 'Admin', stats, recent, courses, widgets: plugins.widgets('adminDashboard'), plugins: plugins.list() });
});

// ---- Courses ----
router.get('/courses', (req, res) => {
  const courses = q.courses.all().map(c => ({
    ...c,
    scoCount: db.prepare('SELECT COUNT(*) n FROM scos WHERE course_id=?').get(c.id).n,
    enrolled: db.prepare(`SELECT COUNT(*) n FROM enrollments WHERE course_id=? AND status='active'`).get(c.id).n,
    completed: db.prepare(`SELECT COUNT(*) n FROM enrollments WHERE course_id=? AND completed_at IS NOT NULL`).get(c.id).n,
  }));
  res.render('admin/courses', { title: 'Courses', courses });
});

// Create a course — with or without a SCORM package. More packages/quizzes/notebooks are added on its learning-path page.
router.post('/courses/upload', upload.single('package'), (req, res) => {
  try {
    let course;
    if (req.file) {
      course = importPackage(req.file.path, { title: req.body.title, description: req.body.description, openEnrollment: req.body.open_enrollment === 'on' });
      flash(req, 'success', `Created "${course.title}" with ${db.prepare('SELECT COUNT(*) n FROM scos WHERE course_id=?').get(course.id).n} lesson(s). Add quizzes, notebooks or more packages on its learning path.`);
    } else {
      course = createCourse({ title: req.body.title, description: req.body.description, openEnrollment: req.body.open_enrollment === 'on' });
      flash(req, 'success', `Created "${course.title}". Now add its steps.`);
    }
    q.logEvent.run(req.user.id, course.id, null, 'course_created', JSON.stringify({ title: course.title, withPackage: !!req.file }));
    return res.redirect(`/admin/courses/${course.id}/path`);
  } catch (e) {
    console.error('[create course]', e);
    flash(req, 'error', `Could not create the course: ${e.message}`);
  } finally { if (req.file) fs.rmSync(req.file.path, { force: true }); }
  res.redirect('/admin/courses');
});
// Add a SCORM package to an existing course → its lessons become Learn steps at the end of the path
router.post('/courses/:id/packages', upload.single('package'), (req, res) => {
  const course = q.courseById.get(req.params.id);
  if (!course) return res.status(404).render('error', { title: 'Not found', message: 'Course not found.' });
  if (!req.file) { flash(req, 'error', 'Choose a .zip SCORM 1.2 package.'); return res.redirect(`/admin/courses/${course.id}/path`); }
  try {
    const custom = pathLib.hasCustomPath(course.id);
    const scos = addPackageToCourse(course.id, req.file.path, { title: req.body.title });
    if (custom) scos.forEach(s => pathLib.addStep(course.id, { type: 'sco', title: s.title, config: { sco_id: s.id } }));
    q.logEvent.run(req.user.id, course.id, null, 'package_added', JSON.stringify({ title: scos[0] && scos[0].package_title, lessons: scos.length }));
    flash(req, 'success', `Added "${scos[0].package_title}" — ${scos.length} lesson(s) appended to the path.`);
  } catch (e) { console.error('[add package]', e); flash(req, 'error', `Import failed: ${e.message}`); }
  finally { fs.rmSync(req.file.path, { force: true }); }
  res.redirect(`/admin/courses/${course.id}/path`);
});
router.post('/courses/:id/packages/remove', (req, res) => {
  removePackage(+req.params.id, String(req.body.folder || ''));
  flash(req, 'success', 'Package removed.');
  res.redirect(`/admin/courses/${req.params.id}/path`);
});

router.post('/courses/:id/toggle', (req, res) => {
  const c = q.courseById.get(req.params.id);
  if (c) {
    if (req.body.field === 'is_published') db.prepare('UPDATE courses SET is_published = 1 - is_published WHERE id=?').run(c.id);
    if (req.body.field === 'open_enrollment') db.prepare('UPDATE courses SET open_enrollment = 1 - open_enrollment WHERE id=?').run(c.id);
  }
  res.redirect('/admin/courses');
});
router.post('/courses/:id/delete', (req, res) => { deleteCourse(req.params.id); flash(req, 'success', 'Course deleted.'); res.redirect('/admin/courses'); });

// Course report: every enrolled learner and their per-SCO progress
router.get('/courses/:id', async (req, res) => {
  req.grid = pathLib.classGrid(+req.params.id);
  const course = q.courseById.get(req.params.id);
  if (!course) return res.status(404).render('error', { title: 'Not found', message: 'Course not found.' });
  const scos = q.scosForCourse.all(course.id);
  const learners = db.prepare(`SELECT u.id, u.name, u.email, u.organization, e.status AS enrollment_status, e.enrolled_at, e.completed_at
                               FROM enrollments e JOIN users u ON u.id = e.user_id WHERE e.course_id = ? ORDER BY u.name`).all(course.id)
    .map(u => ({ ...u, summary: courseSummary(u.id, course.id) }));
  const heat = scos.map(s => {
    const r = db.prepare(`SELECT COUNT(*) attempts, SUM(CASE WHEN lesson_status IN ('completed','passed') THEN 1 ELSE 0 END) done,
                          AVG(score_raw) avg_score, AVG(total_seconds) avg_secs FROM sco_progress WHERE sco_id=?`).get(s.id);
    return { ...s, ...r };
  });
  const allUsers = db.prepare(`SELECT id, name, email FROM users WHERE status='approved' AND id NOT IN (SELECT user_id FROM enrollments WHERE course_id=?) ORDER BY name`).all(course.id);
  const enrol = require('../enrol');
  res.render('admin/course', { title: course.title, course, scos, learners, heat, allUsers, grid: req.grid, hasPath: pathLib.hasCustomPath(course.id),
    schools: await brand.listSchools(), courseSchools: enrol.schoolsForCourse(course.id) });
});

// ---- Learning path builder ----
router.get('/courses/:id/path', async (req, res) => {
  const course = q.courseById.get(req.params.id);
  if (!course) return res.status(404).render('error', { title: 'Not found', message: 'Course not found.' });
  let quizzes = [], quizError = null;
  if (pathLib.quizEnabled()) { try { quizzes = await pathLib.listQuizzes(); } catch (e) { quizError = e.message; } }
  res.render('admin/path', { title: 'Learning path · ' + course.title, course, steps: pathLib.stepsFor(course.id), custom: pathLib.hasCustomPath(course.id),
    scos: q.scosForCourse.all(course.id), packages: packagesFor(course.id), quizzes, quizError, quizEnabled: pathLib.quizEnabled(), quizUrl: pathLib.QUIZ_URL });
});
const notebookDir = path.join(DATA_DIR, 'notebooks');
fs.mkdirSync(notebookDir, { recursive: true });
const nbUpload = multer({ dest: notebookDir, limits: { fileSize: 25 * 1024 * 1024 } });
router.post('/courses/:id/path/steps', nbUpload.single('notebook'), (req, res) => {
  const course = q.courseById.get(req.params.id);
  if (!course) return res.status(404).render('error', { title: 'Not found', message: 'Course not found.' });
  const b = req.body, type = String(b.type || '');
  try {
    pathLib.materialise(course.id);
    if (type === 'sco') { const sco = q.scoById.get(+b.sco_id); if (!sco || sco.course_id !== course.id) throw new Error('Pick a lesson'); pathLib.addStep(course.id, { type, title: b.title || sco.title, config: { sco_id: sco.id } }); }
    else if (type === 'quiz') { if (!b.quiz_id) throw new Error('Pick a quiz'); const [qid, qtitle] = String(b.quiz_id).split('|'); pathLib.addStep(course.id, { type, title: b.title || qtitle || 'Quiz', config: { quiz_id: +qid, quiz_title: qtitle || '' } }); }
    else if (type === 'colab') {
      // Two ways to hand out a notebook: upload the .ipynb (students download it and upload to their own Colab — no link to your
      // Drive, no "authored by …" warning, no sessions on your account), or a shared Colab link (the old way).
      if (req.file) {
        if (!/\.ipynb$/i.test(req.file.originalname || '')) { fs.unlinkSync(req.file.path); throw new Error('Upload a Jupyter/Colab notebook file (.ipynb)'); }
        try { JSON.parse(fs.readFileSync(req.file.path, 'utf8')); } catch { fs.unlinkSync(req.file.path); throw new Error('That file is not a valid notebook (.ipynb is JSON)'); }
        const safe = req.file.originalname.replace(/[^\w.\- ]+/g, '_');
        pathLib.addStep(course.id, { type, title: b.title || safe.replace(/\.ipynb$/i, ''), config: { file: path.basename(req.file.path), filename: safe, instructions: b.instructions || '' } });
      } else {
        if (!/^https?:\/\//i.test(b.url || '')) throw new Error('Upload the notebook file (.ipynb) or paste a Colab link');
        pathLib.addStep(course.id, { type, title: b.title || 'Hands-on: Python in Colab', config: { url: b.url.trim(), instructions: b.instructions || '' } });
      }
    }
    else if (type === 'note') { if (!b.instructions) throw new Error('Write the note text'); pathLib.addStep(course.id, { type, title: b.title || 'Read this first', config: { html: b.instructions } }); }
    else throw new Error('Unknown step type');
    if (b.after !== undefined && b.after !== '' && b.after !== 'end') {   // "Insert after step N" (0 = at the start)
      const last = db.prepare('SELECT id FROM path_steps WHERE course_id=? ORDER BY sort_order DESC, id DESC LIMIT 1').get(course.id);
      if (last) pathLib.moveTo(course.id, last.id, (+b.after || 0) + 1);
    }
    flash(req, 'success', 'Step added.');
  } catch (e) { flash(req, 'error', e.message); }
  res.redirect(`/admin/courses/${course.id}/path`);
});
// Drag-and-drop order from the path page (JSON: { ids: [...] }) — saves silently, no reload
router.post('/courses/:id/path/reorder', express.json(), (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ error: 'No order given' });
  res.json({ ok: true, order: pathLib.reorder(+req.params.id, ids) });
});
router.post('/courses/:id/path/steps/:stepId/:action', (req, res) => {
  const { stepId, action } = req.params;
  if (action === 'up' || action === 'down') pathLib.moveStep(+stepId, action);
  else if (action === 'moveto') pathLib.moveTo(+req.params.id, +stepId, +req.body.position || 1);
  else if (action === 'delete') pathLib.deleteStep(+stepId);
  else if (action === 'rename') pathLib.updateStep(+stepId, { title: String(req.body.title || '').trim() });
  res.redirect(`/admin/courses/${req.params.id}/path`);
});
router.post('/courses/:id/path/sequential', (req, res) => {
  db.prepare('UPDATE courses SET sequential = 1 - sequential WHERE id=?').run(+req.params.id);
  const c = q.courseById.get(req.params.id);
  flash(req, 'success', c && c.sequential ? 'Sequence locked — students must finish each step before the next opens.' : 'Sequence unlocked — students may do steps in any order.');
  res.redirect(`/admin/courses/${req.params.id}/path`);
});
router.post('/courses/:id/path/reset', (req, res) => { pathLib.clearPath(+req.params.id); flash(req, 'success', 'Path reset to the SCORM lessons.'); res.redirect(`/admin/courses/${req.params.id}/path`); });

router.get('/courses/:id/export.csv', (req, res) => {
  const course = q.courseById.get(req.params.id);
  if (!course) return res.sendStatus(404);
  const scos = q.scosForCourse.all(course.id);
  const rows = db.prepare(`SELECT u.id, u.name, u.email, u.organization, e.status, e.enrolled_at, e.completed_at FROM enrollments e JOIN users u ON u.id=e.user_id WHERE e.course_id=?`).all(course.id);
  const head = ['name', 'email', 'organization', 'enrollment_status', 'enrolled_at', 'course_completed_at', 'percent_complete', 'avg_score', 'total_minutes',
                ...scos.flatMap(s => [`${s.title} status`, `${s.title} score`])];
  const lines = [head.map(csv).join(',')];
  for (const r of rows) {
    const s = courseSummary(r.id, course.id);
    const per = s.rows.flatMap(p => [p.lesson_status || 'not attempted', p.score_raw ?? '']);
    lines.push([r.name, r.email, r.organization || '', r.status, r.enrolled_at, r.completed_at || '', s.percent, s.avgScore ?? '', Math.round(s.seconds / 60), ...per].map(csv).join(','));
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${course.slug}-progress.csv"`);
  res.send(lines.join('\n'));
});

// ---- Enrollments ----
router.post('/enrollments', (req, res) => {
  const { user_id, course_id } = req.body;
  db.prepare(`INSERT INTO enrollments (user_id, course_id, status) VALUES (?, ?, 'active')
              ON CONFLICT(user_id, course_id) DO UPDATE SET status='active'`).run(user_id, course_id);
  q.logEvent.run(user_id, course_id, null, 'enroll', JSON.stringify({ by: req.user.id }));
  plugins.emit('enrollment:created', { userId: +user_id, courseId: +course_id, status: 'active' });
  res.redirect(req.get('Referer') || '/admin');
});
router.post('/enrollments/:id/:action', (req, res) => {
  const e = db.prepare('SELECT * FROM enrollments WHERE id=?').get(req.params.id);
  if (e) {
    const status = req.params.action === 'approve' ? 'active' : 'revoked';
    db.prepare('UPDATE enrollments SET status=? WHERE id=?').run(status, e.id);
    q.logEvent.run(e.user_id, e.course_id, null, status === 'active' ? 'enroll' : 'enroll_revoked', JSON.stringify({ by: req.user.id }));
    if (status === 'active') plugins.emit('enrollment:created', { userId: e.user_id, courseId: e.course_id, status });
  }
  res.redirect(req.get('Referer') || '/admin/users');
});
router.post('/progress/reset', (req, res) => {
  const { user_id, course_id } = req.body;
  db.prepare(`DELETE FROM sco_progress WHERE user_id=? AND sco_id IN (SELECT id FROM scos WHERE course_id=?)`).run(user_id, course_id);
  db.prepare(`UPDATE enrollments SET completed_at=NULL WHERE user_id=? AND course_id=?`).run(user_id, course_id);
  flash(req, 'success', 'Progress reset.');
  res.redirect(req.get('Referer') || '/admin');
});

// ---- Users / access requests ----
router.post('/users/sync-accounts', async (req, res) => {
  try { const r = await syncAllFromAccounts(); flash(req, 'success', `Synced with AI Ninjas Accounts: ${r.total} people with Academy access — ${r.created} added, ${r.updated} updated${r.disabled ? ', ' + r.disabled + ' disabled' : ''}.`); }
  catch (e) { flash(req, 'error', 'Sync failed: ' + e.message); }
  res.redirect('/admin/users');
});
/* Quiz Studio link check: shows what the class reports get for a school and why attempts do or don't match students */
router.get('/quiz-link', async (req, res) => {
  const schools = await brand.listSchools();
  const slug = String(req.query.school || (schools[0] || {}).slug || '');
  const students = db.prepare("SELECT id, name, class_name FROM users WHERE role='learner' AND school_slug=? AND status='approved'").all(slug);
  const d = await require('../quizpull').diagnose(slug, students);
  res.render('admin/quizlink', { title: 'Quiz Studio link check', d, schools, slug, students });
});

router.get('/users', async (req, res) => {
  const filter = req.query.status || 'all';
  const qtext = String(req.query.q || '').trim(), fSchool = String(req.query.school || ''), fClass = String(req.query.class || ''), fRole = String(req.query.role || '');
  let users = db.prepare(`SELECT * FROM users ${filter === 'all' ? '' : 'WHERE status = @s'} ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC`).all({ s: filter });
  if (qtext) users = users.filter(u => require('../classes').matches(u, qtext));
  if (fSchool) users = users.filter(u => u.school_slug === fSchool);
  if (fClass) users = users.filter(u => u.class_name === fClass || (u.role === 'teacher' && require('../classes').parseClasses(u).includes(fClass)));
  if (fRole) users = users.filter(u => u.role === fRole);
  const total = users.length;
  users = users.slice(0, 300).map(u => ({ ...u, enrollments: db.prepare(`SELECT e.*, c.title FROM enrollments e JOIN courses c ON c.id=e.course_id WHERE e.user_id=?`).all(u.id) }));
  const schools = await brand.listSchools();
  const classOptions = fSchool ? ((schools.find(s => s.slug === fSchool) || {}).classes || []) : [...new Set(schools.flatMap(s => s.classes || []))];
  res.render('admin/users', { title: 'Users & access requests', users, total, filter, qtext, fSchool, fClass, fRole, classOptions, courses: q.courses.all(), autoApprove: q.getSetting.get('auto_approve')?.value === '1', schools });
});
/* school co-branding: which school a learner belongs to (drives their logo/accent and the quiz launch) */
router.post('/users/:id/school', (req, res) => {
  const u = q.userById.get(req.params.id);
  if (!u) return res.sendStatus(404);
  const slug = String(req.body.school_slug || '').toLowerCase();
  db.prepare('UPDATE users SET school_slug=? WHERE id=?').run(brand.SLUG_RE.test(slug) ? slug : null, u.id);
  flash(req, 'success', slug ? `${u.name} is now with ${slug}.` : `${u.name} has no school set.`);
  res.redirect('/admin/users');
});
router.post('/users/:id/:action', (req, res) => {
  const u = q.userById.get(req.params.id);
  if (!u) return res.sendStatus(404);
  const map = { approve: 'approved', reject: 'rejected', disable: 'disabled', enable: 'approved' };
  const status = map[req.params.action];
  if (status) {
    db.prepare(`UPDATE users SET status=?, approved_at = CASE WHEN ?='approved' THEN COALESCE(approved_at, datetime('now')) ELSE approved_at END WHERE id=?`).run(status, status, u.id);
    q.logEvent.run(u.id, null, null, `user_${req.params.action}`, JSON.stringify({ by: req.user.id }));
    if (status === 'approved') plugins.emit('user:approved', { userId: u.id });
  } else if (req.params.action === 'make-admin') db.prepare(`UPDATE users SET role='admin' WHERE id=?`).run(u.id);
  else if (req.params.action === 'make-learner') db.prepare(`UPDATE users SET role='learner' WHERE id=?`).run(u.id);
  else if (req.params.action === 'delete') db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  res.redirect(req.get('Referer') || '/admin/users');
});
router.post('/settings', (req, res) => {
  q.setSetting.run('auto_approve', req.body.auto_approve === 'on' ? '1' : '0');
  flash(req, 'success', 'Settings saved.');
  res.redirect('/admin/users');
});

function csv(v) { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
module.exports = router;
