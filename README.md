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

