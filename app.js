/* ============================================================
   App Runtime — shared core
   (apiRequest, dataAdapter, showLoading, showError, mount, debounce, throttle)
   ============================================================ */

/* =============================================================================
   app-runtime.js  ·  shared delivery layer for this template pack
   -----------------------------------------------------------------------------
   Every page in this pack loads this ONE file. It gives each template the same
   production-shaped plumbing:

     • apiRequest(url, options)      typed fetch wrapper (timeout / token / errors)
     • dataAdapter.request()        the swappable seam between UI and data
     • showLoading / hideLoading     skeleton state
     • showError(container, msg, retry)   recoverable error state
     • mount()                      skeleton -> request -> render / retry
     • debounce / throttle          search + resize guards
     • store                        localStorage with a safe fallback

   There is NO backend in this pack. `mock` mode fakes latency and failures so
   the loading and retry states are actually demonstrable. Flip `mode` to
   `remote` (or call Pack.setDataMode('remote')) and the very same code path
   runs a real fetch through apiRequest. The UI does not change.
   ========================================================================== */
(function (global) {
  'use strict';

  var CFG_KEY = 'pack.runtime.v1';
  var DEFAULTS = { mode: 'mock', latency: 480, failMode: 'none',
                   baseURL: '/api', timeout: 8000, forceFail: false, failNext: false };
  var cfg = readCfg();

  function readCfg() {
    try {
      var raw = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
      var out = {}, k;
      for (k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k))
        out[k] = raw[k] === undefined ? DEFAULTS[k] : raw[k];
      return out;
    } catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function saveCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {} }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------------------------------------------------------------------
     1 · Typed errors. A string is not an error contract.
     ------------------------------------------------------------------------- */
  function ApiError(kind, message, status, url, retryable, meta) {
    this.name = 'ApiError'; this.kind = kind; this.message = message;
    this.status = status || 0; this.url = url || '';
    this.retryable = retryable !== false; this.meta = meta || {};
    this.code = kind + (status ? ' · HTTP ' + status : '') + (url ? ' · ' + url : '');
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  var HTTP_MSG = {
    400: 'The server could not read that request.',
    401: 'Your session expired. Please sign in again.',
    403: 'This workspace does not have access to that resource.',
    404: 'We could not find that endpoint.',
    408: 'The server gave up waiting. Try again.',
    409: 'That record changed while you were editing it.',
    422: 'Some fields did not validate.',
    429: 'Too many requests. Give it a moment.',
    500: 'The server hit an unexpected error.',
    502: 'An upstream service is unavailable.',
    503: 'The service is briefly down for maintenance.'
  };

  /* ---------------------------------------------------------------------------
     2 · apiRequest — an Axios-shaped fetch wrapper with zero dependencies.
     ------------------------------------------------------------------------- */
  function apiRequest(url, options) {
    options = options || {};
    var timeout = options.timeout == null ? cfg.timeout : options.timeout;
    var method = String(options.method || 'GET').toUpperCase();
    var headers = new Headers(options.headers || {});
    var token = options.token === undefined ? store.get('token') : options.token;

    if (token) headers.set('Authorization', 'Bearer ' + token);
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');

    var body = options.body;
    var isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    var isBlob = typeof Blob !== 'undefined' && body instanceof Blob;
    var isParams = typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams;
    if (body != null && typeof body !== 'string' && !isForm && !isBlob && !isParams) {
      body = JSON.stringify(body);
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    }

    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timedOut = false, cancelled = false;
    function onAbort() { cancelled = true; if (ctrl) ctrl.abort(); }
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    var timer = setTimeout(function () { timedOut = true; if (ctrl) ctrl.abort(); }, timeout);

    var init = { method: method, headers: headers,
                 credentials: options.credentials || 'same-origin',
                 cache: options.cache || 'no-store' };
    if (ctrl) init.signal = ctrl.signal;
    if (body != null && method !== 'GET' && method !== 'HEAD') init.body = body;

    return fetch(url, init).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) {
        var kind = res.status === 401 ? 'UNAUTHORIZED' : res.status === 403 ? 'FORBIDDEN' :
                   res.status >= 500 ? 'SERVER_ERROR' : 'HTTP_ERROR';
        if (res.status === 401) store.remove('token');
        return Promise.reject(new ApiError(kind,
          HTTP_MSG[res.status] || ('Request failed with HTTP ' + res.status + '.'),
          res.status, url,
          res.status >= 500 || res.status === 408 || res.status === 429,
          { statusText: res.statusText }));
      }
      var parse = options.parse || 'auto';
      var ct = res.headers.get('content-type') || '';
      var payload;
      if (res.status === 204 || method === 'HEAD') payload = Promise.resolve(null);
      else if (parse === 'text' || (parse === 'auto' && ct.indexOf('application/json') < 0)) payload = res.text();
      else payload = res.json().catch(function () {
        return Promise.reject(new ApiError('PARSE', 'The response was not valid JSON.', res.status, url, true, {}));
      });
      return payload.then(function (data) {
        return { data: data, status: res.status, headers: res.headers, url: url };
      });
    }).catch(function (err) {
      clearTimeout(timer);
      if (err instanceof ApiError) return Promise.reject(err);
      if (timedOut) return Promise.reject(new ApiError('TIMEOUT',
        'Request timed out after ' + timeout + 'ms. Check the connection and try again.', 0, url, true, {}));
      if (cancelled || err.name === 'AbortError')
        return Promise.reject(new ApiError('ABORTED', 'Request was cancelled.', 0, url, false, {}));
      return Promise.reject(new ApiError('NETWORK',
        'Network unreachable — you appear to be offline, or the server refused the connection.',
        0, url, true, { cause: String(err && err.message || err) }));
    }).finally(function () {
      clearTimeout(timer);
      if (options.signal && options.signal.removeEventListener)
        options.signal.removeEventListener('abort', onAbort);
    });
  }

  /* ---------------------------------------------------------------------------
     3 · dataAdapter — the one seam a backend developer has to replace.
     ------------------------------------------------------------------------- */
  var FAILS = {
    '401': { kind: 'UNAUTHORIZED', status: 401, msg: HTTP_MSG[401] },
    '403': { kind: 'FORBIDDEN', status: 403, msg: HTTP_MSG[403] },
    '500': { kind: 'SERVER_ERROR', status: 500, msg: HTTP_MSG[500] },
    'timeout': { kind: 'TIMEOUT', status: 0, msg: 'Request timed out after ' + cfg.timeout + 'ms. Check the connection and try again.' },
    'network': { kind: 'NETWORK', status: 0, msg: 'Network unreachable — you appear to be offline, or the server refused the connection.' },
    'parse': { kind: 'PARSE', status: 200, msg: 'The response was not valid JSON.' }
  };

  function failure() {
    var mode = cfg.failMode;
    if (cfg.failNext) { cfg.failNext = false; saveCfg(); mode = cfg.forceFail ? mode : (mode === 'none' ? '500' : mode); }
    if (!cfg.forceFail && mode === 'none') return null;
    var f = FAILS[mode] || FAILS['500'];
    return new ApiError(f.kind, f.msg, f.status, cfg.baseURL + '/bootstrap', f.kind !== 'PARSE', {});
  }

  var dataAdapter = {
    /* Return the config so a developer can inspect it in DevTools. */
    get config() { return cfg; },

    /* MOCK: simulate a real round trip, including a recoverable failure. */
    fetchMockData: function (endpoint, payload) {
      var latency = Number(cfg.latency) || 0;
      if (cfg.failMode === 'timeout' && (cfg.forceFail || cfg.failNext)) latency = Math.min(latency, 220);
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          var err = failure();
          if (err) return reject(err);
          resolve({ data: { ok: true, endpoint: endpoint, payload: payload || null,
                            generatedAt: new Date().toISOString(),
                            latencyMs: latency },
                    status: 200, url: cfg.baseURL + endpoint });
        }, latency);
      });
    },

    /* REMOTE: the exact same contract, backed by a real HTTP request. */
    fetchRemoteData: function (endpoint, options) {
      return apiRequest(cfg.baseURL + endpoint, options || {});
    },

    request: function (endpoint, options) {
      options = options || {};
      if (cfg.mode === 'remote') return dataAdapter.fetchRemoteData(endpoint, options);
      return dataAdapter.fetchMockData(endpoint, options.payload);
    },

    /* One-line switch used by the built-in demo panel. */
    setMode: function (mode) { cfg.mode = mode === 'remote' ? 'remote' : 'mock'; saveCfg(); return cfg.mode; }
  };

  /* ---------------------------------------------------------------------------
     4 · UI state feedback — injected styles, no extra stylesheet to ship.
     ------------------------------------------------------------------------- */
  var cssDone = false;
  function injectCSS() {
    if (cssDone) return; cssDone = true;
    var css = [
      '.pack-layer{position:absolute;inset:0;z-index:900;display:flex;align-items:flex-start;',
      'justify-content:center;padding:28px 18px;overflow:hidden;',
      'background:rgba(13,16,20,.94);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);}',
      'body.pack-light .pack-layer{background:rgba(250,247,241,.96);}',
      '.pack-box{width:100%;max-width:620px;margin:0 auto;}',
      '.pack-cap{display:flex;align-items:center;gap:9px;font:600 12px/1.2 system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
      'letter-spacing:.06em;text-transform:uppercase;color:#8b97a5;margin:0 0 18px;}',
      '.pack-spin{width:13px;height:13px;border-radius:50%;border:2px solid rgba(120,140,160,.28);border-top-color:#5ac8b0;',
      'animation:pack-spin .7s linear infinite;}',
      '@keyframes pack-spin{to{transform:rotate(360deg)}}',
      '.pack-bone{height:13px;border-radius:5px;margin-bottom:11px;position:relative;overflow:hidden;background:rgba(140,155,170,.13);}',
      '.pack-bone:after{content:"";position:absolute;inset:0;transform:translateX(-100%);',
      'background:linear-gradient(90deg,transparent,rgba(255,255,255,.13),transparent);animation:pack-sh 1.35s infinite;}',
      '@keyframes pack-sh{to{transform:translateX(100%)}}',
      '.pack-bone.w40{width:40%}.pack-bone.w62{width:62%}.pack-bone.w85{width:85%}.pack-bone.h34{height:34px}',
      '.pack-bone.h92{height:92px}.pack-bone.h140{height:140px}',
      '.pack-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:11px;margin:16px 0 22px;}',
      '.pack-grid .pack-bone{margin:0;height:64px}',
      '.pack-err{max-width:480px;margin:6vh auto 0;padding:24px;border-radius:14px;',
      'background:rgba(120,32,38,.16);border:1px solid rgba(226,96,104,.45);',
      'color:#f3e7e7;font:14px/1.55 system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}',
      'body.pack-light .pack-err{background:#fff4f3;border-color:#e2b1ad;color:#5a2224;}',
      '.pack-err h4{margin:0 0 8px;font-size:16px;letter-spacing:-.01em;color:#ff9ba0}',
      'body.pack-light .pack-err h4{color:#a02c31}',
      '.pack-err .pack-code{margin:12px 0 18px;padding:9px 11px;border-radius:7px;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;',
      'word-break:break-all;background:rgba(0,0,0,.24);color:#d3a5a8}',
      'body.pack-light .pack-err .pack-code{background:#f5e4e2;color:#8b4b4b}',
      '.pack-err .pack-acts{display:flex;gap:9px;flex-wrap:wrap}',
      '.pack-err button{font:600 13px system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;cursor:pointer;',
      'border-radius:8px;padding:9px 16px;border:1px solid transparent}',
      '.pack-retry{background:#d9534f;color:#fff}.pack-retry:hover{background:#c64541}',
      '.pack-dismiss{background:transparent;border-color:rgba(226,96,104,.45)!important;color:inherit}',
      '.pack-pill{position:fixed;right:14px;bottom:14px;z-index:950;display:flex;align-items:center;gap:7px;',
      'padding:7px 11px;border-radius:999px;cursor:pointer;opacity:.5;transition:opacity .2s;',
      'background:#1b2026;color:#d5dde4;border:1px solid rgba(255,255,255,.13);',
      'font:600 11px system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
      'box-shadow:0 6px 22px rgba(0,0,0,.28)}',
      '.pack-pill:hover,.pack-pill.open{opacity:1}',
      '.pack-pill i{width:6px;height:6px;border-radius:50%;background:#5ac8b0;display:block}',
      '.pack-panel{position:fixed;right:14px;bottom:52px;z-index:951;width:262px;padding:16px;border-radius:14px;',
      'background:#1b2026;color:#e6edf3;border:1px solid rgba(255,255,255,.13);display:none;',
      'box-shadow:0 18px 50px rgba(0,0,0,.42);font:12px/1.5 system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
      '.pack-panel.open{display:block}',
      '.pack-panel h5{margin:0 0 4px;font-size:13px}.pack-panel p{margin:0 0 13px;color:#93a0ad;font-size:11px}',
      '.pack-panel label{display:block;margin:9px 0 4px;color:#9aa8b5;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase}',
      '.pack-panel select,.pack-panel input{width:100%;padding:7px 9px;border-radius:7px;background:#10151a;',
      'color:#e6edf3;border:1px solid rgba(255,255,255,.14);font:inherit}',
      '.pack-panel .pack-btns{display:flex;gap:7px;margin-top:13px;flex-wrap:wrap}',
      '.pack-panel button{flex:1;min-width:88px;padding:8px;border-radius:7px;cursor:pointer;font:inherit;font-weight:600;',
      'background:#2a333c;color:#e6edf3;border:1px solid rgba(255,255,255,.1)}',
      '.pack-panel button.pri{background:#5ac8b0;color:#0e1a18;border:0}',
      '.pack-panel .pack-chk{display:flex;align-items:center;gap:7px;margin-top:11px;color:#c3ced8}',
      '.pack-panel .pack-chk input{width:auto}',
      '@media(max-width:520px){.pack-grid{grid-template-columns:repeat(2,1fr)}',
      '.pack-panel{width:calc(100vw - 28px);bottom:120px}.pack-pill{bottom:78px;right:10px}}'
    ].join('');
    var st = document.createElement('style'); st.id = 'pack-runtime-css';
    st.textContent = css; document.head.appendChild(st);
  }

  function layer(container, inner, cls) {
    var host = typeof container === 'string' ? document.querySelector(container) : container;
    if (!host) host = document.body;
    injectCSS();
    clearState(host);
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    var d = document.createElement('div');
    d.className = 'pack-layer ' + (cls || '');
    d.innerHTML = '<div class="pack-box">' + inner + '</div>';
    host.appendChild(d);
    return d;
  }
  function clearState(host) {
    var old = host.querySelector(':scope > .pack-layer');
    if (old) old.parentNode.removeChild(old);
  }

  function showLoading(container, label) {
    var bars = '<div class="pack-bone w40 h34"></div>' +
      '<div class="pack-bone w85"></div><div class="pack-bone w62"></div>' +
      '<div class="pack-grid"><div class="pack-bone"></div><div class="pack-bone"></div>' +
      '<div class="pack-bone"></div><div class="pack-bone"></div></div>' +
      '<div class="pack-bone h140"></div><div class="pack-bone w85"></div><div class="pack-bone w62"></div>';
    return layer(container,
      '<div class="pack-cap"><span class="pack-spin"></span><span>' + esc(label || 'Loading content…') + '</span></div>' + bars);
  }
  function hideLoading(container) {
    var host = typeof container === 'string' ? document.querySelector(container) : container;
    if (host) clearState(host);
  }
  function showError(container, errorMsg, retryCallback, err) {
    var host = typeof container === 'string' ? document.querySelector(container) : container;
    var code = err && err.code ? err.code : 'UNKNOWN · ' + (cfg.baseURL + '/bootstrap');
    var html = '<div class="pack-err"><h4>That request did not come back</h4>' +
      '<div>' + esc(errorMsg) + '</div>' +
      '<div class="pack-code">' + esc(code) + '</div>' +
      '<div class="pack-acts"><button class="pack-retry" type="button">Retry request</button>' +
      '<button class="pack-dismiss" type="button">Dismiss</button></div></div>';
    var d = layer(container, html);
    d.querySelector('.pack-retry').addEventListener('click', function () {
      hideLoading(host);
      if (typeof retryCallback === 'function') retryCallback();
    });
    d.querySelector('.pack-dismiss').addEventListener('click', function () { hideLoading(host); });
    return d;
  }

  /* ---------------------------------------------------------------------------
     5 · mount — the standard lifecycle every page in this pack boots through.
     ------------------------------------------------------------------------- */
  function mount(container, boot, opts) {
    opts = opts || {};
    var host = typeof container === 'string' ? document.querySelector(container) : container;
    if (!host) host = document.body;
    var seq = 0;
    function run() {
      var mine = ++seq;
      showLoading(host, opts.label || 'Loading workspace data…');
      return dataAdapter.request(opts.endpoint || '/bootstrap', { payload: opts.payload })
        .then(function (res) {
          if (mine !== seq) return;                  // discard a stale request
          hideLoading(host);
          try { if (typeof boot === 'function') boot(res.data, res); }
          catch (e) { showError(host, 'The page could not render: ' + e.message, run, e); }
        })
        .catch(function (err) {
          if (mine !== seq) return;
          hideLoading(host);
          showError(host, err.message || 'Something went wrong.', run, err);
        });
    }
    global.Pack.reload = run;
    return run();
  }

  /* ---------------------------------------------------------------------------
     6 · Small utilities
     ------------------------------------------------------------------------- */
  function debounce(fn, delay) {
    var t = null, lastArgs = null;
    function wrapped() {
      lastArgs = arguments;
      clearTimeout(t);
      wrapped.pending = true;
      t = setTimeout(function () { wrapped.pending = false; fn.apply(null, lastArgs); }, delay || 300);
    }
    wrapped.pending = false;
    wrapped.cancel = function () { clearTimeout(t); wrapped.pending = false; };
    wrapped.flush = function () { clearTimeout(t); wrapped.pending = false; if (lastArgs) fn.apply(null, lastArgs); };
    return wrapped;
  }
  function throttle(fn, interval) {
    var last = 0, timer = null, lastArgs = null;
    return function () {
      lastArgs = arguments;
      var now = Date.now(), wait = (interval || 200) - (now - last);
      if (wait <= 0) { clearTimeout(timer); timer = null; last = now; fn.apply(null, lastArgs); }
      else if (!timer) timer = setTimeout(function () {
        last = Date.now(); timer = null; fn.apply(null, lastArgs);
      }, wait);
    };
  }
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    remove: function (k) { try { localStorage.removeItem(k); } catch (e) {} },
    json: function (k, fallback) {
      try { return JSON.parse(localStorage.getItem(k)) || fallback; } catch (e) { return fallback; }
    }
  };

  /* ---------------------------------------------------------------------------
     7 · Demo controls. Deliberately opt-in so the shipped pages stay clean:
        add ?demo=1 to the URL, or call Pack.showDemo() from the console.
        The panel proves the adapter is live: inject a failure, then hit Retry.
     ------------------------------------------------------------------------- */
  function demoPanel() {
    injectCSS();
    document.body.classList.toggle('pack-light', !!document.querySelector('body.light'));
    if (!/[?&]demo=1/.test(location.search) && store.get('pack.demo.visible') !== '1') return;
    var pill = document.createElement('button');
    pill.type = 'button'; pill.className = 'pack-pill';
    pill.innerHTML = '<i></i><span>Demo data</span>';
    var panel = document.createElement('div'); panel.className = 'pack-panel';
    panel.innerHTML =
      '<h5>Data source</h5><p>Same UI, swappable backend. Try a failure, then hit Retry.</p>' +
      '<label>Mode</label><select data-k="mode"><option value="mock">Mock adapter</option><option value="remote">Remote API (real fetch)</option></select>' +
      '<label>Failure to inject</label><select data-k="fail">' +
        '<option value="none">None — request succeeds</option><option value="401">401 Unauthorized</option>' +
        '<option value="403">403 Forbidden</option><option value="500">500 Server error</option>' +
        '<option value="timeout">Timeout</option><option value="network">Network offline</option>' +
        '<option value="parse">Invalid JSON</option></select>' +
      '<label>Latency (ms)</label><input type="number" data-k="latency" min="0" max="15000" step="100">' +
      '<label>Base URL (remote mode)</label><input type="text" data-k="base" placeholder="/api">' +
      '<label class="pack-chk"><input type="checkbox" data-k="force"> Force this failure on every load</label>' +
      '<div class="pack-btns"><button class="pri" data-k="reload">Reload page data</button>' +
      '<button data-k="next">Fail next only</button></div>';
    document.body.appendChild(pill); document.body.appendChild(panel);

    function sync() {
      panel.querySelector('[data-k="mode"]').value = cfg.mode;
      panel.querySelector('[data-k="fail"]').value = cfg.failMode;
      panel.querySelector('[data-k="latency"]').value = cfg.latency;
      panel.querySelector('[data-k="base"]').value = cfg.baseURL;
      panel.querySelector('[data-k="force"]').checked = !!cfg.forceFail;
    }
    sync();
    pill.addEventListener('click', function () {
      panel.classList.toggle('open'); pill.classList.toggle('open'); sync();
    });
    panel.addEventListener('change', function (e) {
      var k = e.target.getAttribute('data-k'); if (!k) return;
      if (k === 'mode') cfg.mode = e.target.value;
      if (k === 'fail') cfg.failMode = e.target.value;
      if (k === 'latency') cfg.latency = Math.max(0, Math.min(15000, Number(e.target.value) || 0));
      if (k === 'base') cfg.baseURL = e.target.value || '/api';
      if (k === 'force') cfg.forceFail = e.target.checked;
      saveCfg();
    });
    panel.addEventListener('click', function (e) {
      var k = e.target.getAttribute('data-k'); if (!k) return;
      if (k === 'next') { cfg.failNext = true; saveCfg(); }
      if (global.Pack.reload) global.Pack.reload();
    });
    if (/[?&]demo=1/.test(location.search)) { panel.classList.add('open'); pill.classList.add('open'); sync(); }
  }

  /* A single throttled resize channel for every page. Charts subscribe to
     'pack:resize' instead of each attaching their own unthrottled listener. */
  window.addEventListener('resize', throttle(function () {
    window.dispatchEvent(new CustomEvent('pack:resize', { detail: { w: innerWidth, h: innerHeight } }));
  }, 200));

  global.Pack = {
    version: '1.0.0', ApiError: ApiError, apiRequest: apiRequest,
    dataAdapter: dataAdapter, showLoading: showLoading, hideLoading: hideLoading,
    showError: showError, mount: mount, debounce: debounce, throttle: throttle,
    store: store, esc: esc, saveCfg: saveCfg,
    setDataMode: function (m) { return dataAdapter.setMode(m); },
    get config() { return cfg; },
    demoPanel: demoPanel,
    showDemo: function () {
      store.set('pack.demo.visible', '1');
      var existing = document.querySelector('.pack-pill');
      if (existing) { var p = document.querySelector('.pack-panel'); if (p) p.classList.add('open'); return; }
      demoPanel();
      var fresh = document.querySelector('.pack-panel');
      if (fresh) fresh.classList.add('open');
      var freshPill = document.querySelector('.pack-pill');
      if (freshPill) freshPill.classList.add('open');
    },
    hideDemo: function () { store.remove('pack.demo.visible'); location.reload(); },
    reload: function () {}
  };

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', demoPanel);
  else demoPanel();
})(window);

/* ==================================================================
   WILLOW — full O2O pet-care SPA
   1 Icons · 2 Catalogue · 3 Persistent DB · 4 Helpers · 5 Chrome
   6 Views · 7 Pricing · 8 Actions · 9 Router
   No frameworks, no network calls, no external assets.
   ================================================================== */
const ICONS={
 paw:'<circle cx="7" cy="8" r="2"/><circle cx="12" cy="6" r="2"/><circle cx="17" cy="8" r="2"/><circle cx="20" cy="12.5" r="1.7"/><path d="M12 11c-3 0-5.5 2.4-5.5 5 0 2 1.6 3.2 3.4 3.2 1 0 1.5-.5 2.1-.5s1.1.5 2.1.5c1.8 0 3.4-1.2 3.4-3.2 0-2.6-2.5-5-5.5-5z"/>',
 home:'<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-7h6v7"/>',
 walk:'<circle cx="6" cy="5" r="2"/><path d="M8 8c2 0 3 2 4 4l2 4"/><path d="M14 16l3 4"/><path d="M10 12l-3 4"/><path d="M18 20h3"/><circle cx="18.5" cy="18" r="1.5"/>',
 clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
 spark:'<path d="M12 2l1.8 5.6L19.5 9l-5.7 1.4L12 16l-1.8-5.6L4.5 9l5.7-1.4z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
 book:'<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21z"/><path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H20"/>',
 search:'<circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/>',
 heart:'<path d="M12 20.5S3.5 15 3.5 9.2A4.7 4.7 0 0 1 12 6.6a4.7 4.7 0 0 1 8.5 2.6c0 5.8-8.5 11.3-8.5 11.3z"/>',
 user:'<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/>',
 calendar:'<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M7 3v4M17 3v4M3 10h18"/>',
 pin:'<path d="M12 21s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
 star:'<path d="m12 2 2.9 6.2 6.6.9-4.8 4.7 1.2 6.7L12 17.3l-5.9 3.2 1.2-6.7-4.8-4.7 6.6-.9z"/>',
 chat:'<path d="M21 12c0 4.4-4 8-9 8-1.2 0-2.3-.2-3.3-.6L4 21l1.3-4A7.6 7.6 0 0 1 3 12c0-4.4 4-8 9-8s9 3.6 9 8z"/>',
 bell:'<path d="M18 9a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
 wallet:'<rect x="3" y="6" width="18" height="14" rx="3"/><path d="M3 10h18"/><circle cx="17" cy="15" r="1.3"/>',
 card:'<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M2 10h20M6 15h4"/>',
 shield:'<path d="M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5z"/><path d="m9 12 2 2 4-4"/>',
 check:'<path d="m5 12 4.5 4.5L19 7"/>',
 plus:'<path d="M12 5v14M5 12h14"/>',
 arrow:'<path d="M5 12h14M13 6l6 6-6 6"/>',
 back:'<path d="M19 12H5M11 18l-6-6 6-6"/>',
 chev:'<path d="m6 9 6 6 6-6"/>',
 close:'<path d="M6 6l12 12M18 6 6 18"/>',
 sliders:'<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
 map:'<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15M15 6v15"/>',
 repeat:'<path d="M4 11a8 8 0 0 1 13.5-5.5L20 8"/><path d="M20 4v4h-4"/><path d="M20 13a8 8 0 0 1-13.5 5.5L4 16"/><path d="M4 20v-4h4"/>',
 gift:'<rect x="3" y="9" width="18" height="12" rx="2"/><path d="M3 13h18M12 9v12"/><path d="M12 9C9 9 7 8 7 6.5A2.5 2.5 0 0 1 12 6a2.5 2.5 0 0 1 5 .5C17 8 15 9 12 9z"/>',
 help:'<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.6 2.6 0 1 1 3.5 2.5c-.8.4-1 1-1 1.8"/><path d="M12 17h.01"/>',
 settings:'<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.3 1a7 7 0 0 0-1.7-1L14.5 3h-4l-.4 2.6a7 7 0 0 0-1.7 1l-2.3-1-2 3.4 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7 7 0 0 0 1.7-1l2.3 1 2-3.4-2-1.5a7 7 0 0 0 .1-1z"/>',
 moon:'<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"/>',
 sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
 receipt:'<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
 camera:'<rect x="3" y="7" width="18" height="13" rx="3"/><circle cx="12" cy="13.5" r="3.5"/><path d="M8 7l1.5-2h5L16 7"/>',
 info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
 edit:'<path d="M4 20h4l11-11-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
 trash:'<path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14"/>',
 badge:'<circle cx="12" cy="9" r="6"/><path d="m8 14-2 7 6-3 6 3-2-7"/>',
 bolt:'<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
 leaf:'<path d="M20 4C9 4 4 9 4 16c0 2 1 4 1 4s9 0 13-6c2-3 2-10 2-10z"/><path d="M4 20c3-6 7-9 12-11"/>',
 tag:'<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="7.5" r="1.3"/>',
 copy:'<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
 phone:'<path d="M5 3h4l2 5-2.5 1.5a12 12 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2C10 21 3 14 3 5a2 2 0 0 1 2-2z"/>',
 lock:'<rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
 send:'<path d="m3 11 18-8-8 18-2-8z"/><path d="m11 13 10-10"/>',
 refresh:'<path d="M20 11a8 8 0 1 0-2 6"/><path d="M20 4v7h-7"/>'
};
document.getElementById('sprite').innerHTML=Object.keys(ICONS).map(function(k){
  return '<symbol id="i-'+k+'" viewBox="0 0 24 24">'+ICONS[k]+'</symbol>';}).join('');
function ic(n,c){return '<svg class="ic '+(c||'')+'" aria-hidden="true"><use href="#i-'+n+'"></use></svg>';}
const LOGO='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAM4AAACsCAYAAAAzI5OVAAAMTGlDQ1BJQ0MgUHJvZmlsZQAAeJyVVwdYU1cbPndkQggQiICMsJcgIiOAjBBWANlbVEISIIwYE4KKGymtYN0ighOtgihYrYAUF2pdFMW9iwMVpRZrcSv/CQG09B/P/z3Pufe97/nOe77vu+eOAwC9iy+V5qKaAORJ8mUxwf6spOQUFukZQAAOKMAQUPgCuZQTFRUOoA2f/26vr0FvaJcdlFr/7P+vpiUUyQUAIFEQpwvlgjyIfwIAbxVIZfkAEKWQN5+VL1XitRDryGCAENcocaYKtypxugpfHPSJi+FC/AgAsjqfL8sEQKMP8qwCQSbUocNsgZNEKJZA7AexT17eDCHEiyC2gT5wTrpSn53+lU7m3zTTRzT5/MwRrMpl0MgBYrk0lz/n/yzH/7a8XMXwHNawqWfJQmKUOcO6PcqZEabE6hC/laRHREKsDQCKi4WD/krMzFKExKv8URuBnAtrBpgQT5LnxvKG+BghPyAMYkOIMyS5EeFDPkUZ4iClD6wfWiHO58VBrAdxjUgeGDvkc0w2I2Z43msZMi5niH/Klw3GoNT/rMiJ56j0Me0sEW9IH3MszIpLhJgKcUCBOCECYg2II+Q5sWFDPqmFWdyIYR+ZIkaZiwXEMpEk2F+lj5VnyIJihvx358mHc8eOZYl5EUP4Un5WXIiqVtgjAX8wfpgL1ieScOKHdUTypPDhXISigEBV7jhZJImPVfG4njTfP0Y1FreT5kYN+eP+otxgJW8GcZy8IHZ4bEE+XJwqfbxEmh8Vp4oTr8zmh0ap4sH3gXDABQGABRSwpYMZIBuIO3qbeuGVqicI8IEMZAIRcBhihkckDvZI4DEWFILfIRIB+cg4/8FeESiA/KdRrJITj3CqowPIGOpTquSAxxDngTCQC68Vg0qSkQgSwCPIiP8RER82AcwhFzZl/7/nh9kvDAcy4UOMYnhGFn3YkxhIDCCGEIOItrgB7oN74eHw6AebM87GPYbz+OJPeEzoJDwgXCV0EW5OFxfJRkU5GXRB/aCh+qR/XR/cCmq64v64N1SHyjgTNwAOuAuch4P7wpldIcsdiltZFdYo7b9l8NUdGvKjOFFQyhiKH8Vm9EgNOw3XERVlrb+ujyrW9JF6c0d6Rs/P/ar6QngOG+2JfYcdwE5jx7GzWCvWBFjYUawZa8cOK/HIins0uOKGZ4sZjCcH6oxeM1/urLKScqc6px6nj6q+fNHsfOXDyJ0hnSMTZ2blszjwiyFi8SQCx3EsZydnNwCU3x/V6+1V9OB3BWG2f+GW/AaA99GBgYGfv3ChRwH40R2+Eg594WzY8NOiBsCZQwKFrEDF4coDAb456PDp0wfGwBzYwHycgRvwAn4gEISCSBAHksE0GH0WXOcyMAvMA4tBCSgDK8E6UAm2gO2gBuwF+0ETaAXHwS/gPLgIroLbcPV0g+egD7wGHxAEISE0hIHoIyaIJWKPOCNsxAcJRMKRGCQZSUMyEQmiQOYhS5AyZDVSiWxDapEfkUPIceQs0oncRO4jPcifyHsUQ9VRHdQItULHo2yUg4ahcehUNBOdiRaixehytAKtRvegjehx9Dx6Fe1Cn6P9GMDUMCZmijlgbIyLRWIpWAYmwxZgpVg5Vo3VYy3wPl/GurBe7B1OxBk4C3eAKzgEj8cF+Ex8Ab4Mr8Rr8Eb8JH4Zv4/34Z8JNIIhwZ7gSeARkgiZhFmEEkI5YSfhIOEUfJa6Ca+JRCKTaE10h89iMjGbOJe4jLiJ2EA8RuwkPiT2k0gkfZI9yZsUSeKT8kklpA2kPaSjpEukbtJbshrZhOxMDiKnkCXkInI5eTf5CPkS+Qn5A0WTYknxpERShJQ5lBWUHZQWygVKN+UDVYtqTfWmxlGzqYupFdR66inqHeorNTU1MzUPtWg1sdoitQq1fWpn1O6rvVPXVrdT56qnqivUl6vvUj+mflP9FY1Gs6L50VJo+bTltFraCdo92lsNhoajBk9DqLFQo0qjUeOSxgs6hW5J59Cn0Qvp5fQD9Av0Xk2KppUmV5OvuUCzSvOQ5nXNfi2G1gStSK08rWVau7XOaj3VJmlbaQdqC7WLtbdrn9B+yMAY5gwuQ8BYwtjBOMXo1iHqWOvwdLJ1ynT26nTo9Olq67roJujO1q3SPazbxcSYVkweM5e5grmfeY35fozRGM4Y0ZilY+rHXBrzRm+snp+eSK9Ur0Hvqt57fZZ+oH6O/ir9Jv27BriBnUG0wSyDzQanDHrH6oz1GisYWzp2/9hbhqihnWGM4VzD7Ybthv1GxkbBRlKjDUYnjHqNmcZ+xtnGa42PGPeYMEx8TMQma02Omjxj6bI4rFxWBeskq8/U0DTEVGG6zbTD9IOZtVm8WZFZg9ldc6o52zzDfK15m3mfhYnFZIt5FnUWtywplmzLLMv1lqct31hZWyVafWvVZPXUWs+aZ11oXWd9x4Zm42sz06ba5oot0ZZtm2O7yfaiHWrnapdlV2V3wR61d7MX22+y7xxHGOcxTjKuetx1B3UHjkOBQ53DfUemY7hjkWOT44vxFuNTxq8af3r8ZydXp1ynHU63J2hPCJ1QNKFlwp/Ods4C5yrnKxNpE4MmLpzYPPGli72LyGWzyw1Xhutk129d21w/ubm7ydzq3XrcLdzT3De6X2frsKPYy9hnPAge/h4LPVo93nm6eeZ77vf8w8vBK8drt9fTSdaTRJN2THrobebN997m3eXD8knz2erT5Wvqy/et9n3gZ+4n9Nvp94Rjy8nm7OG88Hfyl/kf9H/D9eTO5x4LwAKCA0oDOgK1A+MDKwPvBZkFZQbVBfUFuwbPDT4WQggJC1kVcp1nxBPwanl9oe6h80NPhqmHxYZVhj0ItwuXhbdMRieHTl4z+U6EZYQkoikSRPIi10TejbKOmhn1czQxOiq6KvpxzISYeTGnYxmx02N3x76O849bEXc73iZeEd+WQE9ITahNeJMYkLg6sStpfNL8pPPJBsni5OYUUkpCys6U/imBU9ZN6U51TS1JvTbVeursqWenGUzLnXZ4On06f/qBNEJaYtrutI/8SH41vz+dl74xvU/AFawXPBf6CdcKe0TeotWiJxneGasznmZ6Z67J7MnyzSrP6hVzxZXil9kh2Vuy3+RE5uzKGchNzG3II+el5R2SaEtyJCdnGM+YPaNTai8tkXbN9Jy5bmafLEy2U47Ip8qb83Xgj367wkbxjeJ+gU9BVcHbWQmzDszWmi2Z3T7Hbs7SOU8Kgwp/mIvPFcxtm2c6b/G8+/M587ctQBakL2hbaL6weGH3ouBFNYupi3MW/1rkVLS66K8liUtaio2KFxU//Cb4m7oSjRJZyfVvvb7d8h3+nfi7jqUTl25Y+rlUWHquzKmsvOzjMsGyc99P+L7i+4HlGcs7Vrit2LySuFKy8toq31U1q7VWF65+uGbymsa1rLWla/9aN33d2XKX8i3rqesV67sqwiuaN1hsWLnhY2VW5dUq/6qGjYYbl258s0m46dJmv831W4y2lG15v1W89ca24G2N1VbV5duJ2wu2P96RsOP0D+wfanca7Czb+WmXZFdXTUzNyVr32trdhrtX1KF1irqePal7Lu4N2Ntc71C/rYHZULYP7FPse/Zj2o/X9oftbzvAPlD/k+VPGw8yDpY2Io1zGvuaspq6mpObOw+FHmpr8Wo5+LPjz7taTVurDuseXnGEeqT4yMDRwqP9x6THeo9nHn/YNr3t9omkE1dORp/sOBV26swvQb+cOM05ffSM95nWs55nD51jn2s673a+sd21/eCvrr8e7HDraLzgfqH5osfFls5JnUcu+V46fjng8i9XeFfOX4242nkt/tqN66nXu24Ibzy9mXvz5a2CWx9uL7pDuFN6V/Nu+T3De9W/2f7W0OXWdfh+wP32B7EPbj8UPHz+SP7oY3fxY9rj8icmT2qfOj9t7QnqufhsyrPu59LnH3pLftf6feMLmxc//eH3R3tfUl/3S9nLgT+XvdJ/tesvl7/a+qP6773Oe/3hTelb/bc179jvTr9PfP/kw6yPpI8Vn2w/tXwO+3xnIG9gQMqX8Qd/BTCg3NpkAPDnLgBoyQAw4L6ROkW1Pxw0RLWnHUTgP2HVHnLQ4J9LPfynj+6FfzfXAdi3AwArqE9PBSCKBkCcB0AnThxpw3u5wX2n0ohwb7A14lN6Xjr4N6bak34V9+gzUKq6gNHnfwHmvYLnv9qFPQAAa7ZJREFUeNrt/feTZOd55wt+3uPSe1PetW+0gSVBI1EkpRE19pq5cc1G7MZGbOxftfvDbuxG3J2rvbMzo5E0omhAkADhgW607y7vq7IqvTvu3R/OycyTWVkNkBI1ADofRKG6q6sqM0++z3nc9/t9hJSSiU1sYr+bKZNLMLGJTRxnYhObOM7EJjZxnIlNbOI4E5vYxHEmNrGJTRxnYhObOM7EJjZxnIlNbOI4E5vYxHEmNrGJTRxnYhObOM7EJjZxnIlNbOI4E5vYxHEmNrGJTRxnYhObOM7EJjZxnIlNbOI4E5vYxHEmNrGJTRxnYhP7g5k2uQQvhp2USlK6Lq6UCHqSYAIhBEKAEIJsviD+sM/hSHY7HSyzi0SgqRrhcIT81JSYOM7E/sltf3tL1us1atUqzWaTdrNBs9Gg2WrSrjdoNluYlollW7i2g9AUVEVD1VQMTUc3DMKRKPFEShaKBbK5HJlslnAkTDQaJZXN/94He39nS248W2Vt9Sl7OzuUSoe06k1AEIpGyGYzzM4uyOULF7ly/TqzS8tfCycSE0HCr4cdHx7IVqtJp92iVilTr9epVyqUy6fUqxUazQadZgfLNrEsE9t0sB0b27KwLBvXcb0P10EKCVIipURIkEiEEISMMIlEgkQyTjQWIxSOEk8liKcyJJMpUtk8+XyOVDrNzPzCcw949aQk7939lEf37vLs0WOOj45ptZu0zS6O4+C63mNqmkoiGqdQKLJyYZlrN25y8epLrFy9LiaOM7Hf21na7TatRo2DvT2ODw+pVo45PNindHRM+fSUWr2GbdsIQFE1DMMgZITQ9RChcBhdM1B1DVVVAZCOi+M6OLaFZXbotrt0O2063TauZeP4Ucl1HS+dCoWJJJKkkhmm5+ZYWFhkbnGR6blZcsUikWiMqZnZoUN+enwk15485D/95b/j888+5aRUIhyNEU0liSYS6BEDy7Jpd9p06nUalRqOaRIxdG6//Crf/ZMf8t0f/hkLKxfFxHEm9qXtYHdb7mxtsr76jI3VZ2xtrHFwsE+jXsV1HTRNJxZPkM5myOUKZPNT5AsFkqkM6UyGeCJOLBpFD0XQdA2hKCiKAgjABSSu4+DYNrbVxex06HQ6dLtdWrU69VqdRrXM0dExJ8clyicnnJ6Wabda2K6DYYTJF4vMLS6wuLTC9du3uHj5CnNLKwLgg9+8Jf/y//X/5M4nHyMFzCwtMbe8TCKbJRSPIDSBY1uYHQur3ebkuERp/4jj/X2sVpP52Tm+/eb3+Df/0//CytWXxMRxJjbWTkvH8rRUYm9nm53tTXa3Ntnf26VaKWN22yhCJRqPkcxkyOeLZHMZUpkc6WyOaCxBPBYjGk8QCoUJhUKEQgaqriMUgcBLxTyTIF3/KxLpukjpYvtpnHQklmljmiZWt0urXqfRbNCsVzk9OaVcKlEqlSgdlajX65iWCUhyhQIzC/MsLV8gmYixsfqMn//07+h0OxTn57jw0g3ShSxGOIJQVBDgOl5Ucx2bVqtFvVzmeP+Yw61tuo0GmUSSn/yrf8N3f/Ajrty8LSbNgYn17ehgT9YqFXa2t1h/+pTVJ4/Y3drk5PQYx7WJxhMUCgXmF1dYXL7A/NIy83MLpDJp4skkoXDEjyLBc+XVLq50cV0XVzpI1wHpIKVESrfXUEMoIIRKSNcQQkNVNEBBCIEiepMKF+k6tJtNqtUapcMjdjY32d7cZGd7i93tLXZ2ttjd2+bZw4ckEjEqlSonpyfkpqcozM4xtTCHEQ4jAdtxvZpKClRFRTcMjHCYWDxGIpMhHAmz9WyN3b193vnVW6QzOa7cvD3pqk3Ms631Nfnw88/54L3f8ODuHTbWVrEsk1whx9KFC9y6/TIXLl9hcWmFqbl5orEEhhH2axUvYjhOzxmgnzn4Rb/EcxLvz47/74GPflMApJ/COdgI3xEVRfU/KyiqSiyVIZbMMjO3xI1XXqfbaVKtVNjf3WJ9dY1nTx7x+N4DHj95QqVSod1qk8hksW0T27IxQqAIBUWA7Tq40m+HS4F0QdXCJNNhlEs6Qgjsrsnjp0+Y/+QTLl95Sb70+mtfqagzSdX+Ca18UpI76+vcu/c5j+5/zqMnj6lXyxiaRjaX58KliyxduMDC0iJT0zMkkhli8TiRaLR/kPGTLzFIvvr/6zlQ32Gki8QF6d3lA9/sfRb0HQUhEELxZ+ICRREIvK8JxQ9PBDI+6eI4Np12i0a9SfX0hOPjA/b399ne2GT96TOOS4egQDKbZmZ+kex0kUQmg2IYuK7EdV3v8f2nJAS4rsXp0TG7z9Z5cvcuKysX+PGf/XP+D/+X/6uYRJwX0FYfP5JrTx/z2ccf8+Dzu+wf7GFaFrOzs1y8fJlrL93kytWrTM/Nks6m0PWQf5BBSnBdB6R/wP1TJoQYpF1ykLEN3Qv7kWjkjokA6Q0/EV56hlADQ1HfcfqlkduvlaT0WsmqppNIpkmmMszMzXLJvkLltML+7i5rT57x6MEdtjbWODk5xWp1qZ2ekp0tkioWCUeiqJoXXaTvPFKCquokMyms+Tn2tzY5PT3l8YP7bG9syIXlr86MZ+I4/wT27N49+dO/+U+89dbPuff5Z4TCYZZXLvKD7/wZ3/v+97l49RqFYtGPKg5SWjh2dxBhhOrd+cXgUA+Z9I+09E9fPyUb+I4IuAwjqCvPPRQ/wgjfrcTQdyr+16UXw7yIZtvYrttHHghFpTA1TXF6lluvvs53dr/HvU8+5t1f/5qPPnif7bUNYqkkl2+9xPTSIpliHk2PYLuu/xwFrivR9QipfJZ0Ps/x7j5bWxuUSycsLC9PIs6LYHc+eF9++slHfPL+e2xtr2NZFt/9wQ+5eesVrr10g5WLl0ils0SjEVzXRbom4AQOveKlSNLtp2jBHtmo9Yv/ngNJx0/rJMN+I/qpkfdXpQ+96X2PlHIQ3QKPKgOQHSkY6txJR2K5Zv+pprNZbn/rTWYWlrj9ymvcv3OHJ08e8fTze+zv7DK9MMfChYvE0ylU3UC6/lAWgWGESGaynB6VqDcblKsVjg4OZHF6Wkwc5xtqa0+eyGdPHvLpRx/y8O5dSqVDMvk8Fy5d4eU3vsWVq9eYnpkjkUr6aZiLdG3ARfhzlgH+VjwXi3umKeB/9BxQyPGOJvo5XsBhzv52ZCDyDBoMnHFIIcH1mxK4XudO0w2yhQKpdIZcPk9haoridJF79+5weHzMztoG7WaL2aVFMsUC0VjCi7FCQSgq4Wgcoap02m0a1SqWaU4izjfV7t+5Iz967z1++dO/YX3jGa4ruXX7Zf74R3/GG9/5LiuXL6EIFdd1sR2rf9iEoqAIxTuMEiS9Ql31a52zaZoMHuYRp5H9tG0kQZNiKOr0mgG9j36xLno/Ls86KcMONCjue8WW4s+HLK8HIRSKM7MUpopcvXGdq59e41e//CWf3fmUh5/doVVrsnzFYv7iEopm9NPEUMhAKApd06TZamI5zsRxvml2enQgf/XLX/Leu+/w4PM7tLttli9e4dYrr/Enf/oj5uaXyGRyqIoOQqIIBU3oXrTp38k9xxG9P3uDFm+mIoJVh0T6XSkpRKD97PgO5P9OEczORMAHek6ijFQygX+WY6IanKmdRmdIfqvOd/he3QW2bQGQSKW4/a3vkM4XuHD1Mm//8i0Ojva5/2mdRr3G/IULZLI5VEVDU73f4UrvtfIV6gBPHOcfwe5+/L785OMPef/d37K7swuKyu03vs3Lr7zOrdu3Wbl8AVXVadsd6qcNDyvm2N7k3B1M8IcjhPChMiqaqqL2PjQVTVFQVRVFqF6NIQRCKkiBl/L1fpUM1CK9Qx4IOGK4xzbON86kbqPNOkZqoLPllOjPlJAgFI14KsnK5SvE4lFi0Tgff/w+axsbrD19imXZdBeXyOWzdBtNrG4XACMU8mFDE8f5Rtgn770jf/OrX/C3f/NXVKsNCjNz3H71Vb7/Jz/mytWrZHNZ2t0WrVaFZrtJp9vGMm1s2/IAla7jTfh7kSeQ9qiKgio0NF1HNzQMQyekGxi6B+Q0Qt6fdU1DUb3hIuO6z4FCX/jB52y9Mxw1ZCAFC8SSQeNgTDQSQvQdSojBswj+nPd6bSLRKEsXLzM9O0s2n+edd97mnXd+zebqKt1uB9daolQ6wuqaRCIRUuk0RsiYOA7fALjMo3uf85/+419y57PPqFZrXLtxi1e/8z1efuMNook4u6UDnm2v0Wy3sOwutmPj2I6HC+s7jONFHDdYowwOohAKiqqg+kBNVRGoqoKmeU4UDoWJhCPEYlEPsxaJEQmFCBkhFEX1MAH9aOYNSYOeowRbaYFhqvDGPIGIJJ8bjfrfIc4GKCH8xmDAi2zHBkAPhXn59TfI5PPMzs3xs5/9nM21dfa297DbHSLhMJeuXGZ2fo7pERT2xHG+Zvb44efykw8+5K2f/z2bG2uA4Mq1G1y+eYvsVJGWaVI5PKTTbWOaXaQzaDFLKftO4koX1/HrFelNSIYKcumjBFzHH0j6KZyQ/am+qihomoauaxghnWg4SjQcIRKJkowniEVjRCNhwoaBoih9fPTQGRcDvJsMpHDieZnbuFQtWOLIYAPjDF6lP3dyUQhHI8wvLhOORBCqxkfvf8DD+/do1+ukFhaYm54llUwyQQ58XRsAJ8fy+OiQX7/1C9556y0+/OADClNFli5e4MqN2+RnZ3Bw2dvbxbJtFAVUTUXx0y4PuuId/B6JTCCQQkHxHUn2okLwcIqRLpqUuNKrjxzX9ZoCPrhT11QMLUwkEiGTSpFOZchlUiRjKaKRCOGQ7kciddA0GDSnz4kmo6nf+ddIjPxFyEAPLvD3Xq/CgwUJovE4K6kUoXCYcChMt9lk/dlThJQ4tkW72WSCVfua2p2P3pf/2//6/+bd37zDSemEmflZLl+9yvzFFYqzM1QbDSzHQVEVYrE4oVAIRVVxbGcMiNnvfgVSNPfMLGak8B6pKyQStwfwlI7/Z3fA7hTC4+6EIhSKBWanppmdmiGbymBouveYTiAtPL8VcG5d4z3O2Z8ZjjpygJcb83297pxAQdVUTkolnj78nH//v/5/ePrkCeFInH/7P/7PfP+HP2LlypXJAPTrYqXDQ/nxh+/y61/+kvff+y1SwMXrV7l85QqF6SKpbAYENOtNyuUy3XaHcDRCJpshk80SiURBCFwpsR0bRRFjW1PCz3OkD+KU8uyhDQ4iXQbtXmSwc+ZFNRC4rkOj28Q+cKnWahwcHzEzNcN0rkguk8HQQgHUwZio8yVurINvkeODUrAN7n+zED2xEIbmSVJCKpPh2s2X+df/g8Wvf/4Wn9+5y89/+neohoEeCsn5pSUxcZyvuO1sbsiH9+7y1s9/xocfvEe91mDp4kUuXb7M4sVFVNVD+lYqpxzvH3B8eEiz3iQUMqikkpRzGbK5POl8llAkwnBZIfyJu9/4cqVfJoi+c8gezMY/cG4QDQ1e1S0HUal3IBUhUITq/4xDy2zR6rap1urU600atQbN9jS5VNZji+o6ilDODE4HeZoYk6P9btnKANcthwawAyfybi6appPNF3n9ze/hOpKu2eXuZ3f46IPfEovFiMZiMpvPi4njfEXtYGdHPnl4n//H//3/xsbGGkLA8oUVrly5wuziHNFolEatzulpldLJIc8ePaN6WsV1HEIhjd31DhJJYXqaW6+/xtKlSxjRMFIJzFN6CBvXRTouwnUGA83Af26/ucCAjNYHeMqR+qIXsxwURUVXdIRQcV1J17LY2d/j8PiYja0tLl+4wPLCIlOFIpqm+UIabiDKiZGG9GgBJsdWR1K6fXS391qVXlcciTuU3vWBpcJz+F57Pp0t8O3v/4B4MkW5fMKDe3ep1xssLC2RzecnNc5X0dafPpHv/vptfvnzv+fZkyfYtkUopBONRgnFYhhGCKFAq9nBtk2ka9Os1UjEEywtLnPr1Zcxu122dzZ5+OARiq6QLeZZvnSFcDKGoukeEtjQ0VQNRdMxdANUpR9JHMfFcRwc18aRbh/4HESQySFEtHcIFUVBV9UA7pkBt8YfrOJ/1nSdTCpDPpdnfnaOTDpLOBTqIxN60ScItwli1rw/i7MIg6F6znciOb6D0IMRiT4Cu+dQXgSsnJ7w6Qfv8rOf/h2bG1tcvXqdf/3f/1u++4MfiknE+QrZs8eP5Ltv/4oP3n2H9bVVIuEQUupI6dLttLFsB0XTUTWFbtvEtkyk06XTapJJJCjm87zxrTcJhULs7myTTKZ5fP8ex1s7dGttYskYhh7CFQqa4Q0vVS1ENBHBCEfRwyFCEQNV1VBUzauJhOKldD6AkhHmZw8cqQiQtk2z2cTuWDimibStPmRHVXVC4RChSAg9FMa2NEqWRavTpN1pMzM1Qz6TI5VIDib/Un6ZXts5TjO+Q3j2L2dxDK7roqoqmVyOV7/9HcqVCp1WmzuffsTs3CzxeFzeeu0NMXEcvhqEs4/f+y3/4X//S6rVMplcltlCkdPyCaXjYxzXJZ1Ok8sViacS2GaXeq3K6dEhB80mjmkhgGxxirmFJS5eu8lLt27zd//h/8dbP/8ZT+7eJxYxCIXDaIaB7doe7AaFSCJGLJkglk6RyWWJJ1NE4nFC8SiK5oE9pfCyOxc5TFITAk0IHNumU2tycnBIvXxKp9ak2+32h5lCUYglomTyOQrFaaZmpxA4NGpVSqennJRPWZpd5OqFi4TDERRFwT03K/GLe3n2/A/jQ5VhlxCBMkoE243DIFZFCFzpIBAUp+d483vfxzI7PHn8iPfe/Q2hcIhbr70xiTj/te3Jg3vy7Z//PX/9V3+FlC5Xr15hYWkepEun28bQQyRTUX7yF/+c26+9QTyRwHVsquUqe9ub/OaXv8I0u4QTaRAapu0NLnPFOX7w53/B1NwCn332GdFIlGQqTjyZpNNuUi1XOSmdUq6cUqmUKe3sc7C5hZSgh8MkMmkS6TTJdJpkJoMeC6GHDBSfwyIEuI5NvVzleHeX0t4RzUoVAR7iQNXQNM/pbMehWq1SqVTY2tj0lDQX5ynOzhJPZmnUajzrPqVRr7GytEI+lyMcjvj6Bu75mLVeS04OO5UMYnACvi4CCO1e63zkH/tOKaXEskwKxWlefu1bbG1s8OnHn/Lub37DwuKSvP36t5n9AoHEieOM2MbaM3lyfES1ckq1UqHdbmObFroRIp5IkM4VmCoWyRUK5ApFcX73bF3++q1f8O5vfs3xwQHTs9MI6VIrl2nU65RPTum0Wri2zcHuNjPT02hzi0zNzjI1NcPs3CzRaJxms0k6kyEcifhFPmiaxsziEpF4iuLcIqFQiHA0QjgSwTK7NOsNqrUa9UqZk9MTTo6PqJyecFI6oVKt0qzUqZ9UOTB2Pc20VIp4JkUylUY3PIR1q9Fgf3ufcukEq9XGMAwSyTixWBwjEkLVNBDguA6WadJsNmjXW5yWy5iWRa3aYH5liUgsgXQddvZ3cZG0zS5TxSnCoZCPhXPHOM35GVzPIc6iEMRwh3FcqyHQzXNdl1AkwszcAt//kx9ycHDI9tYWf/fX/5lkKsvs/MIk4nw50b4debi3y6MH93ny+D7b2+tUy1U6rRa243rc9VSGqdkZrl27zku3XuHSNVtOTZ/FO21trMrPP36fn//df2FjbY14NIauKFTLFY6Ojul22uBKwmED0zT55MP3Odzd4+q1G3zvxz9m+eIlpufmyReLOJaNKyV6aDAfsSwLTQ8zNTfHzMJCnwZ9thiQdNotqpUyJ8dHbK6us/bsGavPnrCzvU356JSj7T1C4QipfIbiVJF4KoVlm5TLZfa29lBVjVQ6zeziLJlcnlg6QTgcQtE0n2sjsS2Teq1JuXTC0f4OJyXPSTudNsuXLpHNF2h1LTa2Nml1O0ghKWYLRCORXvUxQsVRECOpGIGmAaPaCAHOz1Av0B/C9iPQiC+6UhJPxrn96us8efyI4+MjfvPrt3jp5k2KU0V56foNMemq8bwJ/nvyw/fe4cP33uNgf59Wq4ke0gj7IEcjEsIxXTpmF7PTxTUdj0R1/Qbf++MfcPnadYrTMwJgY/WxfPfXv+J//3d/ycnREVa3S0jXCEcjpHJ5pqZnWFlZojAzTSQcodms8+jeAw4ODgiHDf6H/+X/yI3brxCNxZCu49ORPR5nXxmmR0AT9Hn9A+cJvBmKj99yJY5j0+10aDVbNKonbG9tsf5slSePn7C+tk6tVkHiEovGcKSD5doY4QizC4vMLi6Qmcqh6R5yoadgIwIcNNdxsG2TZq3G/tYWO5vbVMrHLKyssHLpMvNLi1iOi6oaxBMJLi5fYG5qmmw6g+tYvnhHb2gb6N0FOUA9lPWY8n8o3ARSNMFZ+HZ/4OtHO1VR+OyTj/nZT/+Gf//v/jdevv0qf/Gv/hv+p//T/1lMIs4YOzk6lJ999D7vv/8OD+7epVwuo4UMivPzZPI5IrE4kVgYIxTGsRxMs0Or0aC0V6JSq/HZJx9SK5coHX6XS9euSVyH9979De+9+y67W1ukEkkW5uaZXZxjYXGJwswchalp8vksiWQKTdexzA6LK5epnBxjOxZzC/MYuuap0JxJOPw2rBiANgczFzkyJpEe49j/sqqqRKJRwqEQqVSUZDrL7Pwil669xPrqU1afPmVjbZXKaRkXl2gqztzKMlNz82QKOTQj1G87jxLOhABV01BUFS2r9e/wZrfJ6dExihCEIxGiiTiuDtVyhTWxitnt4DgO6WQCRQiEHIGLyiDKUwRQ0zJwVUacJljTjEEryKG/u/07zMLSIjduvczdzz7n4HCfzz/7hJs3bsobr//TdNm+No5TOjqUq48f8rd//R95cO9z6s06xbl5ZhfnyU/Pkcll0XQDTdVQNcVDHUsXx7bIZI/Z39ziYH+bTz5+n47ZYX93G8fq8v5777Ozs0c+n+fihUtcvnaV67ducun6SxSKU4Qj0f7sojczWVhcxnVtbNv0Zw3guoEB5RCP30WgDEHqBztpehwW2W/7yh43B8dvPUuEqpLOpUnncixeuMCFyxcpFgvYTpd6tYpuGBSmZ1i4fIFkKo2mG55ipiuH4JuDQn2QZimqTiaXR1EUOq0W2xvrHOzuEYslmLuwQjylYUuHw6NDbNNEShdlcZlELIqmKr6irkQI16d7j2tJjwGRii95vgO4vJ4rOa5FOpvm4uXLvPraG/zqF3/P06eP+ej990jn83Lun2BVyNfGcZ48fsh//vf/Xz788AN0Q+fi9WssXb5MPJclEo0hhIpEYIPvNN6QUNXCzC4tkM2mmJ4rsP74KVsbm6w+fky9WkWoKkvLK3zvj3/Ay6+/weLKCumM54QgsW2rf6CHFGRwPe2AAKDS0wjj/KV3fpF87gSkN5NRBEjF+1HpPW63a/uPo5BJZ0hlsxiqgmObJHNZ5pZXiCczKKqG63rU7KEiXcqzPBl/wo+iEEslWbp8hWajwcHOLs8ePiaSSKCHQ+jhENJ1OalW6HRNhBAszS+Sz2SwXduLKVKceSliCBnwJXzkHGycRPbBpBKQrkTVDNLZPC+//jJPnj5kf3ObX/3y57x0+2XmlpYnEQfg8cP78tMP3ufOpx8TChnMLC2wcOkiyUIOPRwBofR5i96191uf/inVdR01HqXbjIGUVCtlbNOiUJjh5quvcOvlV7l+62XyhQLReMzXN5PDgMQgZwVAKj2Y5VChP3xGlLFF7uDQyvPvsnJkUKh4sBVVqDTrDQ72Dlhd2wJNJ5XPkynmUDWtf/iGddHGKN3I4CeJoqgkMikK07M06w32t7c5OTwmmkySDYc8ZJDr0Oq0WdtcQ/jxJZlMDBX7QT7P7xRZnqOzM5rBCd9Jw5EwxdlZli9epFqpsre/w93PPiGVycgrN26KF34H6L3PPuXe3TuclEoUilPMLS+TnZkiFIkihILbQ3QFpumyLxMrcW2LZqNG+eSEaq2KphssLF3gez/4ET/+83/B9/7kR1y6cpVkOo2iqNi27WG2pDsQAVQ8KItQeqqXYuAYPYGyUUqy4FwZQDkKZelroclhyrH/fwUFVVFRVZ1ms8H+3h5bWzvo4QiJXIZIPN73TBHsbglGlGnkEBaud38QQqAZBtlinkwui22ZVE5PqFerQQA2pmtzVC6xtb/NzsEO7U7HG5CKM6I3/2CnOR+W4L1C3TBIpdPMLS6RKxQxHZu7n33G6pPHk4izv7sjP/ngfdZXnxJPJZi9sExmZgojHMVx3THH0vXTBi+tUQW06jVWnzzl8ef3OT484I03/4g//cm/4Mc/+XMSiSSqomLbVh/c2OemSM6S+EdEL6RURruqfTBjD+KP/AJ+fyCPH9xh3T6Fuc8ExVP4bzVblKsVytUqi5cuEI3HvUaA4/brKHkezF9KzorWyEG7N50knS8QjUZp1RvUqlVsx+4jD3p+fXh8hG3bJJNJCrkC0XAM13Z8AcWRsCOGaRRiBMYjRwafZ0PM2XDtsV9VNM0gO5VnZmGW0uERjx49YGl5hZdfe0PO/gHpB9pXm9d/IB8/fMjG2hqWZTGztEAqn8MIhzzmY187XI7APFxUIbDMNuVKnfVHT9jd3MC2LX785/+SH/zJj7n9xhvEY3EAHMcOELLOcocH0WHkcItAl2iMDtmXQ97LMXrPPpoYdwi86eG3HLL5Aq+99jq1eh3F0NAN3SPLDXWt5PD/hzTX5TiUDFKCZhjEElFSmTSm5WC12zi2g6KrfcENIQS261JvNHm69gwhVGaKBpqiB9rK4otUQc441vOo2oIR4XfwkN+GQSQSI1MoML+yxMNPP2NzY537n99ldmnpxYw49XqdZ08fc3JcQigq+ZkikWQMRdWwfVlYZfRu6qdolmlSKZXZ39hm89kzdE3j+vVb/Omf/wU3br3M1OxMoOiXQ51ROeZNliPifvILWCe/Tzb/XBaLjz9xpUMiHuP6zZtEYjEOS0eYro1EwXJt/24skGPwlXzR36VX6xjhCPF4gtNy2QewOqApA6UcX82mY3XZOzgkmcgQDccoZPPBfdb8400IxVj6giIUT+1HN0im0hRmZlh7/JiDo0M+v/MZ127e+oMJtX+la5xGvcbm+hrtVptwJEI6m/NWRCD6kHfXpz5KXBxp40gbKW0a1Tq765s8vnePWrXCpavX+Df/9n/ku3/8RxSni/5SWS89GwJRjYqZn1PAC7/N2lfXlAE1TCGGukyDOkiclW0KHvGgxOwIX6Un1eG6LqqusrC0xB//8Ef88R/9gCsXrxCLRLw3U54VXA9GymH6sk8bFQyYp8IT/whFIx6xzHX7iOz+65DeoXUl1Jp19o/2OTo5QgrZHwAPVHrEKDjibJoW+JAMZ2dD+gUi2KjxQKAhQ0fVNEKRMOl8mnQuT71e5/69u5SPDl/MiNM1u9QqZQQSIxLGiEZBqDj9AtcFFE8lWXrkKNdy6LTabD5bY3t9nW67y/f++E/40Z/+OTdfeRlVU/3UjP5dXI7kLWKks3UeFGukfBknljSkL/b8QCPH3FgV/3e4I48tcB0HRSjk8znCkQi5fI6tnW2OTo5otlveLEkRQVL/GTVo0Z/092ooT1BEUYUneKgonnyU6F0rBSHcgDabQNU0qtUaewcHFHJFsukMhm7gOu7QyxnUceMHnc/P5uSQdK8IIL11LUQoHMIIG2iGQXF2lmatxtHBAY8fPyKZzcnlS5fECxVxbMui2fLUTXRNRzP0fh9/0EXzd0n6q/va9RaHW7vsbWyBLbl+4wY/+MGPuXH7ZdLptA8YHGgrB9/QYU2jc4T9+JIKL1/IzZdfqgwS/bdJGSOqIdG1EKlkitniDBdXLrI4t0gmnfZc15X9LtvZZzm8A6fnREpvHuXXMr2NbIMVI15n0dtw4BXoHcvkpFJmZ2+XZqvVv6vIcSiA58xrxt1RxFipeNG/z6iqihEyUDVvSXC2WCCaSNBsN3j04D6HB/svXjvadSV21/bxST4fRbp9OdXe97j+cNLpdqmdnrD5+BmV41OmitP8sz//F7zxne8wNTOFbZu+0/iMloAiTK+VjQw65bCYuXxOezRY4IqhRlJQtUaOCt2MW2cTQK+MduUUH+M2aIM7jreqPRqNsbywxJULl1meXSISCnuaA3I41esJgoghFMPw88dxcWzb0y3QNI9QJ9S+Uym9D6XnRNBut9nc2aLWqPmCJMrYaB1MyeTo18651kIOTdCG5juKomJoBpqiIoFkNkUikwZF8PjhIw52d148x1FUBdXQUZVeC8ANJL/DObuCQq1UZn99i521NWZn5/nO9/6I7/3JD4gnYriO7S+R7c0yBuqWwdMrgzs0z5xn+fwQM1TLiDPErNGfkV+iAyf7INEgtEsE2t6i39KWriSbyXJh+SI3r90gk075GDh3ADRV/J9RxEDnTRnMqZAS27RpNhooqko4HMYwdFRFRfEFEHvr3xVfEF5VVFzpUq1WOTw+olqrofpR6mwDTQTEFYPXbJx++7j5WG/+NHjfdN+5AYxQmFQuQzKdYX9/m+3NdTZXn8oXynFCRohUOguKgmmamM2uj/NTPE3/3p3IdbBabQ639zk9PCISjvDqG29w+7XXyeayqKofqcakYXJor+VIvcNwtBgne/S7Js9Syud2vPpST2f+UZzbypXCw8dJPzIn4wmW5hdZmlskl8v1bxIC76ALoaAgUDz/6f92VVGwzS7tRo1GpYpm6ESiMTRVD2xqU/xeZu/z4OZguzbHJyVOyqe4vaVW4nyEhBzqVornJm1yeH3CUHTyKOYqrg9XSiTTZIpF2u0229s7bG1uvlgRJxaPMz09g64ZmK0O7VodbLfP/uhdbse0qZ9UON7dwWy3uXDxCm98+9tcuHyxL/gg5fl39+E7vxy7NlOed9IDYM3n1z/DIBhxZm4hRpoUY2jJY2/Lw39zXRdFVcllsizNLbIwNU/ECPc1ohUUf/uzYOg/34ma9RqVk1NajSbRWIx4KuFRExBnogbBNM/fzlapVCiVjmm0G7g4/W7dcG46zk/kua9pPPzGVz51XQ9Roah91Eg0ESVXKCA0lcP9fTZW114sx0kmk1y7fo14KkG33ebk4Ahp26h+gSoV7y7bbXbY29imfFwilUzz45/8BRcuXyGWiOM4Vr8rNMjlxWBh7Dk3dMmofNEwN2v4IIvnNgTOc5g+SrrfGh4/GxzCu50jdtFv6/qFvW07ZDNZlhcWubB4wVeucT2n8SNHb+9Or/MmHYfSwSFH+/sIRSGTz5HIZnBG2sQEO4aDF4MiVNrdDqXqKYdHHrJAEWO2ZAdf2/hKaMxeHhhO0Hs7gjzlVFX1ahxbuuihEMlsmng6TblaZmNjlZPjY/nCOM7s/IK48tJLLC8vo+kae9s71EunOKZJSPXybrtrUj0ts7O+TjQS5er167z+5rdJplJnwIb9PZfiC+l9g5QpCA8RY4c558+BGDjFUDk81NGTA77O2ExsFHXcmxGJ4FrQAPy+F3m81CwZT3JxZYXpwhSRSBinJ+AuBjwZRQhsy2R3fZO9jS1azRbTC4uk80VCkSiO4w7BggavmREVUe81NRtN9vb2aLZaHt6PoGCiGItlHXT2BqS/M0t7hmY+A+pFr1mBvxZSKIJQNEx+qohl2xzs7lE9Kb1YIM9rL90UN27fJp8vcHJc4mB7j2a5hgoYiobZ7FI5PqZ8dMDM9Cw3br3M0soK4UjIn+2IM0oqX/SyxVglIzFEBf4yt69RJ5Vf2KYeUVISz0vTzk9ognds3dCZLkwzNzNLLpPxpHHFYIUIAsxuh/JRiY0njzk9LqFoBvMXLhDLpHyagjvcKpHjB8W9qNntdjk4PqTeqGNaXYQizqhDDUuwiTGNZ/HF7Wp/HOHVal4C34Ni6YZBbqqIUBVKpRL7u7uUDg/lC4WO/tab3+HKjZtYlsX608cc7WzhdrqEVZ1mrU75uIRrdXjpxkvcvnXbEwsUBKAqYkCoksr4Tpg8p+gfXQmIGL5zykAHaKQhNK6bJIfv2WdwjKPpUO/OHpzC9wv1ETDlEE25V5RLUBTFY7bOzGLoOlJIUIW3SQFBaf+IZw8esvbwMY7rkJ+ZYuHiEuFo1EOe+6sRB7K8AQRAoNkhfb6R7drUazWOT45pNJseovx5ETXYMjy3HTIM5O1BWQXSa3Aow9hCVVPI5PIY0TDtdoON9XUa9QYvFB/n5hvfFgdHR7J0fMwnn33E2pOnuJZDYabIwcYG7XqT5ZUrXLp6neLcfJ/GPAr5EOPuEyOsyF40EWd09OR5qfiZgZ4YJXKdg1/rke2CDyYGhMlhtST/gAaHk8PPU/Z5Kr3D3RsUOo5D2IhSzBRZnlvk2doTyrUKnUaHw71ttje2ONk/xO5ahMIR4ok4qq7hAI47QIcqnP/6h8Rx/cK9dFIik8qQTWf7iIX+GnghzkAxBkRA2d9rPS4kD+Zto4o4vp4C0qN/x6NEYjEq9SYb68+4/eprLx4D9NqNW3RaLZqdFocHe+xtbdGq1Tja20cAN2+9xuLKRVLpNI7r9PWKn+s051bz4lzi1+hpkb166IsLp/HJ2phZkBhHPBMj6cuAu3AmURMjEUi6Xss2nUyyMDvP+rOnHO0ecLC9TeXkFKvTJRIKI3Vv+ZRt2bi2jdQART27caDnmCLoLCKw0sOLUqflKuVKmbmZaTTVeG7bWZxzrZ6vJjq2k9/XJQhFw0RjcWrqCTvbW1RqlRfPceaXlsT80hJGJCLf/uUv+OzTD9l8tk6j1WBheZlvffc7TM3Mouo6dtdBCHUkxRpLJ/vCAy/GHWwpx52ls3i3cWsuxPCezyBVRQjOKF7yfI2Ycw+QGEmHHMfGMMIUC9OEjQilvWMeff6QQqHAlWvXyaRTbG2sUyqVODk4or2yjJaIed1L6XoSvIAiR5RpzlyAwdfrrTqVepVao0EmlUVRFF9AUQSke8X5RIJzW9fja8igiqEQglAoRCKV4DQS4mB/h9o/YoPga6er9uob3yYWj1HIp/nbv/orkkqSpcUlrt+8SSqZ8N8YddDqHHv45FkxiDOCEnJYuEWI82nIY5pynEdc7v0+KcaxZs5uPR/znKUIsm4CyhvPwb+50kW4ElURvPrqKxRzOU7/4idks3nSmSyOZfL5x7/ll7/4JeVymcrRKemQQVg3sAUjziP7zUEx1DMbvsq2bVFv1Dktn5KKp9B0bWx3bViRUH7J25oY6BAMWolDem0CQSKZIp5IsLm7y97uDhvPnv2jgD6/do5TmJoSnXZT7m9tIF2XrK9OMzUzixGJesotivJFat/nZ1DiS9zCx+Kgvxj8POQMIgiIPm9d9JdJa4ZR3OI5T1b6reHZqWlymQy27RIKRzBCYdrNBrbZ4s6ndzkueTrZsXyWUDQ2tHUAoQ5HnjFoiuCVb7fanJyWmZueR9eN34ulJMaE9mBdJQMtfzEybI4mYiSzGRzpsrO1xfbmBsuXLr0YXTXOgD8dTMvCNE1mpme4eOUq0XgKxR+CDZC8ZweUfV2C0VTrCyjyz8uxz6xAF+fDaURgYj/u50c5M19UNvUBkEKM1RdgDAcnFImQTmfI5fOEQmFAYBghllYuUZydRtc0SodHdNsdXxA+MMEJLrgKPnkhzlQaQgg63S6n1RM6ZgfpukOA0t9FAee86XCPVNdP/Xqtab9OjSZiZPJZoqkk2ztbrD559OK0o0etdHzC5uYWlmVTnJ1mcXnJz8UHhzNIKhs3uRfy7JKJwXxNjl/PJ4eFLuQosrpPCDsnCo3mjuIL56fngEjHCIOcyUDlGWT2EOrctrEtq/96FU0llc0xOztHKpnieP+QZq2Ba1v+gqhzDrgcN4XxXpAiVCzHpl6r02zUsWzTg+8EOmvPLfqDrepz+9kqruvi2A6O4/QR3D0VUU3XiWdSLFy4RKVW4cnD+2w8XZMvpOOUT0rs7+wQjcWZmZkjV5g6O1QT4pxK/fyoMPrm//7ywHIs82BshXTOvOeLuxRnH1OIL/e0ZK+5LDzimhA+PD8UYXZ+keL0NI16jVa9jtnuehAnMab1+9zpsYe4dqVL1+xSqVZpd7pDEWccoGb0vjI02+pvblP86+RTTVwft+bfNJU++tqDZkWiUeaWltDDIfYP9vjtr3/B1vq6fAEjzhHHR4fksjmKxSmS6czQ9jDOUHcF41BRo8I1Q/oSYmSPy5cWLjrfT0en4UKMl1J+Pj7td6HOMUaEsCd35dMDegdNCBRFZXZunrmFBVzXk9Tqttp9RPUYjfjxr3+INQqW41Ct1eh0Ol8q9X1+SiwGWtj+Z8d1cBxPMXXwdR+Gg0DTQ+RniqQLeRqdFm/94u/Y2lh7sSJO6WBPnhzuU6tUKE7PkM4XMEKhAatzdLL/BU1/0cNZybMc/34tMkqyGpP+jMrkDhwgoEDZQzKMccqzTh7k84jgV4LPbAiBMMxTOUfFU/hqMX1n8bk13g4P8lPTzC0sEovGaNYa1Cu1Pongi6FKw88y2P2qNqq0O+0hpLqUoynvqA7D4GN44ZQyJFxv2Ra2Yw3ddPopuvRQ26GIty0ikkjw8OFD7n78Efc//US+MI5Tq5xSqVZwXZe5xUVSyVSfOhAUdDhzQxPjilHBWQLmc/I68bxVfOclamKYaTmGaiDOiVVCcMaRzooMnk095dkkLnCYB7RjEaADCKHgSpdkOsXM3Dwz8ws4tkW7Xkc4MhAFxfn8ITHcmOmzRIVCq9Wm1Wn1D/hozTj+mY92qYOwo8GqlG63i2lZaKoacCoRAPZ6N4p4NkOmUEAPh3hw/y737959gSLO8TG1ahVVUZlfWCCRSp3DT5dj6nLxu3duRmqmfzzVh8DOmEC6NFwM/8Mf7fyMKOjQSr9QD4Vj5PJFVi5eQEhoNes4lomQ9IU7eojq8zZ5BuNOL83rdDu02y0sqxuARrsjSHG+5DA64BBAu9PBMk0U1YucijIsat+D+kTjMTKFPLmZWXZ2t3j44C5PHzySL4TjHB/s0/AV+mfn5ojH40OF5QAGIs7oOYvzNJolZ1KcAcFLBM646BegY1PBwO+QZ3reZ6iPvsMo/ZRJVRRUofhIXzFMwBMB2I0cw48cabMPp5NyBHV9tnfeU/IUikoilebKtWtomk672aLTbPuSUANBD8YFw0C0CQJShRCYlkWn06F9ps4ZnwaPOtJQ9A04jSsdOp0uXdMK0BIYet96A25N04hnUyxcvoTpOmysr/HZR+9xsLcrv9GOUy4dyaOjQ9qtLol4gkwmQyhsDHbTBEUehor9QPqgeKQnVVNRNc377Esh9Xu6Z960c+YOQT2wHmZGiLO6ZSOryVVVRdN1NE3ztMukxHZsbMfx1rLjqbfouo6ua6iq0he1ONMCZ1hQcFSf7NwIPAS0DKQ1QCQSZWl5hXjMk7VtN1tI1/HZo2LEQcZDgkT/gHtf8LprJp12ZyBE8qWDsxiaGQ2Q5i6tTouO1cFxXRRFPXf8oPgt9VA4TGGmQLpQoN5q8OEH73C0t8c3GjlgmSbHRyXMTodYPEEskUDVNJx+Y2BcSiYGInbSG57aruPtt3FdD43eE51QtcGdSv4eOdDzEAaBlMh2bKxum3anQ7fb9Ytbp9/t0hQVwzAwdINwSEfXDf9AKMMi7UEw6jkyTOPT17MazUGeZiQcYmZmjng8Qb3ZpFmvk5rKerWQ69/R5YiYyDgZp4Bmm5QuHbNDy28QDEc9tx9BzhXCHamvFEXBsry19O2uieM6Xj01OiITHmq8JxKpqTrJVIrc9DS7rXWePH7IxtoqueKUnFtcFN9IxzFNk9LRMa12h0y+gKobSF9t0vWZgANBwQCl198w4EqJaXZotpp0Oh26VhdFUTA0nXAoTDwew1ANr2ngugMtaCnGowiGuDoiADmRw3wd/43u6ZNVqhWOT47ZPzyg0qjQaXf6jqOoKoZukIjGSCWT5LI5Crkc0UgcTe0N++w+92VoNiTPjzPiXEHzM9Mr9JBBNl8kkUhycHhAo1rDddy+ToFyZo4rxoxxhg+6C3S6Zp8VqqL41yroNF8AvQmKRQoFx3FpNJqYZhfpyr7jDLqr0hN26XM1vLmVqmrkZ2Ypl05Y297g0aP7zC0uMre4+A2NOFaXer3qQykSaLrhLQx03T6wpAc+FvR0vwSmaXJaKXN6esLJ6SnNTpO22fE0yYRAUzXCeohMOk0hlyeXzROLxFAU0d9gMHb2MNowEONulN7zkEC1XuXw8JDdgz1OqifeigzHHVpOhWXR7XZptZqUyiV29ndJxOLkMlmKuSKFQgFN9cTNXccZkrztqZl+cSY+WIJyhp3seOIX6UyKVDaNYeg0GjVs2x7uasnnq2SN60VYtkW728ZxbVRVDwJ3zmltj6OLDlJK0+xSrpaxTGuIvCcDVa4coWX0aOXxVIJMPksknmBjbZW97S1e/873vpmO02m3qdfrICCeTKBqKtJX5vQyMQXZ08Dx+/utdovSSYnD42NOKiXqjQaWZWE73nbo3uFWhUKlXqXaqFFt1pmbmiMZT6JpKtL5HVAEYnjY2Cu0qjVPc2xtc5XTSpVO10tZUJQhreXeLMYCpOvSbLao1etU6zVq9Tr1dpNCNkc8lkDXNBzH7fNfzqZn7ljnGUIVj7AEXB9PFo7ESWfSGLpBpVrD7lpeSqcoA7jS2X0hgfTsbDnt2A7dbhfbttF6PJ/npbgjTLXewylC4LoOnW6HSrWKbVtD7e3nwRt60KpwOEwynSKZyXJ4dMDe3g4nR4cyV5wS3yjHqZ6WZKvZotGoo6oG6WTK10vrHRpvWa0LqD5+qVavsn+4x7P1dSrVKqZjeoqgfto0UO10MV2LTrVMuV7l8OgIx3ZYnFskl8kOp2hDjEXG4pFHi27HcTk8PmJ14xnb+3v9ZsSQes7I1mXh5XfeunfXoVQpU65W2Ts64OrFy8zPzpPL5j0lTXfYseUQHGJ8KtRP9USguSi9qKUoKqquk0plMcIGjd0qVscE18O0eR1BGdjEJjlDghgJOwpgOzam2fXWQ+p+PSlHlhGI0XQ42E0crHq0bItWq8lpteKhBsY4WABZO1Q5SSnRNI1YIkG2UGT7yWP293YpHR2TK059s7pqpmXSbHn5bDIeY2p62u9KMVD5ZEApPjw65MnqM+4/fki1VsVFousGiqr5HRYGUq5+Y0DTdBSh0O52eLaxxubOFvVGI+Ak7u+wpMNL0VxXcnhyzN7hHiflMpqme4BU/+7ek+/taV/30jYX70P2liipnjZyp2vyeO0ZDx4/YntnB8s2/QHmOXMVMV4QsY/EdgN6AtIdSPUKQb6YI5VO0u20sNpNHNvyUARiWJFGML49P3BI/31xXUzHHOwjGnv85FmlR38dy8CLBLValZPyCe1O24uSQ7I5I8jZQFteBGZQRjRKplBECsFJ6ZTt30G48GvjOO12m5OjAyzLJJlKMTU7jaarfrQZpFxds8tR6Zj1rXW297epNxtYjh2YMwzTkL0hnfeh+sM6KSXVWpWj0iHHJ8f+5jcx4KT0HOg5w8XeOepYHQ6PDzmtVejaZn83Uu+wuv5HX2BPuri4g1zdPwi9GYorXVqtFntH+zzdeMbuwT6NZhOl1xEMpCviPFqEDFIFenLAbr/75fqPnU5nSSZS2KZJs9HAbLcHQ1DxPBbm+DuKKyWObQ/kpsSw+Mbzb0lu/1r03p9yteKn3O5gdnWG13RO6ibB0EMkUmn0UIharcr25gZH+3vyG5WqlUtHbKyt4zou6WyG4lTRX3Kr9CWfXFdSbzTY2F5nc2eTRquJovrC4CP85GCrtJdySOFVSNKX3D0tVzg4PPBX9YWHFTj69YMc21fyungu7Xab41KJTrsTSLLdgRSulGPSejGmVuqJjHvaLs12i9bOdn8leyQc6svZBjF7vQ11+DcEEShqxoj6IqWDlF4NkcpkSCZTSClpVGt0Wh2SOa+tK8U5C4DPmQt7sxyJ47o4jsMg65UjMyDB2LWOvfRQSizL5KR8ymml7F1HMcg1pRgRVZGBTmtgw6/ERVU1woko4ViMVqfFzvbGEBD1a+84h4e78sGDB7z323cIGwbTU1OkM3kUofsRx1sqW62V2TvY4cnqY7qmOegiB2WNxOBgKj2smhwmkiFBUVVMs8tp5YR2u0VI99T6XTnYjiZxBzvhgrMM4e3q7JhdWu0W1b6Cv+jv4OxN6oNEg/7g0P8eEXTykfpHVb1NBDv7u6iqgq7rzBSKKIqnaiPEaMvZHSQZQ4fdHdJnltJrtli2RTyRIJXLEQ5HaNQatJuN4X2cQy335zBtAysi3d7rFl4NJ6Q7vIT4zJIgOTQvsh2Laq3GabVMvdkc3HyE5FzlEinPaolKiaIIwmGDZCpB7eiU44MDmrX6NyNV29pYk3//t3/D27/4Gfs7u+RyOfLFaaKxWCBFU3Aci4PSATuHe9RbDRzp9geEwe0D44qAM+mGn7vb/nryrtnBse1AMS/PJxT0MFKKguPYdM0ulmX6kUEMUMxDUuLBlrIcA9KUYyf/CE/D7PDkmI2tTaqNqkfmUpTzQWr99N9Pz+RAbqnfLHFdXNchnoiTz+bI5nK0222ajdZQViXHPScZgDD16MyBaX4vJXV727EDK0sGSIRhhLsMdBy73S6lkyPqjTq2n4LL82A7jCCxR/4N4d2A4skECEHl9JRKuczp8ZH8WjvOo3t35XvvvM0vf/Z33LtzB7PTIZfPk81nMMIhENJTiZQOjWaDw6NDSqUTHIm/aFUMMzbFCApX8FxQp4unwWxaprdzVHwBj0QMgydt18W0Tb+dPU4KZNAFCsrBnukKnUv88QamzVaLnYNdjk6OaHW6KEIdv8i3/xvdMTupBwW1xMV1TGzLQtc1UkmvzjE7baTrfDGoIkjZDl5z10VaDq7j9p3B3zsyTKkQo0WUZ45t0Ww0OTo8ot1s9aFWvVqRsSjrYSHF4WvsOXU4nkRRVeq1GrXy6SCt/jqmap9+8K58++d/z0//y98iFUEopBPVNXLZHLF4ElXTkK6DUASdrsXR6RGl0xOanRaapg1FhlHxvvEFM2N3FspA8S7Pg1CJEUHQIA5MBre2izOLfvvzEylRh3j74gz5YJypioLt2nQ6bTa3t4iFYyTiiWGQ41DJ457V/5dBQVKBlC5Wp8Pu5ib7ezvea3NdpO3gODYIbbDxW8ozQoFBp+l16+xuF1yJHYp4XTBvJ8eQJG/wCXs1Yi8LVhFImo0aJ6VDDvf26JhNn1akDRoto2qrAbmoQaRnUNP6f42Eo6iqRrPT5rRSptP9GjrO9vqqvPvxh3zw/vtsbq2TzGbI5rKUS8ec7h+SSMQJhUPeIiRf9qjVbXN4dEi70/XawP25hexzz4e00MZpHwfQusG2phDe4ex1rM5OJ0aB9CKQpfudOukv1+0Vri4jj0NfOLB/iEYQMcHoIOTZtreUkpPTMqXTE9LJJLFI3C/0GdaXE5wFxAYQ1qoisC2HVqPBR+/9lk8++piT42Ms08SxLcxuB0OLI/CaH70qfxiDPVCcaTYbVI6POTk8IhoKo61IZH+1fFDqavi6yV4jREpc26TVbHJ6fMDW2ir3795BiYaIZTNki2Fsxx10IEcFQs/R5Zae5CcS0HQDVVGxLJt6pUq30/36OE75pCR3N9a49/kd3n37bXaO9gmFQ6xcu0Q0EsEyO5wcHBKOhAkZRn+ln+N06XTanFROsSx7oHAinb6YgwjIyI5iZIYGbSO5spAenVjXNbSAgFdQs/l5OhKaqqCpuo+hEgOqwZBKZWDM0AMkwjDmTpxRLDyTVkqg1WlTq1dpNOokYnFc129mjM1KA4qhos8rAMVbzGu2W2w8W2fj2SqNZhM9ZOBIDzZjwNDem+A1HNrMIAVW16RWLrO7vkYikiCbyuD6k/5gyBaBNr4MiOfYjk2306FRr1I6OmJnc4PHjx+RnZlhLhIZ6HHL4SGsPNunDPTo3EAzVaLq3lDctm1vVtj9GjnOzrOn/NV/+Et+++5vOK5VuXr7BhevXmNhcZ6ToxKON7nCiITRfcdRFA3LbtFut2g1vEGYqqhDh0QRoKnqEFVXoATukoM8Rfpr36XfNtUUlZCuE9ZDaP7EfHRSPl6zyYt4qqZjGAaaqmL6J0II2RfyUxTh0Qj6/Bylf2CUYAt1SD1TDClYDJivXou41mxQrVWZKc7429NGYTfueOdBemJp0kW6No5j4koHx3WxHIewYXgbu105VJAPp7xyqM3eEwHRVJ1Oq4W0bBrViidRzIjQeo9w1ptZKQrSdem229SqFRrlU06ODjnY32d/d4dwKo7r2ufu0BmHgZIjCkC97qiiqghN8bg9ZhfLtr/6jrOx+lR+/uGH/OoXf8/u/g7hdIo3Xr5BcW6ebD6DKxRsH5jnCYB7nZgev8K1XUzTxradvgKKl2IpuI5NxzQxWx2MUIhYNOZvF5ME6TMSieO43gYx/zg5tk0kbJCIxzF03VdTGQZRjqoBBMOE60o0VScUihAKh+h2u76ghOck3W6bdqtFOBzxNmqrqocBEyIgnt5L4RyvdauIYcE/OXz8hfBoxI1mG9uxURUdRVGHNMcIoJLParR5UdGybGq1Jp1uB6GqJDNpLly9SnF5kXAs5glm+jcRGXS8Xj0YXDMSDpHO5YmnMnSbLerVBu1Wx8fEKcP6Dr54iOu6WKZJs1Gn1azTadZptdvsbO2wsbGFZoRIZTLEUgls2xly4vEyx5x1nD6pfFhG5ctiEv+rOs6zR/flB+++w4e/fZdnzx4TTaeYXZpn/tIFovE4hm70i+0eRKUfev1pv3Qlju30wYk9ghMoOK5Ls95kZ2ODiGGQz09RmM6jakb/Ta83GzQaTZqtFul0ikQijq6HcR0HwzBIJlIeTEYEhnUj2CcxRs3G203pLZ9NxpM0m02wXFRF4LgujXKd3d1t0qk0mWyOTDaL67+RvcPU7XbptFp02h2SmQShSBShqv0o2a8HxKAJYjseYcyxHdSQHmCtjpFgGtlRI4VEOl4nsNGsY3Y8TbVwIk5+fpZMIYeq68PRZtyQPoAUUDWNUDxKNJ6g02jRaDRpN9vYlj2kTdDD01mWhWV26LQ7tFoNrE6TdqvF/s4ua+sblE5OyOQLJLMZItGIv86Qs1sazhNkHxr8BqorX3tBET3hkq+o42ytr8pf/O1f8+u3f8nG5gbTS0tcvHmd6aV5jEjU6176dF1F9fk0rovr9PJyxV+5PsAx9VbzuYDiT5k7zSbPHj1GuJLFhXmi4ZeJx2NIn9+zu7nD7sE+5dNTbr3yMpFwmEjIm4NEIiFy2Qy6rg3NE86AO88oh3roAKFoRMIRMpkMp+UTWq0GqtCQrqRWqbL68CnpdIYLF6W/9GmQTQnp0jipUDouUatWWLp0ASMcDuw0Hb/yULoutmtjOQ66vxsH4Q5leD2cmBTD0CEhBJbjYnU7tBt1ut02EghHIkRTMYxwCKeHOiK4riAwA+o7jf/+KQqKrhGKREAIWq0W9VoNyzL7giFCUfx1JDbNepVWq4XZ6eA6Jo5j0mo2uH//PhsbG3RMk4vLL5HO5dD0ELbj9NEAva6JPKNBMXiecohHNXi/FASqoqBpWj+1/8o5zqfvvyvf+tlPefvtX2E6JsvXr7J89SqpQhZVM3BtP3ooXgqiaiooAttxaLc7WF1zrNC48Isav1IgHIqQLRS4fO06B9s7bG/v0Wx2SCUTGLpBo9ngtFLBlpBJZ0km0hh6CMsyiYTCZFJZ0qlMX2ZVMOwcQ3FHiLFcel1TKeQLHB0dUPWRvIZukM5kmZtfYH97h8f3H9CsV8nksuiagWPbNBpNjvYPabU7pNJJFFX00xgZgNXIfrrhp4jSg7S4jnuGv9JLTeSwXPuQcLllmrQbTZq1uk9zdtFDBtIXXHfds8S+kRGulwSKYMtXoIVCSCnpNBvUamXMbrefMnU7HdrNJq1mE8vsei1vXDRF4eTolMf373Pnszt0Oh2mZ2aYXVoiGo14z2VkUc/46lMGlnidHV73gK6qohD1a+ivnOPc+eh9+etf/oK33/4VjU6LqYVZ5i9dIDWdJ2SEBneE/oIg0DQNVTN8MliFdrs1DBlXAkhdRfEg7dKb3sfjKiuXLhKLxjg5PsLqWnQt745sudIL+fEEhWKRZDrpT/wtMpkcmUyGeCwWqMvF+cNJV55ReHJdB4Egk0yTTmU4LZ9Sq9dRVZVkKsHihWVc16FerbG7u0/5pOJBaVyJ4zg4QDKTZGZ+hnAiglREn0M0zPwc2ZM57q4baOENFjgpfvgQCDxmqWV2aTWb1KoVzG4XRdWIp5KoujZIccZRy/2L5A4GYH2MnFAEoZC3e8dsd6mXT2nWa7SaDbqdNma7g9n1PpCur1IjaNaqrK+u8vln9zgplUgX88wuL5LKJkHTcBneltBPxYT4ksJd3s3INm2k46LrOolUilAo9NVynN2dbfn2L37BW796i42tLa6/dpvFy5fIz06jap6UqfQ7Yf7JwxGgaDp6OISiapyUTqk3695dQsg+w5Jecan0qLLee6mqGtNzc+RyOeq1BU5KJ7QaHvtT1TRS2TSJTJJ4LAHSa3+iqhTzRXLpHIYewrHNAAREZczinaHBZm/42YO7h8NhCvk81VqFcrWKUBVC0SizS/PooRAHuzvs7exTqdc8BqaqEY3FKM4WKMzMUJwpIlQxqG16ziECcv7yLOv0fGFzGYAPefK2XkFuYXXbtJp1To9PaXe7aGGDdD47tGlgrN/4tZ8ScB7RQwWoCnokgqbrmPUG1WqZWrVGtVKlVa9idTyHUVUFVfPo5Y5lsbuzzcP7D3j05BEogqmZaWaW5tB0A7vXGeunzPI5S07EmPZ9j2IAltnCcRxCkQiZdBojFP7qOM7G2qp89+1f8fOf/YzTapkLN66zcOUy8Vza453Ybn8Jqjsi5iAUBSMcRg9H2D/Yp3RwhNVpoxohr5hTvT68N0pWAlhB72I6rkQYBolsllgyNeDB+G01xY8kri/4EInEmJoqEo/HPbV+6eW/qtqLfKOb0QbsSdd1+oxUf8aGdFzS6TSzM9McHB3RNbu4UqKoGoXpIul8ipVrlzA7XbwGmkI4GsYIhzyWqxgodbrBiNJnYoqAUqiCpmqoqjqYHZ3Z+DZI9XqX2bEdb4bRadOqNdnd2aNjWiTSaVL5rLcJwpX4EMCzm+J8HQCJ660AQeAI2ddWC4dCKLqG5TjUq3Ua9QqdVoNuu+lptikKiqqgGzrddouDgz3ee/c9Hj58iGlZzC4vUpyfIZ5K4gYbIwH+juDcNcJn4Du9DMV1JY16A9u1iSUSZApTRGPRr4bjnJZK8uG9u/z93/415WqZdCHH0pULJDIJj5rsur6ogovrQzAUv6BzBeiqRigWIZZOUSqfcni4R+W0RLY4g6HrhI0whqbj9JfFir7GhgwgY4WioulK/7y7PvfE/wtISTwWZ352nmwqT8RfgaHpIaTj0GrUOTkt06jVaHc6nkCEqhAJh4knE6TSGSKRKIqq4kqnX4O5rkvYMMimc6wsLrG1v0Oj2fRQ1LqOauiEItH+klqB4rFb/YVOjhNsucrxy6jwoqVu6EQiEXRNG1lGOkx96KWfiuqtau92u5idFu16m9PyKZs7OyiGTiKbJhKLIxF+TcEIl2Z4U50SWBDcS4UQKqFIFD0URigKbbOL1fWQCL0IraoKmq5Sr1bYWFvn7t07PHj0iFq9QTQZJz87RTSVRFE0bFeeJb3JswuOg5SGsUNj6XVk65Uq0nHJ5Ipkczmy+YL4SjjO5voaH3/4EZ989BHTSwvMLc9TmCmiaJp3EFwQwkUG5iFOIB1xFUkkGiOdz/BkZ5e9vT0OdndI5Qrouk40HCWZSFBvNLFcB6Gp/pn1Oy3uqLbyoF1KQG85EoowlS+wPL9EMp5A04z+wfem1pusrj7h9OiIRquBY9tomk48FieTz3Pp8hXmF5fIFQveILEXG3zNr0Q8zsrSsqcD5jh0LLNfiXgsT7U/B5JSemDI3pYxeZ7MkxwiPUajEVLJBKoawOsJcUb1v9ei9nJ8i06njWOZVKqnHB4ccnBwyNTFFdKFHKquYdlOoLkgRvshIymbj6PrdawUBSMSIuyn27Zpe9QHQFW91rvjWLSrLdaePePzz+5w57M71BsNhKYQjkZJJBMYRsjjAg0g3c9fudVHNIyEIz9KulLSbneoVSooQqEwPe0rw35F5jjv/fYdPnr/AyzLZXZpgeLsHLoRwvY3DAQJUXJkE7T0645QJEQ2V8SyXTY3tnjw8BFLl68SiUWJR6MszS3ydH2NTrOBju7nsDJANhuVSwJNUT0GoesgpGRhdo7lpWWKhaKHG/N/4Phwn1/87Ge886u3ONjZxbW6HvTecXF8hR1N13np1i1++Kc/5vs//CGRaNQ7oK7rvUmOjaoo5HN5LlgrKEJhbWvDb1AJv83MgIvTT0XEczf4DqA8LmHdIJvMkEllfbJcb7CpnJHU7ddhjkO71aLbrKMK2N/bZ2N9nWazRTafJ5vP+emq7F9NMbKmQwxpccszVGqJwDA8fThFUbEtC9d1PKFFQ8O1HI5PTnjy6AHvvP0OhwcHSCFIpOKYto3Z7dJpeyIfSNGvhUdF5SViCIITxAwEh8rSl3SxLJtWrUmjWmUqk2dp8QKRSPSr4TiP7t+TD+5+zunpCQvLi+Sni0QSEb9pKYckh6QY2YXHoHbQDI1UNkk6n+G0VuH+vc9583vfoahNEY0YLMzO0u60EYf71NsthKKeWaMRXBblui6246AKQTKeYLY4w9LCotd+lgOej+1YHBwcsvr4CRurq4Q0LSAB69EaXFfidLs8e/SQ+YV5br78MqFwBFUVA9KWf6yElOTSWQSeJOv+ySGNZgvbtry6ZIiTMsq9F/3aqa+04HqwmJAWZnZ6mmK+QDQS8essObL1wD/Wvo6B6zhUKxU6nTZWt0uzXuPZ0zV2Do7Iz82SnckTS8b7W9nEmIgnxsrUBmYn/vZvQ9fRQgaKqtA127iOg2N1KZfLPHv8iMcPHvDg0WOklFy6ep0r169RrZV59OAh27s7nB4fk8xkicYTXkorhhV7ekNjd2StvaL46aIUwV1xgKDTaFI62Mfptsnns1y6eoVcofBfX+Vmf3dHPn34kJ3tbVzHYmHlqidbGzKw8V6UGE065FkVOtd1vFoiGWVmYZbD7T0ePXnE2tPHhEIh8oUcqUSM+ZlZELB7tE/Xsoc0y3p8fhkgv2iKSjIRZ6Y4zcriCplUEl3zJXWF2j8Inj6bVztpmooiVVBVVNfTNXNsxxvE+elVT+8sCH7ubwlzbWKRCJqmousGmq5zdHpMrdHAcZ2BjpsYkZIXQUj88LAxakRIpdPMzy6QTqYx+nVjb029R4cO6io7tk271aLZqOOYbTrtDqvPnrG2vkGj02Hh8gVSWa+b5sixKmxjgafizLIf78dUNHRdQ6iCdrPJ8f4uz3SVzY1N7t+7y87OLp2Oze3XX+Vbb36Xm6/c5nBvh3q9wfr6Osd7h2TzRVLZFFLTPc4VoOJi+40lr0Gk9m/EigDXsbFsG9cFwwihajoSgWM7NKpVjnZ2CBsGs3PzLF24wFdCV63VavH0yWPa9TqxSJTZ2WlisTCapqH4xOOeyot0+4XImfTEC70CzdBZunSB8kmZzc0t3vvtb8nmcuTyWcyOyVQ+TzwaIxmPs32wT7lawTQtX/nSReJpMwsgpIfJZDJcWFphtjhDKp7ogwYVRfMSPSnRdZXLly9x+9VXOTk6YvXJIzQ84KgALNOi2/VqlVuvv86Nm7fI5Yv9SDluMZLrOIS0ELNTM6RTSQ5Kx2ztbnN4ekir2cK2bW82FYwWsoeU8H5nz8kiWpipYpHlhSXmp+YI6T5PKcjedwHhogjVL9YFzUadyukJVreFJqBRr/Dbd37Lzv4eRiLKxZeuEEvG/XpGPn/f0Aj3aFhTrsdLU/xrJqiWK3z03gd89N6HPHh0n65lsbB0gZ/8q3/JP/vnP+HWa28IgJmZObmxtsGnH33C3vYeuakihaki0WwW23GQ0kFTNbrNpgfKDRlEYzGE8PCImlAoV2rUKhVs26EwXSSZTCOERrVZ5/TokNL+FpcvXuHi5SvML1/4akjgWqZJ9eQE4UoiiSjJZBJNKNTKNU6qFVTDIJGKE41FfW7HAGY+3Dvy0iGBIJnNMD0/R6fZ4qOPPmZufo5MNkO+MIVr2xiaztz0PIlEimarQbvd9RicjuPLrUp03es8peIp4rE4kVDIV7JRziwl8iAnUd749nfIpDPcv/MpG6urHO3vUj0to4fDzC2tcOXGDd747pusXLyEEdKHQIS9Q9TfUyMUr7XsOIQ0g+lc3ruxNKY4KZep1qvUWx5WzLbtgVKpD25VVY1QKEQiFiOXzlHI5UknUoRUj/DVWwvd38Lca7kjsawutao3fHTMDrFwhM31dT764BMePn5CKBFjfmWFVC4FQh+iLfN77bcdUAZURUX1nfZIHpJKZ7nxyutcvX6T6y+9xKVr1ykUi/2fzeSnxJXrL8k33/wOf/s3f83B9i7JZIJFI4QI6bhImq0G6+trmB2LdC7H8oUVQiEDx5fErVUrbG9uIB1JKplESwpMs8PRzi6lgwM0IXjttW9x8fJVvjKi6x7VtYEQkrChY2gKtUqVvaN99o6OyU4VCUfCaAkFRygeyFBKDw0sRF/ULtgw0EMGU7PTdJpNNp+scvfuXfLZHG9+/488QpKmE41ECIcMrGTaAw1aFo7ryS4JBXRNJWQYhELhQdvbdTy1+5FMXkivjT09M0s8HiefLzAz+4DVp4/YWV/3dslcvsKNl19meWWZWCIWSAfFc+nZ0nW9HZWhKOFQhEQsSjKWpN6sU6vXaLfbdCwT27aR0ulvOghpIaLRKMlEilQySSwSIaRpSMdBOn7L2hUIdUDscRwb2zRptz1ui+vYKAJqp6c8uv+Au3fv0bIsZqaLTC/OoxsRHFf2W9B8kQD9mIgUXPMzEJ33htVTM3NcvXGbxYuXuP7SS8wuLIytLxaXL/DGm29y797nlE9P2Hy6RjSSIFHMITSFeq1Caf8Q23bQdR3bNr331R8Cd9pdapWqxz7ttLE6TU6PyxzubGB3OqxcvMyNV15jen7hq+M4riM9FKwiEELS7XTY2dlidWuTUqVMNOUVeopQUVSJ4+ejlm2jGDpCHegG9Opk15VkCnkUBKWDYx4/ekJI1VheXiI/PUckqtBttwiFw8QiEYTfJelTeftkNaffLYLBwtUz3QRfiVMISKbT5ApTzC8tcvXaVR7ff8TFq5eZW1wiky9gm21c2/aHm+JLiIiLPkhVSghpYaZyXkvcti1ana4v9uFFHUVR0DSVUChE2DDQtZCf5trezSYArZfSm4UJHw7U7XRoNBo0KhWk6xCNhcGRfHLvPu9/8CHPNtbJz8+ycHGF4szUkDabPIfvIhDDRLux24AZ6rIpiiAWT/CDP/sJP/lX/4bi7MxzL9TC8gXhuq783sOH/OoXP2NnfQNd01lxLhNKhDk9OsZsNhCK5iFN/I6dogSUQl2JkC5mt8vp8QmbT59wvLPN9PQsP/jRX3Dp2g1yhSnxlXEcRVPRwmGkIjg9PeXB3fscnB6DoXHh6hUWlpaJJeOe+LnlsLe9S6VcRgsZFGdniSRjPqgQnxnpdUc0VSOVSXPrtVfYfPKUJ6ur/NV/+o/86M/+GRevXMUwQjQbDU83Kxzy9Nf6gDO3P4GXyDFLls7uEO0jCxwX024TjcZYuniZwsw84UgUw1CxzIGQhYdSFvjUIMaugxniwMs+ddrDZrp+0W8QMYzADw84OULiRZigKHzvMYVASHAsG9M06XY7dNttbMtEFZJQPMLJ0QmPHj3iZz/9ew5LJ+RnpnnplZtkpwooqjacOj9XlCNAe+6xWIdI0IESyK/PQuEoqXT6C52mZ0sXLol/+d/+dzISifDbd37D1tYG3W6LcDzm4dUch0goTFRXCGkqIVVFUVWvmYNEOA6W2WX10RNUvK3lly5d49vf+2N++Gd/zuzcvPhK7ccxDINMLoduGFROa5SODrEcm0wux8LSMvG0N6gzTYvWaY397W1qtToziwsDgTnpDh1mBYEqBFo4xNziLFa7yf7WDp9++hmJeArHdVm5dBkhVFzH8Q6L4l1ITVVQtN5m4t9tVWDP71zp3fmNUAjbtrGtLq4jMEL6gHLqDkQ/+8qdQ3T/gZ5z7zANqNuDx1MUtc8RIaAC4/r1mpTBjp0CiuvPl2xMy8LsmpidDma3FWjDO+zu7PLg83t8+smn7B8dEstmWbiwwtTcDEYo8rtvtA5itMcyZH3Yvw/FMQwdIxz+nc7StduviW6nK6OJJJ+8/x6HhwfUTyp0rK7HqnUcyochQqEI0XjJP9oOJwf7dJtNbMuig0I6leXGzZf51pt/xMuvv87C0vLvtS/yD+o4oXCExaUlHtyNc1o6ottqE0klyOez5Ao5FEXFdSXdVpej/T0ODw6RQDyZQtHUwPoLBjRXZTC8jCSSLC4tIxyHzz78mHfeeYdmp4Wua946DD3ip1kez0LXdTRdQ9c0FB9MKEeoyMNsXnEGtyH99MqDhqzS6bZJJZPMLi4RDoeHCmmhiHGi+/4nJ6CvLM+MbLyGiOOxMoUclk3qtZqFQPgMT+k6HgnNsjA7XdqtBma74w8bbYywt5m7Wq3y8fsf8tFHH7O2uUF+doblK5dYvLRCJOZFeNeVAULgl6lxhtvlg8sl+1iDQbot+li639Ve/vZ3xdTsnFxaXObdd97m4b177O3vYjs2TbuO1TGp12tomt6nC3TbLRRXEg1HyOcLXLt2k+/+8Q+5euMGhanp33vJ6h/UcRaXl8XtV16Rn3zwLvu723RNi7AcVqt0HIdOq83e7h6OdEllsqSyGYSmDKjGvWGj8Ki1mqqhqxq6opJKRGnlsuSKU+zuHXBafov9nT2+9eZ3uHrlKlOzUyAklmnRadc87JkRImR4vAvDMNAMHaGovqSuGFLNJLhTs7ftWDocHx7wX/72P7P2bJWlpRX+9X/3b1m5eJFoLIIt7aGfF8NaMgMaQkBVUroBB1NGeTZBXQsB/bWL9KOqN11v0Wk1MdsdLMtE11R0Q0PRQjTrDdZW17jzyafc+fwuHctmYeUil29dJTtVJBSJ+NR0Aq30ESHH870mMLceoBl6NxFXCqTrQ5wkGLrRl/D6XW16flHo4bCcv3CB3a1NVp88ZWP1GfsHO1TKZRx/PCAUhWg0xsziCtPzsyyvXGbl4iVmFhZZvnDpH7yV+A+OHJhfWubl19+gUqnw6N7ntOoN6qUyjeMK8XwWKSXtVpNqpUw4EiGbzxFLRD0NAOn225kKXt4uegzFroXZblM/Pebw8JBGrYYRCoEQrK6vUa3VWX32jGtXrzA7P0s6lSIcjXi0A8uk47p0u1103UA3DFRdx9B0VN3j6aMoQ+zOQQSSCKkQTya5fPkahhEmn8sTDUX8OYWvh3BG1kmMyFHJgdyUS1BxbUjxZWhXpy9P6zgWju1gWpZHBbBMHLPrNSf8RoZhaFiWRbVRp3JSZmNtjadPnrH6bI2O3aUwN8vKtcsUZmfQwx470xN/GeDA5BgUx/Ol0eUIddpFkX7rXTo4tg2uS8jQf6+I07Ncvihy+SLpdEbOzC1w7eZNKiclavUapml6kdpHuWcyKTLZPIXiFMuXrvyjLQ3/gztOrlAQr3/rTdmo1SgdH9Gq1ykfn6KFtpl2vCq3flKm02yRSqaIR2OoeO1T13b6HFzXcXEtG8ey6Da7tGt1qvUytdNTOu02oXCECxcuEYpEOD7eZ3trk4ODXbY3Nrh6/QoryytMz82SjCfQDd0HmCrYuo5pGWhaCEvXvKW2qoaqa15nRvH58AHNaQHk83n++Ic/5NZJGVXTyObyaD7FenjjsRgWBJRyiLgq3ZHVFEhce0QyCcXn1rvYPd6MbXnqmmYX27SQjg2+QKNE0umanB4fs7u3y/rqBmvPVjk6OKLVblOYm2ZmYY75lSVU3cBFDjYyjGFJijFajYxqlCHGEuykK8HXs3ZMj5lqhMKo2j/86BWmZ0Rheoar/NPbPwnI89ZrbwjdCMlEMslbf/8zNjc3eHznHke7exhhHduyoGOBaWM3m5T3DjA7po+hMum027SaLZr1Oq16g3azjdm10FRBLp/n8qXrvPG973PrlVdJZlKUjvb57dtv8fFHH3P/8QPuPbzPdHGKlZULXLl8kaXlZaZmZkimU6iKp1Jpmy0ss5eaeRwfVdW8z4rwN1V79ZGqepyXqekZilOzfSKV46+cEL6WW7/D1sfguYMj199L4zUIXB8J4Ppq/r2PHkLati0cx8axHR9tLVA1b0FVJKwhhIZtmVTKVQ7293ny5Cmrq8/Y3trh+PiYVCpDJBEjlkmih3RUv+nQx3YxRvkmqPsWbEGPxyKPVYmRwkVIgW3bWLZXb+lG6B8Ucb4K9k9GZLt285bQdU3mcnkePnjE2upTjo8PaTZqtJtN7HaXysERdqvFweY2tmni2LbHyPQ7AoqikUxnmF9cJpstMjU9w/zCAvOLi8wvLLJ86bIAWL5whWg8IZcuXuH+vXs8efCQk5MSD588ZmNrg0KhwOzULDMz0xSmpsnmMsQTSaLRiE8eM7w83bVwXNvTdPN7yj3BQ0UoqJoS0APzUpMePkwE1Hl66Y+U3lTfw831Wsme00jHI8BJrxgIDH17kBsXFYmqCRzbaxxYXcsbaDbqlE8qlI4O2T885PjogMOjYyzLIRyNcevVBa6/dBOky9bGOpvbG7SbTQ/m1JPLOg8KcEa9NLhBdBhPF5SKGmze8C6eYzt+B9IhGo2ha/rEcb6sXbx6XWRzebm0cpHHjx/z7MkjDvd2qJycUq/XcSwvPzWbHZASVSjo4RixeMJjIqazFKanmJ6eY2Zunrn5RS5fuzo2b33p5mtiemZBXrx8hTsrd3ny6D7rq6scHx6yvrbJ7tYu6VSa4lSR4lSBQj5PJpcnlUkSjSeJhsPoupeLK5o6UHQJSE0OahAVoagBDWRlGJwZVMl3JVL6MBp/DuO6fmSR7oj6+iC160Uc27Hptlu02x1a7TbVaplS6YTS4SnHxyUa7SaO42CEwizPzzC3uMKFS5e5fuMGJyfHmFaLtdUntFpNHMtG1fXhJaBCnruLaRQfLcZKAMoh9HbPbNPG7npYwGg8hmFMHOd3sky+IDL5Ardef4NS6UiWSyWO9vc52NnhtHTirW9wPeGEaCxKIpVhemaa4vQ0ucIUM7OzX7rAy+YKIpsrcOP26+ztbsmdrS0e3r/P/Tt3ePr4Iatrqzx8eB+hCCKRKIVikenpKaanZ5mdnSKbL5DJpIjHk0QiYXRDR9W0PnhTqGLA9/H3vHh3WHeIUu3xR9z+Sr4eqFU6foNASlR/X4zreOmaZVt0ux067RbNeoty9ZTKaZly+ZTT0xPK5QrlcplarYZle1uc4/EU88vLXLx8jZeu3+DStctMz86RyRcFwOMHn8tUIoUAbNP0ZlxEh0VGhnZySgZMDzEelCbl8B4i2VO180TTvaaOxDJNTMtEIEnE4l+K1z9xnHMsny+KfL5IJpOViysXMbsdLMvCld7eEk3X0HWDcDhMcXr6H9QRmZ1bFIYekvlckZdu3OTk+JCDvX32d3c53N/nuFSi222zf3DA/t4+9+7rhAwDwwgRi0UJRyJEwlHCUa+VHQ4bHs5ONzCMcF/qVtXUPt/fU+DplTZ+xHFcH1rkYNveMtlup0271aHV8cT6On5EMTttOp2uN/k3uz5mzWvLq4ZOKpNlbmmFQn6aqZkZpmfnKc7NUSgUSSZTzC4sDF0zVdXQDE+myfZRBaF+hTZeX3pcd0Ccs35EnllKOOjOmZ2OP4xWSGTSXgd04jj/QAeamhb/JI9TnBL54hQXuALA9sa6PDo44OjwgIP9A8qnJarlU6rlU5qtBp12m1qjQa3R8ElkAl3zRCU0RUUL6eiqiq6F0MMGiiLQNdXrxvVzuYBIrT+odBwH23Z81cou7Y6J2e3Q8TtklmX5KZ2v4qOqRKIR0skMyUSSeCpFKuNtcUhnixSnZ5iemiabzz/3WiqKim54LXvHdrAse0id5zmb58dg1kRgE915NZL0Z0KSZr2BbZrohkEmk/5SEkwTx/mK2sLyilhYXhn62vH+rqyWyxwdHXK4v8fR0RGVSo1qpUy1UqFRr1KrVWg2PVV727YGxDN3MGl3g3Ri2SMV+NwYn1DXGwgK4XXIwuEI0YgnF5tKJonHEySSKZLpLAtLS8zOzzM1NU0qnWZ6YVH8XtjBUBhVUbzmgu844/ffisHO0DFSv/LMao7B4hN3RFXGtm2atTq2ZZOIREnnC4Qik1TtG2WFmTlRmJkjW5ySK5evelwef9Bo+msJW60W3Xbb+zBNnzMj+wW8218QK/sC52KIzKb2tc9UHwoUCoWIJ+KEwhGMUAhDN7zWt66h6yHCkSjhaJRCsfh7R2chVHS/GWDZNpbpiZ+fu8GtH2YG8rJiJK0brNcYUAuUHi5NeDWdbZq06hWQLslEinQ6S65QFBPH+Qbal5EIKh0dyv68xfWFO/xZjOszWuWZfTgDzr8iBEJV0VTvQBdnZv+gh0lVFYxQGEVVPahTp+tN2VVlWPlTDnECBs7zXP6aCMx7fZkuoeA4Dma7Q6NWQVNUMrkC8VT6a38+Jo7zD6yZvk7PV1VVIpEIqqbhmF3MrkeFwFVHVGFGHEWMWeQ8Rg5qFF7giZ2YdFodWvU6yUiCfGGaSCz2tX/vlcnxf3FM0zQi0agn3mjbdJptr4vp9hAM8tyPvvafFEN7Sfsi9KMa3kL4axEtmrU6ZrtFLBqlWJzyxBInjjOxr039VpwSsWiUkBHCdV1arabf/veUQl3k8Jbu4T3Nz9EVCC7C7u278deGdLrUKhVc2yKdzjAzO0s2nxMTx5nY18pisRiRSAjput5ajW7Xq9H6m5sHUruMdZ4x8rd9KoYHNvIaH943dVtt6uVTVEUhVygwMz//zYjek6P0YpkRMtBDEU+HoNnC6lhYjo0qdPC1n8/I7I5ojghGmge+WGKP/NprUruOTateo1k9IRFPMTs/z/TcN8NxJhHnRXMcI0w8nkBRVTrtDqbZ8RDXfrLWS9v69c1Q2ja8DrGfovXTM9Fvs2uqRqfVplGt0G02mJ6dZ3pm/kvrDEwcZ2JfuYgTSyXRdJ1up0O33cWxbY/25AZVT+k3DII0tXELqwbihz2tBM+RmtUGjUoV17ZYXL5AcWb2m9NomRwlXrDOmkEykUQzDA8b2GljW96+UNf11EUUAa7woJoKwpfPHVUCEsPsVIZ1pKXjUi4d06hVMHSDC5euUZiamTjOxL6elssXRDpXkPFYHNuxaTXbOJbtDy5FfyOj2vePQXtgoD3NkEJpsPJRFG/o2WrUOT3cR9o2s3NLXLh8mZXLl8U35TpOUrUX0IpTRZKptLeVu9H0lxEPlFOHdngOr5/1ln75K80VZQBiDW7Psyyb8tEplZNjIuEIV1+6wczCwjfqGk4c5wW0qalpcrkcqqrSrNUwux1PCAVPbkrgibo7ruNtlhMDWrT0N96pqvCJuQHZKl/mttVqsbezQ6tWY6pQ4PVvfZellYvim3QNJ6nai5iuFaeYWZgnm8nRqtcxmw0UKVE1HU261E8qrD9+QHZqlky+QCKbwZEuqlBA4qHEKxWkY1OcX0I1PPybKgRmu0P1+JDSzhqJeJxLV65z7dYr37hrOIk4L6DNzi2IudlF5hYX6bSa1CsVrFabiB4CKalVyqw9fkzl+ASrY+ECjq/75riSynGJvfVNdje36XQ63kFSPaXq8vERxzs7tKonLC+tcPnaS8wvr4iJ40zsm+E8CwtcvvoSrmNTLZ3QODklpOlI26FZq1Ha38Nst5GOt73OlQ6OBMuyKR0ecbS3S/n4GMu0vG1nUtLtmBxub3Kyt42uwO1XX+PytRvfyOs3cZwX1nEWee3bbzI/v0izVmf10RNOj46x2l1Pn1tRUXUNVAXbdXAlOI5Lt9OlVa+DlERjMWKJJBIon57y9P59tlfX0FB4/Y3v8PKrb3Lp+k3xTbx+kxrnRW0QTM+K1uWm/P6f/Ij3f/suhwd7rN67TyweoV2vEwpF0PUwqq56RDcB0pFYnS71Wh3X9RZ0WZ0Wp0fHHO3tsLu2huo4XLpyhR/9s3/O/PKFb+z1mzjOC2wrFy+LH/3kL2S91eT0rV+w8fg+iWQC6TqE9JCnDudKTyEUBds06bZatBpNNAHSdjjZ2WF/b5fD3X1a1Qq3b73C629+nx/9i/9efJOv3cRxXnC78fLrolFvSFWo/PS//GeO9vaQrotjW9RKJSKxKLZpo2oKZqdD+aiE0zVxXZfS/gGHu3s0GnXC4Sgv3XiNv/hv/lteeeNb3/jrNnGciXHxyjUQAt3QefLoITtbG5RPjjne36VWLWNEIp7mmy0x2x3atQaqcME2CEeiXLt2g0tXb/Dqt77NtZduMD27IL7p10xIKScnZ2IAPH14X3768Uc8/PwOG6vPqFTKHtnNtrAdiaqo6JrhbT0LGyQTCWYX5rn56re5eftVbr72mnhRrtXEcSZ2xrY3N+T2+joba2sc7O1SrpRpNJtomk4iHiMRi1GcmmJucZELV6+yuHxRvGjXaOI4ExtrJ8fHsl6v0Wo26bQ9bQIhFEK6jm542gXRWJyp2TnxIl6fieNMbGJMBqATm9jEcSY2sYnjTGxiE8eZ2MQmjjOxiU1s4jgTm9jEcSY2sYnjTGxiE8eZ2MQmjjOxiU1s4jgTm9jEcSY2sYnjTGxiE8eZ2MQmjjOxiU1s4jgTm9gf0v7/oirLONuvjQoAAAAASUVORK5CYII=';

/* ---------- 2. Static product catalogue (mock backend) ---------- */
const GRADS=[
 'linear-gradient(135deg,#CBD8C8 0%,#8FA694 48%,#5F7A68 100%)',
 'linear-gradient(135deg,#E8D5C4 0%,#C89F86 50%,#8E6A57 100%)',
 'linear-gradient(135deg,#C9D6DE 0%,#8CA7B8 50%,#5A788C 100%)',
 'linear-gradient(135deg,#E7DECB 0%,#C9B57E 50%,#8E7A46 100%)',
 'linear-gradient(135deg,#D8D0DE 0%,#A99CB8 50%,#6E6383 100%)',
 'linear-gradient(135deg,#D8E0CB 0%,#A8B98C 50%,#6F8355 100%)',
 'linear-gradient(135deg,#E6CFCB 0%,#C69A93 50%,#8D615B 100%)',
 'linear-gradient(135deg,#CFDCD6 0%,#8FAEA6 50%,#52766D 100%)'
];
const SERVICES=[
 {id:'walking',name:'Dog Walking',short:'A proper adventure',icon:'walk',rate:28,unit:'per hour',g:GRADS[0]},
 {id:'boarding',name:'Overnight Boarding',short:'A home away from home',icon:'home',rate:58,unit:'per night',g:GRADS[1]},
 {id:'sitting',name:'House Sitting',short:'Someone stays over',icon:'moon',rate:45,unit:'per night',g:GRADS[2]},
 {id:'dropin',name:'Drop-in Visits',short:'Food, play, cuddles',icon:'paw',rate:22,unit:'per visit',g:GRADS[3]},
 {id:'grooming',name:'Grooming & Bath',short:'Fresh, fluffy, calm',icon:'spark',rate:48,unit:'per session',g:GRADS[4]},
 {id:'training',name:'Positive Training',short:'Better days together',icon:'book',rate:65,unit:'per session',g:GRADS[5]}
];
const EXTRAS=[
 {id:'exwalk',name:'Extra long adventure',price:12,icon:'walk'},
 {id:'photos',name:'Photo & video updates',price:5,icon:'camera'},
 {id:'meds',name:'Medication / special care',price:8,icon:'shield'},
 {id:'bath',name:'Bath & towel dry',price:18,icon:'spark'},
 {id:'pickup',name:'Pick-up & drop-off',price:10,icon:'repeat'},
 {id:'late',name:'Late-night check-in',price:15,icon:'moon'}
];
const BADGES=[
 {id:'checked',label:'Background checked',icon:'shield'},
 {id:'insured',label:'Insured & bonded',icon:'badge'},
 {id:'vet',label:'Pet first-aid trained',icon:'plus'},
 {id:'gold',label:'Willow Favorite',icon:'star'}
];
const REVIEW_TAGS=['Great with my dog','Sent lovely updates','Super punctual','Calm & gentle','Above and beyond','Would book again'];
const FAQS=[
 {q:'How are sitters screened?',a:'Every caregiver completes an identity check, a background screening, a reference review and a pet-care assessment before their profile goes live. Fewer than 1 in 8 applicants are accepted.'},
 {q:'What if my sitter cancels?',a:'We immediately find a vetted replacement at no extra cost. If we cannot, you receive a full refund plus a credit toward your next booking.'},
 {q:'When am I charged?',a:'Your card is authorised when you book and charged only after the visit begins. Cancellations follow the policy shown on every sitter profile.'},
 {q:'Is my pet insured?',a:'Every confirmed booking includes the Willow Care Guarantee: veterinary coverage up to $25,000 and 24/7 support for the duration of the service.'},
 {q:'Can I meet the sitter first?',a:'Yes. After booking, use Messages to arrange a free 15-minute meet-and-greet. If it is not a fit, cancel for free before the visit starts.'},
 {q:'How do refunds work?',a:'More than 24 hours before start: 100% back. Within 24 hours: 50% back. After the visit begins: no refund, but our support team will always review exceptional circumstances.'}
];
const SITTERS=[
 {id:'s1',name:'Maya Chen',initials:'MC',role:'Dog walker & trainer',rating:4.98,reviews:214,jobs:640,repeat:92,distance:0.8,rate:28,resp:'~8 min',instant:true,g:GRADS[0],av:GRADS[7],
  tags:['walking','training','dropin'],badges:['checked','insured','vet','gold'],pets:['dog'],
  bio:'I have spent nine years turning ordinary walks into the best part of a dog\'s day. I read their body language, keep the pace theirs, and always come home with stories.',
  story:'Before Willow I volunteered at a local rescue, and that is where I learned patience. Sniffing is not wasted time — it is how a dog reads the world.',
  area:'Cedar Heights', reviewsList:[
   {n:'Alicia R.',d:'2 weeks ago',r:5,t:'Biscuit waits by the door now. Maya sends the sweetest photo updates and never rushes him.',tags:['Great with my dog','Sent lovely updates']},
   {n:'Devon P.',d:'1 month ago',r:5,t:'Reliable, kind, and somehow our nervous rescue settled within a week. Genuinely lovely human.',tags:['Calm & gentle']},
   {n:'Priya S.',d:'2 months ago',r:5,t:'Rain, snow, late flight — Maya has never once let us down. Worth every penny.',tags:['Super punctual','Would book again']}]},
 {id:'s2',name:'Jordan Ellis',initials:'JE',role:'Home sitter',rating:4.95,reviews:168,jobs:410,repeat:88,distance:1.3,rate:45,resp:'~15 min',instant:false,g:GRADS[1],av:GRADS[2],
  tags:['sitting','boarding','dropin'],badges:['checked','insured','vet'],pets:['dog','cat'],
  bio:'A quiet, steady presence for pets who like their own space. I keep your routines exactly as they are — same walks, same bowls, same bedtime.',
  story:'I work from home, which means someone is always there. I send one honest update a day, plus a photo if your pet does something adorable.',
  area:'Maple Grove', reviewsList:[
   {n:'Nora K.',d:'3 weeks ago',r:5,t:'Came home to a calm cat and a spotless apartment. Jordan even watered the plants.',tags:['Above and beyond']},
   {n:'Tim B.',d:'2 months ago',r:5,t:'Our older dog has medication needs. Jordan handled everything flawlessly.',tags:['Calm & gentle','Would book again']}]},
 {id:'s3',name:'Sofia Alvarez',initials:'SA',role:'Boarding host',rating:4.99,reviews:302,jobs:890,repeat:96,distance:2.1,rate:58,resp:'~5 min',instant:true,g:GRADS[6],av:GRADS[4],
  tags:['boarding','sitting','grooming'],badges:['checked','insured','vet','gold'],pets:['dog','cat','small'],
  bio:'A fenced garden, two resident cats who mind their business, and a strict two-pet maximum. Your pet is a guest in our home, never a number.',
  story:'We send a goodnight photo every single evening. It is the small thing families tell us they miss most.',
  area:'Willow Creek', reviewsList:[
   {n:'Grace L.',d:'1 week ago',r:5,t:'First time leaving Millie overnight. The goodnight photos made our whole trip.',tags:['Sent lovely updates','Above and beyond']},
   {n:'Owen M.',d:'1 month ago',r:5,t:'Sofia is the person you hope to find and almost never do. Book her early.',tags:['Would book again']},
   {n:'Hana T.',d:'3 months ago',r:5,t:'Our cat is famously difficult. She purred on day two. Enough said.',tags:['Calm & gentle']}]},
 {id:'s4',name:'Liam Okafor',initials:'LO',role:'Groomer',rating:4.91,reviews:127,jobs:380,repeat:84,distance:2.6,rate:48,resp:'~22 min',instant:false,g:GRADS[3],av:GRADS[5],
  tags:['grooming','dropin'],badges:['checked','insured'],pets:['dog','cat'],
  bio:'Fear-free grooming, one pet at a time. No cages, no rushing, and plenty of peanut butter. Sensitive skin and senior pets are my speciality.',
  story:'I trained in handling anxious dogs, so I work at their pace — even if that means a bath takes twice as long.',
  area:'Riverside', reviewsList:[
   {n:'Cora W.',d:'2 weeks ago',r:5,t:'Our senior lab came out fluffy and, more importantly, happy.',tags:['Calm & gentle']},
   {n:'Ben H.',d:'2 months ago',r:5,t:'Patient, tidy, and clearly loves what he does.',tags:['Would book again']}]},
 {id:'s5',name:'Emma Brooks',initials:'EB',role:'Cat specialist',rating:4.97,reviews:96,jobs:290,repeat:90,distance:1.7,rate:22,resp:'~11 min',instant:true,g:GRADS[4],av:GRADS[0],
  tags:['dropin','sitting'],badges:['checked','insured','vet'],pets:['cat','small'],
  bio:'Cats are not small dogs. I let them decide when we become friends, and I never force a cuddle that was not offered.',
  story:'Litter, water, food, an honest note about mood — and a photo only if your cat agrees to be seen.',
  area:'Cedar Heights', reviewsList:[
   {n:'Mira D.',d:'1 week ago',r:5,t:'The notes are hilarious and so accurate. Emma clearly understands cats.',tags:['Sent lovely updates']},
   {n:'Paul F.',d:'1 month ago',r:5,t:'Zero stress, zero surprises. Highly recommend.',tags:['Super punctual']}]},
 {id:'s6',name:'Noah Kim',initials:'NK',role:'Trainer & walker',rating:4.89,reviews:74,jobs:210,repeat:79,distance:3.4,rate:65,resp:'~30 min',instant:false,g:GRADS[2],av:GRADS[1],
  tags:['training','walking'],badges:['checked','vet'],pets:['dog'],
  bio:'Reward-based training that fits real life. We work on the things that actually matter: loose-lead walks, calm greetings, coming when called.',
  story:'You get a short written plan after every session so progress does not stop when I go home.',
  area:'Eastfield', reviewsList:[
   {n:'Jules A.',d:'3 weeks ago',r:5,t:'Six weeks in and our pulls-like-a-train pup now checks in with us.',tags:['Above and beyond']}]},
 {id:'s7',name:'Isla Moreau',initials:'IM',role:'Boarding host',rating:4.94,reviews:143,jobs:460,repeat:91,distance:4.2,rate:52,resp:'~18 min',instant:true,g:GRADS[7],av:GRADS[6],
  tags:['boarding','dropin','walking'],badges:['checked','insured','gold'],pets:['dog','cat','small'],
  bio:'Big garden, long woodland walks, and a house rule that every guest gets a bedtime story. Yes, really.',
  story:'I host one family of pets at a time so nobody has to compete for attention or space.',
  area:'Oak Ridge', reviewsList:[
   {n:'Rhea V.',d:'2 weeks ago',r:5,t:'The bedtime story detail made me laugh, then made me book. So glad I did.',tags:['Sent lovely updates','Would book again']}]},
 {id:'s8',name:'Theo Bennett',initials:'TB',role:'Drop-in sitter',rating:4.86,reviews:61,jobs:180,repeat:76,distance:5.1,rate:20,resp:'~40 min',instant:false,g:GRADS[5],av:GRADS[3],
  tags:['dropin','walking'],badges:['checked'],pets:['dog','cat','small'],
  bio:'Reliable, flexible and happy to help with the small stuff — plants, post, bins — while I check in on your pets.',
  story:'Short visits, detailed notes, and I always double-check the door on the way out.',
  area:'Northgate', reviewsList:[
   {n:'Sam G.',d:'1 month ago',r:5,t:'Consistent and kind. Exactly what we needed.',tags:['Super punctual']}]}
];
const COUPON_CODES={WILLOW10:{label:'10% off your booking',type:'pct',value:10},CARE20:{label:'$20 off',type:'flat',value:20},FIRST5:{label:'$5 off for new friends',type:'flat',value:5}};
const SLOTS=['08:00 AM','10:00 AM','12:00 PM','02:00 PM','04:00 PM','06:00 PM'];
const QUICK=['Is everything okay?','Could you send a photo?','Running 10 minutes late','Thank you so much!'];
const AUTO_REPLY=['Absolutely — I\'ll send an update shortly.','All good here! They just had a little nap in the sun.','Of course, no rush at all. I\'ve got everything covered.','Just took a lovely photo, sending it over now!','Thanks for checking in — we\'re having a great time.'];

/* ---------- 3. Persistent state (localStorage = mock backend) ---------- */
const KEY='willow.o2o.v2';
function today(offset){const d=new Date();d.setDate(d.getDate()+(offset||0));return d.toISOString().slice(0,10);}
function seed(){
 return {
  user:{first:'Olivia',last:'Bennett',email:'olivia.bennett@example.com',phone:'(415) 555-0142',initials:'OB',
        location:'Cedar Heights, San Francisco',member:false,points:1250,credit:0,emergency:'Alex Bennett · (415) 555-0199'},
  pets:[
   {id:'p1',name:'Biscuit',type:'Dog',breed:'Golden Retriever',age:4,weight:'64 lb',g:GRADS[1],initials:'B',
    personality:'Gentle, food-motivated, loves water',allergies:'Chicken',meds:'None',vet:'Dr. Reyes · Garden Street Animal Hospital',chip:'985 141 000 412 887',
    notes:'Pulls a little on lead. Afraid of thunder — keep him inside during storms.',vaccines:'Rabies · May 2027 | DHPP · Mar 2027'},
   {id:'p2',name:'Mochi',type:'Cat',breed:'British Shorthair',age:2,weight:'9 lb',g:GRADS[4],initials:'M',
    personality:'Shy at first, then extremely affectionate',allergies:'None known',meds:'Daily probiotic, half a sachet',vet:'Dr. Ames · Neighborhood Veterinary',chip:'985 141 000 733 210',
    notes:'Hide-and-seek champion. Check behind the sofa before leaving.',vaccines:'FVRCP · Aug 2027 | Rabies · Aug 2027'},
   {id:'p3',name:'Pip',type:'Small pet',breed:'Holland Lop',age:1,weight:'3 lb',g:GRADS[5],initials:'P',
    personality:'Curious, loves parsley',allergies:'Iceberg lettuce',meds:'None',vet:'Dr. Ames · Neighborhood Veterinary',chip:'—',
    notes:'Fresh hay twice a day. Keep the hutch door latched.',vaccines:'—'}
  ],
  favorites:['s3'],
  addresses:[
   {id:'a1',label:'Home',line:'148 Alder Lane, Apt 3B',city:'Cedar Heights',zip:'94110',note:'Gate code 4412 · spare key with the concierge',def:true},
   {id:'a2',label:'Weekend place',line:'22 Harbor View',city:'Willow Creek',zip:'94112',note:'Ring the bell twice',def:false}
  ],
  cards:[{id:'c1',label:'Everyday card',last4:'4242',exp:'08/28',def:true},{id:'c2',label:'Backup card',last4:'8810',exp:'01/27',def:false}],
  coupons:[{code:'WELCOME10',label:'10% off your booking',type:'pct',value:10,used:false}],
  orders:[
   {id:'W-1042',sitterId:'s1',service:'walking',date:today(3),time:'10:00 AM',qty:2,pets:['p1'],extras:['photos'],addressId:'a1',note:'Please avoid the busy road.',status:'upcoming',total:74.31,breakdown:{base:56,extra:5,discount:0,platform:4.88,tax:5.43,credit:0},coupon:'',created:today(-2),points:74,reviewed:false,tip:0,
    timeline:[{t:'Booking confirmed',d:'Maya accepted your request',done:true},{t:'Reminder set',d:'We will nudge you 2 hours before',done:true},{t:'Visit begins',d:'Waiting for check-in',done:false},{t:'Photo updates',d:'Coming during the visit',done:false},{t:'Visit complete',d:'Receipt and review',done:false}]},
   {id:'W-1038',sitterId:'s5',service:'dropin',date:today(0),time:'12:00 PM',qty:2,pets:['p2'],extras:[],addressId:'a1',note:'',status:'in_progress',total:47.92,breakdown:{base:44,extra:0,discount:0,platform:3.52,tax:4.04,credit:0},coupon:'',created:today(-1),points:47,reviewed:false,tip:0,
    timeline:[{t:'Booking confirmed',d:'Emma accepted your request',done:true},{t:'Sitter checked in',d:'12:02 PM · arrived at your home',done:true},{t:'Photo update',d:'Mochi is supervising from the windowsill',done:true},{t:'Visit ends',d:'Waiting for check-out',done:false},{t:'Receipt and review',d:'After check-out',done:false}]},
   {id:'W-1021',sitterId:'s3',service:'boarding',date:today(-9),time:'02:00 PM',qty:2,pets:['p1'],extras:['photos','exwalk'],addressId:'a1',note:'Bring his favourite blanket.',status:'completed',total:147.62,breakdown:{base:116,extra:17,discount:0,platform:10.64,tax:12.08,credit:0},coupon:'',created:today(-14),points:147,reviewed:false,tip:12,
    timeline:[{t:'Booking confirmed',d:'Sofia accepted your request',done:true},{t:'Check-in',d:'Goodnight photo sent',done:true},{t:'Visit complete',d:'Biscuit had a wonderful stay',done:true},{t:'Tip added',d:'$12 to Sofia',done:true},{t:'Review',d:'Tell other families about your experience',done:false}]},
   {id:'W-1015',sitterId:'s4',service:'grooming',date:today(-24),time:'10:00 AM',qty:1,pets:['p1'],extras:['bath'],addressId:'a1',note:'',status:'completed',total:68.34,breakdown:{base:48,extra:18,discount:0,platform:0,tax:5.61,credit:0},coupon:'WELCOME10',created:today(-30),points:68,reviewed:true,tip:8,
    timeline:[{t:'Booking confirmed',d:'Liam accepted your request',done:true},{t:'Visit complete',d:'Fresh, fluffy, calm',done:true},{t:'Review left',d:'5 stars · Would book again',done:true}]},
   {id:'W-1009',sitterId:'s7',service:'boarding',date:today(-38),time:'04:00 PM',qty:1,pets:['p2'],extras:[],addressId:'a2',note:'',status:'cancelled',total:0,breakdown:{base:52,extra:0,discount:0,platform:4.16,tax:4.77,credit:60.93},coupon:'',created:today(-42),points:0,reviewed:false,tip:0,
    timeline:[{t:'Booking confirmed',d:'Isla accepted your request',done:true},{t:'Cancelled',d:'More than 24h before start · full refund of $60.93 to Willow credit',done:true}]}
  ],
  threads:[
   {id:'t1',sitterId:'s1',unread:2,messages:[
     {from:'them',text:'Hi Olivia! Just confirming tomorrow at 10 for Biscuit. Anything new I should know?',ts:'9:12 AM'},
     {from:'me',text:'Same as always — he has been a little obsessed with the puddle by the gate lately.',ts:'9:20 AM'},
     {from:'them',text:'Noted! We will take the long route and I will send a photo halfway through.',ts:'9:24 AM'},
     {from:'them',text:'Also, would you like me to bring his raincoat just in case?',ts:'9:25 AM'}]},
   {id:'t2',sitterId:'s5',unread:0,messages:[
     {from:'them',text:'Mochi is out from behind the sofa and has approved of me. Progress!',ts:'12:14 PM'},
     {from:'me',text:'This is enormous news. Thank you!',ts:'12:16 PM'}]},
   {id:'t3',sitterId:'support',unread:1,messages:[
     {from:'them',text:'Welcome to Willow Support. We are here 24/7 for anything about a booking, a pet, or a refund.',ts:'Yesterday'}]}
  ],
  notifications:[
   {id:'n1',type:'booking',title:'Visit coming up',body:'Biscuit\'s walk with Maya is in 3 days.',ts:'2h ago',read:false,go:'booking/W-1042'},
   {id:'n2',type:'chat',title:'New message from Maya',body:'Would you like me to bring his raincoat?',ts:'5h ago',read:false,go:'chat/t1'},
   {id:'n3',type:'booking',title:'Mochi\'s visit is in progress',body:'Emma checked in at 12:02 PM.',ts:'Today',read:false,go:'booking/W-1038'},
   {id:'n4',type:'review',title:'How was Biscuit\'s stay?',body:'Leave Sofia a review and make her day.',ts:'Yesterday',read:true,go:'review/W-1021'},
   {id:'n5',type:'credit',title:'Refund added to your credit',body:'$60.93 is ready for your next booking.',ts:'9 days ago',read:true,go:'wallet'}
  ],
  txns:[
   {id:'x1',label:'Dog Walking · Maya Chen',amount:-74.31,ts:today(-2),type:'charge'},
   {id:'x2',label:'Drop-in Visits · Emma Brooks',amount:-47.92,ts:today(-1),type:'charge'},
   {id:'x3',label:'Refund · W-1009',amount:60.93,ts:today(-38),type:'refund'},
   {id:'x4',label:'Grooming · Liam Okafor',amount:-68.34,ts:today(-24),type:'charge'}
  ],
  reviews:[],
  sitterStats:{},
  draft:null,
  filters:{service:'all',price:'all',sort:'recommended',q:'',distance:10,rating:0,date:'any',pets:'any',instant:false,certified:false},
  settings:{dark:false,push:true,email:true,sms:false,weekly:true},
  recent:['dog walking near me','cat sitter']
 };
}
let DB;
try{ DB=JSON.parse(localStorage.getItem(KEY))||seed(); }catch(e){ DB=seed(); }
function save(){ try{localStorage.setItem(KEY,JSON.stringify(DB));}catch(e){} }
function resetDB(){ DB=seed(); save(); }
if(!DB.draft) DB.draft=null;
if(!DB.sitterStats) DB.sitterStats={};
save();

/* ---------- 4. Helpers ---------- */
const $=s=>document.querySelector(s), $$=s=>Array.prototype.slice.call(document.querySelectorAll(s));
const money=n=>'$'+(Math.round(n*100)/100).toFixed(2);
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function fmtDate(d,full){ const dt=new Date(d+'T12:00:00'); return dt.toLocaleDateString('en-US',full?{weekday:'long',month:'long',day:'numeric'}:{weekday:'short',month:'short',day:'numeric'}); }
function svc(id){ return SERVICES.find(s=>s.id===id)||SERVICES[0]; }
function sitter(id){ const s=SITTERS.find(x=>x.id===id)||SITTERS[0], st=(DB.sitterStats||{})[s.id];
  return st?Object.assign({},s,{rating:st.rating,reviews:st.reviews}):s; }
function extra(id){ return EXTRAS.find(e=>e.id===id); }
function order(id){ return DB.orders.find(o=>o.id===id); }
function pet(id){ return DB.pets.find(p=>p.id===id); }
function addr(id){ return DB.addresses.find(a=>a.id===id)||DB.addresses[0]; }
function card(id){ return DB.cards.find(c=>c.id===id)||DB.cards[0]; }
function thread(id){ return DB.threads.find(t=>t.id===id); }
function uid(p){ return (p||'id')+'-'+Math.random().toString(36).slice(2,8); }
const ART_PICS=['images/dogs-field.jpg','images/dog-happy.jpg','images/cat-window.jpg','images/dog-portrait.jpg',
  'images/puppy-bowl.jpg','images/dog-stick.jpg','images/meal-bowl-green.jpg','images/forest-light.jpg'];
const SITTER_PICS={s1:'images/avatar-dana.jpg',s2:'images/avatar-marcus.jpg',s3:'images/avatar-priya.jpg',
  s4:'images/avatar-ines.jpg',s5:'images/avatar-kenji.jpg',s6:'images/avatar-rosa.jpg',
  s7:'images/avatar-theo.jpg',s8:'images/avatar-june.jpg'};
function art(g,icon,cls){
 const i=GRADS.indexOf(g), pic=ART_PICS[(i<0?0:i)%ART_PICS.length];
 return '<div class="art photo '+(cls||'')+'" style="background-image:url(\''+pic+'\')"></div>'; }
function avatar(o,size){
 const PEOPLE_PICS=['images/avatar-dana.jpg','images/avatar-marcus.jpg','images/avatar-priya.jpg','images/avatar-ines.jpg','images/avatar-theo.jpg','images/avatar-rosa.jpg'];
 const pic=SITTER_PICS[o.id]||PEOPLE_PICS[(String(o.id||o.name||'').length)%PEOPLE_PICS.length];
 return '<div class="av photo '+(size||'m')+'" style="background-image:url(\''+pic+'\')"></div>'; }
function stars(r){ return '<span class="rate">'+ic('star')+Number(r).toFixed(2)+'</span>'; }
function pill(txt,tone){ return '<span class="pill '+(tone||'g')+'">'+txt+'</span>'; }
function notify(type,title,body,go){ DB.notifications.unshift({id:uid('n'),type:type,title:title,body:body,ts:'Just now',read:false,go:go||''}); }
function txn(label,amount,type){ DB.txns.unshift({id:uid('x'),label:label,amount:amount,ts:today(0),type:type||'charge'}); }
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('show'),2600); }
function openModal(html){ $('#modal').innerHTML=html; $('#overlay').classList.add('show'); }
function closeModal(){ $('#overlay').classList.remove('show'); }
function openSheet(title,sub,html){ $('#sheet').innerHTML='<div class="handle"></div><h2>'+title+'</h2>'+(sub?'<div class="sh-sub">'+sub+'</div>':'')+html; $('#sheetOverlay').classList.add('show'); }
function closeSheet(){ $('#sheetOverlay').classList.remove('show'); }
function confetti(){
 const c=$('#confetti'); c.innerHTML='';
 const cols=['#7E9C84','#C6A24C','#C87C5C','#7C9AB0','#D98C8C'];
 for(let i=0;i<36;i++){ const s=document.createElement('i'); s.style.left=(Math.random()*100)+'%';
  s.style.background=cols[i%cols.length]; s.style.animationDelay=(Math.random()*.6)+'s';
  s.style.animationDuration=(1.5+Math.random())+'s'; c.appendChild(s); }
 setTimeout(()=>{c.innerHTML='';},3200);
}
function copyText(t){
 const done=()=>toast('Copied to clipboard');
 function fallback(){ const ta=document.createElement('textarea'); ta.value=t; document.body.appendChild(ta); ta.select();
  try{document.execCommand('copy');done();}catch(e){toast(t);} document.body.removeChild(ta); }
 if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(t).then(done).catch(fallback); } else fallback();
}
function statusPill(s){ const m={pending:['Awaiting confirmation','gold'],upcoming:['Confirmed','g'],in_progress:['In progress','blue'],completed:['Completed','gold'],cancelled:['Cancelled','rose']}; const v=m[s]||m.upcoming; return pill(v[0],v[1]); }
function paidFor(o){ const b=o.breakdown; return b.base+b.extra+b.platform+b.tax; }
/* Cancellation policy: 100% over 24h before, 50% within 24h, 0% once started. */
function refundFor(o){
 if(o.status!=='pending'&&o.status!=='upcoming'&&o.status!=='in_progress') return 0;
 const hrs=(new Date(o.date+'T12:00:00').getTime()-Date.now())/3600000, paid=paidFor(o);
 if(hrs>=24) return paid;
 if(hrs>0) return Math.round(paid*50)/100;
 return 0;
}
function unreadCount(){ return DB.notifications.filter(n=>!n.read).length; }
function msgUnread(){ return DB.threads.reduce((a,t)=>a+t.unread,0); }
function threadFor(sid){
 let t=DB.threads.find(x=>x.sitterId===sid);
 if(!t){ t={id:uid('t'),sitterId:sid,unread:0,messages:[{from:'them',text:'Hi! Thanks for reaching out. What can I help you with?',ts:'Just now'}]}; DB.threads.unshift(t); save(); }
 return t;
}
function pushMsg(t,from,text){ t.messages.push({from:from,text:text,ts:'Just now'}); if(from==='them') t.unread++; save(); }
function freeSlots(sid,date){
 const n=parseInt(sid.slice(1),10)||1, day=parseInt((date||today(1)).replace(/-/g,''),10);
 return SLOTS.filter((x,i)=>(day+i*3+n)%5!==0);
}
function dateStrip(selected,act,extra){
 let out='<div class="hscroll" style="margin:0 0 14px;padding:2px 0 8px">';
 for(let i=1;i<=8;i++){
  const d=today(i), dt=new Date(d+'T12:00:00'), active=selected===d;
  out+='<button class="chip '+(active?'on':'')+'" style="flex-direction:column;padding:9px 14px;min-width:62px" '+
    'data-act="'+(act||'pick-date')+'" '+(extra||'')+' data-v="'+d+'">'+
    '<small style="font-size:10px;opacity:.8">'+dt.toLocaleDateString('en-US',{weekday:'short'})+'</small>'+
    '<b style="font-size:15px">'+dt.getDate()+'</b></button>';
 }
 return out+'</div>';
}
function shortcut(icon,title,sub,go){ return '<button class="list-row" data-go="'+go+'"><div class="lr-ic">'+ic(icon)+'</div><div class="lr-t"><b>'+title+'</b><small>'+sub+'</small></div><span class="chev">'+ic('arrow','s')+'</span></button>'; }
function emptyState(title,body,btn,act,iconn){
 return '<div class="empty">'+art(GRADS[0],iconn||'paw')+'<h3>'+title+'</h3><p>'+body+'</p>'+
  (btn?'<button class="btn soft sm" data-act="'+act+'">'+btn+'</button>':'')+'</div>';
}

/* ---------- 5. Chrome ---------- */
const TABS=[{id:'home',label:'Home',icon:'home'},{id:'search',label:'Search',icon:'search'},
            {id:'bookings',label:'Bookings',icon:'calendar'},{id:'profile',label:'Profile',icon:'user'}];
const TAB_OF={home:'home',notifications:'home',map:'search',search:'search',sitter:'search',checkout:'search',favorites:'search',
  bookings:'bookings',booking:'bookings',review:'bookings',messages:'profile',chat:'profile',profile:'profile',
  pets:'profile',pet:'profile',addresses:'profile',wallet:'profile',membership:'profile',invite:'profile',
  settings:'profile',help:'profile',safety:'profile'};
const TITLES={
 search:['Find your person','Caregivers near Cedar Heights'], map:['Nearby caregivers','Cedar Heights · 5 mi radius'],
 sitter:['Caregiver profile',''], checkout:['Review & confirm','Almost there'],
 bookings:['Your bookings','Every visit, all in one place'], booking:['Booking details',''],
 review:['Leave a review','Your words mean a lot'], messages:['Messages','Stay close, even when you are away'],
 chat:['Conversation',''], favorites:['Saved caregivers','The ones you love'],
 pets:['Your pets','Three very good reasons for all of this'], pet:['Pet profile',''],
 addresses:['Saved addresses','Where care happens'], wallet:['Wallet & payments','Credit, cards and history'],
 membership:['Willow Plus','More care, less fuss'], invite:['Invite a friend','Good care is worth sharing'],
 notifications:['Notifications',''], settings:['Settings','Make Willow yours'],
 help:['Help centre','We are here 24/7'], safety:['Safety centre','Peace of mind, built in'], profile:['Your profile','']
};
function brandBar(){
 const u=unreadCount(), m=msgUnread();
 return '<div class="brandbar"><div class="brand"><img src="'+LOGO+'" alt="Willow"><b>Will<i>ow</i></b></div>'+
  '<div class="tb-acts">'+
   '<button class="circle" data-go="search" aria-label="Search">'+ic('search')+'</button>'+
   '<button class="circle" data-go="messages" aria-label="Messages">'+ic('chat')+(m?'<span class="dot"></span>':'')+'</button>'+
   '<button class="circle" data-go="notifications" aria-label="Notifications">'+ic('bell')+(u?'<span class="dot"></span>':'')+'</button>'+
  '</div></div>';
}
function renderChrome(r){
 if(r.page==='home'){ $('#topbar').innerHTML=brandBar(); }
 else{
  const t=TITLES[r.page]||['Willow',''];
  let right='';
  if(r.page==='search') right='<button class="circle" data-act="open-filters">'+ic('sliders')+'</button>';
  if(r.page==='booking') right='<button class="circle" data-act="order-menu" data-v="'+esc(r.arg)+'">'+ic('info')+'</button>';
  if(r.page==='notifications') right='<button class="circle" data-act="read-all">'+ic('check')+'</button>';
  if(r.page==='sitter') right='<button class="circle heart-top '+(DB.favorites.indexOf(r.arg)>=0?'on':'')+'" data-act="toggle-fav" data-v="'+esc(r.arg)+'">'+ic('heart')+'</button>';
  $('#topbar').innerHTML='<div class="tb"><button class="circle" data-act="back" aria-label="Back">'+ic('back')+'</button>'+
   '<div class="tb-t"><b>'+t[0]+'</b>'+(t[1]?'<small>'+t[1]+'</small>':'')+'</div>'+right+'</div>';
 }
 const active=TAB_OF[r.page]||'home';
 $('#tabInner').innerHTML=TABS.map(t=>'<button class="tab '+(active===t.id?'on':'')+'" data-go="'+t.id+'">'+
   ic(t.icon)+'<span>'+t.label+'</span>'+(t.id==='bookings'&&DB.orders.filter(o=>o.status==='upcoming'||o.status==='pending').length?'<span class="badge">'+DB.orders.filter(o=>o.status==='upcoming'||o.status==='pending').length+'</span>':'')+'</button>').join('');
 const d=$('#dock');
 if((r.page==='sitter'||r.page==='checkout')&&DB.draft&&!matchMedia('(min-width:1040px)').matches){
  const q=r.page==='checkout'?quote(DB.draft||{}):null;
  d.classList.add('show');
  d.innerHTML=r.page==='sitter'
   ? '<div class="dp"><b>'+money(sitter(r.arg).rate)+'</b><small>starting rate</small></div><button class="btn pri" data-act="to-checkout">Continue '+ic('arrow','s')+'</button>'
   : '<div class="dp"><b>'+money(q.total)+'</b><small>total due</small></div><button class="btn pri" data-act="place-order">Confirm booking '+ic('arrow','s')+'</button>';
 } else d.classList.remove('show');
}

/* ---------- 6. Views ---------- */
const VIEWS={};
VIEWS.home=function(){
 const u=DB.user, next=DB.orders.filter(o=>o.status==='upcoming'||o.status==='in_progress'||o.status==='pending').sort((a,b)=>a.date<b.date?-1:1)[0];
 let h='<div class="page"><div style="padding:2px 2px 0">'+
   '<img class="home-shot" src="images/dogs-field.jpg" alt="Two dogs running through a field in late afternoon light">'+
   '<div class="home-shot-cap">Biscuit and Noodle, 4:40pm last Tuesday. Maya sent this one without being asked.</div>'+
   '<div class="eyebrow">'+greeting()+', '+esc(u.first)+'</div>'+
   '<h1 class="hero-h">Your 6:40 train doesn’t care<br><em>that Biscuit needs a walk.</em></h1>'+
   '<div class="sub" style="margin-bottom:16px">'+ic('pin','xs')+' '+esc(u.location)+' &nbsp;·&nbsp; <span data-go="addresses" style="color:var(--sage-d);font-weight:700">Change</span></div>'+
   '<div class="searchbar"><input id="homeQ" placeholder="Try “dog walking” or “cat sitter”"><button class="go" data-act="home-search">'+ic('arrow')+'</button></div></div>';
 if(next){
  const s=sitter(next.sitterId);
  h+='<div class="sec"><div class="sec-h"><h2>Coming up</h2><span class="link" data-go="bookings">All bookings →</span></div>'+
   '<button class="card" style="width:100%;text-align:left;padding:14px;display:flex;gap:12px;align-items:center" data-go="booking/'+next.id+'">'+
    avatar(s,'m')+'<div style="flex:1;min-width:0"><b style="font-size:13.5px">'+esc(svc(next.service).name)+' with '+esc(s.name.split(' ')[0])+'</b>'+
    '<small class="muted" style="display:block;font-size:11.5px;margin-top:3px">'+fmtDate(next.date)+' · '+next.time+'</small></div>'+statusPill(next.status)+'</button></div>';
 }
 h+='<div class="sec"><div class="sec-h"><h2>What do you need?</h2><span class="link" data-go="search">See all →</span></div><div class="hscroll">'+
  SERVICES.map(s=>'<button class="cat" data-act="pick-service" data-v="'+s.id+'"><div class="cb" style="background:'+s.g+'">'+ic(s.icon)+'</div><b>'+s.name+'</b><small>from '+money(s.rate)+'</small></button>').join('')+'</div></div>';
 h+='<div class="sec"><div class="sec-h"><h2>Caregivers families love</h2><span class="link" data-go="search">More →</span></div><div class="hscroll">'+
  SITTERS.slice(0,5).map(s=>'<button class="star-card" data-go="sitter/'+s.id+'">'+
   art(s.g,'paw')+'<div class="body"><div class="row between"><b>'+esc(s.name)+'</b>'+stars(s.rating)+'</div>'+
   '<small>'+esc(s.role)+' · '+s.distance+' mi</small><div class="row between" style="margin-top:8px"><b style="font-size:13px">'+money(s.rate)+'</b><small>/hr</small></div></div></button>').join('')+'</div></div>';
 h+='<div class="sec"><div class="grid-home"><div>'+
   '<div class="note" style="display:flex;gap:11px"><div style="color:var(--sage-d)">'+ic('shield','l')+'</div><div><b>The Willow Care Guarantee</b><div style="margin-top:4px">Every booking includes vet coverage up to $25,000, 24/7 support and a vetted replacement if plans change.</div></div></div>'+
   '<div class="sec-h" style="margin-top:22px"><h2>Quick shortcuts</h2></div><div class="card" style="padding:2px 14px">'+
    shortcut('wallet','Wallet & payments','Credit, cards, coupons','wallet')+
    shortcut('paw','Your pets','Profiles, vaccines, notes','pets')+
    shortcut('calendar','Bookings','Upcoming and past visits','bookings')+
    shortcut('gift','Invite a friend','Give $15, get $15','invite')+
    shortcut('shield','Safety centre','Share a trip, get help','safety')+
    shortcut('help','Help centre','Answers, 24/7','help')+'</div></div><div>'+
    '<div class="quote">&ldquo;They don&rsquo;t count the hours.<br>They count the moments<br>you&rsquo;re gone.&rdquo;<small>A note from the Willow team</small></div>'+
    '<div class="card" style="padding:16px;margin-top:6px"><div class="eyebrow">Willow Plus</div>'+
     '<h3 style="font-size:16px;margin:6px 0">No service fees. Ever.</h3>'+
     '<div class="small muted" style="line-height:1.55;margin-bottom:12px">Members save an average of $28 a month, get priority booking and a free meet-and-greet.</div>'+
     (u.member?pill('Active member','g'):'<button class="btn soft sm" data-go="membership">Explore membership</button>')+'</div>'+
   '</div></div></div>';
 h+='<div class="sec center" style="padding:20px 0 8px"><img src="'+LOGO+'" style="width:54px;height:46px;object-fit:contain;mix-blend-mode:multiply;opacity:.85" alt=""><div class="tiny muted" style="margin-top:6px">Made with care, for the ones who wait by the door.</div></div>';
 return h+'</div>';
};
function greeting(){ const h=new Date().getHours(); return h<12?'Good morning':h<17?'Good afternoon':'Good evening'; }
function filtered(){
 const f=DB.filters; let list=SITTERS.slice();
 if(f.service!=='all') list=list.filter(s=>s.tags.indexOf(f.service)>=0);
 if(f.price==='under25') list=list.filter(s=>s.rate<25);
 if(f.price==='25to45') list=list.filter(s=>s.rate>=25&&s.rate<=45);
 if(f.price==='over45') list=list.filter(s=>s.rate>45);
 if(f.rating) list=list.filter(s=>s.rating>=f.rating);
 if(f.distance) list=list.filter(s=>s.distance<=f.distance);
 if(f.pets!=='any') list=list.filter(s=>s.pets.indexOf(f.pets)>=0);
 if(f.instant) list=list.filter(s=>s.instant);
 if(f.certified) list=list.filter(s=>s.badges.indexOf('checked')>=0&&s.badges.indexOf('insured')>=0);
 /* Lead time: instant-book caregivers are available sooner than request-based ones. */
 if(f.date==='3days'||f.date==='week'){
  const lim=f.date==='3days'?3:7;
  list=list.filter(s=>(s.instant?1:(parseInt(s.id.slice(1),10)%4)+2)<=lim);
 }
 if(f.q){ const q=f.q.toLowerCase(); list=list.filter(s=>(s.name+' '+s.role+' '+s.area+' '+s.tags.join(' ')+' '+s.bio).toLowerCase().indexOf(q)>=0); }
 if(f.sort==='price') list.sort((a,b)=>a.rate-b.rate);
 else if(f.sort==='rating') list.sort((a,b)=>b.rating-a.rating);
 else if(f.sort==='distance') list.sort((a,b)=>a.distance-b.distance);
 else list.sort((a,b)=>(b.rating*20+b.repeat/10)-(a.rating*20+a.repeat/10));
 return list;
}
function resCard(s){
 const f=DB.favorites.indexOf(s.id)>=0;
 return '<div class="rel"><button class="res" data-go="sitter/'+s.id+'">'+
  art(s.g,'paw','cover sm')+
  '<div class="info"><div><div class="row between"><b>'+esc(s.name)+'</b>'+stars(s.rating)+'</div>'+
   '<small>'+esc(s.role)+'</small><div style="margin-top:5px;display:flex;gap:5px;flex-wrap:wrap">'+
    (s.instant?pill('Instant book','g'):'')+(s.badges.indexOf('gold')>=0?pill('Favorite','gold'):'')+'</div></div>'+
   '<div class="row between"><small>'+ic('pin','xs')+' '+s.distance+' mi · '+s.reviews+' reviews</small></div></div>'+
  '<div class="price">'+money(s.rate)+'<small>starting</small></div></button>'+
  '<button class="heart '+(f?'on':'')+'" data-act="toggle-fav" data-v="'+s.id+'" aria-label="Save">'+ic('heart','s')+'</button></div>';
}
VIEWS.search=function(){
 const f=DB.filters, list=filtered();
 let h='<div class="page"><div class="searchbar" style="margin-bottom:14px">'+ic('search','s')+
  '<input id="searchQ" placeholder="Search by name, service or neighborhood" value="'+esc(f.q)+'">'+
  '<button class="go" data-act="open-filters">'+ic('sliders')+'</button></div>';
 h+='<div class="hscroll" style="margin-bottom:6px">'+
  '<button class="chip '+(f.service==='all'?'on':'')+'" data-act="set-filter" data-k="service" data-v="all">All care</button>'+
  SERVICES.map(s=>'<button class="chip '+(f.service===s.id?'on':'')+'" data-act="set-filter" data-k="service" data-v="'+s.id+'">'+s.name+'</button>').join('')+'</div>';
 h+='<div class="row between" style="margin:14px 0 12px"><div class="small muted"><b id="resCount" style="color:var(--ink)">'+list.length+'</b> caregivers available</div>'+
  '<select class="inp" style="width:auto;height:34px;font-size:12px;padding:0 28px 0 11px" data-k="sort">'+
   [['recommended','Recommended'],['rating','Top rated'],['price','Lowest price'],['distance','Nearest']].map(x=>'<option value="'+x[0]+'" '+(f.sort===x[0]?'selected':'')+'>'+x[1]+'</option>').join('')+'</select></div>';
 if(DB.recent.length&&!f.q) h+='<div class="row" style="flex-wrap:wrap;gap:6px;margin-bottom:14px"><small class="muted">Recent:</small>'+
  DB.recent.map(r=>'<button class="chip" style="padding:5px 10px;font-size:11px" data-act="recent" data-v="'+esc(r)+'">'+esc(r)+'</button>').join('')+'</div>';
 h+='<div id="resList">'+list.map(resCard).join('')+'</div>';
 if(!list.length) h+=emptyState('No one quite matches yet','Try widening your distance, clearing a filter, or searching a different service.','Clear filters','clear-filters');
 h+='<div class="center" style="margin-top:12px"><button class="chip" data-go="map">'+ic('map','s')+' See them on a map</button></div>';
 return h+'</div>';
};
const PINPOS=[[18,22],[38,46],[60,20],[72,58],[30,72],[54,38],[84,34],[12,52]];
VIEWS.map=function(){
 return '<div class="page"><div class="map"><div class="roads"></div><div class="park"></div><div class="water"></div>'+
  PINPOS.map((p,i)=>'<button class="pin '+(i===0?'gold':'')+'" style="left:'+p[0]+'%;top:'+p[1]+'%" data-act="pin" data-v="'+SITTERS[i].id+'"><span>'+money(SITTERS[i].rate).replace('.00','')+'</span></button>').join('')+'</div>'+
  '<div class="note" style="margin-top:12px;display:flex;gap:10px">'+ic('info','s')+'<span>Showing '+SITTERS.length+' caregivers within 5 miles of Cedar Heights. Tap a pin to peek at their profile.</span></div>'+
  '<div class="sec-h" style="margin-top:22px"><h2>Nearest to you</h2></div><div id="resList">'+
  SITTERS.slice().sort((a,b)=>a.distance-b.distance).map(resCard).join('')+'</div></div>';
};
VIEWS.sitter=function(id){
 if(DB.draft&&DB.draft.sitterId!==id) DB.draft=null;
 if(!DB.draft){ const s0=sitter(id);
  DB.draft={sitterId:id,service:s0.tags[0],date:today(2),time:'',qty:1,pets:DB.pets.length?[DB.pets[0].id]:[],
   extras:[],addressId:(DB.addresses.find(a=>a.def)||DB.addresses[0]).id,note:'',coupon:'',usePoints:false,agree:true,
   cardId:(DB.cards.find(c=>c.def)||DB.cards[0]).id}; save(); }
 const s=sitter(id), dd=DB.draft, fav=DB.favorites.indexOf(id)>=0;
 const reviews=s.reviewsList.concat(DB.reviews.filter(r=>r.sitterId===id));
 let h='<div class="page wide"><div class="split"><div>';
 h+='<div class="rel">'+art(s.g,'paw','cover lg')+
   '<button class="heart '+(fav?'on':'')+'" style="top:14px;right:14px;width:38px;height:38px" data-act="toggle-fav" data-v="'+id+'">'+ic('heart')+'</button>'+
   (s.badges.indexOf('gold')>=0?'<span style="position:absolute;left:14px;top:14px" class="pill gold">'+ic('star','xs')+' Willow Favorite</span>':'')+'</div>';
 h+='<div style="padding:16px 2px 0"><div class="row between"><div><h1 style="font-size:25px">'+esc(s.name)+'</h1><div class="small muted" style="margin-top:3px">'+esc(s.role)+' · '+esc(s.area)+'</div></div>'+avatar(s,'l')+'</div></div>';
 h+='<div class="row" style="gap:16px;margin:14px 0;flex-wrap:wrap">'+stars(s.rating)+'<span class="small muted">'+s.reviews+' reviews</span>'+
   '<span class="small muted">'+ic('bolt','xs')+' replies '+esc(s.resp)+'</span>'+(s.instant?pill('Instant book','g'):'')+'</div>';
 h+='<div class="grid3" style="margin-bottom:18px"><div class="stat"><b>'+s.jobs+'</b><small>visits completed</small></div>'+
  '<div class="stat"><b>'+s.repeat+'%</b><small>families rebook</small></div>'+
  '<div class="stat"><b>'+s.distance+' mi</b><small>away from you</small></div></div>';
 h+='<div class="card pad" style="margin-bottom:16px"><b>About '+esc(s.name.split(' ')[0])+'</b><p class="small muted" style="line-height:1.65;margin:8px 0 0">'+esc(s.bio)+'</p>'+
  '<div class="divider"></div><p class="small muted" style="line-height:1.65;margin:0">'+esc(s.story)+'</p></div>';
 h+='<div class="sec-h"><h2>Trust & credentials</h2></div><div class="card pad" style="margin-bottom:16px">'+
  s.badges.map(b=>{const bd=BADGES.find(x=>x.id===b);return '<div class="list-row"><div class="lr-ic">'+ic(bd.icon)+'</div><div class="lr-t"><b>'+bd.label+'</b><small>Verified by Willow</small></div>'+ic('check','s')+'</div>';}).join('')+
  '<div class="note" style="margin-top:12px">'+ic('shield','s')+' Every visit is covered by the Willow Care Guarantee — up to $25,000 in vet care.</div></div>';
 h+='<div class="sec-h"><h2>Services & rates</h2></div><div class="card" style="padding:2px 14px;margin-bottom:16px">'+
  s.tags.map(t=>{const v=svc(t);return '<button class="list-row" data-act="pick-svc" data-v="'+t+'"><div class="lr-ic">'+ic(v.icon)+'</div><div class="lr-t"><b>'+v.name+'</b><small>'+v.short+'</small></div><span class="b small">'+money(s.rate+(v.rate-28))+'</span></button>';}).join('')+'</div>';
 h+='<div class="sec-h"><h2>A little of their world</h2></div><div class="hscroll" style="margin-bottom:16px">'+
  [0,1,2,3].map(i=>art(GRADS[(i+parseInt(id.slice(1),10))%GRADS.length],['paw','leaf','spark','home'][i],'cover sm')).join('')+'</div>';
 h+='<div class="sec-h"><h2>What families say</h2><span class="link">'+reviews.length+' reviews</span></div>'+
  reviews.map(r=>'<div class="card pad" style="margin-bottom:10px"><div class="row between"><b class="small">'+esc(r.n)+'</b><span class="rate">'+ic('star')+r.r+'.0</span></div>'+
   '<div class="tiny muted" style="margin:2px 0 8px">'+esc(r.d)+'</div><p class="small" style="line-height:1.6;margin:0">'+esc(r.t)+'</p>'+
   (r.tags?'<div class="row" style="gap:5px;flex-wrap:wrap;margin-top:9px">'+r.tags.map(t=>pill(t,'g')).join('')+'</div>':'')+'</div>').join('');
 h+='<div class="sec-h" style="margin-top:20px"><h2>Good to know</h2></div><div class="card pad small muted" style="line-height:1.7">'+
  '<div class="row" style="margin-bottom:7px">'+ic('clock','s')+' <b style="color:var(--ink)">Cancellation:</b>&nbsp; free up to 24h before, 50% after.</div>'+
  '<div class="row" style="margin-bottom:7px">'+ic('chat','s')+' <b style="color:var(--ink)">Meet and greet:</b>&nbsp; free, arranged in Messages.</div>'+
  '<div class="row">'+ic('paw','s')+' <b style="color:var(--ink)">Pets:</b>&nbsp; comfortable with '+s.pets.join(', ')+'.</div></div></div>';
 h+='<div class="side"><div class="card pad">'+
  '<div class="row between"><div><b style="font-size:17px">'+money(s.rate)+'</b><small class="muted"> / starting</small></div>'+stars(s.rating)+'</div><div class="divider"></div>'+
  '<div class="field"><label>Service</label><select class="inp" data-k="draft.service">'+s.tags.map(t=>'<option value="'+t+'" '+(dd.service===t?'selected':'')+'>'+svc(t).name+'</option>').join('')+'</select></div>'+
  '<div class="field"><label>Date</label>'+dateStrip(dd.date)+'</div>'+
  '<div class="field"><label>Available times</label><div class="row" style="flex-wrap:wrap;gap:6px">'+
   freeSlots(id,dd.date).map(t=>'<button class="chip '+(dd.time===t?'on':'')+'" style="padding:7px 10px;font-size:11px" data-act="pick-time" data-v="'+t+'">'+t+'</button>').join('')+'</div>'+
   (dd.time?'':'<small class="tiny" style="color:var(--terra);display:block;margin-top:6px">Pick a time to continue</small>')+'</div>'+
  '<div class="field"><label>'+(dd.service==='boarding'||dd.service==='sitting'?'Nights':'Hours / visits')+'</label><div class="qty">'+
   '<button data-act="qty" data-v="-1">−</button><b>'+dd.qty+'</b><button data-act="qty" data-v="1">+</button></div></div>'+
  '<div class="field"><label>Which pets?</label><div class="row" style="flex-wrap:wrap;gap:6px">'+
   DB.pets.map(p=>'<button class="chip '+(dd.pets.indexOf(p.id)>=0?'on':'')+'" style="padding:7px 11px" data-act="pick-pet" data-v="'+p.id+'">'+esc(p.name)+'</button>').join('')+'</div></div>'+
  '<div class="field"><label>Add a little extra</label>'+
   EXTRAS.map(e=>'<button class="check '+(dd.extras.indexOf(e.id)>=0?'on':'')+'" style="margin-bottom:9px;width:100%;text-align:left" data-act="pick-extra" data-v="'+e.id+'"><span class="box">'+ic('check')+'</span><span style="flex:1">'+e.name+'</span><b>+'+money(e.price)+'</b></button>').join('')+'</div>'+
  '<div class="field"><label>Notes for '+esc(s.name.split(' ')[0])+'</label><textarea class="inp" data-k="draft.note" placeholder="Anything we should know?">'+esc(dd.note)+'</textarea></div>'+
  '<div class="note" style="margin-bottom:12px">'+ic('info','s')+' You will not be charged until the visit begins.</div>'+
  '<button class="btn pri block" data-act="to-checkout">Continue '+ic('arrow','s')+'</button>'+
  '<button class="btn ghost block sm" style="margin-top:9px" data-act="message-sitter" data-v="'+id+'">'+ic('chat','s')+' Ask a question first</button>'+
  '</div></div></div></div>';
 return h;
};
function quote(d){
 if(!d||!d.service) return {base:0,extra:0,discount:0,platform:0,tax:0,credit:0,total:0,points:0,sub:0,couponLabel:''};
 const s=sitter(d.sitterId), rate=s.rate+(svc(d.service).rate-28);
 const base=rate*(d.qty||1);
 const extraSum=(d.extras||[]).reduce((a,id)=>a+(extra(id)?extra(id).price:0),0);
 const sub=base+extraSum;
 let discount=0, c=d.coupon?COUPON_CODES[d.coupon.toUpperCase()]:null;
 if(!c) c=(DB.coupons.find(x=>x.code===String(d.coupon||'').toUpperCase()&&!x.used)||null);
 if(c) discount=c.type==='pct'?sub*c.value/100:c.value;
 discount=Math.min(discount,sub);
 const platform=DB.user.member?0:(sub-discount)*.08;
 const tax=(sub-discount+platform)*.085;
 // Points and credit are only applied when the shopper opts in at checkout.
 const pointOff=d.usePoints?Math.min(5,Math.floor(DB.user.points/100)):0;
 const creditOff=d.usePoints?Math.min(DB.user.credit,Math.max(0,sub-discount+platform+tax-pointOff)):0;
 const credit=pointOff+creditOff;
 const total=Math.max(0,sub-discount+platform+tax-credit);
 return {base:base,extra:extraSum,discount:discount,platform:platform,tax:tax,credit:credit,
         pointOff:pointOff,creditOff:creditOff,total:total,sub:sub,
         points:Math.floor(total),couponLabel:c?c.label:''};
}
function priceLines(q){
 return '<div class="line-item"><span>'+esc(svc(DB.draft.service).name)+' × '+DB.draft.qty+'</span><span>'+money(q.base)+'</span></div>'+
  (q.extra?'<div class="line-item"><span>Extra care</span><span>'+money(q.extra)+'</span></div>':'')+
  (q.discount?'<div class="line-item"><span>Promo '+esc(String(DB.draft.coupon).toUpperCase())+'</span><span class="disc">−'+money(q.discount)+'</span></div>':'')+
  '<div class="line-item"><span>Service fee '+(DB.user.member?'<span class="pill g">Plus: waived</span>':'')+'</span><span>'+money(DB.user.member?0:q.platform)+'</span></div>'+
  '<div class="line-item"><span>Estimated tax</span><span>'+money(q.tax)+'</span></div>'+
  (q.credit?'<div class="line-item"><span>Willow credit / points</span><span class="disc">−'+money(q.credit)+'</span></div>':'')+
  '<div class="line-item total"><span>Total</span><span>'+money(q.total)+'</span></div>';
}
VIEWS.checkout=function(){
 const d=DB.draft;
 if(!d||!d.service) return '<div class="page">'+emptyState('Nothing to check out yet','Choose a caregiver and a service first.','Browse caregivers','go-search','calendar')+'</div>';
 if(!d.time){ d.time=freeSlots(d.sitterId,d.date)[0]||SLOTS[0]; save(); }
 const s=sitter(d.sitterId), q=quote(d), a=addr(d.addressId);
 let h='<div class="page wide"><div class="split"><div>';
 h+='<div class="card pad" style="margin-bottom:14px"><div class="row">'+avatar(s,'m')+'<div style="flex:1"><b>'+esc(s.name)+'</b><small class="muted" style="display:block">'+esc(s.role)+' · '+stars(s.rating)+'</small></div>'+
   '<button class="btn ghost sm" data-go="sitter/'+s.id+'">Edit</button></div><div class="divider"></div>'+
   '<div class="row" style="gap:8px;flex-wrap:wrap">'+pill(esc(svc(d.service).name),'g')+pill(fmtDate(d.date),'blue')+pill(esc(d.time||'Time not set'),'gold')+pill(d.qty+' '+(d.service==='boarding'||d.service==='sitting'?'nights':'visits'),'g')+'</div>'+
   '<div class="small muted" style="margin-top:10px;line-height:1.6">'+ic('paw','xs')+' '+d.pets.map(p=>esc(pet(p)?pet(p).name:'Pet')).join(', ')+' &nbsp;·&nbsp; '+ic('pin','xs')+' '+esc(a.label)+' — '+esc(a.line)+'</div></div>';
 h+='<div class="sec-h"><h2>Extras</h2></div><div class="card" style="padding:2px 14px;margin-bottom:14px">'+
   (d.extras.length?d.extras.map(e=>{const x=extra(e);return '<div class="list-row"><div class="lr-ic">'+ic(x.icon)+'</div><div class="lr-t"><b>'+x.name+'</b></div><span class="b small">+'+money(x.price)+'</span></div>';}).join(''):'<div class="list-row"><div class="lr-t"><b>No extras added</b><small>You can add them by editing the booking</small></div></div>')+'</div>';
 h+='<div class="sec-h"><h2>Where & notes</h2></div><div class="card pad" style="margin-bottom:14px">'+
   '<div class="field"><label>Service address</label><select class="inp" data-k="draft.addressId">'+DB.addresses.map(x=>'<option value="'+x.id+'" '+(d.addressId===x.id?'selected':'')+'>'+esc(x.label)+' — '+esc(x.line)+'</option>').join('')+'</select></div>'+
   '<div class="small muted" style="line-height:1.55;margin-bottom:10px">'+ic('lock','xs')+' '+esc(a.note||'No access notes')+'</div>'+
   '<div class="field" style="margin:0"><label>Note for your caregiver</label><textarea class="inp" data-k="draft.note" placeholder="Anything else?">'+esc(d.note)+'</textarea></div></div>';
 h+='<div class="sec-h"><h2>Payment</h2></div><div class="card pad" style="margin-bottom:14px">'+
   '<div class="field"><label>Pay with</label><select class="inp" data-k="draft.cardId">'+DB.cards.map(x=>'<option value="'+x.id+'" '+(d.cardId===x.id?'selected':'')+'>'+esc(x.label)+' ···· '+x.last4+'</option>').join('')+'<option value="cash" '+(d.cardId==='cash'?'selected':'')+'>Pay at visit</option></select></div>'+
   '<div class="small muted">'+ic('info','xs')+' Authorised now, charged only after the visit begins.</div></div>';
 h+='<div class="sec-h"><h2>Promo & credit</h2></div><div class="card pad" style="margin-bottom:14px">'+
   '<div class="field"><label>Promo code</label><div class="row"><input class="inp" id="promoInput" placeholder="e.g. WILLOW10" value="'+esc(d.coupon)+'" style="flex:1"><button class="btn soft" data-act="apply-promo">Apply</button></div>'+
   (q.discount?'<div class="tiny" style="color:var(--sage-d);margin-top:7px">'+ic('check','xs')+' '+esc(q.couponLabel)+' applied</div>':'')+'</div>'+
   '<button class="check '+(d.usePoints?'on':'')+'" style="width:100%;text-align:left" data-act="use-points"><span class="box">'+ic('check')+'</span><span style="flex:1">Use points & credit <small class="muted" style="display:block">'+DB.user.points+' pts · '+money(DB.user.credit)+' credit</small></span></button></div>';
 h+='<div class="check '+(d.agree?'on':'')+'" style="margin:16px 0" data-act="toggle-agree"><span class="box">'+ic('check')+'</span><span>I agree to the Willow service terms and the caregiver cancellation policy.</span></div>';
 h+='</div><div class="side"><div class="card pad">'+
   '<b style="font-size:16px">Price details</b><div style="margin-top:10px">'+priceLines(q)+'</div>'+
   '<div class="note" style="margin:12px 0;font-size:11px">You earn <b>'+q.points+' points</b> on this booking.</div>'+
   '<button class="btn pri block" data-act="place-order">Confirm & book '+ic('arrow','s')+'</button>'+
   '<div class="tiny muted center" style="margin-top:9px;line-height:1.5">Free cancellation up to 24 hours before the visit.</div></div>'+
   '<div class="card pad" style="margin-top:12px"><div class="row" style="color:var(--sage-d)">'+ic('shield','s')+'<b class="small">Willow Care Guarantee included</b></div>'+
   '<div class="tiny muted" style="line-height:1.55;margin-top:6px">Vet coverage up to $25,000, 24/7 support, and a vetted replacement if plans change.</div></div>'+
   '</div></div></div>';
 return h;
};
VIEWS.bookings=function(){
 const tab=DB._bkTab||'upcoming';
 const list=DB.orders.filter(o=>tab==='upcoming'?(o.status==='upcoming'||o.status==='in_progress'||o.status==='pending'):(o.status==='completed'||o.status==='cancelled'))
                    .sort((a,b)=>tab==='upcoming'?(a.date<b.date?-1:1):(a.date>b.date?-1:1));
 let h='<div class="page"><div class="seg" style="margin-bottom:18px">'+
  '<button class="'+(tab==='upcoming'?'on':'')+'" data-act="bk-tab" data-v="upcoming">Upcoming · '+DB.orders.filter(o=>o.status==='upcoming'||o.status==='in_progress'||o.status==='pending').length+'</button>'+
  '<button class="'+(tab==='past'?'on':'')+'" data-act="bk-tab" data-v="past">Past · '+DB.orders.filter(o=>o.status==='completed'||o.status==='cancelled').length+'</button></div>';
 if(!list.length) return h+emptyState(tab==='upcoming'?'Your calendar is clear':'Nothing here yet','When you book a visit, every detail will live right here.','Find a caregiver','go-search','calendar')+'</div>';
 h+=list.map(o=>{ const s=sitter(o.sitterId);
  return '<button class="card" style="width:100%;text-align:left;padding:14px;margin-bottom:12px;display:block" data-go="booking/'+o.id+'">'+
   '<div class="row between" style="margin-bottom:10px"><div class="row">'+avatar(s,'s')+'<div><b class="small">'+esc(s.name)+'</b><small class="muted" style="display:block;font-size:10.5px">'+esc(s.role)+'</small></div></div>'+statusPill(o.status)+'</div>'+
   '<div class="row between"><div><b style="font-size:14px">'+esc(svc(o.service).name)+'</b><div class="small muted" style="margin-top:3px">'+ic('calendar','xs')+' '+fmtDate(o.date)+' · '+esc(o.time)+' &nbsp; '+ic('paw','xs')+' '+o.pets.map(p=>esc(pet(p)?pet(p).name:'Pet')).join(', ')+'</div></div>'+
   '<div style="text-align:right"><b>'+money(o.total||o.breakdown.base+o.breakdown.extra+o.breakdown.platform+o.breakdown.tax)+'</b><div class="tiny muted">'+esc(o.id)+'</div></div></div>'+
   (o.status==='completed'&&!o.reviewed?'<div class="tiny" style="color:var(--gold);margin-top:10px">'+ic('star','xs')+' Share how it went →</div>':'')+'</button>';
 }).join('');
 h+='<button class="card" style="width:100%;text-align:left;padding:14px;margin-top:6px;display:flex;gap:12px;align-items:center" data-go="help"><div class="lr-ic">'+ic('help')+'</div><div class="lr-t"><b>Need help with a booking?</b><small>Refunds, changes and the Care Guarantee</small></div>'+ic('arrow','s')+'</button>';
 return h+'</div>';
};
VIEWS.booking=function(id){
 const o=order(id); if(!o) return '<div class="page">'+emptyState('Booking not found','It may have been removed during a demo reset.','Your bookings','go-bookings','info')+'</div>';
 const s=sitter(o.sitterId), a=addr(o.addressId), b=o.breakdown;
 const total=o.total||(b.base+b.extra+b.platform+b.tax);
 let h='<div class="page"><div class="card" style="overflow:hidden;margin-bottom:14px">'+
  '<div style="padding:16px;background:'+s.g+'"><div class="row between" style="color:#fff"><div>'+statusPill(o.status)+'<h2 style="margin-top:10px;font-size:20px;color:#fff">'+esc(svc(o.service).name)+'</h2><div style="font-size:12px;opacity:.9;margin-top:3px">with '+esc(s.name)+'</div></div>'+avatar(s,'l')+'</div></div>'+
  '<div class="pad"><div class="grid3"><div class="stat"><b>'+fmtDate(o.date).split(',')[1]+'</b><small>'+fmtDate(o.date).split(',')[0]+'</small></div>'+
   '<div class="stat"><b>'+esc(o.time.split(' ')[0])+'</b><small>'+esc(o.time.split(' ')[1]||'')+'</small></div>'+
   '<div class="stat"><b>'+o.qty+'</b><small>'+(o.service==='boarding'||o.service==='sitting'?'nights':'visits')+'</small></div></div>'+
  '<div class="divider"></div><div class="small"><b>'+esc(a.label)+'</b> · '+esc(a.line)+', '+esc(a.city)+'</div>'+
  '<div class="tiny muted" style="margin-top:5px">'+ic('lock','xs')+' '+esc(a.note)+'</div>'+
  (o.note?'<div class="note" style="margin-top:12px;font-size:11.5px">'+ic('chat','xs')+' '+esc(o.note)+'</div>':'')+'</div></div>';
 h+='<div class="sec-h"><h2>Visit timeline</h2></div><div class="card pad" style="margin-bottom:14px"><div class="tl">'+
  o.timeline.map(t=>'<div class="step '+(t.done?'done':'')+'"><b>'+esc(t.t)+'</b><small>'+esc(t.d)+'</small></div>').join('')+'</div></div>';
 h+='<div class="sec-h"><h2>Manage this visit</h2></div><div class="card" style="padding:2px 14px;margin-bottom:14px">'+
   shortcut('chat','Message '+esc(s.name.split(' ')[0]),'Usually replies '+esc(s.resp),'chat/'+threadFor(o.sitterId).id)+
   '<button class="list-row" data-act="share-trip" data-v="'+o.id+'"><div class="lr-ic">'+ic('map')+'</div><div class="lr-t"><b>Share this visit</b><small>Send details to a family member</small></div><span class="chev">'+ic('arrow','s')+'</span></button>'+
   ((o.status==='upcoming'||o.status==='pending')?
     '<button class="list-row" data-act="reschedule" data-v="'+o.id+'"><div class="lr-ic">'+ic('calendar')+'</div><div class="lr-t"><b>Reschedule</b><small>Free up to 24h before</small></div><span class="chev">'+ic('arrow','s')+'</span></button>'+
     '<button class="list-row" data-act="cancel-order" data-v="'+o.id+'"><div class="lr-ic">'+ic('close')+'</div><div class="lr-t"><b>Cancel booking</b><small>Refund follows the cancellation policy</small></div><span class="chev">'+ic('arrow','s')+'</span></button>':'')+
   (o.status==='pending'?
     '<button class="list-row" data-act="accept-request" data-v="'+o.id+'"><div class="lr-ic">'+ic('check')+'</div><div class="lr-t"><b>Caregiver accepts request</b><small>Demo: move to confirmed</small></div><span class="chev">'+ic('arrow','s')+'</span></button>':'')+
   (o.status==='upcoming'?
     '<button class="list-row" data-act="check-in" data-v="'+o.id+'"><div class="lr-ic">'+ic('bolt')+'</div><div class="lr-t"><b>Mark visit as started</b><small>Demo: simulate caregiver check-in</small></div><span class="chev">'+ic('arrow','s')+'</span></button>':'')+
   (o.status==='in_progress'?
     '<button class="list-row" data-act="photo-update" data-v="'+o.id+'"><div class="lr-ic">'+ic('camera')+'</div><div class="lr-t"><b>Receive a photo update</b><small>Demo: caregiver sends an update</small></div><span class="chev">'+ic('arrow','s')+'</span></button>'+
     '<button class="list-row" data-act="finish-visit" data-v="'+o.id+'"><div class="lr-ic">'+ic('check')+'</div><div class="lr-t"><b>Finish the visit</b><small>Move to completed</small></div><span class="chev">'+ic('arrow','s')+'</span></button>':'')+
   (o.status==='completed'?
     (o.reviewed?'':'<button class="list-row" data-go="review/'+o.id+'"><div class="lr-ic">'+ic('star')+'</div><div class="lr-t"><b>Write a review</b><small>Add a tip for '+esc(s.name.split(' ')[0])+'</small></div><span class="chev">'+ic('arrow','s')+'</span></button>')+
     '<button class="list-row" data-act="receipt" data-v="'+o.id+'"><div class="lr-ic">'+ic('receipt')+'</div><div class="lr-t"><b>Download receipt</b><small>Itemised, for your records</small></div><span class="chev">'+ic('arrow','s')+'</span></button>'+
     '<button class="list-row" data-act="book-again" data-v="'+o.id+'"><div class="lr-ic">'+ic('repeat')+'</div><div class="lr-t"><b>Book again</b><small>Same caregiver, same care</small></div><span class="chev">'+ic('arrow','s')+'</span></button>':'')+
   (o.status==='cancelled'?'<button class="list-row" data-act="book-again" data-v="'+o.id+'"><div class="lr-ic">'+ic('repeat')+'</div><div class="lr-t"><b>Book again</b><small>Full refund was added to your credit</small></div><span class="chev">'+ic('arrow','s')+'</span></button>':'')+
  '</div>';
 h+='<div class="sec-h"><h2>Payment</h2></div><div class="card pad" style="margin-bottom:14px">'+
  '<div class="line-item"><span>'+esc(svc(o.service).name)+' × '+o.qty+'</span><span>'+money(b.base)+'</span></div>'+
  (b.extra?'<div class="line-item"><span>Extra care</span><span>'+money(b.extra)+'</span></div>':'')+
  (b.discount?'<div class="line-item"><span>Promo</span><span class="disc">−'+money(b.discount)+'</span></div>':'')+
  '<div class="line-item"><span>Service fee</span><span>'+money(b.platform)+'</span></div>'+
  '<div class="line-item"><span>Tax</span><span>'+money(b.tax)+'</span></div>'+
  (b.credit?'<div class="line-item"><span>Willow credit used</span><span class="disc">−'+money(b.credit)+'</span></div>':'')+
  (o.tip?'<div class="line-item"><span>Tip to caregiver</span><span>'+money(o.tip)+'</span></div>':'')+
  '<div class="line-item total"><span>'+(o.status==='cancelled'?'Refunded':'Total')+'</span><span>'+(o.status==='cancelled'?money(b.base+b.extra+b.platform+b.tax):money(total+(o.tip||0)))+'</span></div>'+
  '<div class="tiny muted" style="margin-top:9px">Booking '+esc(o.id)+' · '+esc(o.coupon||'No promo code')+'</div></div>';
 h+='<div class="note">'+ic('shield','s')+' Covered by the Willow Care Guarantee. Need help? <b data-go="help" style="color:var(--sage-d)">Visit the Help Centre</b>.</div></div>';
 return h;
};
VIEWS.review=function(id){
 const o=order(id); if(!o) return '<div class="page">'+emptyState('Not found','','Back','go-bookings')+'</div>';
 const s=sitter(o.sitterId), d=DB._review||{stars:5,tags:[],text:'',tip:15};
 DB._review=d;
 let h='<div class="page"><div class="center" style="padding:14px 0 20px">'+avatar(s,'l')+
  '<h2 style="font-size:20px;margin-top:12px">How was '+esc(s.name.split(' ')[0])+'?</h2>'+
  '<div class="small muted" style="margin-top:5px">'+esc(svc(o.service).name)+' · '+fmtDate(o.date)+'</div></div>'+
  '<div class="card pad center" style="margin-bottom:14px"><div class="eyebrow">Your rating</div><div class="row" style="justify-content:center;gap:8px;margin:14px 0">'+
   [1,2,3,4,5].map(n=>'<button data-act="set-stars" data-v="'+n+'" style="color:'+(n<=d.stars?'var(--gold)':'var(--line)')+'">'+ic('star','xl')+'</button>').join('')+'</div>'+
   '<div class="small b">'+['','Not great','Could be better','Good','Really good','Absolutely wonderful'][d.stars]+'</div></div>';
 h+='<div class="card pad" style="margin-bottom:14px"><b class="small">What stood out?</b><div class="row" style="flex-wrap:wrap;gap:6px;margin-top:11px">'+
   REVIEW_TAGS.map(t=>'<button class="chip '+(d.tags.indexOf(t)>=0?'on':'')+'" style="font-size:11px;padding:7px 10px" data-act="review-tag" data-v="'+esc(t)+'">'+t+'</button>').join('')+'</div>'+
   '<div class="field" style="margin-top:15px;margin-bottom:0"><label>Your words</label><textarea class="inp" data-k="review.text" placeholder="Tell other families what made this visit special…">'+esc(d.text)+'</textarea></div></div>';
 h+='<div class="card pad" style="margin-bottom:18px"><b class="small">Add a tip for '+esc(s.name.split(' ')[0])+'</b><div class="tiny muted" style="margin:5px 0 12px">100% goes to your caregiver.</div>'+
   '<div class="row" style="gap:7px;flex-wrap:wrap">'+[0,10,15,20,25].map(n=>'<button class="chip '+(d.tip===n?'on':'')+'" data-act="set-tip" data-v="'+n+'">'+(n?n+'%':'No tip')+'</button>').join('')+'</div>'+
   '<div class="small muted" style="margin-top:10px">'+money((o.total||0)*d.tip/100)+' on this booking</div></div>';
 h+='<button class="btn pri block" data-act="submit-review" data-v="'+o.id+'">Publish review '+ic('arrow','s')+'</button>'+
   '<button class="btn ghost block sm" style="margin-top:9px" data-act="skip-review" data-v="'+o.id+'">Maybe later</button></div>';
 return h;
};
VIEWS.messages=function(){
 let h='<div class="page"><div class="searchbar" style="margin-bottom:16px">'+ic('search','s')+'<input placeholder="Search conversations" id="msgQ"><button class="go" data-act="new-chat">'+ic('plus')+'</button></div>';
 h+='<div class="card" style="padding:2px 14px">'+DB.threads.map(t=>{
  const s=t.sitterId==='support'?{name:'Willow Support',role:'Here for you, 24/7',g:GRADS[0],initials:'W'}:sitter(t.sitterId);
  const last=t.messages[t.messages.length-1];
  return '<button class="list-row" data-go="chat/'+t.id+'">'+avatar(s,'m')+'<div class="lr-t"><b>'+esc(s.name)+
   (t.unread?' <span class="pill rose">'+t.unread+' new</span>':'')+'</b><small>'+esc(last.text.slice(0,52))+(last.text.length>52?'…':'')+'</small></div>'+
   '<div style="text-align:right"><small class="muted tiny">'+esc(last.ts)+'</small><div>'+ic('chev','s')+'</div></div></button>';
 }).join('')+'</div>';
 h+='<div class="note" style="margin-top:16px;display:flex;gap:10px">'+ic('info','s')+'<span>Messages stay in this demo so you can see the whole flow. Nothing is sent anywhere.</span></div></div>';
 return h;
};
VIEWS.chat=function(id){
 const t=thread(id); if(!t) return '<div class="page">'+emptyState('Conversation not found','','Messages','go-messages')+'</div>';
 t.unread=0; save();
 const s=t.sitterId==='support'?{name:'Willow Support',role:'24/7 support',g:GRADS[0],initials:'W',resp:'a moment'}:sitter(t.sitterId);
 let h='<div class="page"><div class="card pad" style="margin-bottom:14px;display:flex;gap:12px;align-items:center">'+avatar(s,'m')+
  '<div style="flex:1"><b>'+esc(s.name)+'</b><small class="muted" style="display:block">'+esc(s.role)+' · replies in '+esc(s.resp)+'</small></div>'+
  (t.sitterId!=='support'?'<button class="btn ghost sm" data-go="sitter/'+t.sitterId+'">Profile</button>':'')+'</div>';
 h+='<div id="chatBody">'+t.messages.map(m=>'<div class="bubble '+(m.from==='me'?'me':'them')+'">'+esc(m.text)+'<small>'+esc(m.ts)+'</small></div>').join('')+'</div>';
 h+='<div class="hscroll" style="margin:14px 0 10px">'+QUICK.map(q=>'<button class="chip" style="font-size:11px;padding:6px 10px" data-act="quick" data-v="'+esc(q)+'" data-id="'+t.id+'">'+esc(q)+'</button>').join('')+'</div>';
 h+='<div class="row" style="gap:8px"><input class="inp" id="chatInput" placeholder="Write a message…" style="flex:1"><button class="btn pri" style="width:48px;padding:0" data-act="send" data-id="'+t.id+'">'+ic('send','s')+'</button></div>';
 h+='<div class="tiny muted center" style="margin-top:12px">'+ic('lock','xs')+' For your safety, keep conversations and payments on Willow.</div></div>';
 return h;
};
VIEWS.profile=function(){
 const u=DB.user, done=DB.orders.filter(o=>o.status==='completed').length;
 let h='<div class="page"><div class="center" style="padding:10px 0 4px"><div class="av l" style="margin:0 auto;background:'+GRADS[0]+'">'+esc(u.initials)+'</div>'+
  '<h2 style="font-size:21px;margin-top:12px">'+esc(u.first)+' '+esc(u.last)+'</h2>'+
  '<div class="small muted">'+esc(u.email)+'</div><div style="margin-top:10px">'+(u.member?pill('Willow Plus member','gold'):'<button class="chip" data-go="membership">'+ic('spark','s')+' Discover Willow Plus</button>')+'</div></div>';
 h+='<div class="grid3" style="margin:20px 0 6px"><div class="stat"><b>'+done+'</b><small>visits</small></div>'+
  '<div class="stat"><b>'+DB.user.points+'</b><small>points</small></div>'+
  '<div class="stat"><b>'+DB.pets.length+'</b><small>pets</small></div></div>';
 h+='<div class="row" style="gap:8px;margin:12px 0 20px"><button class="btn ghost sm" style="flex:1" data-act="edit-profile">'+ic('edit','s')+' Edit profile</button>'+
  '<button class="btn soft sm" style="flex:1" data-go="invite">'+ic('gift','s')+' Invite friends</button></div>';
 const groups=[
  {title:'Your care',items:[['paw','Your pets',DB.pets.length+' profiles · vaccines & notes','pets'],['calendar','Bookings','Upcoming & past visits','bookings'],['heart','Saved caregivers',DB.favorites.length+' saved','favorites'],['pin','Saved addresses',DB.addresses.length+' places','addresses']]},
  {title:'Payments & rewards',items:[['wallet','Wallet & payments','Credit, cards, coupons','wallet'],['spark','Willow Plus',u.member?'Active membership':'Save on every booking','membership'],['gift','Invite a friend','Give $15, get $15','invite'],['receipt','Transaction history','Charges & refunds','wallet']]},
  {title:'Support & preferences',items:[['bell','Notifications',unreadCount()+' unread','notifications'],['shield','Safety centre','Emergency contact & trip sharing','safety'],['help','Help centre','FAQs and 24/7 support','help'],['settings','Settings','Appearance & notifications','settings']]}
 ];
 groups.forEach(g=>{ h+='<div class="sec-h" style="margin-top:22px"><h2>'+g.title+'</h2></div><div class="card" style="padding:2px 14px">'+
  g.items.map(i=>shortcut(i[0],i[1],i[2],i[3])).join('')+'</div>'; });
 h+='<div class="center tiny muted" style="margin-top:26px;line-height:1.7"><img src="'+LOGO+'" style="width:44px;height:38px;object-fit:contain;mix-blend-mode:multiply;opacity:.7" alt=""><br>Willow · Care that feels like family<br>Demo build · all data stays on this device</div></div>';
 return h;
};
VIEWS.favorites=function(){
 const list=DB.favorites.map(sitter);
 return '<div class="page">'+(list.length?'<div class="small muted" style="margin-bottom:14px">'+list.length+' caregivers you saved</div><div id="resList">'+list.map(resCard).join('')+'</div>':
  emptyState('No saved caregivers yet','Tap the heart on any profile and they will live here.','Browse caregivers','go-search','heart'))+'</div>';
};
VIEWS.pets=function(){
 let h='<div class="page"><div class="note" style="margin-bottom:16px;display:flex;gap:10px">'+ic('info','s')+'<span>The more your caregiver knows, the more it feels like home. Keep these profiles current.</span></div>';
 h+=DB.pets.map(p=>'<button class="card" style="width:100%;text-align:left;padding:12px;margin-bottom:12px;display:flex;gap:13px;align-items:center" data-go="pet/'+p.id+'">'+
  art(p.g,'paw','cover sm')+'<div style="flex:1"><b>'+esc(p.name)+'</b><small class="muted" style="display:block;margin-top:3px">'+esc(p.breed)+' · '+p.age+' yrs · '+esc(p.weight)+'</small>'+
  '<div class="row" style="gap:5px;margin-top:7px">'+pill(esc(p.type),'g')+(p.allergies!=='None'&&p.allergies!=='None known'?pill('Allergies','rose'):'')+'</div></div>'+ic('arrow','s')+'</button>').join('');
 h+='<button class="btn ghost block" data-act="add-pet">'+ic('plus','s')+' Add a pet</button></div>';
 return h;
};
VIEWS.pet=function(id){
 const p=pet(id); if(!p) return '<div class="page">'+emptyState('Pet not found','','Your pets','go-pets')+'</div>';
 let h='<div class="page">'+art(p.g,'paw','cover lg')+
  '<div style="padding:16px 2px"><div class="row between"><div><h1 style="font-size:24px">'+esc(p.name)+'</h1><div class="small muted">'+esc(p.breed)+' · '+esc(p.type)+'</div></div>'+
  '<button class="btn ghost sm" data-act="edit-pet" data-v="'+p.id+'">'+ic('edit','s')+' Edit</button></div>'+
  '<div class="grid3" style="margin:16px 0"><div class="stat"><b>'+p.age+'</b><small>years old</small></div><div class="stat"><b>'+esc(p.weight)+'</b><small>weight</small></div><div class="stat"><b>'+esc(p.type.split(' ')[0])+'</b><small>species</small></div></div>';
 const rows=[['Personality',p.personality],['Allergies',p.allergies],['Medication',p.meds],['Care notes',p.notes],['Vaccines',p.vaccines],['Veterinarian',p.vet],['Microchip',p.chip]];
 h+='<div class="card pad">'+rows.map(r=>'<div style="padding:10px 0;border-bottom:1px solid var(--line2)"><div class="eyebrow">'+r[0]+'</div><div class="small" style="margin-top:5px;line-height:1.55">'+esc(r[1])+'</div></div>').join('')+'</div>';
 h+='<button class="btn danger block" style="margin-top:16px" data-act="delete-pet" data-v="'+p.id+'">'+ic('trash','s')+' Remove '+esc(p.name)+'</button></div></div>';
 return h;
};
VIEWS.addresses=function(){
 let h='<div class="page"><div class="small muted" style="margin-bottom:14px">Caregivers only see the address for a confirmed booking.</div>';
 h+=DB.addresses.map(a=>'<div class="card pad" style="margin-bottom:12px"><div class="row between"><div class="row"><div class="lr-ic">'+ic('home','s')+'</div><b>'+esc(a.label)+'</b></div>'+
  (a.def?pill('Default','g'):'<button class="chip" style="padding:5px 9px;font-size:11px" data-act="make-default-addr" data-v="'+a.id+'">Set default</button>')+'</div>'+
  '<div class="small" style="margin:10px 0 4px">'+esc(a.line)+'<br>'+esc(a.city)+' '+esc(a.zip)+'</div>'+
  '<div class="tiny muted">'+ic('lock','xs')+' '+esc(a.note)+'</div>'+
  '<div class="row" style="gap:8px;margin-top:12px"><button class="btn ghost sm" data-act="edit-addr" data-v="'+a.id+'">Edit</button>'+
  '<button class="btn ghost sm" data-act="delete-addr" data-v="'+a.id+'">Remove</button></div></div>').join('');
 h+='<button class="btn ghost block" data-act="add-addr">'+ic('plus','s')+' Add an address</button></div>';
 return h;
};
VIEWS.wallet=function(){
 const u=DB.user;
 let h='<div class="page"><div class="card pad" style="background:'+GRADS[0]+';border:0;color:#fff;margin-bottom:16px">'+
  '<div class="eyebrow" style="color:rgba(255,255,255,.8)">Willow credit</div><div style="font-size:32px;font-weight:800;margin:4px 0">'+money(u.credit)+'</div>'+
  '<div class="small" style="opacity:.9">'+u.points+' points · 100 pts = $1 off a future visit</div></div>';
 h+='<div class="row" style="gap:8px;margin-bottom:18px"><button class="btn soft sm" style="flex:1" data-act="add-credit">'+ic('plus','s')+' Add credit</button>'+
  '<button class="btn ghost sm" style="flex:1" data-act="show-coupons">'+ic('tag','s')+' My coupons ('+DB.coupons.filter(c=>!c.used).length+')</button></div>';
 h+='<div class="sec-h"><h2>Payment methods</h2><span class="link" data-act="add-card">+ Add</span></div><div class="card" style="padding:2px 14px;margin-bottom:16px">'+
  DB.cards.map(c=>'<div class="list-row"><div class="lr-ic">'+ic('card','s')+'</div><div class="lr-t"><b>'+esc(c.label)+' ···· '+esc(c.last4)+'</b><small>Expires '+esc(c.exp)+(c.def?' · Default':'')+'</small></div>'+
   '<button class="chip" style="padding:5px 9px;font-size:11px" data-act="delete-card" data-v="'+c.id+'">Remove</button></div>').join('')+'</div>';
 h+='<div class="sec-h"><h2>Transactions</h2></div><div class="card pad">'+
  DB.txns.map(t=>'<div class="line-item" style="border-bottom:1px solid var(--line2);padding:11px 0"><span><b class="small">'+esc(t.label)+'</b><small class="muted" style="display:block;margin-top:3px">'+fmtDate(t.ts)+' · '+t.type+'</small></span>'+
   '<span class="b" style="color:'+(t.amount>0?'var(--sage-d)':'var(--ink)')+'">'+(t.amount>0?'+':'−')+money(Math.abs(t.amount))+'</span></div>').join('')+'</div>';
 h+='<div class="note" style="margin-top:14px;font-size:11px">'+ic('info','s')+' Demo only — no real payment is processed and no card data leaves this device.</div></div>';
 return h;
};
VIEWS.membership=function(){
 const u=DB.user;
 let h='<div class="page"><div class="card pad center" style="background:'+GRADS[3]+';border:0;color:#fff;padding:26px 18px;margin-bottom:16px">'+
  '<div class="eyebrow" style="color:rgba(255,255,255,.85)">Willow Plus</div><h1 style="font-size:28px;margin:10px 0 6px;color:#fff">More care.<br>Less fuss.</h1>'+
  '<div class="small" style="opacity:.92">$12 / month · cancel any time</div></div>';
 h+='<div class="card pad" style="margin-bottom:16px">'+
  [['No service fees','Save 8% on every single booking'],['Priority booking','First access to the caregivers families love'],['Free meet-and-greet','One per month, on us'],['Double points','Twice the rewards on every visit'],['Dedicated support','A real human, faster']].map(x=>
   '<div class="list-row"><div class="lr-ic">'+ic('check','s')+'</div><div class="lr-t"><b>'+x[0]+'</b><small>'+x[1]+'</small></div></div>').join('')+'</div>';
 h+='<div class="note gold" style="margin-bottom:16px">Members save an average of <b>$28 / month</b>. Your current service fee on a $60 visit is '+money(4.8)+'.</div>';
 h+='<button class="btn '+(u.member?'ghost':'pri')+' block" data-act="toggle-member">'+(u.member?'Cancel membership':'Join Willow Plus')+'</button>'+
  (u.member?'<div class="tiny muted center" style="margin-top:9px">Your fee waiver is active on new bookings.</div>':'');
 return h+'</div>';
};
VIEWS.invite=function(){
 const code='WILLOW-'+DB.user.first.toUpperCase();
 let h='<div class="page"><div class="center" style="padding:12px 0 18px">'+art(GRADS[5],'gift','cover')+
  '<h1 style="font-size:25px;margin-top:18px">Good care is worth<br>sharing.</h1><div class="sub" style="margin-top:8px">Give a friend $15 off their first visit. Get $15 in credit when they book.</div></div>';
 h+='<div class="card pad center" style="margin-bottom:16px"><div class="eyebrow">Your invite code</div>'+
  '<div style="font-size:24px;font-weight:800;letter-spacing:1px;margin:10px 0">'+esc(code)+'</div>'+
  '<button class="btn soft sm" data-act="copy-code" data-v="'+esc(code)+'">'+ic('copy','s')+' Copy code</button></div>';
 h+='<div class="card pad" style="margin-bottom:16px"><div class="row between"><b class="small">Your progress</b><span class="small b">3 of 5 friends</span></div>'+
  '<div style="height:8px;background:var(--paper2);border-radius:8px;margin:10px 0"><div style="width:60%;height:100%;background:var(--sage);border-radius:8px"></div></div>'+
  '<div class="tiny muted">2 more friends unlock a <b>free night of boarding</b>.</div></div>';
 h+='<button class="btn pri block" data-act="share-invite" data-v="'+esc(code)+'">'+ic('send','s')+' Share invite</button>'+
  '<div class="tiny muted center" style="margin-top:12px;line-height:1.6">Demo: sharing copies a friendly message to your clipboard.</div></div>';
 return h;
};
VIEWS.notifications=function(){
 const icons={booking:'calendar',chat:'chat',review:'star',credit:'wallet'};
 let h='<div class="page"><div class="card" style="padding:2px 14px">'+DB.notifications.map(n=>
  '<button class="list-row" style="'+(n.read?'opacity:.6':'')+'" data-act="open-notif" data-v="'+n.id+'">'+
   '<div class="lr-ic">'+ic(icons[n.type]||'bell','s')+'</div><div class="lr-t"><b>'+esc(n.title)+'</b><small>'+esc(n.body)+'</small>'+
   '<small class="muted" style="display:block;margin-top:3px">'+esc(n.ts)+'</small></div>'+(n.read?'':ic('bolt','xs'))+'</button>').join('')+'</div>';
 if(!DB.notifications.length) h+=emptyState('All caught up','','','','bell');
 h+='<button class="btn ghost block sm" style="margin-top:14px" data-act="read-all">'+ic('check','s')+' Mark all as read</button></div>';
 return h;
};
VIEWS.settings=function(){
 const s=DB.settings;
 let h='<div class="page"><div class="sec-h"><h2>Appearance</h2></div><div class="card" style="padding:2px 14px;margin-bottom:20px">'+
  toggleRow('Dark mode','Easier on the eyes at night','dark',s.dark)+'</div>';
 h+='<div class="sec-h"><h2>Notifications</h2></div><div class="card" style="padding:2px 14px;margin-bottom:20px">'+
  toggleRow('Push notifications','Visit reminders and messages','push',s.push)+
  toggleRow('Email updates','Receipts and weekly summaries','email',s.email)+
  toggleRow('SMS alerts','Only for time-sensitive changes','sms',s.sms)+
  toggleRow('Weekly pet report','A little note about your week','weekly',s.weekly)+'</div>';
 h+='<div class="sec-h"><h2>Account</h2></div><div class="card" style="padding:2px 14px;margin-bottom:20px">'+
  shortcut('user','Personal details','Name, email, phone','#')+
  shortcut('paw','Your pets','Profiles, vaccines, notes','pets')+
  shortcut('lock','Privacy & data','Everything stays on this device','#')+'</div>';
 h+='<button class="btn danger block" data-act="reset-demo">'+ic('refresh','s')+' Reset demo data</button>'+
  '<div class="tiny muted center" style="margin-top:10px">Restores the original sample bookings, pets and messages.</div></div>';
 return h;
};
function toggleRow(title,sub,key,on){ return '<div class="list-row"><div class="lr-t"><b>'+title+'</b><small>'+sub+'</small></div><button class="toggle '+(on?'on':'')+'" data-act="toggle-setting" data-v="'+key+'"></button></div>'; }
VIEWS.help=function(){
 let h='<div class="page"><div class="card pad center" style="margin-bottom:18px">'+art(GRADS[0],'help','cover sm')+
  '<h2 style="font-size:19px;margin-top:14px">How can we help?</h2><div class="small muted" style="margin:6px 0 14px">Real humans, 24 hours a day, 7 days a week.</div>'+
  '<button class="btn pri block" data-act="contact-support">'+ic('chat','s')+' Chat with support</button></div>';
 h+='<div class="sec-h"><h2>Frequently asked</h2></div><div class="card pad">'+FAQS.map((f,i)=>
  '<div class="acc" data-acc="'+i+'"><button>'+esc(f.q)+ic('chev','s')+'</button><div class="body"><p>'+esc(f.a)+'</p></div></div>').join('')+'</div>';
 h+='<div class="sec-h" style="margin-top:20px"><h2>More</h2></div><div class="card" style="padding:2px 14px">'+
  shortcut('shield','Safety centre','Guarantee, insurance, emergency','safety')+
  shortcut('receipt','Refunds & receipts','Policies and downloads','bookings')+
  shortcut('info','About Willow','Our promise to families','#')+'</div></div>';
 return h;
};
VIEWS.safety=function(){
 let h='<div class="page"><div class="card pad" style="background:'+GRADS[7]+';border:0;color:#fff;margin-bottom:16px">'+
  '<div class="eyebrow" style="color:rgba(255,255,255,.85)">Willow Care Guarantee</div>'+
  '<h1 style="font-size:23px;margin:9px 0 6px;color:#fff">Peace of mind,<br>built in.</h1>'+
  '<div class="small" style="opacity:.92;line-height:1.6">Veterinary coverage up to $25,000, 24/7 support, and a vetted replacement if plans change.</div></div>';
 h+='<div class="grid2" style="margin-bottom:16px"><div class="stat"><b>100%</b><small>sitters screened</small></div><div class="stat"><b>24/7</b><small>human support</small></div></div>';
 h+='<div class="sec-h"><h2>Before & during a visit</h2></div><div class="card" style="padding:2px 14px;margin-bottom:16px">'+
  shortcut('map','Share a trip','Send live visit details to someone you trust','#')+
  shortcut('phone','Emergency contact',esc(DB.user.emergency),'#')+
  shortcut('shield','Care Guarantee','What is covered, in plain English','#')+
  shortcut('lock','Keep it on Willow','Messages & payments stay protected','#')+'</div>';
 h+='<button class="btn pri block" data-act="share-latest">'+ic('map','s')+' Share my next visit</button>'+
  '<button class="btn danger block" style="margin-top:9px" data-act="emergency">'+ic('phone','s')+' Get urgent help</button>'+
  '<div class="note" style="margin-top:16px;font-size:11px">'+ic('info','s')+' Demo only — no calls or messages leave this device.</div></div>';
 return h;
};

/* ---------- 7. Sheets / forms ---------- */
function filterSheet(){
 const f=DB.filters;
 let h='<div class="field"><label>Service</label><div class="row" style="flex-wrap:wrap;gap:6px">'+
  '<button class="chip '+(f.service==='all'?'on':'')+'" data-act="set-filter" data-k="service" data-v="all">All</button>'+
  SERVICES.map(s=>'<button class="chip '+(f.service===s.id?'on':'')+'" data-act="set-filter" data-k="service" data-v="'+s.id+'">'+s.name+'</button>').join('')+'</div></div>';
 h+='<div class="field"><label>Price</label><div class="seg">'+[['all','Any'],['under25','<$25'],['25to45','$25–45'],['over45','$45+']].map(x=>
  '<button class="'+(f.price===x[0]?'on':'')+'" data-act="set-filter" data-k="price" data-v="'+x[0]+'">'+x[1]+'</button>').join('')+'</div></div>';
 h+='<div class="field"><label>Minimum rating</label><div class="row" style="gap:6px;flex-wrap:wrap">'+[0,4.7,4.9].map(r=>
  '<button class="chip '+(f.rating===r?'on':'')+'" data-act="set-filter" data-k="rating" data-v="'+r+'">'+(r?r+'+ stars':'Any')+'</button>').join('')+'</div></div>';
 h+='<div class="field"><label>Distance (miles)</label><div class="row" style="gap:6px;flex-wrap:wrap">'+[1,3,5,10].map(r=>
  '<button class="chip '+(f.distance===r?'on':'')+'" data-act="set-filter" data-k="distance" data-v="'+r+'">'+r+' mi</button>').join('')+'</div></div>';
 h+='<div class="field"><label>Pet type</label><div class="row" style="gap:6px;flex-wrap:wrap">'+[['any','Any'],['dog','Dogs'],['cat','Cats'],['small','Small pets']].map(r=>
  '<button class="chip '+(f.pets===r[0]?'on':'')+'" data-act="set-filter" data-k="pets" data-v="'+r[0]+'">'+r[1]+'</button>').join('')+'</div></div>';
 h+='<div class="field"><label>Available within</label><div class="row" style="gap:6px;flex-wrap:wrap">'+[['any','Any time'],['3days','3 days'],['week','This week']].map(x=>
  '<button class="chip '+(f.date===x[0]?'on':'')+'" data-act="set-filter" data-k="date" data-v="'+x[0]+'">'+x[1]+'</button>').join('')+'</div></div>';
 h+='<div class="field"><label>Preferences</label>'+
  '<button class="check '+(f.instant?'on':'')+'" style="width:100%;text-align:left;margin-bottom:10px" data-act="toggle-filter" data-v="instant"><span class="box">'+ic('check')+'</span><span>Instant book only</span></button>'+
  '<button class="check '+(f.certified?'on':'')+'" style="width:100%;text-align:left" data-act="toggle-filter" data-v="certified"><span class="box">'+ic('check')+'</span><span>Background checked & insured</span></button></div>';
 h+='<div class="row" style="gap:8px;margin-top:18px"><button class="btn ghost" style="flex:1" data-act="clear-filters">Clear all</button>'+
  '<button class="btn pri" style="flex:2" data-act="close-sheet">Show '+filtered().length+' caregivers</button></div>';
 openSheet('Refine your search','Find the person who fits your family',h);
}
function petSheet(id){
 const p=id?pet(id):{name:'',type:'Dog',breed:'',age:'',weight:'',personality:'',allergies:'None',meds:'None',vet:'',chip:'',notes:'',vaccines:'—'};
 let h='<div class="field"><label>Name</label><input class="inp" id="f-name" value="'+esc(p.name)+'" placeholder="e.g. Biscuit"></div>'+
  '<div class="grid2"><div class="field"><label>Type</label><select class="inp" id="f-type">'+['Dog','Cat','Small pet'].map(x=>'<option '+(p.type===x?'selected':'')+'>'+x+'</option>').join('')+'</select></div>'+
  '<div class="field"><label>Age (years)</label><input class="inp" id="f-age" type="number" min="0" value="'+esc(p.age)+'"></div></div>'+
  '<div class="grid2"><div class="field"><label>Breed</label><input class="inp" id="f-breed" value="'+esc(p.breed)+'"></div>'+
  '<div class="field"><label>Weight</label><input class="inp" id="f-weight" value="'+esc(p.weight)+'" placeholder="e.g. 42 lb"></div></div>'+
  '<div class="field"><label>Personality</label><input class="inp" id="f-personality" value="'+esc(p.personality)+'" placeholder="What makes them them?"></div>'+
  '<div class="field"><label>Allergies</label><input class="inp" id="f-allergies" value="'+esc(p.allergies)+'"></div>'+
  '<div class="field"><label>Medication</label><input class="inp" id="f-meds" value="'+esc(p.meds)+'"></div>'+
  '<div class="field"><label>Veterinarian</label><input class="inp" id="f-vet" value="'+esc(p.vet)+'"></div>'+
  '<div class="field"><label>Vaccines</label><input class="inp" id="f-vaccines" value="'+esc(p.vaccines)+'"></div>'+
  '<div class="field"><label>Microchip</label><input class="inp" id="f-chip" value="'+esc(p.chip)+'"></div>'+
  '<div class="field"><label>Care notes for your sitter</label><textarea class="inp" id="f-notes">'+esc(p.notes)+'</textarea></div>'+
  '<button class="btn pri block" data-act="save-pet" data-v="'+esc(id||'')+'">'+(id?'Save changes':'Add pet')+'</button>';
 openSheet(id?'Edit '+esc(p.name):'Add a pet','The little details make the biggest difference',h);
}
function addrSheet(id){
 const a=id?DB.addresses.find(x=>x.id===id):{label:'',line:'',city:'',zip:'',note:'',def:false};
 let h='<div class="field"><label>Label</label><input class="inp" id="f-label" value="'+esc(a.label)+'" placeholder="Home, weekend place…"></div>'+
  '<div class="field"><label>Street address</label><input class="inp" id="f-line" value="'+esc(a.line)+'"></div>'+
  '<div class="grid2"><div class="field"><label>City / neighborhood</label><input class="inp" id="f-city" value="'+esc(a.city)+'"></div>'+
  '<div class="field"><label>ZIP</label><input class="inp" id="f-zip" value="'+esc(a.zip)+'"></div></div>'+
  '<div class="field"><label>Access notes</label><textarea class="inp" id="f-note">'+esc(a.note)+'</textarea></div>'+
  '<button class="check '+(a.def?'on':'')+'" style="width:100%;text-align:left;margin-bottom:16px" id="f-def" data-act="toggle-def-ui"><span class="box">'+ic('check')+'</span><span>Make this my default address</span></button>'+
  '<button class="btn pri block" data-act="save-addr" data-v="'+esc(id||'')+'">'+(id?'Save changes':'Add address')+'</button>';
 openSheet(id?'Edit address':'Add an address','Where should your caregiver go?',h);
}
function profileSheet(){
 const u=DB.user;
 let h='<div class="grid2"><div class="field"><label>First name</label><input class="inp" id="f-first" value="'+esc(u.first)+'"></div>'+
  '<div class="field"><label>Last name</label><input class="inp" id="f-last" value="'+esc(u.last)+'"></div></div>'+
  '<div class="field"><label>Email</label><input class="inp" id="f-email" type="email" value="'+esc(u.email)+'"></div>'+
  '<div class="field"><label>Phone</label><input class="inp" id="f-phone" value="'+esc(u.phone)+'"></div>'+
  '<div class="field"><label>Neighborhood</label><input class="inp" id="f-location" value="'+esc(u.location)+'"></div>'+
  '<div class="field"><label>Emergency contact</label><input class="inp" id="f-emergency" value="'+esc(u.emergency)+'"></div>'+
  '<button class="btn pri block" data-act="save-profile">Save changes</button>';
 openSheet('Personal details','Keep your family information up to date',h);
}
function rescheduleSheet(id){
 const o=order(id);
 let h='<div class="field"><label>Choose a new date</label>'+dateStrip(o.date,'resched-date','data-id="'+o.id+'"')+'</div>'+
  '<div class="field"><label>Available times</label><div class="row" style="gap:6px;flex-wrap:wrap">'+
   freeSlots(o.sitterId,o.date).map(t=>'<button class="chip '+(o.time===t?'on':'')+'" style="padding:7px 10px;font-size:11px" data-act="resched-time" data-v="'+t+'" data-id="'+o.id+'">'+t+'</button>').join('')+'</div></div>'+
  '<div class="note" style="margin-bottom:14px">Changes made more than 24 hours before the visit are always free.</div>'+
  '<button class="btn ghost block" data-act="close-sheet">Keep current time</button>';
 openSheet('Reschedule your visit','Pick a time that works better',h);
}
function cancelSheet(id){
 const o=order(id), paid=paidFor(o), refund=refundFor(o), pct=paid?Math.round(refund/paid*100):0;
 let h='<p class="small muted" style="line-height:1.6;margin:0 0 14px">We are sorry it is not working out. Your caregiver will be notified straight away.</p>'+
  '<div class="card pad" style="margin-bottom:14px"><div class="line-item"><span>Paid for this visit</span><span>'+money(paid)+'</span></div>'+
  '<div class="line-item"><span>Policy</span><span>'+(pct===100?'Free · over 24h before':pct===50?'50% · within 24h':'No refund · visit started')+'</span></div>'+
  '<div class="line-item total"><span>Refund to Willow credit</span><span>'+money(refund)+'</span></div></div>'+
  '<div class="field"><label>Reason (optional)</label><select class="inp" id="f-reason"><option>Plans changed</option><option>Found another time</option><option>Pet is unwell</option><option>Other</option></select></div>'+
  '<div class="row" style="gap:8px"><button class="btn ghost" style="flex:1" data-act="close-sheet">Keep booking</button>'+
  '<button class="btn danger" style="flex:1" data-act="confirm-cancel" data-v="'+id+'">Cancel & refund</button></div>';
 openSheet('Cancel this booking?',esc(svc(o.service).name)+' with '+esc(sitter(o.sitterId).name),h);
}

/* ---------- 8. Actions ---------- */
const ACT={
 'home-search':function(){ const v=$('#homeQ').value.trim(); DB.filters.q=v; if(v&&DB.recent.indexOf(v)<0)DB.recent.unshift(v); save(); nav('search'); },
 'open-filters':filterSheet,
 'close-sheet':closeSheet,
 'set-filter':function(d){ DB.filters[d.k]=(d.k==='rating'||d.k==='distance')?parseFloat(d.v):d.v; save(); render(); if($('#sheetOverlay').classList.contains('show'))filterSheet(); },
 'toggle-filter':function(d){ DB.filters[d.v]=!DB.filters[d.v]; save(); render(); filterSheet(); },
 'clear-filters':function(){ DB.filters=seed().filters; save(); render(); if($('#sheetOverlay').classList.contains('show'))filterSheet(); },
 'recent':function(d){ DB.filters.q=d.v; save(); render(); },
 'pick-service':function(d){ DB.filters.service=d.v; DB.filters.q=''; save(); nav('search'); },
 'toggle-fav':function(d){ const i=DB.favorites.indexOf(d.v); if(i>=0){DB.favorites.splice(i,1);toast('Removed from saved');}else{DB.favorites.push(d.v);toast('Saved to your favourites');} save(); render(); },
 'pin':function(d){ const s=sitter(d.v);
   openModal('<div style="text-align:left">'+avatar(s,'l')+'<h2 style="margin-top:10px">'+esc(s.name)+'</h2>'+
    '<p style="text-align:left">'+esc(s.role)+' · '+stars(s.rating)+' · '+s.distance+' mi away · from '+money(s.rate)+'</p>'+
    '<button class="btn pri block" data-go="sitter/'+s.id+'">View profile</button>'+
    '<button class="btn ghost block sm" style="margin-top:8px" data-act="close-modal">Maybe later</button></div>'); },
 'pick-svc':function(d){ DB.draft.service=d.v; save(); render(); },
 'pick-date':function(d){ DB.draft.date=d.v; DB.draft.time=''; save(); render(); },
 'pick-time':function(d){ DB.draft.time=d.v; save(); render(); },
 'qty':function(d){ DB.draft.qty=Math.max(1,Math.min(14,DB.draft.qty+parseInt(d.v,10))); save(); render(); },
 'pick-pet':function(d){ const a=DB.draft.pets,i=a.indexOf(d.v); if(i>=0){if(a.length>1)a.splice(i,1);}else a.push(d.v); save(); render(); },
 'pick-extra':function(d){ const a=DB.draft.extras,i=a.indexOf(d.v); if(i>=0)a.splice(i,1);else a.push(d.v); save(); render(); },
 'message-sitter':function(d){ const t=threadFor(d.v); nav('chat/'+t.id); },
 'to-checkout':function(){ if(!DB.draft.time){toast('Please choose a time first');return;} nav('checkout'); },
 'apply-promo':function(){ const v=($('#promoInput').value||'').trim().toUpperCase();
   if(!v){toast('Enter a code first');return;}
   const ok=COUPON_CODES[v]||DB.coupons.find(c=>c.code===v&&!c.used);
   if(!ok){toast('That code is not valid');DB.draft.coupon='';}else{DB.draft.coupon=v;toast('Promo applied — nice find!');}
   save(); render(); },
 'use-points':function(){ DB.draft.usePoints=!DB.draft.usePoints; save(); render(); },
 'toggle-agree':function(){ DB.draft.agree=!DB.draft.agree; save(); render(); },
 'place-order':function(){
   const d=DB.draft, q=quote(d);
   if(!d.time){toast('Choose a time before booking');return;}
   if(!d.pets.length){toast('Add at least one pet');return;}
   if(!d.agree){toast('Please accept the service terms');return;}
   const s=sitter(d.sitterId), id='W-'+Math.floor(1000+Math.random()*8999);
   DB.orders.unshift({id:id,sitterId:d.sitterId,service:d.service,date:d.date,time:d.time,qty:d.qty,
     pets:d.pets.slice(),extras:d.extras.slice(),addressId:d.addressId,note:d.note,status:s.instant?'upcoming':'pending',total:q.total,
     breakdown:{base:q.base,extra:q.extra,discount:q.discount,platform:DB.user.member?0:q.platform,tax:q.tax,credit:q.credit},
     coupon:d.coupon,created:today(0),points:q.points,reviewed:false,tip:0,
     timeline:[{t:'Booking confirmed',d:s.name+' accepted your request',done:true},
               {t:'Reminder set',d:'We will nudge you 2 hours before',done:true},
               {t:'Visit begins',d:'Waiting for check-in',done:false},
               {t:'Photo updates',d:'Coming during the visit',done:false},
               {t:'Visit complete',d:'Receipt and review',done:false}]});
   if(d.usePoints){
     DB.user.points=Math.max(0,DB.user.points-Math.round(q.pointOff*100));
     DB.user.credit=Math.max(0,DB.user.credit-q.creditOff);
   }
   DB.user.points+=q.points;
   const cp=DB.coupons.find(c=>c.code===String(d.coupon).toUpperCase()&&!c.used); if(cp) cp.used=true;
   txn(svc(d.service).name+' · '+s.name,-q.total,'charge');
   notify('booking',s.instant?'Booking confirmed':'Request sent',
     s.instant?(svc(d.service).name+' with '+s.name+' on '+fmtDate(d.date)+'.'):('Waiting for '+s.name+' to accept your request.'),'booking/'+id);
   const t=threadFor(d.sitterId);
   pushMsg(t,'me','Just booked '+svc(d.service).name.toLowerCase()+' for '+fmtDate(d.date)+' — looking forward to it!');
   pushMsg(t,'them','Thank you so much! I will be there and will send updates during the visit.');
   DB.draft=null; DB._bkTab='upcoming'; save(); confetti();
   openModal('<img src="'+LOGO+'" alt=""><h2>You are all set!</h2>'+
    '<p>'+esc(s.name.split(' ')[0])+(s.instant?' is confirmed for':' will confirm your request for')+' <b>'+fmtDate(d.date,true)+'</b> at <b>'+esc(d.time)+'</b>. We sent the details to your messages.</p>'+
    '<div class="card pad" style="text-align:left;margin-bottom:16px"><div class="line-item"><span>Booking</span><b>'+id+'</b></div>'+
     '<div class="line-item"><span>Total</span><b>'+money(q.total)+'</b></div>'+
     '<div class="line-item"><span>Points earned</span><b>+'+q.points+'</b></div></div>'+
    '<button class="btn pri block" data-go="booking/'+id+'">View booking '+ic('arrow','s')+'</button>'+
    '<button class="btn ghost block sm" style="margin-top:8px" data-go="bookings">All bookings</button></div>');
   setTimeout(function(){ if($('#overlay').classList.contains('show')){closeModal();nav('booking/'+id);} },3600);
 },
 'bk-tab':function(d){ DB._bkTab=d.v; save(); render(); },
 'accept-request':function(d){ const o=order(d.v); if(!o)return; o.status='upcoming';
   o.timeline.unshift({t:'Request accepted',d:sitter(o.sitterId).name+' confirmed your booking',done:true});
   notify('booking','Request accepted',sitter(o.sitterId).name+' confirmed your visit.','booking/'+o.id);
   pushMsg(threadFor(o.sitterId),'them','Happy to confirm — I will see you then!');
   save(); render(); toast('Your visit is confirmed'); },
 'reschedule':function(d){ rescheduleSheet(d.v); },
 'resched-date':function(d){ const o=order(d.id); if(!o)return; o.date=d.v; save(); render(); rescheduleSheet(d.id); },
 'resched-time':function(d){ const o=order(d.id); o.time=d.v; o.timeline.splice(1,0,{t:'Rescheduled',d:'New time: '+d.v,done:true});
   notify('booking','Visit rescheduled','Your visit with '+sitter(o.sitterId).name+' is now at '+d.v+'.','booking/'+o.id); save(); closeSheet(); render(); toast('Visit rescheduled'); },
 'cancel-order':function(d){ cancelSheet(d.v); },
 'confirm-cancel':function(d){ const o=order(d.v), refund=refundFor(o);
   o.status='cancelled'; o.breakdown.credit=refund; o.timeline=[{t:'Booking confirmed',d:'Caregiver accepted',done:true},
     {t:'Cancelled',d:money(refund)+' refunded to Willow credit under the cancellation policy',done:true}];
   DB.user.credit+=refund; txn('Refund · '+o.id,refund,'refund');
   notify('credit','Refund on its way',money(refund)+' is now available in your Willow credit.','wallet');
   save(); closeSheet(); render(); toast('Cancelled · '+money(refund)+' refunded to credit'); },
 'check-in':function(d){ const o=order(d.v); o.status='in_progress';
   o.timeline=[{t:'Booking confirmed',d:'Caregiver accepted your request',done:true},
     {t:'Sitter checked in',d:'Just now · arrived at '+addr(o.addressId).label,done:true},
     {t:'Photo updates',d:'Coming during the visit',done:false},
     {t:'Visit ends',d:'Waiting for check-out',done:false},
     {t:'Receipt and review',d:'After check-out',done:false}];
   notify('booking','Your visit has started',sitter(o.sitterId).name+' checked in. You will get updates along the way.','booking/'+o.id);
   pushMsg(threadFor(o.sitterId),'them','Just arrived — everything looks great. I will send a photo soon!');
   save(); render(); toast('Visit is now in progress'); },
 'photo-update':function(d){ const o=order(d.v), s=sitter(o.sitterId);
   o.timeline.splice(3,0,{t:'Photo update',d:'Just now · '+s.name.split(' ')[0]+' shared a moment from the visit',done:true});
   notify('chat','New photo update',s.name+' shared an update from your visit.','booking/'+o.id);
   pushMsg(threadFor(o.sitterId),'them','Here is a little moment from our visit — all smiles.');
   save(); render(); toast('New photo update received'); },
 'finish-visit':function(d){ const o=order(d.v); o.status='completed';
   o.timeline=o.timeline.map(t=>({t:t.t,d:t.d,done:true}));
   o.timeline.push({t:'Receipt ready',d:'Download it any time from this booking',done:true});
   notify('review','How did it go?','Leave '+sitter(o.sitterId).name.split(' ')[0]+' a review and make their day.','review/'+o.id);
   save(); render(); toast('Visit completed — a review would mean a lot'); },
 'receipt':function(d){ const o=order(d.v), s=sitter(o.sitterId), b=o.breakdown;
   const txt=['WILLOW · RECEIPT','','Booking: '+o.id,'Date: '+fmtDate(o.date,true)+' at '+o.time,
    'Caregiver: '+s.name,'Service: '+svc(o.service).name+' × '+o.qty,'Pets: '+o.pets.map(x=>pet(x)?pet(x).name:x).join(', '),
    'Address: '+addr(o.addressId).line+', '+addr(o.addressId).city,'','--------------------------------',
    'Service                    '+money(b.base),'Extras                     '+money(b.extra),
    'Service fee                '+money(b.platform),'Tax                        '+money(b.tax),
    (b.discount?'Promo                     −'+money(b.discount):''),(b.credit?'Credit used                −'+money(b.credit):''),
    '--------------------------------','TOTAL                      '+money(o.total),
    'Tip                        '+money(o.tip||0),'','Covered by the Willow Care Guarantee.',
    'Thank you for trusting us with your family.',''].filter(Boolean).join('\n');
   const blob=new Blob([txt],{type:'text/plain'}), url=URL.createObjectURL(blob), a=document.createElement('a');
   a.href=url; a.download='willow-receipt-'+o.id+'.txt'; document.body.appendChild(a); a.click(); document.body.removeChild(a);
   setTimeout(()=>URL.revokeObjectURL(url),1000); toast('Receipt downloaded'); },
 'book-again':function(d){ const o=order(d.v);
   DB.draft={sitterId:o.sitterId,service:o.service,date:today(2),time:'',qty:o.qty,pets:o.pets.slice(),
    extras:o.extras.slice(),addressId:o.addressId,note:o.note,coupon:'',usePoints:false,agree:true,
    cardId:(DB.cards.find(c=>c.def)||DB.cards[0]).id};
   save(); nav('sitter/'+o.sitterId); toast('Your booking details are ready to edit'); },
 'set-stars':function(d){ DB._review.stars=parseInt(d.v,10); save(); render(); },
 'review-tag':function(d){ const a=DB._review.tags,i=a.indexOf(d.v); if(i>=0)a.splice(i,1);else a.push(d.v); save(); render(); },
 'set-tip':function(d){ DB._review.tip=parseInt(d.v,10); save(); render(); },
 'submit-review':function(d){ const o=order(d.v), r=DB._review, s=sitter(o.sitterId);
   const tip=Math.round((o.total||0)*r.tip/100*100)/100;
   o.reviewed=true; o.tip=tip; o.timeline.push({t:'Review left',d:r.stars+' stars · '+money(tip)+' tip',done:true});
   DB.reviews.unshift({sitterId:s.id,n:DB.user.first+' '+DB.user.last[0]+'.',d:'Just now',r:r.stars,
     t:r.text||'A lovely visit — we would absolutely book again.',tags:r.tags.slice()});
   const base=SITTERS.find(x=>x.id===s.id), st=DB.sitterStats[s.id]||{rating:base.rating,reviews:base.reviews};
   DB.sitterStats[s.id]={rating:Math.round(((st.rating*st.reviews+r.stars)/(st.reviews+1))*100)/100,reviews:st.reviews+1};
   DB.user.points+=50; notify('credit','Thank you for your review','+50 points added to your account.','profile');
   txn('Tip to '+s.name,-tip,'tip'); DB._review=null; save(); confetti();
   openModal('<img src="'+LOGO+'" alt=""><h2>That was kind of you.</h2><p>Your review helps other families find care they can trust — and '+esc(s.name.split(' ')[0])+' will see it straight away.</p>'+
    '<div class="note" style="text-align:left;margin-bottom:14px">+50 points · '+money(tip)+' tip sent</div>'+
    '<button class="btn pri block" data-go="bookings">Back to bookings</button></div>'); },
 'skip-review':function(d){ DB._review=null; save(); nav('bookings'); },
 'quick':function(d){ sendChat(d.id,d.v); },
 'send':function(d){ const el=$('#chatInput'); if(!el.value.trim())return; sendChat(d.id,el.value.trim()); },
 'new-chat':function(){ openSheet('Start a conversation','Choose who you would like to message',
   '<div class="card" style="padding:2px 14px">'+SITTERS.slice(0,5).map(s=>'<button class="list-row" data-act="start-chat" data-v="'+s.id+'">'+avatar(s,'s')+'<div class="lr-t"><b>'+esc(s.name)+'</b><small>'+esc(s.role)+'</small></div>'+ic('arrow','s')+'</button>').join('')+'</div>'); },
 'start-chat':function(d){ const t=threadFor(d.v); closeSheet(); nav('chat/'+t.id); },
 'add-pet':function(){ petSheet(); },
 'edit-pet':function(d){ petSheet(d.v); },
 'save-pet':function(d){
   const v=k=>{const e=$('#f-'+k);return e?e.value.trim():'';};
   if(!v('name')){toast('Please give your pet a name');return;}
   const obj={name:v('name'),type:v('type'),age:v('age')||'—',breed:v('breed')||'—',weight:v('weight')||'—',
     personality:v('personality')||'A very good companion',allergies:v('allergies')||'None',meds:v('meds')||'None',
     vet:v('vet')||'—',vaccines:v('vaccines')||'—',chip:v('chip')||'—',notes:v('notes')||'—'};
   if(d.v) Object.assign(pet(d.v),obj);
   else DB.pets.push(Object.assign({id:uid('p'),g:GRADS[DB.pets.length%GRADS.length],initials:obj.name[0].toUpperCase()},obj));
   save(); closeSheet(); render(); toast(d.v?'Pet profile updated':'Welcome to the family!'); },
 'delete-pet':function(d){ DB.pets=DB.pets.filter(p=>p.id!==d.v); save(); nav('pets'); toast('Pet profile removed'); },
 'add-addr':function(){ addrSheet(); },
 'edit-addr':function(d){ addrSheet(d.v); },
 'toggle-def-ui':function(d,el){ el.classList.toggle('on'); el._def=el.classList.contains('on'); },
 'save-addr':function(d){
   const v=k=>{const e=$('#f-'+k);return e?e.value.trim():'';};
   if(!v('label')||!v('line')){toast('Label and street address are required');return;}
   const defEl=$('#f-def'), def=defEl?(defEl._def!==undefined?defEl._def:defEl.classList.contains('on')):false;
   const obj={label:v('label'),line:v('line'),city:v('city'),zip:v('zip'),note:v('note'),def:def};
   let targetId=d.v;
   if(d.v) Object.assign(DB.addresses.find(a=>a.id===d.v),obj);
   else { targetId=uid('a'); DB.addresses.push(Object.assign({id:targetId},obj)); }
   if(def) DB.addresses.forEach(a=>{if(a.id!==targetId)a.def=false;});
   if(!DB.addresses.some(a=>a.def)) DB.addresses[0].def=true;
   save(); closeSheet(); render(); toast('Address saved'); },
 'make-default-addr':function(d){ DB.addresses.forEach(a=>a.def=(a.id===d.v)); save(); render(); toast('Default address updated'); },
 'delete-addr':function(d){ if(DB.addresses.length<=1){toast('Keep at least one address');return;}
   DB.addresses=DB.addresses.filter(a=>a.id!==d.v); if(!DB.addresses.some(a=>a.def))DB.addresses[0].def=true;
   DB.orders.forEach(o=>{if(o.addressId===d.v)o.addressId=DB.addresses[0].id;}); save(); render(); toast('Address removed'); },
 'add-card':function(){ openSheet('Add a payment method','Demo only — nothing is stored or sent',
   '<div class="field"><label>Label</label><input class="inp" id="f-cardlabel" placeholder="e.g. Everyday card"></div>'+
   '<div class="field"><label>Last 4 digits</label><input class="inp" id="f-last4" maxlength="4" placeholder="4242"></div>'+
   '<div class="field"><label>Expiry</label><input class="inp" id="f-exp" placeholder="MM/YY"></div>'+
   '<button class="btn pri block" data-act="save-card">Add card</button>'); },
 'save-card':function(){ const l=$('#f-cardlabel').value.trim(),n=$('#f-last4').value.trim(),e=$('#f-exp').value.trim();
   if(!/^\d{4}$/.test(n)){toast('Enter the last 4 digits');return;}
   DB.cards.push({id:uid('c'),label:l||'New card',last4:n,exp:e||'12/29',def:false}); save(); closeSheet(); render(); toast('Payment method added'); },
 'delete-card':function(d){ if(DB.cards.length<=1){toast('Keep at least one card');return;}
   DB.cards=DB.cards.filter(c=>c.id!==d.v); if(!DB.cards.some(c=>c.def))DB.cards[0].def=true; save(); render(); toast('Card removed'); },
 'add-credit':function(){ openSheet('Add Willow credit','Demo top-up — no real payment',
   '<div class="row" style="gap:7px;flex-wrap:wrap;margin-bottom:16px">'+[10,25,50,100].map(n=>'<button class="chip" data-act="topup" data-v="'+n+'">+'+money(n)+'</button>').join('')+'</div>'+
   '<div class="note">Credit is applied automatically at checkout when you choose “Use points & credit”.</div>'); },
 'topup':function(d){ DB.user.credit+=parseInt(d.v,10); txn('Credit top-up',parseInt(d.v,10),'credit'); save(); closeSheet(); render(); toast(money(parseInt(d.v,10))+' added to your credit'); },
 'show-coupons':function(){ openSheet('Your coupons','Apply a code at checkout',
   '<div class="card pad" style="margin-bottom:14px">'+DB.coupons.map(c=>'<div class="list-row"><div class="lr-ic">'+ic('tag','s')+'</div><div class="lr-t"><b>'+esc(c.code)+'</b><small>'+esc(c.label)+(c.used?' · used':'')+'</small></div>'+
    (c.used?'':pill('Active','g'))+'</div>').join('')+'</div>'+
   '<div class="field"><label>Redeem a code</label><input class="inp" id="f-newcoupon" placeholder="WILLOW10, CARE20, FIRST5"></div>'+
   '<button class="btn pri block" data-act="redeem">Redeem code</button>'); },
 'redeem':function(){ const v=($('#f-newcoupon').value||'').trim().toUpperCase(), c=COUPON_CODES[v];
   if(!c){toast('That code is not valid');return;}
   if(DB.coupons.some(x=>x.code===v)){toast('You already have this one');return;}
   DB.coupons.push({code:v,label:c.label,type:c.type,value:c.value,used:false}); save(); closeSheet(); render(); toast('Coupon added to your wallet'); },
 'toggle-member':function(){ DB.user.member=!DB.user.member;
   if(DB.user.member) notify('credit','Welcome to Willow Plus','Service fees are now waived on new bookings.','membership');
   save(); render(); toast(DB.user.member?'Willow Plus is active':'Membership cancelled'); },
 'copy-code':function(d){ copyText(d.v); },
 'share-invite':function(d){ copyText('Come meet Willow — the people who treat your pet like family. Use my code '+d.v+' for $15 off your first visit.'); },
 'open-notif':function(d){ const n=DB.notifications.find(x=>x.id===d.v); if(!n)return; n.read=true; save(); if(n.go)nav(n.go); else render(); },
 'read-all':function(){ DB.notifications.forEach(n=>n.read=true); save(); render(); toast('All caught up'); },
 'edit-profile':profileSheet,
 'save-profile':function(){ const v=k=>$('#f-'+k).value.trim();
   DB.user.first=v('first')||DB.user.first; DB.user.last=v('last')||DB.user.last;
   DB.user.initials=(DB.user.first[0]+DB.user.last[0]).toUpperCase();
   DB.user.email=v('email'); DB.user.phone=v('phone'); DB.user.location=v('location'); DB.user.emergency=v('emergency');
   save(); closeSheet(); render(); toast('Profile updated'); },
 'toggle-setting':function(d,el){ const k=d.v; DB.settings[k]=!DB.settings[k];
   if(k==='dark') document.body.classList.toggle('dark',DB.settings.dark);
   save(); el.classList.toggle('on',DB.settings[k]); toast(k==='dark'?(DB.settings.dark?'Dark mode on':'Light mode on'):'Preference saved'); },
 'reset-demo':function(){ openModal('<h2>Reset demo data?</h2><p>This restores the original sample pets, bookings, messages and wallet.</p>'+
   '<button class="btn danger block" data-act="do-reset">Yes, reset everything</button><button class="btn ghost block sm" style="margin-top:8px" data-act="close-modal">Keep my changes</button></div>'); },
 'do-reset':function(){ resetDB(); document.body.classList.remove('dark'); closeModal(); nav('home'); toast('Demo data restored'); },
 'contact-support':function(){ const t=threadFor('support'); save(); nav('chat/'+t.id); },
 'share-trip':function(d){ const o=order(d.v), s=sitter(o.sitterId);
   copyText('Willow visit · '+svc(o.service).name+' with '+s.name+' · '+fmtDate(o.date,true)+' at '+o.time+' · '+addr(o.addressId).line+', '+addr(o.addressId).city+' · Booking '+o.id); },
 'share-latest':function(){ const o=DB.orders.filter(x=>x.status==='upcoming'||x.status==='in_progress'||x.status==='pending')[0];
   if(o)ACT['share-trip']({v:o.id});else toast('No upcoming visit to share'); },
 'emergency':function(){ notify('booking','Support request noted','A support specialist would contact you here in a real app.','help'); save(); toast('Support notified · we are here 24/7'); },
 'order-menu':function(d){ const o=order(d.v);
   openSheet('About this booking',esc(o.id)+' · created '+fmtDate(o.created),
     '<div class="card pad small" style="line-height:1.7"><div>'+ic('shield','s')+' Covered by the Willow Care Guarantee.</div>'+
     '<div style="margin-top:8px">'+ic('clock','s')+' Free cancellation up to 24h before the visit.</div>'+
     '<div style="margin-top:8px">'+ic('receipt','s')+' Receipt available after the visit begins.</div></div>'+
     '<button class="btn pri block" style="margin-top:16px" data-act="close-sheet">Got it</button>'); },
 'go-search':function(){ nav('search'); }, 'go-bookings':function(){ nav('bookings'); }, 'go-pets':function(){ nav('pets'); },
 'go-messages':function(){ nav('messages'); },
 'close-modal':closeModal,
 'back':function(){ back(); }
};
function sendChat(id,text){
 const t=thread(id); if(!t)return;
 pushMsg(t,'me',text);
 setTimeout(function(){ pushMsg(t,'them',AUTO_REPLY[Math.floor(Math.random()*AUTO_REPLY.length)]); if(parseRoute().page==='chat')render(); },700);
 if(parseRoute().page==='chat')render();
 const el=$('#chatInput'); if(el)el.value='';
 setTimeout(function(){const v=$('#view');if(v)v.scrollTop=v.scrollHeight;},60);
}

/* ---------- 9. Router ---------- */
let stack=['home'], suppress=false;
function path(){ return (location.hash.replace(/^#\/?/,'')||'home').replace(/\/$/,''); }
function parseRoute(){ const p=path().split('/'); return {page:p[0]||'home',arg:p[1]||''}; }
function nav(p){ if(path()===p){render();return;} location.hash='#/'+p; }
function back(){
 const r=parseRoute(), cur=path();
 let target=null;
 if(stack.length>1){ stack.pop(); target=stack[stack.length-1]||null; }
 if(!target||target===cur) target=PARENT[r.page]||'home';
 if(r.page==='checkout'&&DB.draft&&DB.draft.sitterId) target='sitter/'+DB.draft.sitterId;
 if(target===cur) target=PARENT[r.page]||'home';
 suppress=true;
 if(location.hash==='#/'+target){ suppress=false; render(); return; }
 location.hash='#/'+target;
}
function render(){
 const r=parseRoute();
 if(!VIEWS[r.page]) r.page='home';
 $('#view').innerHTML=(VIEWS[r.page])(r.arg);
 renderChrome(r);
 $('#view').scrollTop=0;
 if(r.page==='help') bindAcc();
 if(r.page==='chat') setTimeout(()=>{const v=$('#view');v.scrollTop=v.scrollHeight;},50);
}
function bindAcc(){
 $$('.acc>button').forEach(function(b){
  b.addEventListener('click',function(){
   const a=b.parentNode, body=a.querySelector('.body'), open=a.classList.contains('open');
   $$('.acc').forEach(x=>{x.classList.remove('open');x.querySelector('.body').style.maxHeight='0px';});
   if(!open){a.classList.add('open');body.style.maxHeight=(body.scrollHeight+10)+'px';}
  });
 });
}
window.addEventListener('hashchange',function(){ if(!suppress)stack.push(path()); suppress=false; render(); });
$('#overlay').addEventListener('click',function(e){ if(e.target.id==='overlay')closeModal(); });
$('#sheetOverlay').addEventListener('click',function(e){ if(e.target.id==='sheetOverlay')closeSheet(); });
document.addEventListener('keydown',function(e){ if(e.key==='Escape'){closeModal();closeSheet();} });
document.addEventListener('click',function(e){
 const go=e.target.closest('[data-go]');
 if(go){ const g=go.dataset.go; closeModal(); closeSheet(); if(g==='#'){toast('Coming soon in this demo');return;} nav(g); return; }
 const el=e.target.closest('[data-act]');
 if(el){ const fn=ACT[el.dataset.act]; if(fn) fn(Object.assign({},el.dataset),el,e); return; }
});
document.addEventListener('change',function(e){
 const el=e.target.closest('[data-k]'); if(!el)return;
 const k=el.dataset.k, v=el.type==='checkbox'?el.checked:el.value;
 if(k.indexOf('draft.')===0){ DB.draft[k.slice(6)]=v; save(); render(); }
 else if(k==='sort'){ DB.filters.sort=v; save(); render(); }
 else if(k.indexOf('review.')===0){ if(DB._review)DB._review[k.slice(7)]=v; save(); }
 else if(k.indexOf('filter.')===0){ DB.filters[k.slice(7)]=v; save(); render(); }
});
const filterResultsLater=Pack.debounce(function(){
 const list=filtered(), box=$('#resList');
 if(box)box.innerHTML=list.length?list.map(resCard).join(''):'<div class="empty"><h3>No one quite matches yet</h3><p>Try another search or widen your filters.</p></div>';
 const c=$('#resCount'); if(c)c.textContent=list.length;
},320);
document.addEventListener('input',function(e){
 const dk=e.target.dataset?e.target.dataset.k:'';
 if(dk==='draft.note'&&DB.draft){ DB.draft.note=e.target.value; save(); return; }
 if(dk==='review.text'&&DB._review){ DB._review.text=e.target.value; save(); return; }
 if(e.target.id==='searchQ'){
  DB.filters.q=e.target.value; save();
  filterResultsLater();
 }
});
document.body.classList.toggle('dark',!!DB.settings.dark);
if(!location.hash) location.replace('#/home');
stack=[path()];
function bootApp(){render();}
Pack.mount('body', bootApp, {endpoint:'/home',label:'Finding caregivers near you…',payload:{}});
