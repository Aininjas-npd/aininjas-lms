/* Upload progress for course packages.
 *
 * A plain form post gives the browser's spinner and nothing else, which is unhelpful when a
 * SCORM package is 90 MB and the wait is minutes. Any form marked data-progress is sent with
 * XMLHttpRequest instead, which reports bytes as they go, so the page can say what is happening:
 *
 *     Uploading The Disciple.zip — 34 MB of 92 MB (37%) · about 40 s left
 *     Unpacking the package and reading imsmanifest.xml…
 *
 * The request and the server are untouched: the response is the usual redirect, which the browser
 * follows internally, so we finish by going to where it landed (flash message and all).
 */
(function () {
  'use strict';

  var css = '.up-box{margin-top:12px;padding:12px 14px;border:1px solid #d9d2c2;border-radius:10px;background:#fffdf8;font-size:14px}'
    + '.up-box.err{background:#FBECEC;border-color:#C98B8B;color:#7a2020}'
    + '.up-bar{height:8px;border-radius:4px;background:#e7e2d6;overflow:hidden;margin-top:9px}'
    + '.up-bar>div{height:100%;width:0;background:#b3232f;transition:width .18s linear}'
    + '.up-foot{margin-top:7px;font-size:12.5px;opacity:.75}';

  function size(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB'; }
  function secs(s) { return s < 60 ? Math.round(s) + ' s' : Math.floor(s / 60) + ' m ' + String(Math.round(s % 60)).padStart(2, '0') + ' s'; }

  function wire(form) {
    var file = form.querySelector('input[type=file]');
    if (!file) return;

    form.addEventListener('submit', function (e) {
      if (!file.files || !file.files.length) return;          // no file: let the plain form post happen
      e.preventDefault();

      var f = file.files[0];
      var box = document.createElement('div');
      box.className = 'up-box';
      box.innerHTML = '<b class="up-msg">Starting…</b><div class="up-bar"><div></div></div><div class="up-foot">Keep this tab open until it finishes.</div>';
      form.appendChild(box);
      var msg = box.querySelector('.up-msg'), fill = box.querySelector('.up-bar > div'), foot = box.querySelector('.up-foot');
      var btn = form.querySelector('button'); if (btn) { btn.disabled = true; }

      var xhr = new XMLHttpRequest();
      var t0 = Date.now();
      xhr.open('POST', form.getAttribute('action'));
      xhr.upload.onprogress = function (ev) {
        if (!ev.lengthComputable) return;
        var pct = Math.round(100 * ev.loaded / ev.total);
        fill.style.width = pct + '%';
        var rate = ev.loaded / Math.max(0.2, (Date.now() - t0) / 1000);
        var left = rate > 0 ? (ev.total - ev.loaded) / rate : 0;
        msg.textContent = 'Uploading ' + f.name + ' — ' + size(ev.loaded) + ' of ' + size(ev.total) + ' (' + pct + '%)'
          + (pct < 98 && left > 2 ? ' · about ' + secs(left) + ' left' : '');
      };
      xhr.upload.onload = function () {
        fill.style.width = '100%';
        msg.textContent = 'Unpacking ' + f.name + ' and reading its lessons…';
        foot.textContent = 'A large package can take a minute to unpack. This page will move on by itself.';
      };
      xhr.onload = function () {
        /* The server answered with its usual redirect and the browser followed it, so what we hold
           is the finished page — flash message and all. Navigating to that URL again would fetch it
           a second time and the flash, already consumed, would be gone. So show what we were given
           and just correct the address bar. */
        var url = xhr.responseURL || window.location.href;
        var html = xhr.responseText;
        if (html && /^\s*<(!doctype|html)/i.test(html)) {
          try { window.history.replaceState(null, '', url); } catch (e) { /* different origin */ }
          document.open(); document.write(html); document.close();
        } else {
          window.location.href = url;
        }
      };
      xhr.onerror = function () {
        box.className = 'up-box err';
        msg.textContent = 'The connection dropped while uploading. Nothing was saved — check your network and try again.';
        foot.textContent = '';
        if (btn) btn.disabled = false;
      };
      xhr.send(new FormData(form));
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var forms = document.querySelectorAll('form[data-progress]');
    if (!forms.length) return;
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    Array.prototype.forEach.call(forms, wire);
  });
})();
