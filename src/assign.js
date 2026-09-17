// Assignments, submissions and grades (Phase C).
//
// An assignment belongs to one class of one school and is set by a teacher (or school admin / admin). It has items:
//   sco      — a SCORM lesson step of a course the class is enrolled on, with an optional part note ("sections 2–4")
//   quiz     — a Quiz Studio quiz: a course step or a standalone published quiz, optionally limited to some modules
//   colab    — a Colab notebook: a course step or a standalone URL
//   freeform — anything else the student marks done (optionally with a short note)
// Kinds: homework (default), classwork (an ad-hoc gradebook column, usually one freeform item), unit_test (one quiz item;
// can also be sat through Quiz Studio Live — a live result for that quiz fills the submission too).
//
// Publishing creates one submission row per item per student in the class at that moment; students who join later get
// theirs on first view. Quiz items are auto-scored from the postback (scaled to the item's points); everything else is
// graded by the teacher. A grade row is the teacher's word; when none exists the auto score stands. Students see grades
// once the teacher releases them (spec default: yes, on release).
const { db, q } = require('./db');
const enrolLib = require('./enrol');

db.exec(`
CREATE TABLE IF NOT EXISTS assignments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  school_slug  TEXT NOT NULL,
  class_name   TEXT NOT NULL,
  teacher_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL DEFAULT 'homework',   -- homework | classwork | unit_test
  title        TEXT NOT NULL,
  instructions TEXT,
  due_at       TEXT,                               -- school-local 'YYYY-MM-DDTHH:MM' (SCHOOL_TZ); null = no due date
  published    INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,
  released     INTEGER NOT NULL DEFAULT 0,         -- grades visible to students
  released_at  TEXT,
  max_points   REAL,                               -- null = sum of item points
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS assignment_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  type          TEXT NOT NULL,                     -- sco | quiz | colab | freeform
  title         TEXT NOT NULL,
  ref           TEXT NOT NULL DEFAULT '{}',        -- {step_id, course_id, sco_id, quiz_id, quiz_title, url}
  part_note     TEXT,
  quiz_modules  TEXT,                              -- JSON array of module keys, or null = whole quiz
  points        REAL NOT NULL DEFAULT 10
);
CREATE TABLE IF NOT EXISTS assignment_submissions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_item_id INTEGER NOT NULL REFERENCES assignment_items(id) ON DELETE CASCADE,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'not_started',   -- not_started | in_progress | submitted | graded
  submitted_at       TEXT,
  notebook_url       TEXT,
  note               TEXT,
  auto_score         REAL,
  auto_max           REAL,
  launch_ctx         TEXT,
  UNIQUE(assignment_item_id, user_id)
);
CREATE TABLE IF NOT EXISTS grades (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assignment_id      INTEGER REFERENCES assignments(id) ON DELETE CASCADE,
  assignment_item_id INTEGER REFERENCES assignment_items(id) ON DELETE CASCADE,
  points             REAL,
  max_points         REAL,
  comment            TEXT,
  source             TEXT NOT NULL DEFAULT 'manual',        -- auto | manual | override
  graded_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  graded_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, assignment_item_id)
);
CREATE INDEX IF NOT EXISTS idx_assign_class ON assignments(school_slug, class_name);
CREATE INDEX IF NOT EXISTS idx_sub_user ON assignment_submissions(user_id);
`);

const KINDS = { homework: 'Homework', classwork: 'Classwork', unit_test: 'Unit test' };
const TYPES = { sco: 'Lesson', quiz: 'Quiz', colab: 'Colab', freeform: 'Task' };
const parse = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };
const round1 = v => Math.round(v * 10) / 10;

/** Now, as school-local 'YYYY-MM-DDTHH:MM' — comparable with due_at as plain strings. */
function nowLocal() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: enrolLib.TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const g = t => (p.find(x => x.type === t) || {}).value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`;
}
const cleanDue = s => { const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(String(s || '').trim()); return m ? `${m[1]}T${m[2] || '23:59'}` : null; };
const fmtDue = s => { if (!s) return ''; const [d, t] = s.split('T'); return t && t !== '23:59' ? `${d} ${t}` : d; };

/* ---------- shaping ---------- */
function shapeItem(r) {
  const ref = parse(r.ref, {}); const modules = r.quiz_modules ? parse(r.quiz_modules, null) : null;
  return { ...r, ref, modules: Array.isArray(modules) && modules.length ? modules : null, type_label: TYPES[r.type] || r.type, points: +r.points || 0, standalone: !ref.step_id };
}
function itemsFor(assignmentId) {
  return db.prepare('SELECT * FROM assignment_items WHERE assignment_id=? ORDER BY sort_order, id').all(assignmentId).map(shapeItem);
}
function shape(a) {
  if (!a) return null;
  const items = itemsFor(a.id);
  const total = a.max_points != null ? +a.max_points : items.reduce((n, i) => n + i.points, 0);
  const now = nowLocal();
  return { ...a, items, total, kind_label: KINDS[a.kind] || a.kind, due_label: fmtDue(a.due_at), overdue: !!(a.due_at && a.due_at < now), open: !!a.published && !(a.due_at && a.due_at < now),
           teacher: a.teacher_id ? (db.prepare('SELECT name FROM users WHERE id=?').get(a.teacher_id) || {}).name : null };
}
const byId = id => shape(db.prepare('SELECT * FROM assignments WHERE id=?').get(id));
function listFor(schoolSlug, className, { includeDrafts = true } = {}) {
  return db.prepare(`SELECT * FROM assignments WHERE school_slug=? AND class_name=? ${includeDrafts ? '' : 'AND published=1'} ORDER BY COALESCE(due_at, '9999') DESC, id DESC`).all(schoolSlug, className).map(shape);
}

/* ---------- builder sources ---------- */
/** Course steps a class can be assigned: every step of every course any student of the class is (or was) enrolled on. */
function stepSources(schoolSlug, className) {
  const pathLib = require('./path');
  const courseIds = db.prepare(`SELECT DISTINCT e.course_id FROM enrollments e JOIN users u ON u.id=e.user_id
    WHERE u.role='learner' AND u.school_slug=? AND u.class_name=? AND e.status IN ('active','ended')`).all(schoolSlug, className).map(r => r.course_id);
  return courseIds.map(cid => { const c = q.courseById.get(cid); if (!c) return null;
    return { id: c.id, title: c.title, steps: pathLib.stepsFor(cid).filter(s => s.custom || s.type === 'sco').map(s => ({ id: s.id, type: s.type, title: s.title, kind: s.kind, config: s.config })) }; }).filter(Boolean);
}

/* ---------- create / edit ---------- */
function cleanItems(raw) {
  const list = Array.isArray(raw) ? raw : parse(raw, []);
  return list.map((it, i) => {
    const type = ['sco', 'quiz', 'colab', 'freeform'].includes(it.type) ? it.type : null; if (!type) return null;
    const ref = {};
    if (it.step_id) { ref.step_id = /^\d+$/.test(String(it.step_id)) ? +it.step_id : String(it.step_id).slice(0, 40); ref.course_id = +it.course_id || null; if (!ref.course_id) return null; }   // 'sco-<id>' = automatic lesson step
    if (type === 'sco' && it.sco_id) ref.sco_id = +it.sco_id;
    if (type === 'quiz') { ref.quiz_id = +it.quiz_id || null; ref.quiz_title = String(it.quiz_title || '').slice(0, 200); if (!ref.quiz_id) return null; }
    if (type === 'colab') { ref.url = String(it.url || '').trim().slice(0, 500); if (!ref.step_id && !/^https?:\/\//i.test(ref.url)) return null; }
    const modules = Array.isArray(it.modules) ? it.modules.map(String).filter(Boolean) : null;
    const pts = Math.max(0, Math.min(1000, parseFloat(it.points)));
    return { sort_order: i, type, title: String(it.title || TYPES[type]).trim().slice(0, 200) || TYPES[type], ref, part_note: String(it.part_note || '').trim().slice(0, 200) || null,
             quiz_modules: type === 'quiz' && modules && modules.length ? JSON.stringify(modules) : null, points: isFinite(pts) ? pts : 10 };
  }).filter(Boolean);
}
function create({ school_slug, class_name, teacher_id, kind, title, instructions, due_at, items, max_points }) {
  const list = cleanItems(items);
  if (!list.length) throw new Error('Add at least one item to the assignment.');
  const k = KINDS[kind] ? kind : 'homework';
  const t = String(title || '').trim().slice(0, 200); if (!t) throw new Error('Give the assignment a title.');
  const id = db.transaction(() => {
    const r = db.prepare('INSERT INTO assignments (school_slug, class_name, teacher_id, kind, title, instructions, due_at, max_points) VALUES (?,?,?,?,?,?,?,?)')
      .run(school_slug, class_name, teacher_id || null, k, t, String(instructions || '').trim().slice(0, 4000) || null, cleanDue(due_at), max_points ? +max_points : null);
    const ins = db.prepare('INSERT INTO assignment_items (assignment_id, sort_order, type, title, ref, part_note, quiz_modules, points) VALUES (?,?,?,?,?,?,?,?)');
    list.forEach(it => ins.run(r.lastInsertRowid, it.sort_order, it.type, it.title, JSON.stringify(it.ref), it.part_note, it.quiz_modules, it.points));
    return r.lastInsertRowid;
  })();
  return byId(id);
}
/** Edit title/instructions/due/kind always; items only while it is still a draft (submissions hang off item ids). */
function update(id, { title, instructions, due_at, kind, items, max_points }) {
  const a = byId(id); if (!a) throw new Error('Not found');
  db.transaction(() => {
    db.prepare('UPDATE assignments SET title=?, instructions=?, due_at=?, kind=?, max_points=? WHERE id=?')
      .run(String(title || a.title).trim().slice(0, 200) || a.title, String(instructions || '').trim().slice(0, 4000) || null, cleanDue(due_at), KINDS[kind] ? kind : a.kind, max_points ? +max_points : null, id);
    if (!a.published && items !== undefined) {
      const list = cleanItems(items); if (!list.length) throw new Error('Add at least one item to the assignment.');
      db.prepare('DELETE FROM assignment_items WHERE assignment_id=?').run(id);
      const ins = db.prepare('INSERT INTO assignment_items (assignment_id, sort_order, type, title, ref, part_note, quiz_modules, points) VALUES (?,?,?,?,?,?,?,?)');
      list.forEach(it => ins.run(id, it.sort_order, it.type, it.title, JSON.stringify(it.ref), it.part_note, it.quiz_modules, it.points));
    }
  })();
  return byId(id);
}
function remove(id) { db.prepare('DELETE FROM assignments WHERE id=?').run(id); }

/** Students of the class (approved learners). */
const studentsOf = (schoolSlug, className) => db.prepare(`SELECT id, name, email, class_name FROM users WHERE role='learner' AND status='approved' AND school_slug=? AND class_name=? ORDER BY name COLLATE NOCASE`).all(schoolSlug, className);

/** Make sure every student has a submission row for every item (idempotent). */
function ensureSubmissions(a, userIds) {
  const ins = db.prepare('INSERT OR IGNORE INTO assignment_submissions (assignment_item_id, user_id) VALUES (?, ?)');
  db.transaction(() => { for (const it of a.items) for (const uid of userIds) ins.run(it.id, uid); })();
}
function publish(id) {
  const a = byId(id); if (!a) throw new Error('Not found');
  if (!a.published) db.prepare("UPDATE assignments SET published=1, published_at=datetime('now') WHERE id=?").run(id);
  ensureSubmissions(a, studentsOf(a.school_slug, a.class_name).map(u => u.id));
  return byId(id);
}
function unpublish(id) { db.prepare('UPDATE assignments SET published=0, released=0 WHERE id=?').run(id); return byId(id); }
function release(id, on) { db.prepare("UPDATE assignments SET released=?, released_at=CASE WHEN ? THEN datetime('now') ELSE released_at END WHERE id=?").run(on ? 1 : 0, on ? 1 : 0, id); return byId(id); }

/* ---------- per-student status ---------- */
const sub = (itemId, userId) => db.prepare('SELECT * FROM assignment_submissions WHERE assignment_item_id=? AND user_id=?').get(itemId, userId);
const grade = (itemId, userId) => db.prepare('SELECT * FROM grades WHERE assignment_item_id=? AND user_id=?').get(itemId, userId);

/** One student's view of an assignment: each item with its submission, effective score and course-step evidence. */
function statusFor(a, userId) {
  const pathLib = require('./path');
  const pathCache = {};
  const items = a.items.map(it => {
    const s = sub(it.id, userId) || { status: 'not_started' };
    const g = grade(it.id, userId) || null;
    let evidence = null, step = null, course = null;
    if (it.ref.step_id && it.ref.course_id) {
      const ps = pathCache[it.ref.course_id] || (pathCache[it.ref.course_id] = pathLib.pathSummary(userId, it.ref.course_id));
      step = ps.steps.find(x => String(x.id) === String(it.ref.step_id)) || null;
      course = q.courseById.get(it.ref.course_id) || null;
      if (step) evidence = { status: step.status, score: step.score, detail: step.detail, notebook: step.notebook, when: step.when };
    }
    let score = null, source = null;
    if (g && g.points != null) { score = +g.points; source = g.source; }
    else if (s.auto_score != null && s.auto_max) { score = round1(it.points * s.auto_score / s.auto_max); source = 'auto'; }
    const enrolled = course ? (() => { const e = q.enrollment.get(userId, course.id); return !!(e && e.status === 'active'); })() : true;
    return { ...it, sub: s, grade: g, evidence, step, course, enrolled, score, source, done: ['submitted', 'graded'].includes(s.status) };
  });
  const scored = items.filter(i => i.score != null);
  const total = scored.reduce((n, i) => n + i.score, 0);
  const allGraded = items.every(i => i.score != null);
  const comment = (db.prepare('SELECT comment FROM grades WHERE user_id=? AND assignment_id=? AND assignment_item_id IS NULL').get(userId, a.id) || {}).comment || null;
  return { items, total: scored.length ? round1(total) : null, allGraded, anyDone: items.some(i => i.done), allDone: items.every(i => i.done), comment,
           late: items.some(i => i.sub.submitted_at && a.due_at && localOf(i.sub.submitted_at) > a.due_at) };
}
/** UTC 'YYYY-MM-DD HH:MM:SS' (sqlite datetime) → school-local 'YYYY-MM-DDTHH:MM'. */
function localOf(utc) {
  if (!utc) return null;
  const d = new Date(utc.replace(' ', 'T') + (utc.endsWith('Z') ? '' : 'Z'));
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: enrolLib.TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = t => (p.find(x => x.type === t) || {}).value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`;
}

/** Teacher's table: every student of the class with their status on this assignment. */
function roster(a) {
  const students = studentsOf(a.school_slug, a.class_name);
  if (a.published) ensureSubmissions(a, students.map(u => u.id));
  const rows = students.map(u => ({ user: u, ...statusFor(a, u.id) }));
  const summary = { students: rows.length, done: rows.filter(r => r.allDone).length, started: rows.filter(r => r.anyDone && !r.allDone).length, graded: rows.filter(r => r.allGraded).length, late: rows.filter(r => r.late).length,
                    avg: (() => { const s = rows.filter(r => r.total != null); return s.length ? round1(s.reduce((n, r) => n + r.total, 0) / s.length) : null; })() };
  return { rows, summary };
}

/* ---------- student actions ---------- */
function markStarted(itemId, userId) {
  db.prepare("INSERT INTO assignment_submissions (assignment_item_id, user_id, status) VALUES (?, ?, 'in_progress') ON CONFLICT(assignment_item_id, user_id) DO UPDATE SET status=CASE WHEN status='not_started' THEN 'in_progress' ELSE status END").run(itemId, userId);
}
function markSubmitted(itemId, userId, { notebook_url, note } = {}) {
  db.prepare(`INSERT INTO assignment_submissions (assignment_item_id, user_id, status, submitted_at, notebook_url, note) VALUES (?, ?, 'submitted', datetime('now'), ?, ?)
    ON CONFLICT(assignment_item_id, user_id) DO UPDATE SET status=CASE WHEN status='graded' THEN 'graded' ELSE 'submitted' END, submitted_at=COALESCE(submitted_at, datetime('now')),
    notebook_url=COALESCE(excluded.notebook_url, notebook_url), note=COALESCE(excluded.note, note)`).run(itemId, userId, notebook_url || null, note || null);
}
/** Quiz result for an item (from the postback, or a live session for the same quiz). Keeps the best score. */
function applyQuizScore(itemId, userId, { points, max_points, ctx }) {
  const s = sub(itemId, userId);
  const better = !s || s.auto_score == null || +points >= +s.auto_score;
  db.prepare(`INSERT INTO assignment_submissions (assignment_item_id, user_id, status, submitted_at, auto_score, auto_max, launch_ctx) VALUES (?, ?, 'submitted', datetime('now'), ?, ?, ?)
    ON CONFLICT(assignment_item_id, user_id) DO UPDATE SET status=CASE WHEN status='graded' THEN 'graded' ELSE 'submitted' END, submitted_at=COALESCE(submitted_at, datetime('now')),
    auto_score=CASE WHEN ? THEN excluded.auto_score ELSE auto_score END, auto_max=CASE WHEN ? THEN excluded.auto_max ELSE auto_max END, launch_ctx=COALESCE(excluded.launch_ctx, launch_ctx)`)
    .run(itemId, userId, +points, +max_points, ctx ? JSON.stringify(ctx) : null, better ? 1 : 0, better ? 1 : 0);
}
/** A quiz result that did not come through an assignment launch (a live session, or the course step opened directly):
 *  credit every published assignment item of that quiz for this student's class, so a unit test sat live still fills in. */
function applyLiveQuizScore(userId, quizId, score, ctx = { live: true }) {
  const u = db.prepare('SELECT school_slug, class_name FROM users WHERE id=?').get(userId); if (!u || !u.class_name) return 0;
  const items = db.prepare(`SELECT ai.id FROM assignment_items ai JOIN assignments a ON a.id=ai.assignment_id
    WHERE a.published=1 AND a.school_slug=? AND a.class_name=? AND ai.type='quiz' AND json_extract(ai.ref, '$.quiz_id')=?`).all(u.school_slug, u.class_name, +quizId);
  items.forEach(it => applyQuizScore(it.id, userId, { ...score, ctx }));
  return items.length;
}

/* ---------- grading ---------- */
function setGrade(itemId, userId, points, graderId) {
  const it = shapeItem(db.prepare('SELECT * FROM assignment_items WHERE id=?').get(itemId)); if (!it) return;
  const s = sub(itemId, userId);
  if (points === '' || points == null) { db.prepare('DELETE FROM grades WHERE assignment_item_id=? AND user_id=?').run(itemId, userId); if (s && s.status === 'graded') db.prepare("UPDATE assignment_submissions SET status='submitted' WHERE id=?").run(s.id); return; }
  const p = Math.max(0, Math.min(it.points * 2, parseFloat(points))); if (!isFinite(p)) return;
  const source = s && s.auto_score != null ? 'override' : 'manual';
  db.prepare(`INSERT INTO grades (user_id, assignment_id, assignment_item_id, points, max_points, source, graded_by) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(user_id, assignment_item_id) DO UPDATE SET points=excluded.points, max_points=excluded.max_points, source=excluded.source, graded_by=excluded.graded_by, graded_at=datetime('now')`)
    .run(userId, it.assignment_id, itemId, p, it.points, source, graderId || null);
  db.prepare(`INSERT INTO assignment_submissions (assignment_item_id, user_id, status, submitted_at) VALUES (?, ?, 'graded', datetime('now'))
    ON CONFLICT(assignment_item_id, user_id) DO UPDATE SET status='graded', submitted_at=COALESCE(submitted_at, datetime('now'))`).run(itemId, userId);
}
function setComment(assignmentId, userId, comment, graderId) {
  const c = String(comment || '').trim().slice(0, 2000);
  db.prepare('DELETE FROM grades WHERE user_id=? AND assignment_id=? AND assignment_item_id IS NULL').run(userId, assignmentId);
  if (c) db.prepare("INSERT INTO grades (user_id, assignment_id, assignment_item_id, comment, source, graded_by) VALUES (?,?,NULL,?,'manual',?)").run(userId, assignmentId, c, graderId || null);
}

/* ---------- gradebook ---------- */
/** Students × published assignments of a class, with per-assignment totals and an overall sum. */
function gradebook(schoolSlug, className) {
  const assignments = listFor(schoolSlug, className, { includeDrafts: false }).sort((x, y) => (x.due_at || x.published_at || '') < (y.due_at || y.published_at || '') ? -1 : 1);
  const students = studentsOf(schoolSlug, className);
  const rows = students.map(u => {
    const cells = assignments.map(a => { const st = statusFor(a, u.id); return { assignment_id: a.id, total: st.total, max: a.total, allDone: st.allDone, anyDone: st.anyDone, allGraded: st.allGraded, late: st.late, items: st.items.map(i => ({ id: i.id, score: i.score, source: i.source, done: i.done })) }; });
    const got = cells.filter(c => c.total != null);
    return { user: u, cells, sum: got.length ? round1(got.reduce((n, c) => n + c.total, 0)) : null, sumMax: round1(got.reduce((n, c) => n + c.max, 0)) };
  });
  const maxAll = round1(assignments.reduce((n, a) => n + a.total, 0));
  return { assignments, rows, maxAll };
}

/* ---------- student lists ---------- */
function forStudent(user) {
  if (!user.school_slug || !user.class_name) return { open: [], past: [] };
  const all = listFor(user.school_slug, user.class_name, { includeDrafts: false });
  ensureSubmissions({ items: all.flatMap(a => a.items) }, [user.id]);
  const withStatus = all.map(a => ({ ...a, mine: statusFor(a, user.id) }));
  const open = withStatus.filter(a => !a.mine.allDone).sort((x, y) => (x.due_at || '9999') < (y.due_at || '9999') ? -1 : 1);
  const past = withStatus.filter(a => a.mine.allDone).sort((x, y) => (x.due_at || x.published_at || '') < (y.due_at || y.published_at || '') ? 1 : -1);
  return { open, past };
}

module.exports = { KINDS, TYPES, nowLocal, cleanDue, fmtDue, byId, listFor, itemsFor, stepSources, create, update, remove, publish, unpublish, release, studentsOf, statusFor, roster, markStarted, markSubmitted, applyQuizScore, applyLiveQuizScore, setGrade, setComment, gradebook, forStudent, sub };
