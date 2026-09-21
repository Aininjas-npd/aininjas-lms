/* Import a package from a URL.
 *
 * The form posts a link rather than a file, gets a job id back straight away, and then this polls
 * until the server says it is done. Nothing is held open, so a two-gigabyte package can take as
 * long as it likes:
 *
 *     Downloading from Google Drive
 *     1.2 GB of 2.5 GB at 94 MB/s · about 14 s left
 *     ───────────────────────────────────────────
 *
 * Marked up as form[data-sideload]; it shares the .up-box styling with upload-progress.js.
 */
(function () {
  'use strict';

  var POLL_MS = 1000;

  function wire(form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var url = form.querySelector('[name=package_url]');
      if (!url || !url.value.trim()) return;

      var box = form.querySelector('.up-box');
      if (!box) {
        box = document.createElement('div');
        box.className = 'up-box';
        form.appendChild(box);
      }
      box.className = 'up-box';
      box.innerHTML = '<b class="up-msg">Starting…</b><div class="up-bar"><div></div></div><div class="up-foot">You can leave this page — the import carries on. Come back to Courses to see it.</div>';
      var msg = box.querySelector('.up-msg'), fill = box.querySelector('.up-bar > div'), foot = box.querySelector('.up-foot');
      var btn = form.querySelector('button'); if (btn) btn.disabled = true;

      function stop(cls, text, extra) {
        box.className = 'up-box' + (cls ? ' ' + cls : '');
        msg.textContent = text;
        foot.innerHTML = extra || '';
        var bar = box.querySelector('.up-bar'); if (bar && cls === 'err') bar.remove();
        if (btn) btn.disabled = false;
      }

      fetch(form.getAttribute('action'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(new FormData(form)).toString(),
        credentials: 'same-origin'
      })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
        .then(function (r) {
          if (!r.ok || !r.body.jobId) throw new Error((r.body && r.body.error) || 'the server would not start the import');
          poll(r.body.jobId);
        })
        .catch(function (err) { stop('err', err.message); });

      function poll(id) {
        fetch('/admin/jobs/' + id, { credentials: 'same-origin' })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (j.error && !j.state) throw new Error(j.error);
            msg.textContent = j.step;
            foot.textContent = j.note || 'Elapsed ' + j.elapsedSec + ' s. You can leave this page — the import carries on.';
            if (j.pct !== null && j.pct !== undefined) { fill.style.width = j.pct + '%'; }
            else { fill.style.width = '100%'; fill.style.opacity = '.45'; }

            if (j.state === 'running') return setTimeout(function () { poll(id); }, POLL_MS);
            if (j.state === 'error') return stop('err', j.error);
            stop('ok', j.message || 'Done.',
              j.redirect ? '<a href="' + j.redirect + '">Open the course →</a>' : '');
            if (j.redirect) setTimeout(function () { window.location.href = j.redirect; }, 2500);
          })
          .catch(function (err) { stop('err', err.message); });
      }
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var forms = document.querySelectorAll('form[data-sideload]');
    if (!forms.length) return;
    var st = document.createElement('style');
    /* The base .up-box rules also live in upload-progress.js; repeated here so a page that only
       offers the URL form still gets them. Identical declarations, so order does not matter. */
    st.textContent = '.up-box{margin-top:12px;padding:12px 14px;border:1px solid #d9d2c2;border-radius:10px;background:#fffdf8;font-size:14px}'
      + '.up-box.err{background:#FBECEC;border-color:#C98B8B;color:#7a2020}'
      + '.up-bar{height:8px;border-radius:4px;background:#e7e2d6;overflow:hidden;margin-top:9px}'
      + '.up-bar>div{height:100%;width:0;background:#b3232f;transition:width .18s linear}'
      + '.up-foot{margin-top:7px;font-size:12.5px;opacity:.75}'
      + '.up-box.ok{background:#EEF7EE;border-color:#9DC49D;color:#1f5720}'
      + '.up-box.ok .up-bar>div{background:#3f8c41}';
    document.head.appendChild(st);
    Array.prototype.forEach.call(forms, wire);
  });
})();
