'use strict';
/*
 * The curriculum, from a teacher's side of the desk.
 *
 * Building curricula is an AI Ninjas job and stays in /admin. What a teacher needs is narrower and
 * happens every September: "my Grade 9 is supposed to do Level 2 — put them on it." Until now that
 * meant asking someone with an admin account, or enrolling seven courses one at a time and hoping
 * the order matched.
 *
 * So: one page per class, showing the curriculum suggested for that grade, in order, with what the
 * class already has — and the same preview-then-confirm enrolment the admin screen uses, because
 * the rules about dates, exclusions and students who already own a course belong in one place
 * (enrol.js) rather than being reimplemented for teachers.
 *
 * What a teacher may reach is bounded twice over: the class must be hers (classesLib.scopeFor), and
 * the curriculum must be offered to her school (curriculum.openTo). Deciding WHICH curriculum a
 * grade is on is a school-wide call, so that stays with school admins and above.
 */
const express = require('express');
const { requireStaff, flash } = require('../auth');
const classesLib = require('../classes');
const cur = require('../curriculum');
const enrol = require('../enrol');

const router = express.Router();

const ids = v => (Array.isArray(v) ? v : v == null ? [] : [v]).map(Number).filter(Boolean);
const mayMapGrades = user => user.role === 'admin' || user.role === 'school_admin';

/** The class, refused unless this member of staff teaches it. */
async function classCtx(req, res) {
  const scope = await classesLib.scopeFor(req.user, String(req.query.school || req.body?.school || ''));
  const name = req.params.name;
  if (!scope.school || !(scope.all || scope.classes.includes(name))) {
    res.status(403).render('error', { title: 'Not your class', message: 'You can only see the classes assigned to you.' });
    return null;
  }
  return { scope, school: scope.school.slug, name };
}

/** A curriculum this school may actually use, or null. Never trust the id in the URL. */
function pick(id, school) {
  const c = id ? cur.byId(id) : null;
  return c && c.is_published && cur.openTo(c.id, school) ? c : null;
}

/* ------------------------------------------------------------- § the page -- */

router.get('/classes/:name/curriculum', requireStaff, async (req, res) => {
  const ctx = await classCtx(req, res); if (!ctx) return;

  const year = cur.currentYear();
  const suggestedRaw = cur.forGrade(ctx.school, ctx.name, year);
  const suggested = suggestedRaw ? pick(suggestedRaw.id, ctx.school) : null;
  const offered = cur.forSchool(ctx.school);

  /* Chosen from the list, or the suggestion. A suggestion the school is no longer offered is
     reported rather than silently swapped for something else. */
  const chosen = pick(Number(req.query.c) || (suggested && suggested.id), ctx.school);

  res.render('classes/curriculum', {
    title: `Curriculum · ${ctx.name}`,
    sc: ctx.scope, name: ctx.name, year,
    suggested, offered, chosen,
    withdrawn: !!(suggestedRaw && !suggested),
    suggestedTitle: suggestedRaw ? suggestedRaw.title : null,
    /* applyPreview writes nothing — it is the same read the confirm screen uses, so the page can
       show "12 would be enrolled, 3 already have it" before anyone commits to anything. */
    p: chosen ? cur.applyPreview({ curriculumId: chosen.id, schoolSlug: ctx.school, classes: [ctx.name] }) : null,
    canMap: mayMapGrades(req.user),
  });
});

/* --------------------------------------------------------------- § enrol --- */

/** Step one: what this would do. Nothing is written. */
router.post('/classes/:name/curriculum/preview', requireStaff, async (req, res) => {
  const ctx = await classCtx(req, res); if (!ctx) return;
  const back = `/classes/${encodeURIComponent(ctx.name)}/curriculum`;
  const c = pick(Number(req.body.curriculum_id), ctx.school);
  if (!c) { flash(req, 'error', 'Pick a curriculum your school is offered.'); return res.redirect(back); }

  const p = cur.applyPreview({
    curriculumId: c.id, schoolSlug: ctx.school, classes: [ctx.name], excludeUserIds: ids(req.body.exclude),
  });
  res.render('admin/curriculum-apply', {
    title: `Apply ${c.title}`, c, p, school: ctx.school, classes: [ctx.name], sc: ctx.scope,
    startsOn: req.body.starts_on || '', endsOn: req.body.ends_on || '',
    actionUrl: `${back}/apply`, cancelUrl: `${back}?c=${c.id}`, backHref: back, backLabel: `← ${ctx.name}`,
  });
});

/** Step two: she has seen the list and said yes. */
router.post('/classes/:name/curriculum/apply', requireStaff, async (req, res) => {
  const ctx = await classCtx(req, res); if (!ctx) return;
  const back = `/classes/${encodeURIComponent(ctx.name)}/curriculum`;
  const c = pick(Number(req.body.curriculum_id), ctx.school);
  if (!c) { flash(req, 'error', 'Pick a curriculum your school is offered.'); return res.redirect(back); }

  try {
    const courseIds = ids(req.body.course_ids);
    if (!courseIds.length) throw new Error('Every course was unticked, so there is nothing to enrol anyone in.');
    const { batch, applied } = enrol.createBatch({
      schoolSlug: ctx.school, classes: [ctx.name], courseIds,
      startsOn: req.body.starts_on, endsOn: req.body.ends_on,
      excludeUserIds: ids(req.body.exclude),
      note: `Curriculum: ${c.title}`,
      by: req.user.id,
    });
    const n = applied ? applied.enrolled + applied.reactivated : 0;
    flash(req, 'success', batch.status === 'pending'
      ? `"${c.title}" is scheduled for ${ctx.name} on ${batch.starts_on}.`
      : `${ctx.name}: ${n} enrolment${n === 1 ? '' : 's'} from "${c.title}".`);
  } catch (e) {
    flash(req, 'error', e.message);
  }
  res.redirect(`${back}?c=${c.id}`);
});

/* ---------------------------------------------------------- § the mapping -- */

/**
 * Which curriculum this grade is on. School-wide, so school admins and above only — a teacher
 * changing it would quietly move every other class of that grade, and the students' ladder with it.
 */
router.post('/classes/:name/curriculum/suggest', requireStaff, async (req, res) => {
  const ctx = await classCtx(req, res); if (!ctx) return;
  const back = `/classes/${encodeURIComponent(ctx.name)}/curriculum`;
  if (!mayMapGrades(req.user)) {
    flash(req, 'error', 'Only a school admin can change which curriculum a grade is on. You can still enrol the class from any curriculum your school is offered.');
    return res.redirect(back);
  }
  const raw = Number(req.body.curriculum_id);
  try {
    if (!raw) {
      cur.clearForGrade(ctx.school, ctx.name, cur.currentYear());
      flash(req, 'success', `${ctx.name} no longer has a suggested curriculum.`);
    } else {
      const c = pick(raw, ctx.school);
      if (!c) throw new Error('Pick a curriculum your school is offered.');
      cur.setForGrade(ctx.school, ctx.name, c.id, cur.currentYear());
      flash(req, 'success', `${ctx.name} is on "${c.title}"${cur.currentYear() ? ` for ${cur.currentYear()}` : ''}.`);
    }
  } catch (e) {
    flash(req, 'error', e.message);
  }
  res.redirect(back);
});

module.exports = router;
