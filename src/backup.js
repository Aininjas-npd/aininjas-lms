'use strict';
/* Nightly encrypted backup of this service's DATA_DIR to an S3-compatible bucket (Cloudflare R2, Backblaze B2, AWS S3),
   plus restore. No SDK: a small SigV4 signer over fetch. NDPA 5.3 / 4.6: backups are encrypted (AES-256-GCM with a
   key only Railway holds) and expire after BACKUP_KEEP_DAYS, so a deleted student also ages out of the backups on a
   known date.

   Env:  BACKUP_S3_ENDPOINT  https://<account>.r2.cloudflarestorage.com   (R2)  |  https://s3.us-west-004.backblazeb2.com (B2)
         BACKUP_S3_BUCKET    bucket name          BACKUP_S3_REGION  auto (R2) | us-west-004 (B2) | us-east-1 (S3)
         BACKUP_S3_KEY / BACKUP_S3_SECRET          access key pair with read/write/list/delete on the bucket
         BACKUP_ENC_KEY      64 hex chars (32 bytes). Lose it and the backups are unreadable — keep it in the password manager.
         BACKUP_PREFIX       folder in the bucket, e.g. "lms" (default: the service name passed in)
         BACKUP_KEEP_DAYS    default 35          BACKUP_HOUR_UTC   default 7 (03:00 New York in summer, 02:00 in winter)
   Use:  schedule({ db, dataDir, dbFile, service })  from server.js — runs nightly, exposes status() for /healthz
         runBackup(...)  once — `node scripts/backup.js`;   restore  — `node scripts/restore.js latest` (see scripts/) */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const cfg = () => ({
  endpoint: String(process.env.BACKUP_S3_ENDPOINT || '').replace(/\/$/, ''),
  bucket: process.env.BACKUP_S3_BUCKET || '',
  region: process.env.BACKUP_S3_REGION || 'auto',
  key: process.env.BACKUP_S3_KEY || '',
  secret: process.env.BACKUP_S3_SECRET || '',
  encKey: process.env.BACKUP_ENC_KEY || '',
  keepDays: Math.max(1, Number(process.env.BACKUP_KEEP_DAYS) || 35),
  hourUtc: Math.min(23, Math.max(0, Number(process.env.BACKUP_HOUR_UTC) || 7)),
});
function configured() { const c = cfg(); return !!(c.endpoint && c.bucket && c.key && c.secret && /^[0-9a-f]{64}$/i.test(c.encKey)); }

/* ---------- SigV4 (path-style, region from env, service s3) ---------- */
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
async function s3(method, objectKey, { body = null, query = {} } = {}) {
  const c = cfg();
  const url = new URL(c.endpoint);
  const canonicalUri = '/' + enc(c.bucket) + (objectKey ? '/' + objectKey.split('/').map(enc).join('/') : '');
  const qs = Object.keys(query).sort().map(k => enc(k) + '=' + enc(query[k])).join('&');
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256(body || '');
  const headers = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map(k => k + ':' + String(headers[k]).trim() + '\n').join('');
  const canonicalRequest = [method, canonicalUri, qs, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${c.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + c.secret, date), c.region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${c.key}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const { host, ...sendHeaders } = headers;
  const r = await fetch(url.origin + canonicalUri + (qs ? '?' + qs : ''), { method, headers: sendHeaders, body: body || undefined, signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!r.ok) throw new Error(`S3 ${method} ${objectKey || ''}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r;
}
async function list(prefix) {
  const out = [];
  let token = null;
  do {
    const query = { 'list-type': '2', prefix: prefix + '/', ...(token ? { 'continuation-token': token } : {}) };
    const xml = await (await s3('GET', '', { query })).text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = /<Key>(.*?)<\/Key>/.exec(m[1]), mod = /<LastModified>(.*?)<\/LastModified>/.exec(m[1]), size = /<Size>(\d+)<\/Size>/.exec(m[1]);
      if (key) out.push({ key: key[1].replace(/&amp;/g, '&'), modified: mod ? new Date(mod[1]) : null, size: size ? +size[1] : 0 });
    }
    const t = /<NextContinuationToken>(.*?)<\/NextContinuationToken>/.exec(xml);
    token = t ? t[1] : null;
  } while (token);
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/* ---------- encryption: "AINB1" + iv(12) + ciphertext + tag(16) ---------- */
const MAGIC = Buffer.from('AINB1');
function encrypt(plain) {
  const key = Buffer.from(cfg().encKey, 'hex'), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  return Buffer.concat([MAGIC, iv, c.update(plain), c.final(), c.getAuthTag()]);
}
function decrypt(blob) {
  if (!blob.subarray(0, 5).equals(MAGIC)) throw new Error('Not an AI Ninjas backup (bad header)');
  const key = Buffer.from(cfg().encKey, 'hex'), iv = blob.subarray(5, 17), tag = blob.subarray(blob.length - 16), data = blob.subarray(17, blob.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]);
}

/* ---------- backup ---------- */
const status = { configured: false, last_ok: null, last_error: null, last_key: null, last_bytes: null, next_at: null };
async function runBackup({ db, dataDir, dbFile, service, log = console }) {
  status.configured = configured();
  if (!status.configured) { status.last_error = 'not configured (BACKUP_* variables)'; return { skipped: true, reason: status.last_error }; }
  const c = cfg(), prefix = process.env.BACKUP_PREFIX || service;
  const stamp = new Date().toISOString().replace(/[:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ainb-'));
  try {
    // 1. a consistent snapshot of the live database (safe while the app serves requests), written beside it as
    //    <dbFile>.snapshot so one tar of DATA_DIR carries it; restore renames it back to <dbFile>
    const snap = path.join(dataDir, dbFile + '.snapshot');
    await db.backup(snap);
    // 2. everything in DATA_DIR (uploads, courses, notebooks, the snapshot) except the live db files, as one gzip tar
    const tgz = path.join(tmp, 'backup.tgz');
    try {
      execFileSync('tar', ['-czf', tgz, '-C', dataDir, '--exclude=./' + dbFile, '--exclude=./' + dbFile + '-wal', '--exclude=./' + dbFile + '-shm', '--exclude=./' + dbFile + '-journal', '.'], { stdio: 'pipe' });
    } finally { fs.rmSync(snap, { force: true }); }
    // 3. encrypt and upload
    const blob = encrypt(fs.readFileSync(tgz));
    const key = `${prefix}/${stamp}.tgz.enc`;
    await s3('PUT', key, { body: blob });
    // 4. expire old copies
    const cutoff = Date.now() - c.keepDays * 86400000, pruned = [];
    for (const o of await list(prefix)) if (o.modified && o.modified.getTime() < cutoff && o.key !== key) { await s3('DELETE', o.key); pruned.push(o.key); }
    Object.assign(status, { last_ok: new Date().toISOString(), last_error: null, last_key: key, last_bytes: blob.length });
    log.log(`[backup] ${key} (${(blob.length / 1048576).toFixed(1)} MB) uploaded; ${pruned.length} older than ${c.keepDays} days removed`);
    return { key, bytes: blob.length, pruned };
  } catch (e) {
    status.last_error = `${new Date().toISOString()} ${e.message}`;
    log.error('[backup] failed: ' + e.message);
    throw e;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/* ---------- restore (run with the app STOPPED, or accept that it restarts after) ---------- */
async function listBackups(service) { return list(process.env.BACKUP_PREFIX || service); }
async function restore({ dataDir, dbFile, service, key, log = console }) {
  if (!configured()) throw new Error('BACKUP_* variables are not set');
  if (!key || key === 'latest') { const all = await listBackups(service); if (!all.length) throw new Error('no backups found'); key = all[all.length - 1].key; }
  log.log(`[restore] downloading ${key}`);
  const blob = Buffer.from(await (await s3('GET', key)).arrayBuffer());
  const tgz = path.join(os.tmpdir(), 'ainb-restore-' + Date.now() + '.tgz');
  fs.writeFileSync(tgz, decrypt(blob));
  fs.mkdirSync(dataDir, { recursive: true });
  execFileSync('tar', ['-xzf', tgz, '-C', dataDir], { stdio: 'pipe' });
  for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(path.join(dataDir, dbFile + suffix), { force: true });
  fs.renameSync(path.join(dataDir, dbFile + '.snapshot'), path.join(dataDir, dbFile));
  fs.rmSync(tgz, { force: true });
  log.log(`[restore] ${key} extracted into ${dataDir}. Restart the app.`);
  return key;
}

/* ---------- nightly schedule ---------- */
function schedule(opts) {
  status.configured = configured();
  if (!status.configured) { console.log('[backup] off — set BACKUP_S3_* and BACKUP_ENC_KEY to enable nightly backups'); return; }
  const plan = () => {
    const now = new Date(), next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), cfg().hourUtc, 0, 0));
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    status.next_at = next.toISOString();
    setTimeout(() => runBackup(opts).catch(() => {}).finally(plan), next - now).unref();
  };
  plan();
  console.log(`[backup] nightly at ${String(cfg().hourUtc).padStart(2, '0')}:00 UTC → ${cfg().bucket}/${process.env.BACKUP_PREFIX || opts.service}, kept ${cfg().keepDays} days`);
}

module.exports = { configured, runBackup, restore, listBackups, schedule, status: () => ({ ...status }) };
