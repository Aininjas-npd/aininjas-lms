'use strict';
/*
 * Sideload: fetch a course package from a URL, server-side.
 *
 * Why this exists. Railway's edge gives a request body five minutes to arrive and then cuts the
 * connection — not configurable, not a plan limit. A 2.5 GB package would need ~66 Mbps sustained
 * for the whole five minutes to make it, so browser uploads of large packages simply do not
 * finish: the log shows "Error: Request aborted" and nothing is saved.
 *
 * An outbound fetch has no such deadline. So the admin puts the zip somewhere with a link — Drive,
 * Dropbox, S3/R2 — where the upload is resumable and unhurried, and pastes the link here. This
 * module streams those bytes to a temp file on the data volume, and from there the ordinary
 * importer takes over unchanged.
 *
 * The fiddly part is that "a link to a file" is rarely a link to a file:
 *
 *   Drive     a share link points at a viewer page, and even the download endpoint answers a
 *             large file with an HTML virus-scan interstitial instead of the bytes
 *   Dropbox   a share link renders a preview page unless you ask for dl=1
 *   OneDrive  the worst of them: no single rewrite covers personal, Business and SharePoint
 *             links, so several shapes are tried in turn (see oneDriveCandidates)
 *   S3/R2     a presigned URL is already the bytes, and must be passed through untouched — its
 *             signature covers the query string, so rewriting it breaks it
 *
 * So: rewrite what we recognise (§ direct), then verify we actually got a zip by looking at the
 * first four bytes rather than trusting Content-Type, and retry once through the interstitial if
 * what arrived was a web page (§ sniff).
 */
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { DATA_DIR } = require('./db');

const TMP_DIR = path.join(DATA_DIR, 'uploads');
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);          // "PK\x03\x04"
const ZIP_EMPTY = Buffer.from([0x50, 0x4b, 0x05, 0x06]);          // an empty archive, still a zip
const CONNECT_TIMEOUT_MS = 60_000;      // time allowed to get headers back, not to transfer
const STALL_TIMEOUT_MS = 120_000;       // no bytes at all for this long → give up
const MAX_HTML_PEEK = 512 * 1024;       // enough of an interstitial to find its form

const human = n => {
  if (!Number.isFinite(n) || n < 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
};

/* ---------------------------------------------------------------- § direct -- */

const driveId = u => {
  let m = u.pathname.match(/\/file\/d\/([-\w]{10,})/);            // /file/d/<id>/view
  if (m) return m[1];
  m = u.pathname.match(/\/d\/([-\w]{10,})/);                      // /d/<id>
  if (m) return m[1];
  return u.searchParams.get('id');                                // /uc?id=, /open?id=
};

/**
 * OneDrive's share links are the least cooperative of the lot, and there is no single rewrite that
 * covers them, so we return an ordered list of things to try:
 *
 *   ?download=1        what SharePoint and OneDrive for Business answer a share link with
 *   u! content         the consumer trick: base64url the whole share link, ask the content
 *                      endpoint for it (see Microsoft's sharing-URL encoding — note the Graph
 *                      version of this needs a signed-in user, so it only helps personal links)
 *
 * download() walks the list until one of them actually yields a zip.
 */
function oneDriveCandidates(u) {
  const out = [];
  const withDownload = new URL(u.toString());
  withDownload.searchParams.set('download', '1');
  out.push(withDownload.toString());

  const share = 'u!' + Buffer.from(u.toString(), 'utf8').toString('base64')
    .replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
  out.push(`https://api.onedrive.com/v1.0/shares/${share}/root/content`);

  if (!/[?&]download=1/.test(u.toString())) out.push(u.toString());   // last resort: as pasted
  return out;
}

/**
 * Turn a share link into a link to the actual bytes. Anything unrecognised is returned untouched,
 * which is the right answer for presigned URLs, plain web servers and the LMS's own links.
 *
 * Returns { url, source, candidates } — `url` is the first thing to try and `candidates` the whole
 * ordered list, which for most hosts is just that one URL.
 */
function directUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new Error('that does not look like a web address — paste the whole link, starting with https://'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`links must be http or https, not ${u.protocol.replace(':', '')}`);

  const host = u.hostname.toLowerCase();

  // Google Drive → the usercontent download host, pre-confirmed past the virus-scan page
  if (host === 'drive.google.com' || host === 'drive.usercontent.google.com' || host === 'docs.google.com') {
    const id = driveId(u);
    if (!id) throw new Error('that Google Drive link has no file id in it — use the link from Share → Copy link on the file itself');
    const d = new URL('https://drive.usercontent.google.com/download');
    d.searchParams.set('id', id);
    d.searchParams.set('export', 'download');
    d.searchParams.set('confirm', 't');
    return { url: d.toString(), candidates: [d.toString()], source: 'Google Drive' };
  }

  // Dropbox → raw bytes rather than the preview page
  if (host.endsWith('dropbox.com')) {
    u.searchParams.delete('dl'); u.searchParams.set('dl', '1');
    u.searchParams.delete('raw');
    return { url: u.toString(), candidates: [u.toString()], source: 'Dropbox' };
  }

  // OneDrive / SharePoint share links — several shapes, tried in turn (see oneDriveCandidates)
  if (host.endsWith('1drv.ms') || host.endsWith('onedrive.live.com')
      || host.endsWith('sharepoint.com') || host.endsWith('api.onedrive.com')) {
    const candidates = oneDriveCandidates(u);
    return { url: candidates[0], candidates, source: host.endsWith('sharepoint.com') ? 'SharePoint' : 'OneDrive' };
  }

  // Everything else — presigned S3/R2/GCS, a plain web server, a CDN — is already the bytes.
  // Do not touch the query string: a presigned signature covers it.
  const source = /\.r2\.cloudflarestorage\.com$/.test(host) ? 'Cloudflare R2'
    : /(^|\.)s3[.-]|amazonaws\.com$/.test(host) ? 'Amazon S3'
      : /storage\.googleapis\.com$/.test(host) ? 'Google Cloud Storage'
        : host;
  return { url: u.toString(), candidates: [u.toString()], source };
}

/* ----------------------------------------------------------------- § sniff -- */

/** Drive's interstitial is a form; submitting it yields the file. Find where it points. */
function interstitialTarget(html, fromUrl) {
  const form = html.match(/<form[^>]+action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i);
  if (!form) return null;
  let action;
  try { action = new URL(form[1].replace(/&amp;/g, '&'), fromUrl); } catch { return null; }
  for (const m of form[2].matchAll(/<input[^>]+name="([^"]+)"[^>]*value="([^"]*)"/gi)) {
    action.searchParams.set(m[1], m[2].replace(/&amp;/g, '&'));
  }
  return action.toString();
}

const looksZip = buf => buf.length >= 4 && (buf.subarray(0, 4).equals(ZIP_MAGIC) || buf.subarray(0, 4).equals(ZIP_EMPTY));

/**
 * Pull the next chunk, turning a mid-transfer disconnection into something an admin can act on.
 * fetch() reports a dropped connection as a bare "fetch failed" wherever it happens — during the
 * first four bytes or nine tenths of the way through two gigabytes — so every read goes through
 * here and reports how far it got.
 */
async function nextChunk(iter, { source, received, total }) {
  try { return await iter.next(); }
  catch (e) {
    throw Object.assign(
      new Error(`the connection to ${source} dropped after ${human(received)}${total ? ` of ${human(total)}` : ''}. `
        + 'Nothing was saved. Try again — or host the file somewhere with a steadier connection.'),
      { cause: e });
  }
}

/** A filename from Content-Disposition, or from the URL's last path segment. */
function nameFrom(res, url) {
  const cd = res.headers.get('content-disposition') || '';
  let m = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (m) { try { return decodeURIComponent(m[1]); } catch { /* fall through */ } }
  m = cd.match(/filename="?([^";]+)"?/i);
  if (m) return m[1];
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
    if (last && /\.zip$/i.test(last)) return last;
  } catch { /* not a usable name */ }
  return 'package.zip';
}

/* ---------------------------------------------------------------- § fetch --- */

async function openStream(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('the server did not answer within a minute')), CONNECT_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        // Some hosts serve an HTML landing page to anything that does not look like a browser.
        'user-agent': 'Mozilla/5.0 (compatible; AI-Ninjas-Academy/1.0; +https://academy.aininjas.com)',
        accept: 'application/zip,application/octet-stream,*/*',
      },
    });
  } catch (e) {
    /* No response at all. fetch() says "fetch failed" for a refused connection, a DNS miss, a TLS
       problem and a server that hangs up mid-headers alike, so unwrap the cause for a hint. */
    const code = (e && (e.cause?.code || e.code)) || '';
    const why = e && e.name === 'AbortError' ? 'it did not answer within a minute'
      : code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'that host name does not resolve — check the link for a typo'
        : code === 'ECONNREFUSED' ? 'the connection was refused'
          : /CERT|SSL|TLS/i.test(code) ? `its security certificate was rejected (${code})`
            : code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' ? 'the connection was closed before it sent anything'
              : 'the connection failed';
    throw Object.assign(new Error(`could not reach that link — ${why}.`), { cause: e });
  } finally { clearTimeout(t); }
  return res;
}

function httpError(res, source) {
  const s = res.status;
  if (s === 401 || s === 403) {
    return new Error(`${source} refused the download (HTTP ${s}). If it is a Drive or Dropbox link, set sharing to "anyone with the link"; `
      + 'if it is a presigned S3 link, it has most likely expired — generate a fresh one.');
  }
  if (s === 404) return new Error(`nothing is at that link any more (HTTP 404). Check it opens in a private browser window.`);
  if (s === 429) return new Error(`${source} is rate-limiting the download (HTTP 429). Wait a few minutes and try again.`);
  return new Error(`${source} answered HTTP ${s} ${res.statusText || ''}`.trim());
}

/**
 * Open one candidate URL and confirm it is really a zip, following a download-button interstitial
 * once if what came back was a web page. Returns the live stream positioned at the start, or
 * throws with a message worth showing.
 */
async function openZipStream(url, source) {
  let res = await openStream(url);
  if (!res.ok) throw httpError(res, source);

  // Did we get a zip, or a web page pretending to be one? Peek before committing to disk.
  // Note the stream is iterated through `iter` throughout: taking an async iterator locks the
  // ReadableStream, so a later `for await (… of res.body)` would throw ERR_INVALID_STATE.
  if (!res.body) throw new Error(`${source} sent an empty response`);
  let iter = res.body[Symbol.asyncIterator]();
  let cancel = () => { try { return iter.return && iter.return(); } catch { /* already done */ } };

  let head = Buffer.alloc(0);
  const chunks = [];
  while (head.length < 4) {
    const { value, done } = await nextChunk(iter, { source, received: head.length, total: 0 });
    if (done) break;
    const b = Buffer.from(value);
    chunks.push(b); head = Buffer.concat([head, b]);
  }
  if (!head.length) throw new Error(`${source} sent an empty file`);

  if (!looksZip(head)) {
    // Collect a little more and see whether it is an interstitial we can get past.
    let html = Buffer.concat(chunks);
    while (html.length < MAX_HTML_PEEK) {
      const { value, done } = await nextChunk(iter, { source, received: html.length, total: 0 });
      if (done) break;
      html = Buffer.concat([html, Buffer.from(value)]);
    }
    await cancel();
    const text = html.toString('utf8', 0, Math.min(html.length, MAX_HTML_PEEK));
    const next = /<html|<!doctype/i.test(text) ? interstitialTarget(text, url) : null;

    if (!next) {
      const hint = /virus scan|too large for Google|can't scan/i.test(text)
        ? ' Google could not scan the file and served its warning page instead — open the link in a private window, click "Download anyway" once, then try again.'
        : /sign in|login|accounts\.google/i.test(text)
          ? ' The link is asking for a sign-in, so it is not public — set sharing to "anyone with the link".'
          : ' Check the link downloads a .zip directly when you open it in a private browser window.';
      throw new Error(`that link returned a web page, not a package.${hint}`);
    }
    res = await openStream(next);
    if (!res.ok) throw httpError(res, source);
    if (!res.body) throw new Error(`${source} sent an empty response`);
    iter = res.body[Symbol.asyncIterator]();
    cancel = () => { try { return iter.return && iter.return(); } catch { /* already done */ } };
    head = Buffer.alloc(0); chunks.length = 0;
    while (head.length < 4) {
      const { value, done } = await nextChunk(iter, { source, received: head.length, total: 0 });
      if (done) break;
      const b = Buffer.from(value);
      chunks.push(b); head = Buffer.concat([head, b]);
    }
    if (!looksZip(head)) {
      await cancel();
      throw new Error('that link returned a web page, not a package, even after following its download button. Download it yourself and put it somewhere that serves the file directly.');
    }
  }

  return { res, iter, chunks, url };
}

/**
 * Download `rawUrl` to a temp file on the data volume.
 *
 * onProgress({ source, received, total, pct, rate, etaSec }) is called every ~500 ms so the admin
 * page can say something truthful while a couple of gigabytes move.
 *
 * `resolve` maps the pasted link to { candidates, source } and defaults to directUrl; it is a seam
 * so the candidate walk can be tested against a local server.
 *
 * Returns { file, name, bytes, source } — `file` being a temp path the caller must delete, exactly
 * as it deletes multer's temp file today.
 */
async function download(rawUrl, { onProgress, maxBytes, freeBytes, resolve = directUrl } = {}) {
  const { candidates, source } = resolve(rawUrl);
  fs.mkdirSync(TMP_DIR, { recursive: true });

  /* Most hosts give one candidate. OneDrive gives several, because no single rewrite covers
     personal, Business and SharePoint links — so try them in turn and report the first host's
     complaint if none of them works, that being the one the admin can act on. */
  let opened = null, firstErr = null;
  for (const candidate of candidates) {
    try { opened = await openZipStream(candidate, source); break; }
    catch (e) { if (!firstErr) firstErr = e; }
  }
  if (!opened) throw firstErr;

  const { res, chunks, url } = opened;
  let iter = opened.iter;

  const total = Number(res.headers.get('content-length')) || 0;
  const name = nameFrom(res, url);

  if (maxBytes && total && total > maxBytes) {
    throw new Error(`that package is ${human(total)}, over the ${human(maxBytes)} limit. Split it, host the video outside the package, or raise MAX_PACKAGE_MB.`);
  }
  if (freeBytes && total && total + 50 * 1024 * 1024 > freeBytes) {
    throw new Error(`that package is ${human(total)} and only ${human(freeBytes)} is free on the data volume — and the unpacked copy needs about as much again. Clear space (Admin → Storage) or grow the volume first.`);
  }

  const file = path.join(TMP_DIR, `url-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  const out = fs.createWriteStream(file);
  const started = Date.now();
  let received = 0, lastTick = 0, lastBytesAt = Date.now();

  const tick = force => {
    const now = Date.now();
    if (!force && now - lastTick < 500) return;
    lastTick = now;
    if (!onProgress) return;
    const secs = Math.max(0.25, (now - started) / 1000);
    const rate = received / secs;
    onProgress({
      source, received, total,
      pct: total ? Math.min(100, Math.round(100 * received / total)) : null,
      rate, humanReceived: human(received), humanTotal: total ? human(total) : null,
      humanRate: `${human(rate)}/s`,
      etaSec: total && rate > 0 ? Math.max(0, (total - received) / rate) : null,
    });
  };

  // A download that dies mid-flight usually just stops producing bytes rather than erroring, so
  // watch for silence ourselves instead of waiting forever.
  const source$ = async function* () {
    for (const b of chunks) { received += b.length; yield b; }
    chunks.length = 0;
    tick(true);
    for (;;) {
      const n = await nextChunk(iter, { source, received, total });
      if (n.done) break;
      const b = Buffer.from(n.value);
      received += b.length; lastBytesAt = Date.now();
      if (maxBytes && received > maxBytes) throw new Error(`the download passed the ${human(maxBytes)} limit — stopped.`);
      tick();
      yield b;
    }
  };
  const stall = setInterval(() => {
    if (Date.now() - lastBytesAt > STALL_TIMEOUT_MS) out.destroy(new Error('the download stalled — no data for two minutes'));
  }, 10_000);

  try {
    await pipeline(Readable.from(source$()), out);
  } catch (e) {
    clearInterval(stall);
    try { fs.rmSync(file, { force: true }); } catch { /* nothing to clean */ }
    if (e && /ENOSPC/.test(e.code || e.message || '')) throw new Error('the data volume filled up during the download. Clear space (Admin → Storage) or grow the volume, then try again.');
    throw e;
  }
  clearInterval(stall);
  tick(true);

  if (total && received < total) {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    throw new Error(`the download ended early — ${human(received)} of ${human(total)} arrived. Try again; if it keeps happening, host the file somewhere else.`);
  }

  return { file, name, bytes: received, source };
}

module.exports = { download, directUrl, human };
