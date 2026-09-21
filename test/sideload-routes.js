/* End to end: a real admin session posts a link, polls the job, and a course appears. */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

/* End-to-end for the URL sideload: a real admin session posts a link, polls the job, and the
 * course appears. Run:  node test/sideload-routes.js */
const os = require('os');
const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sideload-e2e-'));

const ZIP = fs.readFileSync(path.join(__dirname, 'sample-scorm12.zip'));

const ok = [], bad = [];
const check = (n, c, d) => (c ? ok : bad).push(n + (d ? ` — ${d}` : ''));

// A host that behaves like Drive: viewer link → interstitial → bytes.
let host, HPORT;
function startHost() {
  host = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/pkg.zip') {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': ZIP.length,
        'content-disposition': 'attachment; filename="Pattern Apprentice.zip"' });
      return res.end(ZIP);
    }
    if (p === '/scan') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<html><body>Google Drive can't scan this file for viruses.
        <form action="http://127.0.0.1:${HPORT}/pkg.zip"><input name="confirm" value="t"></form></body></html>`);
    }
    if (p === '/notazip') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><body>Sign in</body></html>'); }
    res.writeHead(404); res.end();
  });
  return new Promise(r => host.listen(0, '127.0.0.1', () => { HPORT = host.address().port; r(); }));
}

const PORT = 4321;
const base = `http://127.0.0.1:${PORT}`;
let cookie = '';

async function post(url, fields, json) {
  const r = await fetch(base + url, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams(fields).toString(),
  });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return json ? { status: r.status, body: await r.json().catch(() => null) } : { status: r.status, loc: r.headers.get('location') };
}

(async () => {
  await startHost();
  const srv = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), NODE_ENV: 'test', SESSION_SECRET: 'test-secret-e2e',
      ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'admin12345' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', d => { log += d; });
  srv.stderr.on('data', d => { log += d; });

  const up = async () => { for (let i = 0; i < 80; i++) { try { await fetch(base + '/login'); return true; } catch { await new Promise(r => setTimeout(r, 250)); } } return false; };
  if (!await up()) { console.error('server never started:\n' + log); process.exit(2); }

  const login = await post('/login', { email: 'admin@test.local', password: 'admin12345' });
  check('admin can sign in', login.status === 302 && !/login/.test(login.loc || ''), `${login.status} → ${login.loc}`);

  async function runJob(url, fields) {
    const start = await post(url, fields, true);
    if (start.status !== 202 || !start.body || !start.body.jobId) return { failedToStart: start };
    for (let i = 0; i < 240; i++) {
      const r = await fetch(`${base}/admin/jobs/${start.body.jobId}`, { headers: { cookie } });
      const j = await r.json();
      if (j.state !== 'running') return j;
      await new Promise(r2 => setTimeout(r2, 250));
    }
    return { timedOut: true };
  }

  // 1. happy path — plain direct link
  const j1 = await runJob('/admin/courses/import-url', {
    title: 'Sideloaded Course', description: 'from a link', package_url: `http://127.0.0.1:${HPORT}/pkg.zip`,
  });
  check('direct link creates a course', j1.state === 'done', j1.error || j1.step || JSON.stringify(j1));
  check('success message names the lessons', /lesson/.test(j1.message || ''), j1.message);
  check('it redirects to the new course path', /^\/admin\/courses\/\d+\/path$/.test(j1.redirect || ''), j1.redirect);

  // 2. interstitial path
  const j2 = await runJob('/admin/courses/import-url', {
    title: 'Via Interstitial', package_url: `http://127.0.0.1:${HPORT}/scan`,
  });
  check('interstitial link creates a course', j2.state === 'done', j2.error || JSON.stringify(j2));

  // 3. an HTML page is refused, in words
  const j3 = await runJob('/admin/courses/import-url', { title: 'Nope', package_url: `http://127.0.0.1:${HPORT}/notazip` });
  check('a web page is refused', j3.state === 'error' && /web page|not public/.test(j3.error || ''), j3.error);

  // 4. add a package to the course made in step 1
  const courseId = (j1.redirect || '').match(/courses\/(\d+)/);
  if (courseId) {
    const j4 = await runJob(`/admin/courses/${courseId[1]}/packages/import-url`, {
      title: 'Module 2', package_url: `http://127.0.0.1:${HPORT}/pkg.zip`,
    });
    check('a package can be added to an existing course by link', j4.state === 'done', j4.error || JSON.stringify(j4));
  } else check('a package can be added to an existing course by link', false, 'no course id to add to');

  // 5. empty url is rejected before any job starts
  const empty = await post('/admin/courses/import-url', { title: 'x', package_url: '  ' }, true);
  check('an empty link is rejected at once', empty.status === 400 && /link/i.test(empty.body?.error || ''), JSON.stringify(empty));

  // 6. unknown job id
  const gone = await fetch(`${base}/admin/jobs/doesnotexist`, { headers: { cookie } });
  check('an unknown job says so', gone.status === 404, String(gone.status));

  // 7. the courses page really lists them, and no temp files survived
  const pageR = await fetch(base + '/admin/courses', { headers: { cookie } });
  const page = await pageR.text();
  check('both courses appear in the admin list', /Sideloaded Course/.test(page) && /Via Interstitial/.test(page));
  check('the URL form is on the page', /import-url/.test(page) && /data-sideload/.test(page));

  const tmp = fs.existsSync(path.join(DATA, 'uploads')) ? fs.readdirSync(path.join(DATA, 'uploads')) : [];
  check('no temp downloads left behind', tmp.length === 0, tmp.join(', '));

  // 8. a session that is not an admin cannot start one
  const anon = await fetch(base + '/admin/courses/import-url', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'package_url=http://example.com/x.zip',
  });
  check('a signed-out visitor cannot sideload', anon.status === 302 || anon.status === 401 || anon.status === 403, String(anon.status));

  srv.kill(); host.close();
  console.log('\nPASS'); ok.forEach(t => console.log('  ✓ ' + t));
  if (bad.length) { console.log('\nFAIL'); bad.forEach(t => console.log('  ✗ ' + t)); console.log('\n--- server log ---\n' + log.slice(-3000)); }
  console.log(`\n${ok.length} passed, ${bad.length} failed`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
