// Learner-facing pages: catalog, dashboard, course page, player, profile.
const express = require('express');
const path = require('path');
const { db, q, DATA_DIR, courseSummary } = require('../db');
const { requireLogin, flash, homeFor } = require('../auth');
const plugins = require('../plugins');
const pathLib = require('../path');
const brand = require('../brand');

const router = express.Router();
const baseUrl = req => (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

router.get('/', (req, res) => {
  if (req.user && req.user.status === 'approved') return res.redirect(homeFor(req.user));
  res.render('home', { title: res.locals.brand ? res.locals.brand.name : 'AI Ninjas Academy', courses: q.courses.all().filter(c => c.is_published) });
});

/* Per-school entry link: academy.aininjas.com/s/darularqam — remembers the school (cookie) so the sign-in page,
   the header and the student's dashboard carry the school's logo and accent. Unknown slugs fall back to the plain home page. */
router.get('/s/:slug', async (req, res) => {
  const slug = String(req.params.slug || '').toLowerCase();
  const b = brand.SLUG_RE.test(slug) ? await brand.fetchBrand(slug) : null;
  if (!b) return res.status(404).render('error', { title: 'Unknown school link', message: `There is no school at /s/${slug}. Check the link your school gave you, or go to the Academy home page.` });
  brand.setCookie(res, b.slug);
  if (req.user && req.user.role !== 'admin' && !req.user.school_slug) db.prepare('UPDATE users SET school_slug=? WHERE id=?').run(b.slug, req.user.id);
  res.redirect(req.user && req.user.status === 'approved' ? homeFor(req.user) : '/');
});

/* Join a live quiz hosted by the teacher: the code on the classroom screen → Quiz Studio, with the student's identity. */
router.get('/live', requireLogin, (req, res) => {
  const code = String(req.query.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (!code) { flash(req, 'error', 'Type the code shown on your teacher\'s screen.'); return res.redirect('/dashboard'); }
  if (!pathLib.quizEnabled()) return res.status(404).render('error', { title: 'Not available', message: 'Live quizzes are not set up on this Academy yet.' });
  if (req.user.role !== 'learner') return res.redirect(`${pathLib.QUIZ_URL}/live/${code}`);
  if (!req.actor) q.logEvent.run(req.user.id, null, null, 'live_joined', JSON.stringify({ code }));
  res.redirect(pathLib.liveJoinUrl({ user: req.user, code, baseUrl: baseUrl(req), actor: req.actor }));
});
router.get('/live/:code', requireLogin, (req, res) => res.redirect('/live?code=' + encodeURIComponent(req.params.code)));

router.get('/dashboard', requireLogin, (req, res) => {
  /* active enrolments only: a scheduled one shows nothing until its start day, an ended one moves to the list below */
  const enrolLib = require('../enrol');
  const mineAll = enrolLib.forStudent(req.user.id);
  const mine = [...mineAll.active, ...mineAll.requested].map(e => ({ ...e, summary: pathLib.pathSummary(req.user.id, e.course_id) }));
  const ended = mineAll.ended.map(e => ({ ...e, summary: pathLib.pathSummary(req.user.id, e.course_id) }));
  const enrolledIds = new Set([...mineAll.active, ...mineAll.requested].map(e => e.course_id));
  // Only courses an admin marked "open enrollment" — and open to this student's school — are offered for self-enrol
  /* A learner already on v1 must not be able to self-enrol in v2 as a separate course — they are
     offered the switch instead, so the catalogue hides every version of a family they are in. */
  const myGroups = new Set([...mineAll.active, ...mineAll.requested, ...mineAll.ended]
    .map(e => q.courseById.get(e.course_id)).filter(Boolean).map(c => c.version_group || c.id));
  const catalog = q.courses.all().filter(c => c.is_published && c.open_enrollment && !enrolledIds.has(c.id)
    && !myGroups.has(c.version_group || c.id) && enrolLib.courseOpenTo(c.id, req.user.school_slug));
  const due = req.user.role === 'learner' ? require('../assign').forStudent(req.user).open.slice(0, 4) : [];
  /* An updated version of a course they are on: offered, never forced, with the numbers they
     need to decide — what changed, and how much of the old one they have already done. */
  const versions = require('../versions');
  const updates = mineAll.active.map(e => {
    const course = q.courseById.get(e.course_id);
    const next = versions.newerThan(course);
    if (!next) return null;
    const declined = db.prepare(`SELECT 1 FROM events WHERE user_id=? AND type='version_declined' AND payload=?`).get(req.user.id, String(next.id));
    if (declined) return null;
    const s = pathLib.pathSummary(req.user.id, course.id);
    return { course, next, percent: s.percent, done: s.done, total: s.total };
  }).filter(Boolean);
  res.render('dashboard', { title: 'My courses', mine, ended, catalog, due, updates, dueNow: require('../assign').nowLocal(), widgets: plugins.widgets('learnerDashboard', req.user) });
});

// Move to the updated version of a course — the learner's own choice, never automatic.
router.post('/courses/:id/switch-version', requireLogin, (req, res) => {
  const versions = require('../versions');
  try {
    const to = versions.switchLearner(req.user.id, +req.params.id);
    q.logEvent.run(req.user.id, to.id, null, 'version_switched', JSON.stringify({ from: +req.params.id }));
    flash(req, 'success', `You are now on the updated "${to.title}". Your progress on the earlier version is kept — ask your teacher if you need it back.`);
  } catch (e) { flash(req, 'error', e.message); }
  res.redirect('/dashboard');
});
// "Stay on this version" — remember the choice so the offer stops nagging
router.post('/courses/:id/keep-version', requireLogin, (req, res) => {
  const versions = require('../versions');
  const next = versions.newerThan(q.courseById.get(+req.params.id));
  if (next) db.prepare(`INSERT INTO events (user_id, course_id, type, payload) VALUES (?, ?, 'version_declined', ?)`).run(req.user.id, +req.params.id, String(next.id));
  res.redirect('/dashboard');
});

// Ask for a course (self-enroll if open, otherwise creates a "requested" enrollment for admin approval)
router.post('/courses/:id/enroll', requireLogin, (req, res) => {
  const course = q.courseById.get(req.params.id);
  if (!course || !course.is_published) return res.status(404).render('error', { title: 'Not found', message: 'Course not found.' });
  if (!require('../enrol').courseOpenTo(course.id, req.user.school_slug)) return res.status(403).render('error', { title: 'Not available', message: 'This course is not offered to your school.' });
  const existing = q.enrollment.get(req.user.id, course.id);
  if (existing && existing.status !== 'ended') { flash(req, 'info', 'You already have a request for this course.'); return res.redirect('/dashboard'); }
  if (existing) { db.prepare(`UPDATE enrollments SET status=?, ended_at=NULL, ends_on=NULL, batch_id=NULL, source='self', enrolled_at=datetime('now') WHERE id=?`).run(course.open_enrollment ? 'active' : 'requested', existing.id); flash(req, 'success', `Welcome back to "${course.title}".`); return res.redirect('/dashboard'); }
  const status = course.open_enrollment ? 'active' : 'requested';
  db.prepare('INSERT INTO enrollments (user_id, course_id, status) VALUES (?, ?, ?)').run(req.user.id, course.id, status);
  q.logEvent.run(req.user.id, course.id, null, status === 'active' ? 'enroll' : 'enroll_requested', null);
  plugins.emit('enrollment:created', { userId: req.user.id, courseId: course.id, status });
  flash(req, 'success', status === 'active' ? `You're enrolled in "${course.title}".` : `Access to "${course.title}" requested — an admin will approve it shortly.`);
  res.redirect('/dashboard');
});

router.get('/courses/:id', requireLogin, (req, res) => {
  const course = q.courseById.get(req.params.id);
  if (!course) return res.status(404).render('error', { title: 'Not found', message: 'Course not found.' });
  const enrollment = q.enrollment.get(req.user.id, course.id);
  if (req.user.role !== 'admin' && (!enrollment || enrollment.status !== 'active')) {
    if (enrollment && enrollment.status === 'ended') return res.status(403).render('error', { title: 'This course has ended', message: `Your access to "${course.title}" ended${enrollment.ends_on ? ' on ' + enrollment.ends_on : ''}. Your progress is saved — ask your teacher if you need it extended.` });
    return res.status(403).render('error', { title: 'No access', message: 'You are not enrolled in this course yet.' });
  }
  const lp = pathLib.pathSummary(req.user.id, course.id);
  res.render('course', { title: course.title, course, lp, justDone: req.query.done || null, quizEnabled: pathLib.quizEnabled(),
                         widgets: plugins.widgets('results', req.user, course) });
});

// ---- Learning-path steps ----
function stepFor(req, res) {
  const course = q.courseById.get(req.params.id);
  if (!course) { res.status(404).render('error', { title: 'Not found', message: 'Course not found.' }); return null; }
  const enrollment = q.enrollment.get(req.user.id, course.id);
  if (req.user.role !== 'admin' && (!enrollment || enrollment.status !== 'active')) { res.status(403).render('error', { title: enrollment && enrollment.status === 'ended' ? 'This course has ended' : 'No access', message: enrollment && enrollment.status === 'ended' ? 'Your access to this course has ended. Your progress is saved.' : 'You are not enrolled in this course.' }); return null; }
  const step = pathLib.pathSummary(req.user.id, course.id).steps.find(s => String(s.id) === String(req.params.stepId));
  if (!step) { res.status(404).render('error', { title: 'Not found', message: 'That step no longer exists.' }); return null; }
  if (step.locked && req.user.role !== 'admin') { flash(req, 'error', `Finish "${step.blockedBy ? step.blockedBy.title : 'the previous step'}" first — this course goes in order.`); res.redirect(`/courses/${course.id}`); return null; }
  return { course, step };
}
// "Continue" / step button: go wherever the step lives
router.get('/courses/:id/steps/:stepId/go', requireLogin, (req, res) => {
  const ctx = stepFor(req, res); if (!ctx) return;
  const { course, step } = ctx;
  if (step.type === 'sco') return res.redirect(`/courses/${course.id}/play/${step.config.sco_id}`);
  if (step.type === 'quiz') {
    if (!pathLib.quizEnabled()) return res.status(500).render('error', { title: 'Quiz not available', message: 'Quiz Studio is not connected to the Academy yet (QUIZ_STUDIO_URL / QUIZ_LAUNCH_SECRET).' });
    if (!req.actor) { pathLib.markStarted(req.user.id, step.id); }
    if (!req.actor) q.logEvent.run(req.user.id, course.id, null, 'quiz_launched', JSON.stringify({ step_id: step.id, quiz_id: step.config.quiz_id }));
    return res.redirect(pathLib.launchUrl({ user: req.user, step, course, baseUrl: baseUrl(req), actor: req.actor }));
  }
  if (step.type === 'colab') {
    if (!req.actor) { pathLib.markStarted(req.user.id, step.id); }
    if (!req.actor) q.logEvent.run(req.user.id, course.id, null, 'colab_opened', JSON.stringify({ step_id: step.id }));
    if (step.config.file) return res.redirect(`/courses/${course.id}/steps/${step.id}/notebook`);   // hand them the file
    return res.redirect(step.config.url);
  }
  if (step.type === 'note') { pathLib.markDone(req.user.id, step.id); return res.redirect(`/courses/${course.id}`); }
  res.redirect(`/courses/${course.id}`);
});
// Practice step with an uploaded notebook: download it (students then upload it to their own Colab)
router.get('/courses/:id/steps/:stepId/notebook', requireLogin, (req, res) => {
  const ctx = stepFor(req, res); if (!ctx) return;
  const { step } = ctx;
  if (step.type !== 'colab' || !step.config.file) return res.status(404).render('error', { title: 'Not found', message: 'This step has no notebook file.' });
  const file = path.join(DATA_DIR, 'notebooks', path.basename(step.config.file));
  if (!require('fs').existsSync(file)) return res.status(404).render('error', { title: 'Not found', message: 'The notebook file is missing — tell your teacher.' });
  if (!req.actor) pathLib.markStarted(req.user.id, step.id);
  res.download(file, step.config.filename || 'notebook.ipynb');
});
// Practice step: student marks it done (optionally with their notebook share link)
router.post('/courses/:id/steps/:stepId/done', requireLogin, (req, res) => {
  const ctx = stepFor(req, res); if (!ctx) return;
  const { course, step } = ctx;
  if (!['colab', 'note'].includes(step.type)) return res.redirect(`/courses/${course.id}`);
  const url = String(req.body.notebook_url || '').trim();
  if (url && !/^https?:\/\//i.test(url)) { flash(req, 'error', 'The notebook link should start with https://'); return res.redirect(`/courses/${course.id}`); }
  pathLib.markDone(req.user.id, step.id, { notebook_url: url || null });
  q.logEvent.run(req.user.id, course.id, null, 'colab_done', JSON.stringify({ step_id: step.id, notebook: !!url }));
  plugins.emit('step:completed', { userId: req.user.id, courseId: course.id, stepId: step.id, type: step.type });
  flash(req, 'success', `Nice — "${step.title}" marked complete.`);
  res.redirect(`/courses/${course.id}`);
});
// Quiz Studio posts scores here (signed with QUIZ_LAUNCH_SECRET)
router.post('/api/quiz-results', express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); } }), (req, res) => {
  if (!pathLib.quizEnabled()) return res.status(404).json({ error: 'Quiz integration not configured' });
  try {
    const r = pathLib.applyQuizResult(req.rawBody || '', req.headers);
    if (r.step) plugins.emit('step:completed', { userId: r.userId, courseId: r.step.course_id, stepId: r.step.id, type: 'quiz' });
    res.json({ ok: true });
  } catch (e) { console.warn('[quiz-results]', e.message); res.status(400).json({ error: e.message }); }
});

// ---- Player page: hosts the SCORM API and the SCO iframe ----
router.get('/courses/:id/play/:scoId', requireLogin, (req, res) => {
  const course = q.courseById.get(req.params.id);
  const sco = q.scoById.get(req.params.scoId);
  if (!course || !sco || sco.course_id !== course.id) return res.status(404).render('error', { title: 'Not found', message: 'SCO not found.' });
  const enrollment = q.enrollment.get(req.user.id, course.id);
  if (req.user.role !== 'admin' && (!enrollment || enrollment.status !== 'active')) {
    return res.status(403).render('error', { title: 'No access', message: 'You are not enrolled in this course.' });
  }
  if (course.sequential && req.user.role !== 'admin') {   // locked sequence: the lesson's step must be reachable
    const st = pathLib.pathSummary(req.user.id, course.id).steps.find(s => s.type === 'sco' && String(s.config.sco_id) === String(sco.id));
    if (st && st.locked) { flash(req, 'error', `Finish "${st.blockedBy ? st.blockedBy.title : 'the previous step'}" first — this course goes in order.`); return res.redirect(`/courses/${course.id}`); }
  }

  // Ensure a progress row exists and compute entry mode
  let p = q.progress.get(req.user.id, sco.id);
  if (req.actor) {                                   // "View as": look, don't touch the student's record
    p = p || { id: 0, lesson_status: 'not attempted', lesson_location: '', suspend_data: '', score_raw: null, score_min: null, score_max: null, total_time: '0000:00:00.00', exit_mode: '', cmi_json: null, first_launched_at: null, attempts: 0 };
  } else if (!p) {
    db.prepare(`INSERT INTO sco_progress (user_id, sco_id, first_launched_at, last_accessed_at, attempts) VALUES (?, ?, datetime('now'), datetime('now'), 1)`).run(req.user.id, sco.id);
    p = q.progress.get(req.user.id, sco.id);
  } else {
    db.prepare(`UPDATE sco_progress SET last_accessed_at = datetime('now'), attempts = attempts + 1 WHERE id = ?`).run(p.id);
  }
  const entry = (p.exit_mode === 'suspend' || p.lesson_status === 'incomplete' || p.lesson_status === 'browsed') ? 'resume' : (p.first_launched_at && p.attempts > 0 && p.lesson_status !== 'not attempted' ? '' : 'ab-initio');
  const saved = p.cmi_json ? JSON.parse(p.cmi_json) : {};
  const initialData = {
    student_id: String(req.user.id), student_name: `${req.user.name}`,
    lesson_location: p.lesson_location, lesson_status: p.lesson_status, entry,
    score_raw: p.score_raw, score_min: p.score_min, score_max: p.score_max,
    total_time: p.total_time, suspend_data: p.suspend_data, launch_data: sco.data_from_lms || '',
    objectives: saved.objectives || [], interactions: [], comments: saved.comments || '',
    max_time_allowed: sco.max_time_allowed || '',
  };
  if (!req.actor) { q.logEvent.run(req.user.id, course.id, sco.id, 'launch', null); plugins.emit('sco:launch', { userId: req.user.id, courseId: course.id, scoId: sco.id }); }

  // Prev / Next follow the learning path (not just the lesson list), so a Colab or quiz step is never skipped.
  // "Next" is only enabled once this lesson is done (or the course isn't locked / the viewer is an admin).
  const lp = pathLib.pathSummary(req.user.id, course.id);
  const pi = lp.steps.findIndex(s => s.type === 'sco' && String(s.config.sco_id) === String(sco.id));
  const cur = pi >= 0 ? lp.steps[pi] : null;
  const nav = st => st ? { title: st.title, kind: st.kind, href: `/courses/${course.id}/steps/${st.id}/go` } : null;
  const nextStep = pi >= 0 ? lp.steps[pi + 1] : null, prevStep = pi >= 0 ? lp.steps[pi - 1] : null;
  const nextOpen = !course.sequential || req.user.role === 'admin' || !!(cur && cur.status === 'done');
  res.render('player', {
    title: sco.title, course, sco, prev: nav(prevStep), next: nav(nextStep), nextOpen, stepId: cur ? cur.id : null,
    launchUrl: `/content/${course.slug}/${sco.launch_href}`,
    config: { scoId: sco.id, commitUrl: `/api/runtime/${sco.id}/commit`, masteryScore: sco.mastery_score, launchData: sco.data_from_lms || '', initialData },
    layout: false,
  });
});

// ---- Runtime commit endpoint (called by scorm-api.js) ----
router.post('/api/runtime/:scoId/commit', express.json({ limit: '1mb' }), (req, res) => {
  if (!req.user || req.user.status !== 'approved') return res.status(401).json({ error: 'not logged in' });
  const sco = q.scoById.get(req.params.scoId);
  if (!sco) return res.status(404).json({ error: 'sco not found' });
  const { cmi, finishing, elapsed_seconds } = req.body || {};
  if (!cmi || !cmi.core) return res.status(400).json({ error: 'bad payload' });

  const prev = q.progress.get(req.user.id, sco.id);
  if (!prev) return res.status(400).json({ error: 'not launched' });

  // session_time: prefer what the SCO reported, else our own elapsed clock. Add to total only when finishing.
  const sessionSecs = parseScormTime(cmi.core.session_time) || 0;
  const addSecs = finishing ? (sessionSecs || Number(elapsed_seconds) || 0) : 0;
  const totalSeconds = prev.total_seconds + addSecs;

  let status = cmi.core.lesson_status || prev.lesson_status;
  const raw = numOrNull(cmi.core.score?.raw);
  // SCORM 1.2 rule: if the SCO never sets status but a mastery score exists, derive pass/fail from score.
  if (finishing && sco.mastery_score != null && raw != null && (status === 'incomplete' || status === 'completed' || status === 'not attempted')) {
    status = raw >= sco.mastery_score ? 'passed' : 'failed';
  }
  const wasDone = ['completed', 'passed'].includes(prev.lesson_status);
  const isDone = ['completed', 'passed'].includes(status);

  db.prepare(`UPDATE sco_progress SET lesson_status=?, lesson_location=?, suspend_data=?, score_raw=?, score_min=?, score_max=?,
              total_seconds=?, total_time=?, exit_mode=?, cmi_json=?, last_accessed_at=datetime('now'),
              completed_at = COALESCE(completed_at, CASE WHEN ? THEN datetime('now') END)
              WHERE id=?`)
    .run(status, cmi.core.lesson_location || '', cmi.suspend_data || '', raw, numOrNull(cmi.core.score?.min), numOrNull(cmi.core.score?.max),
         totalSeconds, toScormTime(totalSeconds), cmi.core.exit || '',
         JSON.stringify({ objectives: cmi.objectives || [], interactions: cmi.interactions || [], comments: cmi.comments || '' }),
         isDone ? 1 : 0, prev.id);

  const ev = { userId: req.user.id, courseId: sco.course_id, scoId: sco.id, status, score: raw, finishing: !!finishing };
  q.logEvent.run(req.user.id, sco.course_id, sco.id, finishing ? 'finish' : 'commit', JSON.stringify({ status, score: raw }));
  plugins.emit('sco:commit', ev);
  if (isDone && !wasDone) {
    q.logEvent.run(req.user.id, sco.course_id, sco.id, status === 'passed' ? 'pass' : 'complete', JSON.stringify({ score: raw }));
    plugins.emit('sco:complete', ev);
    if (status === 'passed') plugins.emit('sco:pass', ev);
  }
  if (status === 'failed' && prev.lesson_status !== 'failed') { q.logEvent.run(req.user.id, sco.course_id, sco.id, 'fail', JSON.stringify({ score: raw })); plugins.emit('sco:fail', ev); }

  // Course-level completion
  const summary = courseSummary(req.user.id, sco.course_id);
  if (summary.status === 'completed') {
    const enr = q.enrollment.get(req.user.id, sco.course_id);
    if (enr && !enr.completed_at) {
      db.prepare(`UPDATE enrollments SET completed_at = datetime('now') WHERE id = ?`).run(enr.id);
      q.logEvent.run(req.user.id, sco.course_id, null, 'course_complete', JSON.stringify({ avgScore: summary.avgScore }));
      plugins.emit('course:complete', { userId: req.user.id, courseId: sco.course_id, avgScore: summary.avgScore });
    }
  }
  res.json({ ok: true, status, percent: summary.percent, courseStatus: summary.status });
});

// ---- Serve course content (only to enrolled users / admins) ----
router.get('/content/:slug/*file', requireLogin, (req, res) => {
  const course = q.courseBySlug.get(req.params.slug);
  if (!course) return res.sendStatus(404);
  if (req.user.role !== 'admin') {
    const e = q.enrollment.get(req.user.id, course.id);
    if (!e || e.status !== 'active') return res.sendStatus(403);
  }
  const root = path.join(DATA_DIR, 'courses', course.slug);
  const file = path.normalize(path.join(root, [].concat(req.params.file).join('/')));
  if (!file.startsWith(root)) return res.sendStatus(403);
  res.sendFile(file, { headers: { 'Cache-Control': 'private, max-age=3600' } }, err => { if (err) res.sendStatus(404); });
});

// ---- Profile: display handle, leaderboard opt-in ----
router.get('/profile', requireLogin, (req, res) => res.render('profile', { title: 'My profile', widgets: plugins.widgets('profile', req.user) }));
router.post('/profile', requireLogin, (req, res) => {
  const handle = String(req.body.display_handle || '').trim().replace(/[^A-Za-z0-9_ -]/g, '').slice(0, 24);
  if (handle) db.prepare('UPDATE users SET display_handle = ? WHERE id = ?').run(handle, req.user.id);
  plugins.emit('user:profile', { userId: req.user.id, body: req.body });
  flash(req, 'success', 'Profile saved.');
  res.redirect('/profile');
});

// ---- helpers ----
function numOrNull(v) { if (v === '' || v == null) return null; const n = Number(v); return isNaN(n) ? null : n; }
function parseScormTime(t) {  // HHHH:MM:SS.SS -> seconds
  const m = String(t || '').match(/^(\d{2,4}):(\d{2}):(\d{2})(?:\.(\d{1,2}))?$/);
  if (!m) return 0;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (m[4] ? Number('0.' + m[4]) : 0);
}
function toScormTime(s) {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${String(h).padStart(4, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.00`;
}

module.exports = router;
