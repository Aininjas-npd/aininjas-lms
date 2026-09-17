// Enrolment pages (Phase A):
//   /admin/enroll                 AI Ninjas admin: pick a school, classes, courses, dates → enrol everyone matching
//   /classes/:name/enroll         school admin / teacher: the same, locked to one of their classes
//   /classes/enrolments           every batch in the caller's scope: pending, active, ended — cancel, extend, re-date
// Scope is enforced server-side: a teacher only ever enrols the classes on their own record.
const express = require('express');
const { q } = require('../db');
const { requireAdmin, requireStaff, flash } = require('../auth');
const classesLib = require('../classes');
const enrol = require('../enrol');
const brand = require('../brand');

const router = express.Router();
const list = v => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(String);

/* Shared form handler. `lock` = { school, className } for the class page; admin picks freely. */
async function enrolPage(req, res, { admin, lockClass }) {
  const scope = await classesLib.scopeFor(req.user, String(req.query.school || (req.body && req.body.school) || ''));
  if (!scope.school) return res.render('enrol/form', { title: 'Enrol', sc: scope, admin, lockClass: null, courses: [], form: {}, preview: null, error: 'No school to enrol for yet.' });
  /* school admins / admins: the school's class list plus any class name students already carry (e.g. a grade added after the import) */
  const allowedClasses = scope.all ? [...new Set([...scope.classes, ...enrol.classNamesAt(scope.school.slug)])] : scope.classes;
  const courses = enrol.coursesForSchool(scope.school.slug);
  const b = req.body || {};
  const form = {
    classes: lockClass ? [lockClass] : list(b.classes).filter(c => allowedClasses.includes(c)),
    course_ids: list(b.course_ids).map(Number).filter(id => courses.some(c => c.id === id)),
    starts_on: enrol.cleanDate(b.starts_on) || '', ends_on: enrol.cleanDate(b.ends_on) || '', note: String(b.note || '').slice(0, 200),
    exclude: list(b.exclude).map(Number),
  };
  let preview = null, error = null, done = null;
  if (req.method === 'POST') {
    if (!form.classes.length) error = 'Pick at least one class.';
    else if (!form.course_ids.length) error = 'Pick at least one course.';
    else if (form.starts_on && form.ends_on && form.ends_on < form.starts_on) error = 'The end date is before the start date.';
    else if (b.action === 'enrol') {
      try {
        const r = enrol.createBatch({ schoolSlug: scope.school.slug, classes: form.classes, courseIds: form.course_ids, startsOn: form.starts_on, endsOn: form.ends_on, excludeUserIds: form.exclude, note: form.note, by: req.user.id });
        const a = r.applied;
        flash(req, 'success', a
          ? `Enrolled ${a.enrolled + a.reactivated} student${a.enrolled + a.reactivated === 1 ? '' : 's'} (${a.skipped} already enrolled)${form.ends_on ? ' until ' + form.ends_on : ''}.`
          : `Scheduled: ${form.classes.join(', ')} will be enrolled on ${form.starts_on}${form.ends_on ? ' until ' + form.ends_on : ''}.`);
        return res.redirect((admin ? '/classes/enrolments?school=' + encodeURIComponent(scope.school.slug) : '/classes/enrolments'));
      } catch (e) { error = e.message; }
    } else preview = enrol.preview({ schoolSlug: scope.school.slug, classes: form.classes, courseIds: form.course_ids, excludeUserIds: form.exclude });
  }
  res.render('enrol/form', { title: lockClass ? `Enrol ${lockClass}` : 'Enrol students', sc: scope, admin, lockClass, allowedClasses, courses, form, preview, error, today: enrol.today(), tz: enrol.TZ });
}

router.get('/admin/enroll', requireAdmin, (req, res) => enrolPage(req, res, { admin: true, lockClass: null }));
router.post('/admin/enroll', requireAdmin, (req, res) => enrolPage(req, res, { admin: true, lockClass: null }));

async function classGuard(req, res) {
  const scope = await classesLib.scopeFor(req.user, String(req.query.school || (req.body && req.body.school) || ''));
  const name = req.params.name;
  if (!scope.school || !(scope.all || scope.classes.includes(name))) { res.status(403).render('error', { title: 'Not your class', message: 'You can only enrol the classes assigned to you.' }); return null; }
  return name;
}
router.get('/classes/:name/enroll', requireStaff, async (req, res) => { const name = await classGuard(req, res); if (name) enrolPage(req, res, { admin: req.user.role === 'admin', lockClass: name }); });
router.post('/classes/:name/enroll', requireStaff, async (req, res) => { const name = await classGuard(req, res); if (name) enrolPage(req, res, { admin: req.user.role === 'admin', lockClass: name }); });

/* ---------- the list of batches ---------- */
router.get('/classes/enrolments', requireStaff, async (req, res) => {
  const scope = await classesLib.scopeFor(req.user, String(req.query.school || ''));
  const batches = scope.school ? enrol.listBatches({ user: req.user, schoolSlug: scope.school.slug, classes: scope.classes, all: scope.all }) : [];
  res.render('enrol/list', { title: 'Enrolments', sc: scope, batches, today: enrol.today() });
});
async function batchGuard(req, res) {
  const b = enrol.batchById(req.params.id);
  if (!b) { res.status(404).render('error', { title: 'Not found', message: 'That enrolment no longer exists.' }); return null; }
  const scope = await classesLib.scopeFor(req.user, b.school_slug);
  const ok = scope.school && scope.school.slug === b.school_slug && (scope.all || b.classes.every(c => scope.classes.includes(c)));
  if (!ok) { res.status(403).render('error', { title: 'Not yours', message: 'That enrolment belongs to another class or school.' }); return null; }
  return { b, scope };
}
router.post('/classes/enrolments/:id/:action', requireStaff, async (req, res) => {
  const g = await batchGuard(req, res); if (!g) return;
  const { b, scope } = g; const back = '/classes/enrolments' + (req.user.role === 'admin' ? '?school=' + encodeURIComponent(scope.school.slug) : '');
  try {
    if (req.params.action === 'cancel') {
      const n = enrol.endBatch(b, req.user.id, 'cancelled');
      flash(req, 'success', b.status === 'active' ? `Ended for ${n} student${n === 1 ? '' : 's'} — their progress is kept.` : 'Scheduled enrolment cancelled.');
    } else if (req.params.action === 'extend') {
      const nb = enrol.extendBatch(b, req.body.ends_on, req.user.id);
      flash(req, 'success', nb.ends_on ? `Extended until ${nb.ends_on}.` : 'End date removed — this enrolment now runs until you end it.');
    } else if (req.params.action === 'reschedule') {
      const nb = enrol.rescheduleBatch(b, req.body.starts_on, req.body.ends_on);
      flash(req, 'success', `Dates updated: starts ${nb.starts_on || 'now'}${nb.ends_on ? ', ends ' + nb.ends_on : ''}.`);
    } else throw new Error('Unknown action.');
  } catch (e) { flash(req, 'error', e.message); }
  res.redirect(back);
});

/* ---------- course availability (admin) ---------- */
router.post('/admin/courses/:id/schools', requireAdmin, async (req, res) => {
  const course = q.courseById.get(req.params.id);
  if (!course) return res.sendStatus(404);
  const schools = await brand.listSchools();
  const chosen = list(req.body.schools).filter(s => schools.some(x => x.slug === s));
  enrol.setSchoolsForCourse(course.id, req.body.everyone === 'on' ? [] : chosen);
  flash(req, 'success', req.body.everyone === 'on' || !chosen.length ? `"${course.title}" is available to every school.` : `"${course.title}" is limited to ${chosen.length} school${chosen.length === 1 ? '' : 's'}. Students already enrolled keep their access.`);
  res.redirect(`/admin/courses/${course.id}`);
});

module.exports = router;
