/*  SCORM 1.2 Run-Time Environment adapter (window.API)
 *  Exposed on the player page; the course runs inside an <iframe> and discovers
 *  window.parent.API per the SCORM 1.2 API discovery algorithm.
 *  Persists to POST /api/runtime/:scoId/commit
 */
(function () {
  var CFG = window.SCORM_PLAYER_CONFIG;          // { scoId, initialData, commitUrl, masteryScore, launchData }
  var ERR = {
    0: 'No error', 101: 'General exception', 201: 'Invalid argument error', 202: 'Element cannot have children',
    203: 'Element not an array - cannot have count', 301: 'Not initialized', 401: 'Not implemented error',
    402: 'Invalid set value, element is a keyword', 403: 'Element is read only', 404: 'Element is write only',
    405: 'Incorrect data type'
  };
  var initialized = false, terminated = false, lastError = 0, dirty = false, startTime = null;
  var cmi = buildModel(CFG.initialData || {});

  function buildModel(d) {
    return {
      core: {
        student_id: String(d.student_id || ''), student_name: String(d.student_name || ''),
        lesson_location: d.lesson_location || '', credit: 'credit',
        lesson_status: d.lesson_status || 'not attempted', entry: d.entry || 'ab-initio',
        score: { raw: nz(d.score_raw), min: nz(d.score_min), max: nz(d.score_max) },
        total_time: d.total_time || '0000:00:00.00', lesson_mode: 'normal', exit: '', session_time: '0000:00:00.00'
      },
      suspend_data: d.suspend_data || '', launch_data: d.launch_data || CFG.launchData || '', comments: d.comments || '',
      comments_from_lms: d.comments_from_lms || '',
      objectives: d.objectives || [], interactions: d.interactions || [],
      student_data: { mastery_score: nz(CFG.masteryScore), max_time_allowed: d.max_time_allowed || '', time_limit_action: d.time_limit_action || '' },
      student_preference: { audio: d.audio || '0', language: d.language || '', speed: d.speed || '0', text: d.text || '0' }
    };
  }
  function nz(v) { return v == null ? '' : String(v); }
  function setErr(c) { lastError = c; return c === 0 ? 'true' : 'false'; }

  var READONLY = /^cmi\.(core\.(student_id|student_name|credit|entry|total_time|lesson_mode)|launch_data|comments_from_lms|student_data\..*|_version)$/;
  var WRITEONLY = /^cmi\.core\.(exit|session_time)$/;
  var CHILDREN = {
    'cmi._children': 'core,suspend_data,launch_data,comments,objectives,student_data,student_preference,interactions',
    'cmi.core._children': 'student_id,student_name,lesson_location,credit,lesson_status,entry,score,total_time,lesson_mode,exit,session_time',
    'cmi.core.score._children': 'raw,min,max',
    'cmi.objectives._children': 'id,score,status',
    'cmi.student_data._children': 'mastery_score,max_time_allowed,time_limit_action',
    'cmi.student_preference._children': 'audio,language,speed,text',
    'cmi.interactions._children': 'id,objectives,time,type,correct_responses,weighting,student_response,result,latency'
  };

  function getValue(el) {
    if (CHILDREN[el] !== undefined) return CHILDREN[el];
    if (el === 'cmi._version') return '3.4';
    if (el === 'cmi.objectives._count') return String(cmi.objectives.length);
    if (el === 'cmi.interactions._count') return String(cmi.interactions.length);
    var m;
    if ((m = el.match(/^cmi\.objectives\.(\d+)\.(id|status|score\.(raw|min|max))$/))) {
      var o = cmi.objectives[+m[1]]; if (!o) { lastError = 201; return ''; }
      return m[2] === 'id' ? (o.id || '') : m[2] === 'status' ? (o.status || '') : ((o.score || {})[m[3]] || '');
    }
    if ((m = el.match(/^cmi\.interactions\.(\d+)\.(objectives|correct_responses)\._count$/))) {
      var it = cmi.interactions[+m[1]]; if (!it) { lastError = 201; return ''; }
      return String((it[m[2]] || []).length);
    }
    if (/^cmi\.interactions\./.test(el)) { lastError = 404; return ''; }   // write-only in 1.2
    if (WRITEONLY.test(el)) { lastError = 404; return ''; }
    var parts = el.split('.'); if (parts[0] !== 'cmi') { lastError = 201; return ''; }
    var cur = cmi;
    for (var i = 1; i < parts.length; i++) { if (cur == null || typeof cur !== 'object' || !(parts[i] in cur)) { lastError = 201; return ''; } cur = cur[parts[i]]; }
    if (typeof cur === 'object') { lastError = 201; return ''; }
    return String(cur);
  }

  function setValue(el, val) {
    val = String(val);
    if (CHILDREN[el] !== undefined || /_count$/.test(el)) return setErr(402);
    if (READONLY.test(el)) return setErr(403);
    var m;
    if (el === 'cmi.core.lesson_status') {
      if (!/^(passed|completed|failed|incomplete|browsed|not attempted)$/.test(val)) return setErr(405);
      cmi.core.lesson_status = val; dirty = true; return setErr(0);
    }
    if (el === 'cmi.core.exit') { if (!/^(time-out|suspend|logout|)$/.test(val)) return setErr(405); cmi.core.exit = val; return setErr(0); }
    if (el === 'cmi.core.session_time') { if (!/^\d{2,4}:\d{2}:\d{2}(\.\d{1,2})?$/.test(val)) return setErr(405); cmi.core.session_time = val; dirty = true; return setErr(0); }
    if ((m = el.match(/^cmi\.core\.score\.(raw|min|max)$/))) { if (val !== '' && isNaN(Number(val))) return setErr(405); cmi.core.score[m[1]] = val; dirty = true; return setErr(0); }
    if (el === 'cmi.core.lesson_location') { cmi.core.lesson_location = val.slice(0, 255); dirty = true; return setErr(0); }
    if (el === 'cmi.suspend_data') { cmi.suspend_data = val.slice(0, 4096); dirty = true; return setErr(0); }
    if (el === 'cmi.comments') { cmi.comments = (cmi.comments + val).slice(0, 4096); dirty = true; return setErr(0); }
    if ((m = el.match(/^cmi\.student_preference\.(audio|language|speed|text)$/))) { cmi.student_preference[m[1]] = val; dirty = true; return setErr(0); }
    if ((m = el.match(/^cmi\.objectives\.(\d+)\.(id|status|score\.(raw|min|max))$/))) {
      var idx = +m[1]; if (idx > cmi.objectives.length) return setErr(201);
      var o = cmi.objectives[idx] || (cmi.objectives[idx] = { id: '', status: '', score: { raw: '', min: '', max: '' } });
      if (m[2] === 'id') o.id = val; else if (m[2] === 'status') o.status = val; else o.score[m[3]] = val;
      dirty = true; return setErr(0);
    }
    if ((m = el.match(/^cmi\.interactions\.(\d+)\.(id|time|type|weighting|student_response|result|latency|objectives\.(\d+)\.id|correct_responses\.(\d+)\.pattern)$/))) {
      var ii = +m[1]; if (ii > cmi.interactions.length) return setErr(201);
      var it = cmi.interactions[ii] || (cmi.interactions[ii] = { id: '', objectives: [], time: '', type: '', correct_responses: [], weighting: '', student_response: '', result: '', latency: '' });
      if (m[3] !== undefined) { (it.objectives[+m[3]] = it.objectives[+m[3]] || {}).id = val; }
      else if (m[4] !== undefined) { (it.correct_responses[+m[4]] = it.correct_responses[+m[4]] || {}).pattern = val; }
      else it[m[2]] = val;
      dirty = true; return setErr(0);
    }
    return setErr(201);
  }

  function snapshot(finishing) {
    var elapsed = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;
    return { cmi: cmi, finishing: !!finishing, elapsed_seconds: elapsed };
  }

  function commit(finishing, useBeacon) {
    var body = JSON.stringify(snapshot(finishing));
    try {
      if (useBeacon && navigator.sendBeacon) {
        navigator.sendBeacon(CFG.commitUrl, new Blob([body], { type: 'application/json' }));
      } else {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', CFG.commitUrl, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onload = function () { if (xhr.status === 200) { try { var r = JSON.parse(xhr.responseText); if (window.onScormProgress) window.onScormProgress(r); } catch (e) {} } };
        xhr.send(body);
      }
      dirty = false;
      return true;
    } catch (e) { console.error('[SCORM] commit failed', e); return false; }
  }

  window.API = {
    LMSInitialize: function () {
      if (initialized) return setErr(101);
      initialized = true; terminated = false; startTime = Date.now();
      if (cmi.core.lesson_status === 'not attempted') { cmi.core.lesson_status = 'incomplete'; dirty = true; }
      commit(false);
      return setErr(0);
    },
    LMSFinish: function () {
      if (!initialized) return setErr(301);
      commit(true); initialized = false; terminated = true;
      if (window.onScormFinish) window.onScormFinish();
      return setErr(0);
    },
    LMSGetValue: function (el) { if (!initialized) { lastError = 301; return ''; } lastError = 0; return getValue(String(el)); },
    LMSSetValue: function (el, val) { if (!initialized) return setErr(301); return setValue(String(el), val); },
    LMSCommit: function () { if (!initialized) return setErr(301); commit(false); return setErr(0); },
    LMSGetLastError: function () { return String(lastError); },
    LMSGetErrorString: function (c) { return ERR[+c] || ''; },
    LMSGetDiagnostic: function (c) { return ERR[+c] || 'No diagnostic available'; }
  };

  // Safety nets: courses often forget LMSFinish; flush on unload / tab hide.
  window.addEventListener('beforeunload', function () { if (initialized) commit(true, true); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden' && initialized && dirty) commit(false); });
  setInterval(function () { if (initialized && dirty) commit(false); }, 30000);   // periodic autosave
})();
