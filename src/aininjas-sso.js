'use strict';
/* ============================================================
   aininjas-sso.js — drop-in client for the AI Ninjas Accounts service.
   Copy this file into any app that should accept AI Ninjas sign-ins.
   Zero dependencies (Node 18+ — uses crypto + global fetch).

   const sso = require('./lib/aininjas-sso')({
     accountsUrl: process.env.ACCOUNTS_URL,        // https://accounts.aininjas.com
     appSlug:     'quiz-studio',                    // as registered in Accounts → Apps
     secret:      process.env.SSO_SECRET,           // shown once on the app's page in Accounts
   });

   1. Send the user to  sso.authorizeUrl(returnPath)  (e.g. from a "Sign in with AI Ninjas" button).
   2. Accounts redirects back to your callback with ?token=…&return=…
      const claims = sso.verifyToken(req.query.token);   // { sub, email, name, role, scope, ... }
      → upsert your local user from claims, create your own session.
   3. Accounts POSTs grant changes to your sync endpoint (registered per app);
      verify with  sso.verifyWebhook(rawBody, req.headers)  before applying.
   4. Ask Accounts to invite/update/remove a user for this app with  sso.api(...)
      (Bearer-authenticated with the app secret).
   ============================================================ */
const crypto = require('crypto');

const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** Sign a payload as an HS256 JWT. */
function sign(payload, secret) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac('sha256', secret).update(h + '.' + p).digest());
  return h + '.' + p + '.' + sig;
}
/** Verify an HS256 JWT; returns the payload or throws. */
function verify(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const expect = b64u(crypto.createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest());
  const a = Buffer.from(expect), b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Bad token signature');
  const payload = JSON.parse(unb64u(parts[1]).toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now > payload.exp + 30) throw new Error('Token expired');
  if (payload.nbf && now < payload.nbf - 30) throw new Error('Token not yet valid');
  return payload;
}

/** Sign a webhook body: returns the value for the X-AIN-Signature header. */
function signWebhook(rawBody, secret, ts = Math.floor(Date.now() / 1000)) {
  const mac = crypto.createHmac('sha256', secret).update(ts + '.' + rawBody).digest('hex');
  return `t=${ts},v1=${mac}`;
}

function createClient({ accountsUrl, appSlug, secret }) {
  if (!accountsUrl || !appSlug || !secret) throw new Error('aininjas-sso: accountsUrl, appSlug and secret are required');
  accountsUrl = accountsUrl.replace(/\/$/, '');
  const seenJti = new Map();                      // one-time tokens (jti → exp)
  function sweep() { const now = Date.now() / 1000; for (const [k, v] of seenJti) if (v < now) seenJti.delete(k); }

  return {
    sign, verify, signWebhook,

    authorizeUrl(returnTo) {
      const u = new URL(accountsUrl + '/sso/authorize');
      u.searchParams.set('app', appSlug);
      if (returnTo) u.searchParams.set('return', returnTo);
      return u.toString();
    },
    logoutUrl(returnTo) {
      const u = new URL(accountsUrl + '/logout');
      if (returnTo) u.searchParams.set('return', returnTo);
      return u.toString();
    },
    accountUrl() { return accountsUrl + '/'; },

    /** Verify a sign-in token issued for this app. Throws on any problem. */
    verifyToken(token) {
      const c = verify(token, secret);
      if (c.aud !== appSlug) throw new Error('Token is for a different app');
      if (c.iss !== 'aininjas-accounts') throw new Error('Unknown issuer');
      if (!c.jti) throw new Error('Token has no id');
      sweep();
      if (seenJti.has(c.jti)) throw new Error('Token already used');
      seenJti.set(c.jti, c.exp || (Date.now() / 1000 + 300));
      return c;
    },

    /** Verify an incoming sync webhook. rawBody must be the exact request body string. */
    verifyWebhook(rawBody, headers) {
      const h = String(headers['x-ain-signature'] || '');
      const m = /t=(\d+),v1=([a-f0-9]+)/.exec(h);
      if (!m) throw new Error('Missing signature');
      const ts = +m[1];
      if (Math.abs(Date.now() / 1000 - ts) > 300) throw new Error('Stale webhook');
      const expect = crypto.createHmac('sha256', secret).update(ts + '.' + rawBody).digest('hex');
      const a = Buffer.from(expect), b = Buffer.from(m[2]);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Bad webhook signature');
      return JSON.parse(rawBody);
    },

    /** Call the Accounts app-API as this app. path e.g. '/grants'. */
    async api(path, { method = 'GET', body } = {}) {
      const r = await fetch(accountsUrl + '/api/v1' + path, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + secret, 'X-App': appSlug },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || ('Accounts API HTTP ' + r.status));
      return data;
    },
  };
}

module.exports = createClient;
module.exports.sign = sign;
module.exports.verify = verify;
module.exports.signWebhook = signWebhook;
