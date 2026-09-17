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

/**
 * mount(app, { prefix: '/assess', target: 'http://host:4000', secret, shell: req => ({...}) })
 * Everything under `prefix` (and the bare prefix) is forwarded to target + original path.
 */
function mount(app, { prefix, target, secret, shell, log = console }) {
  const t = new URL(target);
  const client = t.protocol === 'https:' ? https : http;
  const agent = new client.Agent({ keepAlive: true, maxSockets: 64 });

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

    const up = client.request({
      protocol: t.protocol, hostname: t.hostname, port: t.port || (t.protocol === 'https:' ? 443 : 80),
      method: req.method, path: req.originalUrl, headers, agent, timeout: 120000,
    }, r => {
      const out = {};
      for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) out[k] = v;
      res.writeHead(r.statusCode, out);
      r.pipe(res);
    });
    up.on('timeout', () => up.destroy(new Error('upstream timeout')));
    up.on('error', err => {
      log.warn(`[proxy ${prefix}] ${req.method} ${req.originalUrl}: ${err.message}`);
      if (!res.headersSent) res.status(502).type('html').send(`<!doctype html><meta charset="utf-8"><title>Temporarily unavailable</title><main style="font-family:system-ui;max-width:520px;margin:80px auto;padding:0 20px"><h1>That part of the Academy is waking up</h1><p>Please try again in a moment. If this keeps happening, tell your teacher or AI Ninjas admin.</p><p><a href="/">Back to the Academy</a></p></main>`);
      else res.end();
    });
    req.on('aborted', () => up.destroy());
    req.pipe(up);
  });
}

module.exports = { mount };
