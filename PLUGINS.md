# Writing a plugin

A plugin is a folder in `/plugins/<name>/` with an `index.js` that exports an object. Everything is optional except `name`.

```js
module.exports = {
  name: 'certificates',
  description: 'Issue a PDF certificate when a course is completed',
  nav: [{ label: 'My certificates', href: '/plugins/certificates' }],          // admin: true → admins only

  init(app, ctx) {
    // ctx = { db, q, DATA_DIR, express, requireLogin, requireAdmin, router }
    ctx.db.exec(`CREATE TABLE IF NOT EXISTS certificates (...)`);
    const r = ctx.router('certificates');         // express.Router mounted at /plugins/certificates
    r.get('/', ctx.requireLogin, (req, res) => res.render('plugin', { title: 'Certificates', html: '<div class="card">…</div>' }));
  },

  hooks: {
    'course:complete': e => { /* e = { userId, courseId, avgScore } */ },
    'sco:complete':    e => { /* e = { userId, courseId, scoId, status, score, finishing } */ },
  },

  widgets: {
    learnerDashboard(user)    { return '<div class="card">…</div>'; },
    adminDashboard()          { return '…'; },
    results(user, course)     { return '…'; },   // shown on the course page
    profile(user)             { return '<label class="check"><input type="checkbox" name="x"> …</label>'; }, // extra profile fields
  },
};
```

## Events

| Event | Payload | When |
|---|---|---|
| `user:requested` | `{ userId }` | someone submits the access form / first Google sign-in |
| `user:approved` | `{ userId }` | admin approves |
| `user:profile` | `{ userId, body }` | learner saves profile (read your own form fields from `body`) |
| `enrollment:created` | `{ userId, courseId, status }` | enrollment becomes active |
| `sco:launch` | `{ userId, courseId, scoId }` | lesson opened |
| `sco:commit` | `{ userId, courseId, scoId, status, score, finishing }` | every LMSCommit / LMSFinish |
| `sco:complete` | same | first time a SCO becomes completed/passed |
| `sco:pass` / `sco:fail` | same | status transitions |
| `course:complete` | `{ userId, courseId, avgScore }` | every SCO in the course is done |

Enable/disable plugins with `PLUGINS=*` or `PLUGINS=leaderboard,certificates` in `.env`.

## Ideas that map to the Foundations Challenge PRD

- **google-classroom** — on `course:complete`, PATCH the learner's `studentSubmission` in Classroom (the LMS must have created the CourseWork; store `courseWorkId` per course).
- **live-class** — a projector view that polls `/plugins/leaderboard/api?course=…` every 15 s during a session.
- **streaks / badges** — count consecutive `sco:pass` events per user.
- **belt-card** — render a shareable PNG with belt + score on `course:complete`.
- **notifications** — POST to Slack/Discord/email on `user:requested` so admins approve faster.
