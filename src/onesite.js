// One site: academy.aininjas.com serves Quiz Studio under /assess and Accounts under /account.
//
// The Academy forwards those paths over Railway's private network to the other two services, so teachers and
// students only ever see academy.aininjas.com. Each of the other apps runs with a BASE_URL that carries the prefix
// (https://academy.aininjas.com/assess) and rewrites its own links accordingly (their lib/basepath.js).
//
// Turned on per app by the *_INTERNAL_URL variables:
//   QUIZ_STUDIO_INTERNAL_URL = http://aininjas-quiz-studio.railway.internal:4000   → /assess/*  is Quiz Studio
//   ACCOUNTS_INTERNAL_URL    = http://aininjas-accounts.railway.internal:5000      → /account/* is Accounts
// Without them the Academy links out to QUIZ_STUDIO_URL / ACCOUNTS_URL as before (separate hostnames).
//
// Everything else in the Academy asks this module for the right address:
//   onesite.quiz.public     browser-facing base for links and redirects   (/assess  or  https://assessment.aininjas.com)
//   onesite.quiz.api        server-to-server base for fetch()             (private URL or the public one)
//   onesite.accounts.public / .api  — the same for Accounts (public is absolute: Accounts needs it for sign-in redirects)
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const trim = v => String(v || '').trim().replace(/\/$/, '');

const validUrl = (v, name) => { if (!v) return ''; try { const u = new URL(v); if (/^https?:$/.test(u.protocol) && u.hostname) return v; } catch {} console.warn(`[one site] ${name}="${v}" is not a valid URL — ignored. Expected e.g. http://<service>.railway.internal:4000`); return ''; };
function service({ internal, external, prefix, name }) {
  internal = validUrl(trim(internal), name + '_INTERNAL_URL'); external = trim(external);
  const on = !!internal;
  return {
    on, prefix, internal,
    public: on ? BASE_URL + prefix : external,      // absolute, for redirects and links shown to people
    api: on ? internal : external,                  // for fetch() from this server
    configured: on || !!external,
  };
}

const quiz = service({ internal: process.env.QUIZ_STUDIO_INTERNAL_URL, external: process.env.QUIZ_STUDIO_URL, prefix: '/assess', name: 'QUIZ_STUDIO' });
const accounts = service({ internal: process.env.ACCOUNTS_INTERNAL_URL, external: process.env.ACCOUNTS_URL, prefix: '/account', name: 'ACCOUNTS' });

module.exports = { BASE_URL, quiz, accounts, any: quiz.on || accounts.on };
