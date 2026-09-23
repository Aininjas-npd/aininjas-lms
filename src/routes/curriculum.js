'use strict';
/*
 * Curricula: define what a grade is taught, and hand it to the enrolment machinery.
 *
 * Nothing here enrols anyone by itself. "Apply to a class" builds a preview, and only the confirm
 * step calls enrol.createBatch — so the dates, exclusions and end-of-term rules stay in enrol.js,
 * which already knows them.
 */
const express = require('express');
const { db, q } = require('../db');
const { requireAdmin, flash } = require('../auth');
const cur = require('../curriculum');
const enrol = require('../enrol');
const brand = require('../brand');

const router = express.Router();

const ids = v => (Array.isArray(v) ? v : v == null ? [] : [v]).map(Number).filter(Boolean);
/* The schools that actually have people in them. brand.schools() asks Quiz Studio over the
   network and can be empty when the secret is unset; this is local and always right. */
const schoolsList = () => db.prepare(
  `SELECT school_slug AS slug, COUNT(*) n FROM users WHERE school_slug IS NOT NULL AND school_slug <> ''
   GROUP BY school_slug ORDER BY school_slug`).all();

/* ------------------------------------------------------------------ § list -- */

router.get('/curricula', requireAdmin, (req, res) => {
  const rows = cur.list().map(c => {
    const items = cur.resolve(c.id);
    return {
      ...c,
      count: items.length,
      inheritedCount: items.filter(i => i.inherited).length,
      parent: c.extends_id ? cur.byId(c.extends_id) : null,
      usedBy: cur.descendants(c.id).length,
      grades: db.prepare('SELECT school_slug, grade, academic_year FROM curriculum_grades WHERE curriculum_id=?').all(c.id),
    };
  });
  /* The grade must match a student's class name exactly, so offer the real ones rather than a
     free-text box where a typo saves silently and does nothing. */
  const classesBySchool = Object.fromEntries(schoolsList().map(sc => [sc.slug, enrol.classNamesAt(sc.slug)]));
  res.render('admin/curricula', { title: 'Curricula', rows, all: cur.list(), schools: schoolsList(),
    year: cur.currentYear(), classesBySchool });
});

router.post('/curricula', requireAdmin, (req, res) => {
  try {
    const c = cur.create({
      title: req.body.title,
      description: req.body.description,
      extendsId: Number(req.body.extends_id) || null,
      schoolSlug: req.body.school_slug || null,
      sequential: req.body.sequential === 'on' ? 1 : 0,
    });
    flash(req, 'success', `Created "${c.title}". Now add its courses, in teaching order.`);
    return res.redirect(`/admin/curricula/${c.id}`);
  } catch (e) {
    flash(req, 'error', e.message);
    res.redirect('/admin/curricula');
  }
});

/* These two literal paths must be declared before any /curricula/:id route: Express matches in
   order, so "/curricula/grades" would otherwise be read as a curriculum whose id is "grades". */
/* ----------------------------------------------------------------- § grades -- */

router.post('/curricula/grades', requireAdmin, (req, res) => {
  const { school_slug: school, grade, academic_year: year, curriculum_id: cid } = req.body;
  try {
    if (!school || !grade) throw new Error('Pick a school and name the grade.');
    if (cid) {
      cur.setForGrade(school, String(grade).trim(), Number(cid), String(year || '').trim());
      flash(req, 'success', `${grade}${year ? ` (${year})` : ''} now suggests "${cur.byId(cid).title}".`);
    } else {
      cur.clearForGrade(school, String(grade).trim(), String(year || '').trim());
      flash(req, 'success', `Cleared the suggestion for ${grade}.`);
    }
  } catch (e) { flash(req, 'error', e.message); }
  res.redirect(req.body.back || '/admin/curricula');
});

/* The year decides which per-year grade entries apply. Blank = every grade on its standing one. */
router.post('/curricula/year', requireAdmin, (req, res) => {
  cur.setCurrentYear(req.body.academic_year);
  const y = cur.currentYear();
  flash(req, 'success', y
    ? `Academic year set to ${y}. Grade entries naming ${y} now apply; the rest stay on their standing curriculum.`
    : 'Academic year cleared. Every grade is on its standing curriculum.');
  res.redirect('/admin/curricula');
});

/* ------------------------------------------------------------------ § edit -- */

router.get('/curricula/:id', requireAdmin, (req, res) => {
  const c = cur.byId(req.params.id);
  if (!c) return res.status(404).render('error', { title: 'Not found', message: 'Curriculum not found.' });
  const items = cur.resolve(c.id);
  const inThis = new Set(items.map(i => i.courseId));
  res.render('admin/curriculum', {
    title: c.title,
    c,
    items,
    own: cur.ownCourses(c.id).map(r => r.course_id),
    ancestry: cur.ancestry(c.id),
    descendants: cur.descendants(c.id),
    others: cur.list().filter(x => x.id !== c.id && !cur.descendants(c.id).some(d => d.id === x.id)),
    addable: q.courses.all().filter(x => !inThis.has(x.id)),
    schools: schoolsList(),
    /* Every school's class list, so "Apply to a class" works even for a shared template: pick the
       school, and its classes appear. Without this a template was a dead end — it offered no
       classes and the settings form had no way to give it a school either. */
    classesBySchool: Object.fromEntries(schoolsList().map(sc => [sc.slug, enrol.classNamesAt(sc.slug)])),
  });
});

router.post('/curricula/:id', requireAdmin, (req, res) => {
  try {
    cur.update(req.params.id, {
      title: req.body.title,
      description: req.body.description,
      schoolSlug: req.body.school_slug === undefined ? undefined : (req.body.school_slug || null),
      extendsId: req.body.extends_id === undefined ? undefined : (Number(req.body.extends_id) || null),
      sequential: req.body.sequential === 'on' ? 1 : 0,
      isPublished: req.body.is_published === 'on' ? 1 : 0,
    });
    flash(req, 'success', 'Saved.');
  } catch (e) { flash(req, 'error', e.message); }
  res.redirect(`/admin/curricula/${req.params.id}`);
});

router.post('/curricula/:id/courses', requireAdmin, (req, res) => {
  try {
    cur.addCourse(req.params.id, Number(req.body.course_id), { required: req.body.required === 'off' ? 0 : 1 });
    flash(req, 'success', 'Course added at the end. Drag it into place if it belongs earlier.');
  } catch (e) { flash(req, 'error', e.message); }
  res.redirect(`/admin/curricula/${req.params.id}`);
});

router.post('/curricula/:id/courses/remove', requireAdmin, (req, res) => {
  const courseId = Number(req.body.course_id);
  const own = cur.ownCourses(req.params.id).some(r => r.course_id === courseId);
  if (!own) {
    flash(req, 'error', 'That course is inherited — remove it from the curriculum it comes from, or it will keep coming back.');
  } else {
    cur.removeCourse(req.params.id, courseId);
    flash(req, 'success', 'Course removed.');
  }
  res.redirect(`/admin/curricula/${req.params.id}`);
});

router.post('/curricula/:id/reorder', requireAdmin, express.json(), (req, res) => {
  try { cur.reorder(req.params.id, ids(req.body.ids)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/curricula/:id/delete', requireAdmin, (req, res) => {
  try { cur.remove(req.params.id); flash(req, 'success', 'Curriculum deleted. No enrolments were changed.'); res.redirect('/admin/curricula'); }
  catch (e) { flash(req, 'error', e.message); res.redirect(`/admin/curricula/${req.params.id}`); }
});

/* ------------------------------------------------------------------ § apply -- */

/** Step one: show what would happen. Nothing is written. */
router.post('/curricula/:id/apply/preview', requireAdmin, (req, res) => {
  const c = cur.byId(req.params.id);
  if (!c) return res.status(404).render('error', { title: 'Not found', message: 'Curriculum not found.' });
  const classes = (Array.isArray(req.body.classes) ? req.body.classes : [req.body.classes]).filter(Boolean);
  const school = req.body.school_slug || c.school_slug;
  if (!school || !classes.length) {
    flash(req, 'error', 'Pick a school and at least one class.');
    return res.redirect(`/admin/curricula/${c.id}`);
  }
  const p = cur.applyPreview({ curriculumId: c.id, schoolSlug: school, classes, excludeUserIds: ids(req.body.exclude) });
  res.render('admin/curriculum-apply', {
    title: `Apply ${c.title}`, c, p, school, classes,
    startsOn: req.body.starts_on || '', endsOn: req.body.ends_on || '',
  });
});

/** Step two: the admin has seen it and said yes. */
router.post('/curricula/:id/apply', requireAdmin, (req, res) => {
  const c = cur.byId(req.params.id);
  if (!c) return res.status(404).render('error', { title: 'Not found', message: 'Curriculum not found.' });
  const classes = (Array.isArray(req.body.classes) ? req.body.classes : [req.body.classes]).filter(Boolean);
  const school = req.body.school_slug || c.school_slug;
  const exclude = ids(req.body.exclude);
  const courseIds = ids(req.body.course_ids);          // what the admin left ticked on the preview

  try {
    if (!courseIds.length) throw new Error('Every course was unticked, so there is nothing to enrol anyone in.');
    const { batch, applied } = enrol.createBatch({
      schoolSlug: school, classes, courseIds,
      startsOn: req.body.starts_on, endsOn: req.body.ends_on,
      excludeUserIds: exclude,
      note: `Curriculum: ${c.title}`,
      by: req.user.id,
    });

    /* Enrolling a class and saying "this grade is on this curriculum" are two different things,
       and forgetting the second leaves students enrolled with no ladder and no locking. Offer it
       here so the common case is one action. */
    let mapped = [];
    if (req.body.set_for_grade === 'on') {
      for (const name of classes) {
        try { cur.setForGrade(school, name, c.id, cur.currentYear()); mapped.push(name); } catch { /* skip */ }
      }
    }
    q.logEvent.run(req.user.id, null, null, 'curriculum_applied',
      JSON.stringify({ curriculum: c.id, title: c.title, classes, courses: courseIds.length, batch: batch.id }));
    const mappedNote = mapped.length
      ? ` ${mapped.join(', ')} ${mapped.length === 1 ? 'is' : 'are'} now on this curriculum, so students see it as their path.`
      : '';
    flash(req, 'success', (applied
      ? `"${c.title}" applied to ${classes.join(', ')} — ${applied.enrolled} enrolment${applied.enrolled === 1 ? '' : 's'} created${applied.skipped ? `, ${applied.skipped} already had theirs` : ''}.`
      : `"${c.title}" is scheduled for ${classes.join(', ')} and starts on ${batch.starts_on}.`) + mappedNote);
    return res.redirect('/classes');
  } catch (e) {
    flash(req, 'error', e.message);
    res.redirect(`/admin/curricula/${c.id}`);
  }
});

module.exports = router;
