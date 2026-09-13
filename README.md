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


## Learning paths (Learn → Practice → Check)

Admin → course → **Build learning path**. A path is an ordered list of steps: **Learn** (a SCORM lesson), **Practice** (a Google Colab notebook link with instructions; the student opens it, then marks it done and can paste their notebook's share link), **Check** (a Quiz Studio quiz), or **Read** (a note). Students see one page per course with a single *Continue* button that always goes to the first unfinished step; the dashboard shows path progress. A course with no custom steps uses its lessons as the path, so nothing changes until you add a step.

Quiz steps launch Quiz Studio with a signed token carrying the student's identity (the name gate is skipped, the attempt is tagged to the student) and Quiz Studio posts the score back to `/api/quiz-results`, which marks the step complete and keeps the best score. Requires `QUIZ_STUDIO_URL` and `QUIZ_LAUNCH_SECRET` here and the same `QUIZ_LAUNCH_SECRET` on Quiz Studio. The admin course page shows a class grid: every learner × every step, with quiz scores and notebook links.
