/* Who may use a curriculum, and the teacher's own way in.
 *
 * Two things under test, and they meet in the middle:
 *   1. a curriculum is offered to schools the way a course is — nothing ticked means everyone
 *   2. a teacher can enrol HER class from a curriculum HER school is offered, and nothing else
 *
 * Run:  node test/curriculum-access.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cur-access-'));
process.env.DATA_DIR = DATA;
const PORT = 20000 + Math.floor(Math.random() * 20000), base = `http://127.0.0.1:${PORT}`;

const ok = [], bad = [];
const check = (n, c, d) => (c ? ok : bad).push(n + (d ? ` — ${d}` : ''));
let cookie = '';

async function post(url, fields) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) (Array.isArray(v) ? v : [v]).forEach(x => body.append(k, x));
  const r = await fetch(base + url, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: body.toString(),
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
    env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), SESSION_SECRET: 'cur-access-test',
      ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'admin12345', BASE_URL: base },
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
      const has = probe.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='curriculum_schools'").get().n;
      probe.close();
      if (has) { sql = new Database(dbFile); break; }
    }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!sql) { console.error('schema never appeared\n' + log); process.exit(2); }
  const bcrypt = require('bcryptjs');

  /* ---- two schools, three courses, one class each ---- */
  const course = t => {
    const slug = t.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    sql.prepare('INSERT INTO courses (slug, title, manifest_json, is_published) VALUES (?, ?, ?, 1)').run(slug, t, '{}');
    return sql.prepare('SELECT id FROM courses WHERE slug=?').get(slug).id;
  };
  const FOUND = course('Foundations Challenge'), PY = course('Python for AI'), DISC = course('The Disciple');

  const learner = (name, school, cls) => {
    sql.prepare(`INSERT INTO users (name,email,role,status,school_slug,class_name,password_hash)
                 VALUES (?,?,'learner','approved',?,?, 'x')`).run(name, `${name}@${school}.edu`, school, cls);
    return sql.prepare('SELECT id FROM users WHERE email=?').get(`${name}@${school}.edu`).id;
  };
  ['Aisha', 'Bilal', 'Sami'].forEach(n => learner(n, 'darularqam', 'Grade 9'));
  learner('Omar', 'otherschool', 'Grade 9');

  const staff = (name, email, role, school, classes) =>
    sql.prepare(`INSERT INTO users (name,email,role,status,school_slug,classes,password_hash) VALUES (?,?,?,'approved',?,?,?)`)
      .run(name, email, role, school, JSON.stringify(classes), bcrypt.hashSync('teach12345', 10));
  staff('Ms Khan', 'khan@das.edu', 'teacher', 'darularqam', ['Grade 9']);
  staff('Mr Idris', 'idris@das.edu', 'school_admin', 'darularqam', []);
  staff('Ms Rao', 'rao@other.edu', 'teacher', 'otherschool', ['Grade 9']);

  /* ---- the model rules, before any screen ---- */
  const cur = (() => { process.env.DATA_DIR = DATA; return require('../src/curriculum'); })();

  const open = cur.create({ title: 'Level 1 (template)', sequential: 1 });
  [FOUND, PY, DISC].forEach(c => cur.addCourse(open.id, c));
  check('a template with no schools ticked is open to every school',
    cur.openTo(open.id, 'darularqam') && cur.openTo(open.id, 'otherschool'));

  cur.setSchoolsFor(open.id, ['darularqam']);
  check('naming a school shuts the others out', cur.openTo(open.id, 'darularqam') && !cur.openTo(open.id, 'otherschool'));
  check('and the list reflects it', cur.list('darularqam').some(c => c.id === open.id) && !cur.list('otherschool').some(c => c.id === open.id));

  cur.setSchoolsFor(open.id, []);
  check('clearing the list opens it again', cur.openTo(open.id, 'otherschool'));

  const owned = cur.create({ title: 'Darul Arqam only', schoolSlug: 'darularqam', sequential: 1 });
  cur.addCourse(owned.id, FOUND);
  check('a curriculum owned by a school is that school\'s alone',
    cur.openTo(owned.id, 'darularqam') && !cur.openTo(owned.id, 'otherschool'));

  const draft = cur.create({ title: 'Not ready yet', sequential: 1 });
  cur.update(draft.id, { isPublished: 0 });
  check('an unpublished curriculum is not offered to anyone', !cur.forSchool('darularqam').some(c => c.id === draft.id));

  /* a suggestion for a curriculum the school loses stops laddering its students */
  cur.setForGrade('otherschool', 'Grade 9', open.id);
  const omar = sql.prepare("SELECT * FROM users WHERE email='Omar@otherschool.edu'").get();
  check('a student is on the curriculum their grade is suggested', !!cur.forStudent(omar));
  cur.setSchoolsFor(open.id, ['darularqam']);
  check('withdrawing it from their school stops the ladder at once', !cur.forStudent(omar));
  cur.setSchoolsFor(open.id, []);

  cur.setForGrade('darularqam', 'Grade 9', open.id);

  /* ---- the teacher's page ---- */
  let r = await post('/login', { email: 'khan@das.edu', password: 'teach12345' });
  check('the teacher signs in', r.status === 302 && !/login/.test(r.loc || ''), `${r.status} → ${r.loc}`);

  const classPage = await get('/classes/Grade%209');
  check('the class page offers Curriculum', /\/classes\/Grade(%20| )9\/curriculum/.test(classPage.text), 'no Curriculum link');

  let page = await get('/classes/Grade%209/curriculum');
  check('the curriculum page opens for a teacher', page.status === 200, String(page.status));
  check('it names the curriculum suggested for the grade', page.text.includes('Level 1 (template)'));
  check('and lists its courses in order',
    page.text.indexOf('Foundations Challenge') < page.text.indexOf('Python for AI'), 'wrong order');
  check('it offers to enrol the class', /curriculum\/preview/.test(page.text));
  check('a teacher is not offered the grade mapping', !/curriculum\/suggest/.test(page.text));
  check('it counts the students in the class', /3 students/.test(page.text), 'no student count');

  /* a curriculum this school is not offered is neither listed nor reachable */
  const foreign = cur.create({ title: 'Someone else\'s list', schoolSlug: 'otherschool', sequential: 1 });
  cur.addCourse(foreign.id, DISC);
  page = await get('/classes/Grade%209/curriculum');
  check('another school\'s curriculum is not listed', !page.text.includes('Someone else'));
  page = await get(`/classes/Grade%209/curriculum?c=${foreign.id}`);
  check('and asking for it by id shows nothing of it', !page.text.includes('Someone else'), 'leaked through the query string');

  const sneak = await post('/classes/Grade%209/curriculum/preview', { curriculum_id: foreign.id });
  check('previewing it is refused', sneak.status === 302 && /curriculum$/.test(sneak.loc || ''), `${sneak.status} → ${sneak.loc}`);
  const sneak2 = await post('/classes/Grade%209/curriculum/apply', { curriculum_id: foreign.id, course_ids: DISC });
  check('and so is applying it', sneak2.status === 302,
    String(sql.prepare('SELECT COUNT(*) n FROM enrollments WHERE course_id=?').get(DISC).n));
  check('nothing was enrolled by the attempt',
    sql.prepare('SELECT COUNT(*) n FROM enrollments WHERE course_id=?').get(DISC).n === 0);

  /* a class she does not teach */
  const notHers = await get('/classes/Grade%208/curriculum');
  check('a class she does not teach is refused', notHers.status === 403, String(notHers.status));

  /* ---- preview, then enrol, for real ---- */
  const prev = await post('/classes/Grade%209/curriculum/preview', { curriculum_id: open.id });
  check('the preview opens', prev.status === 200, String(prev.status));
  check('it says nothing has been written yet', /Nothing has been written yet/i.test(prev.text));
  check('it posts back to the class, not to the admin screen', /action="\/classes\/Grade%209\/curriculum\/apply"/.test(prev.text), 'wrong form action');
  check('no enrolment happened from the preview',
    sql.prepare('SELECT COUNT(*) n FROM enrollments').get().n === 0, 'the preview wrote something');

  const done = await post('/classes/Grade%209/curriculum/apply', { curriculum_id: open.id, course_ids: [FOUND, PY, DISC] });
  check('confirming redirects back to the class curriculum', done.status === 302 && /curriculum\?c=/.test(done.loc || ''), `${done.status} → ${done.loc}`);
  check('every student in the class is enrolled in every course',
    sql.prepare("SELECT COUNT(*) n FROM enrollments WHERE status='active'").get().n === 9,
    String(sql.prepare("SELECT COUNT(*) n FROM enrollments WHERE status='active'").get().n));
  check('and nobody at the other school was touched',
    sql.prepare(`SELECT COUNT(*) n FROM enrollments e JOIN users u ON u.id=e.user_id WHERE u.school_slug='otherschool'`).get().n === 0);
  check('the batch is labelled with the curriculum',
    /Curriculum: Level 1/.test(sql.prepare('SELECT note FROM enrollment_batches ORDER BY id DESC').get().note || ''));

  /* running it twice must not double anyone up */
  await post('/classes/Grade%209/curriculum/apply', { curriculum_id: open.id, course_ids: [FOUND, PY, DISC] });
  check('applying it again enrols nobody twice',
    sql.prepare("SELECT COUNT(*) n FROM enrollments WHERE status='active'").get().n === 9,
    String(sql.prepare("SELECT COUNT(*) n FROM enrollments WHERE status='active'").get().n));

  /* a teacher may not change what the grade is on */
  const nope = await post('/classes/Grade%209/curriculum/suggest', { curriculum_id: owned.id });
  check('a teacher cannot change the grade mapping', nope.status === 302);
  check('the mapping is unchanged', cur.forGrade('darularqam', 'Grade 9', cur.currentYear()).id === open.id);

  /* ---- the school admin may ---- */
  cookie = '';
  r = await post('/login', { email: 'idris@das.edu', password: 'teach12345' });
  check('the school admin signs in', r.status === 302 && !/login/.test(r.loc || ''), `${r.status} → ${r.loc}`);
  page = await get('/classes/Grade%209/curriculum');
  check('a school admin IS offered the grade mapping', /curriculum\/suggest/.test(page.text));
  const setIt = await post('/classes/Grade%209/curriculum/suggest', { curriculum_id: owned.id });
  check('and setting it is accepted', setIt.status === 302);
  check('the grade is now on the other curriculum',
    cur.forGrade('darularqam', 'Grade 9', cur.currentYear()).id === owned.id,
    String(cur.forGrade('darularqam', 'Grade 9', cur.currentYear()).title));
  await post('/classes/Grade%209/curriculum/suggest', { curriculum_id: '' });
  check('and clearing it works too', !cur.forGrade('darularqam', 'Grade 9', cur.currentYear()));

  /* a school admin still cannot reach another school's curriculum */
  const admSneak = await post('/classes/Grade%209/curriculum/suggest', { curriculum_id: foreign.id });
  check('a school admin cannot map a grade to a curriculum the school is not offered',
    admSneak.status === 302 && !cur.forGrade('darularqam', 'Grade 9', cur.currentYear()));

  /* ---- the admin screen: availability ---- */
  cookie = '';
  await post('/login', { email: 'admin@test.local', password: 'admin12345' });
  const save = await post(`/admin/curricula/${open.id}/schools`, { schools: ['darularqam'] });
  check('the admin can limit a curriculum to schools', save.status === 302);
  check('which the model agrees with',
    cur.schoolsFor(open.id).join() === 'darularqam' && !cur.openTo(open.id, 'otherschool'));
  await post(`/admin/curricula/${open.id}/schools`, { everyone: 'on', schools: ['darularqam'] });
  check('"every school" clears the list', cur.schoolsFor(open.id).length === 0);
  const junk = await post(`/admin/curricula/${open.id}/schools`, { schools: ['no-such-school'] });
  check('an unknown school is ignored rather than stored',
    junk.status === 302 && cur.schoolsFor(open.id).length === 0, cur.schoolsFor(open.id).join());

  /* the teacher at the other school sees the right thing: nothing of ours */
  cookie = '';
  await post('/login', { email: 'rao@other.edu', password: 'teach12345' });
  page = await get('/classes/Grade%209/curriculum');
  check('the other school\'s teacher sees her own list only',
    page.status === 200 && !page.text.includes('Darul Arqam only'), String(page.status));

  srv.kill();
  console.log('\nPASS'); ok.forEach(t => console.log('  ✓ ' + t));
  if (bad.length) { console.log('\nFAIL'); bad.forEach(t => console.log('  ✗ ' + t)); }
  console.log(`\n${ok.length} passed, ${bad.length} failed`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
