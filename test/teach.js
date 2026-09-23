/* Teaching a course to a class: the class's own place, resumed, per class, touching no student.
 * Run:  node test/teach.js */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-'));
process.env.DATA_DIR = DATA;
const PORT = 20000 + Math.floor(Math.random() * 20000), base = `http://127.0.0.1:${PORT}`;

const ok = [], bad = [];
const check = (n, c, d) => (c ? ok : bad).push(n + (d ? ` — ${d}` : ''));
let cookie = '';

async function post(url, fields, json) {
  const body = json ? JSON.stringify(fields) : new URLSearchParams();
  if (!json) for (const [k, v] of Object.entries(fields)) (Array.isArray(v) ? v : [v]).forEach(x => body.append(k, x));
  const r = await fetch(base + url, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded', cookie },
    body: json ? body : body.toString(),
  });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, loc: r.headers.get('location'), text: await r.text() };
}
const get = async url => {
  const r = await fetch(base + url, { headers: { cookie }, redirect: 'manual' });
  return { status: r.status, loc: r.headers.get('location'), text: await r.text() };
};

(async () => {
  const srv = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), SESSION_SECRET: 'teach-test',
      ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'admin12345',
      /* Quiz Studio configured, so the live hand-off is exercised for real rather than
         falling through to the "not set up" branch and passing on a 404. */
      QUIZ_STUDIO_URL: 'https://quiz.example.test', QUIZ_LAUNCH_SECRET: 'test-secret',
      /* A deployed Academy always has this; the hand-off to Quiz Studio uses it to say where
         "back to the lesson plan" leads. */
      BASE_URL: base },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
  for (let i = 0; i < 80; i++) { try { await fetch(base + '/login'); break; } catch { await new Promise(r => setTimeout(r, 250)); } }

  const Database = require('better-sqlite3');
  const dbFile = path.join(DATA, 'lms.sqlite');
  let sql = null;
  for (let i = 0; i < 80; i++) {
    if (fs.existsSync(dbFile)) {
      const probe = new Database(dbFile, { readonly: true });
      const has = probe.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='class_lessons'").get().n;
      probe.close();
      if (has) { sql = new Database(dbFile); break; }
    }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!sql) { console.error('schema never appeared\n' + log); process.exit(2); }
  const bcrypt = require('bcryptjs');

  // --- a course with two lessons and a Colab step, two classes, one teacher ---
  sql.prepare(`INSERT INTO courses (slug, title, manifest_json, is_published) VALUES ('ai-foundations','AI Foundations','{}',1)`).run();
  const COURSE = sql.prepare("SELECT id FROM courses WHERE slug='ai-foundations'").get().id;
  const sco = (ident, title, order) => {
    sql.prepare(`INSERT INTO scos (course_id, identifier, title, launch_href, sort_order) VALUES (?, ?, ?, 'index.html', ?)`)
      .run(COURSE, ident, title, order);
    return sql.prepare('SELECT id FROM scos WHERE course_id=? AND identifier=?').get(COURSE, ident).id;
  };
  const L1 = sco('L1', 'Lesson 1 · What AI is', 0), L2 = sco('L2', 'Lesson 2 · How it learns', 1);
  sql.prepare(`INSERT INTO path_steps (course_id, sort_order, type, title, config, audience) VALUES (?,0,'sco',?,?,'student')`)
    .run(COURSE, 'Lesson 1 · What AI is', JSON.stringify({ sco_id: L1 }));
  sql.prepare(`INSERT INTO path_steps (course_id, sort_order, type, title, config, audience) VALUES (?,1,'colab',?,?,'class')`)
    .run(COURSE, 'Practice · First notebook', JSON.stringify({ url: 'https://colab.research.google.com/x' }));
  sql.prepare(`INSERT INTO path_steps (course_id, sort_order, type, title, config, audience) VALUES (?,2,'sco',?,?,'student')`)
    .run(COURSE, 'Lesson 2 · How it learns', JSON.stringify({ sco_id: L2 }));
  const COLAB = sql.prepare("SELECT id FROM path_steps WHERE course_id=? AND type='colab'").get(COURSE).id;

  const learner = (name, cls) => {
    sql.prepare(`INSERT INTO users (name,email,role,status,school_slug,class_name,password_hash)
                 VALUES (?,?,'learner','approved','darularqam',?, 'x')`).run(name, `${name}@d.edu`, cls);
    const id = sql.prepare('SELECT id FROM users WHERE email=?').get(`${name}@d.edu`).id;
    sql.prepare(`INSERT INTO enrollments (user_id, course_id, status) VALUES (?,?,'active')`).run(id, COURSE);
    return id;
  };
  const aisha = learner('aisha', 'Grade 9'), zain = learner('zain', 'Grade 8');

  /* A teacher's classes live in users.classes as JSON — class_name is the student's own class. */
  sql.prepare(`INSERT INTO users (name,email,role,status,school_slug,classes,password_hash)
               VALUES ('Ms Khan','khan@d.edu','teacher','approved','darularqam',?,?)`)
    .run(JSON.stringify(['Grade 9', 'Grade 8']), bcrypt.hashSync('teach12345', 10));

  const login = await post('/login', { email: 'khan@d.edu', password: 'teach12345' });
  check('the teacher signs in', login.status === 302 && !/login/.test(login.loc || ''), `${login.status} → ${login.loc}`);

  // --- the class page offers it ---
  const classPage = await get('/classes/Grade%209');
  check('the class page has a Teach button', /\/classes\/Grade(%20| )9\/teach/.test(classPage.text), 'no Teach link');

  const idx = await get('/classes/Grade%209/teach');
  check('the teach page lists the class\'s course', idx.status === 200 && idx.text.includes('AI Foundations'), String(idx.status));
  check('and says it has not been started', /Not started with this class/.test(idx.text));

  // --- resume with nothing done goes to the first lesson ---
  let r = await get(`/classes/Grade%209/teach/${COURSE}/resume`);
  check('Resume goes to the first lesson', r.status === 302 && String(r.loc || '').endsWith(`/play/${L1}`), `${r.status} → ${r.loc}`);

  const player = await get(`/classes/Grade%209/teach/${COURSE}/play/${L1}`);
  check('the player opens in teaching mode', player.status === 200 && /teaching Grade 9/.test(player.text), String(player.status));
  check('the SCO is told the class name, not the teacher\'s', /"student_name":"Grade 9"/.test(player.text),
    (player.text.match(/"student_name":"[^"]*"/) || [])[0]);
  check('it says nothing is recorded against a student',
    /recorded against any student/i.test(player.text) && !/class\\/.test(player.text),
    'missing, or a stray backslash in the apostrophe');
  check('it commits to the class endpoint', player.text.includes(`/teach/${COURSE}/play/${L1}/commit`));

  // --- the lesson files themselves must be fetchable, or the iframe says Forbidden ---
  {
    const dir = path.join(DATA, 'courses', 'ai-foundations');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>lesson</body></html>');
    const asTeacher = await get('/content/ai-foundations/index.html');
    check('a teacher can fetch the lesson files she is teaching', asTeacher.status === 200,
      `${asTeacher.status} — the player shell loads but the lesson iframe is refused`);
  }

  // --- teach part of it, then stop ---
  await post(`/classes/Grade%209/teach/${COURSE}/play/${L1}/commit`,
    { cmi: { core: { lesson_status: 'incomplete', lesson_location: '5', exit: 'suspend' }, suspend_data: 'slide5' }, elapsed_seconds: 300 }, true);
  const row = sql.prepare('SELECT * FROM class_lessons WHERE class_name=? AND sco_id=?').get('Grade 9', L1);
  check('the class\'s place is saved', row && row.lesson_location === '5' && row.suspend_data === 'slide5', JSON.stringify(row && row.lesson_location));
  check('no student progress row was created', sql.prepare('SELECT COUNT(*) n FROM sco_progress').get().n === 0,
    String(sql.prepare('SELECT COUNT(*) n FROM sco_progress').get().n));

  // --- come back: it resumes ---
  const again = await get(`/classes/Grade%209/teach/${COURSE}/play/${L1}`);
  check('reopening resumes rather than restarting', /"entry":"resume"/.test(again.text), (again.text.match(/"entry":"[^"]*"/) || [])[0]);
  check('and returns to the same place', /"lesson_location":"5"/.test(again.text));
  check('the cover says so', /Picking up where Grade 9 left off/.test(again.text));

  const back = await get(`/classes/Grade%209/teach/${COURSE}`);
  check('the course page shows it part way through', /Part way through/.test(back.text));
  r = await get(`/classes/Grade%209/teach/${COURSE}/resume`);
  check('Resume returns to the unfinished lesson, not the next one', String(r.loc || '').endsWith(`/play/${L1}`), `${r.status} → ${r.loc}`);

  // --- a second class is independent ---
  const g8 = await get(`/classes/Grade%208/teach/${COURSE}/play/${L1}`);
  check('another class starts from the beginning', /"entry":"ab-initio"/.test(g8.text), (g8.text.match(/"entry":"[^"]*"/) || [])[0]);
  check('and has its own name in the runtime', /"student_name":"Grade 8"/.test(g8.text));
  const g9row = sql.prepare('SELECT lesson_location FROM class_lessons WHERE class_name=? AND sco_id=?').get('Grade 9', L1);
  check('Grade 9 was not disturbed', g9row && g9row.lesson_location === '5', JSON.stringify(g9row));

  // --- finish it, and the next step becomes next ---
  await post(`/classes/Grade%209/teach/${COURSE}/play/${L1}/commit`,
    { cmi: { core: { lesson_status: 'completed', lesson_location: '9', exit: '' } }, finishing: true, elapsed_seconds: 200 }, true);
  r = await get(`/classes/Grade%209/teach/${COURSE}/resume`);
  check('once taught, Resume moves to the Colab step', String(r.loc || '').includes(`#step-${COLAB}`), `${r.status} → ${r.loc}`);

  // --- non-lesson steps are ticked off ---
  await post(`/classes/Grade%209/teach/${COURSE}/steps/${COLAB}/covered`, {});
  check('a Colab step can be marked covered',
    !!sql.prepare('SELECT * FROM class_steps WHERE class_name=? AND step_id=?').get('Grade 9', COLAB));
  r = await get(`/classes/Grade%209/teach/${COURSE}/resume`);
  check('and Resume then moves to the last lesson', String(r.loc || '').endsWith(`/play/${L2}`), `${r.status} → ${r.loc}`);
  await post(`/classes/Grade%209/teach/${COURSE}/steps/${COLAB}/covered`, { undo: '1' });
  check('and can be unticked', !sql.prepare('SELECT * FROM class_steps WHERE class_name=? AND step_id=?').get('Grade 9', COLAB));

  // --- showing the exercise code on the projector ---
  {
    // give the Colab step a real notebook file
    const nbDir = path.join(DATA, 'notebooks');
    fs.mkdirSync(nbDir, { recursive: true });
    fs.writeFileSync(path.join(nbDir, 'ex1.ipynb'), JSON.stringify({
      cells: [
        { cell_type: 'markdown', source: ['# Exercise 1\n', 'Type this into your own Colab.'] },
        { cell_type: 'code', source: ['import numpy as np\n', 'print(np.arange(5))'] },
        { cell_type: 'code', source: ['   \n'] },                       // blank: should be dropped
      ],
    }));
    sql.prepare('UPDATE path_steps SET config=? WHERE id=?')
      .run(JSON.stringify({ file: 'ex1.ipynb', filename: 'ex1.ipynb' }), COLAB);

    const code = await get(`/classes/Grade%209/teach/${COURSE}/steps/${COLAB}/code`);
    check('the code page opens', code.status === 200, String(code.status));
    check('it shows the code cell', code.text.includes('import numpy as np') && code.text.includes('print(np.arange(5))'));
    check('and the markdown notes', /Type this into your own Colab/.test(code.text));
    check('empty cells are dropped', (code.text.match(/Code · cell/g) || []).length === 1,
      String((code.text.match(/Code · cell/g) || []).length));
    check('code cells are numbered among themselves, not by notebook position',
      /Code · cell 1/.test(code.text), (code.text.match(/Code · cell \d+/) || [])[0]);
    check('the back button is styled for the dark bar', /\.proj-bar \.btn\{/.test(code.text));
    check('and says where it goes rather than just "exit"', /← Lesson plan/.test(code.text));
    check('it offers a text size control for the room', /id="bigger"/.test(code.text));
    check('and a way back to the course', code.text.includes(`/teach/${COURSE}"`));

    // a missing file must say so rather than crash
    sql.prepare('UPDATE path_steps SET config=? WHERE id=?').run(JSON.stringify({ file: 'gone.ipynb' }), COLAB);
    const missing = await get(`/classes/Grade%209/teach/${COURSE}/steps/${COLAB}/code`);
    check('a missing notebook is explained, not a crash', missing.status === 200 && /missing from the server/.test(missing.text), String(missing.status));

    // a link-only step offers the link
    sql.prepare('UPDATE path_steps SET config=? WHERE id=?')
      .run(JSON.stringify({ url: 'https://colab.research.google.com/x' }), COLAB);
    const linked = await get(`/classes/Grade%209/teach/${COURSE}/steps/${COLAB}/code`);
    check('a link-only step offers the Colab link instead',
      /no cells to put on screen/.test(linked.text) && linked.text.includes('colab.research.google.com'));

    // and a lesson step has no code page
    const notCode = await get(`/classes/Grade%209/teach/${COURSE}/steps/999999/code`);
    check('a step that is not a Colab has no code page', notCode.status === 404, String(notCode.status));
  }

  // --- handing a quiz step to the live host ---
  {
    sql.prepare(`INSERT INTO path_steps (course_id, sort_order, type, title, config, audience)
                 VALUES (?,3,'quiz','Check · Level 1 quiz',?,'class')`)
      .run(COURSE, JSON.stringify({ quiz_id: 7, quiz_title: 'Level 1' }));
    const QUIZ = sql.prepare("SELECT id FROM path_steps WHERE course_id=? AND type='quiz'").get(COURSE).id;

    const page = await get(`/classes/Grade%209/teach/${COURSE}`);
    check('a quiz step offers Run live', page.text.includes(`/steps/${QUIZ}/live`), 'no Run live button');
    check('and a Colab step offers Show the code', page.text.includes(`/steps/${COLAB}/code`), 'no Show the code button');

    const live = await get(`/classes/Grade%209/teach/${COURSE}/steps/${QUIZ}/live`);
    check('Run live hands over to the live host',
      live.status === 302 && /\/admin\/live\?/.test(live.loc || ''), `${live.status} → ${live.loc}`);
    check('with the quiz already chosen', /quiz=7/.test(live.loc || ''), live.loc);
    check('and the class already chosen', /class=Grade(%20|\+)9/.test(live.loc || ''), live.loc);

    /* The way home. Quiz Studio is a different app, so the teacher only gets back to the lesson
       plan she left if we hand her the link to it. */
    const backParam = new URL(live.loc, base).searchParams.get('back');
    check('and the lesson plan handed over as the way back', !!backParam, live.loc);
    check('the way back points at this Academy, not somewhere else',
      backParam && new URL(backParam).origin === new URL(base).origin, String(backParam));
    check('and lands on the class\'s plan for this course',
      backParam && new URL(backParam).pathname === `/classes/${encodeURIComponent('Grade 9')}/teach/${COURSE}`,
      String(backParam));

    const home = await get(new URL(backParam).pathname);
    check('which is a page she may actually open', home.status === 200, String(home.status));
  }

  // --- resetting clears the class, not the students ---
  sql.prepare(`INSERT INTO sco_progress (user_id, sco_id, lesson_status, lesson_location) VALUES (?,?,'completed','9')`).run(aisha, L1);
  await post(`/classes/Grade%209/teach/${COURSE}/reset`, {});
  check('reset clears the class\'s place',
    sql.prepare('SELECT COUNT(*) n FROM class_lessons WHERE class_name=?').get('Grade 9').n === 0);
  check('and leaves the student\'s progress alone',
    sql.prepare('SELECT COUNT(*) n FROM sco_progress WHERE user_id=?').get(aisha).n === 1);
  check('Grade 8 still has its own row',
    sql.prepare('SELECT COUNT(*) n FROM class_lessons WHERE class_name=?').get('Grade 8').n === 1);

  // --- a class this teacher does not have ---
  sql.prepare(`INSERT INTO users (name,email,role,status,school_slug,classes,password_hash)
               VALUES ('Mr Other','other@d.edu','teacher','approved','darularqam',?,?)`)
    .run(JSON.stringify(['Grade 7']), bcrypt.hashSync('other12345', 10));
  cookie = '';
  await post('/login', { email: 'other@d.edu', password: 'other12345' });
  const denied = await get('/classes/Grade%209/teach');
  check('a teacher cannot teach a class that is not hers', denied.status === 403, String(denied.status));
  const deniedPlay = await get(`/classes/Grade%209/teach/${COURSE}/play/${L1}`);
  check('nor open its player', deniedPlay.status === 403, String(deniedPlay.status));

  // --- content is still closed to a learner who is not enrolled ---
  {
    sql.prepare(`INSERT INTO users (name,email,role,status,school_slug,class_name,password_hash)
                 VALUES ('Nobody','nobody@d.edu','learner','approved','darularqam','Grade 9',?)`)
      .run(bcrypt.hashSync('ninja12345', 10));
    cookie = '';
    await post('/login', { email: 'nobody@d.edu', password: 'ninja12345' });
    const r2 = await get('/content/ai-foundations/index.html');
    check('an unenrolled learner still cannot fetch lesson files', r2.status === 403, String(r2.status));
  }

  // --- a student cannot reach any of it ---
  sql.prepare('UPDATE users SET password_hash=? WHERE email=?').run(bcrypt.hashSync('ninja12345', 10), 'aisha@d.edu');
  cookie = '';
  await post('/login', { email: 'aisha@d.edu', password: 'ninja12345' });
  const asStudent = await get('/classes/Grade%209/teach');
  check('a student cannot reach the teaching view', asStudent.status === 403 || asStudent.status === 302, String(asStudent.status));

  sql.close(); srv.kill();
  console.log('\nPASS'); ok.forEach(t => console.log('  ✓ ' + t));
  if (bad.length) { console.log('\nFAIL'); bad.forEach(t => console.log('  ✗ ' + t)); console.log('\n--- server log ---\n' + log.slice(-2500)); }
  console.log(`\n${ok.length} passed, ${bad.length} failed`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
