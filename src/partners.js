'use strict';
/* Partner tracking (Phase 2): who brought a sale, and what we owe them for it.

   Three ways a sale is attributed, in order of precedence (first match wins):
     deal  — a registered deal: the partner told us beforehand "I am introducing school X / buyer Y" (Admin → Partners).
     code  — the buyer typed the partner's promotion code at Stripe Checkout (we read it off the completed session).
     link  — the buyer arrived through the partner's link (/p/<CODE>, or ?ref=<CODE> on aininjas.com) within the window.
     house — none of the above: AI Ninjas' own marketing. No commission.
   Attribution is decided once, when the order is paid, and locked on the order (partner_id, attribution, attributed_at).
   A buyer's first partner is also kept on users.partner_id so renewals keep paying the partner that originated the
   subscription, for `renewal_months` after the first sale. Nothing here is written to a student's learning profile and
   nothing is shown to the learner: it is accounting about the ORDER, kept for the partner ledger (NDPA position).

   Commissions: one row per paid order (kind first | renewal), amount = rate × what the buyer actually paid (after any
   discount). A full refund inside the clawback window reverses the row (or books a negative row if it was already paid).
   Status flow: pending → approved → paid (payout itself is Phase 3). */
const crypto = require('crypto');
const { db, q } = require('./db');

const WINDOW_DAYS = Math.max(1, +process.env.PARTNER_LINK_DAYS || 60);          // referral link / cookie validity
const CLAWBACK_DAYS = Math.max(0, +process.env.PARTNER_CLAWBACK_DAYS || 30);    // refunds inside this reverse the commission
const DEAL_DAYS = Math.max(1, +process.env.PARTNER_DEAL_DAYS || 180);           // a registered deal expires after this
const DEFAULT_RATES = { affiliate: { first: 20, renewal: 10 }, agent: { first: 15, renewal: 7.5 } };
const MAIN_SITE = (process.env.MAIN_SITE_URL || 'https://www.aininjas.com').replace(/\/$/, '');

/* ---------- schema ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS partners (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT UNIQUE NOT NULL,              -- what goes in links and coupon codes, e.g. AHMED20
  name            TEXT NOT NULL,                     -- person or company
  type            TEXT NOT NULL DEFAULT 'affiliate', -- affiliate | agent (business-development agent)
  contact_name    TEXT,
  email           TEXT,
  rate_first      REAL NOT NULL DEFAULT 20,          -- % of the first payment
  rate_renewal    REAL NOT NULL DEFAULT 10,          -- % of each renewal within renewal_months
  renewal_months  INTEGER NOT NULL DEFAULT 12,
  discount_percent REAL NOT NULL DEFAULT 0,          -- buyer discount carried by the coupon code (0 = link-only partner)
  stripe_coupon_id TEXT,
  stripe_promotion_code_id TEXT,
  status          TEXT NOT NULL DEFAULT 'active',    -- active | paused | ended
  clicks          INTEGER NOT NULL DEFAULT 0,        -- /p/<code> hits (a count, no visitor data)
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS deal_registrations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_id      INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  match_kind      TEXT NOT NULL,                     -- school | email | domain
  match_value     TEXT NOT NULL,                     -- school slug, buyer email, or email domain (lower-case)
  label           TEXT,                              -- e.g. "Greenfield Academy, Ms Rao"
  status          TEXT NOT NULL DEFAULT 'registered',-- registered | won | expired | rejected
  registered_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT NOT NULL,
  won_order_id    INTEGER,
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS idx_deals_match ON deal_registrations(match_kind, match_value);
CREATE TABLE IF NOT EXISTS commissions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_id      INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  order_id        INTEGER NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'first',     -- first | renewal | clawback
  basis_cents     INTEGER NOT NULL,                  -- what the buyer paid
  rate            REAL NOT NULL,
  amount_cents    INTEGER NOT NULL,                  -- negative for a clawback
  currency        TEXT NOT NULL DEFAULT 'usd',
  period          TEXT NOT NULL,                     -- YYYY-MM the order was paid (the payout month it belongs to)
  status          TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | paid | reversed
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at     TEXT,
  paid_at         TEXT,
  reversed_at     TEXT,
  note            TEXT
);
CREATE INDEX IF NOT EXISTS idx_comm_partner ON commissions(partner_id, period);
CREATE INDEX IF NOT EXISTS idx_comm_order ON commissions(order_id);
CREATE TABLE IF NOT EXISTS payouts (                 -- Phase 3: one statement per partner per month
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_id      INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  period          TEXT NOT NULL,                     -- YYYY-MM the statement covers
  amount_cents    INTEGER NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'usd',
  status          TEXT NOT NULL DEFAULT 'issued',    -- issued | paid | void
  reference       TEXT,                              -- bank / PayPal reference once paid
  issued_at       TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at         TEXT,
  note            TEXT,
  UNIQUE (partner_id, period)
);
`);
const addCol = (table, col, type) => { if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); };
addCol('partners', 'user_id', 'INTEGER');                 // the partner's Academy account (role partner), for the portal
addCol('partners', 'terms_accepted_at', 'TEXT');
addCol('partners', 'payout_details', 'TEXT');             // how they want to be paid, in their words
addCol('deal_registrations', 'source', "TEXT NOT NULL DEFAULT 'admin'");   // admin | partner (portal)
addCol('commissions', 'payout_id', 'INTEGER');
/** orders columns this module adds; called by commerce.js once the orders table exists. */
function ensureOrderColumns() { addCol('orders', 'attributed_at', 'TEXT'); addCol('orders', 'promotion_code', 'TEXT'); }

/* ---------- partners ---------- */
const CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,19}$/;
const partnerById = id => db.prepare('SELECT * FROM partners WHERE id=?').get(id);
const partnerByCode = code => code ? db.prepare('SELECT * FROM partners WHERE code=?').get(String(code).trim().toUpperCase()) : null;
const partnerByUser = u => u ? (db.prepare('SELECT * FROM partners WHERE user_id=?').get(u.id) || (u.email ? db.prepare('SELECT * FROM partners WHERE email=? AND user_id IS NULL').get(String(u.email).toLowerCase()) : null)) : null;
const partnerByPromotionCode = id => id ? db.prepare('SELECT * FROM partners WHERE stripe_promotion_code_id=?').get(id) : null;
const listPartners = () => db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM orders o WHERE o.partner_id=p.id AND o.status IN ('paid','refunded','lapsed')) AS orders_n,
  (SELECT COALESCE(SUM(amount_cents),0) FROM commissions c WHERE c.partner_id=p.id AND c.status<>'reversed') AS earned_cents,
  (SELECT COALESCE(SUM(amount_cents),0) FROM commissions c WHERE c.partner_id=p.id AND c.status IN ('pending','approved')) AS owed_cents
  FROM partners p ORDER BY p.status='active' DESC, p.name`).all();

let stripeFn = null;   // set by commerce.js so both modules share the lazy client
function setStripe(fn) { stripeFn = fn; }

/** Create or update a partner. Keeps the Stripe promotion code in step with discount_percent. */
async function savePartner(input, { by } = {}) {
  const code = String(input.code || '').trim().toUpperCase();
  if (!CODE_RE.test(code)) throw new Error('Code: 3–20 capital letters, digits or dashes (e.g. AHMED20) — it goes in links and at checkout');
  const name = String(input.name || '').trim(); if (!name) throw new Error('Name is required');
  const type = input.type === 'agent' ? 'agent' : 'affiliate';
  const num = (v, dflt) => { if (v === undefined || v === null || String(v).trim() === '') return dflt; const n = Number(v); if (!(n >= 0 && n <= 100)) throw new Error('Rates and discounts are percentages between 0 and 100'); return n; };
  const existing = input.id ? partnerById(input.id) : null;
  const clash = partnerByCode(code); if (clash && (!existing || clash.id !== existing.id)) throw new Error('That code is already used by ' + clash.name);
  const fields = {
    code, name, type, contact_name: String(input.contact_name || '').trim() || null, email: String(input.email || '').trim().toLowerCase() || null,
    rate_first: num(input.rate_first, DEFAULT_RATES[type].first), rate_renewal: num(input.rate_renewal, DEFAULT_RATES[type].renewal),
    renewal_months: Math.max(0, Math.min(120, +input.renewal_months || 12)), discount_percent: num(input.discount_percent, 0),
    status: ['active', 'paused', 'ended'].includes(input.status) ? input.status : 'active', notes: String(input.notes || '').trim() || null,
  };
  let id;
  if (existing) { db.prepare(`UPDATE partners SET code=@code, name=@name, type=@type, contact_name=@contact_name, email=@email, rate_first=@rate_first, rate_renewal=@rate_renewal, renewal_months=@renewal_months, discount_percent=@discount_percent, status=@status, notes=@notes, updated_at=datetime('now') WHERE id=@id`).run({ ...fields, id: existing.id }); id = existing.id; }
  else id = db.prepare(`INSERT INTO partners (code, name, type, contact_name, email, rate_first, rate_renewal, renewal_months, discount_percent, status, notes) VALUES (@code, @name, @type, @contact_name, @email, @rate_first, @rate_renewal, @renewal_months, @discount_percent, @status, @notes)`).run(fields).lastInsertRowid;
  q.logEvent.run(null, null, null, 'partner_saved', JSON.stringify({ id, code, by, type, rate_first: fields.rate_first, discount_percent: fields.discount_percent }));
  const warning = await syncPromotionCode(partnerById(id), existing);
  return { partner: partnerById(id), warning };
}

/** Keep one active Stripe promotion code per partner (code = partner code, discount = discount_percent, first payment only).
    No discount → no Stripe code (link-only partner); a changed discount → new coupon, old promotion code deactivated. */
async function syncPromotionCode(p, previous) {
  const s = stripeFn && stripeFn();
  const wantsCode = p.discount_percent > 0 && p.status === 'active';
  if (!s) return wantsCode ? 'Stripe is not configured — the coupon code will be created when keys are set and you save the partner again.' : null;
  try {
    const changed = !previous || previous.discount_percent !== p.discount_percent || previous.code !== p.code || (previous.status === 'active') !== (p.status === 'active');
    if (!changed && (!wantsCode || p.stripe_promotion_code_id)) return null;
    if (p.stripe_promotion_code_id) { try { await s.promotionCodes.update(p.stripe_promotion_code_id, { active: false }); } catch {} db.prepare('UPDATE partners SET stripe_promotion_code_id=NULL WHERE id=?').run(p.id); }
    if (!wantsCode) return null;
    const coupon = await s.coupons.create({ percent_off: p.discount_percent, duration: 'once', name: `Partner ${p.code}`, metadata: { partner_id: String(p.id), partner_code: p.code } });
    // Stripe API 2025-09+ takes `promotion: {type:'coupon', coupon}`; older pinned versions take `coupon`. Try new, fall back.
    let promo;
    try { promo = await s.promotionCodes.create({ promotion: { type: 'coupon', coupon: coupon.id }, code: p.code, metadata: { partner_id: String(p.id) } }); }
    catch (e) { if (!/unknown parameter: promotion/i.test(e.message)) throw e; promo = await s.promotionCodes.create({ coupon: coupon.id, code: p.code, metadata: { partner_id: String(p.id) } }); }
    db.prepare('UPDATE partners SET stripe_coupon_id=?, stripe_promotion_code_id=? WHERE id=?').run(coupon.id, promo.id, p.id);
    return null;
  } catch (e) { return 'Stripe refused the coupon code: ' + e.message; }
}

/** The partner's shareable link and the raw landing URL it forwards to. */
function linkFor(p, baseUrl) { return { link: `${baseUrl}/p/${p.code}`, landing: `${MAIN_SITE}/?ref=${p.code}` }; }

/* ---------- deals ---------- */
function registerDeal(partnerId, input, { source = 'admin' } = {}) {
  const p = partnerById(partnerId); if (!p) throw new Error('No such partner');
  const kind = ['school', 'email', 'domain'].includes(input.match_kind) ? input.match_kind : 'email';
  let value = String(input.match_value || '').trim().toLowerCase();
  if (kind === 'domain') value = value.replace(/^@/, '');
  if (!value || (kind === 'email' && !value.includes('@')) || (kind === 'domain' && value.includes('@'))) throw new Error(kind === 'email' ? 'Enter the buyer\'s email' : kind === 'domain' ? 'Enter the organisation\'s email domain, e.g. greenfield.edu' : 'Enter the school slug');
  if (kind === 'domain' && /^(gmail|yahoo|hotmail|outlook|icloud|live|aol|proton|protonmail)\.com$|^(gmail|yahoo)\.[a-z.]+$/.test(value)) throw new Error('A public mail domain cannot be registered as a deal — register the buyer\'s email instead');
  const open = db.prepare("SELECT d.*, p.name partner_name FROM deal_registrations d JOIN partners p ON p.id=d.partner_id WHERE d.match_kind=? AND d.match_value=? AND d.status IN ('registered','proposed') AND d.expires_at > datetime('now')").get(kind, value);
  if (open) throw new Error(`Already registered by ${open.partner_name} until ${open.expires_at.slice(0, 10)}`);
  const days = Math.max(1, +input.days || DEAL_DAYS);
  const status = source === 'partner' ? 'proposed' : 'registered';   // a partner's own registration waits for an admin to approve it
  const id = db.prepare(`INSERT INTO deal_registrations (partner_id, match_kind, match_value, label, expires_at, notes, source, status) VALUES (?, ?, ?, ?, datetime('now', '+${days} days'), ?, ?, ?)`).run(p.id, kind, value, String(input.label || '').trim() || null, String(input.notes || '').trim() || null, source, status).lastInsertRowid;
  q.logEvent.run(null, null, null, 'deal_registered', JSON.stringify({ id, partner_id: p.id, kind, value }));
  return db.prepare('SELECT * FROM deal_registrations WHERE id=?').get(id);
}
const listDeals = partnerId => db.prepare('SELECT * FROM deal_registrations WHERE partner_id=? ORDER BY id DESC').all(partnerId);
function setDealStatus(id, status) { if (!['registered', 'rejected', 'expired'].includes(status)) throw new Error('bad status'); db.prepare("UPDATE deal_registrations SET status=? WHERE id=? AND status<>'won'").run(status, id); }
const proposedDeals = () => db.prepare("SELECT d.*, p.name partner_name, p.code partner_code FROM deal_registrations d JOIN partners p ON p.id=d.partner_id WHERE d.status='proposed' ORDER BY d.id").all();

/** An open registered deal that matches this buyer (email / its domain) or school. */
function matchDeal({ email, schoolSlug }) {
  const now = "datetime('now')";
  const find = (kind, value) => value ? db.prepare(`SELECT * FROM deal_registrations WHERE match_kind=? AND match_value=? AND status='registered' AND expires_at > ${now} ORDER BY registered_at LIMIT 1`).get(kind, value) : null;
  email = String(email || '').toLowerCase();
  return find('school', schoolSlug && String(schoolSlug).toLowerCase()) || find('email', email) || find('domain', email.split('@')[1]) || null;
}

/* ---------- attribution ---------- */
/** Decide and lock who gets credit for a paid order. Called by commerce.fulfil once per order (no-op if already attributed). */
function attribute(order, { session, promotionCodeId, partnerRef, buyerEmail, user } = {}) {
  if (order.attribution && order.partner_id !== undefined && order.attributed_at) return { partner: order.partner_id ? partnerById(order.partner_id) : null, source: order.attribution, already: true };
  const email = String(buyerEmail || order.buyer_email || '').toLowerCase();
  let partner = null, source = 'house', deal = null, detail = null;
  const usable = p => p && p.status === 'active' && !(p.email && email && p.email === email);   // a partner buying for themselves is a house sale
  // 1. registered deal
  deal = matchDeal({ email, schoolSlug: order.school_slug });
  if (deal && usable(partnerById(deal.partner_id))) { partner = partnerById(deal.partner_id); source = 'deal'; detail = `deal ${deal.id}`; }
  // 2. promotion code typed at checkout
  if (!partner) {
    const promoId = promotionCodeId || (session && Array.isArray(session.discounts) && session.discounts.length ? (typeof session.discounts[0].promotion_code === 'string' ? session.discounts[0].promotion_code : (session.discounts[0].promotion_code && session.discounts[0].promotion_code.id)) : null);
    const p = partnerByPromotionCode(promoId);
    if (usable(p)) { partner = p; source = 'code'; detail = promoId; }
  }
  // 3. referral link / cookie
  if (!partner) {
    const ref = partnerRef || (session && session.metadata && session.metadata.partner_ref) || (() => { try { return JSON.parse(order.metadata || '{}').partner_ref; } catch { return null; } })();
    const p = partnerByCode(ref);
    if (usable(p)) { partner = p; source = 'link'; detail = ref; }
  }
  db.transaction(() => {
    db.prepare("UPDATE orders SET partner_id=?, attribution=?, attributed_at=datetime('now'), promotion_code=COALESCE(?, promotion_code) WHERE id=?").run(partner ? partner.id : null, source, source === 'code' ? detail : null, order.id);
    if (partner && source === 'deal') db.prepare("UPDATE deal_registrations SET status='won', won_order_id=? WHERE id=?").run(order.id, deal.id);
    if (partner && user && !user.partner_id) db.prepare("UPDATE users SET partner_id=?, attributed_at=datetime('now') WHERE id=?").run(partner.id, user.id);
  })();
  q.logEvent.run(null, null, null, 'order_attributed', JSON.stringify({ order_id: order.id, partner_id: partner ? partner.id : null, source, detail }));
  return { partner, source, already: false };
}

/* ---------- commissions ---------- */
const period = iso => String(iso || new Date().toISOString()).slice(0, 7);
const commissionsForOrder = orderId => db.prepare('SELECT * FROM commissions WHERE order_id=? ORDER BY id').all(orderId);

/** Book the commission for a paid order (first sale or renewal). Idempotent per order. */
function bookCommission(order, { renewalOf } = {}) {
  const fresh = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
  if (!fresh || !fresh.partner_id || fresh.status !== 'paid') return null;
  if (db.prepare("SELECT 1 FROM commissions WHERE order_id=? AND kind IN ('first','renewal')").get(fresh.id)) return null;
  const p = partnerById(fresh.partner_id); if (!p) return null;
  let kind = 'first', rate = p.rate_first;
  if (renewalOf) {
    kind = 'renewal'; rate = p.rate_renewal;
    const origin = db.prepare("SELECT attributed_at FROM orders WHERE id=?").get(renewalOf) || {};
    const firstAt = (db.prepare("SELECT MIN(attributed_at) t FROM orders WHERE stripe_subscription_id=? AND stripe_subscription_id IS NOT NULL").get(fresh.stripe_subscription_id) || {}).t || origin.attributed_at;
    if (firstAt && p.renewal_months > 0) {
      const months = (Date.now() - Date.parse(firstAt.replace(' ', 'T') + (firstAt.endsWith('Z') ? '' : 'Z'))) / (30.44 * 86400000);
      if (months > p.renewal_months) { q.logEvent.run(null, null, null, 'commission_skipped', JSON.stringify({ order_id: fresh.id, reason: 'renewal window over', months: Math.round(months) })); return null; }
    }
  }
  const amount = Math.round(fresh.amount_cents * rate / 100);
  if (amount <= 0) return null;
  const id = db.prepare('INSERT INTO commissions (partner_id, order_id, kind, basis_cents, rate, amount_cents, currency, period) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(p.id, fresh.id, kind, fresh.amount_cents, rate, amount, fresh.currency, period(fresh.paid_at)).lastInsertRowid;
  return db.prepare('SELECT * FROM commissions WHERE id=?').get(id);
}

/** A refund: reverse the order's commission if inside the clawback window (book a negative row if it was already paid). */
function clawback(order, reason) {
  const rows = commissionsForOrder(order.id).filter(c => c.kind !== 'clawback' && c.status !== 'reversed');
  if (!rows.length) return null;
  const paidAt = order.paid_at ? Date.parse(order.paid_at.replace(' ', 'T') + 'Z') : Date.now();
  if (CLAWBACK_DAYS && Date.now() - paidAt > CLAWBACK_DAYS * 86400000) { q.logEvent.run(null, null, null, 'commission_kept', JSON.stringify({ order_id: order.id, reason: 'refund after clawback window' })); return 'kept (refund after ' + CLAWBACK_DAYS + ' days)'; }
  db.transaction(() => {
    for (const c of rows) {
      if (c.status === 'paid') db.prepare('INSERT INTO commissions (partner_id, order_id, kind, basis_cents, rate, amount_cents, currency, period, status, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(c.partner_id, c.order_id, 'clawback', c.basis_cents, c.rate, -c.amount_cents, c.currency, period(), 'pending', reason || 'refund');
      else db.prepare("UPDATE commissions SET status='reversed', reversed_at=datetime('now'), note=? WHERE id=?").run(reason || 'refund', c.id);
    }
  })();
  return 'reversed';
}

function setCommissionStatus(id, status, { by } = {}) {
  const c = db.prepare('SELECT * FROM commissions WHERE id=?').get(id); if (!c) throw new Error('No such commission');
  const allowed = { pending: ['approved', 'reversed'], approved: ['paid', 'pending', 'reversed'], paid: [], reversed: ['pending'] }[c.status] || [];
  if (!allowed.includes(status)) throw new Error(`Cannot move a ${c.status} commission to ${status}`);
  const stamp = { approved: 'approved_at', paid: 'paid_at', reversed: 'reversed_at' }[status];
  db.prepare(`UPDATE commissions SET status=?${stamp ? `, ${stamp}=datetime('now')` : ''} WHERE id=?`).run(status, id);
  q.logEvent.run(null, null, null, 'commission_' + status, JSON.stringify({ id, by }));
}
function bulkStatus(ids, status, opts) { let n = 0; for (const id of ids) { try { setCommissionStatus(id, status, opts); n++; } catch {} } return n; }

function listCommissions({ partnerId, period: per, status } = {}) {
  const where = [], args = [];
  if (partnerId) { where.push('c.partner_id=?'); args.push(partnerId); }
  if (per) { where.push('c.period=?'); args.push(per); }
  if (status) { where.push('c.status=?'); args.push(status); }
  return db.prepare(`SELECT c.*, p.name partner_name, p.code partner_code, o.product_slug, o.buyer_email, o.attribution, o.paid_at FROM commissions c JOIN partners p ON p.id=c.partner_id LEFT JOIN orders o ON o.id=c.order_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.period DESC, c.id DESC`).all(...args);
}
/** Per partner per month: what is pending, approved, paid. */
/** Per partner per month: earned (gross of everything not reversed), reversed, and what is pending / approved / paid. */
function summary({ period: per, partnerId, status } = {}) {
  const where = [], args = [];
  if (per) { where.push('c.period=?'); args.push(per); }
  if (partnerId) { where.push('c.partner_id=?'); args.push(partnerId); }
  if (status) { where.push('c.status=?'); args.push(status); }
  return db.prepare(`SELECT c.period, p.id partner_id, p.name partner_name, p.code partner_code, p.type,
    SUM(CASE WHEN c.status<>'reversed' THEN c.amount_cents ELSE 0 END) net_cents,
    SUM(CASE WHEN c.status='reversed' THEN c.amount_cents ELSE 0 END) reversed_cents,
    SUM(CASE WHEN c.status='pending' THEN c.amount_cents ELSE 0 END) pending_cents, SUM(CASE WHEN c.status='approved' THEN c.amount_cents ELSE 0 END) approved_cents,
    SUM(CASE WHEN c.status='paid' THEN c.amount_cents ELSE 0 END) paid_cents, COUNT(*) n
    FROM commissions c JOIN partners p ON p.id=c.partner_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY c.period, p.id ORDER BY c.period DESC, p.name`).all(...args);
}
const periods = () => db.prepare('SELECT DISTINCT period FROM commissions ORDER BY period DESC').all().map(r => r.period);

/** Orders attributed to one partner. */
const partnerOrders = partnerId => db.prepare('SELECT o.*, pr.name product_name FROM orders o LEFT JOIN products pr ON pr.id=o.product_id WHERE o.partner_id=? ORDER BY o.id DESC LIMIT 200').all(partnerId);

function csv(rows) {
  const cols = ['id', 'period', 'partner_code', 'partner_name', 'order_id', 'kind', 'product_slug', 'paid_at', 'basis_cents', 'rate', 'amount_cents', 'currency', 'status', 'note'];
  const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n') + '\n';
}

/** Record a click on /p/<code>. Returns the partner (active or not) so the route can decide where to send the visitor. */
function click(code) { const p = partnerByCode(code); if (p) db.prepare('UPDATE partners SET clicks=clicks+1 WHERE id=?').run(p.id); return p; }

/** On account deletion: the order stays as a financial record, but nothing identifies the person any more. */
function anonymiseOrders(userId, email) {
  db.prepare('UPDATE partners SET user_id=NULL WHERE user_id=?').run(userId);
  const hash = email ? crypto.createHash('sha256').update(String(email).toLowerCase()).digest('hex').slice(0, 12) : null;
  return db.prepare("UPDATE orders SET user_id=NULL, buyer_email=?, buyer_name=NULL, metadata=NULL WHERE user_id=? OR (buyer_email IS NOT NULL AND buyer_email=?)").run(hash ? `deleted-${hash}@removed.invalid` : null, userId, String(email || '').toLowerCase()).changes;
}

/* ---------- Phase 3: partner accounts, statements, portal ---------- */
let accountsApi = null;
function setAccountsApi(fn) { accountsApi = fn; }

/** Called on every SSO sign-in / local login: a user with role partner is linked to the partner record with their email. */
function linkUser(user) {
  if (!user || user.role !== 'partner') return null;
  let p = db.prepare('SELECT * FROM partners WHERE user_id=?').get(user.id);
  if (!p && user.email) { p = db.prepare('SELECT * FROM partners WHERE email=? AND (user_id IS NULL OR user_id=?)').get(String(user.email).toLowerCase(), user.id); if (p) db.prepare('UPDATE partners SET user_id=? WHERE id=?').run(user.id, p.id); }
  return p || null;
}
/** Invite the partner to the portal: an Accounts grant with role partner (invitation email), or a local account when SSO is off. */
async function invitePartner(p) {
  if (!p.email) throw new Error('Add the partner\'s email first');
  const existing = q.userByEmail.get(p.email);
  if (existing) {
    if (existing.role !== 'partner') throw new Error(`${p.email} already has an Academy account as ${existing.role}; a partner needs their own email`);
    db.prepare('UPDATE partners SET user_id=? WHERE id=?').run(existing.id, p.id); return { user: existing, created: false };
  }
  if (accountsApi) {
    const r = await accountsApi('/grants', { method: 'POST', body: { email: p.email, name: p.contact_name || p.name, role: 'partner', invited_by: 'AI Ninjas partner programme' } });
    let u = null; for (let i = 0; i < 10; i++) { u = q.userByEmail.get(p.email); if (u) break; await new Promise(res => setTimeout(res, 300)); }
    if (!u) u = require('./auth').upsertFromSso({ sub: r.user.id, email: p.email, name: p.contact_name || p.name, role: 'partner', scope: {} });
    db.prepare('UPDATE partners SET user_id=? WHERE id=?').run(u.id, p.id);
    return { user: u, created: true, invite: r.inviteLink || null };
  }
  const info = db.prepare(`INSERT INTO users (email, name, role, status, approved_at, display_handle, organization) VALUES (?, ?, 'partner', 'approved', datetime('now'), ?, ?)`).run(p.email, p.contact_name || p.name, 'Partner' + crypto.randomInt(1000, 9999), p.name);
  db.prepare('UPDATE partners SET user_id=? WHERE id=?').run(info.lastInsertRowid, p.id);
  return { user: q.userById.get(info.lastInsertRowid), created: true, local: true };
}
function acceptTerms(p) { db.prepare("UPDATE partners SET terms_accepted_at=datetime('now') WHERE id=?").run(p.id); }
function savePayoutDetails(p, text) { db.prepare("UPDATE partners SET payout_details=?, updated_at=datetime('now') WHERE id=?").run(String(text || '').trim().slice(0, 500) || null, p.id); }

/** What the partner sees about their own sales: no buyer identity, just the order facts. */
const partnerSales = partnerId => db.prepare(`SELECT o.id, o.paid_at, o.created_at, o.status, o.amount_cents, o.currency, o.kind, o.attribution, pr.name product_name, o.product_slug,
  (SELECT amount_cents FROM commissions c WHERE c.order_id=o.id AND c.kind IN ('first','renewal') LIMIT 1) commission_cents,
  (SELECT status FROM commissions c WHERE c.order_id=o.id AND c.kind IN ('first','renewal') LIMIT 1) commission_status
  FROM orders o LEFT JOIN products pr ON pr.id=o.product_id WHERE o.partner_id=? AND o.status<>'pending' ORDER BY o.id DESC LIMIT 500`).all(partnerId);
function partnerStats(partnerId) {
  const c = db.prepare(`SELECT COALESCE(SUM(CASE WHEN status<>'reversed' THEN amount_cents END),0) earned, COALESCE(SUM(CASE WHEN status IN ('pending','approved') THEN amount_cents END),0) owed, COALESCE(SUM(CASE WHEN status='paid' THEN amount_cents END),0) paid FROM commissions WHERE partner_id=?`).get(partnerId);
  const o = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(amount_cents),0) cents FROM orders WHERE partner_id=? AND status IN ('paid','refunded','lapsed')`).get(partnerId);
  const m = db.prepare(`SELECT COUNT(*) n FROM orders WHERE partner_id=? AND status='paid' AND paid_at >= date('now','start of month')`).get(partnerId);
  return { ...c, sales_n: o.n, sales_cents: o.cents, this_month_n: m.n, clicks: (partnerById(partnerId) || {}).clicks || 0 };
}

/** Statements. One per partner per month: every approved (or clawback) commission of that period not yet on a statement. */
function createStatements(per, { by } = {}) {
  if (!/^\d{4}-\d{2}$/.test(per)) throw new Error('Month must look like 2026-10');
  const rows = db.prepare("SELECT partner_id, SUM(amount_cents) cents, COUNT(*) n, MIN(currency) currency FROM commissions WHERE period=? AND payout_id IS NULL AND (status='approved' OR (kind='clawback' AND status<>'reversed')) GROUP BY partner_id").all(per);
  const made = [];
  db.transaction(() => {
    for (const r of rows) {
      if (db.prepare('SELECT 1 FROM payouts WHERE partner_id=? AND period=? AND status<>?').get(r.partner_id, per, 'void')) continue;
      const id = db.prepare('INSERT INTO payouts (partner_id, period, amount_cents, currency) VALUES (?, ?, ?, ?)').run(r.partner_id, per, r.cents, r.currency || 'usd').lastInsertRowid;
      db.prepare("UPDATE commissions SET payout_id=? WHERE period=? AND partner_id=? AND payout_id IS NULL AND (status='approved' OR (kind='clawback' AND status<>'reversed'))").run(id, per, r.partner_id);
      made.push(id);
    }
  })();
  q.logEvent.run(null, null, null, 'statements_created', JSON.stringify({ period: per, payouts: made, by }));
  return made.map(payoutById);
}
const payoutById = id => db.prepare('SELECT py.*, p.name partner_name, p.code partner_code, p.email partner_email, p.payout_details, p.type partner_type FROM payouts py JOIN partners p ON p.id=py.partner_id WHERE py.id=?').get(id);
const listPayouts = ({ partnerId, status } = {}) => db.prepare(`SELECT py.*, p.name partner_name, p.code partner_code FROM payouts py JOIN partners p ON p.id=py.partner_id WHERE 1=1 ${partnerId ? 'AND py.partner_id=@partnerId' : ''} ${status ? 'AND py.status=@status' : ''} ORDER BY py.period DESC, p.name`).all({ partnerId, status });
const payoutLines = id => db.prepare('SELECT c.*, o.product_slug, o.paid_at order_paid_at, o.kind order_kind FROM commissions c LEFT JOIN orders o ON o.id=c.order_id WHERE c.payout_id=? ORDER BY c.id').all(id);
function markPayoutPaid(id, { reference, by } = {}) {
  const py = payoutById(id); if (!py) throw new Error('No such statement');
  if (py.status === 'paid') throw new Error('Already paid');
  db.transaction(() => {
    db.prepare("UPDATE payouts SET status='paid', paid_at=datetime('now'), reference=? WHERE id=?").run(String(reference || '').trim() || null, id);
    db.prepare("UPDATE commissions SET status='paid', paid_at=datetime('now') WHERE payout_id=? AND status<>'reversed'").run(id);
  })();
  q.logEvent.run(null, null, null, 'payout_paid', JSON.stringify({ id, reference, by }));
}
function voidPayout(id) {
  db.transaction(() => { db.prepare("UPDATE payouts SET status='void' WHERE id=? AND status='issued'").run(id); db.prepare('UPDATE commissions SET payout_id=NULL WHERE payout_id=? AND status<>?').run(id, 'paid'); })();
}
/** Months whose approved commissions are not on a statement yet (what the admin can issue). */
const unstatementedPeriods = () => db.prepare("SELECT c.period, COUNT(DISTINCT c.partner_id) partners, SUM(c.amount_cents) cents, GROUP_CONCAT(DISTINCT p.name) names FROM commissions c JOIN partners p ON p.id=c.partner_id WHERE c.payout_id IS NULL AND (c.status='approved' OR (c.kind='clawback' AND c.status<>'reversed')) GROUP BY c.period ORDER BY c.period DESC").all().map(r => ({ ...r, names: String(r.names || '').split(',').join(', ') }));

module.exports = { ensureOrderColumns, partnerByUser, proposedDeals, setAccountsApi, linkUser, invitePartner, acceptTerms, savePayoutDetails, partnerSales, partnerStats, createStatements, payoutById, listPayouts, payoutLines, markPayoutPaid, voidPayout, unstatementedPeriods, WINDOW_DAYS, CLAWBACK_DAYS, DEAL_DAYS, DEFAULT_RATES, MAIN_SITE, setStripe, partnerById, partnerByCode, partnerByPromotionCode, listPartners, savePartner, syncPromotionCode, linkFor, registerDeal, listDeals, setDealStatus, matchDeal, attribute, bookCommission, clawback, setCommissionStatus, bulkStatus, listCommissions, commissionsForOrder, summary, periods, partnerOrders, csv, click, anonymiseOrders };
