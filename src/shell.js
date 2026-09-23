// The Academy's menu, in one place: the header partial renders it, and the one-site proxy hands it to
// Quiz Studio and Accounts so their pages show the same header (see proxy.js / onesite.js).
const onesite = require('./onesite');

const ROLE_LABEL = { admin: 'Administrator', school_admin: 'School Admin', teacher: 'Teacher' };
const STAFF = ['admin', 'school_admin', 'teacher'];

/** Primary menu items for a signed-in, approved user. `path` is the current request path for the "on" state. */
function navFor(user, path = '', pluginNav = [], viewing = false) {
  if (!user || user.status !== 'approved') return [];
  const items = [];
  const staff = STAFF.includes(user.role);
  const on = (test) => typeof test === 'function' ? test(path) : path === test;
  if (user.role === 'learner' || user.role === 'admin') items.push({ href: '/dashboard', label: 'My courses', on: on('/dashboard') });
  if (user.role === 'learner') items.push({ href: '/assignments', label: 'Assignments', on: on(p => p.startsWith('/assignments')) });
  if (staff) items.push({ href: '/classes', label: user.role === 'teacher' ? 'My classes' : 'Classes', on: on(p => p.startsWith('/classes') || p.startsWith('/students')) });
  for (const n of pluginNav) items.push({ href: n.href, label: n.label, on: on(p => p.startsWith(n.href)) });
  if (staff && onesite.quiz.configured && !viewing) items.push({ href: onesite.quiz.on ? onesite.quiz.prefix + '/admin' : onesite.quiz.public + '/admin', label: 'Assessments', out: true, on: on(p => p.startsWith(onesite.quiz.prefix + '/') || p === onesite.quiz.prefix) });
  if (user.role === 'admin') {
    items.push({ href: '/admin/courses', label: 'Courses', on: on(p => p.startsWith('/admin/courses')) });
    items.push({ href: '/admin/curricula', label: 'Curricula', on: on(p => p.startsWith('/admin/curricula')) });
    items.push({ href: '/admin/users', label: 'Users', on: on(p => p.startsWith('/admin/users')) });
    items.push({ href: '/admin', label: 'Activity', on: on(p => p === '/admin' || p === '/admin/') });
  }
  return items;
}

/**
 * Leaving the Academy for another app (Assessments), carrying the page she is leaving.
 *
 * Quiz Studio wears the Academy's menu, so it can always get her back to the Academy — but not to
 * the page she was actually working on. A teacher who goes Grade 9 → Assessments → By Class has
 * only the browser's Back button, and she loses it the moment she moves between tabs there. So the
 * jump hands over where she came from, and Quiz Studio shows it as a link for as long as she stays.
 */
function withBack(href, path, label) {
  const abs = h => (/^https?:\/\//.test(h) ? h : onesite.BASE_URL + h);
  try {
    const u = new URL(abs(href));
    u.searchParams.set('back', abs(String(path || '/').split('?')[0]));
    if (label) u.searchParams.set('back_label', String(label).slice(0, 60));
    return u.toString();
  } catch { return href; }
}

/** What the proxy sends upstream for this request: menu + who + where Account / Log out go.
 *  Links are absolute on purpose: the other apps rewrite root-relative URLs that start with one of their own
 *  segments (Accounts and Quiz Studio both own "/admin"), so "/admin/courses" would come out as "/account/admin/courses". */
function shellFor(req) {
  const user = req.user;
  if (!user || user.status !== 'approved') return null;
  const abs = href => (/^https?:\/\//.test(href) ? href : onesite.BASE_URL + href);
  return {
    app_name: process.env.SITE_NAME || 'AI Ninjas Academy', app_tag: 'Academy', home: abs('/'),
    nav: navFor(user, String(req.originalUrl || req.path).split('?')[0], req.app.locals.pluginNavFor ? req.app.locals.pluginNavFor(user) : [], !!req.actor)   // originalUrl: inside the proxy mount req.path has lost the prefix
      .map(n => ({ ...n, href: abs(n.href) })),
    user: { name: user.name, role_label: ROLE_LABEL[user.role] || 'Learner' },
    profile: abs('/profile'),
    viewing_as: req.actor ? { by: req.actor.name } : null,
    account: !req.actor && user.sso_sub && onesite.accounts.configured ? (onesite.accounts.on ? abs(onesite.accounts.prefix + '/') : onesite.accounts.public + '/') : null,
    logout: abs('/logout'),
  };
}

module.exports = { navFor, shellFor, withBack, ROLE_LABEL };
