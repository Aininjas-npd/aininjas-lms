// Assignments and grading (Phase C).
//   staff:   /classes/:name/assignments (+ /new, /:id, /:id/edit, actions), /classes/:name/gradebook (+ .csv, classwork columns)
//   student: /assignments, /assignments/:id, item launch + done, quiz launches with the assignment context
const express = require('express');
const { db, q } = require('../db');
const { requireLogin, requireStaff, flash } = require('../auth');
const classesLib = require('../classes');
const pathLib = require('../path');
const assign = require('../assign');
const plugins = require('../plugins');

const router = express.Router();
const baseUrl = req => (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const enc = s => encodeURIComponent(s);

/* ---------- staff scope: the class must be one this person may see ---------- */
async function classScope(req, res) {
  const scope = await classesLib.scopeFor(req.user, String(req.query.school || req.body && req.body.school || ''));
  const name = req.params.name;
  if (!scope.school || !(scope.all || scope.classes.includes(name))) { res.status(403).render('error', { title: 'Not your class', message: 'You can only see the classes assigned to you.' }); return null; }
  return { scope, name, qs: req.user.role === 'admin' ? '?school=' + enc(scope.school.slug) : '', base: `/classes/${enc(name)}` };
}
function ownedAssignment(req, res, ctx) {
  const a = assign.byId(req.params.id);
  if (!a || a.school_slug !== ctx.scope.school.slug || a.class_name !== ctx.name) { res.status(404).render('error', { title: 'Not found', message: 'That assignment does not exist in this class.' }); return null; }
  return a;
}
async function quizChoices() {
  try { return (await pathLib.listQuizzes()).map(qz => ({ id: qz.id, title: qz.title, modules: qz.modules || [] })); } catch (e) { return []; }
}

/** g[u<userId>][i<itemId>] → [[userId, [[itemId, value]…]]…] */
function gradeInputs(g) {
  if (!g || typeof g !== 'object') return [];
  return Object.keys(g).filter(k => /^u\d+$/.test(k)).map(k => [k.slice(1), Object.keys(g[k] || {}).filter(i => /^i\d+$/.test(i)).map(i => [i.slice(1), g[k][i]])]);
}

/* ---------- list ---------- */
router.get('/classes/:name/assignments', requireStaff, async (req, res) => {
  const ctx = await classScope(req, res); if (!ctx) return;
  const list = assign.listFor(ctx.scope.school.slug, ctx.name).map(a => ({ ...a, ...assign.roster(a).summary }));
  res.render('assign/list', { title: `${ctx.name} · Assignments`, ctx, list });
});

/* ---------- builder ---------- */
router.get('/classes/:name/assignments/new', requireStaff, async (req, res) => {
  const ctx = await classScope(req, res); if (!ctx) return;
  res.render('assign/form', { title: `New assignment · ${ctx.name}`, ctx, a: null, sources: assign.stepSources(ctx.scope.school.slug, ctx.name), quizzes: await quizChoices(), kind: String(req.query.kind || 'homework') });
});
router.post('/classes/:name/assignments', requireStaff, async (req, res) => {
  const ctx = await classScope(req, res); if (!ctx) return;
  try {
    const a = assign.create({ school_slug: ctx.scope.school.slug, class_name: ctx.name, teacher_id: req.user.id, kind: req.body.kind, title: req.body.title, instructions: req.body.instructions, due_at: req.body.due_at, items: req.body.items_json, max_points: req.body.max_points });
    if (req.body.action === 'publish') { assign.publish(a.id); flash(req, 'success', `“${a.title}” is published — ${assign.studentsOf(a.school_slug, a.class_name).length} students can see it.`); }
    else flash(req, 'success', `“${a.title}” saved as a draft. Publish it when it's ready.`);
    q.logEvent.run(req.user.id, null, null, 'assignment_created', JSON.stringify({ assignment_id: a.id, class_name: ctx.name, kind: a.kind, published: req.body.action === 'publish' }));
    res.redirect(`${ctx.base}/assignments/${a.id}${ctx.qs}`);
  } catch (e) { flash(req, 'error', e.message); res.redirect(`${ctx.base}/assignments/new${ctx.qs}`); }
});
router.get('/classes/:name/assignments/:id/edit', requireStaff, async (req, res) => {
  const ctx = await classScope(req, res); if (!ctx) return; const a = ownedAssignment(req, res, ctx); if (!a) return;
  res.render('assign/form', { title: `Edit · ${a.title}`, ctx, a, sources: assign.stepSources(ctx.scope.school.slug, ctx.name), quizzes: await quizChoices(), kind: a.kind });
});
router.post('/classes/:name/assignments/:id/edit', requireStaff, async (req, res) => {
  const ctx = await classScope(req, res); if (!ctx) return; const a = ownedAssignment(req, res, ctx); if (!a) return;
  try {
    assign.update(a.id, { title: req.body.title, instructions: req.body.instructions, due_at: req.body.due_at, kind: req.body.kind, max_points: req.body.max_points, items: a.published ? undefined : req.body.items_json });
    if (req.body.action === 'publish') assign.publish(a.id);
    flash(req, 'success', 'Saved.');
  } catch (e) { flash(req, 'error', e.message); }
  res.redirect(`${ctx.base}/assignments/${a.id}${ctx.qs}`);
});

/* ---------- one assignment: status + grading ---------- */
router.get('/classes/:name/assignments/:id', requireStaff, async (req, res) => {
  const ctx = await classScope(req, res); if (!ctx) return; const a = ownedAssignment(req, res, ctx); if (!a) return;
  const { rows, summary } = assign.roster(a);
  res.render('assign/detail', { title: a.title, ctx, a, rows, summary, quizUrl: pathLib.QUIZ_URL });
});
router.post('/classes/:name/assignments/:id/:action', requireStaff, async (req, res) => {
  const ctx = await classScope(req, res); if (!ctx) return; const a = ownedAssignment(req, res, ctx); if (!a) return;
  const back = `${ctx.base}/assignments/${a.id}${ctx.qs}`;
  const act = req.params.action;
  if (act === 'publish') { assign.publish(a.id); flash(req, 'success', 'Published — students can see it now.'); return res.redirect(back); }
  if (act === 'unpublish') { assign.unpublish(a.id); flash(req, 'success', 'Taken back to draft; students no longer see it.'); return res.redirect(back); }
  if (act === 'release') { assign.release(a.id, true); flash(req, 'success', 'Grades released — students can see their marks and your comments.'); return res.redirect(back); }
  if (act === 'unrelease') { assign.release(a.id, false); flash(req, 'success', 'Grades hidden from students again.'); return res.redirect(back); }
  if (act === 'delete') { assign.remove(a.id); flash(req, 'success', `“${a.title}” deleted.`); return res.redirect(`${ctx.base}/assignments${ctx.qs}`); }
  if (act === 'grades') {
    /* inputs: g[u<userId>][i<itemId>] = points, c[u<userId>] = comment (letter prefixes keep qs from turning ids into arrays) */
    const g = gradeInputs(req.body.g), c = req.body.c || {};
    const students = new Set(assign.studentsOf(a.school_slug, a.class_name).map(u => String(u.id)));
    db.transaction(() => {
      for (const [uid, items] of g) { if (!students.has(uid)) continue; for (const [itemId, v] of items) { if (!a.items.some(i => String(i.id) === itemId)) continue; assign.setGrade(+itemId, +uid, v, req.user.id); } }
      for (const k of Object.keys(c)) { const uid = k.replace(/^u/, ''); if (students.has(uid)) assign.setComment(a.id, +uid, c[k], req.user.id); }
    })();
    if (req.body.release === '1') assign.release(a.id, true);
    flash(req, 'success', `Grades saved${req.body.release === '1' ? ' and released' : ''}.`);
    return res.redirect(back);
  }
  res.redirect(back);
});

/* ---------- gradebook ---------- */
router.get('/classes/:name/gradebook', requireStaff, async (req, res) => {
  const ctx = await classScope(req, res); if (!ctx) return;
  const gb = assign.gradebook(ctx.scope.school.slug, ctx.name);
  res.render('assign/gradebook', { title: `${ctx.name} · Gradebook`, ctx, gb });
});
router.get('/classes/:name/gradebook.csv', requireStaff, async (req, res) => {
  const ctx = await classScope(req, res); if (!ctx) return;
  const gb = assign.gradebook(ctx.scope.school.slug, ctx.name);
  const csv = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const head = ['Student', 'Email', 'Class', ...gb.assignments.map(a => `${a.title} (/${a.total})`), 'Total', 'Out of'];
  const lines = [head.map(csv).join(',')];
  gb.rows.forEach(r => lines.push([r.user.name, r.user.email, r.user.class_name, ...r.cells.map(c => c.total == null ? '' : c.total), r.sum == null ? '' : r.sum, r.sumMax].map(csv).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${ctx.name.replace(/[^\w.-]+/g, '_')}-gradebook.csv"`);
  res.send('﻿' + lines.join('\n'));
});
/** Quick classwork column: a published classwork assignment with one freeform item, graded straight in the gradebook. */
router.post('/classes/:name/gradebook/column', requireStaff, async (req, res) => {
  const ctx = await classScope(req, res); if (!ctx) return;
  try {
    const a = assign.create({ school_slug: ctx.scope.school.slug, class_name: ctx.name, teacher_id: req.user.id, kind: 'classwork', title: req.body.title, due_at: req.body.due_at,
      items: [{ type: 'freeform', title: req.body.title, points: req.body.points || 10 }] });
    assign.publish(a.id); assign.release(a.id, true);
    flash(req, 'success', `Column “${a.title}” added.`);
  } catch (e) { flash(req, 'error', e.message); }
  res.redirect(`${ctx.base}/gradebook${ctx.qs}`);
});
/** Inline gradebook entry: g[<userId>][<itemId>] */
router.post('/classes/:name/gradebook', requireStaff, async (req, res) => {
  const ctx = await classScope(req, res); if (!ctx) return;
  const g = gradeInputs(req.body.g);
  const students = new Set(assign.studentsOf(ctx.scope.school.slug, ctx.name).map(u => String(u.id)));
  const items = new Set(assign.listFor(ctx.scope.school.slug, ctx.name, { includeDrafts: false }).flatMap(a => a.items.map(i => String(i.id))));
  db.transaction(() => { for (const [uid, its] of g) { if (!students.has(uid)) continue; for (const [itemId, v] of its) if (items.has(itemId)) assign.setGrade(+itemId, +uid, v, req.user.id); } })();
  flash(req, 'success', 'Gradebook saved.');
  res.redirect(`${ctx.base}/gradebook${ctx.qs}`);
});

/* ======================= students ======================= */
router.get('/assignments', requireLogin, (req, res) => {
  const { open, past } = assign.forStudent(req.user);
  res.render('assign/mine', { title: 'Assignments', open, past, now: assign.nowLocal() });
});
function mine(req, res) {
  const a = assign.byId(req.params.id);
  const ok = a && a.published && req.user.role === 'learner' ? (a.school_slug === req.user.school_slug && a.class_name === req.user.class_name) : !!(a && req.user.role === 'admin');
  if (!ok) { res.status(404).render('error', { title: 'Not found', message: 'That assignment is not available to you.' }); return null; }
  return a;
}
router.get('/assignments/:id', requireLogin, (req, res) => {
  const a = mine(req, res); if (!a) return;
  const st = assign.statusFor(a, req.user.id);
  const done = req.query.done ? st.items.find(i => String(i.id) === String(req.query.done)) : null;
  res.render('assign/one', { title: a.title, a, st, now: assign.nowLocal(), justDone: done && done.done ? done : null });
});
/** Open an item: lesson → the course player, quiz → signed launch with the assignment context, Colab → the notebook. */
router.get('/assignments/:id/items/:itemId/go', requireLogin, (req, res) => {
  const a = mine(req, res); if (!a) return;
  const it = a.items.find(i => String(i.id) === String(req.params.itemId));
  if (!it) return res.status(404).render('error', { title: 'Not found', message: 'That item no longer exists.' });
  const back = `/assignments/${a.id}`;
  const course = it.ref.course_id ? q.courseById.get(it.ref.course_id) : null;
  if (course && req.user.role === 'learner') { const e = q.enrollment.get(req.user.id, course.id); if (!e || e.status !== 'active') { flash(req, 'error', `You are not enrolled in “${course.title}” — ask your teacher.`); return res.redirect(back); } }
  if (!req.actor) assign.markStarted(it.id, req.user.id);
  if (it.type === 'sco') {
    const scoId = it.ref.sco_id || (it.ref.step_id && course ? (pathLib.stepsFor(course.id).find(s => String(s.id) === String(it.ref.step_id)) || { config: {} }).config.sco_id : null);
    if (!course || !scoId) { flash(req, 'error', 'This lesson is not available any more.'); return res.redirect(back); }
    return res.redirect(`/courses/${course.id}/play/${scoId}`);
  }
  if (it.type === 'quiz') {
    if (!pathLib.quizEnabled()) return res.status(500).render('error', { title: 'Quiz not available', message: 'Quiz Studio is not connected to the Academy yet.' });
    const step = it.ref.step_id && course ? pathLib.stepsFor(course.id).find(s => String(s.id) === String(it.ref.step_id) && s.custom) : null;
    if (step && !req.actor) pathLib.markStarted(req.user.id, step.id);
    if (!req.actor) q.logEvent.run(req.user.id, course ? course.id : null, null, 'quiz_launched', JSON.stringify({ assignment_item_id: it.id, quiz_id: it.ref.quiz_id }));
    return res.redirect(pathLib.launchUrl({ user: req.user, step: step || null, course: course || null, baseUrl: baseUrl(req), actor: req.actor, assignment: { id: a.id, item_id: it.id, quiz_id: it.ref.quiz_id, modules: it.modules } }));
  }
  if (it.type === 'colab') {
    const step = it.ref.step_id && course ? pathLib.stepsFor(course.id).find(s => String(s.id) === String(it.ref.step_id)) : null;
    if (step && step.custom) { if (!req.actor) pathLib.markStarted(req.user.id, step.id); return res.redirect(`/courses/${course.id}/steps/${step.id}/go`); }
    if (/^https?:\/\//i.test(it.ref.url || '')) return res.redirect(it.ref.url);
    flash(req, 'error', 'This notebook has no link.'); return res.redirect(back);
  }
  res.redirect(back);
});
/** Student marks a lesson part / Colab / task done (with an optional notebook link or note). */
router.post('/assignments/:id/items/:itemId/done', requireLogin, (req, res) => {
  const a = mine(req, res); if (!a) return;
  const it = a.items.find(i => String(i.id) === String(req.params.itemId));
  const back = `/assignments/${a.id}`;
  if (!it || it.type === 'quiz') return res.redirect(back);
  const url = String(req.body.notebook_url || '').trim(), note = String(req.body.note || '').trim().slice(0, 1000);
  if (url && !/^https?:\/\//i.test(url)) { flash(req, 'error', 'The notebook link should start with https://'); return res.redirect(back); }
  assign.markSubmitted(it.id, req.user.id, { notebook_url: url || null, note: note || null });
  // a course step done from the assignment counts for the course too
  if (it.ref.step_id && it.ref.course_id && it.type === 'colab') { const step = pathLib.stepsFor(it.ref.course_id).find(s => String(s.id) === String(it.ref.step_id) && s.custom); if (step) pathLib.markDone(req.user.id, step.id, { notebook_url: url || null }); }
  q.logEvent.run(req.user.id, it.ref.course_id || null, null, 'assignment_item_done', JSON.stringify({ assignment_id: a.id, item_id: it.id, type: it.type }));
  plugins.emit('assignment:item_done', { userId: req.user.id, assignmentId: a.id, itemId: it.id, type: it.type });
  flash(req, 'success', `“${it.title}” handed in.`);
  res.redirect(back);
});

module.exports = router;
