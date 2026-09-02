// Minimal SCORM 1.2 client wrapper used by the sample SCOs (standard API discovery algorithm).
var scorm = (function () {
  var API = null;
  function find(win) { var n = 0; while (!win.API && win.parent && win.parent !== win && n++ < 500) win = win.parent; return win.API || null; }
  function get() { if (API) return API; API = find(window); if (!API && window.opener) API = find(window.opener); return API; }
  return {
    init: function () { var a = get(); if (!a) { console.warn('No SCORM API found'); return false; } return a.LMSInitialize('') === 'true'; },
    get: function (k) { var a = get(); return a ? a.LMSGetValue(k) : ''; },
    set: function (k, v) { var a = get(); return a ? a.LMSSetValue(k, v) === 'true' : false; },
    commit: function () { var a = get(); return a ? a.LMSCommit('') : 'false'; },
    finish: function () { var a = get(); return a ? a.LMSFinish('') : 'false'; }
  };
})();
