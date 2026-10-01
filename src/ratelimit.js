'use strict';
/* Small in-memory rate limiter for sign-in style routes (no dependency, one process).
   limit({ windowMs, max, key }) → Express middleware. Counts attempts per key (default: client IP + route) in a
   sliding window; past `max` it answers 429 with a Retry-After header. State is per process, which is all a
   single-instance deployment needs; a second instance would simply count separately. */
const buckets = new Map();
function sweep() {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
}
setInterval(sweep, 60 * 1000).unref();

function limit({ windowMs = 15 * 60 * 1000, max = 20, key, message } = {}) {
  return function rateLimit(req, res, next) {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const k = (key ? key(req) : ip) + '|' + req.baseUrl + req.path;
    const now = Date.now();
    let b = buckets.get(k);
    if (!b || b.reset <= now) { b = { n: 0, reset: now + windowMs }; buckets.set(k, b); }
    b.n++;
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - b.n)));
    if (b.n > max) {
      const retry = Math.ceil((b.reset - now) / 1000);
      res.setHeader('Retry-After', String(retry));
      const text = message || `Too many attempts. Try again in ${Math.ceil(retry / 60)} minute(s).`;
      if ((req.headers.accept || '').includes('application/json') || req.path.startsWith('/api/')) return res.status(429).json({ error: text });
      return res.status(429).type('text/plain').send(text);
    }
    next();
  };
}
/** Forget the attempts for a key — call after a successful sign-in so one bad password does not count forever. */
function reset(req, key) {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  buckets.delete((key ? key(req) : ip) + '|' + req.baseUrl + req.path);
}
module.exports = { limit, reset };
