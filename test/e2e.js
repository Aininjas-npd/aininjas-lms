// End-to-end smoke test: admin uploads the sample package, a learner requests access,
// admin approves, learner plays all SCOs, progress + leaderboard update.
// Run:  npm test   (starts its own server on port 3999 with a temp data dir)
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');

const PORT = 3999, BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-test-'));
const server = spawn('node', ['server.js'], {
  cwd: path.join(__dirname, '..'), stdio: 'inherit',
  env: { ...process.env, PORT, BASE_URL: BASE, DATA_DIR: dataDir, ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'admin12345', GOOGLE_CLIENT_ID: '' },
});
const assert = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); console.log('  ✓', m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await sleep(1500);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const shots = path.join(__dirname, 'screenshots'); fs.mkdirSync(shots, { recursive: true });
  try {
    // ---- Admin: log in, upload course ----
    const admin = await (await browser.newContext()).newPage();
    await admin.goto(`${BASE}/login`);
    await admin.fill('input[name=email]', 'admin@test.local'); await admin.fill('input[name=password]', 'admin12345');
    await admin.click('button.btn');
    assert(admin.url().endsWith('/admin'), 'admin logs in and lands on /admin');
    await admin.goto(`${BASE}/admin/courses`);
    await admin.setInputFiles('input[name=package]', path.join(__dirname, 'sample-scorm12.zip'));
    await admin.click('form[action="/admin/courses/upload"] button');
    const flash = await admin.textContent('.flash');
    assert(/Imported .* \(3 SCO/.test(flash), `SCORM package imported: ${flash.trim()}`);
    await admin.screenshot({ path: path.join(shots, '1-admin-courses.png') });

    // ---- Learner: request access ----
    const learner = await (await browser.newContext()).newPage();
    await learner.goto(`${BASE}/request-access`);
    await learner.fill('input[name=name]', 'Kai Student'); await learner.fill('input[name=email]', 'kai@school.edu');
    await learner.fill('input[name=password]', 'ninja12345'); await learner.fill('input[name=organization]', 'Lincoln High');
    await learner.click('button.btn');
    assert(learner.url().endsWith('/pending'), 'new learner lands on pending page');
    await learner.goto(`${BASE}/dashboard`);
    assert(learner.url().endsWith('/pending'), 'pending learner cannot reach dashboard');

    // ---- Admin approves user + grants course ----
    await admin.goto(`${BASE}/admin/users?status=pending`);
    assert((await admin.textContent('body')).includes('kai@school.edu'), 'request visible in admin');
    await admin.click('form[action$="/approve"] button');
    await admin.goto(`${BASE}/admin/users`);
    await admin.selectOption('form[action="/admin/enrollments"] select', { index: 0 });
    await admin.click('form[action="/admin/enrollments"] button');
    await admin.screenshot({ path: path.join(shots, '2-admin-users.png') });

    // ---- Learner: dashboard shows course, play SCO 1 (resume + complete) ----
    await learner.goto(`${BASE}/dashboard`);
    assert(learner.url().endsWith('/dashboard'), 'approved learner reaches dashboard');
    assert((await learner.textContent('body')).includes('Foundations Sample'), 'enrolled course on dashboard');
    await learner.screenshot({ path: path.join(shots, '3-learner-dashboard.png') });
    await learner.click('a.btn:has-text("Start course")');
    const courseUrl = learner.url();
    await learner.click('a.btn:has-text("Start")');
    let frame = learner.frameLocator('#sco');
    assert((await frame.locator('#hello').textContent()).includes('Kai Student'), 'SCO reads cmi.core.student_name via window.API');
    await frame.locator('#next').click();                        // page 2 -> lesson_location = 2, commit
    await sleep(400);
    await learner.goto(courseUrl);                                  // simulate leaving mid-lesson
    assert((await learner.textContent('body')).includes('Resume'), 'course page offers Resume for incomplete SCO');
    await learner.click('a.btn:has-text("Resume")');
    frame = learner.frameLocator('#sco');
    assert((await frame.locator('#hello').textContent()).includes('entry: resume'), 'entry = resume on relaunch');
    assert((await frame.locator('#page').textContent()) === '2', 'lesson_location restored → page 2');
    await frame.locator('#next').click();                        // finish
    await frame.locator('#done').waitFor();
    await sleep(500);
    assert((await learner.textContent('#status')).includes('completed'), 'player bar shows completed status');
    await learner.screenshot({ path: path.join(shots, '4-player.png') });

    // ---- SCO 2: quiz, pass ----
    await learner.click('a.btn:has-text("Next")');
    frame = learner.frameLocator('#sco');
    await frame.locator('input[name=q1][value=b]').check(); await frame.locator('input[name=q2][value=b]').check();
    await frame.locator('#submit').click(); await sleep(500);
    assert((await learner.textContent('#status')).includes('passed'), 'quiz SCO reports passed');
    // ---- SCO 3 auto-completes ----
    await learner.click('a.btn:has-text("Next")'); await sleep(800);
    await learner.goto(courseUrl);
    const body = await learner.textContent('body');
    assert(body.includes('3/3 lessons complete'), 'course shows 3/3 complete');
    assert(/average score 100/.test(body), 'average score 100 recorded');
    await learner.screenshot({ path: path.join(shots, '5-course-complete.png') });

    // ---- Leaderboard plugin ----
    await learner.goto(`${BASE}/plugins/leaderboard`);
    const lb = await learner.textContent('body');
    assert(/Your Ninja points:\s*950/.test(lb), 'leaderboard awarded 100+150+100+500 = 950 points');   // complete + passed(+100 score) + complete + course
    assert(!(await learner.textContent('table.table')).includes('Kai Student'), 'leaderboard table never shows real names');
    await learner.screenshot({ path: path.join(shots, '6-leaderboard.png') });
    const api = await (await learner.request.get(`${BASE}/plugins/leaderboard/api`)).json();
    assert(api[0].points === 950 && api[0].belt === 'Green Belt', 'leaderboard JSON API works');

    // ---- Admin report + CSV ----
    await admin.goto(`${BASE}/admin/courses`); await admin.click('a:has-text("Report")');
    assert((await admin.textContent('body')).includes('3/3 · 100%'), 'admin course report shows learner at 100%');
    await admin.screenshot({ path: path.join(shots, '7-admin-report.png'), fullPage: true });
    const csv = await (await admin.request.get(admin.url() + '/export.csv')).text();
    assert(csv.includes('kai@school.edu') && csv.includes('passed'), 'CSV export contains learner row');

    // ---- Content is protected ----
    const anon = await (await browser.newContext()).newPage();
    const r = await anon.goto(`${BASE}/content/ai-ninjas-foundations-sample/intro.html`);
    assert(r.url().endsWith('/login'), 'course content requires login');

    console.log('\nALL TESTS PASSED');
  } catch (e) { console.error('\nTEST FAILED:', e.message); process.exitCode = 1; }
  finally { await browser.close(); server.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); }
})();
