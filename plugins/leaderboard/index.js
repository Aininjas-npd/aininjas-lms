// Leaderboard plugin — awards "Ninja points" for learning activity and shows a ranked board.
// Points: SCO completed 100 · SCO passed 150 · score bonus = round(score_raw) (max 100) · course completed 500
// Learners can opt out on their profile page; only display handles are shown, never names/emails.
const POINTS = { complete: 100, pass: 150, course: 500 };

let db, q;

function award(userId, courseId, reason, points) {
  db.prepare('INSERT INTO leaderboard_points (user_id, course_id, reason, points) VALUES (?, ?, ?, ?)').run(userId, courseId, reason, points);
}

function board({ courseId = null, limit = 20, organization = null, schoolSlug = null, className = null, individualsOnly = false } = {}) {
  return db.prepare(`
    SELECT u.id, u.display_handle AS handle, u.organization, SUM(p.points) AS points, COUNT(DISTINCT p.course_id) AS courses,
           MAX(p.created_at) AS last_activity
    FROM leaderboard_points p JOIN users u ON u.id = p.user_id
    WHERE u.status = 'approved' AND COALESCE(u.leaderboard_opt_out, 0) = 0
      AND (? IS NULL OR p.course_id = ?) AND (? IS NULL OR u.organization = ?)
      AND (? IS NULL OR u.school_slug = ?) AND (? IS NULL OR u.class_name = ?)
      AND (? = 0 OR COALESCE(u.school_slug, '') = '')
    GROUP BY u.id ORDER BY points DESC, last_activity ASC LIMIT ?`)
    .all(courseId, courseId, organization, organization, schoolSlug, schoolSlug, className, className, individualsOnly ? 1 : 0, limit);
}

/* Who a viewer is allowed to be ranked against.
   A learner sees their own class only — the board is a classroom thing, not a directory of
   every school on the platform. Staff see their school. AI Ninjas admins see everything. */
function scopeFor(user) {
  if (!user) return { schoolSlug: '__none__', className: '__none__', label: '' };
  if (user.role === 'admin') return { schoolSlug: null, className: null, label: 'Everyone', wide: true };
  if (user.role === 'learner') {
    if (!user.school_slug) return { schoolSlug: null, className: null, label: 'Individual learners', individual: true };
    if (!user.class_name) return { schoolSlug: user.school_slug, className: null, label: 'Your school' };
    return { schoolSlug: user.school_slug, className: user.class_name, label: user.class_name };
  }
  return { schoolSlug: user.school_slug || null, className: null, label: 'Your school' };   // teacher / school admin
}

function belt(points) {
  if (points >= 2000) return { name: 'Black Belt', emoji: '⬛' };
  if (points >= 1000) return { name: 'Blue Belt', emoji: '🟦' };
  if (points >= 400) return { name: 'Green Belt', emoji: '🟩' };
  return { name: 'White Belt', emoji: '⬜' };
}

function renderTable(rows, meId, showOrg = false) {
  if (!rows.length) return '<p class="muted">No points yet — complete a lesson to get on the board.</p>';
  return `<table class="table"><thead><tr><th>#</th><th>Ninja</th><th>Belt</th><th class="num">Points</th></tr></thead><tbody>` +
    rows.map((r, i) => `<tr${r.id === meId ? ' class="me"' : ''}><td>${i + 1}</td><td>${esc(r.handle || 'Anonymous')}${showOrg && r.organization ? ` <span class="muted small">· ${esc(r.organization)}</span>` : ''}</td><td>${belt(r.points).emoji} ${belt(r.points).name}</td><td class="num">${r.points.toLocaleString()}</td></tr>`).join('') +
    `</tbody></table>`;
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

module.exports = {
  name: 'leaderboard',
  description: 'Ninja points, belts and a school/organization leaderboard',
  nav: [{ label: 'Leaderboard', href: '/plugins/leaderboard' }],

  init(app, ctx) {
    db = ctx.db; q = ctx.q;
    db.exec(`CREATE TABLE IF NOT EXISTS leaderboard_points (
               id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, course_id INTEGER, reason TEXT NOT NULL,
               points INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
             CREATE INDEX IF NOT EXISTS idx_lb_user ON leaderboard_points(user_id);`);
    try { db.exec('ALTER TABLE users ADD COLUMN leaderboard_opt_out INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* column exists */ }

    const r = ctx.router('leaderboard');
    r.get('/', ctx.requireLogin, (req, res) => {
      const courseId = req.query.course ? +req.query.course : null;
      const sc = scopeFor(req.user);
      const org = sc.wide ? (req.query.org || null) : null;
      const rows = board({ courseId, organization: org, schoolSlug: sc.schoolSlug, className: sc.className, individualsOnly: !!sc.individual, limit: 50 });
      const mine = db.prepare('SELECT COALESCE(SUM(points),0) p FROM leaderboard_points WHERE user_id=?').get(req.user.id).p;
      const orgs = db.prepare(`SELECT DISTINCT organization FROM users WHERE organization IS NOT NULL AND organization != '' ORDER BY 1`).all().map(x => x.organization);
      res.render('plugin', {
        title: 'Leaderboard',
        html: `
          <div class="card">
            <form class="row gap" method="get">
              <select name="course" onchange="this.form.submit()"><option value="">All courses</option>${q.courses.all().map(c => `<option value="${c.id}"${courseId === c.id ? ' selected' : ''}>${esc(c.title)}</option>`).join('')}</select>
              ${sc.wide ? `<select name="org" onchange="this.form.submit()"><option value="">All schools / orgs</option>${orgs.map(o => `<option${org === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>` : ''}
            </form>
            <p class="muted small" style="margin:0 0 6px">${sc.wide ? 'You are seeing every learner because you are an AI Ninjas admin.' : sc.individual ? 'Ranked against other individual learners.' : `Ranked within <strong>${esc(sc.label)}</strong>.`}</p>
            <p>Your Ninja points: <strong>${mine.toLocaleString()}</strong> · ${belt(mine).emoji} ${belt(mine).name}${req.user.leaderboard_opt_out ? ' · <span class="muted">(you are hidden from the board — change this on your profile)</span>' : ''}</p>
            ${renderTable(rows, req.user.id, !!sc.wide)}
            <p class="muted small">Points: lesson completed +100 · lesson passed +150 · +1 per score point · course completed +500. Only display handles are shown.</p>
          </div>`,
      });
    });
    // JSON endpoint (signed in only — it used to be open, which published every learner's handle,
    // school and points to anyone who knew the URL). It answers with the caller's own scope.
    r.get('/api', ctx.requireLogin, (req, res) => {
      const sc = scopeFor(req.user);
      const rows = board({ courseId: req.query.course ? +req.query.course : null,
        organization: sc.wide ? (req.query.org || null) : null,
        schoolSlug: sc.schoolSlug, className: sc.className, individualsOnly: !!sc.individual, limit: +req.query.limit || 20 });
      res.json(rows.map((x, i) => ({ rank: i + 1, handle: x.handle, organization: sc.wide ? x.organization : undefined, points: x.points, belt: belt(x.points).name })));
    });
  },

  hooks: {
    'sco:complete': e => award(e.userId, e.courseId, e.status === 'passed' ? 'sco_passed' : 'sco_completed', (e.status === 'passed' ? POINTS.pass : POINTS.complete) + Math.min(100, Math.max(0, Math.round(e.score || 0)))),
    'course:complete': e => award(e.userId, e.courseId, 'course_completed', POINTS.course),
    'user:profile': e => db.prepare('UPDATE users SET leaderboard_opt_out=? WHERE id=?').run(e.body.leaderboard_opt_out === 'on' ? 1 : 0, e.userId),
  },

  widgets: {
    learnerDashboard(user) {
      const mine = db.prepare('SELECT COALESCE(SUM(points),0) p FROM leaderboard_points WHERE user_id=?').get(user.id).p;
      const sc = scopeFor(user);
      const rows = board({ schoolSlug: sc.schoolSlug, className: sc.className, individualsOnly: !!sc.individual, limit: 5 });
      const b = belt(mine);
      const where = sc.wide ? '' : sc.individual ? ' <span class="muted small">· individual learners</span>' : ` <span class="muted small">· ${esc(sc.label)}</span>`;
      return `<div class="card"><h3>🏆 Leaderboard${where}</h3><p>You: <strong>${mine.toLocaleString()} pts</strong> · ${b.emoji} ${b.name}</p>${renderTable(rows, user.id, !!sc.wide)}<a class="btn small" href="/plugins/leaderboard">Full leaderboard →</a></div>`;
    },
    adminDashboard() {
      const rows = board({ limit: 10 });
      return `<div class="card"><h3>🏆 Top ninjas</h3>${renderTable(rows, null, true)}<a class="btn small" href="/plugins/leaderboard">Open leaderboard →</a></div>`;
    },
    profile(user) {
      return `<label class="check"><input type="checkbox" name="leaderboard_opt_out" ${user.leaderboard_opt_out ? 'checked' : ''}> Hide me from the leaderboard</label>`;
    },
  },
};
