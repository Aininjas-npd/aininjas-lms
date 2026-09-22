/* The curriculum screens end to end: create, inherit, reorder, preview, confirm, and the gate.
 * Run:  node test/curriculum-routes.js */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'curriculum-routes-'));
process.env.DATA_DIR = DATA;          // set before anything under src/ is required
const PORT = 4323, base = `http://127.0.0.1:${PORT}`;

const ok = [], bad = [];
const check = (n, c, d) => (c ? ok : bad).push(n + (d ? ` — ${d}` : ''));
let cookie = '';

async function post(url, fields) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) (Array.isArray(v) ? v : [v]).forEach(x => body.append(k, x));
  const r = await fetch(base + url, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: body.toString(),
  });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const text = await r.text();
  return { status: r.status, loc: r.headers.get('location'), text };
}
const get = async url => {
  const r = await fetch(base + url, { headers: { cookie }, redirect: 'manual' });
  return { status: r.status, loc: r.headers.get('location'), text: await r.text() };
};

(async () => {
  const srv = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), SESSION_SECRET: 'cur-test',
      ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'admin12345' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
  let up = false;
  for (let i = 0; i < 80; i++) { try { await fetch(base + '/login'); up = true; break; } catch { await new Promise(r => setTimeout(r, 250)); } }
  if (!up) { console.error('server never came up on ' + base + '\n--- log ---\n' + log); process.exit(2); }

  // seed courses and a class straight into the database the server is using
  const sql = require('better-sqlite3')(path.join(DATA, 'lms.sqlite'));
  const course = t => {
    const slug = t.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    sql.prepare('INSERT INTO courses (slug, title, manifest_json, is_published) VALUES (?, ?, ?, 1)').run(slug, t, '{}');
    return sql.prepare('SELECT id FROM courses WHERE slug=?').get(slug).id;
  };
  const FOUND = course('Foundations Challenge'), PY = course('Python for AI'),
    DISC = course('The Disciple'), PRED = course('The Predictor'), PAT = course('The Pattern Apprentice');
  ['Aisha', 'Bilal', 'Sami'].forEach(n => sql.prepare(
    `INSERT INTO users (name, email, role, status, school_slug, class_name, password_hash)
     VALUES (?, ?, 'learner', 'approved', 'darularqam', 'Grade 9', 'x')`).run(n, `${n.toLowerCase()}@das.edu`));

  const login = await post('/login', { email: 'admin@test.local', password: 'admin12345' });
  check('admin signs in', login.status === 302 && !/login/.test(login.loc || ''), `${login.status} → ${login.loc}`);

  // --- create Grade 8, add its four courses ---
  const mk = await post('/admin/curricula', { title: 'Level 1 — Grade 8', school_slug: 'darularqam', sequential: 'on' });
  const g8 = (mk.loc || '').match(/curricula\/(\d+)/);
  check('creating a curriculum lands on its page', !!g8, mk.loc);
  for (const c of [FOUND, PY, DISC, PRED]) await post(`/admin/curricula/${g8[1]}/courses`, { course_id: c, required: 'on' });
  let page = await get(`/admin/curricula/${g8[1]}`);
  check('all four courses are listed', ['Foundations Challenge', 'Python for AI', 'The Disciple', 'The Predictor']
    .every(t => page.text.includes(t)));

  // --- Grade 9 extends it ---
  const mk9 = await post('/admin/curricula', { title: 'Grade 9 — 2026 intake', school_slug: 'darularqam', extends_id: g8[1], sequential: 'on' });
  const g9 = (mk9.loc || '').match(/curricula\/(\d+)/);
  await post(`/admin/curricula/${g9[1]}/courses`, { course_id: PAT, required: 'on' });
  page = await get(`/admin/curricula/${g9[1]}`);
  check('the child page shows the inherited courses', page.text.includes('Foundations Challenge') && page.text.includes('The Pattern Apprentice'));
  check('and says where they were inherited from', /inherited from|Inherited ·/i.test(page.text));
  check('the parent is named at the top', page.text.includes('Builds on'));

  // --- an inherited course cannot be removed from the child ---
  const badRemove = await post(`/admin/curricula/${g9[1]}/courses/remove`, { course_id: FOUND });
  page = await get(`/admin/curricula/${g9[1]}`);
  check('removing an inherited course is refused, with a reason',
    /inherited/i.test(page.text) && page.text.includes('Foundations Challenge'), String(badRemove.status));

  // --- loops are refused through the form too ---
  await post(`/admin/curricula/${g8[1]}`, { title: 'Level 1 — Grade 8', extends_id: g9[1], sequential: 'on' });
  page = await get(`/admin/curricula/${g8[1]}`);
  check('the form refuses a loop', /loop/i.test(page.text), 'no loop warning on the page');

  // --- reorder ---
  const ro = await fetch(`${base}/admin/curricula/${g8[1]}/reorder`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ ids: [PY, FOUND, DISC, PRED] }),
  });
  check('reorder is accepted', ro.ok, String(ro.status));
  page = await get(`/admin/curricula/${g9[1]}`);
  check('and the new order flows into the child',
    page.text.indexOf('Python for AI') < page.text.indexOf('Foundations Challenge'));

  // --- grade suggestion ---
  await post('/admin/curricula/grades', { school_slug: 'darularqam', grade: 'Grade 9', academic_year: '2026-27', curriculum_id: g9[1] });
  const gradeRow = sql.prepare('SELECT * FROM curriculum_grades WHERE school_slug=? AND grade=? AND academic_year=?')
    .get('darularqam', 'Grade 9', '2026-27');
  check('the grade suggestion is saved', gradeRow && gradeRow.curriculum_id === Number(g9[1]), JSON.stringify(gradeRow));
  page = await get('/admin/curricula');
  check('and shown as a badge on the list', /Grade 9<\/span>|Grade 9 · 2026-27/.test(page.text));

  // --- preview writes nothing ---
  const before = sql.prepare('SELECT COUNT(*) n FROM enrollments').get().n;
  const prev = await post(`/admin/curricula/${g9[1]}/apply/preview`, { school_slug: 'darularqam', classes: 'Grade 9' });
  check('the preview renders', prev.status === 200 && /Before anything is saved/.test(prev.text), String(prev.status));
  check('it lists the students', ['Aisha', 'Bilal', 'Sami'].every(n => prev.text.includes(n)));
  check('it shows all five courses', (prev.text.match(/Foundations Challenge|Python for AI|The Disciple|The Predictor|The Pattern Apprentice/g) || []).length >= 5);
  check('the preview enrols nobody', sql.prepare('SELECT COUNT(*) n FROM enrollments').get().n === before, 'enrolments changed during preview');

  // --- confirm, minus one course the admin unticked ---
  const conf = await post(`/admin/curricula/${g9[1]}/apply`, {
    school_slug: 'darularqam', classes: 'Grade 9', course_ids: [FOUND, PY, DISC, PRED],   // Pattern left out
  });
  check('confirming redirects to the classes page', conf.status === 302 && /\/classes/.test(conf.loc || ''), conf.loc);
  const made = sql.prepare(`SELECT COUNT(*) n FROM enrollments WHERE status='active'`).get().n;
  check('three students × four ticked courses were enrolled', made === 12, String(made));
  check('the unticked course enrolled nobody',
    sql.prepare('SELECT COUNT(*) n FROM enrollments WHERE course_id=?').get(PAT).n === 0);

  // --- applying with nothing ticked is refused ---
  const none = await post(`/admin/curricula/${g9[1]}/apply`, { school_slug: 'darularqam', classes: 'Grade 9' });
  check('confirming with every course unticked is refused', none.status === 302 && /curricula/.test(none.loc || ''), none.loc);
  check('and still nothing extra was enrolled', sql.prepare(`SELECT COUNT(*) n FROM enrollments WHERE status='active'`).get().n === 12);

  // --- the gate, from the model, against the real rows the routes just wrote ---
  const cur = require('../src/curriculum');
  const aisha = sql.prepare('SELECT id FROM users WHERE email=?').get('aisha@das.edu').id;
  let prog = cur.progressFor(aisha, Number(g9[1]));
  check('the student is gated at the first course',
    !prog.items[0].locked && prog.items[1].locked, prog.items.map(i => i.locked ? 'L' : 'o').join(''));
  sql.prepare('UPDATE enrollments SET completed_at=? WHERE user_id=? AND course_id=?').run('2026-09-20', aisha, PY);
  prog = cur.progressFor(aisha, Number(g9[1]));
  check('finishing the first opens the second', prog.items[0].done && !prog.items[1].locked,
    prog.items.map(i => (i.done ? 'D' : i.locked ? 'L' : 'o')).join(''));

  // --- the gate as a student actually experiences it ---
  // Put the class on the curriculum for the current year, then sign in as a student.
  await post('/admin/curricula/year', { academic_year: '2026-27' });
  check('the academic year is saved',
    (sql.prepare("SELECT value FROM settings WHERE key='academic_year'").get() || {}).value === '2026-27',
    JSON.stringify(sql.prepare("SELECT value FROM settings WHERE key='academic_year'").get()));
  sql.prepare('UPDATE users SET password_hash=? WHERE email=?')
    .run(require('bcryptjs').hashSync('ninja12345', 10), 'bilal@das.edu');

  const adminCookie = cookie;
  cookie = '';
  const slogin = await post('/login', { email: 'bilal@das.edu', password: 'ninja12345' });
  check('a student signs in', slogin.status === 302 && /dashboard/.test(slogin.loc || ''), `${slogin.status} → ${slogin.loc}`);

  const dash = await get('/dashboard');
  check('the dashboard shows the curriculum ladder', dash.text.includes('Grade 9 — 2026 intake'), 'ladder missing');
  check('it says what is next', /Next up/.test(dash.text));
  check('and marks the later courses as shut', /Opens later/.test(dash.text));
  check('the course cards agree with the ladder — no "Start course" on a locked one',
    !/The Disciple[\s\S]{0,400}?Start course/.test(dash.text), 'a locked course still offers Start course');
  check('a locked card says what to finish first', /opens later[\s\S]{0,200}?Finish "/i.test(dash.text));

  // Python for AI is first in the order after the reorder above; The Disciple is later and shut.
  const openFirst = await get(`/courses/${PY}`);
  check('the first course opens', openFirst.status === 200, String(openFirst.status));
  const shut = await get(`/courses/${DISC}`);
  check('a later course is refused', shut.status === 403, String(shut.status));
  check('and the refusal says what is owed first',
    /Opens later|opens in order|finished/.test(shut.text), shut.text.slice(0, 200));

  const shutStep = await get(`/courses/${DISC}/play/1`);
  check('the lesson player is shut too, not just the course page', shutStep.status === 403 || shutStep.status === 404, String(shutStep.status));

  // finishing the first opens the second
  const bilal = sql.prepare('SELECT id FROM users WHERE email=?').get('bilal@das.edu').id;
  sql.prepare('UPDATE enrollments SET completed_at=? WHERE user_id=? AND course_id=?').run('2026-09-21', bilal, PY);
  check('finishing the first opens the second', (await get(`/courses/${FOUND}`)).status === 200);

  // an unlocked curriculum gates nobody
  cookie = adminCookie;
  await post(`/admin/curricula/${g9[1]}`, { title: 'Grade 9 — 2026 intake', extends_id: g8[1] });   // sequential unchecked
  cookie = '';
  await post('/login', { email: 'bilal@das.edu', password: 'ninja12345' });
  check('unlocking the order opens everything', (await get(`/courses/${DISC}`)).status === 200);
  cookie = adminCookie;

  // --- a non-admin cannot reach any of it ---
  const anon = await fetch(base + '/admin/curricula', { redirect: 'manual' });
  check('a signed-out visitor is turned away', anon.status === 302 || anon.status === 403, String(anon.status));

  sql.close(); srv.kill();
  console.log('\nPASS'); ok.forEach(t => console.log('  ✓ ' + t));
  if (bad.length) { console.log('\nFAIL'); bad.forEach(t => console.log('  ✗ ' + t)); console.log('\n--- server log ---\n' + log.slice(-2500)); }
  console.log(`\n${ok.length} passed, ${bad.length} failed`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
