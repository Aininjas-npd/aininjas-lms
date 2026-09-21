// SCORM 1.2 package handling: unzip, parse imsmanifest.xml, register SCOs.
//
// The zip is read STREAMING, straight from the uploaded temp file: yauzl walks the central
// directory (names and sizes only), we read imsmanifest.xml on its own, then each entry is piped
// to disk one at a time. Memory stays flat whatever the package weighs — the old adm-zip path
// held the entire archive, and then every extracted file, in RAM, which is what killed the
// container on large courses.
const yauzl = require('yauzl');
const storage = require('./storage');
const path = require('path');
const fs = require('fs');
const { XMLParser } = require('fast-xml-parser');
const { db, q, DATA_DIR } = require('./db');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,      // adlcp:masteryscore -> masteryscore
  isArray: (name) => ['item', 'resource', 'organization', 'file'].includes(name),
});

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'course';
}

/** Create an empty course (no SCORM needed) — steps are added on the learning-path page. */
function createCourse({ title, description, openEnrollment } = {}) {
  const courseTitle = String(title || '').trim();
  if (!courseTitle) throw new Error('Give the course a title.');
  let slug = slugify(courseTitle), n = 1;
  while (q.courseBySlug.get(slug)) slug = `${slugify(courseTitle)}-${++n}`;
  fs.mkdirSync(path.join(DATA_DIR, 'courses', slug), { recursive: true });
  const info = db.prepare(`INSERT INTO courses (slug, title, description, version, manifest_json, open_enrollment) VALUES (?, ?, ?, '', '[]', ?)`)
    .run(slug, courseTitle, description || null, openEnrollment ? 1 : 0);
  return q.courseById.get(info.lastInsertRowid);
}

/** Parse a SCORM 1.2 zip. Returns { entries, prefix, manifest, tree, scos, title, description, schemaversion }. */
/** Open a zip for streaming reads. */
const openZip = zipPath => new Promise((resolve, reject) =>
  yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (err, zip) => err ? reject(err) : resolve(zip)));

/** Walk the central directory once. Returns [{ name, size, dir }] — no file contents are read. */
function listEntries(zip) {
  return new Promise((resolve, reject) => {
    const out = [];
    zip.on('entry', e => { out.push({ name: e.fileName, size: e.uncompressedSize, dir: /\/$/.test(e.fileName), raw: e }); zip.readEntry(); });
    zip.on('end', () => resolve(out));
    zip.on('error', reject);
    zip.readEntry();
  });
}

/** Read one entry into memory — only ever used for imsmanifest.xml. */
function readEntry(zip, entry, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    if (entry.size > limit) return reject(new Error('imsmanifest.xml is implausibly large — is this really a SCORM package?'));
    zip.openReadStream(entry.raw, (err, rs) => {
      if (err) return reject(err);
      const chunks = [];
      rs.on('data', c => chunks.push(c));
      rs.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      rs.on('error', reject);
    });
  });
}

/** Pipe one entry to a file on disk, never holding it in memory. */
function extractEntry(zip, entry, outPath) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry.raw, (err, rs) => {
      if (err) return reject(err);
      const ws = fs.createWriteStream(outPath);
      rs.on('error', reject);
      ws.on('error', reject);
      ws.on('close', resolve);
      rs.pipe(ws);
    });
  });
}

async function parsePackage(zipPath, { title, description } = {}) {
  let zip;
  try { zip = await openZip(zipPath); }
  catch (e) { throw new Error(`Could not open the package as a zip file (${e.message}).`); }
  const entries = await listEntries(zip);
  const manifestEntry = entries.find(e => /(^|\/)imsmanifest\.xml$/i.test(e.name));
  if (!manifestEntry) { zip.close(); throw new Error('Not a SCORM package: imsmanifest.xml not found in the zip.'); }
  // Packages sometimes have a single top-level folder; strip that prefix.
  const prefix = manifestEntry.name.replace(/imsmanifest\.xml$/i, '');

  const xml = parser.parse(await readEntry(zip, manifestEntry));
  const bad = msg => { try { zip.close(); } catch {} return new Error(msg); };
  const manifest = xml.manifest;
  if (!manifest) throw bad('imsmanifest.xml has no <manifest> root.');
  const schemaversion = manifest.metadata?.schemaversion || manifest.metadata?.schema || '1.2';
  if (String(schemaversion).includes('2004') || String(schemaversion).includes('CAM')) {
    throw bad(`This looks like a SCORM 2004 package (schemaversion "${schemaversion}"). This LMS supports SCORM 1.2 — re-export the course as SCORM 1.2.`);
  }

  // ---- resources: identifier -> { href, base } ----
  const resources = {};
  const resBase = manifest.resources?.['@_base'] || '';
  for (const r of manifest.resources?.resource || []) {
    resources[r['@_identifier']] = { href: r['@_href'], base: r['@_base'] || '', type: r['@_scormtype'] || r['@_scormType'] || 'sco' };
  }

  // ---- organizations: flatten item tree into a list of launchable SCOs ----
  const orgs = manifest.organizations?.organization || [];
  const defaultOrgId = manifest.organizations?.['@_default'];
  const org = orgs.find(o => o['@_identifier'] === defaultOrgId) || orgs[0];
  if (!org) throw bad('imsmanifest.xml has no <organization>.');
  const courseTitle = title?.trim() || textOf(org.title) || textOf(manifest.metadata?.title) || 'Untitled course';

  const scos = [];
  const tree = [];
  (function walk(items, depth, parentList) {
    for (const it of items || []) {
      const node = { identifier: it['@_identifier'], title: textOf(it.title) || it['@_identifier'], depth, children: [] };
      const ref = it['@_identifierref'];
      if (ref && resources[ref] && resources[ref].href) {
        const r = resources[ref];
        const params = it['@_parameters'] || '';
        node.launch = path.posix.join(resBase, r.base, r.href).replace(/^\/+/, '') + params;
        node.mastery = it.masteryscore != null ? Number(it.masteryscore) : null;
        node.maxTime = it.maxtimeallowed || null;
        node.dataFromLms = it.datafromlms || null;
        scos.push(node);
      }
      parentList.push(node);
      walk(it.item, depth + 1, node.children);
    }
  })(org.item, 0, tree);
  if (!scos.length) throw bad('No launchable SCOs (items with identifierref + resource href) found in manifest.');
  return { zip, entries, prefix, manifest, tree, scos, title: courseTitle, description: description || textOf(manifest.metadata?.description) || null, schemaversion: String(schemaversion) };
}
/** Unpacked size of the entries we are about to write (from the central directory — nothing is read). */
function unpackedSize(entries, prefix) {
  let n = 0;
  for (const e of entries) {
    if (e.dir || !e.name.startsWith(prefix)) continue;
    n += e.size || 0;
  }
  return n;
}

/** Refuse before writing anything if the volume cannot hold the unpacked course. */
function checkRoom(entries, prefix) {
  const need = unpackedSize(entries, prefix);
  let free = NaN;
  try { const st = fs.statfsSync(DATA_DIR); free = st.bavail * st.bsize; } catch { return; }
  if (!Number.isFinite(free)) return;
  const margin = 50 * 1024 * 1024;                     // leave room for the database and sessions
  if (need + margin > free) {
    throw new Error(`this package needs ${storage.human(need)} once unpacked and only ${storage.human(free)} is free on the data volume. `
      + 'Clear abandoned uploads on the Admin dashboard, delete a course you no longer need, or grow the volume in Railway, then try again.');
  }
}

/** Write every entry under `prefix` to `dest`, one stream at a time. */
async function writeFiles(zip, entries, prefix, dest) {
  checkRoom(entries, prefix);
  const fresh = !fs.existsSync(dest);
  fs.mkdirSync(dest, { recursive: true });
  try {
    for (const e of entries) {
      if (e.dir || !e.name.startsWith(prefix)) continue;
      const rel = e.name.slice(prefix.length);
      if (!rel) continue;
      const out = path.join(dest, rel);
      if (!out.startsWith(dest + path.sep)) continue;   // zip-slip guard
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await extractEntry(zip, e, out);
    }
  } catch (err) {
    // A half-written course is dead weight on a volume that is already short of room.
    if (fresh) { try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* best effort */ } }
    throw err;
  }
}
const insertSco = db.prepare(`INSERT INTO scos (course_id, identifier, title, launch_href, sort_order, mastery_score, max_time_allowed, data_from_lms, package, package_title)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

/** Import a zip as a NEW course (the original behaviour). Returns the course row. */
async function importPackage(zipPath, { title, description, openEnrollment } = {}) {
  const pk = await parsePackage(zipPath, { title, description });
  try {
  let slug = slugify(pk.title), n = 1;
  while (q.courseBySlug.get(slug)) slug = `${slugify(pk.title)}-${++n}`;
  await writeFiles(pk.zip, pk.entries, pk.prefix, path.join(DATA_DIR, 'courses', slug));
  const courseId = db.transaction(() => {
    const info = db.prepare(`INSERT INTO courses (slug, title, description, version, manifest_json, open_enrollment) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(slug, pk.title, pk.description, pk.schemaversion, JSON.stringify(pk.tree), openEnrollment ? 1 : 0);
    pk.scos.forEach((s, i) => insertSco.run(info.lastInsertRowid, s.identifier, s.title, s.launch, i, s.mastery, s.maxTime, s.dataFromLms, '', pk.title));
    return info.lastInsertRowid;
  })();
  return q.courseById.get(courseId);
  } finally { try { pk.zip.close(); } catch {} }
}

/** Add a zip's lessons to an EXISTING course (any number of packages per course). Returns the new SCO rows. */
async function addPackageToCourse(courseId, zipPath, { title } = {}) {
  const course = q.courseById.get(courseId);
  if (!course) throw new Error('Course not found');
  const pk = await parsePackage(zipPath, { title });
  try {
  const folder = 'pkg-' + Date.now().toString(36);
  await writeFiles(pk.zip, pk.entries, pk.prefix, path.join(DATA_DIR, 'courses', course.slug, folder));
  const start = db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM scos WHERE course_id=?').get(course.id).m + 1;
  const ids = db.transaction(() => pk.scos.map((s, i) => {
    const ident = `${folder}:${s.identifier}`;   // identifiers are only unique within a package
    return insertSco.run(course.id, ident, s.title, folder + '/' + s.launch, start + i, s.mastery, s.maxTime, s.dataFromLms, folder, pk.title).lastInsertRowid;
  }))();
  if (!course.version) db.prepare('UPDATE courses SET version=? WHERE id=?').run(pk.schemaversion, course.id);
  return ids.map(id => q.scoById.get(id));
  } finally { try { pk.zip.close(); } catch {} }
}
/** Remove one package (its files, SCOs and any path steps pointing at them). */
function removePackage(courseId, folder) {
  const course = q.courseById.get(courseId); if (!course) return;
  const scos = db.prepare('SELECT id FROM scos WHERE course_id=? AND package=?').all(courseId, folder);
  db.transaction(() => {
    scos.forEach(s => { db.prepare(`DELETE FROM path_steps WHERE course_id=? AND type='sco' AND json_extract(config, '$.sco_id')=?`).run(courseId, s.id); db.prepare('DELETE FROM scos WHERE id=?').run(s.id); });
  })();
  if (folder) fs.rmSync(path.join(DATA_DIR, 'courses', course.slug, folder), { recursive: true, force: true });
}
/** Packages in a course: [{ folder, title, count }] */
function packagesFor(courseId) {
  return db.prepare(`SELECT COALESCE(package, '') AS folder, COALESCE(package_title, 'Lessons') AS title, COUNT(*) AS count FROM scos WHERE course_id=? GROUP BY package, package_title ORDER BY MIN(sort_order)`).all(courseId);
}

function deleteCourse(courseId) {
  const course = q.courseById.get(courseId);
  if (!course) return;
  db.prepare('DELETE FROM courses WHERE id = ?').run(courseId);
  fs.rmSync(path.join(DATA_DIR, 'courses', course.slug), { recursive: true, force: true });
}

function textOf(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v).trim();
  if (Array.isArray(v)) return textOf(v[0]);
  if (typeof v === 'object') return textOf(v['#text'] ?? v.langstring ?? Object.values(v)[0]);
  return '';
}

module.exports = { importPackage, createCourse, addPackageToCourse, removePackage, packagesFor, deleteCourse };
