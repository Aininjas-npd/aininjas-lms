// School co-branding for the Academy.
// Schools (name, logo, accent, slug) are managed in Quiz Studio; the Academy fetches a school's public
// brand from `${QUIZ_STUDIO_URL}/api/brand/<slug>` and caches it. A person gets a school context from:
//   1. their user row (users.school_slug — set from the Accounts sign-in token or by an admin), or
//   2. the entry link they arrived through (academy.aininjas.com/s/<slug> sets the `ain_school` cookie).
// AI Ninjas stays visible everywhere — this is co-branding, not white-labelling.
const { db } = require('./db');

const QUIZ_URL = (process.env.QUIZ_STUDIO_URL || '').replace(/\/$/, '');
const LAUNCH_SECRET = process.env.QUIZ_LAUNCH_SECRET || '';
const COOKIE = 'ain_school';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const TTL = 5 * 60 * 1000;
const cache = new Map();                       // slug → { at, brand|null }

async function fetchBrand(slug) {
  if (!QUIZ_URL || !SLUG_RE.test(slug || '')) return null;
  const c = cache.get(slug);
  if (c && c.at > Date.now() - TTL) return c.brand;
  let brand = null;
  try {
    const r = await fetch(`${QUIZ_URL}/api/brand/${slug}`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) brand = await r.json();
    else if (r.status !== 404) throw new Error('HTTP ' + r.status);
  } catch (e) {
    console.warn('[brand]', slug, e.message);
    if (c) return c.brand;                     // keep showing the last known brand if Quiz Studio is asleep
  }
  cache.set(slug, { at: Date.now(), brand });
  return brand;
}

/** All schools (for the admin's "school" dropdown). Needs the launch secret; empty list if not configured. */
async function listSchools() {
  if (!QUIZ_URL || !LAUNCH_SECRET) return [];
  try {
    const r = await fetch(`${QUIZ_URL}/api/sso/schools`, { headers: { Authorization: 'Bearer ' + LAUNCH_SECRET }, signal: AbortSignal.timeout(8000) });
    return r.ok ? await r.json() : [];
  } catch (e) { console.warn('[brand] list', e.message); return []; }
}

function cookieSlug(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([a-z0-9-]{2,40})`).exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function setCookie(res, slug) {
  const secure = /^https:/i.test(process.env.BASE_URL || '');
  res.append('Set-Cookie', `${COOKIE}=${slug}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? '; Secure' : ''}`);
}

/** Express middleware: res.locals.brand = the school for this request (or null), res.locals.brandCss = accent overrides. */
async function context(req, res, next) {
  try {
    // AI Ninjas administrators work across every school, so they see the plain AI Ninjas Academy
    const isAdmin = req.user && req.user.role === 'admin';
    const slug = isAdmin ? null : ((req.user && req.user.school_slug) || cookieSlug(req));
    const brand = slug ? await fetchBrand(slug) : null;
    res.locals.brand = brand;
    res.locals.brandCss = brand ? `:root{--crimson:${brand.accent_hex};--crimson-hover:${brand.accent_hover};--crimson-soft:${brand.accent_soft};--accent:${brand.accent_hex};--school-accent:${brand.accent_hex}}` : '';
    // a signed-in person without a school yet inherits the school of the entry link they used
    if (brand && req.user && !req.user.school_slug && cookieSlug(req) === brand.slug) {
      db.prepare('UPDATE users SET school_slug=? WHERE id=?').run(brand.slug, req.user.id);
      req.user.school_slug = brand.slug;
    }
  } catch (e) { console.warn('[brand]', e.message); res.locals.brand = null; res.locals.brandCss = ''; }
  next();
}

module.exports = { fetchBrand, listSchools, context, cookieSlug, setCookie, SLUG_RE, QUIZ_URL };
