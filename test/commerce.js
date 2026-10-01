/* eCommerce end-to-end against a fake Stripe (test/fake-stripe.js): products → catalog → buy → webhook → enrol,
   replay, bad signature, refund, yearly subscription, renewal, lapse. Run: node test/commerce.js */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const assert = require('assert');
const Stripe = require('stripe');
const PORT = 3998, BASE = `http://localhost:${PORT}`, FAKE = 4243, WHSEC = 'whsec_test_commerce';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-commerce-'));
const fake = require('./fake-stripe'); fake.listen(FAKE);
const server = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT, BASE_URL: BASE, DATA_DIR: dataDir, ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'admin12345', GOOGLE_CLIENT_ID: '', ACCOUNTS_URL: '', SSO_SECRET: '', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_API_BASE: `http://localhost:${FAKE}`, STRIPE_WEBHOOK_SECRET: WHSEC } });
let passed = 0, failed = 0;
const ok = (name, cond) => { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cookies = {}; function jar(res) { const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean); for (const c of sc) { const [kv] = c.split(';'); const [k, v] = kv.split('='); cookies[k] = v; } }
const cookieHeader = () => Object.entries(cookies).map(([k, v]) => k + '=' + v).join('; ');
async function call(p, opts = {}) { const r = await fetch(BASE + p, { redirect: 'manual', ...opts, headers: { cookie: cookieHeader(), ...(opts.headers || {}) } }); jar(r); return r; }
const form = o => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });
const stripe = Stripe('sk_test_x');
async function hook(evt) { const payload = JSON.stringify(evt); const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC }); const r = await call('/api/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: payload }); return { status: r.status, body: await r.json().catch(() => ({})) }; }
const Database = require('better-sqlite3');
(async () => {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {} await sleep(200); }
  const db = new Database(path.join(dataDir, 'lms.sqlite'));
  db.prepare("INSERT INTO courses (slug,title,manifest_json) VALUES ('c1','Course One','{}'),('c2','Course Two','{}')").run();
  await call('/login', form({ email: 'admin@test.local', password: 'admin12345' }));
  console.log('products');
  let r = await call('/admin/products', form({ name: 'Course One', slug: 'course-one', kind: 'one_time', audience: 'individual', amount: '49', course_ids: '1', on_sale: 'on' }));
  ok('create one-time product redirects', r.status === 302);
  await call('/admin/products', form({ name: 'Everything', slug: 'everything', kind: 'yearly', audience: 'individual', amount: '299', all_courses: 'on', on_sale: 'on' }));
  const cat = await (await call('/api/catalog')).json();
  ok('catalog lists both products with prices', cat.products.length === 2 && cat.products[0].display_price === '$49' && cat.products[1].display_price === '$299 / year');
  ok('catalog reports checkout available in test mode', cat.checkout_available && cat.test_mode);
  await call('/admin/products', form({ id: '1', name: 'Course One', slug: 'course-one', kind: 'one_time', audience: 'individual', amount: '59', course_ids: '1', on_sale: 'on' }));
  const prices = (await (await fetch(`http://localhost:${FAKE}/__dump`)).json()).prices;
  ok('price change creates a new Stripe price and archives the old', Object.values(prices).filter(p => p.product === db.prepare('SELECT stripe_product_id FROM products WHERE id=1').get().stripe_product_id).map(p => p.active).join() === 'false,true');

  console.log('one-time purchase by a new buyer');
  r = await fetch(BASE + '/buy/course-one?ref=ahmed', { redirect: 'manual' });
  ok('buy redirects to Stripe checkout', r.status === 303 && /checkout\.stripe/.test(r.headers.get('location')));
  const sid = db.prepare('SELECT stripe_session_id s FROM orders ORDER BY id DESC').get().s;
  const sess = await (await fetch(`http://localhost:${FAKE}/__pay/${sid}?email=parent@test.local`)).json();
  let h = await hook({ id: 'evt_1', type: 'checkout.session.completed', data: { object: sess } });
  ok('webhook fulfils the order', h.status === 200 && /fulfilled order 1/.test(h.body.result));
  const buyer = db.prepare("SELECT * FROM users WHERE email='parent@test.local'").get();
  ok('buyer account created and approved', buyer && buyer.status === 'approved' && buyer.role === 'learner');
  ok('buyer enrolled in the course, tagged to the order', db.prepare("SELECT status, order_id, source FROM enrollments WHERE user_id=?").get(buyer.id).status === 'active' && db.prepare("SELECT order_id FROM enrollments WHERE user_id=?").get(buyer.id).order_id === 1);
  ok('partner ref kept on the order for Phase 2', JSON.parse(db.prepare('SELECT metadata FROM orders WHERE id=1').get().metadata).partner_ref === 'ahmed');
  h = await hook({ id: 'evt_1', type: 'checkout.session.completed', data: { object: sess } });
  ok('replayed event is a duplicate, not a second enrolment', /duplicate/.test(h.body.result) && db.prepare('SELECT COUNT(*) n FROM enrollments WHERE user_id=?').get(buyer.id).n === 1);
  r = await call('/api/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=bad' }, body: '{}' });
  ok('bad signature is rejected with 400', r.status === 400);
  const html = await (await fetch(BASE + '/welcome?session_id=' + sid)).text();
  ok('welcome page says the course is unlocked and the account is new', /Welcome to AI Ninjas/.test(html) && /set your password/.test(html));
  h = await hook({ id: 'evt_2', type: 'charge.refunded', data: { object: { id: 'ch_1', payment_intent: db.prepare('SELECT stripe_payment_intent p FROM orders WHERE id=1').get().p, amount: 5900, amount_refunded: 5900 } } });
  ok('full refund ends the enrolment and marks the order refunded', /refunded order 1/.test(h.body.result) && db.prepare('SELECT status FROM orders WHERE id=1').get().status === 'refunded' && db.prepare('SELECT status FROM enrollments WHERE user_id=?').get(buyer.id).status === 'ended');

  console.log('yearly subscription');
  r = await fetch(BASE + '/buy/everything', { redirect: 'manual' });
  const sid2 = db.prepare('SELECT stripe_session_id s FROM orders ORDER BY id DESC').get().s;
  const sess2 = await (await fetch(`http://localhost:${FAKE}/__pay/${sid2}?email=parent2@test.local`)).json();
  h = await hook({ id: 'evt_3', type: 'checkout.session.completed', data: { object: sess2 } });
  const b2 = db.prepare("SELECT id FROM users WHERE email='parent2@test.local'").get();
  const enr = db.prepare('SELECT course_id, status, ends_on FROM enrollments WHERE user_id=? ORDER BY course_id').all(b2.id);
  ok('subscription enrols every course with an end date a year out', enr.length === 2 && enr.every(e => e.status === 'active' && /^\d{4}-\d\d-\d\d$/.test(e.ends_on)));
  const sub = db.prepare('SELECT stripe_subscription_id s FROM orders WHERE stripe_session_id=?').get(sid2).s;
  ok('subscription id recorded on the order', !!sub);
  h = await hook({ id: 'evt_4', type: 'invoice.paid', data: { object: { id: 'in_renew', subscription: sub, amount_paid: 29900, currency: 'usd' } } });
  ok('renewal creates a second paid order', /renewal order/.test(h.body.result) && db.prepare('SELECT COUNT(*) n FROM orders WHERE stripe_subscription_id=? AND status=?').get(sub, 'paid').n === 2);
  h = await hook({ id: 'evt_5', type: 'customer.subscription.deleted', data: { object: { id: sub } } });
  ok('cancelled subscription lapses the latest order and ends access', /lapsed/.test(h.body.result) && db.prepare('SELECT COUNT(*) n FROM enrollments WHERE user_id=? AND status=?').get(b2.id, 'ended').n === 2);
  const orders = await (await call('/admin/orders')).text();
  ok('admin orders page lists the orders', /parent2@test.local/.test(orders) && /lapsed/.test(orders));
  const notSale = await (await fetch(BASE + '/buy/nope')).text();
  ok('unknown product is not for sale', /Not for sale/.test(notSale));
  console.log(`\n${passed} passed, ${failed} failed`);
  server.kill(); fake.close(); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); server.kill(); fake.close(); process.exit(1); });
