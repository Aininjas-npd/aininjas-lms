// Authentication: request-access form, email/password login, Google Sign-In, approval gating.
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { db, q } = require('./db');
const plugins = require('./plugins');

const router = express.Router();

/* ---------- Single sign-on through AI Ninjas Accounts (on when ACCOUNTS_URL + SSO_SECRET are set) ---------- */
const onesite = require('./onesite');
const ACCOUNTS_URL = onesite.accounts.public;   // browser-facing: https://academy.aininjas.com/account in one-site mode
const sso = ACCOUNTS_URL && process.env.SSO_SECRET
  ? require('./aininjas-sso')({ accountsUrl: ACCOUNTS_URL, apiUrl: onesite.accounts.api, appSlug: process.env.SSO_APP_SLUG || 'lms', secret: process.env.SSO_SECRET })
  : null;
const safeReturn = v => (/^\/(?!\/)/.test(String(v || '')) ? String(v) : '');

/* Create/update the local user from Accounts claims. Accounts-granted users are approved by definition. */
const ROLES = ['admin', 'school_admin', 'teacher', 'learner'];
const STAFF = ['admin', 'school_admin', 'teacher'];
function upsertFromSso({ sub, email, name, role, scope }) {
  const em = String(email).toLowerCase();
  const r = ROLES.includes(role) ? role : 'learner';
  const slug = scope && /^[a-z0-9][a-z0-9-]{1,39}$/.test(scope.school_slug || '') ? scope.school_slug : null;   // school co-branding
  const scopeClasses = Array.isArray(scope && scope.classes) ? scope.classes.filter(Boolean) : [];
  const classes = JSON.stringify(r === 'teacher' ? scopeClasses : []);
  const className = r === 'learner' && scopeClasses[0] ? String(scopeClasses[0]) : null;   // a student's class, as set in Accounts (import or user form)
  let u = db.prepare('SELECT * FROM users WHERE sso_sub=? OR email=?').get(String(sub), em);
  if (u) {
    db.prepare(`UPDATE users SET email=?, sso_sub=?, name=?, role=?, classes=?, class_name=COALESCE(?, class_name), status='approved', approved_at=COALESCE(approved_at, datetime('now')), school_slug=COALESCE(?, school_slug), organization=COALESCE(organization, ?) WHERE id=?`)
      .run(em, String(sub), name || u.name, r, classes, className, slug, scope && scope.school_name || null, u.id);
  } else {
    const info = db.prepare(`INSERT INTO users (email, name, sso_sub, role, classes, class_name, status, approved_at, display_handle, school_slug, organization) VALUES (?, ?, ?, ?, ?, ?, 'approved', datetime('now'), ?, ?, ?)`)
      .run(em, name || em, String(sub), r, classes, className, makeHandle(), slug, scope && scope.school_name || null);
    u = q.userById.get(info.lastInsertRowid);
    q.logEvent.run(u.id, null, null, 'access_granted', JSON.stringify({ email: em, via: 'accounts', role: r }));
    plugins.emit('user:approved', { userId: u.id });
  }
  return q.userById.get(u.id);
}
/* A person whose sign-in token named their school but not its slug (older Accounts builds, or an Academy-only grant):
   find the slug by school name so class views, enrolment and co-branding all work. */
async function resolveSchoolSlug(u, scope) {
  if (!u || u.school_slug) return u;
  const name = String((scope && scope.school_name) || u.organization || '').trim().toLowerCase();
  if (!name) return u;
  try {
    const schools = await require('./brand').listSchools();
    const sch = schools.find(s => String(s.name || '').trim().toLowerCase() === name);
    if (sch && sch.slug) { db.prepare('UPDATE users SET school_slug=? WHERE id=?').run(sch.slug, u.id); return q.userById.get(u.id); }
  } catch {}
  return u;
}
router.get('/auth/sso', (req, res) => {
  if (!sso) return res.redirect('/login');
  res.redirect(sso.authorizeUrl(safeReturn(req.query.return) || req.session.returnTo || '/dashboard'));
});
router.get('/auth/sso/callback', async (req, res) => {
  if (!sso) return res.redirect('/login');
  try {
    const c = sso.verifyToken(req.query.token);
    const u = await resolveSchoolSlug(upsertFromSso(c), c.scope);
    /* "View as": Accounts signed this token for an AI Ninjas administrator looking at the Academy as `u`.
       The session belongs to `u` but carries the administrator, every page shows a banner, and nothing is saved
       (see the read-only guard in server.js). Their own sign-in time is left untouched. */
    const actor = c.act && c.act.sub ? { id: String(c.act.sub), name: String(c.act.name || 'AI Ninjas admin'), email: String(c.act.email || ''), since: new Date().toISOString() } : null;
    if (!actor) db.prepare("UPDATE users SET last_login_at=datetime('now') WHERE id=?").run(u.id);
    else q.logEvent.run(u.id, null, null, 'viewed_as', JSON.stringify({ by: actor.email || actor.name }));
    req.session.regenerate(() => {
      req.session.userId = u.id;
      if (actor) req.session.actor = actor;
      const dest = actor ? homeFor(u) : (safeReturn(req.query.return) || homeFor(u));
      req.session.save(() => res.redirect(dest));
    });
  } catch (e) {
    console.warn('[sso]', e.message);
    res.status(400).render('error', { title: 'Sign-in failed', message: e.message + ' — go back to your AI Ninjas account and try again.' });
  }
});
/* Accounts asks here which schools/classes a School Admin or Teacher can be limited to (the list lives in Quiz Studio) */
router.get('/api/sso/scopes', async (req, res) => {
  const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization || '');
  if (!sso || !m || m[1] !== process.env.SSO_SECRET) return res.status(401).json({ error: 'unauthorized' });
  const schools = await require('./brand').listSchools();
  res.json(schools.map(s => ({ id: s.id, name: s.name, classes: s.classes || [], slug: s.slug })));
});
/* Accounts pushes every access change here */
router.post('/api/sso/sync', express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); } }), (req, res) => {
  if (!sso) return res.status(404).json({ error: 'SSO not enabled' });
  let ev;
  try { ev = sso.verifyWebhook(req.rawBody || '', req.headers); } catch (e) { return res.status(401).json({ error: e.message }); }
  const em = String(ev.user && ev.user.email || '').toLowerCase();
  if (!em) return res.status(400).json({ error: 'No user' });
  if (ev.event === 'grant.updated' && ev.grant && ev.user.status !== 'disabled') { resolveSchoolSlug(upsertFromSso({ sub: ev.user.id, email: em, name: ev.user.name, role: ev.grant.role, scope: ev.grant.scope }), ev.grant.scope); return res.json({ ok: true, applied: 'updated' }); }
  const u = q.userByEmail.get(em);
  if (u) {
    if (u.role === 'admin' && db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND status='approved'").get().n <= 1) return res.json({ ok: true, applied: 'kept-last-admin' });
    db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(u.id);      // keep their progress; they just can't sign in
    db.prepare('DELETE FROM sessions WHERE sess LIKE ?').run(`%"userId":${u.id}%`);
    q.logEvent.run(u.id, null, null, 'access_revoked', JSON.stringify({ via: 'accounts' }));
  }
  res.json({ ok: true, applied: u ? 'disabled' : 'noop' });
});

// ---------- middleware ----------
function currentUser(req, res, next) {
  req.user = req.session.userId ? q.userById.get(req.session.userId) : null;
  res.locals.user = req.user;
  req.actor = req.user && req.session.actor ? req.session.actor : null;   // set when an administrator is "viewing as" this user
  res.locals.actor = req.actor;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
}
function requireLogin(req, res, next) {
  if (!req.user) { req.session.returnTo = req.originalUrl; return res.redirect(sso ? '/auth/sso?return=' + encodeURIComponent(req.originalUrl) : '/login'); }
  if (req.user.status !== 'approved') return res.redirect('/pending');
  // a student whose school has classes picks theirs once (teachers can correct it later)
  if (req.user.role === 'learner' && req.user.school_slug && !req.user.class_name && res.locals.brand && (res.locals.brand.classes || []).length && !req.path.startsWith('/pick-class')) {
    req.session.returnTo = req.originalUrl; return res.redirect('/pick-class');
  }
  next();
}
/* Teachers, school admins and AI Ninjas admins: the class views */
function requireStaff(req, res, next) {
  if (!req.user) { req.session.returnTo = req.originalUrl; return res.redirect(sso ? '/auth/sso?return=' + encodeURIComponent(req.originalUrl) : '/login'); }
  if (!STAFF.includes(req.user.role)) return res.status(403).render('error', { title: 'Teachers only', message: 'This page is for teachers and school admins.' });
  next();
}
const homeFor = u => u.role === 'admin' ? '/admin' : (u.role === 'teacher' || u.role === 'school_admin') ? '/classes' : '/dashboard';
function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'admin') return res.status(403).render('error', { title: 'Forbidden', message: 'Admins only.' });
  next();
}
function flash(req, type, message) { req.session.flash = { type, message }; }
/* While an administrator is viewing as someone, nothing may be saved on that person's behalf: every non-GET request
   (SCORM commits, "Done" buttons, profile edits, enrol requests…) is acknowledged but not applied. */
function readOnlyWhileViewing(req, res, next) {
  if (!req.actor || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (['/logout', '/stop-viewing'].includes(req.path)) return next();
  if (req.path.startsWith('/api/')) return res.json({ ok: true, readonly: true, message: 'Viewing as ' + req.user.name + ' — nothing is saved.' });
  flash(req, 'info', `You are viewing the Academy as ${req.user.name} — changes are not saved.`);
  res.redirect(req.get('Referer') || homeFor(req.user));
}

// ---------- request access / register ----------
router.get('/request-access', (req, res) => res.render('request-access', { title: 'Request access', values: {} }));

router.post('/request-access', (req, res) => {
  const { name, email, password, organization, note } = req.body;
  const values = { name, email, organization, note };
  const em = String(email || '').trim().toLowerCase();
  if (!name || !em || !password) return res.status(400).render('request-access', { title: 'Request access', values, error: 'Name, email and password are required.' });
  if (password.length < 8) return res.status(400).render('request-access', { title: 'Request access', values, error: 'Password must be at least 8 characters.' });
  if (q.userByEmail.get(em)) return res.status(400).render('request-access', { title: 'Request access', values, error: 'An account with this email already exists. Try logging in.' });

  const autoApprove = q.getSetting.get('auto_approve')?.value === '1';
  const info = db.prepare(`INSERT INTO users (email, name, password_hash, organization, request_note, status, approved_at, display_handle)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(em, name.trim(), bcrypt.hashSync(password, 10), organization || null, note || null,
         autoApprove ? 'approved' : 'pending', autoApprove ? new Date().toISOString() : null, makeHandle(name));
  q.logEvent.run(info.lastInsertRowid, null, null, 'access_requested', JSON.stringify({ email: em, organization }));
  plugins.emit('user:requested', { userId: info.lastInsertRowid });
  req.session.userId = info.lastInsertRowid;
  res.redirect(autoApprove ? '/dashboard' : '/pending');
});

// ---------- login ----------
router.get('/login', (req, res) => res.render('login', { title: 'Log in', googleEnabled: !!process.env.GOOGLE_CLIENT_ID, ssoEnabled: !!sso, accountsUrl: ACCOUNTS_URL, showLocal: req.query.local === '1' || !sso }));

router.post('/login', (req, res) => {
  const em = String(req.body.email || '').trim().toLowerCase();
  const user = q.userByEmail.get(em);
  if (!user || !user.password_hash || !bcrypt.compareSync(req.body.password || '', user.password_hash)) {
    return res.status(401).render('login', { title: 'Log in', error: 'Invalid email or password.', googleEnabled: !!process.env.GOOGLE_CLIENT_ID, ssoEnabled: !!sso, accountsUrl: ACCOUNTS_URL, showLocal: true });
  }
  if (user.status === 'disabled' || user.status === 'rejected') {
    return res.status(403).render('login', { title: 'Log in', error: 'This account is not active. Contact info@aininjas.com.', googleEnabled: !!process.env.GOOGLE_CLIENT_ID, ssoEnabled: !!sso, accountsUrl: ACCOUNTS_URL, showLocal: true });
  }
  req.session.userId = user.id;
  db.prepare("UPDATE users SET last_login_at=datetime('now') WHERE id=?").run(user.id);
  const dest = req.session.returnTo || homeFor(user);
  delete req.session.returnTo;
  res.redirect(user.status === 'approved' ? dest : '/pending');
});

/* End a "View as" session: back to the person's record in Accounts (their own Accounts sign-in is untouched). */
router.post('/stop-viewing', (req, res) => {
  const onesite = require('./onesite');
  const who = req.user; const actor = req.session.actor;
  const dest = actor && who && who.sso_sub && onesite.accounts.configured ? `${onesite.accounts.on ? onesite.accounts.prefix : onesite.accounts.public}/admin/users/${encodeURIComponent(who.sso_sub)}` : '/';
  req.session.destroy(() => res.redirect(dest));
});
router.post('/logout', (req, res) => {
  /* one site, one sign-out: also drop the Quiz Studio / Accounts / student cookies that live on this domain */
  const secure = /^https:/i.test(onesite.BASE_URL) ? '; Secure' : '';
  for (const c of ['qs_session', 'ain_session', 'ain_student']) res.append('Set-Cookie', `${c}=; Path=/; Max-Age=0; SameSite=Lax${secure}`);
  req.session.destroy(() => res.redirect('/'));
});
router.get('/pending', (req, res) => {
  if (!req.user) return res.redirect('/login');
  if (req.user.status === 'approved') return res.redirect('/dashboard');
  res.render('pending', { title: 'Access pending' });
});

// ---------- Google Sign-In (plain OAuth 2.0, no passport) ----------
router.get('/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(404).send('Google sign-in not configured');
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${process.env.BASE_URL}/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get('/auth/google/callback', async (req, res) => {
  try {
    if (!req.query.code || req.query.state !== req.session.oauthState) throw new Error('Invalid OAuth state');
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: req.query.code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${process.env.BASE_URL}/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error('Token exchange failed: ' + JSON.stringify(tokens));
    const profile = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })).json();
    if (!profile.email_verified) throw new Error('Google email not verified');

    const em = profile.email.toLowerCase();
    let user = q.userByGoogleId.get(profile.sub) || q.userByEmail.get(em);
    if (user) {
      if (!user.google_id) db.prepare('UPDATE users SET google_id = ? WHERE id = ?').run(profile.sub, user.id);
    } else {
      // Optional domain allow-list, e.g. GOOGLE_ALLOWED_DOMAINS=myschool.edu,aininjas.com
      const allowed = (process.env.GOOGLE_ALLOWED_DOMAINS || '').split(',').map(s => s.trim()).filter(Boolean);
      const autoApprove = q.getSetting.get('auto_approve')?.value === '1' || (allowed.length && allowed.includes(profile.hd));
      const info = db.prepare(`INSERT INTO users (email, name, google_id, status, approved_at, organization, display_handle)
                               VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(em, profile.name || em, profile.sub, autoApprove ? 'approved' : 'pending',
             autoApprove ? new Date().toISOString() : null, profile.hd || null, makeHandle(profile.name || em));
      user = q.userById.get(info.lastInsertRowid);
      q.logEvent.run(user.id, null, null, 'access_requested', JSON.stringify({ email: em, via: 'google' }));
      plugins.emit('user:requested', { userId: user.id });
    }
    req.session.userId = user.id;
    res.redirect(user.status === 'approved' ? homeFor(user) : '/pending');
  } catch (err) {
    console.error('[google]', err);
    res.status(400).render('error', { title: 'Sign-in failed', message: err.message });
  }
});

// ---------- helpers ----------
const HANDLE_WORDS = ['Swift', 'Silent', 'Iron', 'Shadow', 'Crimson', 'Jade', 'Storm', 'Ember', 'Frost', 'Nova'];
const HANDLE_NOUNS = ['Ninja', 'Blade', 'Fox', 'Hawk', 'Tiger', 'Wolf', 'Dragon', 'Falcon', 'Panda', 'Crane'];
function makeHandle() {
  const w = HANDLE_WORDS[Math.floor(Math.random() * HANDLE_WORDS.length)];
  const n = HANDLE_NOUNS[Math.floor(Math.random() * HANDLE_NOUNS.length)];
  return `${w}${n}${Math.floor(100 + Math.random() * 900)}`;
}

/* Pull every Academy grant from Accounts and create/update the local users (safety net if a push was missed). */
async function syncAllFromAccounts() {
  if (!sso) throw new Error('Single sign-on is not configured (ACCOUNTS_URL / SSO_SECRET)');
  const grants = await sso.api('/grants');
  let created = 0, updated = 0, disabled = 0;
  for (const g of grants) {
    if (g.status === 'disabled') { const u = q.userByEmail.get(String(g.email).toLowerCase()); if (u && u.status !== 'disabled') { db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(u.id); disabled++; } continue; }
    const before = q.userByEmail.get(String(g.email).toLowerCase());
    await resolveSchoolSlug(upsertFromSso({ sub: g.id, email: g.email, name: g.name, role: g.role, scope: g.scope }), g.scope);
    if (before) updated++; else created++;
  }
  return { total: grants.length, created, updated, disabled };
}
module.exports = { router, currentUser, readOnlyWhileViewing, requireLogin, requireAdmin, requireStaff, homeFor, STAFF, flash, upsertFromSso, ssoEnabled: !!sso, accountsUrl: ACCOUNTS_URL, syncAllFromAccounts };
