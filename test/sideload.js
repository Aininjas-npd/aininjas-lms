/* Exercises fetchurl.download against a local server that imitates each host's bad manners. */
/* Unit tests for the URL sideload: link rewriting, zip sniffing, error wording, streaming.
 * Run:  node test/sideload.js      (no browser, no network beyond a local server) */
const os = require('os');
process.env.DATA_DIR = fsMkTemp();
function fsMkTemp() { const f = require('fs'), p = require('path'); return f.mkdtempSync(p.join(os.tmpdir(), 'sideload-')); }
const fs = require('fs');
const http = require('http');
const path = require('path');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const { download, directUrl, human } = require('../src/fetchurl');

// A real (small) zip, plus a big one built on the fly to watch memory.
const { execSync } = require('child_process');
const TMP = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'sideload-src-'));
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP + '/pkg', { recursive: true });
fs.writeFileSync(TMP + '/pkg/imsmanifest.xml', '<manifest/>');
fs.writeFileSync(TMP + '/pkg/big.bin', Buffer.alloc(8 * 1024 * 1024, 7));
execSync(`cd ${TMP}/pkg && zip -q -0 -r ../small.zip .`);
const SMALL = fs.readFileSync(TMP + '/small.zip');

// A ~600 MB stream of zip: real header, then filler. Enough to prove we never buffer it.
const BIG_BYTES = 600 * 1024 * 1024;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  if (p === '/small.zip') {
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': SMALL.length,
      'content-disposition': 'attachment; filename="Pattern Apprentice.zip"' });
    return res.end(SMALL);
  }

  if (p === '/big.zip') {
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': BIG_BYTES });
    let sent = 0;
    const chunk = Buffer.alloc(1024 * 1024, 3);
    SMALL.copy(chunk, 0, 0, 4);                       // keep the PK magic at the front
    const push = () => {
      while (sent < BIG_BYTES) {
        const n = Math.min(chunk.length, BIG_BYTES - sent);
        sent += n;
        if (!res.write(n === chunk.length ? chunk : chunk.subarray(0, n))) return res.once('drain', push);
      }
      res.end();
    };
    return push();
  }

  // Drive's virus-scan interstitial: HTML with a form that points at the real bytes.
  if (p === '/interstitial') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(`<!DOCTYPE html><html><body>
      <p>Google Drive can't scan this file for viruses.</p>
      <form id="download-form" action="http://127.0.0.1:${PORT}/small.zip" method="get">
        <input type="hidden" name="id" value="abc123">
        <input type="hidden" name="confirm" value="t&amp;x">
      </form></body></html>`);
  }

  // A page with no form — the dead end.
  if (p === '/signin') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<!DOCTYPE html><html><body>Sign in to continue to accounts.google.com</body></html>');
  }

  if (p === '/403') { res.writeHead(403); return res.end('no'); }
  if (p === '/404') { res.writeHead(404); return res.end('no'); }

  // Claims 100 MB, delivers 1 MB then hangs up.
  if (p === '/short') {
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': 100 * 1024 * 1024 });
    res.write(SMALL.subarray(0, 4));
    res.write(Buffer.alloc(1024 * 1024, 1));
    return res.destroy();
  }

  res.writeHead(404); res.end();
});

let PORT;
const ok = [], bad = [];
const check = (name, cond, detail) => (cond ? ok : bad).push(name + (detail ? ` — ${detail}` : ''));

async function expectFail(name, url, re) {
  try {
    const r = await download(url);
    fs.rmSync(r.file, { force: true });
    check(name, false, 'it succeeded, but should not have');
  } catch (e) {
    check(name, re.test(e.message), `got: ${e.message}`);
  }
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;
  const base = `http://127.0.0.1:${PORT}`;

  // --- URL rewriting, no network ---
  const d1 = directUrl('https://drive.google.com/file/d/1AbC_dEfGhIjKlMnOpQ/view?usp=sharing');
  check('Drive share link → usercontent download', /drive\.usercontent\.google\.com\/download/.test(d1.url) && /id=1AbC_dEfGhIjKlMnOpQ/.test(d1.url) && /confirm=t/.test(d1.url), d1.url);
  const d2 = directUrl('https://www.dropbox.com/scl/fi/xyz/pkg.zip?rlkey=abc&dl=0');
  check('Dropbox link → dl=1', /dl=1/.test(d2.url) && !/dl=0/.test(d2.url) && /rlkey=abc/.test(d2.url), d2.url);
  const presigned = 'https://bucket.s3.us-east-1.amazonaws.com/p.zip?X-Amz-Signature=deadbeef&X-Amz-Expires=3600';
  const d3 = directUrl(presigned);
  check('presigned S3 URL passes through byte-for-byte', d3.url === presigned, d3.url);
  try { directUrl('file:///etc/passwd'); check('file:// rejected', false); }
  catch (e) { check('file:// rejected', /http or https/.test(e.message)); }
  try { directUrl('not a url'); check('garbage rejected', false); }
  catch (e) { check('garbage rejected', /web address/.test(e.message)); }
  try { directUrl('https://drive.google.com/drive/my-drive'); check('Drive folder link rejected', false); }
  catch (e) { check('Drive folder link rejected', /no file id/.test(e.message), e.message); }

  // --- happy path ---
  const r1 = await download(`${base}/small.zip`);
  check('downloads a zip', fs.readFileSync(r1.file).equals(SMALL) && r1.bytes === SMALL.length, `${r1.bytes} bytes`);
  check('filename from Content-Disposition', r1.name === 'Pattern Apprentice.zip', r1.name);
  fs.rmSync(r1.file, { force: true });

  // --- interstitial ---
  const r2 = await download(`${base}/interstitial`);
  check('follows the virus-scan interstitial', fs.readFileSync(r2.file).equals(SMALL), `${r2.bytes} bytes`);
  fs.rmSync(r2.file, { force: true });

  // --- errors ---
  await expectFail('sign-in page gives a useful message', `${base}/signin`, /not public|web page/);
  await expectFail('403 explains sharing', `${base}/403`, /refused|anyone with the link/);
  await expectFail('404 is plain', `${base}/404`, /404|any more/);
  await expectFail('truncated download is rejected', `${base}/short`, /ended early|stalled|dropped after|could not reach/);

  // --- limits ---
  try {
    const r = await download(`${base}/big.zip`, { maxBytes: 10 * 1024 * 1024 });
    fs.rmSync(r.file, { force: true });
    check('over-size is refused up front', false, 'it downloaded anyway');
  } catch (e) { check('over-size is refused up front', /over the .* limit/.test(e.message), e.message); }

  try {
    const r = await download(`${base}/big.zip`, { freeBytes: 20 * 1024 * 1024 });
    fs.rmSync(r.file, { force: true });
    check('no-room is refused up front', false, 'it downloaded anyway');
  } catch (e) { check('no-room is refused up front', /free on the data volume/.test(e.message), e.message); }

  // --- memory: 600 MB must not be buffered ---
  const before = process.memoryUsage().rss;
  let peak = before, lastPct = null;
  const watch = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 25);
  const r3 = await download(`${base}/big.zip`, { onProgress: p => { lastPct = p.pct; } });
  clearInterval(watch);
  const growth = peak - before;
  check('600 MB streams to disk without buffering', growth < 150 * 1024 * 1024,
    `RSS grew ${human(growth)} (peak ${human(peak)})`);
  check('the file really is 600 MB on disk', fs.statSync(r3.file).size === BIG_BYTES, human(fs.statSync(r3.file).size));
  check('progress was reported', lastPct === 100, `last pct ${lastPct}`);
  fs.rmSync(r3.file, { force: true });

  // --- cleanup: no temp files left behind by the failures above ---
  const leftovers = fs.readdirSync(path.join(process.env.DATA_DIR, 'uploads')).filter(f => f.startsWith('url-'));
  check('no temp files left behind', leftovers.length === 0, leftovers.join(', '));

  server.close();
  console.log('\nPASS');
  ok.forEach(t => console.log('  ✓ ' + t));
  if (bad.length) { console.log('\nFAIL'); bad.forEach(t => console.log('  ✗ ' + t)); }
  console.log(`\n${ok.length} passed, ${bad.length} failed`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('harness blew up:', e); process.exit(2); });
