// Learning paths: an ordered list of steps per course — Learn (SCORM lesson), Practice (Colab notebook), Check (Quiz Studio quiz).
// If a course has no custom steps, its SCORM lessons form the path automatically, so existing courses keep working unchanged.
const crypto = require('crypto');
const { db, q } = require('./db');
const ssoLib = require('./aininjas-sso');

db.exec(`
CREATE TABLE IF NOT EXISTS path_steps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  type       TEXT NOT NULL,              -- sco | quiz | colab | note
  title      TEXT NOT NULL,
  config     TEXT NOT NULL DEFAULT '{}', -- sco:{sco_id} quiz:{quiz_id,quiz_title} colab:{url,instructions} note:{html}
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS step_progress (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  step_id      INTEGER NOT NULL REFERENCES path_steps(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'started',   -- started | done
  score_json   TEXT,                              -- quiz result payload
  notebook_url TEXT,                              -- Colab share link the student pasted
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  UNIQUE(user_id, step_id)
);
CREATE INDEX IF NOT EXISTS idx_step_progress_user ON step_progress(user_id);
`);

const QUIZ_URL = (process.env.QUIZ_STUDIO_URL || '').replace(/\/$/, '');
const LAUNCH_SECRET = process.env.QUIZ_LAUNCH_SECRET || '';
const quizEnabled = () => !!(QUIZ_URL && LAUNCH_SECRET);

const TYPE_LABEL = { sco: 'Learn', quiz: 'Check', colab: 'Practice', note: 'Read' };
const TYPE_ICON = { sco: '▶', quiz: '✓', colab: '{ }', note: '¶' };

function shape(row) {
  let config = {}; try { config = JSON.parse(row.config || '{}'); } catch {}
  const out = { ...row, config, kind: TYPE_LABEL[row.type] || row.type, icon: TYPE_ICON[row.type] || '•', custom: true };
  if (row.type === 'sco') { const sco = q.scoById.get(config.sco_id); out.pkg = sco ? (sco.package_title || '') : ''; out.missing = !sco; }
  return out;
}

/** Custom steps for a course, or an automatic path made of its SCORM lessons. */
function stepsFor(courseId) {
  const rows = db.prepare('SELECT * FROM path_steps WHERE course_id=? ORDER BY sort_order, id').all(courseId).map(shape);
  if (rows.length) return rows;
  return q.scosForCourse.all(courseId).map((s, i) => ({ id: 'sco-' + s.id, course_id: courseId, sort_order: i, type: 'sco', title: s.title, config: { sco_id: s.id }, kind: 'Learn', icon: '▶', custom: false, pkg: s.package_title || '' }));
}
const hasCustomPath = courseId => db.prepare('SELECT COUNT(*) n FROM path_steps WHERE course_id=?').get(courseId).n > 0;

/** Per-student view of the path: each step with status/score, overall percent, and the next step to do. */
function pathSummary(userId, courseId) {
  const steps = stepsFor(courseId);
  const prog = db.prepare('SELECT * FROM step_progress WHERE user_id=?').all(userId);
  const out = steps.map(st => {
    let status = 'todo', score = null, detail = null, notebook = null, when = null;
    if (st.type === 'sco') {
      const p = q.progress.get(userId, st.config.sco_id);
      if (p) {
        if (['completed', 'passed'].includes(p.lesson_status)) status = 'done';
        else if (p.first_launched_at) status = 'started';
        if (p.score_raw != null) score = p.score_raw;
        detail = p.total_seconds ? Math.round(p.total_seconds / 60) + ' min' : null; when = p.completed_at || p.last_accessed_at;
      }
    } else if (st.custom) {
      const p = prog.find(x => x.step_id === st.id);
      if (p) {
        status = p.status === 'done' ? 'done' : 'started'; notebook = p.notebook_url; when = p.completed_at || p.started_at;
        if (p.score_json) { try { const sj = JSON.parse(p.score_json); score = sj.points != null ? `${sj.points}/${sj.max_points}` : null; detail = [sj.accuracy != null ? sj.accuracy + '%' : null, sj.belt || null].filter(Boolean).join(' · '); } catch {} }
      }
    }
    return { ...st, status, score, detail, notebook, when, locked: false };
  });
  // Locked sequence: a step opens only once every step before it is done
  const course = q.courseById.get(courseId);
  if (course && course.sequential) {
    let blocked = false;
    out.forEach((s, i) => { s.locked = blocked; s.blockedBy = blocked ? out.slice(0, i).find(x => x.status !== 'done') : null; if (s.status !== 'done') blocked = true; });
  }
  const total = out.length, done = out.filter(s => s.status === 'done').length;
  const next = out.find(s => s.status !== 'done') || null;
  return { steps: out, total, done, percent: total ? Math.round(100 * done / total) : 0, next, sequential: !!(course && course.sequential),
           status: total && done === total ? 'completed' : out.some(s => s.status !== 'todo') ? 'in_progress' : 'not_started' };
}

/* ---------- admin: edit steps ---------- */
function addStep(courseId, { type, title, config }) {
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM path_steps WHERE course_id=?').get(courseId).m;
  return db.prepare('INSERT INTO path_steps (course_id, sort_order, type, title, config) VALUES (?, ?, ?, ?, ?)').run(courseId, max + 1, type, title, JSON.stringify(config || {})).lastInsertRowid;
}
/** First customisation of a course: copy its SCORM lessons in as real steps so the admin can interleave quizzes/Colab. */
function materialise(courseId) {
  if (hasCustomPath(courseId)) return;
  q.scosForCourse.all(courseId).forEach(s => addStep(courseId, { type: 'sco', title: s.title, config: { sco_id: s.id } }));
}
function moveStep(stepId, dir) {
  const st = db.prepare('SELECT * FROM path_steps WHERE id=?').get(stepId); if (!st) return;
  const list = db.prepare('SELECT id FROM path_steps WHERE course_id=? ORDER BY sort_order, id').all(st.course_id).map(r => r.id);
  const i = list.indexOf(st.id), j = i + (dir === 'up' ? -1 : 1);
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  const upd = db.prepare('UPDATE path_steps SET sort_order=? WHERE id=?');
  db.transaction(() => list.forEach((id, k) => upd.run(k, id)))();
}
/** Save a full new order: `ids` is every custom step id of the course in the wanted order. */
function reorder(courseId, ids) {
  const cur = db.prepare('SELECT id FROM path_steps WHERE course_id=? ORDER BY sort_order, id').all(courseId).map(r => r.id);
  const wanted = ids.map(Number).filter(id => cur.includes(id));
  const finalOrder = [...wanted, ...cur.filter(id => !wanted.includes(id))];   // anything missing keeps its place at the end
  const upd = db.prepare('UPDATE path_steps SET sort_order=? WHERE id=?');
  db.transaction(() => finalOrder.forEach((id, k) => upd.run(k, id)))();
  return finalOrder;
}
/** Move one step to a 1-based position. */
function moveTo(courseId, stepId, position) {
  const cur = db.prepare('SELECT id FROM path_steps WHERE course_id=? ORDER BY sort_order, id').all(courseId).map(r => r.id);
  const i = cur.indexOf(+stepId); if (i < 0) return;
  cur.splice(i, 1); cur.splice(Math.max(0, Math.min(cur.length, position - 1)), 0, +stepId);
  reorder(courseId, cur);
}
function deleteStep(stepId) { db.prepare('DELETE FROM path_steps WHERE id=?').run(stepId); }
function clearPath(courseId) { db.prepare('DELETE FROM path_steps WHERE course_id=?').run(courseId); }
function updateStep(stepId, { title, config }) {
  const st = db.prepare('SELECT * FROM path_steps WHERE id=?').get(stepId); if (!st) return;
  db.prepare('UPDATE path_steps SET title=?, config=? WHERE id=?').run(title || st.title, JSON.stringify(config || JSON.parse(st.config)), stepId);
}

/* ---------- Quiz Studio: list quizzes, build launch URLs, accept results ---------- */
async function listQuizzes() {
  if (!quizEnabled()) return [];
  const r = await fetch(QUIZ_URL + '/api/sso/quizzes', { headers: { Authorization: 'Bearer ' + LAUNCH_SECRET }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('Quiz Studio HTTP ' + r.status);
  return r.json();
}
/** Signed launch URL: Quiz Studio skips the name gate and posts the score to callbackUrl when the student finishes. */
function launchUrl({ user, step, course, baseUrl }) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = ssoLib.sign({
    iss: 'aininjas-academy', aud: 'quiz-studio', sub: String(user.id), jti: crypto.randomBytes(8).toString('hex'), iat: now, exp: now + 3 * 3600,
    email: user.email, name: user.name, school: user.organization || null, school_slug: user.school_slug || null, class_name: user.class_name || null,
    step_id: step.id, course_id: course.id, source: 'Academy',
    callback_url: `${baseUrl}/api/quiz-results`, return_url: `${baseUrl}/courses/${course.id}?done=${step.id}`,
  }, LAUNCH_SECRET);
  return `${QUIZ_URL}/launch/${step.config.quiz_id}?launch=${encodeURIComponent(jwt)}`;
}
/** Verify + apply a result posted by Quiz Studio. Returns the progress row or throws. */
function applyQuizResult(rawBody, headers) {
  const h = String(headers['x-ain-signature'] || '');
  const m = /t=(\d+),v1=([a-f0-9]+)/.exec(h);
  if (!m) throw new Error('Missing signature');
  if (Math.abs(Date.now() / 1000 - +m[1]) > 300) throw new Error('Stale');
  const expect = crypto.createHmac('sha256', LAUNCH_SECRET).update(m[1] + '.' + rawBody).digest('hex');
  if (expect.length !== m[2].length || !crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(m[2]))) throw new Error('Bad signature');
  const ev = JSON.parse(rawBody);
  const userId = +ev.student_ref;
  const step = db.prepare('SELECT * FROM path_steps WHERE id=?').get(+ev.step_id);
  if (!userId || !step) throw new Error('Unknown student or step');
  // keep the best score if they retry
  const cur = db.prepare('SELECT * FROM step_progress WHERE user_id=? AND step_id=?').get(userId, step.id);
  let prevPts = -1; if (cur && cur.score_json) { try { prevPts = JSON.parse(cur.score_json).points ?? -1; } catch {} }
  const scoreJson = JSON.stringify({ points: ev.points, max_points: ev.max_points, accuracy: ev.accuracy, xp: ev.xp, belt: ev.belt, best_streak: ev.best_streak, attempt_id: ev.attempt_id, quiz_id: ev.quiz_id, finished_at: ev.finished_at });
  if (cur) db.prepare("UPDATE step_progress SET status='done', score_json=CASE WHEN ? >= ? THEN ? ELSE score_json END, completed_at=COALESCE(completed_at, datetime('now')) WHERE id=?").run(+ev.points, prevPts, scoreJson, cur.id);
  else db.prepare("INSERT INTO step_progress (user_id, step_id, status, score_json, completed_at) VALUES (?, ?, 'done', ?, datetime('now'))").run(userId, step.id, scoreJson);
  q.logEvent.run(userId, step.course_id, null, 'quiz_completed', JSON.stringify({ step_id: step.id, quiz_id: ev.quiz_id, points: ev.points, max_points: ev.max_points, belt: ev.belt }));
  return { userId, step };
}

/* ---------- student actions on custom steps ---------- */
function markStarted(userId, stepId) {
  db.prepare("INSERT INTO step_progress (user_id, step_id, status) VALUES (?, ?, 'started') ON CONFLICT(user_id, step_id) DO NOTHING").run(userId, stepId);
}
function markDone(userId, stepId, { notebook_url } = {}) {
  db.prepare(`INSERT INTO step_progress (user_id, step_id, status, notebook_url, completed_at) VALUES (?, ?, 'done', ?, datetime('now'))
              ON CONFLICT(user_id, step_id) DO UPDATE SET status='done', notebook_url=COALESCE(excluded.notebook_url, step_progress.notebook_url), completed_at=COALESCE(step_progress.completed_at, datetime('now'))`)
    .run(userId, stepId, notebook_url || null);
}

/** Admin grid: every learner × every step for a course. */
function classGrid(courseId) {
  const steps = stepsFor(courseId);
  const learners = db.prepare(`SELECT u.* FROM users u JOIN enrollments e ON e.user_id=u.id WHERE e.course_id=? AND e.status='active' ORDER BY u.name`).all(courseId);
  return { steps, rows: learners.map(u => ({ user: u, summary: pathSummary(u.id, courseId) })) };
}

module.exports = { stepsFor, hasCustomPath, pathSummary, addStep, materialise, moveStep, reorder, moveTo, deleteStep, clearPath, updateStep, listQuizzes, launchUrl, applyQuizResult, markStarted, markDone, classGrid, quizEnabled, QUIZ_URL, TYPE_LABEL };
