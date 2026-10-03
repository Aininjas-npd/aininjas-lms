/* Partner tracking end-to-end against the fake Stripe: partners + coupon codes, /p/<CODE> links, attribution by
   deal > code > link > house, commissions (first, renewal, refund clawback), paused partners, admin pages, CSV.
   Run: node test/partners.js */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const Stripe = require('stripe');
const PORT = 3997, BASE = `http://localhost:${PORT}`, FAKE = 4244, WHSEC = 'whsec_test_partners';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-partners-'));
const fake = require('./fake-stripe'); fake.listen(FAKE);
const server = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT, BASE_URL: BASE, DATA_DIR: dataDir, ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'admin12345', GOOGLE_CLIENT_ID: '', ACCOUNTS_URL: '', SSO_SECRET: '', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_API_BASE: `http://localhost:${FAKE}`, STRIPE_WEBHOOK_SECRET: WHSEC, MAIN_SITE_URL: 'https://www.example.test' } });
if (process.env.DEBUG) server.stderr.on('data', d => process.stderr.write(d));
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
let evt = 0;
/** Buy as an anonymous visitor (own cookie jar), pay at the fake, deliver the webhook. Returns the order row. */
async function purchase(db, slug, { ref, cookie, email, promo } = {}) {
  const headers = {}; if (cookie) headers.cookie = 'partner_ref=' + cookie;
  const r = await fetch(BASE + `/buy/${slug}${ref ? '?ref=' + ref : ''}`, { redirect: 'manual', headers });
  if (r.status !== 303) throw new Error('buy failed ' + r.status);
  const sid = db.prepare('SELECT stripe_session_id s FROM orders ORDER BY id DESC').get().s;
  const sess = await (await fetch(`http://localhost:${FAKE}/__pay/${sid}?email=${encodeURIComponent(email)}${promo ? '&promo=' + promo : ''}`)).json();
  const h = await hook({ id: 'evt_p' + (++evt), type: 'checkout.session.completed', data: { object: sess } });
  if (h.status !== 200) throw new Error('webhook failed: ' + JSON.stringify(h.body));
  return { order: db.prepare('SELECT * FROM orders WHERE stripe_session_id=?').get(sid), result: h.body.result, session: sess };
}
(async () => {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {} await sleep(200); }
  const db = new Database(path.join(dataDir, 'lms.sqlite'));
  db.prepare("INSERT INTO courses (slug,title,manifest_json) VALUES ('c1','Course One','{}'),('c2','Course Two','{}')").run();
  await call('/login', form({ email: 'admin@test.local', password: 'admin12345' }));
  await call('/admin/products', form({ name: 'Course One', slug: 'course-one', kind: 'one_time', audience: 'individual', amount: '100', course_ids: '1', on_sale: 'on' }));
  await call('/admin/products', form({ name: 'Everything', slug: 'everything', kind: 'yearly', audience: 'individual', amount: '200', all_courses: 'on', on_sale: 'on' }));

  console.log('partners');
  let r = await call('/admin/partners', form({ name: 'Ahmed Khan', code: 'ahmed20', type: 'affiliate', email: 'ahmed@partner.test', discount_percent: '10' }));
  ok('create affiliate redirects to its page', r.status === 302 && /\/admin\/partners\/1$/.test(r.headers.get('location')));
  const ahmed = db.prepare("SELECT * FROM partners WHERE code='AHMED20'").get();
  ok('code upper-cased, default affiliate rates 20/10', ahmed && ahmed.rate_first === 20 && ahmed.rate_renewal === 10 && ahmed.discount_percent === 10);
  const dump = await (await fetch(`http://localhost:${FAKE}/__dump`)).json();
  ok('10% buyer discount became a Stripe coupon + promotion code AHMED20', Object.values(dump.promotion_codes).some(c => c.code === 'AHMED20' && c.active) && !!ahmed.stripe_promotion_code_id);
  r = await call('/admin/partners', form({ name: 'Bright Minds', code: 'BRIGHT', type: 'agent', rate_first: '', rate_renewal: '' }));
  const bright = db.prepare("SELECT * FROM partners WHERE code='BRIGHT'").get();
  ok('BD agent defaults 15/7.5, no coupon when discount is 0', bright.rate_first === 15 && bright.rate_renewal === 7.5 && !bright.stripe_promotion_code_id);
  r = await call('/admin/partners', form({ name: 'Dup', code: 'ahmed20', type: 'affiliate' }));
  ok('duplicate code is refused', r.status === 302 && db.prepare('SELECT COUNT(*) n FROM partners').get().n === 2);
  const page = await (await call('/admin/partners/1')).text();
  ok('partner page shows link and coupon', page.includes(BASE + '/p/AHMED20') && /AHMED20<\/code> = 10% off/.test(page));

  console.log('referral link');
  r = await fetch(BASE + '/p/ahmed20', { redirect: 'manual' });
  const setc = (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')]).join(';');
  ok('/p/<code> sets the partner cookie and forwards to the marketing site with ?ref', r.status === 302 && r.headers.get('location') === 'https://www.example.test/?ref=AHMED20' && /partner_ref=AHMED20/.test(setc) && /Max-Age=5184000/.test(setc));
  r = await fetch(BASE + '/p/AHMED20?to=course-one', { redirect: 'manual' });
  ok('?to=<product> goes straight to checkout', r.headers.get('location') === BASE + '/buy/course-one?ref=AHMED20');
  r = await fetch(BASE + '/p/NOPE', { redirect: 'manual' });
  ok('unknown code is a plain visit, no cookie', r.status === 302 && !r.headers.get('set-cookie') && r.headers.get('location') === 'https://www.example.test/');
  ok('clicks counted', db.prepare('SELECT clicks FROM partners WHERE id=1').get().clicks === 2);

  console.log('attribution');
  let p = await purchase(db, 'course-one', { cookie: 'AHMED20', email: 'link@buyer.test' });
  ok('cookie → link attribution to Ahmed', p.order.partner_id === 1 && p.order.attribution === 'link' && /link AHMED20/.test(p.result));
  let c = db.prepare('SELECT * FROM commissions WHERE order_id=?').get(p.order.id);
  ok('commission 20% of $100 = $20 pending, period = this month', c && c.kind === 'first' && c.amount_cents === 2000 && c.status === 'pending' && c.period === new Date().toISOString().slice(0, 7));
  ok('buyer remembers the originating partner', db.prepare("SELECT partner_id FROM users WHERE email='link@buyer.test'").get().partner_id === 1);
  p = await purchase(db, 'course-one', { email: 'code@buyer.test', promo: 'AHMED20' });
  ok('coupon typed at checkout → code attribution, commission on the discounted $90', p.order.attribution === 'code' && p.order.partner_id === 1 && p.order.amount_cents === 9000 && db.prepare('SELECT amount_cents a FROM commissions WHERE order_id=?').get(p.order.id).a === 1800);
  p = await purchase(db, 'course-one', { email: 'direct@buyer.test' });
  ok('direct buyer → house, no commission', p.order.attribution === 'house' && p.order.partner_id === null && !db.prepare('SELECT 1 FROM commissions WHERE order_id=?').get(p.order.id));
  r = await call('/admin/partners/2/deals', form({ match_kind: 'domain', match_value: 'greenfield.edu', label: 'Greenfield Academy' }));
  ok('deal registered for a domain', db.prepare("SELECT status FROM deal_registrations WHERE match_value='greenfield.edu'").get().status === 'registered');
  r = await call('/admin/partners/1/deals', form({ match_kind: 'domain', match_value: 'greenfield.edu' }));
  ok('second partner cannot register the same deal', db.prepare('SELECT COUNT(*) n FROM deal_registrations').get().n === 1);
  r = await call('/admin/partners/1/deals', form({ match_kind: 'domain', match_value: 'gmail.com' }));
  ok('public mail domain refused as a deal', db.prepare('SELECT COUNT(*) n FROM deal_registrations').get().n === 1);
  p = await purchase(db, 'course-one', { cookie: 'AHMED20', email: 'teacher@greenfield.edu' });
  ok('registered deal beats the link cookie: credited to Bright Minds at 15%', p.order.attribution === 'deal' && p.order.partner_id === 2 && db.prepare('SELECT amount_cents a, rate FROM commissions WHERE order_id=?').get(p.order.id).a === 1500);
  ok('deal marked won with the order', db.prepare("SELECT status, won_order_id FROM deal_registrations WHERE id=1").get().won_order_id === p.order.id);
  p = await purchase(db, 'course-one', { cookie: 'AHMED20', email: 'ahmed@partner.test' });
  ok('partner buying through their own link is a house sale', p.order.attribution === 'house');
  await call('/admin/partners', form({ id: '1', name: 'Ahmed Khan', code: 'AHMED20', type: 'affiliate', email: 'ahmed@partner.test', discount_percent: '10', status: 'paused' }));
  p = await purchase(db, 'course-one', { cookie: 'AHMED20', email: 'late@buyer.test' });
  ok('paused partner gets no credit', p.order.attribution === 'house');
  const dump2 = await (await fetch(`http://localhost:${FAKE}/__dump`)).json();
  ok('pausing deactivated the Stripe promotion code', Object.values(dump2.promotion_codes).every(x => !x.active));
  await call('/admin/partners', form({ id: '1', name: 'Ahmed Khan', code: 'AHMED20', type: 'affiliate', email: 'ahmed@partner.test', discount_percent: '10', status: 'active' }));
  const dump3 = await (await fetch(`http://localhost:${FAKE}/__dump`)).json();
  ok('re-activating creates a fresh promotion code', Object.values(dump3.promotion_codes).filter(x => x.active && x.code === 'AHMED20').length === 1);

  console.log('refunds and renewals');
  const first = db.prepare("SELECT * FROM orders WHERE buyer_email='link@buyer.test'").get();
  let h = await hook({ id: 'evt_r1', type: 'charge.refunded', data: { object: { id: 'ch_1', payment_intent: first.stripe_payment_intent, amount: 10000, amount_refunded: 10000 } } });
  ok('full refund inside 30 days reverses the commission', /refunded order/.test(h.body.result) && db.prepare('SELECT status FROM commissions WHERE order_id=?').get(first.id).status === 'reversed');
  const codeOrder = db.prepare("SELECT * FROM orders WHERE buyer_email='code@buyer.test'").get();
  db.prepare("UPDATE orders SET paid_at=datetime('now','-45 days') WHERE id=?").run(codeOrder.id);
  h = await hook({ id: 'evt_r2', type: 'charge.refunded', data: { object: { id: 'ch_2', payment_intent: codeOrder.stripe_payment_intent, amount: 9000, amount_refunded: 9000 } } });
  ok('refund after the window leaves the commission', db.prepare('SELECT status FROM commissions WHERE order_id=?').get(codeOrder.id).status === 'pending');
  p = await purchase(db, 'everything', { cookie: 'AHMED20', email: 'sub@buyer.test' });
  ok('subscription first payment: 20% of $200', db.prepare('SELECT amount_cents a FROM commissions WHERE order_id=?').get(p.order.id).a === 4000);
  const sub = p.order.stripe_subscription_id;
  h = await hook({ id: 'evt_n1', type: 'invoice.paid', data: { object: { id: 'in_renew1', subscription: sub, amount_paid: 20000, currency: 'usd' } } });
  const renew = db.prepare("SELECT * FROM orders WHERE stripe_invoice_id='in_renew1'").get();
  ok('renewal credited to the same partner at the renewal rate (10% = $20)', renew.partner_id === 1 && renew.attribution === 'renewal' && db.prepare('SELECT kind, amount_cents a FROM commissions WHERE order_id=?').get(renew.id).a === 2000);
  db.prepare("UPDATE orders SET attributed_at=datetime('now','-400 days') WHERE id=?").run(p.order.id);
  h = await hook({ id: 'evt_n2', type: 'invoice.paid', data: { object: { id: 'in_renew2', subscription: sub, amount_paid: 20000, currency: 'usd' } } });
  const renew2 = db.prepare("SELECT * FROM orders WHERE stripe_invoice_id='in_renew2'").get();
  ok('renewal after 12 months earns nothing', !db.prepare('SELECT 1 FROM commissions WHERE order_id=?').get(renew2.id));

  console.log('admin');
  await call('/admin/commissions/' + c.id + '/approved', { method: 'POST' });   // c was reversed → refused
  const dealC = db.prepare("SELECT id FROM commissions WHERE partner_id=2").get();
  r = await call('/admin/commissions/status', form({ ids: String(dealC.id), status: 'approved' }));
  ok('bulk approve moves pending → approved', db.prepare('SELECT status FROM commissions WHERE id=?').get(dealC.id).status === 'approved');
  r = await call('/admin/commissions/' + dealC.id + '/paid', { method: 'POST' });
  ok('approved → paid', db.prepare('SELECT status, paid_at FROM commissions WHERE id=?').get(dealC.id).paid_at !== null);
  r = await call('/admin/commissions/' + dealC.id + '/approved', { method: 'POST' });
  ok('paid cannot go back', db.prepare('SELECT status FROM commissions WHERE id=?').get(dealC.id).status === 'paid');
  const dealOrder = db.prepare("SELECT * FROM orders WHERE buyer_email='teacher@greenfield.edu'").get();
  h = await hook({ id: 'evt_r3', type: 'charge.refunded', data: { object: { id: 'ch_3', payment_intent: dealOrder.stripe_payment_intent, amount: 10000, amount_refunded: 10000 } } });
  ok('refund of a paid commission books a negative clawback row', db.prepare("SELECT amount_cents a FROM commissions WHERE order_id=? AND kind='clawback'").get(dealOrder.id).a === -1500);
  const html = await (await call('/admin/commissions')).text();
  ok('commissions page renders summary and rows', /Ahmed Khan/.test(html) && /Bright Minds/.test(html) && /clawback/.test(html));
  const csv = await (await call('/admin/commissions?format=csv')).text();
  ok('CSV export has a header and one line per row', csv.split('\n')[0].startsWith('id,period,partner_code') && csv.trim().split('\n').length === db.prepare('SELECT COUNT(*) n FROM commissions').get().n + 1);
  const orders = await (await call('/admin/orders')).text();
  ok('orders page shows the partner column', /href="\/admin\/partners\/1">Ahmed Khan/.test(orders) && /house/.test(orders));
  const list = await (await call('/admin/partners')).text();
  ok('partners list shows earned and owed', /Ahmed Khan/.test(list) && /\$/.test(list));
  ok('attribution never written to a student profile beyond partner_id/attributed_at', !db.prepare('PRAGMA table_info(users)').all().some(col => /commission|coupon|promo/.test(col.name)));

  console.log('content partners');
  r = await call('/admin/partners', form({ name: 'Course Author Co', type: 'content', email: 'author@partner.test' }));
  const author = db.prepare("SELECT * FROM partners WHERE type='content'").get();
  ok('content partner gets a generated identifier', author && /^CP-COURSEAUTH/.test(author.code));
  ok('content partner created with no coupon and no rates', author && author.type === 'content' && !author.stripe_promotion_code_id && author.discount_percent === 0);
  r = await call('/admin/partners/' + author.id + '/royalties', form({ course_id: '1', percent: '25' }));
  ok('royalty 25% set on Course One', db.prepare('SELECT percent FROM course_royalties WHERE course_id=1 AND partner_id=?').get(author.id).percent === 25);
  r = await call('/admin/partners/' + author.id + '/royalties', form({ course_id: '1', percent: '80' }));
  ok('saving again replaces the percentage', db.prepare('SELECT percent FROM course_royalties WHERE course_id=1 AND partner_id=?').get(author.id).percent === 80);
  await call('/admin/partners/' + author.id + '/royalties', form({ course_id: '1', percent: '25' }));
  p = await purchase(db, 'course-one', { cookie: 'AHMED20', email: 'royal1@buyer.test' });
  let roy = db.prepare("SELECT * FROM commissions WHERE order_id=? AND kind='royalty'").get(p.order.id);
  ok('house/affiliate sale of a 1-course product books 25% of net $100 = $25 to the author, alongside the affiliate commission', roy && roy.partner_id === author.id && roy.amount_cents === 2500 && db.prepare("SELECT COUNT(*) n FROM commissions WHERE order_id=?").get(p.order.id).n === 2);
  p = await purchase(db, 'course-one', { email: 'royal2@buyer.test', promo: 'AHMED20' });
  roy = db.prepare("SELECT * FROM commissions WHERE order_id=? AND kind='royalty'").get(p.order.id);
  ok('discounted sale: royalty on the net $90 = $22.50', roy && roy.amount_cents === 2250 && roy.basis_cents === 9000);
  p = await purchase(db, 'everything', { email: 'royal3@buyer.test' });
  roy = db.prepare("SELECT * FROM commissions WHERE order_id=? AND kind='royalty'").get(p.order.id);
  ok('2-course bundle at $200: Course One share $100 → $25 royalty', roy && roy.basis_cents === 10000 && roy.amount_cents === 2500);
  const sub2 = p.order.stripe_subscription_id;
  h = await hook({ id: 'evt_roy_renew', type: 'invoice.paid', data: { object: { id: 'in_roy_renew', subscription: sub2, amount_paid: 20000, currency: 'usd' } } });
  const renewRoy = db.prepare("SELECT c.* FROM commissions c JOIN orders o ON o.id=c.order_id WHERE o.stripe_invoice_id='in_roy_renew' AND c.kind='royalty'").get();
  ok('renewal books the royalty again (no time limit)', renewRoy && renewRoy.amount_cents === 2500);
  const royOrder = db.prepare("SELECT * FROM orders WHERE buyer_email='royal1@buyer.test'").get();
  h = await hook({ id: 'evt_roy_refund', type: 'charge.refunded', data: { object: { id: 'ch_roy', payment_intent: royOrder.stripe_payment_intent, amount: 10000, amount_refunded: 10000 } } });
  ok('refund reverses the royalty too', db.prepare("SELECT status FROM commissions WHERE order_id=? AND kind='royalty'").get(royOrder.id).status === 'reversed');
  ok('content partner never gets sales attribution', !db.prepare('SELECT 1 FROM orders WHERE partner_id=?').get(author.id));
  var html2 = await (await call('/admin/commissions?kind=royalty')).text();
  ok('commissions page filters royalties and names the course', /Course One/.test(html2) && !/>first</.test(html2));
  var html3 = await (await call('/admin/products')).text();
  ok('products page shows royalty payout %', /royalties 25% of net sale/.test(html3) && /royalties 12\.5% of net sale/.test(html3));

  console.log('deletion');
  const victim = db.prepare("SELECT * FROM users WHERE email='sub@buyer.test'").get();
  r = await call('/admin/users/' + victim.id + '/delete', { method: 'POST' });
  const gone = db.prepare("SELECT COUNT(*) n FROM orders WHERE user_id=? OR buyer_email='sub@buyer.test'").get(victim.id).n === 0;
  const kept = db.prepare("SELECT COUNT(*) n FROM orders WHERE buyer_email LIKE 'deleted-%@removed.invalid'").get().n;
  ok('deleting the buyer strips identity from orders but keeps them and their commissions', gone && kept === 3 && db.prepare('SELECT COUNT(*) n FROM commissions WHERE order_id=?').get(p.order.id).n === 1);

  console.log(`\n${passed} passed, ${failed} failed`);
  server.kill(); fake.close(); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); server.kill(); fake.close(); process.exit(1); });
