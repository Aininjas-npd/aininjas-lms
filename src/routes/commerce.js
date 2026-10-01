'use strict';
/* eCommerce routes. Public: catalog, buy, welcome, Stripe webhook. Admin: products, orders. */
const express = require('express');
const { db, q } = require('../db');
const commerce = require('../commerce');
const { flash, requireAdmin } = require('../auth');
const onesite = require('../onesite');

const pub = express.Router();

/* The catalog www.aininjas.com reads (CORS open: it is public pricing). */
pub.get('/api/catalog', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'public, max-age=60');
  res.json(commerce.catalog());
});

/* Buy: create the Checkout Session and send the buyer to Stripe. A signed-in buyer's email is prefilled; a partner
   reference from ?ref= (or the Phase 2 cookie) rides along in metadata. */
pub.get('/buy/:slug', async (req, res) => {
  const p = commerce.productBySlug(req.params.slug);
  if (!p || !p.on_sale || p.kind === 'seat') return res.status(404).render('error', { title: 'Not for sale', message: 'This product is not available for purchase online. See aininjas.com for current courses, or write to info@aininjas.com.' });
  if (!commerce.configured()) return res.status(503).render('error', { title: 'Checkout not available', message: 'Online purchase is not open yet. Write to info@aininjas.com and we will enrol you.' });
  try {
    const partnerRef = String(req.query.ref || (req.cookies && req.cookies.partner_ref) || '').slice(0, 40) || null;
    const session = await commerce.createCheckout({ product: p, user: req.user && req.user.status === 'approved' ? req.user : null, partnerRef });
    q.logEvent.run(req.user ? req.user.id : null, null, null, 'checkout_started', JSON.stringify({ product: p.slug, session: session.id }));
    res.redirect(303, session.url);
  } catch (e) {
    console.error('[buy]', e.message);
    res.status(500).render('error', { title: 'Could not start checkout', message: 'Something went wrong starting the payment. Please try again in a minute, or write to info@aininjas.com. (' + e.message + ')' });
  }
});
pub.get('/buy/:slug/cancelled', (req, res) => {
  const p = commerce.productBySlug(req.params.slug);
  res.render('buy-cancelled', { title: 'Payment cancelled', product: p, mainSite: process.env.MAIN_SITE_URL || 'https://www.aininjas.com' });
});

/* After payment. The webhook usually lands before the buyer does; if not, we confirm the session with Stripe here. */
pub.get('/welcome', async (req, res) => {
  const sid = String(req.query.session_id || '');
  let order = sid ? commerce.orderBySession(sid) : null;
  let state = 'unknown';
  try {
    if (order && order.status !== 'paid' && commerce.configured()) {
      const st = commerce.stripe();
      const s = await st.checkout.sessions.retrieve(sid);
      if (s.payment_status === 'paid' || (s.mode === 'subscription' && s.status === 'complete')) {
        let subscription = s.subscription || null;
        if (typeof subscription === 'string') subscription = await st.subscriptions.retrieve(subscription);
        await commerce.fulfil(order, { session: s, subscription, customerId: typeof s.customer === 'string' ? s.customer : null, paymentIntent: typeof s.payment_intent === 'string' ? s.payment_intent : null, invoice: s.invoice ? { id: typeof s.invoice === 'string' ? s.invoice : s.invoice.id } : null });
        order = commerce.orderBySession(sid);
      }
    }
  } catch (e) { console.warn('[welcome] could not confirm session: ' + e.message); }
  if (order && order.status === 'paid') state = 'paid';
  else if (order) state = 'pending';
  const product = order ? commerce.productById(order.product_id) : null;
  const buyer = order && order.user_id ? q.userById.get(order.user_id) : null;
  const newAccount = buyer && !buyer.last_login_at;
  res.render('welcome', { title: 'Welcome to AI Ninjas', state, order, product, buyer, newAccount, signedIn: !!(req.user && buyer && req.user.id === buyer.id), accountsBase: onesite.accounts.configured ? (onesite.accounts.on ? onesite.accounts.prefix : onesite.accounts.public) : null, ssoEnabled: !!process.env.SSO_SECRET && onesite.accounts.configured });
});

/* Stripe → us. Raw body is required for the signature check; mounted BEFORE any JSON/urlencoded parser. */
pub.get('/api/stripe/webhook', (req, res) => res.status(405).json({ ok: true, note: 'This endpoint accepts POST from Stripe only. Opening it in a browser is not a test; use "Send test event" in the Stripe dashboard.' }));
pub.post('/api/stripe/webhook', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  try {
    const result = await commerce.handleWebhook(req.body, req.headers['stripe-signature']);
    res.json({ received: true, result });
  } catch (e) {
    const status = e.status || (/signature|No signatures|timestamp/i.test(e.message) ? 400 : 500);
    console.error('[stripe webhook]', e.message);
    res.status(status).json({ error: e.message });
  }
});

/* ---------- admin ---------- */
const admin = express.Router();
admin.use(requireAdmin);

admin.get('/products', (req, res) => {
  const courses = db.prepare('SELECT id, title, slug, is_published, superseded_by FROM courses ORDER BY title').all();
  const products = commerce.listProducts().map(p => ({ ...p, courseTitles: commerce.coursesFor(p).map(id => (courses.find(c => c.id === id) || {}).title).filter(Boolean), display: commerce.formatMoney(p.amount_cents, p.currency) }));
  const edit = req.query.edit ? commerce.productById(req.query.edit) : null;
  res.render('admin/products', { title: 'Products', products, courses: courses.filter(c => !c.superseded_by), edit, stripe: { configured: commerce.configured(), test: commerce.testMode(), webhook: !!process.env.STRIPE_WEBHOOK_SECRET, tax: process.env.STRIPE_TAX === '1' }, catalogUrl: (process.env.BASE_URL || '') + '/api/catalog' });
});
admin.post('/products', async (req, res) => {
  try {
    const { product, warning } = await commerce.saveProduct({ ...req.body, course_ids: [].concat(req.body.course_ids || []), all_courses: req.body.all_courses === 'on', on_sale: req.body.on_sale === 'on' }, { by: req.user.id });
    flash(req, warning ? 'error' : 'success', `${product.name} saved${warning ? ' — ' + warning : ' and synced to Stripe.'}`);
  } catch (e) { flash(req, 'error', e.message); }
  res.redirect('/admin/products');
});
admin.post('/products/:id/toggle', async (req, res) => {
  const p = commerce.productById(req.params.id); if (!p) return res.sendStatus(404);
  db.prepare("UPDATE products SET on_sale=?, updated_at=datetime('now') WHERE id=?").run(p.on_sale ? 0 : 1, p.id);
  const w = await commerce.syncToStripe(commerce.productById(p.id), p);
  flash(req, w ? 'error' : 'success', `${p.name} is now ${p.on_sale ? 'off sale' : 'on sale'}.` + (w ? ' ' + w : ''));
  res.redirect('/admin/products');
});
admin.post('/products/:id/sync', async (req, res) => {
  const p = commerce.productById(req.params.id); if (!p) return res.sendStatus(404);
  const w = await commerce.syncToStripe(p, null);
  flash(req, w ? 'error' : 'success', w || `${p.name} synced to Stripe (price ${commerce.productById(p.id).stripe_price_id}).`);
  res.redirect('/admin/products');
});
admin.post('/products/import-stripe', async (req, res) => {
  try { const n = await commerce.importFromStripe(); flash(req, 'success', `${n} product price(s) updated from Stripe.`); }
  catch (e) { flash(req, 'error', e.message); }
  res.redirect('/admin/products');
});
admin.get('/orders', (req, res) => {
  const status = String(req.query.status || ''), text = String(req.query.q || '').trim();
  const orders = commerce.listOrders({ status: status || null, q: text || null }).map(o => ({ ...o, display: commerce.formatMoney(o.amount_cents, o.currency) }));
  const totals = db.prepare("SELECT status, COUNT(*) n, COALESCE(SUM(amount_cents),0) cents FROM orders GROUP BY status").all();
  res.render('admin/orders', { title: 'Orders', orders, totals, status, qtext: text, stripeDash: commerce.testMode() ? 'https://dashboard.stripe.com/test' : 'https://dashboard.stripe.com', money: commerce.formatMoney });
});
admin.post('/orders/:id/re-enrol', async (req, res) => {
  const o = commerce.orderById(req.params.id); if (!o) return res.sendStatus(404);
  try { const r = await commerce.fulfil(o, {}); flash(req, 'success', `Order ${o.id}: ${r.courses.length} course(s) re-granted to ${r.user.email}.`); }
  catch (e) { flash(req, 'error', e.message); }
  res.redirect('/admin/orders');
});

module.exports = { publicRouter: pub, adminRouter: admin };
