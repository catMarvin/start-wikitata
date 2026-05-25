// wt-diag.js — one-click clipboard diagnostic token + auto-surface when page looks broken.
// Loaded with defer AFTER gate.js. Self-contained: if the inline app.html script crashed,
// this still runs (separate <script> tag) — so the chip is available exactly when we need it.
//
// 2026-05-07 v1 — basic chip + plus + auto-surface banner.
// 2026-05-08 v2 — decode tables (PG/HTTP error codes), 5-deep error tail buffer,
//                 categorized verbose output (ROUTE/AUTH/DATA/UI/ENV/ERRS/LS/SS),
//                 third "→ claude" chip that emits a Claude-ready prompt template,
//                 zero changes required to app.html (uses property descriptor on
//                 __wtLastFetchErr to fan out to ring buffer).
(function(){
  if (window.__wtDiagLoaded) return;
  window.__wtDiagLoaded = true;
  var BOOT_AT = Date.now();
  // Capture our own version from the script src `?v=…` query — bulletproof against
  // inline-script load order (window.VERSION isn't reliably set when this runs).
  var SCRIPT_VER = (function(){
    try {
      var s = document.currentScript || document.querySelector('script[src*="wt-diag.js"]');
      if (s && s.src) { var m = s.src.match(/[?&]v=([^&]+)/); if (m) return m[1]; }
    } catch(_) {}
    return null;
  })();

  // ── Decode tables ────────────────────────────────────────────────────────
  // Pre-resolve common error codes so a glance tells you "DB error: undefined column"
  // not "magic number 42703". Add codes as they're observed in the wild.
  var PG_CODES = {
    '42501':'insufficient_privilege','42703':'undefined_column','42883':'undefined_function',
    '42P01':'undefined_table','42P02':'undefined_parameter','42622':'name_too_long',
    '23502':'not_null_violation','23503':'fk_violation','23505':'unique_violation','23514':'check_violation',
    '22P02':'invalid_text_representation','22023':'invalid_parameter_value','22001':'string_too_long',
    '40001':'serialization_failure','40P01':'deadlock','25P02':'in_failed_sql_transaction',
    '08006':'connection_failure','53300':'too_many_connections','57014':'query_canceled',
    'PGRST100':'parse_error','PGRST116':'no_rows','PGRST204':'no_match','PGRST301':'jwt_expired','PGRST302':'jwt_invalid'
  };
  var HTTP_CODES = {
    400:'bad_request',401:'unauthorized',403:'forbidden',404:'not_found',
    409:'conflict',410:'gone',413:'payload_too_large',422:'unprocessable',429:'rate_limited',
    500:'server_error',502:'bad_gateway',503:'unavailable',504:'gateway_timeout'
  };

  // ── Error tail buffer ────────────────────────────────────────────────────
  // Replace single-slot __wtLastFetchErr with a ring buffer (last 5).
  // app.html sets __wtLastFetchErr = {...}; we intercept via property descriptor
  // and push to log. Fully backward-compatible — reads still return the latest.
  var ERR_LOG = [];
  var ERR_MAX = 5;
  var __backing = window.__wtLastFetchErr || null;
  if (__backing) ERR_LOG.push(__backing);
  try {
    Object.defineProperty(window, '__wtLastFetchErr', {
      configurable: true,
      set: function(e){
        __backing = e;
        if (e) {
          ERR_LOG.push(e);
          while (ERR_LOG.length > ERR_MAX) ERR_LOG.shift();
        }
      },
      get: function(){ return __backing; }
    });
  } catch(_) {}
  window.__wtFetchErrLog = ERR_LOG;

  function num(v){ return (typeof v==='number'?v:0); }
  function arrLen(name){ try { var a = window[name]; return Array.isArray(a)?a.length:'?'; } catch(_) { return '?'; } }
  function shortId(s){ return s ? String(s).slice(0,8) : ''; }
  function hh(){ var d=new Date(); return d.toTimeString().slice(0,5); }
  function hhmmss(ms){ var d=new Date(ms); return d.toTimeString().slice(0,8); }

  // Hover-tooltip primitives (v2 — verify-loaded-version requirement).
  function uptimeStr(){
    var sec = Math.floor((Date.now() - BOOT_AT) / 1000);
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.floor(sec/60) + 'm';
    return Math.floor(sec/3600) + 'h' + Math.floor((sec%3600)/60) + 'm';
  }
  function isStale(){
    // Stale = script src ?v= differs from in-page VERSION (cached JS, fresh HTML or vice versa).
    if (!SCRIPT_VER) return false;
    if (typeof window.VERSION === 'undefined') return false;
    return SCRIPT_VER !== window.VERSION;
  }
  function tooltipFor(action){
    var loaded = new Date(BOOT_AT).toTimeString().slice(0,8);
    var ver = SCRIPT_VER || (typeof window.VERSION!=='undefined' ? window.VERSION : '?');
    var head = '⚙ wt-diag ' + ver + ' (loaded ' + loaded + ' · uptime ' + uptimeStr() + ')';
    if (isStale()) head += '\n⚠ STALE — script ' + SCRIPT_VER + ' but page VERSION ' + window.VERSION + '. Hard-reload.';
    return head + '\n' + action;
  }
  function refreshTooltips(){
    try {
      var chip = document.getElementById('wt-diag-chip');
      var plus = document.getElementById('wt-diag-plus');
      var cl   = document.getElementById('wt-diag-claude');
      if (chip) { chip.title = tooltipFor('Click: copy compact diag (Cmd/Ctrl+Shift+D)'); chip.classList.toggle('stale', isStale()); }
      if (plus) { plus.title = tooltipFor('Click: copy verbose structured snapshot'); plus.classList.toggle('stale', isStale()); }
      if (cl)   { cl.title   = tooltipFor('Click: copy as Claude-ready prompt template (Cmd/Ctrl+Shift+L)'); cl.classList.toggle('stale', isStale()); }
    } catch(_) {}
  }

  // Decode one error record into {short, full} — short for inline chip, full for structured copy.
  function decodeErr(e){
    if (!e) return null;
    var status = e.status;
    var pgCode = e.body && e.body.code;
    var msg = e.body && (e.body.msg || e.body.raw || e.body.hint);
    var statusLabel = HTTP_CODES[status] || ('http_'+status);
    var pgLabel = pgCode ? (PG_CODES[pgCode] || ('pg_'+pgCode)) : null;
    var endpoint = (e.path||'').split('/').pop().split('?')[0] || '/';
    return {
      short: status + ':' + endpoint + (pgCode ? '['+pgCode+':'+(msg||'').slice(0,60).replace(/\s+/g,' ')+']' : ''),
      full: status + ' ' + statusLabel + ' · ' + (e.method||'GET') + ' ' + (e.path||'') +
            (pgLabel ? ' · pg=' + pgCode + '/' + pgLabel : '') +
            (msg ? ' · "' + String(msg).slice(0,140) + '"' : '')
    };
  }

  function snapshot(){
    var ver = SCRIPT_VER || ((typeof window.VERSION!=='undefined') ? window.VERSION : '?');
    var path = location.pathname.replace(/^\//,'/') + (location.search||'');
    var tok = (typeof window._wtAuthToken!=='undefined' && window._wtAuthToken) || '';
    var tokState = 'NONE';
    if (tok) {
      tokState = 'OK';
      try { if (typeof window._wtTokenExpired==='function' && window._wtTokenExpired(tok)) tokState='EXP'; }
      catch(_) { tokState = '?'; }
    }
    var su = null;
    try { su = JSON.parse(localStorage.getItem('wt_session_user')||sessionStorage.getItem('wt_session_user')||'null'); } catch(_) {}
    var user = (su && su.username) || null;
    var popoutId = null;
    try { popoutId = (typeof window.__wtGetPopoutId==='function') ? window.__wtGetPopoutId() : null; } catch(_) {}
    var vbatchMode = !!(document.body && document.body.classList && document.body.classList.contains('vault-batch-mode'));
    var vbatchRows = document.querySelectorAll('.vbatch-row').length;
    var gateVisible = !!document.getElementById('wt-gate');
    var pinOverlay = !!(document.getElementById('pin-overlay') && document.getElementById('pin-overlay').classList.contains('show'));
    var lastErr = ERR_LOG.length ? ERR_LOG[ERR_LOG.length-1] : null;
    var I = arrLen('allI'), CL = arrLen('allCL');
    return {
      ver: ver, time: hh(),
      path: path,
      user: user, tok: tokState,
      I: I, CL: CL,
      gate: gateVisible, pin: pinOverlay,
      popout: popoutId ? shortId(popoutId) : null,
      vbatch: vbatchMode ? vbatchRows : 0,
      err: lastErr ? decodeErr(lastErr).short : null,
      sess: !!user,
      ageMs: Date.now() - BOOT_AT
    };
  }

  // ── Compact format (unchanged contract — backward-compat for keyboard shortcut + console) ──
  function format(d){
    var head = '[wt-diag '+d.ver+' '+d.time+']';
    var bits = [];
    bits.push(d.path);
    bits.push(d.user || 'no-user');
    if (d.tok !== 'OK') bits.push('tok='+d.tok);
    if (d.I === 0 && !d.gate && !d.popout) bits.push('I=0');
    else if (typeof d.I === 'number' && d.I > 0) bits.push('I='+d.I);
    if (d.popout) bits.push('popout='+d.popout);
    if (d.vbatch) bits.push('vbatch='+d.vbatch);
    if (d.gate) bits.push('GATE');
    if (d.pin) bits.push('PIN');
    if (d.sess && d.tok !== 'OK') bits.push('staleSess');
    if (d.err) bits.push('err='+d.err);
    if (typeof d.CL === 'number' && d.CL > 0) bits.push('CL='+d.CL);
    return head+' '+bits.join(' · ');
  }

  // Bucket-encode storage keys: groups repeats by prefix (e.g. wt-draft-{uuid}*7 → wt-draft[7x]).
  function bucketKeys(keys){
    if (!keys || !keys.length) return '';
    var counts = {};
    keys.forEach(function(k){
      var prefix = k.replace(/-[0-9a-f]{4,}.*$/i,'').replace(/_[0-9a-f]{8,}.*$/i,'');
      counts[prefix] = (counts[prefix]||0) + 1;
    });
    return Object.keys(counts).map(function(p){
      return counts[p] > 1 ? (p + '[' + counts[p] + 'x]') : p;
    }).join('+');
  }

  function snapshotVerbose(){
    var d = snapshot();
    var ls = []; try { for (var k in localStorage) { if (Object.prototype.hasOwnProperty.call(localStorage,k)) ls.push(k); } } catch(_) {}
    var ss = []; try { for (var k2 in sessionStorage) { if (Object.prototype.hasOwnProperty.call(sessionStorage,k2)) ss.push(k2); } } catch(_) {}
    d.ls = bucketKeys(ls);
    d.ss = bucketKeys(ss);
    d.tokLen = (typeof window._wtAuthToken!=='undefined' && window._wtAuthToken) ? window._wtAuthToken.length : 0;
    d.online = navigator.onLine;
    d.ua = (navigator.userAgent||'').slice(-30);
    d.viewport = window.innerWidth + 'x' + window.innerHeight;
    d.cookie = document.cookie ? ('len=' + document.cookie.length) : 'none';
    d.scripts = document.querySelectorAll('script[src]').length;
    return d;
  }

  // ── Verbose format (v2: structured multi-line, decoded codes, error tail) ──
  function formatVerbose(d){
    var lines = [];
    lines.push('[wt-diag+ '+d.ver+' '+d.time+']');
    var routeBits = [d.path];
    if (d.popout) routeBits.push('popout='+d.popout);
    if (d.vbatch) routeBits.push('vbatch='+d.vbatch);
    if (d.gate) routeBits.push('GATE');
    if (d.pin) routeBits.push('PIN');
    lines.push('ROUTE: '+routeBits.join(' · '));
    var authBits = [d.user||'no-user', 'tok='+d.tok+(d.tokLen?'/'+d.tokLen:'')];
    authBits.push('sess='+(d.sess?'Y':'N'));
    lines.push('AUTH:  '+authBits.join(' · '));
    lines.push('DATA:  I='+d.I+' · CL='+d.CL);
    lines.push('UI:    vp='+d.viewport+' · scripts='+d.scripts);
    var envBits = ['ua='+d.ua, 'cookie='+d.cookie];
    if (!d.online) envBits.push('OFFLINE');
    lines.push('ENV:   '+envBits.join(' · '));
    if (ERR_LOG.length) {
      lines.push('ERRS:  ('+ERR_LOG.length+' tail, newest first)');
      var copy = ERR_LOG.slice().reverse();
      copy.forEach(function(e){
        var dec = decodeErr(e);
        lines.push('  ['+hhmmss(e.at)+'] '+(dec ? dec.full : (e.status+' '+(e.path||''))));
      });
    } else {
      lines.push('ERRS:  (none captured this session)');
    }
    if (d.ls) lines.push('LS:    '+d.ls);
    if (d.ss) lines.push('SS:    '+d.ss);
    return lines.join('\n');
  }

  // ── Claude-ready format (v2 new): structured snapshot wrapped in a prompt template ──
  function formatForClaude(d){
    var lines = [];
    lines.push("I'm debugging a wikiTaTa issue. Here's the page state:");
    lines.push("");
    lines.push("```");
    lines.push(formatVerbose(d));
    lines.push("```");
    lines.push("");
    lines.push("[describe what you expected vs. what you saw]");
    return lines.join('\n');
  }

  // ── Copy ────────────────────────────────────────────────────────────────
  // mode: 'compact' (default) | 'verbose' | 'claude'
  function copy(mode){
    var line;
    if (mode === 'verbose') line = formatVerbose(snapshotVerbose());
    else if (mode === 'claude') line = formatForClaude(snapshotVerbose());
    else line = format(snapshot());
    var ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(line);
        ok = true;
      }
    } catch(_) {}
    if (!ok) {
      try {
        var ta = document.createElement('textarea');
        ta.value = line;
        ta.style.position='fixed';
        ta.style.opacity='0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        ok = true;
      } catch(__) { ok = false; }
    }
    var btnId = mode === 'verbose' ? 'wt-diag-plus'
              : mode === 'claude'  ? 'wt-diag-claude'
                                   : 'wt-diag-chip';
    var target = document.getElementById(btnId);
    if (target) {
      var orig = target.dataset.label || target.textContent;
      target.dataset.label = orig;
      target.textContent = ok ? '✓ copied' : '✗ failed';
      target.classList.add('flash');
      setTimeout(function(){ target.textContent = orig; target.classList.remove('flash'); }, 1400);
    }
    try { console.log('[wt-diag '+(mode||'compact')+']', line); } catch(_) {}
    return line;
  }

  // ── Backward-compat alias for the old boolean signature ──
  // Old callers: copy(true) → verbose; copy() / copy(false) → compact.
  // New callers: copy('verbose') / copy('claude') / copy('compact').
  var _copyImpl = copy;
  copy = function(arg){
    if (arg === true) return _copyImpl('verbose');
    if (arg === false || arg == null) return _copyImpl('compact');
    return _copyImpl(arg);
  };

  function injectStyles(){
    if (document.getElementById('wt-diag-styles')) return;
    var css = document.createElement('style');
    css.id = 'wt-diag-styles';
    css.textContent =
      // Hidden by default. The cookie pill reveals it on hover (.wt-revealed) and
      // anchors it just above the pill; fallback corner = bottom-right.
      // Always-visible grip on EVERY screen (incl. gate + onboarding/guest overlays),
      // above all app overlays so it's reachable for diagnostics anywhere. Option buttons
      // stay collapsed (max-width:0) until the wrap is hovered.
      '#wt-diag-wrap{position:fixed;bottom:120px;right:8px;left:auto;z-index:2147483000;padding:0;display:flex;align-items:stretch;gap:3px;opacity:1;pointer-events:auto;transition:opacity .2s ease}'+
      // Edge-aware expansion: when the bar sits on the left half of the screen, expand the
      // option buttons to the RIGHT of the grip (row-reverse) so they never run off-page.
      '#wt-diag-wrap.wt-open-right{flex-direction:row-reverse}'+
      '#wt-diag-wrap.wt-revealed,#wt-diag-wrap:hover{opacity:1;pointer-events:auto}'+
      'body.popout-mode #wt-diag-wrap{right:120px;left:auto}'+
      // The HANDLE — the only thing visible by default. Hovering it opens the bar.
      '#wt-diag-grip{display:inline-flex;align-items:center;padding:4px 7px;font:700 13px/1.2 ui-monospace,monospace;color:rgba(200,200,200,.7);background:rgba(20,20,20,.75);border:1px solid rgba(150,150,150,.35);border-radius:3px;cursor:grab;user-select:none;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);letter-spacing:-1px;transition:color .15s,border-color .15s,background .15s}'+
      '#wt-diag-wrap:hover #wt-diag-grip{color:#7ab8e8;border-color:#7ab8e8;background:rgba(20,20,20,.9)}'+
      '#wt-diag-grip.stale{color:#ffb347;border-color:#ffb347}'+
      '#wt-diag-grip.alarm{color:#ffb347;border-color:#ffb347;animation:wt-diag-pulse 1.6s ease-in-out infinite}'+
      // Option buttons: collapsed to zero width by default, slide open on wrap hover.
      '#wt-diag-chip,#wt-diag-plus,#wt-diag-claude{font:600 11px/1.2 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;background:rgba(20,20,20,.65);color:rgba(220,220,220,.6);border:1px solid rgba(150,150,150,.3);cursor:pointer;user-select:none;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);white-space:nowrap;overflow:hidden;max-width:0;padding:5px 0;opacity:0;visibility:hidden;pointer-events:none;transition:max-width .26s ease,padding .26s ease,opacity .2s ease,color .15s,border-color .15s,background .15s}'+
      '#wt-diag-chip{border-radius:2px 0 0 2px}'+
      '#wt-diag-plus{border-left:none;border-radius:0;font-size:14px}'+
      '#wt-diag-claude{border-left:none;border-radius:0 2px 2px 0}'+
      '#wt-diag-wrap:hover #wt-diag-chip{max-width:140px;padding:5px 10px;opacity:1;visibility:visible;pointer-events:auto;color:#7ab8e8;border-color:#7ab8e8;background:rgba(20,20,20,.9)}'+
      '#wt-diag-wrap:hover #wt-diag-plus{max-width:48px;padding:5px 12px;opacity:1;visibility:visible;pointer-events:auto;color:#7ab8e8;border-color:#7ab8e8;background:rgba(20,20,20,.9)}'+
      '#wt-diag-wrap:hover #wt-diag-claude{max-width:140px;padding:5px 10px;opacity:1;visibility:visible;pointer-events:auto;color:#b8a07a;border-color:#b8a07a;background:rgba(30,25,15,.9)}'+
      '#wt-diag-chip:hover,#wt-diag-plus:hover,#wt-diag-claude:hover{color:#ffd57a !important;border-color:#ffd57a !important;background:rgba(40,30,10,.95) !important}'+
      // flash/alarm/stale must force the affected button visible regardless of hover.
      '#wt-diag-chip.flash,#wt-diag-plus.flash,#wt-diag-claude.flash{max-width:140px !important;padding:5px 10px !important;color:#5dd97a !important;border-color:#5dd97a !important;opacity:1 !important;visibility:visible !important;pointer-events:auto !important}'+
      '#wt-diag-chip.alarm{max-width:140px;padding:5px 10px;opacity:1;visibility:visible;pointer-events:auto;color:#ffb347;border-color:#ffb347}'+
      '#wt-diag-wrap:hover #wt-diag-chip.stale,#wt-diag-wrap:hover #wt-diag-plus.stale,#wt-diag-wrap:hover #wt-diag-claude.stale{color:#ffb347 !important;border-color:#ffb347 !important}'+
      '@keyframes wt-diag-pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,179,71,.4)}50%{box-shadow:0 0 0 6px rgba(255,179,71,0)}}'+
      '@keyframes wt-diag-stale-pulse{0%,100%{box-shadow:inset 0 -2px 0 0 rgba(255,179,71,.5)}50%{box-shadow:inset 0 -2px 0 0 rgba(255,179,71,1)}}'+
      '#wt-diag-banner{position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:99999;padding:8px 18px;background:rgba(40,30,15,.95);color:#ffb347;border:1px solid #ffb347;border-top:none;border-radius:0 0 4px 4px;font:600 12px/1.4 ui-monospace,monospace;letter-spacing:.04em;cursor:pointer;backdrop-filter:blur(6px);box-shadow:0 4px 14px rgba(0,0,0,.5)}'+
      '#wt-diag-banner:hover{background:rgba(60,45,20,.97)}';
    document.head.appendChild(css);
  }

  function injectChip(){
    if (document.getElementById('wt-diag-wrap')) return;
    if (!document.body) return;
    var wrap = document.createElement('div');
    wrap.id = 'wt-diag-wrap';
    var chip = document.createElement('button');
    chip.id = 'wt-diag-chip';
    chip.type = 'button';
    chip.title = 'Copy compact diagnostic token (Cmd/Ctrl+Shift+D)';
    chip.textContent = '⚙ wt-diag';
    chip.dataset.label = '⚙ wt-diag';
    chip.addEventListener('click', function(ev){ ev.preventDefault(); ev.stopPropagation(); copy('compact'); });
    var plus = document.createElement('button');
    plus.id = 'wt-diag-plus';
    plus.type = 'button';
    plus.title = 'Copy structured verbose snapshot (categories + decoded errors + LS/SS keys + 5-deep error tail)';
    plus.textContent = '+';
    plus.dataset.label = '+';
    plus.addEventListener('click', function(ev){ ev.preventDefault(); ev.stopPropagation(); copy('verbose'); });
    var claudeBtn = document.createElement('button');
    claudeBtn.id = 'wt-diag-claude';
    claudeBtn.type = 'button';
    claudeBtn.title = 'Copy as Claude-ready prompt template (verbose snapshot wrapped + placeholder for your description)';
    claudeBtn.textContent = '→ claude';
    claudeBtn.dataset.label = '→ claude';
    claudeBtn.addEventListener('click', function(ev){ ev.preventDefault(); ev.stopPropagation(); copy('claude'); });
    // Drag handle (the always-visible grip). Anchored bottom-right, so the grip sits
    // at the far right (the corner) and the option buttons slide open to its left.
    // Styling lives in injectStyles (#wt-diag-grip). Hover the grip → bar opens.
    var grip = document.createElement('span');
    grip.id = 'wt-diag-grip';
    grip.title = 'Hover to open the diagnostics bar';
    grip.textContent = '⋮⋮';
    // These tooltips are verbose; let them wait 1.5s (opt out of the instant-tip rule).
    [chip, plus, claudeBtn, grip].forEach(function(el){ el.setAttribute('data-tip-delay','1500'); });
    wrap.appendChild(chip);
    wrap.appendChild(plus);
    wrap.appendChild(claudeBtn);
    wrap.appendChild(grip);
    document.body.appendChild(wrap);
    // ── Grabbable grip (restored) — drag to move the bar off any text/content; position
    // persists across loads. Mirrors the cookie pill's drag. A drag suppresses the next
    // click so dragging never fires a copy. ──
    (function(){
      var KEY='wt_diag_pos';
      try{ var sp=JSON.parse(localStorage.getItem(KEY)||'null'); if(sp&&typeof sp.left==='number'){ wrap.style.left=sp.left+'px'; wrap.style.top=sp.top+'px'; wrap.style.right='auto'; wrap.style.bottom='auto'; } }catch(_){}
      var dragging=false, moved=false, sx=0, sy=0, ox=0, oy=0;
      grip.addEventListener('mousedown', function(ev){ dragging=true; moved=false; grip.style.cursor='grabbing'; var r=wrap.getBoundingClientRect(); ox=r.left; oy=r.top; sx=ev.clientX; sy=ev.clientY; ev.preventDefault(); });
      document.addEventListener('mousemove', function(ev){ if(!dragging) return; var dx=ev.clientX-sx, dy=ev.clientY-sy; if(Math.abs(dx)>3||Math.abs(dy)>3) moved=true; var nl=Math.max(0,Math.min(window.innerWidth-32, ox+dx)), nt=Math.max(0,Math.min(window.innerHeight-32, oy+dy)); wrap.style.left=nl+'px'; wrap.style.top=nt+'px'; wrap.style.right='auto'; wrap.style.bottom='auto'; });
      document.addEventListener('mouseup', function(){ if(!dragging) return; dragging=false; grip.style.cursor='grab'; if(moved){ try{ var r=wrap.getBoundingClientRect(); localStorage.setItem(KEY, JSON.stringify({left:Math.round(r.left), top:Math.round(r.top)})); }catch(_){} } });
      wrap.addEventListener('click', function(ev){ if(moved){ ev.preventDefault(); ev.stopPropagation(); moved=false; } }, true);
    })();
    // Reveal + positioning are driven by the cookie pill (partials/consent.html):
    // hovering the pill anchors this wrap just above it and toggles .wt-revealed.
    // The pill owns movement now, so wt-diag no longer self-drags.
    // Refresh tooltips on hover so uptime is live + stale state re-evaluates.
    function _wtDiagEdge(){ try{ var r=wrap.getBoundingClientRect(); wrap.classList.toggle('wt-open-right', r.left < (window.innerWidth/2)); }catch(_){} }
    wrap.addEventListener('mouseenter', function(){ _wtDiagEdge(); refreshTooltips(); });
    window.addEventListener('resize', _wtDiagEdge);
    _wtDiagEdge();
    refreshTooltips();
  }

  // Auto-surface: if the page looks broken after 3s (no items, no gate visible, no popout
  // placeholder), pulse the chip and drop a banner inviting the user to copy the token.
  function autoSurfaceCheck(){
    try {
      var d = snapshot();
      var brokenLogged = (d.tok==='NONE' || d.tok==='EXP') && d.sess && !d.gate && !d.pin && !d.popout;
      var brokenLoggedIn = d.tok==='OK' && d.I===0 && d.CL===0 && !d.gate && !d.pin && !d.popout && d.ageMs > 3500;
      if (brokenLogged || brokenLoggedIn) showBanner(d, brokenLogged ? 'Auth dropped — re-login required' : 'No data loaded');
    } catch(_) {}
  }
  function showBanner(d, label){
    if (document.getElementById('wt-diag-banner')) return;
    if (!document.body) return;
    var b = document.createElement('div');
    b.id = 'wt-diag-banner';
    var msg = document.createElement('span');
    msg.textContent = '⚠ ' + label;
    msg.style.marginRight = '12px';
    var copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = '📋 copy diag';
    copyBtn.style.cssText = 'margin-right:8px;padding:3px 10px;background:transparent;color:inherit;border:1px solid currentColor;border-radius:2px;font:inherit;cursor:pointer;letter-spacing:.04em';
    copyBtn.addEventListener('click', function(ev){ ev.stopPropagation(); copy('verbose'); });
    var resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.textContent = '🧹 reset & re-login';
    resetBtn.title = 'Clear all wt_* local state and reload — recovers from unrecoverably stale tokens';
    resetBtn.style.cssText = 'padding:3px 10px;background:rgba(255,179,71,.15);color:#ffd57a;border:1px solid #ffd57a;border-radius:2px;font:inherit;cursor:pointer;letter-spacing:.04em';
    resetBtn.addEventListener('click', function(ev){ ev.stopPropagation(); location.assign(location.pathname + '?wt-reset=1'); });
    b.appendChild(msg);
    b.appendChild(copyBtn);
    b.appendChild(resetBtn);
    document.body.appendChild(b);
    var chip = document.getElementById('wt-diag-chip');
    if (chip) chip.classList.add('alarm');
  }

  function bind(){
    injectStyles();
    injectChip();
    document.addEventListener('keydown', function(ev){
      if ((ev.metaKey||ev.ctrlKey) && ev.shiftKey && (ev.key==='D' || ev.key==='d')) {
        ev.preventDefault();
        copy('compact');
      }
      // Cmd/Ctrl+Shift+L → Claude-ready prompt (faster than mousing to the chip).
      if ((ev.metaKey||ev.ctrlKey) && ev.shiftKey && (ev.key==='L' || ev.key==='l')) {
        ev.preventDefault();
        copy('claude');
      }
    });
    setTimeout(autoSurfaceCheck, 4000);
    setTimeout(autoSurfaceCheck, 9000);
  }

  // Public surface for legacy callers + console
  window.wtDiagSnapshot = snapshot;
  window.wtDiagSnapshotVerbose = snapshotVerbose;
  window.wtDiagFormat = format;
  window.wtDiagFormatVerbose = formatVerbose;
  window.wtDiagFormatClaude = formatForClaude;
  window.wtDiagDecode = decodeErr;
  window.wtDiagCopy = copy;
  window.wtDiagToken = function(){ return format(snapshot()); };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
