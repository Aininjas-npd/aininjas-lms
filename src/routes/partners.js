'use strict';
/* Partner routes. Public: /p/<CODE> referral links. Admin: partners, deals, commissions. */
const express = require('express');
const { db } = require('../db');
const commerce = require('../commerce');
const partners = require('../partners');
const { flash, requireAdmin } = require('../auth');

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
  res.render('admin/commissions', { title: 'Commissions', rows, summary: partners.summary({ period: per || null }), periods: partners.periods(), period: per, status, partnerId, partnersList: partners.listPartners(), money, clawbackDays: partners.CLAWBACK_DAYS });
});
admin.post('/commissions/status', (req, res) => {
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  const status = String(req.body.status || '');
  const n = partners.bulkStatus(ids, status, { by: req.user.id });
  flash(req, n ? 'success' : 'error', n ? `${n} commission(s) marked ${status}.` : 'Nothing changed (pick rows, and only moves pending → approved → paid are allowed).');
  res.redirect('/admin/commissions' + (req.body.period ? '?period=' + encodeURIComponent(req.body.period) : ''));
});
admin.post('/commissions/:id/:status', (req, res) => {
  try { partners.setCommissionStatus(req.params.id, req.params.status, { by: req.user.id }); flash(req, 'success', 'Commission marked ' + req.params.status + '.'); }
  catch (e) { flash(req, 'error', e.message); }
  res.redirect(req.get('referer') || '/admin/commissions');
});

module.exports = { publicRouter: pub, adminRouter: admin, refFromRequest };
