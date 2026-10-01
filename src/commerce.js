'use strict';
/* eCommerce (Phase 1): products, Stripe Checkout, orders, enrol-on-payment.

   Where things live
   - Stripe is the system of record for money: every product has a Stripe Product and a Stripe Price (amount,
     currency, one-time or yearly). Prices are immutable there, so a price change = a new Price + the old one archived.
   - The Academy is the system of record for what a product GRANTS: the `products` table maps a slug to course ids and
     carries the display copy. Admin → Products is the one place to edit; saving pushes to Stripe through the API.
   - `orders` records what was bought by whom (Stripe session/invoice ids, amount, status, buyer), `order_items` which
     courses it granted. Partner attribution (partner_id, attribution, attributed_at) is decided by src/partners.js
     when the order is paid; commissions live there too.
   - `stripe_events` makes the webhook idempotent: Stripe retries, we process each event id once.

   Buyer flow: www.aininjas.com (prices from /api/catalog) → GET /buy/<slug> → Stripe Checkout → webhook
   checkout.session.completed → order + buyer account (Accounts invitation if new) + enrolments → /welcome. */
const crypto = require('crypto');
const { db, q } = require('./db');
const enrol = require('./enrol');
const plugins = require('./plugins');

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const CURRENCY = (process.env.STRIPE_CURRENCY || 'usd').toLowerCase();
const TAX = process.env.STRIPE_TAX === '1';

/* ---------- schema ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT UNIQUE NOT NULL,            -- python-for-ai, belt-white, full-curriculum, school-seat
  name            TEXT NOT NULL,
  description     TEXT,
  kind            TEXT NOT NULL DEFAULT 'one_time', -- one_time | yearly | seat (seat = per seat per year, invoiced in Phase 4)
  audience        TEXT NOT NULL DEFAULT 'individual', -- individual | school
  amount_cents    INTEGER NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'usd',
  course_ids      TEXT NOT NULL DEFAULT '[]',      -- JSON list; empty + all_courses=1 means every published course
  all_courses     INTEGER NOT NULL DEFAULT 0,
  access_days     INTEGER,                         -- one_time products: NULL = no end; yearly: set by Stripe period
  on_sale         INTEGER NOT NULL DEFAULT 1,
  sort            INTEGER NOT NULL DEFAULT 100,
  stripe_product_id TEXT,
  stripe_price_id TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id      INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_slug    TEXT,
  user_id         INTEGER,                         -- buyer's Academy user (NULL until the account exists)
  buyer_email     TEXT,
  buyer_name      TEXT,
  school_slug     TEXT,
  kind            TEXT NOT NULL DEFAULT 'one_time',
  amount_cents    INTEGER NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'usd',
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | paid | refunded | lapsed
  stripe_session_id TEXT UNIQUE,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  stripe_invoice_id TEXT UNIQUE,
  stripe_payment_intent TEXT,
  partner_id      INTEGER,                         -- Phase 2
  attribution     TEXT,                            -- deal | code | link | none (Phase 2)
  metadata        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at         TEXT,
  refunded_at     TEXT,
  lapsed_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(buyer_email);
CREATE TABLE IF NOT EXISTS order_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id        INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  course_id       INTEGER NOT NULL,
  enrollment_id   INTEGER
);
CREATE TABLE IF NOT EXISTS stripe_events (
  id              TEXT PRIMARY KEY,                -- evt_…
  type            TEXT NOT NULL,
  received_at     TEXT NOT NULL DEFAULT (datetime('now')),
  result          TEXT
);
`);
// enrollments gain a pointer to the order that granted them (additive, safe on old volumes)
const ecols = db.prepare('PRAGMA table_info(enrollments)').all().map(c => c.name);
if (!ecols.includes('order_id')) db.exec('ALTER TABLE enrollments ADD COLUMN order_id INTEGER');
const ucols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
if (!ucols.includes('partner_id')) db.exec('ALTER TABLE users ADD COLUMN partner_id INTEGER');        // Phase 2
if (!ucols.includes('attributed_at')) db.exec('ALTER TABLE users ADD COLUMN attributed_at TEXT');     // Phase 2
if (!ucols.includes('stripe_customer_id')) db.exec('ALTER TABLE users ADD COLUMN stripe_customer_id TEXT');
const partners = require('./partners');   // Phase 2: attribution + commissions (needs the orders table above)

/* ---------- Stripe client (lazy: the app runs without keys, checkout just says "not available") ---------- */
let _stripe = null;
function stripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  const opts = { apiVersion: process.env.STRIPE_API_VERSION || undefined, maxNetworkRetries: 2 };
  if (process.env.STRIPE_API_BASE) { const u = new URL(process.env.STRIPE_API_BASE); Object.assign(opts, { host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), protocol: u.protocol.replace(':', '') }); }   // tests: a local fake
  _stripe = require('stripe')(key, opts);
  return _stripe;
}
partners.setStripe(stripe);
const configured = () => !!process.env.STRIPE_SECRET_KEY;
const testMode = () => /^sk_test_|^rk_test_/.test(process.env.STRIPE_SECRET_KEY || '');

/* ---------- products ---------- */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,59}$/;
function shape(p) {
  if (!p) return null;
  let ids = []; try { ids = JSON.parse(p.course_ids || '[]'); } catch {}
  return { ...p, course_ids: ids.map(Number).filter(Boolean), all_courses: !!p.all_courses, on_sale: !!p.on_sale };
}
const listProducts = ({ onSale } = {}) => db.prepare(`SELECT * FROM products ${onSale ? 'WHERE on_sale=1' : ''} ORDER BY sort, id`).all().map(shape);
const productBySlug = slug => shape(db.prepare('SELECT * FROM products WHERE slug=?').get(String(slug || '').toLowerCase()));
const productById = id => shape(db.prepare('SELECT * FROM products WHERE id=?').get(id));

/** Course ids a product grants right now (all published courses for curriculum products). */
function coursesFor(p) {
  if (p.all_courses) return db.prepare('SELECT id FROM courses WHERE is_published=1 AND superseded_by IS NULL ORDER BY id').all().map(r => r.id);
  return p.course_ids;
}

/** Create or update a product here and mirror it to Stripe (product + price; a changed amount archives the old price). */
async function saveProduct(input, { by } = {}) {
  const slug = String(input.slug || '').trim().toLowerCase();
  if (!SLUG_RE.test(slug)) throw new Error('Slug: 2–60 lowercase letters, digits or dashes (e.g. python-for-ai)');
  const name = String(input.name || '').trim(); if (!name) throw new Error('Name is required');
  const kind = ['one_time', 'yearly', 'seat'].includes(input.kind) ? input.kind : 'one_time';
  const audience = kind === 'seat' ? 'school' : (input.audience === 'school' ? 'school' : 'individual');
  const amount = Math.round(Number(String(input.amount || '0').replace(/[^0-9.]/g, '')) * 100);
  if (!(amount >= 0)) throw new Error('Amount must be a number');
  const allCourses = !!input.all_courses;
  const courseIds = allCourses ? [] : [].concat(input.course_ids || []).map(Number).filter(Boolean);
  if (!allCourses && kind !== 'seat' && !courseIds.length) throw new Error('Pick at least one course, or tick "every published course"');
  const accessDays = input.access_days ? Math.max(1, +input.access_days) : null;
  const existing = input.id ? productById(input.id) : productBySlug(slug);
  if (!existing && productBySlug(slug)) throw new Error('That slug is already used');
  const fields = { slug, name, description: String(input.description || '').trim() || null, kind, audience, amount_cents: amount, currency: CURRENCY, course_ids: JSON.stringify(courseIds), all_courses: allCourses ? 1 : 0, access_days: accessDays, on_sale: input.on_sale === undefined ? 1 : (input.on_sale ? 1 : 0), sort: Number(input.sort) || 100 };
  let id;
  if (existing) { db.prepare(`UPDATE products SET slug=@slug, name=@name, description=@description, kind=@kind, audience=@audience, amount_cents=@amount_cents, currency=@currency, course_ids=@course_ids, all_courses=@all_courses, access_days=@access_days, on_sale=@on_sale, sort=@sort, updated_at=datetime('now') WHERE id=@id`).run({ ...fields, id: existing.id }); id = existing.id; }
  else id = db.prepare(`INSERT INTO products (slug, name, description, kind, audience, amount_cents, currency, course_ids, all_courses, access_days, on_sale, sort) VALUES (@slug, @name, @description, @kind, @audience, @amount_cents, @currency, @course_ids, @all_courses, @access_days, @on_sale, @sort)`).run(fields).lastInsertRowid;
  q.logEvent.run(null, null, null, 'product_saved', JSON.stringify({ id, slug, by, amount_cents: amount, kind }));
  const warn = await syncToStripe(productById(id), existing);
  return { product: productById(id), warning: warn };
}

/** Mirror one product to Stripe. Returns a warning string when Stripe is not configured or refused. */
async function syncToStripe(p, previous) {
  const s = stripe();
  if (!s) return 'Stripe is not configured (STRIPE_SECRET_KEY) — saved here only; sync will happen when you press "Sync to Stripe" after keys are set.';
  if (p.kind === 'seat') return null;   // invoiced per seat in Phase 4, no Checkout price
  try {
    let productId = p.stripe_product_id;
    const pdata = { name: p.name, description: p.description || undefined, active: p.on_sale, metadata: { slug: p.slug, academy_product_id: String(p.id) } };
    if (productId) await s.products.update(productId, pdata);
    else { productId = (await s.products.create(pdata)).id; db.prepare('UPDATE products SET stripe_product_id=? WHERE id=?').run(productId, p.id); }
    const priceChanged = !p.stripe_price_id || !previous || previous.amount_cents !== p.amount_cents || previous.kind !== p.kind || previous.currency !== p.currency;
    if (priceChanged) {
      const price = await s.prices.create({ product: productId, unit_amount: p.amount_cents, currency: p.currency, ...(p.kind === 'yearly' ? { recurring: { interval: 'year' } } : {}), metadata: { slug: p.slug } });
      if (p.stripe_price_id) { try { await s.prices.update(p.stripe_price_id, { active: false }); } catch {} }
      db.prepare('UPDATE products SET stripe_price_id=? WHERE id=?').run(price.id, p.id);
    }
    return null;
  } catch (e) { return 'Stripe refused: ' + e.message; }
}

/** Pull prices back from Stripe (if someone edited them in the dashboard). Returns the number updated. */
async function importFromStripe() {
  const s = stripe(); if (!s) throw new Error('Stripe is not configured');
  let n = 0;
  for (const p of listProducts()) {
    if (!p.stripe_product_id) continue;
    const prices = await s.prices.list({ product: p.stripe_product_id, active: true, limit: 10 });
    const match = prices.data.find(pr => (p.kind === 'yearly') === !!pr.recurring) || prices.data[0];
    if (match && (match.id !== p.stripe_price_id || match.unit_amount !== p.amount_cents)) {
      db.prepare("UPDATE products SET stripe_price_id=?, amount_cents=?, currency=?, updated_at=datetime('now') WHERE id=?").run(match.id, match.unit_amount, match.currency, p.id);
      n++;
    }
  }
  return n;
}

/** What www.aininjas.com shows: on-sale individual products with prices. Public. */
function catalog() {
  const courses = Object.fromEntries(db.prepare('SELECT id, title, slug FROM courses').all().map(c => [c.id, c]));
  return {
    currency: CURRENCY, test_mode: testMode(), checkout_available: configured(),
    products: listProducts({ onSale: true }).filter(p => p.kind !== 'seat').map(p => ({
      slug: p.slug, name: p.name, description: p.description, kind: p.kind, audience: p.audience,
      amount: p.amount_cents / 100, amount_cents: p.amount_cents, currency: p.currency,
      display_price: formatMoney(p.amount_cents, p.currency) + (p.kind === 'yearly' ? ' / year' : ''),
      courses: coursesFor(p).map(id => courses[id] ? { title: courses[id].title, slug: courses[id].slug } : null).filter(Boolean),
      buy_url: `${BASE_URL}/buy/${p.slug}`,
    })),
  };
}
function formatMoney(cents, currency) {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: (currency || 'usd').toUpperCase(), minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100); }
  catch { return (cents / 100).toFixed(2) + ' ' + String(currency || '').toUpperCase(); }
}

/* ---------- checkout ---------- */
/** Create a Stripe Checkout Session for a product. `user` = signed-in buyer (optional); `partnerRef` from the Phase 2 cookie. */
async function createCheckout({ product: p, user, partnerRef, promoCode }) {
  const s = stripe(); if (!s) throw new Error('Checkout is not available yet');
  if (!p.on_sale || p.kind === 'seat') throw new Error('This product is not for sale online');
  if (!p.stripe_price_id) { const w = await syncToStripe(p, null); if (w) throw new Error(w); p = productById(p.id); }
  const nonce = crypto.randomBytes(8).toString('hex');
  const session = await s.checkout.sessions.create({
    mode: p.kind === 'yearly' ? 'subscription' : 'payment',
    line_items: [{ price: p.stripe_price_id, quantity: 1 }],
    success_url: `${BASE_URL}/welcome?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${BASE_URL}/buy/${p.slug}/cancelled`,
    allow_promotion_codes: true,
    ...(promoCode ? { discounts: [{ promotion_code: promoCode }] } : {}),
    ...(user ? (user.stripe_customer_id ? { customer: user.stripe_customer_id } : { customer_email: user.email }) : {}),
    ...(TAX ? { automatic_tax: { enabled: true } } : {}),
    customer_creation: p.kind === 'yearly' ? undefined : 'always',
    metadata: { product_slug: p.slug, product_id: String(p.id), academy_user_id: user ? String(user.id) : '', partner_ref: partnerRef || '', nonce },
    ...(p.kind === 'yearly' ? { subscription_data: { metadata: { product_slug: p.slug, product_id: String(p.id), academy_user_id: user ? String(user.id) : '', partner_ref: partnerRef || '' } } } : {}),
  });
  db.prepare(`INSERT INTO orders (product_id, product_slug, user_id, buyer_email, kind, amount_cents, currency, status, stripe_session_id, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
    .run(p.id, p.slug, user ? user.id : null, user ? user.email : null, p.kind, p.amount_cents, p.currency, session.id, JSON.stringify({ partner_ref: partnerRef || null }));
  return session;
}

/* ---------- fulfilment ---------- */
let accountsApi = null;   // set by server.js: (path, opts) => sso.api(...)
function setAccountsApi(fn) { accountsApi = fn; }

/** The Academy user for a buyer: by id from metadata, else by email, else created through Accounts (which syncs the
    grant back here and emails the invitation) or locally when SSO is off. */
async function buyerUser({ academyUserId, email, name }) {
  email = String(email || '').toLowerCase();
  let u = academyUserId ? q.userById.get(+academyUserId) : null;
  if (!u && email) u = q.userByEmail.get(email);
  if (u) return { user: u, created: false };
  if (!email) throw new Error('No buyer email on the Stripe session');
  if (accountsApi) {
    const r = await accountsApi('/grants', { method: 'POST', body: { email, name: name || email.split('@')[0], role: 'individual', invited_by: 'AI Ninjas (your purchase)' } });
    // Accounts syncs the grant to us at once (creates the user); poll briefly in case the sync lands a moment later
    for (let i = 0; i < 10; i++) { u = q.userByEmail.get(email); if (u) break; await new Promise(res => setTimeout(res, 300)); }
    if (!u) u = require('./auth').upsertFromSso({ sub: r.user.id, email, name: name || email, role: 'individual', scope: {} });
    return { user: u, created: true, invite: r.inviteLink || null, mail: r.mail || null };
  }
  const info = db.prepare(`INSERT INTO users (email, name, role, status, approved_at, display_handle, organization) VALUES (?, ?, 'learner', 'approved', datetime('now'), ?, 'Individual')`).run(email, name || email, 'Ninja' + crypto.randomInt(1000, 9999));
  return { user: q.userById.get(info.lastInsertRowid), created: true };
}

/** Mark an order paid and enrol the buyer in the product's courses. Idempotent per order. */
async function fulfil(order, { session, invoice, subscription, customerId, paymentIntent, renewalOf } = {}) {
  const p = productById(order.product_id) || productBySlug(order.product_slug);
  if (!p) throw new Error('Order ' + order.id + ' has no product');
  const email = (session && (session.customer_details && session.customer_details.email || session.customer_email)) || order.buyer_email;
  const name = session && session.customer_details && session.customer_details.name || order.buyer_name || null;
  const meta = (session && session.metadata) || {};
  const { user, created, invite } = await buyerUser({ academyUserId: meta.academy_user_id || order.user_id, email, name });
  if (customerId && !user.stripe_customer_id) db.prepare('UPDATE users SET stripe_customer_id=? WHERE id=?').run(customerId, user.id);
  const endsOn = p.kind === 'yearly' && subscription && subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString().slice(0, 10)
    : (p.kind === 'one_time' && p.access_days ? new Date(Date.now() + p.access_days * 86400000).toISOString().slice(0, 10) : null);
  const courses = coursesFor(p);
  db.transaction(() => {
    db.prepare(`UPDATE orders SET status='paid', paid_at=COALESCE(paid_at, datetime('now')), user_id=?, buyer_email=?, buyer_name=COALESCE(?, buyer_name), stripe_customer_id=COALESCE(?, stripe_customer_id), stripe_subscription_id=COALESCE(?, stripe_subscription_id), stripe_invoice_id=COALESCE(?, stripe_invoice_id), stripe_payment_intent=COALESCE(?, stripe_payment_intent), amount_cents=COALESCE(?, amount_cents) WHERE id=?`)
      .run(user.id, email, name, customerId || null, subscription ? subscription.id : null, invoice ? invoice.id : null, paymentIntent || null, session && session.amount_total != null ? session.amount_total : null, order.id);
    for (const courseId of courses) {
      const result = enrol.enrolOne({ userId: user.id, courseId, startsOn: null, endsOn, source: 'purchase', by: 'stripe' });
      const enr = q.enrollment.get(user.id, courseId);
      // a renewal (or a second purchase) extends the end date and re-points the enrolment at the newest order
      if (enr) db.prepare('UPDATE enrollments SET order_id=?, ends_on=CASE WHEN ? IS NULL THEN ends_on ELSE ? END WHERE id=?').run(order.id, endsOn, endsOn, enr.id);
      if (!db.prepare('SELECT 1 FROM order_items WHERE order_id=? AND course_id=?').get(order.id, courseId)) db.prepare('INSERT INTO order_items (order_id, course_id, enrollment_id) VALUES (?, ?, ?)').run(order.id, courseId, enr ? enr.id : null);
      q.logEvent.run(user.id, courseId, null, 'purchase_enrol', JSON.stringify({ order_id: order.id, result }));
    }
  })();
  // Phase 2: who gets credit (locked once per order), then the commission row
  let attribution = null, commission = null;
  try {
    if (renewalOf) { if (!order.attributed_at) db.prepare("UPDATE orders SET attributed_at=datetime('now') WHERE id=?").run(order.id); attribution = { source: 'renewal', partner: order.partner_id ? partners.partnerById(order.partner_id) : null }; }
    else attribution = partners.attribute(order, { session, buyerEmail: email, user });
    commission = partners.bookCommission(order, { renewalOf });
  } catch (e) { console.error('[partners] attribution failed for order ' + order.id + ': ' + e.message); }
  plugins.emit('order:paid', { orderId: order.id, userId: user.id, productSlug: p.slug, courseIds: courses, created, partnerId: attribution && attribution.partner ? attribution.partner.id : null });
  return { user, created, invite, courses, attribution, commission };
}

/** Refund or lapse: enrolments granted by the order end (progress kept); order status updated. */
function revoke(order, status, reason) {
  const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(order.id);
  db.transaction(() => {
    for (const it of items) {
      const enr = it.enrollment_id ? db.prepare('SELECT * FROM enrollments WHERE id=?').get(it.enrollment_id) : (order.user_id ? q.enrollment.get(order.user_id, it.course_id) : null);
      if (enr && enr.status === 'active' && enr.order_id === order.id) enrol.endOne(enr.id, 'stripe', reason);
    }
    db.prepare(`UPDATE orders SET status=?, ${status === 'refunded' ? 'refunded_at' : 'lapsed_at'}=datetime('now') WHERE id=?`).run(status, order.id);
  })();
  if (status === 'refunded') { try { partners.clawback(order, reason); } catch (e) { console.error('[partners] clawback failed: ' + e.message); } }
  plugins.emit('order:' + status, { orderId: order.id, userId: order.user_id, reason });
}

/* ---------- webhook ---------- */
const orderBySession = id => db.prepare('SELECT * FROM orders WHERE stripe_session_id=?').get(id);
const orderBySubscription = id => db.prepare('SELECT * FROM orders WHERE stripe_subscription_id=? ORDER BY id DESC').get(id);
const orderByInvoice = id => db.prepare('SELECT * FROM orders WHERE stripe_invoice_id=?').get(id);
const orderByPaymentIntent = id => db.prepare('SELECT * FROM orders WHERE stripe_payment_intent=?').get(id);

/** Verify and process one Stripe event. Returns a short result string (also stored in stripe_events). */
async function handleWebhook(rawBody, signature) {
  const s = stripe(); if (!s) throw Object.assign(new Error('Stripe not configured'), { status: 503 });
  const secret = process.env.STRIPE_WEBHOOK_SECRET; if (!secret) throw Object.assign(new Error('STRIPE_WEBHOOK_SECRET not set'), { status: 503 });
  const event = s.webhooks.constructEvent(rawBody, signature, secret);
  const seen = db.prepare('SELECT result FROM stripe_events WHERE id=?').get(event.id);
  if (seen) return 'duplicate: ' + seen.result;
  db.prepare('INSERT INTO stripe_events (id, type, result) VALUES (?, ?, ?)').run(event.id, event.type, 'processing');
  let result;
  try { result = await processEvent(event, s); }
  catch (e) { db.prepare('DELETE FROM stripe_events WHERE id=?').run(event.id); throw e; }   // let Stripe retry
  db.prepare('UPDATE stripe_events SET result=? WHERE id=?').run(result, event.id);
  return result;
}

async function processEvent(event, s) {
  const obj = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed': {
      if (obj.payment_status !== 'paid' && obj.mode !== 'subscription') return 'ignored: unpaid session';
      let order = orderBySession(obj.id);
      if (!order) {   // a session we did not create (e.g. a Payment Link): make the order from metadata
        const p = productBySlug(obj.metadata && obj.metadata.product_slug); if (!p) return 'ignored: no product in metadata';
        const id = db.prepare(`INSERT INTO orders (product_id, product_slug, kind, amount_cents, currency, status, stripe_session_id, metadata) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`).run(p.id, p.slug, p.kind, obj.amount_total || p.amount_cents, p.currency, obj.id, JSON.stringify({ partner_ref: obj.metadata.partner_ref || obj.client_reference_id || null })).lastInsertRowid;
        order = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
      }
      if (order.status === 'paid') return 'already fulfilled';
      const subscription = obj.subscription ? await s.subscriptions.retrieve(typeof obj.subscription === 'string' ? obj.subscription : obj.subscription.id) : null;
      const r = await fulfil(order, { session: obj, subscription, customerId: typeof obj.customer === 'string' ? obj.customer : (obj.customer && obj.customer.id), paymentIntent: typeof obj.payment_intent === 'string' ? obj.payment_intent : null, invoice: obj.invoice ? { id: typeof obj.invoice === 'string' ? obj.invoice : obj.invoice.id } : null });
      return `fulfilled order ${order.id}: user ${r.user.id}${r.created ? ' (new account)' : ''}, ${r.courses.length} course(s)` + (r.attribution ? `, ${r.attribution.source}${r.attribution.partner ? ' ' + r.attribution.partner.code : ''}` : '');
    }
    case 'invoice.paid': {
      // renewals of a yearly subscription (the first invoice is handled by checkout.session.completed)
      const subId = typeof obj.subscription === 'string' ? obj.subscription : (obj.subscription && obj.subscription.id);
      if (!subId) return 'ignored: invoice without subscription';
      if (orderByInvoice(obj.id)) return 'already recorded';
      const prev = orderBySubscription(subId);
      if (!prev) return 'ignored: unknown subscription (first invoice arrives via checkout.session.completed)';
      if (prev.stripe_invoice_id === null) { db.prepare('UPDATE orders SET stripe_invoice_id=? WHERE id=?').run(obj.id, prev.id); return 'first invoice linked to order ' + prev.id; }
      const subscription = await s.subscriptions.retrieve(subId);
      const id = db.prepare(`INSERT INTO orders (product_id, product_slug, user_id, buyer_email, kind, amount_cents, currency, status, stripe_customer_id, stripe_subscription_id, stripe_invoice_id, partner_id, attribution, metadata) VALUES (?, ?, ?, ?, 'yearly', ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`)
        .run(prev.product_id, prev.product_slug, prev.user_id, prev.buyer_email, obj.amount_paid || prev.amount_cents, obj.currency || prev.currency, prev.stripe_customer_id, subId, obj.id, prev.partner_id, prev.partner_id ? 'renewal' : 'house', JSON.stringify({ renewal_of: prev.id })).lastInsertRowid;
      const order = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
      const r = await fulfil(order, { subscription, invoice: obj, customerId: prev.stripe_customer_id, renewalOf: prev.id });
      return `renewal order ${order.id}: user ${r.user.id}, access to ${subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString().slice(0, 10) : '?'}`;
    }
    case 'customer.subscription.deleted': {
      const order = orderBySubscription(obj.id); if (!order) return 'ignored: unknown subscription';
      if (order.status === 'paid') revoke(order, 'lapsed', 'subscription ended');
      return 'lapsed order ' + order.id;
    }
    case 'invoice.payment_failed': {
      const subId = typeof obj.subscription === 'string' ? obj.subscription : (obj.subscription && obj.subscription.id);
      const order = subId ? orderBySubscription(subId) : null;
      q.logEvent.run(order ? order.user_id : null, null, null, 'payment_failed', JSON.stringify({ order_id: order ? order.id : null, invoice: obj.id, attempt: obj.attempt_count }));
      return 'noted payment failure' + (order ? ' for order ' + order.id : '');   // access ends when Stripe cancels the subscription
    }
    case 'charge.refunded': {
      const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : (obj.payment_intent && obj.payment_intent.id);
      const order = pi ? orderByPaymentIntent(pi) : null; if (!order) return 'ignored: unknown charge';
      if (obj.amount_refunded >= obj.amount && order.status === 'paid') { revoke(order, 'refunded', 'refunded'); return 'refunded order ' + order.id; }
      q.logEvent.run(order.user_id, null, null, 'partial_refund', JSON.stringify({ order_id: order.id, amount_refunded: obj.amount_refunded }));
      return 'partial refund noted for order ' + order.id;
    }
    default: return 'ignored: ' + event.type;
  }
}

/* ---------- admin helpers ---------- */
function listOrders({ status, q: text, partnerId, limit = 200 } = {}) {
  const where = [], args = [];
  if (partnerId) { where.push('o.partner_id=?'); args.push(partnerId); }
  if (status) { where.push('o.status=?'); args.push(status); }
  if (text) { where.push('(o.buyer_email LIKE ? OR o.buyer_name LIKE ? OR o.product_slug LIKE ? OR o.stripe_session_id LIKE ?)'); args.push(`%${text}%`, `%${text}%`, `%${text}%`, `%${text}%`); }
  return db.prepare(`SELECT o.*, p.name AS product_name, u.name AS user_name, pa.name AS partner_name, pa.code AS partner_code FROM orders o LEFT JOIN products p ON p.id=o.product_id LEFT JOIN users u ON u.id=o.user_id LEFT JOIN partners pa ON pa.id=o.partner_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.id DESC LIMIT ?`).all(...args, limit);
}
const orderById = id => db.prepare('SELECT * FROM orders WHERE id=?').get(id);

module.exports = { configured, testMode, stripe, listProducts, productBySlug, productById, coursesFor, saveProduct, syncToStripe, importFromStripe, catalog, formatMoney, createCheckout, fulfil, revoke, handleWebhook, listOrders, orderById, orderBySession, setAccountsApi };
