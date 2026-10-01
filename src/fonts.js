'use strict';
/* Serve the three brand fonts from the @fontsource-variable packages at /fonts/<family>/<file>.woff2 and the
   @font-face sheet at /fonts/fonts.css. Replaces the Google Fonts <link> so no page load calls a third party. */
const path = require('path');
const express = require('express');
const FAMILIES = { 'archivo': '@fontsource-variable/archivo', 'source-serif-4': '@fontsource-variable/source-serif-4', 'jetbrains-mono': '@fontsource-variable/jetbrains-mono' };
function mount(app, { cssPath, statik = express.static } = {}) {
  const year = { maxAge: '365d', immutable: true };
  for (const [slug, pkg] of Object.entries(FAMILIES)) {
    let dir;
    try { dir = path.join(path.dirname(require.resolve(pkg + '/package.json')), 'files'); } catch { console.warn(`[fonts] ${pkg} not installed — run npm install`); continue; }
    app.use('/fonts/' + slug, statik(dir, year));
  }
  app.get('/fonts/fonts.css', (req, res) => { res.set('Cache-Control', 'public, max-age=86400'); res.sendFile(cssPath); });
}
module.exports = { mount };
