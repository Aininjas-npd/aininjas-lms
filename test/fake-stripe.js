// Minimal fake of the Stripe REST API surface the Academy uses (products, prices, checkout sessions, subscriptions).
// In-memory; `__pay/<session>` marks a session paid the way a real checkout would; `__dump` shows the store.
// Used by test/commerce.js; run standalone with `node test/fake-stripe.js` (port 4242) and point the Academy at it
// with STRIPE_API_BASE=http://localhost:4242. Set FAKE_STRIPE_LOG=1 to print requests.
// Minimal fake of the Stripe REST API surface the Academy uses. Stores objects in memory; prints requests.
const http = require('http'); const qs = require('querystring');
const store = { products: {}, prices: {}, sessions: {}, subscriptions: {}, customers: {} }; let n = 0; const id = p => p + '_' + (++n).toString(36).padStart(6, '0');
const parse = body => { const flat = qs.parse(body); const out = {}; for (const [k, v] of Object.entries(flat)) { const path = k.replace(/\]/g, '').split('['); let o = out; path.forEach((seg, i) => { if (i === path.length - 1) o[seg] = v; else o = (o[seg] = o[seg] || (/^\d+$/.test(path[i+1]) ? [] : {})); }); } return out; };
module.exports = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => {
  const [path, query] = req.url.split('?'); const body = parse(b); const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'request-id': 'req_x' }); res.end(JSON.stringify(obj)); };
  const log = (...a) => { if (process.env.FAKE_STRIPE_LOG) console.log('[fake-stripe]', req.method, path, ...a); };
  let m;
  if (req.method === 'POST' && path === '/v1/products') { const p = { id: id('prod'), object: 'product', active: true, ...body }; store.products[p.id] = p; log('→', p.id); return send(200, p); }
  if ((m = path.match(/^\/v1\/products\/(\w+)$/)) && req.method === 'POST') { Object.assign(store.products[m[1]], body); return send(200, store.products[m[1]]); }
  if (req.method === 'POST' && path === '/v1/prices') { const p = { id: id('price'), object: 'price', active: true, unit_amount: +body.unit_amount, currency: body.currency, product: body.product, recurring: body.recurring || null, metadata: body.metadata || {} }; store.prices[p.id] = p; log('→', p.id, p.unit_amount); return send(200, p); }
  if ((m = path.match(/^\/v1\/prices\/(\w+)$/)) && req.method === 'POST') { Object.assign(store.prices[m[1]], { active: body.active !== 'false' }); return send(200, store.prices[m[1]]); }
  if (req.method === 'GET' && path === '/v1/prices') { const q = qs.parse(query || ''); return send(200, { object: 'list', data: Object.values(store.prices).filter(p => (!q.product || p.product === q.product) && (q.active === undefined || String(p.active) === q.active)) }); }
  if (req.method === 'POST' && path === '/v1/checkout/sessions') { const s = { id: id('cs_test'), object: 'checkout.session', url: 'https://checkout.stripe.test/pay/' + n, mode: body.mode, metadata: body.metadata || {}, payment_status: 'unpaid', status: 'open', customer: null, customer_email: body.customer_email || null, line_items: body.line_items, success_url: body.success_url, amount_total: +store.prices[body.line_items[0].price].unit_amount, subscription_data: body.subscription_data || null }; store.sessions[s.id] = s; log('→', s.id, s.mode, JSON.stringify(s.metadata)); return send(200, s); }
  if ((m = path.match(/^\/v1\/checkout\/sessions\/(\w+)$/)) && req.method === 'GET') { return store.sessions[m[1]] ? send(200, store.sessions[m[1]]) : send(404, { error: { message: 'no such session' } }); }
  if ((m = path.match(/^\/v1\/subscriptions\/(\w+)$/)) && req.method === 'GET') { return store.subscriptions[m[1]] ? send(200, store.subscriptions[m[1]]) : send(404, { error: { message: 'no such subscription' } }); }
  // test helper: mark a session paid and return the object (what the webhook would carry)
  if ((m = path.match(/^\/__pay\/(\w+)$/))) { const s = store.sessions[m[1]]; const email = (qs.parse(query||'').email) || s.customer_email || 'buyer@test.local'; const cust = id('cus'); s.payment_status = 'paid'; s.status = 'complete'; s.customer = cust; s.customer_details = { email, name: 'Buyer ' + email.split('@')[0] }; s.payment_intent = id('pi'); if (s.mode === 'subscription') { const sub = { id: id('sub'), object: 'subscription', status: 'active', customer: cust, current_period_end: Math.floor(Date.now()/1000) + 365*86400, metadata: s.subscription_data ? s.subscription_data.metadata : {} }; store.subscriptions[sub.id] = sub; s.subscription = sub.id; s.invoice = id('in'); } return send(200, s); }
  if (path === '/__dump') return send(200, store);
  log('UNHANDLED'); send(404, { error: { message: 'fake: unhandled ' + req.method + ' ' + path } });
}); });
if (require.main === module) module.exports.listen(4242, () => console.log("fake stripe on :4242"));
