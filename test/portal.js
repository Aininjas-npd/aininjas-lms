/* Partner portal + statements (Phase 3) against the fake Stripe: invite a partner, terms gate, portal pages without
   buyer identity, partner-proposed deals, approve → statements → mark paid, access control. Run: node test/portal.js */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const Stripe = require('stripe');
const bcrypt = require('bcryptjs');
const PORT = 3996, BASE = `http://localhost:${PORT}`, FAKE = 4245, WHSEC = 'whsec_test_portal';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-portal-'));
const fake = require('./fake-stripe'); fake.listen(FAKE);
const server = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT, BASE_URL: BASE, DATA_DIR: dataDir, ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'admin12345', GOOGLE_CLIENT_ID: '', ACCOUNTS_URL: '', SSO_SECRET: '', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_API_BASE: `http://localhost:${FAKE}`, STRIPE_WEBHOOK_SECRET: WHSEC, MAIN_SITE_URL: 'https://www.example.test', PARTNER_TERMS_URL: 'https://www.example.test/partner-terms' } });
if (process.env.DEBUG) server.stderr.on('data', d => process.stderr.write(d));
let passed = 0, failed = 0;
const ok = (name, cond) => { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function client() {
  const cookies = {};
  const jar = res => { const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean); for (const c of sc) { const [kv] = c.split(';'); const [k, v] = kv.split('='); cookies[k] = v; } };
  const header = () => Object.entries(cookies).map(([k, v]) => k + '=' + v).join('; ');
  return async (p, opts = {}) => { const r = await fetch(BASE + p, { redirect: 'manual', ...opts, headers: { cookie: header(), ...(opts.headers || {}) } }); jar(r); return r; };
}
const form = o => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });
const stripe = Stripe('sk_test_x');
const admin = client(), partner = client(), other = client();
async function hook(evt) { const payload = JSON.stringify(evt); const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC }); const r = await fetch(BASE + '/api/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: payload }); return { status: r.status, body: await r.json().catch(() => ({})) }; }
const Database = require('better-sqlite3');
let evt = 0;
async function purchase(db, slug, { cookie, email }) {
  await fetch(BASE + `/buy/${slug}`, { redirect: 'manual', headers: cookie ? { cookie: 'partner_ref=' + cookie } : {} });
  const sid = db.prepare('SELECT stripe_session_id s FROM orders ORDER BY id DESC').get().s;
  const sess = await (await fetch(`http://localhost:${FAKE}/__pay/${sid}?email=${encodeURIComponent(email)}`)).json();
  await hook({ id: 'evt_q' + (++evt), type: 'checkout.session.completed', data: { object: sess } });
  return db.prepare('SELECT * FROM orders WHERE stripe_session_id=?').get(sid);
}
(async () => {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {} await sleep(200); }
  const db = new Database(path.join(dataDir, 'lms.sqlite'));
  db.prepare("INSERT INTO courses (slug,title,manifest_json) VALUES ('c1','Course One','{}')").run();
  await admin('/login', form({ email: 'admin@test.local', password: 'admin12345' }));
  await admin('/admin/products', form({ name: 'Course One', slug: 'course-one', kind: 'one_time', audience: 'individual', amount: '100', course_ids: '1', on_sale: 'on' }));

  console.log('invitation');
  await admin('/admin/partners', form({ name: 'Ahmed Khan', code: 'AHMED', type: 'affiliate', email: 'ahmed@partner.test', contact_name: 'Ahmed' }));
  await admin('/admin/partners', form({ name: 'Other Co', code: 'OTHER', type: 'agent', email: 'other@partner.test' }));
  let r = await admin('/admin/partners/1/invite', { method: 'POST' });
  const pu = db.prepare("SELECT * FROM users WHERE email='ahmed@partner.test'").get();
  ok('invite creates a partner-role account linked to the partner record', pu && pu.role === 'partner' && pu.status === 'approved' && db.prepare('SELECT user_id FROM partners WHERE id=1').get().user_id === pu.id);
  await admin('/admin/partners/2/invite', { method: 'POST' });
  db.prepare('UPDATE users SET password_hash=? WHERE role=?').run(bcrypt.hashSync('partner123', 4), 'partner');   // SSO is off in tests: give them passwords

  console.log('terms gate and portal');
  r = await partner('/login', form({ email: 'ahmed@partner.test', password: 'partner123' }));
  ok('partner login lands on the portal', r.status === 302 && r.headers.get('location') === '/partners');
  r = await partner('/partners');
  ok('terms must be accepted first', r.status === 302 && r.headers.get('location') === '/partners/terms');
  let html = await (await partner('/partners/terms')).text();
  ok('terms page shows the agreement link and the partner\'s rates', /partner-terms/.test(html) && /20%/.test(html));
  await partner('/partners/terms', form({}));
  ok('not ticking the box keeps the gate', !db.prepare('SELECT terms_accepted_at t FROM partners WHERE id=1').get().t);
  await partner('/partners/terms', form({ accept: 'on' }));
  ok('acceptance recorded', !!db.prepare('SELECT terms_accepted_at t FROM partners WHERE id=1').get().t);
  html = await (await partner('/partners')).text();
  ok('overview shows link, code and zero stats', html.includes(BASE + '/p/AHMED') && /No sales yet/.test(html));
  r = await partner('/dashboard');
  ok('a partner is kept out of learner pages', r.status === 302 && r.headers.get('location') === '/partners');
  r = await partner('/admin/partners');
  ok('… and out of admin', r.status === 302 || r.status === 403);
  r = await admin('/partners');
  ok('an admin is not a partner', r.status === 403);

  console.log('sales, privacy');
  const o1 = await purchase(db, 'course-one', { cookie: 'AHMED', email: 'parent.one@buyer.test' });
  const o2 = await purchase(db, 'course-one', { cookie: 'AHMED', email: 'parent.two@buyer.test' });
  await purchase(db, 'course-one', { cookie: 'OTHER', email: 'parent.three@buyer.test' });
  html = await (await partner('/partners/sales')).text();
  ok('sales page lists the partner\'s two orders with commissions', (html.match(/\$20/g) || []).length >= 2 && new RegExp(`<td>${o1.id}</td>`).test(html) && new RegExp(`<td>${o2.id}</td>`).test(html));
  ok('… without any buyer identity', !/buyer\.test/.test(html) && !/parent\./.test(html));
  ok('… and not the other partner\'s order', !/OTHER/.test(html) && (html.match(/<td>\d+<\/td><td class="small">/g) || []).length === 2);
  html = await (await partner('/partners')).text();
  ok('overview stats: 2 sales, $40 awaiting payment', /<strong>2<\/strong> sales credited/.test(html) && /Awaiting payment <strong>\$40<\/strong>/.test(html));

  console.log('deals');
  await partner('/partners/deals', form({ match_kind: 'domain', match_value: 'greenfield.edu', label: 'Greenfield Academy' }));
  let d = db.prepare("SELECT * FROM deal_registrations WHERE match_value='greenfield.edu'").get();
  ok('partner-submitted deal is proposed, not yet counted', d && d.status === 'proposed' && d.source === 'partner');
  const o4 = await purchase(db, 'course-one', { email: 'head@greenfield.edu' });
  ok('a proposed deal does not attribute', o4.attribution === 'house');
  html = await (await admin('/admin/payouts')).text();
  ok('admin sees the proposal on the statements page', /Greenfield Academy/.test(html) && /Approve/.test(html));
  await admin(`/admin/partners/1/deals/${d.id}/approve`, { method: 'POST' });
  d = db.prepare('SELECT status FROM deal_registrations WHERE id=?').get(d.id);
  const o5 = await purchase(db, 'course-one', { email: 'teacher@greenfield.edu' });
  ok('approved deal attributes the next purchase', d.status === 'registered' && o5.attribution === 'deal' && o5.partner_id === 1);
  await partner('/partners/deals', form({ match_kind: 'domain', match_value: 'gmail.com' }));
  ok('public mail domain refused in the portal too', !db.prepare("SELECT 1 FROM deal_registrations WHERE match_value='gmail.com'").get());

  console.log('statements');
  const period = new Date().toISOString().slice(0, 7);
  r = await admin('/admin/payouts/create', form({ period }));
  ok('no statement while commissions are still pending', db.prepare('SELECT COUNT(*) n FROM payouts').get().n === 0);
  const ids = db.prepare("SELECT id FROM commissions WHERE status='pending'").all().map(x => x.id);
  await admin('/admin/commissions/status', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: ids.map(i => 'ids=' + i).join('&') + '&status=approved' });
  r = await admin('/admin/payouts/create', form({ period }));
  const pys = db.prepare('SELECT * FROM payouts ORDER BY partner_id').all();
  ok('one statement per partner for the month: Ahmed $60 (3 sales), Other $15', pys.length === 2 && pys[0].partner_id === 1 && pys[0].amount_cents === 6000 && pys[1].amount_cents === 1500);
  ok('commissions are tied to their statement', db.prepare('SELECT COUNT(*) n FROM commissions WHERE payout_id IS NULL').get().n === 0);
  r = await admin('/admin/payouts/create', form({ period }));
  ok('issuing again creates nothing new', db.prepare('SELECT COUNT(*) n FROM payouts').get().n === 2);
  html = await (await partner('/partners/commissions')).text();
  ok('partner sees their statement as awaiting payment', new RegExp(`/partners/statements/${pys[0].id}`).test(html) && /\$60/.test(html) && /awaiting payment/.test(html));
  html = await (await partner('/partners/statements/' + pys[0].id)).text();
  ok('statement page lists the three lines and the total', (html.match(/<td>first<\/td>/g) || []).length === 3 && /<strong>\$60<\/strong>/.test(html) && !/buyer\.test|greenfield/.test(html));
  r = await partner('/partners/statements/' + pys[1].id);
  ok('another partner\'s statement is not reachable', r.status === 404);
  const csv = await (await partner('/partners/statements/' + pys[0].id + '?format=csv')).text();
  ok('statement CSV', csv.startsWith('id,period,partner_code') && csv.trim().split('\n').length === 4);
  await admin('/admin/payouts/' + pys[0].id + '/paid', form({ reference: 'TRX-1001' }));
  ok('marking paid pays its commissions and stores the reference', db.prepare("SELECT COUNT(*) n FROM commissions WHERE payout_id=? AND status='paid'").get(pys[0].id).n === 3 && db.prepare('SELECT reference FROM payouts WHERE id=?').get(pys[0].id).reference === 'TRX-1001');
  html = await (await partner('/partners')).text();
  ok('overview now shows paid out $60, awaiting $0', /Paid out to you <strong>\$60<\/strong>/.test(html) && /Awaiting payment <strong>\$0<\/strong>/.test(html));
  await admin('/admin/payouts/' + pys[1].id + '/void', { method: 'POST' });
  ok('voiding frees the commissions for a re-issue', db.prepare('SELECT status FROM payouts WHERE id=?').get(pys[1].id).status === 'void' && db.prepare("SELECT COUNT(*) n FROM commissions WHERE partner_id=2 AND payout_id IS NULL AND status='approved'").get().n === 1);
  html = await (await admin('/admin/payouts/' + pys[0].id)).text();
  ok('admin statement view shows the partner email and payout details area', /ahmed@partner.test/.test(html) && /TRX-1001/.test(html));

  console.log('content partner portal');
  await admin('/admin/partners', form({ name: 'Author Co', code: 'AUTHOR', type: 'content', email: 'author@partner.test' }));
  const authorP = db.prepare("SELECT * FROM partners WHERE code='AUTHOR'").get();
  await admin('/admin/partners/' + authorP.id + '/royalties', form({ course_id: '1', percent: '25' }));
  await admin('/admin/partners/' + authorP.id + '/invite', { method: 'POST' });
  db.prepare('UPDATE users SET password_hash=? WHERE email=?').run(bcrypt.hashSync('partner123', 4), 'author@partner.test');
  await purchase(db, 'course-one', { email: 'reader@buyer.test' });
  const author = client();
  await author('/login', form({ email: 'author@partner.test', password: 'partner123' }));
  await author('/partners/terms', form({ accept: 'on' }));
  html = await (await author('/partners')).text();
  ok('content partner overview lists their course, royalty and recent royalties without buyer identity', /Course One/.test(html) && /<strong>25%<\/strong>/.test(html) && /\$25/.test(html) && !/buyer\.test/.test(html) && !/\/p\/AUTHOR/.test(html));
  ok('menu says Royalties and has no Deals', /Royalties/.test(html) && !/href="\/partners\/deals"/.test(html));
  r = await author('/partners/deals');
  ok('deals page redirects away for content partners', r.status === 302);

  console.log('settings and deletion');
  await partner('/partners/settings', form({ payout_details: 'PayPal: ahmed@partner.test' }));
  ok('payout details saved', db.prepare('SELECT payout_details d FROM partners WHERE id=1').get().d === 'PayPal: ahmed@partner.test');
  await admin('/admin/users/' + pu.id + '/delete', { method: 'POST' });
  ok('deleting the portal account keeps the partner record and ledger, unlinked', db.prepare('SELECT user_id FROM partners WHERE id=1').get().user_id === null && db.prepare('SELECT COUNT(*) n FROM commissions WHERE partner_id=1').get().n === 3);

  console.log(`\n${passed} passed, ${failed} failed`);
  server.kill(); fake.close(); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); server.kill(); fake.close(); process.exit(1); });
