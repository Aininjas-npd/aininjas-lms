// Reverse proxy for one-site mode: /assess/* → Quiz Studio, /account/* → Accounts (see onesite.js).
//
// Plain Node http — no extra dependency. Requests are streamed through untouched (JSON, form posts, file uploads,
// server-sent events for live quizzes), so the upstream app sees exactly what the browser sent. The upstream
// keeps the prefix in the path (it mounts itself under BASE_PATH), redirects it issues already carry the prefix,
// and its Set-Cookie headers apply to academy.aininjas.com like any other cookie.
//
// Two headers tell the upstream who is browsing so its pages can wear the Academy's header:
//   X-AIN-Proxy: <QUIZ_LAUNCH_SECRET>     proves the request came through this proxy
//   X-AIN-Shell: base64url(JSON)          the Academy's menu for this person (see shell.js)
const http = require('http');
const https = require('https');

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
// Upstream work can take a while — an AI quiz generation runs for several minutes — so the cap is
// generous. PROXY_TIMEOUT_MS (seconds*1000) overrides it.
const PROXY_TIMEOUT_MS = Math.max(30000, parseInt(process.env.PROXY_TIMEOUT_MS, 10) || 900000);

/**
 * mount(app, { prefix: '/assess', target: 'http://host:4000', secret, shell: req => ({...}) })
 * Everything under `prefix` (and the bare prefix) is forwarded to target + original path.
 */
function mount(app, { prefix, target, secret, shell, log = console }) {
  secret = String(secret || '').trim();                       // a pasted secret may carry a stray newline — never send that in a header
  let t;
  try { t = new URL(target); if (!/^https?:$/.test(t.protocol) || !t.hostname) throw new Error('not an http(s) URL'); }
  catch (e) { log.warn(`[proxy ${prefix}] not enabled: "${target}" is not a valid URL (${e.message}). Set the *_INTERNAL_URL variable to e.g. http://<service>.railway.internal:4000`); return false; }
  const client = t.protocol === 'https:' ? https : http;
  const agent = new client.Agent({ keepAlive: true, maxSockets: 64 });

  /*
   * What someone sees when the app behind this prefix is not answering — mid-deploy, restarting,
   * or busy. It is deliberately self-contained (no stylesheet, no fonts, no JS): the reason we are
   * here at all may be that the site is struggling, and a page that needs three more requests to
   * render is the wrong thing to send. It retries itself once after eight seconds, which covers
   * the usual case of a container coming back up.
   */
  const label = prefix === '/account' ? 'Sign-in' : prefix === '/assess' ? 'Assessments' : 'That part of the Academy';
  const unavailable = () => `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${label} is coming back</title>
<style>body{background:#F6F3EC;color:#171B26;font-family:Archivo,system-ui,-apple-system,sans-serif;margin:0}
main{max-width:560px;margin:14vh auto 0;padding:0 24px}
.bar{height:6px;background:#B3232F;border-radius:3px;width:64px;margin-bottom:26px}
h1{font-size:28px;line-height:1.2;margin:0 0 12px}p{font-size:16px;line-height:1.6;color:#3A4152;margin:0 0 14px}
.muted{color:#6B6A63;font-size:14px}a{color:#B3232F}</style>
<main><div class="bar"></div>
<h1>${label} is coming back</h1>
<p>This part of AI Ninjas Academy restarted a moment ago and is not ready yet. Nothing has been lost — wait a few seconds and try again.</p>
<p class="muted">This page refreshes itself shortly. If it is still here in a minute or two, tell your teacher or AI Ninjas, and mention the time.</p>
<p><a href="/">Back to the Academy</a></p></main>
<script>setTimeout(function(){location.reload();},8000)</script></html>`;
  app.use(prefix, (req, res) => {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
    headers['host'] = t.host;
    headers['x-forwarded-host'] = req.headers.host || '';
    headers['x-forwarded-proto'] = req.protocol;
    headers['x-forwarded-for'] = [req.headers['x-forwarded-for'], req.socket.remoteAddress].filter(Boolean).join(', ');
    if (secret) {
      headers['x-ain-proxy'] = secret;
      try { const sh = shell && shell(req); if (sh) headers['x-ain-shell'] = Buffer.from(JSON.stringify(sh), 'utf8').toString('base64url'); } catch {}
    } else { delete headers['x-ain-proxy']; delete headers['x-ain-shell']; }

    let up;
    try {
      up = client.request({
        protocol: t.protocol, hostname: t.hostname, port: t.port || (t.protocol === 'https:' ? 443 : 80),
        method: req.method, path: req.originalUrl, headers, agent, timeout: PROXY_TIMEOUT_MS,
      }, r => {
      const out = {};
      for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) out[k] = v;
      res.writeHead(r.statusCode, out);
      r.pipe(res);
      });
    } catch (err) {                                            // e.g. an invalid character in a header value
      log.warn(`[proxy ${prefix}] could not forward ${req.method} ${req.originalUrl}: ${err.message}`);
      return res.status(502).type('html').send(unavailable());
    }
    up.on('timeout', () => up.destroy(new Error('upstream timeout')));
    up.on('error', err => {
      /* a connect failure on both IPv6 and IPv4 arrives as an AggregateError with an empty message — show the causes */
      const why = err.message || (err.errors && err.errors.map(e => e.code || e.message).join(', ')) || err.code || String(err);
      log.warn(`[proxy ${prefix}] ${req.method} ${req.originalUrl}: ${why}${/ECONNREFUSED/.test(why) ? '  (connection refused — is the upstream listening on that port? check its PORT variable)' : ''}`);
      if (!res.headersSent) res.status(502).type('html').send(unavailable());
      else res.end();
    });
    req.on('aborted', () => up.destroy());
    req.pipe(up);
  });
  return true;
}

module.exports = { mount };
