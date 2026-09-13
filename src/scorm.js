// SCORM 1.2 package handling: unzip, parse imsmanifest.xml, register SCOs.
const AdmZip = require('adm-zip');
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
function parsePackage(zipPath, { title, description } = {}) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const manifestEntry = entries.find(e => /(^|\/)imsmanifest\.xml$/i.test(e.entryName));
  if (!manifestEntry) throw new Error('Not a SCORM package: imsmanifest.xml not found in the zip.');
  // Packages sometimes have a single top-level folder; strip that prefix.
  const prefix = manifestEntry.entryName.replace(/imsmanifest\.xml$/i, '');

  const xml = parser.parse(manifestEntry.getData().toString('utf8'));
  const manifest = xml.manifest;
  if (!manifest) throw new Error('imsmanifest.xml has no <manifest> root.');
  const schemaversion = manifest.metadata?.schemaversion || manifest.metadata?.schema || '1.2';
  if (String(schemaversion).includes('2004') || String(schemaversion).includes('CAM')) {
    throw new Error(`This looks like a SCORM 2004 package (schemaversion "${schemaversion}"). This LMS supports SCORM 1.2 — re-export the course as SCORM 1.2.`);
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
  if (!org) throw new Error('imsmanifest.xml has no <organization>.');
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
  if (!scos.length) throw new Error('No launchable SCOs (items with identifierref + resource href) found in manifest.');
  return { entries, prefix, manifest, tree, scos, title: courseTitle, description: description || textOf(manifest.metadata?.description) || null, schemaversion: String(schemaversion) };
}
function writeFiles(entries, prefix, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of entries) {
    if (e.isDirectory || !e.entryName.startsWith(prefix)) continue;
    const rel = e.entryName.slice(prefix.length);
    const out = path.join(dest, rel);
    if (!out.startsWith(dest)) continue;               // zip-slip guard
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, e.getData());
  }
}
const insertSco = db.prepare(`INSERT INTO scos (course_id, identifier, title, launch_href, sort_order, mastery_score, max_time_allowed, data_from_lms, package, package_title)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

/** Import a zip as a NEW course (the original behaviour). Returns the course row. */
function importPackage(zipPath, { title, description, openEnrollment } = {}) {
  const pk = parsePackage(zipPath, { title, description });
  let slug = slugify(pk.title), n = 1;
  while (q.courseBySlug.get(slug)) slug = `${slugify(pk.title)}-${++n}`;
  writeFiles(pk.entries, pk.prefix, path.join(DATA_DIR, 'courses', slug));
  const courseId = db.transaction(() => {
    const info = db.prepare(`INSERT INTO courses (slug, title, description, version, manifest_json, open_enrollment) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(slug, pk.title, pk.description, pk.schemaversion, JSON.stringify(pk.tree), openEnrollment ? 1 : 0);
    pk.scos.forEach((s, i) => insertSco.run(info.lastInsertRowid, s.identifier, s.title, s.launch, i, s.mastery, s.maxTime, s.dataFromLms, '', pk.title));
    return info.lastInsertRowid;
  })();
  return q.courseById.get(courseId);
}

/** Add a zip's lessons to an EXISTING course (any number of packages per course). Returns the new SCO rows. */
function addPackageToCourse(courseId, zipPath, { title } = {}) {
  const course = q.courseById.get(courseId);
  if (!course) throw new Error('Course not found');
  const pk = parsePackage(zipPath, { title });
  const folder = 'pkg-' + Date.now().toString(36);
  writeFiles(pk.entries, pk.prefix, path.join(DATA_DIR, 'courses', course.slug, folder));
  const start = db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM scos WHERE course_id=?').get(course.id).m + 1;
  const ids = db.transaction(() => pk.scos.map((s, i) => {
    const ident = `${folder}:${s.identifier}`;   // identifiers are only unique within a package
    return insertSco.run(course.id, ident, s.title, folder + '/' + s.launch, start + i, s.mastery, s.maxTime, s.dataFromLms, folder, pk.title).lastInsertRowid;
  }))();
  if (!course.version) db.prepare('UPDATE courses SET version=? WHERE id=?').run(pk.schemaversion, course.id);
  return ids.map(id => q.scoById.get(id));
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
