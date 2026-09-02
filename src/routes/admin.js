// Admin: course upload, access requests, enrollments, progress reports, settings.
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { db, q, DATA_DIR, courseSummary } = require('../db');
const { requireAdmin, flash } = require('../auth');
const { importPackage, deleteCourse } = require('../scorm');
const plugins = require('../plugins');

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
  res.render('admin/index', { title: 'Admin', stats, recent, widgets: plugins.widgets('adminDashboard'), plugins: plugins.list() });
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

router.post('/courses/upload', upload.single('package'), (req, res) => {
  if (!req.file) { flash(req, 'error', 'Choose a .zip SCORM package.'); return res.redirect('/admin/courses'); }
  try {
    const course = importPackage(req.file.path, { title: req.body.title, description: req.body.description, openEnrollment: req.body.open_enrollment === 'on' });
    q.logEvent.run(req.user.id, course.id, null, 'course_uploaded', JSON.stringify({ title: course.title }));
    flash(req, 'success', `Imported "${course.title}" (${db.prepare('SELECT COUNT(*) n FROM scos WHERE course_id=?').get(course.id).n} SCO(s)).`);
  } catch (e) {
    console.error('[upload]', e);
    flash(req, 'error', `Import failed: ${e.message}`);
  } finally { fs.rmSync(req.file.path, { force: true }); }
  res.redirect('/admin/courses');
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
router.get('/courses/:id', (req, res) => {
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
  res.render('admin/course', { title: course.title, course, scos, learners, heat, allUsers });
});

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
router.get('/users', (req, res) => {
  const filter = req.query.status || 'all';
  const users = db.prepare(`SELECT * FROM users ${filter === 'all' ? '' : 'WHERE status = @s'} ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC`).all({ s: filter })
    .map(u => ({ ...u, enrollments: db.prepare(`SELECT e.*, c.title FROM enrollments e JOIN courses c ON c.id=e.course_id WHERE e.user_id=?`).all(u.id) }));
  res.render('admin/users', { title: 'Users & access requests', users, filter, courses: q.courses.all(), autoApprove: q.getSetting.get('auto_approve')?.value === '1' });
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
