/* AI Ninjas catalog embed for www.aininjas.com.
   One tag on any page:  <script src="https://academy.aininjas.com/embed/catalog.js" async></script>
   Then, in the HTML:
     <span data-aininjas-price="python-for-ai">$49</span>          ← text replaced with the live price
     <a data-aininjas-buy="python-for-ai" href="#">Buy</a>         ← href set to the Academy's checkout link
     <span data-aininjas-courses="full-curriculum"></span>         ← optional: comma-separated course titles
   A partner reference (?ref=code on any page) is remembered for 60 days and appended to every Buy link, so the
   Academy can attribute the sale (Phase 2). Nothing else is stored; no cookies are set by this script. */
(function () {
  var base = (document.currentScript && document.currentScript.src.replace(/\/embed\/catalog\.js.*$/, '')) || 'https://academy.aininjas.com';
  var REF_KEY = 'aininjas_ref', REF_DAYS = 60;
  function ref() {
    try {
      var m = /[?&]ref=([A-Za-z0-9_-]{2,40})/.exec(location.search);
      if (m) { localStorage.setItem(REF_KEY, JSON.stringify({ code: m[1], exp: Date.now() + REF_DAYS * 864e5 })); return m[1]; }
      var saved = JSON.parse(localStorage.getItem(REF_KEY) || 'null');
      if (saved && saved.exp > Date.now()) return saved.code;
    } catch (e) {}
    return null;
  }
  function apply(cat) {
    var byslug = {}; (cat.products || []).forEach(function (p) { byslug[p.slug] = p; });
    var r = ref();
    document.querySelectorAll('[data-aininjas-price]').forEach(function (el) { var p = byslug[el.getAttribute('data-aininjas-price')]; if (p) el.textContent = p.display_price; });
    document.querySelectorAll('[data-aininjas-courses]').forEach(function (el) { var p = byslug[el.getAttribute('data-aininjas-courses')]; if (p) el.textContent = p.courses.map(function (c) { return c.title; }).join(', '); });
    document.querySelectorAll('[data-aininjas-buy]').forEach(function (el) {
      var p = byslug[el.getAttribute('data-aininjas-buy')];
      if (!p) { el.setAttribute('aria-disabled', 'true'); el.title = 'Not available right now'; return; }
      el.setAttribute('href', p.buy_url + (r ? '?ref=' + encodeURIComponent(r) : ''));
      if (!cat.checkout_available) { el.setAttribute('aria-disabled', 'true'); el.title = 'Online purchase opens soon'; }
    });
    document.documentElement.setAttribute('data-aininjas-catalog', 'ready');
  }
  var x = new XMLHttpRequest();
  x.open('GET', base + '/api/catalog'); x.onload = function () { if (x.status === 200) { try { apply(JSON.parse(x.responseText)); } catch (e) {} } }; x.send();
})();
