# AI Ninjas LMS — SCORM 1.2 learning platform for AINinjas.com

A self-contained LMS that lets you upload SCORM 1.2 packages, gate access behind an approval workflow, and track every learner's progress. One Node.js process, one SQLite file, no external services required.

## What it does

**For learners**
- Request access (name, email, password, school) → account sits in *pending* until an admin approves it
- Or sign in with Google (optional; Workspace domains can be auto-approved)
- Dashboard with enrolled courses, progress bars, average scores
- SCORM 1.2 player: full `window.API` runtime, resume where you left off, autosave every 30 s and on tab close
- Leaderboard with Ninja points and belts (display handles only — never real names)

**For admins**
- Upload a `.zip` SCORM 1.2 package → manifest parsed, every SCO registered, files served only to enrolled users
- Approve / reject / disable accounts; toggle auto-approve
- Enroll learners manually, approve course requests, or mark a course "open enrollment"
- Per-course report: lesson heat-map (hardest lessons first), per-learner progress, time spent, scores
- CSV export, progress reset, activity feed

**For developers**
- Plugin system: drop a folder in `/plugins`, subscribe to events (`sco:complete`, `course:complete`, …), add routes, nav items and dashboard widgets. The leaderboard is itself a plugin — copy it to build certificates, badges, streaks, Slack/Discord notifications, or a Google Classroom grade sync.

## Quick start

```bash
git clone <this repo> && cd aininjas-lms
npm install
cp .env.example .env         # edit ADMIN_EMAIL / ADMIN_PASSWORD / SESSION_SECRET
npm start                    # http://localhost:3000
```

Log in with the admin credentials from `.env`, open **Admin → Courses**, and upload `test/sample-scorm12.zip` (a 3-lesson sample course) to see the whole flow.

Run the end-to-end test (needs Chromium; `npx playwright install chromium` once):

```bash
npm test
```

## Project layout

```
server.js                 app bootstrap, sessions, plugin loading
src/db.js                 SQLite schema + helpers (users, courses, scos, enrollments, sco_progress, events)
src/auth.js               request-access, login, Google OAuth, approval gating
src/scorm.js              zip import + imsmanifest.xml parsing
src/routes/learner.js     dashboard, course page, player, SCORM commit endpoint, protected content
src/routes/admin.js       courses, users, enrollments, reports, CSV
src/plugins.js            plugin loader / event bus / widget slots
public/scorm-api.js       SCORM 1.2 RTE (window.API) running on the player page
plugins/leaderboard/      reference plugin
views/                    EJS templates
test/                     Playwright e2e test + sample SCORM package
sample-course/            source of the sample package
DEPLOYMENT.md             how to put this on learn.aininjas.com
PLUGINS.md                how to write a plugin
```

## How SCORM tracking works

1. Admin uploads a zip. `src/scorm.js` finds `imsmanifest.xml`, walks the default `<organization>`, and stores one `scos` row per item that points at a resource (`launch_href`, `masteryscore`, `datafromlms`).
2. When a learner opens a lesson, `/courses/:id/play/:scoId` renders `views/player.ejs`: the SCORM API (`public/scorm-api.js`) is on the page, and the SCO loads in an iframe from `/content/<slug>/<href>` — which checks enrollment on every request.
3. The course calls `LMSInitialize`, `LMSGetValue`/`LMSSetValue`, `LMSCommit`, `LMSFinish` as usual. Every commit POSTs the CMI snapshot to `/api/runtime/:scoId/commit`, which updates `sco_progress` (status, location, suspend_data, score, total time, interactions/objectives JSON) and emits plugin events.
4. `courseSummary()` rolls SCO rows up to course %: a course is complete when every SCO is `completed` or `passed`. If a SCO has a mastery score and only reports a score, pass/fail is derived on finish, per the SCORM 1.2 spec.

## Configuration

See `.env.example`. The important ones: `BASE_URL` (public URL — drives secure cookies and the Google redirect), `SESSION_SECRET`, `DATA_DIR` (persist this!), `ADMIN_EMAIL`/`ADMIN_PASSWORD`, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `GOOGLE_ALLOWED_DOMAINS`.

## Roadmap ideas

Password reset emails, SCORM 2004 / xAPI support, certificates plugin, Google Classroom grade-sync plugin (see the Foundations Challenge PRD), per-school admin role, Postgres adapter for multi-instance deployments.


## Single sign-on (AI Ninjas Accounts)

Set `ACCOUNTS_URL` and `SSO_SECRET` (the Academy's secret under **Apps** in Accounts). Learners and admins given *Academy* access in Accounts sign in with one button; they're matched to existing users by email so progress is kept. Removing access in Accounts disables the user here (progress is retained). Local email/password and Google sign-in remain available at `/login?local=1`. The brand stylesheet is a pinned copy of `www.aininjas.com/brand-kit` (`public/aininjas-app.css`).


## Courses hold any mix of content

Admin → Courses → **New course** creates a course with just a title (a SCORM zip is optional). On its learning-path page you can upload any number of SCORM 1.2 packages (each becomes a set of Learn steps, stored in its own sub-folder), add Quiz Studio quizzes and Colab notebooks, and reorder everything. Packages can be removed individually.

## Learning paths (Learn → Practice → Check)

Admin → course → **Build learning path**. A path is an ordered list of steps: **Learn** (a SCORM lesson), **Practice** (a Google Colab notebook link with instructions; the student opens it, then marks it done and can paste their notebook's share link), **Check** (a Quiz Studio quiz), or **Read** (a note). Students see one page per course with a single *Continue* button that always goes to the first unfinished step; the dashboard shows path progress. A course with no custom steps uses its lessons as the path, so nothing changes until you add a step.

Quiz steps launch Quiz Studio with a signed token carrying the student's identity (the name gate is skipped, the attempt is tagged to the student) and Quiz Studio posts the score back to `/api/quiz-results`, which marks the step complete and keeps the best score. Requires `QUIZ_STUDIO_URL` and `QUIZ_LAUNCH_SECRET` here and the same `QUIZ_LAUNCH_SECRET` on Quiz Studio. The admin course page shows a class grid: every learner × every step, with quiz scores and notebook links.

## School co-branding and entry links

Schools are managed in Quiz Studio (name, logo, one accent colour from a curated palette, and a *link name* such as `darularqam`). The Academy reads a school's branding from Quiz Studio (`GET /api/brand/<slug>`, cached for 5 minutes) — nothing to configure beyond `QUIZ_STUDIO_URL` and `QUIZ_LAUNCH_SECRET`, which the learning paths already need.

- **Entry link per school:** `academy.aininjas.com/s/<slug>` remembers the school (cookie) and shows its logo, name and accent on the home page, the sign-in page and the header. A student who signs up or signs in through that link is tagged with the school automatically.
- **Signed-in people:** `users.school_slug` decides whose branding they see. It is set from the AI Ninjas Accounts sign-in token (Accounts derives it from any school-scoped access the person has, e.g. a teacher's Quiz Studio access), from the entry link, or by an admin on **Admin → Users** (School dropdown, list comes from Quiz Studio). AI Ninjas administrators always see the plain Academy.
- **Quiz steps:** the launch token now carries `school_slug`, so Quiz Studio picks the right school's link by slug (falls back to the school name).
- AI Ninjas stays visible everywhere ("Powered by" mark, the AI Ninjas wordmark in the header): this is co-branding, not white-labelling.

## Class views for teachers and school admins

The Academy has four roles: **Administrator** (AI Ninjas — everything), **School Admin** (every class and student of one school), **Teacher** (chosen classes of one school) and **Learner**. School Admin and Teacher are granted in AI Ninjas Accounts exactly like their Quiz Studio counterparts — pick the school (and classes for a teacher); the list comes from Quiz Studio via this app's `/api/sso/scopes`.

- **Students get their class from Accounts.** The Academy's Learner role takes a school and a class, so the class comes with the student when they are imported (columns *Academy school* / *Academy classes*) or edited in Accounts → Users, and is updated on their next sign-in. Only a student who arrives with no class (for example self-signup through the school's entry link) is asked "Which class are you in?" once (`/pick-class`). School admins can move students between classes from the Classes page, a class page, or a student page; teachers cannot.
- **Classes** (`/classes`) — one card per class: students, average completion, how many finished everything / not started, active this week, quiz average. Administrators pick the school at the top.
- **A class** (`/classes/<name>`) — per student: progress per course, overall %, quiz average, last active; CSV export.
- **A student** (`/students/<id>`) — every course with each step's status, score, Colab notebook link and date; the same data the admin course grid shows, for one person.
- Scoping is enforced server-side: a teacher gets "Not your class" outside their classes; a school admin never sees another school.

## Locked sequence

On a course's **Build learning path** page, **Lock the sequence** makes students complete each step before the next one opens: later steps show a 🔒 and "Locked — finish "…" first", and opening one directly (even by URL, including a SCORM lesson's player link) sends them back to the course page with the same message. A lesson counts as done when SCORM reports completed/passed; a Colab step when the student marks it done; a quiz when Quiz Studio posts the score. Unlock at any time — nothing is lost. Admins are never locked, so you can review any step.

## Practice steps: hand out the notebook file

When adding a **Practice** step you can now upload the `.ipynb` itself instead of sharing a Colab link. The notebook is stored in the Academy (`data/notebooks/`) and students get **⬇ Download notebook** and **Open Colab** buttons with the three-step hint (download → in Colab, *File → Upload notebook* → run, then mark done). Nothing runs on your Google account, so there is no "authored by …" warning and no session limit tied to you. The Colab-link option still exists for notebooks you'd rather keep in your Drive. Files live on the `/data` volume with everything else.

## Reordering a path

On *Build learning path*, drag any step by its ☰ handle and drop it where it belongs — the order saves immediately ("Order saved"). You can also type a position number in the box next to a step, use ↑/↓, or choose where a new step goes ("At the end", "At the start", "After 2. …") when adding it.


## Live quizzes

Teachers can host a quiz live from Quiz Studio (Live in its menu bar). Students join from the **Join a live quiz** box on their dashboard (`/live?code=…`), which sends them to Quiz Studio with a signed launch token, so their name and class come from Accounts. When the teacher ends the session the result posts back to `/api/quiz-results` without a `step_id`; the Academy credits the quiz step (matching `quiz_id`) of a course the student is enrolled in, or just logs a `quiz_completed` event if there is none.

## One site: /assess and /account (Phase 0)

Quiz Studio and Accounts can be served through the Academy's own domain — `academy.aininjas.com/assess/…` and
`academy.aininjas.com/account/…` — with the Academy's menu on every page, so teachers and students see one site.
Set `QUIZ_STUDIO_INTERNAL_URL` / `ACCOUNTS_INTERNAL_URL` to turn it on; **ONE-SITE.md** has the Railway steps.
Code: `src/onesite.js` (addresses), `src/proxy.js` (streaming reverse proxy), `src/shell.js` (the shared menu).

## Enrolment by class and by date (Phase A)

* **Bulk enrolment** — Admin → Users → “Enrol a whole class” (`/admin/enroll`), or a class page → “Enrol this class in a
  course” (`/classes/:name/enroll`, school admins and teachers, limited to their own classes). Pick classes and courses,
  preview who gets enrolled (untick anyone to leave them out), confirm. Students already on a course are skipped.
* **Scheduled enrolment** — the same form with a start date and/or an end date. A scheduler (`src/enrol.js`, on boot and
  every 5 minutes) enrols on the start day and ends access the day after the end date. While a dated enrolment runs,
  students who join the class later are enrolled automatically. Dates are calendar days in `SCHOOL_TZ`
  (default `America/New_York`).
* **Ending keeps everything** — an ended enrolment leaves the student's dashboard (they see it under “Ended courses”)
  but progress, quiz scores and reports stay. `/classes/enrolments` lists every batch in the caller's scope with
  Extend (new end date, or bring an ended one back), End now, Change dates (before it starts) and Cancel.
* **Course availability** — Admin → Courses → course → “Available to”: every school, or a chosen list
  (`course_schools`). Only those schools' staff and students see the course; anyone already enrolled keeps access.
* **Search** — Admin → Users has name/email/class search plus school, class and role filters; the Classes page and each
  class page have a search box, scoped to what that person may see.

## “View as” (AI Ninjas administrator only)

Admin → Users → 👁 View as (or Accounts → Users → person → “View Academy as …”) opens the Academy as that person in a
new tab, with a banner. Nothing is saved while viewing: SCORM commits, “Done” buttons, quiz attempts and every other
write are acknowledged but ignored (`readOnlyWhileViewing` in `src/auth.js`), quizzes open in preview mode, and live
quizzes can't be joined. “Stop viewing” returns you to the person's record in Accounts; because the Academy keeps one
session per browser, your own Academy tabs show that person too until you stop. Every start is audited in Accounts
(`impersonate.start`) and logged in the Academy's events (`viewed_as`).

## Progress by content type and school overview (Phase B)

* Class pages and each student's page split progress into **Lessons** (SCORM lessons completed), **Code** (Colab
  notebooks marked done) and **Quiz average** (best score on quizzes launched from the Academy), next to the overall
  percentage. Ended enrolments stay in the reports.
* **School overview** (`/classes/school`, school admins and AI Ninjas admins): one row per class with the same measures,
  finished-all / not-started / active-this-week counts and a total line. Averages count students who have a course.
* **Quizzes taken outside the Academy** (plain Quiz Studio share links) are pulled from Quiz Studio (`src/quizpull.js`,
  `GET /api/sso/attempts?school=` with the launch secret, cached a minute), matched by the student's Academy id or by
  name + class, shown as "+n outside" on the class page and as a table on the student page, and listed in the CSV.
  They are **not** counted in the quiz average unless `QUIZ_OUTSIDE_COUNTS=1`.

## Assignments and the gradebook (Phase C)

Teachers (and school admins / AI Ninjas admins) set work for a class from **Classes → a class → Assignments**. An assignment is a
list of items, each worth points:

- a **lesson, quiz or notebook step** of any course the class is enrolled on (with an optional part note such as
  "sections 2–4" — SCORM cannot enforce a part, so the student marks it done and the teacher confirms when grading);
- a **standalone Quiz Studio quiz**, optionally limited to some of its modules — the player then shows only those and the
  score is out of those items only;
- a **standalone Colab link**; or
- **anything else** the student marks done with a note.

Kinds: *homework*, *classwork* (a quick gradebook column, added straight from the gradebook) and *unit test* (one quiz —
sit it normally or through a Quiz Studio **Live** session; live results fill the test automatically). Save as draft or
publish with a due date; publishing gives every student in the class a submission row (late joiners get theirs on first
view). Students see **Assignments** in their menu and a "to do" box on the dashboard; each item opens through the normal
launch routes. Quiz items launch with `assignment_item_id` (and the module list) in the signed token and Quiz Studio echoes
it in the postback, so the score lands on the submission, scaled to the item's points. Everything else is graded by hand.

Grading happens on the assignment page (per student, per item, with a comment) or in the **Gradebook** (students × every
published item, inline entry, CSV export). Auto quiz marks show in italics and can be overridden; both values are kept.
Students see marks and comments only once the teacher **releases** them (spec default). Tables: `assignments`,
`assignment_items`, `assignment_submissions`, `grades`.

**Uploading a package.** Course and package uploads show real progress — `Uploading The Disciple.zip — 34 MB of 92 MB (37%) · about 40 s left`, then `Unpacking…` while the server reads the manifest. Before writing anything the importer checks that the volume can hold the unpacked course and refuses with the actual numbers if it cannot; a failed import cleans up after itself rather than leaving a half-written course on the disk. The Admin dashboard's **Storage** card shows what is on the volume and clears abandoned upload temp files.

**Leaderboard scope.** The board ranks a learner against their **own class** — not every school on the platform. A learner with no class yet sees their school; a learner with no school is ranked against other individual learners; teachers and school admins see their school; only the AI Ninjas admin sees everyone, with the school filter. The JSON endpoint `/plugins/leaderboard/api` requires a signed-in user and answers in that same scope (it used to be open to anyone with the URL). Handles only — never names or emails — and anyone can hide themselves from their profile.

**Closing a course, and updating one.** The Published toggle on **Admin → Courses** now reads **open to new learners / closed to new enrolment**, because that is what it does: closing a course removes it from the catalogue, from bulk and scheduled enrolment and from the home page, while **every learner already enrolled keeps full access and their progress**. The row shows how many that is.

To change a course people are already working through, press **+ New version** (optionally saying what changed). That copies the course, its learning path, its lessons and its files as v2: v1 closes to new enrolment and its learners carry on untouched, v2 is published and is what new learners enrol in. Learners on v1 see an offer on their dashboard — what changed, how far through they are, and that switching restarts them at 0% with their old progress kept — plus a **Stay on this one** button that stops the offer coming back. The catalogue never shows a learner a second version of a course they are already in. Each version keeps its own copy of the package files, so check **Storage** on the admin dashboard before versioning a large course; if the volume cannot hold the copy, the attempt is refused with the numbers and nothing is changed.
