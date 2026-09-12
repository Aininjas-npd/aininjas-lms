require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { db, q, DATA_DIR } = require('./src/db');
const auth = require('./src/auth');
const plugins = require('./src/plugins');

const app = express();
const PORT = process.env.PORT || 3000;
process.env.BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);                       // behind nginx / Railway / Render
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));

// Sessions persisted in SQLite so logins survive restarts.
const SqliteStore = require('./src/session-store')(session);
app.use(session({
  store: new SqliteStore({ db }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 30 * 24 * 3600 * 1000 },
}));
app.use(auth.currentUser);
app.use((req, res, next) => {                    // template globals
  res.locals.siteName = process.env.SITE_NAME || 'AI Ninjas Academy';
  res.locals.mainSite = process.env.MAIN_SITE_URL || 'https://aininjas.com';
  res.locals.pluginNav = plugins.nav(req.user?.role === 'admin');
  res.locals.path = req.path;
  res.locals.ssoEnabled = auth.ssoEnabled; res.locals.accountsUrl = auth.accountsUrl;
  next();
});

// Plugins get a way to mount routers before the 404 handler.
plugins.load(app, {
  db, q, DATA_DIR, express, requireLogin: auth.requireLogin, requireAdmin: auth.requireAdmin,
  mountRouter: prefix => { const r = express.Router(); app.use(prefix, r); return r; },
});

app.use(auth.router);
app.use(require('./src/routes/learner'));
app.use('/admin', require('./src/routes/admin'));

app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'Page not found.' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).render('error', { title: 'Error', message: err.message }); });

app.listen(PORT, () => console.log(`AI Ninjas LMS running at ${process.env.BASE_URL}  (data dir: ${DATA_DIR})`));
