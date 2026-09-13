// Authentication: request-access form, email/password login, Google Sign-In, approval gating.
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { db, q } = require('./db');
const plugins = require('./plugins');

const router = express.Router();

/* ---------- Single sign-on through AI Ninjas Accounts (on when ACCOUNTS_URL + SSO_SECRET are set) ---------- */
const ACCOUNTS_URL = (process.env.ACCOUNTS_URL || '').replace(/\/$/, '');
const sso = ACCOUNTS_URL && process.env.SSO_SECRET
  ? require('./aininjas-sso')({ accountsUrl: ACCOUNTS_URL, appSlug: process.env.SSO_APP_SLUG || 'lms', secret: process.env.SSO_SECRET })
  : null;
const safeReturn = v => (/^\/(?!\/)/.test(String(v || '')) ? String(v) : '');

/* Create/update the local user from Accounts claims. Accounts-granted users are approved by definition. */
function upsertFromSso({ sub, email, name, role, scope }) {
  const em = String(email).toLowerCase();
  const r = role === 'admin' ? 'admin' : 'learner';
  const slug = scope && /^[a-z0-9][a-z0-9-]{1,39}$/.test(scope.school_slug || '') ? scope.school_slug : null;   // school co-branding
  let u = db.prepare('SELECT * FROM users WHERE sso_sub=? OR email=?').get(String(sub), em);
  if (u) {
    db.prepare(`UPDATE users SET email=?, sso_sub=?, name=?, role=?, status='approved', approved_at=COALESCE(approved_at, datetime('now')), school_slug=COALESCE(?, school_slug), organization=COALESCE(organization, ?) WHERE id=?`)
      .run(em, String(sub), name || u.name, r, slug, scope && scope.school_name || null, u.id);
  } else {
    const info = db.prepare(`INSERT INTO users (email, name, sso_sub, role, status, approved_at, display_handle, school_slug, organization) VALUES (?, ?, ?, ?, 'approved', datetime('now'), ?, ?, ?)`)
      .run(em, name || em, String(sub), r, makeHandle(), slug, scope && scope.school_name || null);
    u = q.userById.get(info.lastInsertRowid);
    q.logEvent.run(u.id, null, null, 'access_granted', JSON.stringify({ email: em, via: 'accounts', role: r }));
    plugins.emit('user:approved', { userId: u.id });
  }
  return q.userById.get(u.id);
}
router.get('/auth/sso', (req, res) => {
  if (!sso) return res.redirect('/login');
  res.redirect(sso.authorizeUrl(safeReturn(req.query.return) || req.session.returnTo || '/dashboard'));
});
router.get('/auth/sso/callback', (req, res) => {
  if (!sso) return res.redirect('/login');
  try {
    const c = sso.verifyToken(req.query.token);
    const u = upsertFromSso(c);
    db.prepare("UPDATE users SET last_login_at=datetime('now') WHERE id=?").run(u.id);
    req.session.regenerate(() => {
      req.session.userId = u.id;
      const dest = safeReturn(req.query.return) || (u.role === 'admin' ? '/admin' : '/dashboard');
      req.session.save(() => res.redirect(dest));
    });
  } catch (e) {
    console.warn('[sso]', e.message);
    res.status(400).render('error', { title: 'Sign-in failed', message: e.message + ' — go back to your AI Ninjas account and try again.' });
  }
});
/* Accounts pushes every access change here */
router.post('/api/sso/sync', express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); } }), (req, res) => {
  if (!sso) return res.status(404).json({ error: 'SSO not enabled' });
  let ev;
  try { ev = sso.verifyWebhook(req.rawBody || '', req.headers); } catch (e) { return res.status(401).json({ error: e.message }); }
  const em = String(ev.user && ev.user.email || '').toLowerCase();
  if (!em) return res.status(400).json({ error: 'No user' });
  if (ev.event === 'grant.updated' && ev.grant && ev.user.status !== 'disabled') { upsertFromSso({ sub: ev.user.id, email: em, name: ev.user.name, role: ev.grant.role, scope: ev.grant.scope }); return res.json({ ok: true, applied: 'updated' }); }
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
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
}
function requireLogin(req, res, next) {
  if (!req.user) { req.session.returnTo = req.originalUrl; return res.redirect(sso ? '/auth/sso?return=' + encodeURIComponent(req.originalUrl) : '/login'); }
  if (req.user.status !== 'approved') return res.redirect('/pending');
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'admin') return res.status(403).render('error', { title: 'Forbidden', message: 'Admins only.' });
  next();
}
function flash(req, type, message) { req.session.flash = { type, message }; }

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
  const dest = req.session.returnTo || (user.role === 'admin' ? '/admin' : '/dashboard');
  delete req.session.returnTo;
  res.redirect(user.status === 'approved' ? dest : '/pending');
});

router.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));
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
    res.redirect(user.status === 'approved' ? (user.role === 'admin' ? '/admin' : '/dashboard') : '/pending');
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
    upsertFromSso({ sub: g.id, email: g.email, name: g.name, role: g.role, scope: g.scope });
    if (before) updated++; else created++;
  }
  return { total: grants.length, created, updated, disabled };
}
module.exports = { router, currentUser, requireLogin, requireAdmin, flash, ssoEnabled: !!sso, accountsUrl: ACCOUNTS_URL, syncAllFromAccounts };
