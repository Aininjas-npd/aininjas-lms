'use strict';
/*
 * "Teach this to this class" — the front-of-room mode.
 *
 * Everything here is scoped to a class the caller may actually see (classesLib.scopeFor), and
 * writes only to the class's own record in teach.js. A student's progress is never touched, and
 * nothing a teacher does here marks a lesson done for anybody.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, q, DATA_DIR } = require('../db');
const { requireStaff, flash } = require('../auth');
const classesLib = require('../classes');
const pathLib = require('../path');
const teach = require('../teach');
const plugins = require('../plugins');

const router = express.Router();

/** Resolve the class from the URL and refuse it if this member of staff has no business there. */
async function classCtx(req, res) {
  const scope = await classesLib.scopeFor(req.user, String(req.query.school || ''));
  const name = req.params.name;
  if (!scope.school || !(scope.all || scope.classes.includes(name))) {
    res.status(403).render('error', { title: 'Not your class', message: 'You can only teach the classes assigned to you.' });
    return null;
  }
  return { scope, school: scope.school.slug, name };
}

/* ------------------------------------------------------------- § the class -- */

/** Every course this class has, and how far through each the CLASS has been taught. */
router.get('/classes/:name/teach', requireStaff, async (req, res) => {
  const ctx = await classCtx(req, res); if (!ctx) return;
  res.render('teach/index', {
    title: `Teach ${ctx.name}`,
    sc: ctx.scope, name: ctx.name,
    courses: teach.coursesFor(ctx.school, ctx.name),
  });
});

/** One course: the path, what has been taught, and where to pick up. */
router.get('/classes/:name/teach/:courseId', requireStaff, async (req, res) => {
  const ctx = await classCtx(req, res); if (!ctx) return;
  const course = q.courseById.get(req.params.courseId);
  if (!course) return res.status(404).render('error', { title: 'Not found', message: 'Course not found.' });
  if (!require('../enrol').courseOpenTo(course.id, ctx.school)) {
    return res.status(403).render('error', { title: 'Not available', message: 'That course is not offered to your school.' });
  }
  const progress = teach.courseProgress(ctx.school, ctx.name, course.id, req.user);
  const stepFiles = require('../stepfiles').forSteps(progress.items.map(i => i.step.id));
  res.render('teach/course', {
    title: `${course.title} · ${ctx.name}`,
    sc: ctx.scope, name: ctx.name, course, progress, stepFiles,
    enrolled: db.prepare(`SELECT COUNT(*) n FROM enrollments e JOIN users u ON u.id=e.user_id
                          WHERE e.course_id=? AND e.status='active' AND u.school_slug=? AND u.class_name=?`)
      .get(course.id, ctx.school, ctx.name).n,
  });
});

/** Resume: straight to whatever comes next, so the teacher can go from the class list to teaching. */
router.get('/classes/:name/teach/:courseId/resume', requireStaff, async (req, res) => {
  const ctx = await classCtx(req, res); if (!ctx) return;
  const course = q.courseById.get(req.params.courseId);
  if (!course) return res.status(404).render('error', { title: 'Not found', message: 'Course not found.' });
  const p = teach.courseProgress(ctx.school, ctx.name, course.id);
  const back = `/classes/${encodeURIComponent(ctx.name)}/teach/${course.id}`;
  if (!p.next) { flash(req, 'success', `${ctx.name} has been through every step of "${course.title}".`); return res.redirect(back); }
  if (p.next.kind === 'sco' && p.next.scoId) return res.redirect(`${back}/play/${p.next.scoId}`);
  return res.redirect(`${back}#step-${p.next.step.id}`);
});

/* ---------------------------------------------------------------- § player -- */

router.get('/classes/:name/teach/:courseId/play/:scoId', requireStaff, async (req, res) => {
  const ctx = await classCtx(req, res); if (!ctx) return;
  const course = q.courseById.get(req.params.courseId);
  const sco = q.scoById.get(req.params.scoId);
  if (!course || !sco || sco.course_id !== course.id) return res.status(404).render('error', { title: 'Not found', message: 'Lesson not found.' });
  if (!require('../enrol').courseOpenTo(course.id, ctx.school)) {
    return res.status(403).render('error', { title: 'Not available', message: 'That course is not offered to your school.' });
  }

  const row = teach.open(ctx.school, ctx.name, course.id, sco.id, req.user.id);
  const saved = row.cmi_json ? JSON.parse(row.cmi_json) : {};
  const initialData = {
    /* The SCO is told it is being run for the class, not for a person. Some packages print the
       name on screen, and "Grade 9" on the projector is right where a teacher's name would be odd. */
    student_id: `class-${ctx.school}-${ctx.name}`.replace(/\s+/g, '-'),
    student_name: ctx.name,
    lesson_location: row.lesson_location, lesson_status: row.lesson_status, entry: teach.entryFor(row),
    score_raw: null, score_min: null, score_max: null,
    total_time: '0000:00:00.00', suspend_data: row.suspend_data, launch_data: sco.data_from_lms || '',
    objectives: saved.objectives || [], interactions: [], comments: saved.comments || '',
    max_time_allowed: sco.max_time_allowed || '',
  };

  const p = teach.courseProgress(ctx.school, ctx.name, course.id);
  const i = p.items.findIndex(x => x.kind === 'sco' && String(x.scoId) === String(sco.id));
  const base = `/classes/${encodeURIComponent(ctx.name)}/teach/${course.id}`;
  const nav = it => it ? {
    title: it.step.title, kind: it.step.kind || it.kind,
    href: it.kind === 'sco' && it.scoId ? `${base}/play/${it.scoId}` : `${base}#step-${it.step.id}`,
  } : null;

  q.logEvent.run(req.user.id, course.id, sco.id, 'class_launch', JSON.stringify({ class: ctx.name, school: ctx.school }));

  res.render('player', {
    title: `${sco.title} · ${ctx.name}`,
    course, sco,
    prev: nav(i > 0 ? p.items[i - 1] : null),
    next: nav(i >= 0 ? p.items[i + 1] : null),
    nextOpen: true,                       // a teacher moves through at her own pace
    stepId: i >= 0 ? p.items[i].step.id : null,
    exitUrl: base,
    teaching: { className: ctx.name, school: ctx.school },
    launchUrl: `/content/${course.slug}/${sco.launch_href}`,
    config: {
      scoId: sco.id,
      commitUrl: `${base}/play/${sco.id}/commit`,
      masteryScore: sco.mastery_score, launchData: sco.data_from_lms || '', initialData,
    },
    layout: false,
  });
});

/** The class's runtime commit. Same shape as the learner one, different record. */
router.post('/classes/:name/teach/:courseId/play/:scoId/commit', requireStaff, express.json({ limit: '1mb' }), async (req, res) => {
  const scope = await classesLib.scopeFor(req.user, String(req.query.school || ''));
  const name = req.params.name;
  if (!scope.school || !(scope.all || scope.classes.includes(name))) return res.status(403).json({ error: 'not your class' });
  const sco = q.scoById.get(req.params.scoId);
  if (!sco) return res.status(404).json({ error: 'sco not found' });
  const { cmi, finishing, elapsed_seconds } = req.body || {};
  if (!cmi || !cmi.core) return res.status(400).json({ error: 'bad payload' });

  const row = teach.rowFor(scope.school.slug, name, sco.id);
  if (!row) return res.status(400).json({ error: 'not launched' });

  const secs = Number(elapsed_seconds) || 0;
  const status = cmi.core.lesson_status || row.lesson_status;
  db.prepare(`UPDATE class_lessons SET lesson_status=?, lesson_location=?, suspend_data=?, exit_mode=?, cmi_json=?,
              total_seconds = total_seconds + ?, last_taught_at=datetime('now'), last_taught_by=? WHERE id=?`)
    .run(status, cmi.core.lesson_location || '', cmi.suspend_data || '', cmi.core.exit || '',
      JSON.stringify({ objectives: cmi.objectives || [], interactions: cmi.interactions || [], comments: cmi.comments || '' }),
      finishing ? secs : 0, req.user.id, row.id);

  res.json({ ok: true, status });
});

/* ------------------------------------------------------------- § the code --- */

/**
 * Put the exercise on the projector.
 *
 * Students type the code into their own Colab, so what the room needs is the notebook's cells,
 * large and readable, with nothing else on screen — not a download, and not the teacher's own
 * Colab tab with her solutions three cells further down.
 *
 * A step that is only a link to Colab has no cells to show, so it offers the link instead.
 */
router.get('/classes/:name/teach/:courseId/steps/:stepId/code', requireStaff, async (req, res) => {
  const ctx = await classCtx(req, res); if (!ctx) return;
  const course = q.courseById.get(req.params.courseId);
  if (!course) return res.status(404).render('error', { title: 'Not found', message: 'Course not found.' });
  const step = pathLib.stepsFor(course.id).find(s => String(s.id) === String(req.params.stepId));
  if (!step || step.type !== 'colab') return res.status(404).render('error', { title: 'Not found', message: 'That step has no code to show.' });

  let cells = null, readError = null;
  if (step.config.file) {
    const file = path.join(DATA_DIR, 'notebooks', path.basename(step.config.file));
    try {
      const nb = JSON.parse(fs.readFileSync(file, 'utf8'));
      cells = (nb.cells || []).map(c => ({
        type: c.cell_type,
        source: Array.isArray(c.source) ? c.source.join('') : String(c.source || ''),
      })).filter(c => c.source.trim());
    } catch (e) {
      readError = e.code === 'ENOENT' ? 'The notebook file is missing from the server.' : 'That notebook could not be read as a Jupyter file.';
    }
  }

  res.render('teach/code', {
    title: `${step.title} · ${ctx.name}`,
    sc: ctx.scope, name: ctx.name, course, step, cells, readError,
    files: require('../stepfiles').forSteps([step.id])[step.id] || [],
    covered: teach.coveredSteps(ctx.school, ctx.name).has(step.id),
    layout: false,
  });
});

/* ------------------------------------------------------------ § live quiz --- */

/**
 * Hand over to Quiz Studio's live host, with the quiz and class already chosen. The session
 * itself belongs to Quiz Studio — it owns the codes, the players and the scoring — so this is a
 * signpost, not a second implementation of it.
 */
router.get('/classes/:name/teach/:courseId/steps/:stepId/live', requireStaff, async (req, res) => {
  const ctx = await classCtx(req, res); if (!ctx) return;
  const course = q.courseById.get(req.params.courseId);
  if (!course) return res.status(404).render('error', { title: 'Not found', message: 'Course not found.' });
  const step = pathLib.stepsFor(course.id).find(s => String(s.id) === String(req.params.stepId));
  if (!step || step.type !== 'quiz') return res.status(404).render('error', { title: 'Not found', message: 'That step is not a quiz.' });
  if (!pathLib.quizEnabled()) {
    return res.status(404).render('error', { title: 'Not available', message: 'Live quizzes are not set up on this Academy yet.' });
  }
  const url = `${pathLib.QUIZ_URL}/admin/live?quiz=${encodeURIComponent(step.config.quiz_id)}&class=${encodeURIComponent(ctx.name)}`;
  res.redirect(url);
});

/* ----------------------------------------------------------------- § steps -- */

/** Tick off a Colab, a live quiz or a note as covered in class (or untick it). */
router.post('/classes/:name/teach/:courseId/steps/:stepId/covered', requireStaff, async (req, res) => {
  const ctx = await classCtx(req, res); if (!ctx) return;
  const stepId = Number(req.params.stepId);
  const back = `/classes/${encodeURIComponent(ctx.name)}/teach/${req.params.courseId}`;
  const step = pathLib.stepsFor(req.params.courseId).find(s => s.id === stepId);
  if (!step) { flash(req, 'error', 'That step no longer exists.'); return res.redirect(back); }

  if (req.body.undo === '1') {
    teach.unmarkStep(ctx.school, ctx.name, stepId);
    flash(req, 'success', `"${step.title}" is back on the list.`);
  } else {
    teach.markStep(ctx.school, ctx.name, stepId, req.user.id);
    flash(req, 'success', `"${step.title}" marked as covered with ${ctx.name}. This does not mark it done for any student.`);
  }
  res.redirect(back + '#step-' + stepId);
});

/** Reset the class's place in one lesson — for teaching it again from the start next year. */
router.post('/classes/:name/teach/:courseId/reset', requireStaff, async (req, res) => {
  const ctx = await classCtx(req, res); if (!ctx) return;
  const back = `/classes/${encodeURIComponent(ctx.name)}/teach/${req.params.courseId}`;
  if (req.body.sco_id) {
    db.prepare('DELETE FROM class_lessons WHERE school_slug=? AND class_name=? AND sco_id=?')
      .run(ctx.school, ctx.name, Number(req.body.sco_id));
    flash(req, 'success', 'That lesson will start from the beginning next time.');
  } else {
    db.prepare('DELETE FROM class_lessons WHERE school_slug=? AND class_name=? AND course_id=?')
      .run(ctx.school, ctx.name, Number(req.params.courseId));
    for (const st of pathLib.stepsFor(req.params.courseId)) teach.unmarkStep(ctx.school, ctx.name, st.id);
    flash(req, 'success', `Cleared where ${ctx.name} had got to. Student progress is untouched.`);
  }
  res.redirect(back);
});

module.exports = router;
