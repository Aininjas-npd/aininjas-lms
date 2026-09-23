require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { db, q, DATA_DIR } = require('./src/db');
const auth = require('./src/auth');
const plugins = require('./src/plugins');
const brand = require('./src/brand');
const onesite = require('./src/onesite');          // /assess → Quiz Studio, /account → Accounts (one site)
const shell = require('./src/shell');

const app = express();
const PORT = process.env.PORT || 3000;
process.env.BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);                       // behind nginx / Railway / Render
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, 'public', 'favicon.png')));   // browsers ask for this on pages without an icon link

// Sessions persisted in SQLite so logins survive restarts.
const SqliteStore = require('./src/session-store')(session);
app.use(session({
  store: new SqliteStore({ db }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 30 * 24 * 3600 * 1000 },
}));
app.use(auth.currentUser);
app.use(auth.readOnlyWhileViewing);              // "View as": an administrator looking through someone's eyes can't save anything
app.use(brand.context);                          // school co-branding: res.locals.brand / brandCss

app.use((req, res, next) => {                    // template globals
  res.locals.siteName = process.env.SITE_NAME || 'AI Ninjas Academy';
  res.locals.mainSite = process.env.MAIN_SITE_URL || 'https://aininjas.com';
  res.locals.pluginNav = plugins.nav(req.user?.role === 'admin');
  res.locals.path = req.path;
  res.locals.ssoEnabled = auth.ssoEnabled; res.locals.accountsUrl = auth.accountsUrl;
  res.locals.shellNav = shell.navFor(req.user, req.path, res.locals.pluginNav, !!req.actor);
  /* For menu items that leave the Academy: hand the other app the page she is on, so it can offer
     the way back. The header partial supplies the page's own title as the label. */
  res.locals.withBack = (href, label) => shell.withBack(href, req.originalUrl || req.path, label);
  res.locals.accountsBase = onesite.accounts.configured ? (onesite.accounts.on ? onesite.accounts.prefix : onesite.accounts.public) : null;   // "/account" in one-site mode
  res.locals.ssoAppSlug = process.env.SSO_APP_SLUG || 'lms';
  res.locals.accountHref = req.user && !req.actor && req.user.sso_sub && res.locals.accountsBase ? res.locals.accountsBase + '/' : null;
  next();
});

/* One site: forward /assess/* and /account/* to the other services before any body parser touches the request,
   passing along the Academy's menu so their pages wear the same header. */
app.locals.pluginNavFor = user => plugins.nav(user && user.role === 'admin');
if (onesite.quiz.on) require('./src/proxy').mount(app, { prefix: onesite.quiz.prefix, target: onesite.quiz.internal, secret: process.env.QUIZ_LAUNCH_SECRET, shell: shell.shellFor });
if (onesite.accounts.on) require('./src/proxy').mount(app, { prefix: onesite.accounts.prefix, target: onesite.accounts.internal, secret: process.env.SSO_SECRET, shell: shell.shellFor });   // Accounts checks the proof against our registered app secret

app.use(express.urlencoded({ extended: true }));


// Plugins get a way to mount routers before the 404 handler.
plugins.load(app, {
  db, q, DATA_DIR, express, requireLogin: auth.requireLogin, requireAdmin: auth.requireAdmin,
  mountRouter: prefix => { const r = express.Router(); app.use(prefix, r); return r; },
});

app.use(auth.router);
app.use(require('./src/routes/learner'));
app.use(require('./src/routes/assign'));    // assignments + gradebook (staff) and the student due list (before classes: /classes/:name/assignments)
app.use(require('./src/routes/enrol'));     // bulk + scheduled enrolment, course availability (before classes: /classes/enrolments beats /classes/:name)
app.use(require('./src/routes/teach'));     // before classes: /classes/:name/teach beats /classes/:name
app.use(require('./src/routes/classes'));   // teacher / school-admin class views + student class picker
app.use('/admin', require('./src/routes/curriculum'));   // before admin: /admin/curricula/:id beats admin's own patterns
app.use('/admin', require('./src/routes/admin'));

app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'Page not found.' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).render('error', { title: 'Error', message: err.message }); });

require('./src/storage').start();                // clear abandoned upload temp files; warn when the volume is nearly full
require('./src/enrol').start();                  // scheduled enrolments: apply on their start day, end the day after their end date

app.listen(PORT, () => {
  console.log(`AI Ninjas LMS running at ${process.env.BASE_URL}  (data dir: ${DATA_DIR})`);
  if (onesite.quiz.on) console.log(`  one site: ${onesite.quiz.prefix}/* → Quiz Studio at ${onesite.quiz.internal}`);
  if (onesite.accounts.on) console.log(`  one site: ${onesite.accounts.prefix}/* → Accounts at ${onesite.accounts.internal}`);
});
