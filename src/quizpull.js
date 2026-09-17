// Quiz attempts made outside the Academy (plain Quiz Studio share links) for the class reports.
//
// Only quizzes launched from the Academy post their results back. Everything else lives in Quiz Studio, so the reports
// ask Quiz Studio for the school's attempts (over the private network in one-site mode) and match them to students:
//   1. by student_ref — the Academy user id Quiz Studio stored for launched attempts (already known to the Academy, but
//      it also lets a launched attempt that failed to post back be shown);
//   2. otherwise by name + class within the school, case-insensitive — how a student identifies on a plain share link.
// Attempts are cached per school for a minute. They are shown as "outside Academy" and never counted in the quiz
// average unless QUIZ_OUTSIDE_COUNTS=1 (decision left open in the spec; default: shown, not counted).
const onesite = require('./onesite');

const LAUNCH_SECRET = process.env.QUIZ_LAUNCH_SECRET || '';
const TTL = 60 * 1000;
const cache = new Map();                       // slug → { at, rows }
const COUNTS = process.env.QUIZ_OUTSIDE_COUNTS === '1';

async function attemptsFor(schoolSlug) {
  if (!onesite.quiz.api || !LAUNCH_SECRET || !schoolSlug) return [];
  const c = cache.get(schoolSlug);
  if (c && c.at > Date.now() - TTL) return c.rows;
  let rows = [];
  try {
    const r = await fetch(`${onesite.quiz.api}/api/sso/attempts?school=${encodeURIComponent(schoolSlug)}`, { headers: { Authorization: 'Bearer ' + LAUNCH_SECRET }, signal: AbortSignal.timeout(8000) });
    if (r.ok) rows = await r.json();
  } catch (e) { console.warn('[quizpull]', e.message); }
  cache.set(schoolSlug, { at: Date.now(), rows });
  return rows;
}

const key = (name, cls) => `${String(name || '').trim().toLowerCase()}|${String(cls || '').trim().toLowerCase()}`;

/** Outside-Academy attempts per student id for a list of students of one school: { [userId]: [attempt…] }. */
async function outsideByStudent(schoolSlug, students) {
  const rows = await attemptsFor(schoolSlug);
  if (!rows.length) return {};
  const byRef = new Map(), byName = new Map();
  for (const u of students) { byRef.set(String(u.id), u.id); byName.set(key(u.name, u.class_name), u.id); }
  const out = {};
  for (const a of rows) {
    if (a.launched) continue;                                   // launched from the Academy → already in step_progress
    const uid = (a.student_ref && byRef.get(String(a.student_ref))) || byName.get(key(a.student_name, a.class_name));
    if (!uid) continue;
    (out[uid] = out[uid] || []).push({ id: a.id, quiz_id: a.quiz_id, title: a.quiz_title, points: a.points + (a.teacher_points || 0), max: a.max_points, accuracy: a.accuracy, belt: a.belt, when: a.created_at });
  }
  /* best attempt per quiz per student */
  for (const uid of Object.keys(out)) {
    const best = new Map();
    for (const a of out[uid]) { const b = best.get(a.quiz_id); if (!b || a.points > b.points) best.set(a.quiz_id, a); }
    out[uid] = [...best.values()].sort((x, y) => (x.when < y.when ? 1 : -1));
  }
  return out;
}

module.exports = { attemptsFor, outsideByStudent, COUNTS };
