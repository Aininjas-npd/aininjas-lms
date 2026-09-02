// Minimal plugin system.
// A plugin is a folder under /plugins with an index.js exporting:
//   {
//     name: 'leaderboard',
//     description: '...',
//     init(app, ctx)          -> optional; register routes: ctx.router(prefix) returns an express.Router mounted at /plugins/<prefix>
//     hooks: { 'sco:commit': fn(event), 'sco:complete': fn(event), 'user:approved': fn(event), ... }
//     widgets: { learnerDashboard(user) -> html, adminDashboard() -> html, results(user, course) -> html }
//     nav: [{ label, href, admin?: bool }]
//   }
// Events emitted by the core:
//   user:requested, user:approved, enrollment:created, sco:launch, sco:commit, sco:complete, sco:pass, sco:fail, course:complete
const fs = require('fs');
const path = require('path');

const registry = [];
const hooks = {};

function load(app, ctx) {
  const dir = path.join(__dirname, '..', 'plugins');
  if (!fs.existsSync(dir)) return;
  const enabled = (process.env.PLUGINS || '*').split(',').map(s => s.trim());
  for (const name of fs.readdirSync(dir)) {
    const entry = path.join(dir, name, 'index.js');
    if (!fs.existsSync(entry)) continue;
    if (!enabled.includes('*') && !enabled.includes(name)) continue;
    try {
      const plugin = require(entry);
      plugin.name = plugin.name || name;
      registry.push(plugin);
      for (const [evt, fn] of Object.entries(plugin.hooks || {})) (hooks[evt] ||= []).push({ plugin: plugin.name, fn });
      if (typeof plugin.init === 'function') plugin.init(app, { ...ctx, router: prefix => ctx.mountRouter(`/plugins/${prefix || plugin.name}`) });
      console.log(`[plugins] loaded "${plugin.name}"`);
    } catch (e) { console.error(`[plugins] failed to load ${name}:`, e); }
  }
}

function emit(event, payload) {
  for (const h of hooks[event] || []) {
    try { h.fn(payload); } catch (e) { console.error(`[plugins] ${h.plugin} hook ${event} failed:`, e); }
  }
}

function widgets(slot, ...args) {
  return registry.map(p => (p.widgets && p.widgets[slot]) ? safe(() => p.widgets[slot](...args), p.name) : '').filter(Boolean);
}
function nav(isAdmin) {
  return registry.flatMap(p => (p.nav || []).filter(n => !n.admin || isAdmin));
}
function safe(fn, name) { try { return fn(); } catch (e) { console.error(`[plugins] ${name} widget failed:`, e); return ''; } }

module.exports = { load, emit, widgets, nav, list: () => registry };
