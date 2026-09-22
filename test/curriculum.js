/* Curricula: inheritance, shared courses, loops, and the sequence gate.
 * Run:  node test/curriculum.js      (own temp data dir, no server, no browser) */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'curriculum-'));

const { db, q } = require('../src/db');
const cur = require('../src/curriculum');

const ok = [], bad = [];
const check = (n, c, d) => (c ? ok : bad).push(n + (d ? ` — ${d}` : ''));
const titles = list => list.map(i => i.course.title);

// --- fixtures: the real course names, so a failure reads like the product ---
const course = title => {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  db.prepare('INSERT INTO courses (slug, title, manifest_json, is_published) VALUES (?, ?, ?, 1)').run(slug, title, '{}');
  return db.prepare('SELECT * FROM courses WHERE slug=?').get(slug).id;
};
const FOUND = course('Foundations Challenge');
const PYTHON = course('Python for AI');
const DISCIPLE = course('The Disciple');
const PREDICTOR = course('The Predictor');
const PATTERN = course('The Pattern Apprentice');
const CONTROLLER = course('The Controller');

const student = (name, cls) => {
  db.prepare(`INSERT INTO users (name, email, role, status, school_slug, class_name)
              VALUES (?, ?, 'learner', 'approved', 'darularqam', ?)`).run(name, `${name.toLowerCase()}@x.edu`, cls);
  return db.prepare('SELECT * FROM users WHERE email=?').get(`${name.toLowerCase()}@x.edu`).id;
};

// --- Level 1, as Grade 8 gets it ---
const g8 = cur.create({ title: 'Level 1 — Grade 8', schoolSlug: 'darularqam' });
[FOUND, PYTHON, DISCIPLE, PREDICTOR].forEach(c => cur.addCourse(g8.id, c));
check('a curriculum keeps the order courses were added in',
  JSON.stringify(titles(cur.resolve(g8.id))) === JSON.stringify(['Foundations Challenge', 'Python for AI', 'The Disciple', 'The Predictor']),
  titles(cur.resolve(g8.id)).join(' · '));

// --- Grade 9, first year: everything Grade 8 gets, plus one ---
const g9y1 = cur.create({ title: 'Grade 9 — 2026 intake', extendsId: g8.id, schoolSlug: 'darularqam' });
cur.addCourse(g9y1.id, PATTERN);
const r9 = cur.resolve(g9y1.id);
check('an extending curriculum inherits the whole list, in order, then adds its own',
  JSON.stringify(titles(r9)) === JSON.stringify(['Foundations Challenge', 'Python for AI', 'The Disciple', 'The Predictor', 'The Pattern Apprentice']),
  titles(r9).join(' · '));
check('inherited courses are marked as inherited', r9.slice(0, 4).every(i => i.inherited) && !r9[4].inherited);
check('each inherited course says where it came from', r9[0].from.title === 'Level 1 — Grade 8', r9[0].from.title);

// --- editing the parent flows through ---
cur.addCourse(g8.id, CONTROLLER);
check('adding to the parent shows up in the child', titles(cur.resolve(g9y1.id)).includes('The Controller'));
check('and lands before the child\'s own additions',
  titles(cur.resolve(g9y1.id)).indexOf('The Controller') < titles(cur.resolve(g9y1.id)).indexOf('The Pattern Apprentice'));
cur.removeCourse(g8.id, CONTROLLER);

// --- a course in two curricula, and reached by two routes ---
const g9y2 = cur.create({ title: 'Grade 9 — 2027 onwards', schoolSlug: 'darularqam' });
[PATTERN, CONTROLLER].forEach(c => cur.addCourse(g9y2.id, c));
check('a course can belong to several curricula',
  titles(cur.resolve(g9y2.id)).includes('The Pattern Apprentice') && titles(cur.resolve(g9y1.id)).includes('The Pattern Apprentice'));

const dup = cur.create({ title: 'Duplicate route', extendsId: g8.id, schoolSlug: 'darularqam' });
cur.addCourse(dup.id, PYTHON);                       // already inherited from Grade 8
const rd = titles(cur.resolve(dup.id));
check('a course reached twice appears once', rd.filter(t => t === 'Python for AI').length === 1, rd.join(' · '));
check('and keeps its earlier, inherited position', rd.indexOf('Python for AI') === 1, rd.join(' · '));

// --- required vs enrichment ---
const enrich = cur.create({ title: 'With enrichment', schoolSlug: 'darularqam' });
cur.addCourse(enrich.id, FOUND);
cur.addCourse(enrich.id, PATTERN, { required: 0 });
cur.addCourse(enrich.id, PYTHON);
check('an enrichment course is recorded as not required',
  cur.resolve(enrich.id).find(i => i.courseId === PATTERN).required === 0);

const promote = cur.create({ title: 'Promotes it', extendsId: enrich.id, schoolSlug: 'darularqam' });
cur.addCourse(promote.id, PATTERN, { required: 1 });
check('a derived curriculum can promote an inherited enrichment course to required',
  cur.resolve(promote.id).find(i => i.courseId === PATTERN).required === 1);

// --- loops ---
let looped = false;
try { cur.update(g8.id, { extendsId: g9y1.id }); } catch (e) { looped = /loop/i.test(e.message); }
check('a loop is refused with an explanation', looped);
let self = false;
try { cur.update(g8.id, { extendsId: g8.id }); } catch (e) { self = /itself/i.test(e.message); }
check('a curriculum cannot extend itself', self);
check('the refused change was not saved', cur.byId(g8.id).extends_id === null, String(cur.byId(g8.id).extends_id));

// a loop forced straight into the database must not hang or crash resolve()
db.prepare('UPDATE curricula SET extends_id=? WHERE id=?').run(g9y1.id, g8.id);
let survived = true;
try { cur.resolve(g9y1.id); } catch { survived = false; }
check('a loop already in the database is survived, not fatal', survived);
db.prepare('UPDATE curricula SET extends_id=NULL WHERE id=?').run(g8.id);

// --- deleting a parent that others build on ---
let refused = false;
try { cur.remove(g8.id); } catch (e) { refused = /build/i.test(e.message); }
check('a curriculum other curricula build on cannot just be deleted', refused);

// --- ancestry / descendants ---
check('ancestry names what it builds on', cur.ancestry(g9y1.id).map(a => a.title).join() === 'Level 1 — Grade 8', JSON.stringify(cur.ancestry(g9y1.id)));
check('descendants finds everything built on it', cur.descendants(g8.id).some(d => d.id === g9y1.id));

// --- a deleted course drops out quietly ---
const temp = course('Temporary');
cur.addCourse(g9y2.id, temp);
db.prepare('DELETE FROM courses WHERE id=?').run(temp);
check('a deleted course disappears from the list instead of breaking it',
  !titles(cur.resolve(g9y2.id)).includes('Temporary'), titles(cur.resolve(g9y2.id)).join(' · '));

// --- per grade, per intake year ---
cur.setForGrade('darularqam', 'Grade 8', g8.id);
cur.setForGrade('darularqam', 'Grade 9', g9y2.id);                 // the standing default
cur.setForGrade('darularqam', 'Grade 9', g9y1.id, '2026-27');      // the catch-up year
check('a grade has a standing curriculum', cur.forGrade('darularqam', 'Grade 9').id === g9y2.id);
check('a named year overrides it', cur.forGrade('darularqam', 'Grade 9', '2026-27').id === g9y1.id);
check('a year with no entry of its own falls back', cur.forGrade('darularqam', 'Grade 9', '2028-29').id === g9y2.id);
check('a grade with nothing set returns nothing', cur.forGrade('darularqam', 'Grade 12') === null);
check('the grade list shows both entries', cur.gradesFor('darularqam').filter(g => g.grade === 'Grade 9').length === 2);

// --- the sequence gate ---
const kai = student('Kai', 'Grade 9');
const enrol = (uid, cid, done) => db.prepare(
  `INSERT INTO enrollments (user_id, course_id, status, completed_at) VALUES (?, ?, 'active', ?)`)
  .run(uid, cid, done ? '2026-09-01' : null);

let p = cur.progressFor(kai, g9y1.id);
check('with nothing done, only the first course is open',
  !p.items[0].locked && p.items.slice(1).every(i => i.locked), p.items.map(i => i.locked ? 'L' : 'o').join(''));
check('a locked course names what is owed first', p.items[1].blockedBy === 'Foundations Challenge', p.items[1].blockedBy);
check('"next" is the first open course', p.next && p.next.course.title === 'Foundations Challenge', p.next && p.next.course.title);
check('progress starts at zero', p.percent === 0 && p.done === 0);

enrol(kai, FOUND, true);
p = cur.progressFor(kai, g9y1.id);
check('finishing one course opens the next', p.items[0].done && !p.items[1].locked && p.items[2].locked,
  p.items.map(i => (i.done ? 'D' : i.locked ? 'L' : 'o')).join(''));
check('progress counts it', p.done === 1 && p.percent === 20, `${p.done}/${p.total} = ${p.percent}%`);
check('mayOpen allows the open one', cur.mayOpen(kai, PYTHON, g9y1.id).ok);
const denied = cur.mayOpen(kai, PREDICTOR, g9y1.id);
check('mayOpen refuses a locked one, in words', !denied.ok && /finished "Python for AI"/.test(denied.reason), denied.reason);
check('mayOpen ignores a course outside the curriculum', cur.mayOpen(kai, CONTROLLER, g9y1.id).ok);

// enrichment must not block what follows it
const kim = student('Kim', 'Grade 9');
enrol(kim, FOUND, true);
const pe = cur.progressFor(kim, enrich.id);
check('an enrichment course does not hold up the course after it',
  !pe.items[1].locked && !pe.items[2].locked, pe.items.map(i => (i.done ? 'D' : i.locked ? 'L' : 'o')).join(''));

// an unlocked curriculum gates nothing
const open = cur.create({ title: 'Open order', schoolSlug: 'darularqam', sequential: 0 });
[FOUND, PYTHON, DISCIPLE].forEach(c => cur.addCourse(open.id, c));
const zoe = student('Zoe', 'Grade 8');
check('with the sequence unlocked nothing is locked', cur.progressFor(zoe, open.id).items.every(i => !i.locked));

// --- applying to a class ---
const applied = cur.applyPreview({ curriculumId: g9y1.id, schoolSlug: 'darularqam', classes: ['Grade 9'] });
check('the preview resolves the whole inherited list', applied.courseIds.length === 5, String(applied.courseIds.length));
check('the preview reports what a student already has',
  applied.already.some(a => a.user.id === kai && a.courses.includes('Foundations Challenge')), JSON.stringify(applied.already.map(a => a.courses)));
check('the preview covers the students in the class', applied.already.length >= 1);

db.prepare(`INSERT INTO course_schools (course_id, school_slug) VALUES (?, 'someone-else')`).run(PATTERN);
const gated = cur.applyPreview({ curriculumId: g9y1.id, schoolSlug: 'darularqam', classes: ['Grade 9'] });
check('the preview flags a course this school is not offered',
  gated.notOffered.some(n => n.title === 'The Pattern Apprentice'), JSON.stringify(gated.notOffered));

console.log('\nPASS'); ok.forEach(t => console.log('  ✓ ' + t));
if (bad.length) { console.log('\nFAIL'); bad.forEach(t => console.log('  ✗ ' + t)); }
console.log(`\n${ok.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
