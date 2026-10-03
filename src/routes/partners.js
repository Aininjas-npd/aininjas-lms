'use strict';
/* Partner routes. Public: /p/<CODE> referral links. Admin: partners, deals, commissions. */
const express = require('express');
const { db } = require('../db');
const commerce = require('../commerce');
const partners = require('../partners');
const { flash, requireAdmin, requireLogin } = require('../auth');

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const COOKIE = 'partner_ref';

/** Cookie header → object (cookie-parser is not mounted app-wide; this is the one cookie we read). */
function readCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
const refFromRequest = req => String(req.query.ref || readCookies(req)[COOKIE] || '').trim().toUpperCase().slice(0, 20) || null;

const pub = express.Router();

/* The partner's link. Counts the click, remembers the code for WINDOW_DAYS on this domain, and forwards to the
   marketing site (which stores ?ref itself for its Buy buttons) or straight to checkout with ?to=<product-slug>.
   No visitor data is kept: the counter is a number, the cookie is the code. */
pub.get('/p/:code', (req, res) => {
  const p = partners.click(req.params.code);
  const to = String(req.query.to || '').toLowerCase();
  if (p && p.status === 'active') {
    res.cookie(COOKIE, p.code, { maxAge: partners.WINDOW_DAYS * 86400000, httpOnly: true, sameSite: 'lax', secure: req.secure || req.get('x-forwarded-proto') === 'https' });
    if (to && commerce.productBySlug(to)) return res.redirect(302, `${BASE_URL}/buy/${to}?ref=${p.code}`);
    return res.redirect(302, `${partners.MAIN_SITE}/?ref=${encodeURIComponent(p.code)}`);
  }
  res.redirect(302, to && commerce.productBySlug(to) ? `${BASE_URL}/buy/${to}` : partners.MAIN_SITE + '/');   // unknown or paused code: plain visit
});

/* ---------- admin ---------- */
const admin = express.Router();
admin.use(requireAdmin);
const money = commerce.formatMoney;

admin.get('/partners', (req, res) => {
  const list = partners.listPartners().map(p => ({ ...p, ...partners.linkFor(p, BASE_URL) }));
  const edit = req.query.edit ? partners.partnerById(req.query.edit) : null;
  res.render('admin/partners', { title: 'Partners', partners: list, edit, defaults: partners.DEFAULT_RATES, windowDays: partners.WINDOW_DAYS, clawbackDays: partners.CLAWBACK_DAYS, stripe: { configured: commerce.configured(), test: commerce.testMode() }, money });
});
admin.post('/partners', async (req, res) => {
  try {
    const { partner, warning } = await partners.savePartner(req.body, { by: req.user.id });
    flash(req, warning ? 'error' : 'success', `${partner.name} saved${warning ? ' — ' + warning : (partner.stripe_promotion_code_id ? ` — coupon code ${partner.code} is live at checkout.` : '.')}`);
    return res.redirect('/admin/partners/' + partner.id);
  } catch (e) { flash(req, 'error', e.message); return res.redirect('/admin/partners' + (req.body.id ? '?edit=' + req.body.id : '#new')); }
});
admin.get('/partners/:id', (req, res) => {
  const p = partners.partnerById(req.params.id); if (!p) return res.sendStatus(404);
  const orders = partners.partnerOrders(p.id).map(o => ({ ...o, display: money(o.amount_cents, o.currency) }));
  const commissions = partners.listCommissions({ partnerId: p.id }).map(c => ({ ...c, display: money(c.amount_cents, c.currency) }));
  const totals = { earned: commissions.filter(c => c.status !== 'reversed').reduce((s, c) => s + c.amount_cents, 0), owed: commissions.filter(c => ['pending', 'approved'].includes(c.status)).reduce((s, c) => s + c.amount_cents, 0), paid: commissions.filter(c => c.status === 'paid').reduce((s, c) => s + c.amount_cents, 0) };
  const schools = db.prepare("SELECT DISTINCT school_slug FROM users WHERE school_slug IS NOT NULL ORDER BY 1").all().map(r => r.school_slug);
  res.render('admin/partner', { title: p.name, p: { ...p, ...partners.linkFor(p, BASE_URL) }, orders, commissions, totals, deals: partners.listDeals(p.id), schools, dealDays: partners.DEAL_DAYS, products: commerce.listProducts({ onSale: true }).filter(x => x.kind !== 'seat'), money, stripeDash: commerce.testMode() ? 'https://dashboard.stripe.com/test' : 'https://dashboard.stripe.com' });
});
admin.post('/partners/:id/deals', (req, res) => {
  try { const d = partners.registerDeal(req.params.id, req.body); flash(req, 'success', `Deal registered (${d.match_kind}: ${d.match_value}) until ${d.expires_at.slice(0, 10)}.`); }
  catch (e) { flash(req, 'error', e.message); }
  res.redirect('/admin/partners/' + req.params.id);
});
admin.post('/partners/:id/deals/:dealId/approve', (req, res) => {
  try { partners.setDealStatus(req.params.dealId, 'registered'); flash(req, 'success', 'Deal approved — it now counts for attribution.'); }
  catch (e) { flash(req, 'error', e.message); }
  res.redirect(req.get('referer') || '/admin/partners/' + req.params.id);
});
admin.post('/partners/:id/deals/:dealId/:status', (req, res) => {
  try { partners.setDealStatus(req.params.dealId, req.params.status); flash(req, 'success', 'Deal marked ' + req.params.status + '.'); }
  catch (e) { flash(req, 'error', e.message); }
  res.redirect('/admin/partners/' + req.params.id);
});
admin.post('/partners/:id/sync-code', async (req, res) => {
  const p = partners.partnerById(req.params.id); if (!p) return res.sendStatus(404);
  const w = await partners.syncPromotionCode(p, null);
  flash(req, w ? 'error' : 'success', w || (partners.partnerById(p.id).stripe_promotion_code_id ? `Coupon code ${p.code} is live at checkout.` : 'No coupon: this partner has no buyer discount (link-only).'));
  res.redirect('/admin/partners/' + p.id);
});

admin.get('/commissions', (req, res) => {
  const per = String(req.query.period || ''), status = String(req.query.status || ''), partnerId = +req.query.partner || null;
  const rows = partners.listCommissions({ period: per || null, status: status || null, partnerId }).map(c => ({ ...c, display: money(c.amount_cents, c.currency) }));
  if (req.query.format === 'csv') { res.set('Content-Type', 'text/csv'); res.set('Content-Disposition', `attachment; filename="commissions${per ? '-' + per : ''}.csv"`); return res.send(partners.csv(rows)); }
  res.render('admin/commissions', { title: 'Commissions', rows, summary: partners.summary({ period: per || null, partnerId, status: status || null }), periods: partners.periods(), period: per, status, partnerId, partnersList: partners.listPartners(), money, clawbackDays: partners.CLAWBACK_DAYS });
});
admin.post('/commissions/status', (req, res) => {
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  const status = String(req.body.status || '');
  const n = partners.bulkStatus(ids, status, { by: req.user.id });
  flash(req, n ? 'success' : 'error', n ? `${n} commission(s) marked ${status}.` : 'Nothing changed (pick rows, and only moves pending → approved → paid are allowed).');
  const back = new URLSearchParams(); if (req.body.period) back.set('period', req.body.period); if (req.body.partner) back.set('partner', req.body.partner); if (req.body.status_filter) back.set('status', req.body.status_filter);
  res.redirect('/admin/commissions' + (back.toString() ? '?' + back : ''));
});
admin.post('/commissions/:id/:status', (req, res) => {
  try { partners.setCommissionStatus(req.params.id, req.params.status, { by: req.user.id }); flash(req, 'success', 'Commission marked ' + req.params.status + '.'); }
  catch (e) { flash(req, 'error', e.message); }
  res.redirect(req.get('referer') || '/admin/commissions');
});

/* ---------- admin: statements / payouts, portal invitations, proposed deals ---------- */
admin.post('/partners/:id/invite', async (req, res) => {
  const p = partners.partnerById(req.params.id); if (!p) return res.sendStatus(404);
  try { const r = await partners.invitePartner(p); flash(req, 'success', r.created ? `${p.email} invited to the partner portal${r.local ? ' (local account — set a password via Users)' : ' — Accounts has emailed the invitation.'}` : `${p.email} already had an account; linked to this partner.`); }
  catch (e) { flash(req, 'error', e.message); }
  res.redirect('/admin/partners/' + p.id);
});
admin.get('/payouts', (req, res) => {
  const list = partners.listPayouts({ status: String(req.query.status || '') || null }).map(x => ({ ...x, display: money(x.amount_cents, x.currency) }));
  res.render('admin/payouts', { title: 'Statements & payouts', payouts: list, pending: partners.unstatementedPeriods().map(x => ({ ...x, display: money(x.cents, 'usd') })), proposed: partners.proposedDeals(), status: String(req.query.status || ''), money, clawbackDays: partners.CLAWBACK_DAYS });
});
admin.post('/payouts/create', (req, res) => {
  try { const made = partners.createStatements(String(req.body.period || ''), { by: req.user.id }); flash(req, made.length ? 'success' : 'error', made.length ? `${made.length} statement(s) issued for ${req.body.period}: ${made.map(m => m.partner_name + ' ' + money(m.amount_cents, m.currency)).join(', ')}.` : 'Nothing to issue: approve the month\'s commissions first (Commissions → select → Approve).'); }
  catch (e) { flash(req, 'error', e.message); }
  res.redirect('/admin/payouts');
});
admin.get('/payouts/:id', (req, res) => {
  const py = partners.payoutById(req.params.id); if (!py) return res.sendStatus(404);
  const lines = partners.payoutLines(py.id).map(c => ({ ...c, display: money(c.amount_cents, c.currency) }));
  if (req.query.format === 'csv') { res.set('Content-Type', 'text/csv'); res.set('Content-Disposition', `attachment; filename="statement-${py.partner_code}-${py.period}.csv"`); return res.send(partners.csv(lines.map(l => ({ ...l, partner_code: py.partner_code, partner_name: py.partner_name })))); }
  res.render('partners/statement', { title: `Statement ${py.period} — ${py.partner_name}`, py: { ...py, display: money(py.amount_cents, py.currency) }, lines, money, adminView: true, company: process.env.COMPANY_NAME || 'Neuralpath Dynamics Inc (AI Ninjas)' });
});
admin.post('/payouts/:id/paid', (req, res) => {
  try { partners.markPayoutPaid(req.params.id, { reference: req.body.reference, by: req.user.id }); flash(req, 'success', 'Statement marked paid; its commissions are now paid.'); }
  catch (e) { flash(req, 'error', e.message); }
  res.redirect('/admin/payouts');
});
admin.post('/payouts/:id/void', (req, res) => { partners.voidPayout(req.params.id); flash(req, 'success', 'Statement voided; its commissions can be re-issued.'); res.redirect('/admin/payouts'); });

/* ---------- the partner portal (/partners): a partner sees only their own numbers, never a buyer's identity ---------- */
const portal = express.Router();
portal.use(requireLogin, (req, res, next) => {
  if (req.user.role !== 'partner') return res.status(403).render('error', { title: 'Partners only', message: 'This area is for AI Ninjas partners. If you are a partner, sign in with the email your invitation was sent to.' });
  const p = partners.linkUser(req.user) || partners.partnerByUser(req.user);
  if (!p) return res.status(403).render('error', { title: 'No partner record', message: 'Your account has the partner role but no partner record uses your email. Write to partners@aininjas.com.' });
  if (p.status === 'ended') return res.status(403).render('error', { title: 'Partnership ended', message: 'This partnership has ended. Write to partners@aininjas.com if you think this is a mistake.' });
  req.partner = { ...p, ...partners.linkFor(p, BASE_URL) }; res.locals.partner = req.partner;
  if (!p.terms_accepted_at && !/^\/terms/.test(req.path)) return res.redirect('/partners/terms');
  next();
});
portal.get('/terms', (req, res) => res.render('partners/terms', { title: 'Partner terms', termsUrl: process.env.PARTNER_TERMS_URL || null, accepted: !!req.partner.terms_accepted_at }));
portal.post('/terms', (req, res) => { if (req.body.accept === 'on') { partners.acceptTerms(req.partner); flash(req, 'success', 'Thank you — welcome to the programme.'); return res.redirect('/partners'); } flash(req, 'error', 'Please tick the box to accept the terms.'); res.redirect('/partners/terms'); });
portal.get('/', (req, res) => {
  const stats = partners.partnerStats(req.partner.id);
  const recent = partners.partnerSales(req.partner.id).slice(0, 8).map(o => ({ ...o, display: money(o.amount_cents, o.currency), cdisplay: o.commission_cents != null ? money(o.commission_cents, o.currency) : null }));
  res.render('partners/home', { title: 'Partner overview', stats, recent, money, products: commerce.listProducts({ onSale: true }).filter(x => x.kind !== 'seat'), windowDays: partners.WINDOW_DAYS, clawbackDays: partners.CLAWBACK_DAYS });
});
portal.get('/sales', (req, res) => {
  const sales = partners.partnerSales(req.partner.id).map(o => ({ ...o, display: money(o.amount_cents, o.currency), cdisplay: o.commission_cents != null ? money(o.commission_cents, o.currency) : null }));
  res.render('partners/sales', { title: 'Your sales', sales, money });
});
portal.get('/commissions', (req, res) => {
  const rows = partners.listCommissions({ partnerId: req.partner.id }).map(c => ({ ...c, display: money(c.amount_cents, c.currency) }));
  const statements = partners.listPayouts({ partnerId: req.partner.id }).filter(x => x.status !== 'void').map(x => ({ ...x, display: money(x.amount_cents, x.currency) }));
  res.render('partners/commissions', { title: 'Your commissions', rows, statements, stats: partners.partnerStats(req.partner.id), money, clawbackDays: partners.CLAWBACK_DAYS });
});
portal.get('/statements/:id', (req, res) => {
  const py = partners.payoutById(req.params.id); if (!py || py.partner_id !== req.partner.id || py.status === 'void') return res.sendStatus(404);
  const lines = partners.payoutLines(py.id).map(c => ({ ...c, display: money(c.amount_cents, c.currency) }));
  if (req.query.format === 'csv') { res.set('Content-Type', 'text/csv'); res.set('Content-Disposition', `attachment; filename="statement-${py.period}.csv"`); return res.send(partners.csv(lines.map(l => ({ ...l, partner_code: py.partner_code, partner_name: py.partner_name })))); }
  res.render('partners/statement', { title: `Statement ${py.period}`, py: { ...py, display: money(py.amount_cents, py.currency) }, lines, money, adminView: false, company: process.env.COMPANY_NAME || 'Neuralpath Dynamics Inc (AI Ninjas)' });
});
portal.get('/deals', (req, res) => res.render('partners/deals', { title: 'Your deals', deals: partners.listDeals(req.partner.id), dealDays: partners.DEAL_DAYS, isAgent: req.partner.type === 'agent' }));
portal.post('/deals', (req, res) => {
  try { const d = partners.registerDeal(req.partner.id, { ...req.body, days: undefined }, { source: 'partner' }); flash(req, 'success', `Deal submitted (${d.match_kind}: ${d.match_value}). AI Ninjas will confirm it; until then it is marked proposed.`); }
  catch (e) { flash(req, 'error', e.message); }
  res.redirect('/partners/deals');
});
portal.get('/settings', (req, res) => res.render('partners/settings', { title: 'Partner settings' }));
portal.post('/settings', (req, res) => { partners.savePayoutDetails(req.partner, req.body.payout_details); flash(req, 'success', 'Saved.'); res.redirect('/partners/settings'); });

module.exports = { publicRouter: pub, adminRouter: admin, portalRouter: portal, refFromRequest };
