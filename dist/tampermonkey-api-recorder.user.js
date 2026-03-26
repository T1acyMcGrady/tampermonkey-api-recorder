// ==UserScript==
// @name         Tampermonkey API Recorder
// @namespace    https://local.test.tools/
// @version      0.1.0
// @description  Capture, classify, replay, and report API calls during manual testing
// @match        *://*/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function tampermonkeyApiRecorder() {
  'use strict';

  if (window.__TM_API_RECORDER_INSTALLED__) {
    return;
  }
  window.__TM_API_RECORDER_INSTALLED__ = true;

  const APP_ID = 'tm-api-recorder';
  const APP_VERSION = '0.1.0';
  const CONFIG_STORAGE_KEY = 'tm_api_recorder_config';
  const ROOT_ID = 'tm-api-recorder-root';
  const XHR_META_KEY = '__tmApiRecorderMeta';
  const MAX_TOAST_COUNT = 3;
  const REPLAY_HEADER = 'x-tm-api-recorder-replay';
  const DB_NAME = 'tm_api_recorder';
  const DB_VERSION = 1;
  const STORE_NAMES = {
    sessions: 'sessions',
    records: 'records',
    templates: 'templates',
    replayReports: 'replayReports',
  };
  const STATIC_EXTENSIONS = [
    '.js',
    '.mjs',
    '.css',
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.svg',
    '.webp',
    '.ico',
    '.woff',
    '.woff2',
    '.ttf',
    '.map',
    '.mp4',
    '.webm',
    '.mp3',
    '.wav',
    '.pdf',
  ];
  const SENSITIVE_KEYS = new Set([
    'authorization',
    'cookie',
    'set-cookie',
    'password',
    'passwd',
    'pwd',
    'token',
    'access_token',
    'refresh_token',
    'csrf',
    'csrf_token',
    'x-csrf-token',
    'mobile',
    'phone',
    'idcard',
    'id_card',
  ]);
  const COMMON_EXCLUDE_MATCHERS = [
    { type: 'prefix', pathname: '/sockjs-node/' },
    { type: 'prefix', pathname: '/__webpack_hmr' },
    { type: 'prefix', pathname: '/api/track' },
    { type: 'prefix', pathname: '/api/log' },
    { type: 'prefix', pathname: '/api/metrics' },
    { type: 'exact', pathname: '/api/health' },
    { type: 'exact', pathname: '/favicon.ico' },
  ];
  const BUILTIN_VARIABLE_SOURCES = {
    token: [
      { source: 'localStorage', keys: ['token', 'access_token', 'accessToken', 'Authorization'] },
      { source: 'sessionStorage', keys: ['token', 'access_token', 'accessToken', 'Authorization'] },
      { source: 'cookie', keys: ['token', 'access_token', 'accessToken'] },
      { source: 'manual', keys: ['token'] },
    ],
    csrfToken: [
      { source: 'localStorage', keys: ['csrfToken', 'csrf_token', 'x-csrf-token'] },
      { source: 'sessionStorage', keys: ['csrfToken', 'csrf_token', 'x-csrf-token'] },
      { source: 'cookie', keys: ['csrfToken', 'csrf_token', 'x-csrf-token', 'xsrf-token'] },
      { source: 'manual', keys: ['csrfToken'] },
    ],
  };
  const DEFAULT_CONFIG = {
    enabled: true,
    capture: {
      include: [{ type: 'prefix', pathname: '/api/' }],
      exclude: COMMON_EXCLUDE_MATCHERS,
      maxStoredBodyChars: 20000,
      maxRecordsPerSession: 1000,
      storeUnknownResponses: true,
      skipHtmlResponses: true,
    },
    replay: {
      allowDangerous: false,
      blockedHostKeywords: ['prod', 'production'],
      confirmWarning: true,
      timeoutMs: 15000,
    },
    ui: {
      maxRecentFailures: 20,
      maxListItems: 200,
      compactToasts: true,
    },
    rules: [],
  };
  const originalApis = {
    fetch: typeof window.fetch === 'function' ? window.fetch.bind(window) : null,
    xhrOpen: XMLHttpRequest.prototype.open,
    xhrSend: XMLHttpRequest.prototype.send,
    xhrSetRequestHeader: XMLHttpRequest.prototype.setRequestHeader,
  };

  const bus = createEventBus();
  const state = {
    ready: false,
    uiReady: false,
    db: null,
    config: cloneDefaultConfig(),
    pendingPayloads: [],
    queueActive: false,
    panelOpen: false,
    currentTab: 'current',
    detailRecordId: null,
    currentSession: null,
    recentSessions: [],
    sessionRecords: [],
    templates: [],
    replayReports: [],
    selectedTemplateIds: new Set(),
    manualVariables: {},
    capturePaused: false,
    filters: {
      search: '',
      status: 'all',
      method: 'all',
    },
    toasts: [],
    lastVariableCheckAt: 0,
    sessionRecordLimitReached: false,
    root: null,
    shadowRoot: null,
  };

  installNetworkHooks();
  void bootstrap();

  async function bootstrap() {
    try {
      state.config = mergeConfig(cloneDefaultConfig(), await loadConfig());
      state.db = await openDatabase();
      state.currentSession = await createSession();
      state.recentSessions = await loadRecentSessions();
      state.templates = sortByDateDesc(await state.db.getAll(STORE_NAMES.templates), 'lastSuccessAt');
      state.replayReports = sortByDateDesc(await state.db.getAll(STORE_NAMES.replayReports), 'startedAt');
      bindGlobalListeners();
      await waitForDomReady();
      initUi();
      state.ready = true;
      scheduleRender();
      void drainPayloadQueue();
    } catch (error) {
      console.error('[TM API Recorder] bootstrap failed', error);
    }
  }

  function installNetworkHooks() {
    installFetchHook();
    installXhrHook();
  }

  function installFetchHook() {
    if (!originalApis.fetch || window.fetch.__tmApiRecorderWrapped__) {
      return;
    }

    const patchedFetch = async function patchedFetch(input, init) {
      if (init && init.__tmApiRecorderInternalReplay) {
        const passthroughInit = Object.assign({}, init);
        delete passthroughInit.__tmApiRecorderInternalReplay;
        return originalApis.fetch(input, passthroughInit);
      }

      const startedAt = Date.now();
      const requestPromise = extractFetchRequestMeta(input, init);
      try {
        const response = await originalApis.fetch(input, init);
        const responsePromise = extractFetchResponseMeta(response.clone());
        const payload = {
          source: 'fetch',
          startedAt,
          endedAt: Date.now(),
          request: await requestPromise,
          response: await responsePromise,
        };
        enqueuePayload(payload);
        return response;
      } catch (error) {
        const payload = {
          source: 'fetch',
          startedAt,
          endedAt: Date.now(),
          request: await requestPromise,
          response: null,
          error: serializeError(error),
        };
        enqueuePayload(payload);
        throw error;
      }
    };

    patchedFetch.__tmApiRecorderWrapped__ = true;
    window.fetch = patchedFetch;
  }

  function installXhrHook() {
    if (XMLHttpRequest.prototype.open.__tmApiRecorderWrapped__) {
      return;
    }

    XMLHttpRequest.prototype.open = function patchedOpen(method, url, async, user, password) {
      this[XHR_META_KEY] = {
        method: typeof method === 'string' ? method.toUpperCase() : 'GET',
        url: url,
        async: async !== false,
        user: user || null,
        password: password || null,
        headers: {},
        body: null,
        startedAt: 0,
      };
      return originalApis.xhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.open.__tmApiRecorderWrapped__ = true;

    XMLHttpRequest.prototype.setRequestHeader = function patchedSetRequestHeader(name, value) {
      const meta = this[XHR_META_KEY];
      if (meta && typeof name === 'string') {
        meta.headers[name.toLowerCase()] = String(value);
      }
      return originalApis.xhrSetRequestHeader.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function patchedSend(body) {
      const meta = this[XHR_META_KEY] || {
        method: 'GET',
        url: '',
        headers: {},
        body: null,
      };
      meta.body = body;
      meta.startedAt = Date.now();
      this[XHR_META_KEY] = meta;
      const xhr = this;
      const listener = function onLoadEnd() {
        xhr.removeEventListener('loadend', listener);
        const xhrMeta = xhr[XHR_META_KEY];
        if (!xhrMeta) {
          return;
        }
        const payload = {
          source: 'xhr',
          startedAt: xhrMeta.startedAt || Date.now(),
          endedAt: Date.now(),
          request: {
            method: xhrMeta.method,
            url: xhr.responseURL || xhrMeta.url,
            headers: xhrMeta.headers,
            body: xhrMeta.body,
            contentType: xhrMeta.headers['content-type'] || '',
          },
          response: {
            status: Number(xhr.status) || 0,
            statusText: xhr.statusText || '',
            headers: parseRawResponseHeaders(xhr.getAllResponseHeaders()),
            body: extractXhrResponseBody(xhr),
            contentType: getXhrContentType(xhr),
            url: xhr.responseURL || xhrMeta.url,
          },
          error: xhr.status === 0 ? { message: 'xhr_status_0' } : null,
        };
        enqueuePayload(payload);
      };
      xhr.addEventListener('loadend', listener);
      return originalApis.xhrSend.apply(this, arguments);
    };
  }

  function bindGlobalListeners() {
    window.addEventListener('beforeunload', () => {
      void finishCurrentSession();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        pruneToasts();
      }
    });
  }

  function initUi() {
    if (state.uiReady) {
      return;
    }

    const root = document.createElement('div');
    root.id = ROOT_ID;
    document.documentElement.appendChild(root);
    const shadowRoot = root.attachShadow({ mode: 'open' });
    shadowRoot.addEventListener('click', onShadowClick);
    shadowRoot.addEventListener('input', onShadowInput);
    shadowRoot.addEventListener('change', onShadowChange);
    state.root = root;
    state.shadowRoot = shadowRoot;
    state.uiReady = true;
    scheduleRender();
  }

  function onShadowClick(event) {
    const target = event.target.closest('[data-action]');
    if (!target) {
      return;
    }

    const action = target.dataset.action;
    const value = target.dataset.value || '';

    switch (action) {
      case 'toggle-panel':
        state.panelOpen = !state.panelOpen;
        scheduleRender();
        break;
      case 'close-panel':
        state.panelOpen = false;
        state.detailRecordId = null;
        scheduleRender();
        break;
      case 'switch-tab':
        state.currentTab = value;
        state.detailRecordId = null;
        scheduleRender();
        break;
      case 'toggle-capture':
        state.capturePaused = !state.capturePaused;
        scheduleRender();
        break;
      case 'view-record':
        state.detailRecordId = value;
        scheduleRender();
        break;
      case 'close-detail':
        state.detailRecordId = null;
        scheduleRender();
        break;
      case 'save-template':
        void handleCreateTemplate(value);
        break;
      case 'replay-record':
        void handleReplayRecord(value);
        break;
      case 'toggle-template':
        toggleTemplateSelection(value);
        scheduleRender();
        break;
      case 'select-all-templates':
        toggleAllTemplates();
        scheduleRender();
        break;
      case 'check-variables':
        state.lastVariableCheckAt = Date.now();
        scheduleRender();
        break;
      case 'replay-template':
        void handleReplayTemplate(value);
        break;
      case 'replay-selected':
        void handleReplaySelectedTemplates();
        break;
      case 'copy-summary':
        void handleCopySummary(value);
        break;
      case 'toggle-report-pin':
        void handleToggleReportPin(value);
        break;
      case 'export-json':
        void exportJsonReport();
        break;
      case 'export-html':
        void exportHtmlReport();
        break;
      case 'finish-session':
        void handleFinishAndStartNewSession();
        break;
      case 'open-toast-record':
        state.panelOpen = true;
        state.currentTab = 'fails';
        state.detailRecordId = value;
        scheduleRender();
        break;
      default:
        break;
    }
  }

  function onShadowInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }

    const bind = target.dataset.bind;
    if (bind === 'search') {
      state.filters.search = target.value;
      scheduleRender();
    }
  }

  function onShadowChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) {
      return;
    }

    const bind = target.dataset.bind;
    if (bind === 'status') {
      state.filters.status = target.value;
    }
    if (bind === 'method') {
      state.filters.method = target.value;
    }
    scheduleRender();
  }

  function enqueuePayload(payload) {
    state.pendingPayloads.push(payload);
    if (state.ready) {
      void drainPayloadQueue();
    }
  }

  async function drainPayloadQueue() {
    if (!state.ready || state.queueActive) {
      return;
    }
    state.queueActive = true;
    try {
      while (state.pendingPayloads.length > 0) {
        const payload = state.pendingPayloads.shift();
        try {
          await processPayload(payload);
        } catch (error) {
          console.error('[TM API Recorder] payload processing failed', error, payload);
        }
      }
    } finally {
      state.queueActive = false;
    }
  }

  async function processPayload(payload) {
    if (!state.currentSession || state.capturePaused || !state.config.enabled) {
      return;
    }

    const normalized = normalizePayload(payload);
    const matchedRule = findMatchingRule(normalized, state.config.rules || []);
    if (!shouldCaptureRecord(normalized, matchedRule)) {
      return;
    }
    if (state.sessionRecordLimitReached) {
      return;
    }

    const classification = classifyRecord(normalized, matchedRule);
    const record = Object.assign({}, normalized, classification, {
      id: generateId('rec'),
      sessionId: state.currentSession.id,
      pageUrl: location.href,
      host: location.hostname,
      reportPinned: false,
    });

    if (
      state.currentSession.stats &&
      state.currentSession.stats.total >= state.config.capture.maxRecordsPerSession
    ) {
      state.sessionRecordLimitReached = true;
      addToast({
        title: '记录数量达到上限',
        body: `当前会话最多保存 ${state.config.capture.maxRecordsPerSession} 条记录`,
      });
      scheduleRender();
      return;
    }

    await persistRecord(record);
    if (record.classification === 'fail') {
      addFailureToast(record);
    }
    bus.emit('record:saved', record);
    scheduleRender();
  }

  function normalizePayload(payload) {
    const request = payload.request || {};
    const response = payload.response || {};
    const parsedUrl = parseUrl(request.url || response.url || location.href);
    const method = String(request.method || 'GET').toUpperCase();
    const requestHeaders = normalizeHeaders(request.headers);
    const responseHeaders = normalizeHeaders(response.headers);
    const requestContentType = request.contentType || requestHeaders['content-type'] || '';
    const responseContentType = response.contentType || responseHeaders['content-type'] || '';
    const normalizedRequestBody = normalizeBody(request.body, requestContentType, state.config.capture.maxStoredBodyChars);
    const normalizedResponseBody = normalizeBody(response.body, responseContentType, state.config.capture.maxStoredBodyChars);

    return {
      source: payload.source || 'unknown',
      method: method,
      pathname: parsedUrl.pathname,
      fullUrl: parsedUrl.fullUrl,
      query: sanitizeDeep(parsedUrl.query),
      matchKey: `${method} ${parsedUrl.pathname}`,
      requestHeaders: sanitizeHeaders(requestHeaders),
      requestBody: sanitizeDeep(normalizedRequestBody.value),
      requestBodyKind: normalizedRequestBody.kind,
      requestContentType: requestContentType,
      responseHeaders: sanitizeHeaders(responseHeaders),
      responseBody: sanitizeDeep(normalizedResponseBody.value),
      responseBodyKind: normalizedResponseBody.kind,
      responseBodyText: normalizedResponseBody.textSnippet,
      responseStatus: typeof response.status === 'number' ? response.status : 0,
      duration: Math.max(0, Number(payload.endedAt || Date.now()) - Number(payload.startedAt || Date.now())),
      capturedAt: payload.endedAt || Date.now(),
      responseStatusText: response.statusText || '',
      error: payload.error || null,
      contentType: responseContentType,
      _runtime: {
        requestHeaders: requestHeaders,
        responseHeaders: responseHeaders,
        requestBodyRaw: normalizedRequestBody.rawValue,
        responseBodyRaw: normalizedResponseBody.rawValue,
        responseBodyText: normalizedResponseBody.rawText,
      },
    };
  }

  function shouldCaptureRecord(record, matchedRule) {
    if (!state.config.enabled || state.capturePaused) {
      return false;
    }

    if (matchedRule && matchedRule.capture && matchedRule.capture.enabled === false) {
      return false;
    }

    if (record.requestHeaders[REPLAY_HEADER]) {
      return false;
    }

    if (record.pathname && STATIC_EXTENSIONS.some((ext) => record.pathname.toLowerCase().endsWith(ext))) {
      return false;
    }

    const responseType = (record.contentType || '').toLowerCase();
    if (state.config.capture.skipHtmlResponses && responseType.includes('text/html')) {
      return false;
    }

    if (matchesAnyMatcher(record, state.config.capture.exclude || [])) {
      return false;
    }

    const includes = state.config.capture.include || [];
    if (includes.length === 0) {
      return true;
    }

    return matchesAnyMatcher(record, includes);
  }

  function matchesAnyMatcher(record, matchers) {
    return matchers.some((matcher) => doesMatcherMatch(record, matcher));
  }

  function doesMatcherMatch(record, matcher) {
    if (!matcher || !matcher.pathname) {
      return false;
    }

    const pathname = record.pathname || '';
    const method = record.method || '';
    if (matcher.method && String(matcher.method).toUpperCase() !== method.toUpperCase()) {
      return false;
    }

    switch (matcher.type) {
      case 'exact':
        return pathname === matcher.pathname;
      case 'regex':
        try {
          return new RegExp(matcher.pathname).test(pathname);
        } catch (error) {
          return false;
        }
      case 'prefix':
      default:
        return pathname.startsWith(matcher.pathname);
    }
  }

  function findMatchingRule(record, rules) {
    const matched = rules
      .filter((rule) => rule && rule.enabled !== false && doesRuleMatch(record, rule))
      .sort(compareRules);
    return matched[0] || null;
  }

  function doesRuleMatch(record, rule) {
    const match = rule.match || {};
    if (match.method && String(match.method).toUpperCase() !== record.method.toUpperCase()) {
      return false;
    }
    if (match.hostname && match.hostname !== location.hostname) {
      return false;
    }
    if (match.contentType && !(record.contentType || '').includes(match.contentType)) {
      return false;
    }
    if (!match.pathname) {
      return false;
    }
    return doesMatcherMatch(record, {
      type: match.type || 'exact',
      pathname: match.pathname,
      method: match.method || '',
    });
  }

  function compareRules(left, right) {
    const leftTypeRank = getMatchTypeRank(left.match && left.match.type);
    const rightTypeRank = getMatchTypeRank(right.match && right.match.type);
    if (leftTypeRank !== rightTypeRank) {
      return leftTypeRank - rightTypeRank;
    }
    const leftPriority = Number(left.priority || 0);
    const rightPriority = Number(right.priority || 0);
    if (leftPriority !== rightPriority) {
      return rightPriority - leftPriority;
    }
    const leftPathLength = (left.match && left.match.pathname ? left.match.pathname.length : 0);
    const rightPathLength = (right.match && right.match.pathname ? right.match.pathname.length : 0);
    return rightPathLength - leftPathLength;
  }

  function getMatchTypeRank(type) {
    switch (type) {
      case 'exact':
        return 1;
      case 'prefix':
        return 2;
      case 'regex':
        return 3;
      default:
        return 9;
    }
  }

  function classifyRecord(record, matchedRule) {
    if (record.error && record.responseStatus === 0) {
      return {
        classification: 'fail',
        reason: record.error.message || 'network_error',
        evidence: ['network_error'],
        ruleId: matchedRule ? matchedRule.id : '',
      };
    }

    if (matchedRule && matchedRule.classify) {
      const failResult = evaluateConditions(matchedRule.classify.fail || [], record);
      if (failResult.matched) {
        return {
          classification: 'fail',
          reason: failResult.reason,
          evidence: failResult.evidence,
          ruleId: matchedRule.id,
        };
      }
      const successResult = evaluateConditions(matchedRule.classify.success || [], record);
      if (successResult.matched) {
        return {
          classification: 'success',
          reason: successResult.reason,
          evidence: successResult.evidence,
          ruleId: matchedRule.id,
        };
      }
      if (matchedRule.classify.unknownWhenNoRuleMatched !== false) {
        return {
          classification: 'unknown',
          reason: 'unknown:no_rule_matched',
          evidence: [],
          ruleId: matchedRule.id,
        };
      }
    }

    if (record.responseStatus < 200 || record.responseStatus >= 300) {
      return {
        classification: 'fail',
        reason: `http_status=${record.responseStatus}`,
        evidence: [`status=${record.responseStatus}`],
        ruleId: '',
      };
    }

    const body = record._runtime.responseBodyRaw;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      if (body.success === false) {
        return {
          classification: 'fail',
          reason: 'body.success=false',
          evidence: ['body.success=false'],
          ruleId: '',
        };
      }
      if (body.success === true) {
        return {
          classification: 'success',
          reason: 'body.success=true',
          evidence: ['body.success=true'],
          ruleId: '',
        };
      }
      if (Object.prototype.hasOwnProperty.call(body, 'code') && Number(body.code) === 0) {
        return {
          classification: 'success',
          reason: 'body.code=0',
          evidence: ['body.code=0'],
          ruleId: '',
        };
      }
      if (Object.prototype.hasOwnProperty.call(body, 'code') && Number(body.code) !== 0) {
        return {
          classification: 'fail',
          reason: `body.code=${body.code}`,
          evidence: [`body.code=${body.code}`],
          ruleId: '',
        };
      }
    }

    return {
      classification: 'unknown',
      reason: record.contentType.includes('json') ? 'unknown:no_default_rule_matched' : 'unknown:non_json_response',
      evidence: [],
      ruleId: '',
    };
  }

  function evaluateConditions(conditions, record) {
    if (!Array.isArray(conditions) || conditions.length === 0) {
      return { matched: false, reason: '', evidence: [] };
    }

    const evidence = [];
    for (const condition of conditions) {
      const result = evaluateCondition(condition, record);
      if (!result.matched) {
        return { matched: false, reason: '', evidence: [] };
      }
      evidence.push(result.evidence);
    }

    return {
      matched: true,
      reason: evidence[0] || 'rule_matched',
      evidence: evidence,
    };
  }

  function evaluateCondition(condition, record) {
    const op = condition.op;
    switch (op) {
      case 'statusIn':
        if (isNumberInRanges(record.responseStatus, condition.value || [])) {
          return { matched: true, evidence: `status=${record.responseStatus}` };
        }
        break;
      case 'statusNotIn':
        if (!isNumberInRanges(record.responseStatus, condition.value || [])) {
          return { matched: true, evidence: `status=${record.responseStatus}` };
        }
        break;
      case 'bodyPathExists': {
        const value = getByPath(record._runtime.responseBodyRaw, condition.path);
        if (value !== undefined) {
          return { matched: true, evidence: `body.${condition.path} exists` };
        }
        break;
      }
      case 'bodyPathEquals': {
        const value = getByPath(record._runtime.responseBodyRaw, condition.path);
        if (value === condition.value) {
          return { matched: true, evidence: `body.${condition.path}=${String(value)}` };
        }
        break;
      }
      case 'bodyPathNotEquals': {
        const value = getByPath(record._runtime.responseBodyRaw, condition.path);
        if (value !== undefined && value !== condition.value) {
          return { matched: true, evidence: `body.${condition.path}=${String(value)}` };
        }
        break;
      }
      case 'bodyPathIn': {
        const value = getByPath(record._runtime.responseBodyRaw, condition.path);
        if (Array.isArray(condition.value) && condition.value.includes(value)) {
          return { matched: true, evidence: `body.${condition.path}=${String(value)}` };
        }
        break;
      }
      case 'bodyPathNotIn': {
        const value = getByPath(record._runtime.responseBodyRaw, condition.path);
        if (value !== undefined && Array.isArray(condition.value) && !condition.value.includes(value)) {
          return { matched: true, evidence: `body.${condition.path}=${String(value)}` };
        }
        break;
      }
      case 'headerEquals': {
        const header = String(record._runtime.responseHeaders[(condition.path || '').toLowerCase()] || '');
        if (header === String(condition.value || '')) {
          return { matched: true, evidence: `header.${condition.path}=${header}` };
        }
        break;
      }
      case 'headerContains': {
        const header = String(record._runtime.responseHeaders[(condition.path || '').toLowerCase()] || '');
        if (header.includes(String(condition.value || ''))) {
          return { matched: true, evidence: `header.${condition.path} contains ${condition.value}` };
        }
        break;
      }
      case 'bodyTextContains': {
        const text = String(record._runtime.responseBodyText || '');
        if (text.includes(String(condition.value || ''))) {
          return { matched: true, evidence: `response_text contains ${condition.value}` };
        }
        break;
      }
      case 'bodyTextNotContains': {
        const text = String(record._runtime.responseBodyText || '');
        if (!text.includes(String(condition.value || ''))) {
          return { matched: true, evidence: `response_text not_contains ${condition.value}` };
        }
        break;
      }
      default:
        break;
    }
    return { matched: false, evidence: '' };
  }

  async function persistRecord(record) {
    const storedRecord = stripRuntimeFields(record);
    await state.db.put(STORE_NAMES.records, storedRecord);
    state.sessionRecords.unshift(storedRecord);

    if (!state.currentSession.stats) {
      state.currentSession.stats = { total: 0, success: 0, fail: 0, unknown: 0 };
    }
    state.currentSession.stats.total += 1;
    if (!state.currentSession.stats[storedRecord.classification]) {
      state.currentSession.stats[storedRecord.classification] = 0;
    }
    state.currentSession.stats[storedRecord.classification] += 1;
    state.currentSession.lastActivityAt = Date.now();
    await state.db.put(STORE_NAMES.sessions, state.currentSession);
    state.recentSessions = await loadRecentSessions();
  }

  async function createSession() {
    const session = {
      id: generateId('sess'),
      name: buildSessionName(),
      pageUrl: location.href,
      env: location.hostname,
      startedAt: Date.now(),
      endedAt: null,
      lastActivityAt: Date.now(),
      stats: {
        total: 0,
        success: 0,
        fail: 0,
        unknown: 0,
      },
    };
    await state.db.put(STORE_NAMES.sessions, session);
    state.sessionRecords = [];
    state.sessionRecordLimitReached = false;
    bus.emit('session:created', session);
    return session;
  }

  async function finishCurrentSession() {
    if (!state.db || !state.currentSession || state.currentSession.endedAt) {
      return;
    }
    state.currentSession.endedAt = Date.now();
    await state.db.put(STORE_NAMES.sessions, state.currentSession);
  }

  async function handleFinishAndStartNewSession() {
    const shouldContinue = window.confirm('结束当前会话并开启一个新会话？');
    if (!shouldContinue) {
      return;
    }
    await finishCurrentSession();
    state.currentSession = await createSession();
    state.detailRecordId = null;
    state.currentTab = 'current';
    state.recentSessions = await loadRecentSessions();
    scheduleRender();
  }

  async function loadRecentSessions() {
    if (!state.db) {
      return [];
    }
    const sessions = await state.db.getAll(STORE_NAMES.sessions);
    return sortByDateDesc(sessions, 'startedAt').slice(0, 8);
  }

  async function handleCreateTemplate(recordId) {
    const record = findRecordById(recordId);
    if (!record) {
      return;
    }
    if (record.classification !== 'success') {
      addToast({ title: '只能模板化成功接口', body: `${record.method} ${record.pathname}` });
      scheduleRender();
      return;
    }
    const template = buildTemplateFromRecord(record);
    const existing = state.templates.find((item) => item.matchKey === template.matchKey);
    if (existing) {
      template.id = existing.id;
      template.createdAt = existing.createdAt;
      template.sampleCount = Number(existing.sampleCount || 1) + 1;
    }
    await state.db.put(STORE_NAMES.templates, template);
    upsertTemplateInState(template);
    addToast({
      title: existing ? '模板已更新' : '模板已保存',
      body: `${template.method} ${template.pathname}`,
    });
    scheduleRender();
  }

  async function handleReplayRecord(recordId) {
    const record = findRecordById(recordId);
    if (!record) {
      return;
    }
    await handleCreateTemplate(recordId);
    const template = state.templates.find((item) => item.matchKey === record.matchKey);
    if (template) {
      await runReplay([template]);
    }
  }

  async function handleReplayTemplate(templateId) {
    const template = state.templates.find((item) => item.id === templateId);
    if (!template) {
      return;
    }
    await runReplay([template]);
  }

  async function handleReplaySelectedTemplates() {
    const templates = state.templates.filter((template) => state.selectedTemplateIds.has(template.id));
    if (templates.length === 0) {
      addToast({ title: '未选择模板', body: '请先勾选至少一条模板' });
      scheduleRender();
      return;
    }
    await runReplay(templates);
  }

  async function runReplay(templates) {
    if (!templates || templates.length === 0) {
      return;
    }

    const blockedReason = getReplayBlockedReason();
    if (blockedReason) {
      addToast({ title: '当前环境禁止回放', body: blockedReason });
      scheduleRender();
      return;
    }

    const warningCount = templates.filter((template) => template.riskLevel === 'warning').length;
    const dangerousCount = templates.filter((template) => template.riskLevel === 'danger').length;
    if (dangerousCount > 0 && !state.config.replay.allowDangerous) {
      addToast({
        title: '存在高风险模板',
        body: `danger 模板默认禁用，共 ${dangerousCount} 条`,
      });
      scheduleRender();
      return;
    }
    if ((warningCount > 0 || templates.length > 5) && state.config.replay.confirmWarning) {
      const accepted = window.confirm(
        `即将回放 ${templates.length} 条模板，warning ${warningCount} 条。继续执行？`
      );
      if (!accepted) {
        return;
      }
    }

    const report = {
      id: generateId('rpt'),
      sessionId: state.currentSession.id,
      type: templates.length === 1 ? 'single_replay' : 'batch_replay',
      startedAt: Date.now(),
      endedAt: null,
      summary: {
        total: templates.length,
        success: 0,
        fail: 0,
        skipped: 0,
      },
      items: [],
    };
    bus.emit('replay:started', report);

    for (const template of templates) {
      const item = await replayTemplate(template);
      report.items.push(item);
      if (!report.summary[item.status]) {
        report.summary[item.status] = 0;
      }
      report.summary[item.status] += 1;
      bus.emit('replay:item-finished', item);
    }

    report.endedAt = Date.now();
    await state.db.put(STORE_NAMES.replayReports, report);
    state.replayReports.unshift(report);
    state.currentTab = 'replay';
    addToast({
      title: '回放完成',
      body: `success ${report.summary.success} / fail ${report.summary.fail} / skipped ${report.summary.skipped}`,
    });
    bus.emit('replay:finished', report);
    scheduleRender();
  }

  async function replayTemplate(template) {
    const baseItem = {
      templateId: template.id,
      matchKey: template.matchKey,
      method: template.method,
      pathname: template.pathname,
      status: 'skipped',
      reason: '',
      startedAt: Date.now(),
      endedAt: 0,
    };

    if (template.allowReplay === false) {
      return finishReplayItem(baseItem, 'skipped', 'template_replay_disabled');
    }
    if (template.riskLevel === 'danger' && !state.config.replay.allowDangerous) {
      return finishReplayItem(baseItem, 'skipped', 'risk_level_danger');
    }

    const resolution = await resolveTemplateVariables(template, true);
    if (!resolution.ok) {
      return finishReplayItem(baseItem, 'skipped', resolution.reason);
    }

    try {
      const request = buildReplayRequest(template, resolution.values);
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timeoutId = controller
        ? window.setTimeout(() => controller.abort(), state.config.replay.timeoutMs)
        : null;

      const response = await originalApis.fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        credentials: 'include',
        signal: controller ? controller.signal : undefined,
        __tmApiRecorderInternalReplay: true,
      });

      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      const responseMeta = await extractFetchResponseMeta(response.clone());
      const normalized = normalizePayload({
        source: 'replay',
        startedAt: baseItem.startedAt,
        endedAt: Date.now(),
        request: {
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: request.body,
          contentType: request.headers['content-type'] || '',
        },
        response: responseMeta,
      });
      const matchedRule = findMatchingRule(normalized, state.config.rules || []);
      const classification = classifyRecord(normalized, matchedRule);
      return finishReplayItem(
        baseItem,
        classification.classification === 'unknown' ? 'fail' : classification.classification,
        classification.reason
      );
    } catch (error) {
      return finishReplayItem(baseItem, 'fail', error && error.name === 'AbortError' ? 'replay_timeout' : String(error.message || error));
    }
  }

  function finishReplayItem(item, status, reason) {
    return Object.assign({}, item, {
      status: status,
      reason: reason,
      endedAt: Date.now(),
    });
  }

  async function resolveTemplateVariables(template, allowPrompt) {
    const missing = [];
    const values = {};
    const rules = Array.isArray(template.variableRules) ? template.variableRules : [];

    for (const rule of rules) {
      let resolved = '';
      for (const extractor of rule.extractors || []) {
        resolved = resolveVariableFromExtractor(rule.name, extractor);
        if (resolved) {
          break;
        }
      }
      if (!resolved && allowPrompt) {
        resolved = requestManualVariable(rule.name);
      }
      if (!resolved && rule.required !== false) {
        missing.push(rule.name);
      } else if (resolved) {
        values[rule.name] = resolved;
      }
    }

    if (missing.length > 0) {
      return {
        ok: false,
        reason: `missing_variable:${missing.join(',')}`,
      };
    }

    return { ok: true, values: values };
  }

  function requestManualVariable(name) {
    if (state.manualVariables[name]) {
      return state.manualVariables[name];
    }
    const value = window.prompt(`请输入回放变量 ${name}`);
    if (value) {
      state.manualVariables[name] = value;
      return value;
    }
    return '';
  }

  function resolveVariableFromExtractor(variableName, extractor) {
    if (!extractor) {
      return '';
    }
    if (extractor.source === 'manual') {
      return state.manualVariables[variableName] || '';
    }

    const keys = Array.isArray(extractor.keys) ? extractor.keys : extractor.key ? [extractor.key] : [];
    for (const key of keys) {
      const value = readValueFromSource(extractor.source, key);
      if (value) {
        return value;
      }
    }
    return '';
  }

  function readValueFromSource(source, key) {
    try {
      if (source === 'cookie') {
        return parseCookies()[key] || '';
      }
      if (source === 'localStorage') {
        return window.localStorage.getItem(key) || '';
      }
      if (source === 'sessionStorage') {
        return window.sessionStorage.getItem(key) || '';
      }
    } catch (error) {
      return '';
    }
    return '';
  }

  function buildReplayRequest(template, values) {
    const headers = replacePlaceholdersInObject(cloneData(template.headers), values);
    const query = replacePlaceholdersInObject(cloneData(template.query), values);
    const body = replacePlaceholdersInObject(cloneData(template.body), values);
    const url = buildUrlFromTemplate(template.pathname, query);
    const request = {
      method: template.method,
      url: url,
      headers: normalizeHeaders(headers),
      body: undefined,
    };

    request.headers[REPLAY_HEADER] = '1';

    if (template.bodyKind === 'json' && body != null) {
      request.body = JSON.stringify(body);
      request.headers['content-type'] = request.headers['content-type'] || 'application/json';
    } else if (template.bodyKind === 'urlencoded' && body && typeof body === 'object') {
      request.body = new URLSearchParams(flattenObjectToStringRecord(body)).toString();
      request.headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    } else if (template.bodyKind === 'text' && typeof body === 'string') {
      request.body = body;
    } else if (template.bodyKind === 'empty') {
      request.body = undefined;
    }

    return request;
  }

  function buildTemplateFromRecord(record) {
    const matchedRule = findMatchingRule(record, state.config.rules || []);
    const templateConfig = matchedRule && matchedRule.template ? matchedRule.template : {};
    const dynamicFields = [];
    const headers = cloneData(record.requestHeaders);
    const query = cloneData(record.query);
    const body = cloneData(record.requestBody);
    const headerVariableMap = {
      authorization: 'token',
      token: 'token',
      'x-csrf-token': 'csrfToken',
      'csrf-token': 'csrfToken',
      csrf: 'csrfToken',
    };

    Object.keys(headers || {}).forEach((key) => {
      const variableName = headerVariableMap[key.toLowerCase()];
      if (variableName) {
        headers[key] = `{{${variableName}}}`;
        dynamicFields.push({
          location: 'header',
          path: key,
          variable: variableName,
        });
      }
    });

    if (Array.isArray(templateConfig.dynamicFields)) {
      templateConfig.dynamicFields.forEach((field) => {
        dynamicFields.push(field);
      });
    }

    const dedupedDynamicFields = dedupeDynamicFields(dynamicFields);
    const variableRules = buildVariableRules(dedupedDynamicFields);
    if (headers && typeof headers === 'object') {
      replaceDynamicFields(headers, dedupedDynamicFields.filter((field) => field.location === 'header'));
    }
    if (query && typeof query === 'object') {
      replaceDynamicFields(query, dedupedDynamicFields.filter((field) => field.location === 'query'));
    }
    if (body && typeof body === 'object') {
      replaceDynamicFields(body, dedupedDynamicFields.filter((field) => field.location === 'body'));
    }

    const existing = state.templates.find((item) => item.matchKey === record.matchKey);
    return {
      id: existing ? existing.id : generateId('tpl'),
      name: matchedRule && matchedRule.name ? matchedRule.name : record.matchKey,
      matchKey: record.matchKey,
      method: record.method,
      pathname: record.pathname,
      query: query,
      headers: headers,
      body: body,
      bodyKind: record.requestBodyKind,
      contentType: record.requestContentType,
      variableRules: variableRules,
      dynamicFields: dedupedDynamicFields,
      riskLevel: templateConfig.riskLevel || inferRiskLevel(record.method),
      allowReplay: templateConfig.allowReplay !== false,
      replayEnabled: true,
      sourceRecordId: record.id,
      createdAt: existing ? existing.createdAt : Date.now(),
      updatedAt: Date.now(),
      lastSuccessAt: record.capturedAt,
      sampleCount: existing ? Number(existing.sampleCount || 1) : 1,
    };
  }

  function buildVariableRules(dynamicFields) {
    const variableNames = Array.from(new Set((dynamicFields || []).map((item) => item.variable)));
    return variableNames.map((name) => ({
      name: name,
      required: true,
      extractors: cloneData(BUILTIN_VARIABLE_SOURCES[name] || [{ source: 'manual', keys: [name] }]),
      mask: true,
    }));
  }

  function dedupeDynamicFields(dynamicFields) {
    const seen = new Set();
    return (dynamicFields || []).filter((field) => {
      const signature = `${field.location}:${field.path}:${field.variable}`;
      if (seen.has(signature)) {
        return false;
      }
      seen.add(signature);
      return true;
    });
  }

  function replaceDynamicFields(target, dynamicFields) {
    dynamicFields.forEach((field) => {
      if (field.location && field.path) {
        setByPath(target, field.path, `{{${field.variable}}}`);
      }
    });
  }

  async function handleCopySummary(recordId) {
    const record = findRecordById(recordId);
    if (!record) {
      return;
    }
    const text = `${record.method} ${record.pathname} ${record.responseStatus} ${record.reason}`;
    const ok = await copyText(text);
    addToast({
      title: ok ? '摘要已复制' : '复制失败',
      body: text,
    });
    scheduleRender();
  }

  async function handleToggleReportPin(recordId) {
    const record = findRecordById(recordId);
    if (!record) {
      return;
    }
    record.reportPinned = !record.reportPinned;
    await state.db.put(STORE_NAMES.records, record);
    scheduleRender();
  }

  function toggleTemplateSelection(templateId) {
    if (state.selectedTemplateIds.has(templateId)) {
      state.selectedTemplateIds.delete(templateId);
    } else {
      state.selectedTemplateIds.add(templateId);
    }
  }

  function toggleAllTemplates() {
    const visibleTemplates = getVisibleTemplates();
    const everySelected = visibleTemplates.every((template) => state.selectedTemplateIds.has(template.id));
    if (everySelected) {
      visibleTemplates.forEach((template) => state.selectedTemplateIds.delete(template.id));
    } else {
      visibleTemplates.forEach((template) => state.selectedTemplateIds.add(template.id));
    }
  }

  function addFailureToast(record) {
    const dedupeKey = `${record.matchKey}:${record.reason}`;
    const existing = state.toasts.find(
      (toast) => toast.dedupeKey === dedupeKey && Date.now() - toast.createdAt < 5000
    );
    if (existing) {
      existing.count += 1;
      existing.createdAt = Date.now();
    } else {
      state.toasts.unshift({
        id: generateId('toast'),
        dedupeKey: dedupeKey,
        title: `${record.method} ${record.pathname}`,
        body: record.reason,
        recordId: record.id,
        count: 1,
        createdAt: Date.now(),
      });
      state.toasts = state.toasts.slice(0, MAX_TOAST_COUNT);
    }
    pruneToastsLater();
  }

  function addToast(toast) {
    state.toasts.unshift(
      Object.assign(
        {
          id: generateId('toast'),
          dedupeKey: `${toast.title}:${toast.body}`,
          count: 1,
          recordId: '',
        },
        toast,
        { createdAt: Date.now() }
      )
    );
    state.toasts = state.toasts.slice(0, MAX_TOAST_COUNT);
    pruneToastsLater();
  }

  function pruneToastsLater() {
    window.setTimeout(() => {
      pruneToasts();
      scheduleRender();
    }, 5200);
  }

  function pruneToasts() {
    const threshold = Date.now() - 5000;
    state.toasts = state.toasts.filter((toast) => toast.createdAt >= threshold);
  }

  function scheduleRender() {
    if (!state.uiReady || !state.shadowRoot) {
      return;
    }
    if (scheduleRender.queued) {
      return;
    }
    scheduleRender.queued = true;
    window.requestAnimationFrame(() => {
      scheduleRender.queued = false;
      renderUi();
    });
  }

  function renderUi() {
    if (!state.shadowRoot) {
      return;
    }

    const stats = state.currentSession && state.currentSession.stats
      ? state.currentSession.stats
      : { total: 0, success: 0, fail: 0, unknown: 0 };
    const replayBlockedReason = getReplayBlockedReason();

    state.shadowRoot.innerHTML = `
      <style>
        :host {
          all: initial;
        }
        *, *::before, *::after {
          box-sizing: border-box;
        }
        .tmar-shell {
          position: fixed;
          right: 16px;
          bottom: 16px;
          z-index: 2147483646;
          font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
          color: #0f172a;
        }
        .tmar-entry {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 14px;
          border-radius: 16px;
          border: 1px solid rgba(15, 23, 42, 0.12);
          background: linear-gradient(135deg, #ffffff, #edf6ff);
          box-shadow: 0 10px 28px rgba(15, 23, 42, 0.18);
          cursor: pointer;
          min-width: 166px;
        }
        .tmar-entry.warning {
          background: linear-gradient(135deg, #fff7ed, #ffe4e6);
        }
        .tmar-entry.paused,
        .tmar-entry.disabled {
          background: #e5e7eb;
          color: #475569;
        }
        .tmar-entry-title {
          font-weight: 700;
          letter-spacing: 0.02em;
        }
        .tmar-entry-meta {
          font-size: 12px;
          color: #475569;
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        .tmar-panel {
          position: absolute;
          right: 0;
          bottom: 64px;
          width: min(480px, calc(100vw - 32px));
          height: min(80vh, 860px);
          max-height: min(80vh, 860px);
          display: flex;
          flex-direction: column;
          border: 1px solid rgba(15, 23, 42, 0.14);
          border-radius: 22px;
          background: rgba(255, 255, 255, 0.98);
          box-shadow: 0 24px 60px rgba(15, 23, 42, 0.22);
          overflow: hidden;
          backdrop-filter: blur(12px);
        }
        .tmar-header {
          padding: 16px 18px 14px;
          border-bottom: 1px solid rgba(148, 163, 184, 0.22);
          background: linear-gradient(180deg, #f8fafc, #ffffff);
        }
        .tmar-header-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .tmar-brand {
          font-size: 14px;
          font-weight: 700;
        }
        .tmar-header-actions {
          display: flex;
          gap: 8px;
        }
        .tmar-chip {
          padding: 6px 10px;
          border-radius: 999px;
          border: 1px solid rgba(148, 163, 184, 0.25);
          background: #ffffff;
          font-size: 12px;
          cursor: pointer;
        }
        .tmar-chip.danger {
          border-color: rgba(239, 68, 68, 0.24);
          color: #b91c1c;
          background: #fff1f2;
        }
        .tmar-chip.active {
          color: #0f766e;
          background: #ecfeff;
          border-color: rgba(15, 118, 110, 0.26);
        }
        .tmar-session {
          margin-top: 12px;
          display: grid;
          gap: 10px;
        }
        .tmar-session-meta {
          font-size: 12px;
          color: #475569;
          display: grid;
          gap: 4px;
        }
        .tmar-stats {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 8px;
        }
        .tmar-stat {
          padding: 10px;
          border-radius: 14px;
          background: #f8fafc;
          border: 1px solid rgba(148, 163, 184, 0.18);
        }
        .tmar-stat-value {
          font-size: 18px;
          font-weight: 700;
        }
        .tmar-stat-label {
          margin-top: 4px;
          font-size: 11px;
          color: #475569;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .tmar-tabs {
          display: flex;
          gap: 6px;
          padding: 10px 14px;
          border-bottom: 1px solid rgba(148, 163, 184, 0.22);
          overflow-x: auto;
          flex: 0 0 auto;
        }
        .tmar-tab {
          padding: 8px 12px;
          border-radius: 999px;
          border: none;
          background: transparent;
          color: #475569;
          font-size: 12px;
          cursor: pointer;
          white-space: nowrap;
        }
        .tmar-tab.active {
          background: #e0f2fe;
          color: #0c4a6e;
          font-weight: 600;
        }
        .tmar-toolbar {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 110px 110px;
          gap: 8px;
          padding: 12px 14px;
          border-bottom: 1px solid rgba(148, 163, 184, 0.16);
          flex: 0 0 auto;
        }
        .tmar-input,
        .tmar-select {
          width: 100%;
          border-radius: 12px;
          border: 1px solid rgba(148, 163, 184, 0.32);
          background: #ffffff;
          font-size: 12px;
          padding: 10px 12px;
          color: #0f172a;
        }
        .tmar-body {
          position: relative;
          flex: 1 1 auto;
          min-height: 0;
          overflow: auto;
          padding: 14px;
          background: #f8fafc;
        }
        .tmar-stack {
          display: grid;
          gap: 10px;
        }
        .tmar-card {
          border-radius: 16px;
          background: #ffffff;
          border: 1px solid rgba(148, 163, 184, 0.18);
          padding: 12px;
          box-shadow: 0 6px 16px rgba(148, 163, 184, 0.08);
        }
        .tmar-record-row {
          display: grid;
          gap: 10px;
        }
        .tmar-record-head {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 10px;
        }
        .tmar-record-title {
          display: grid;
          gap: 4px;
          min-width: 0;
        }
        .tmar-path {
          font-size: 13px;
          font-weight: 600;
          word-break: break-all;
        }
        .tmar-subtle {
          font-size: 11px;
          color: #64748b;
        }
        .tmar-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }
        .tmar-button {
          border: 1px solid rgba(148, 163, 184, 0.28);
          background: #ffffff;
          color: #0f172a;
          border-radius: 10px;
          padding: 7px 10px;
          font-size: 12px;
          cursor: pointer;
        }
        .tmar-button.primary {
          background: #0f766e;
          border-color: #0f766e;
          color: #ffffff;
        }
        .tmar-button.warn {
          background: #fff7ed;
          border-color: rgba(234, 88, 12, 0.2);
          color: #9a3412;
        }
        .tmar-button[disabled] {
          cursor: not-allowed;
          opacity: 0.45;
        }
        .tmar-status {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          border-radius: 999px;
          padding: 5px 10px;
          font-size: 11px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .tmar-status.success {
          background: #ecfdf5;
          color: #047857;
        }
        .tmar-status.fail {
          background: #fff1f2;
          color: #be123c;
        }
        .tmar-status.unknown {
          background: #fefce8;
          color: #a16207;
        }
        .tmar-status.skipped {
          background: #f1f5f9;
          color: #475569;
        }
        .tmar-grid-2 {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
        }
        .tmar-kv {
          display: grid;
          gap: 4px;
          font-size: 12px;
        }
        .tmar-kv strong {
          font-size: 11px;
          color: #64748b;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .tmar-empty {
          padding: 30px 12px;
          text-align: center;
          font-size: 13px;
          color: #64748b;
          border-radius: 16px;
          border: 1px dashed rgba(148, 163, 184, 0.32);
          background: #ffffff;
        }
        .tmar-footer {
          display: flex;
          justify-content: space-between;
          gap: 10px;
          padding: 12px 14px 14px;
          border-top: 1px solid rgba(148, 163, 184, 0.18);
          background: #ffffff;
          flex: 0 0 auto;
        }
        .tmar-footer-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }
        .tmar-toast-stack {
          position: absolute;
          right: 0;
          bottom: calc(100% + 12px);
          display: grid;
          gap: 8px;
          width: min(320px, calc(100vw - 32px));
        }
        .tmar-toast {
          padding: 12px;
          border-radius: 16px;
          background: rgba(255, 255, 255, 0.98);
          border: 1px solid rgba(239, 68, 68, 0.18);
          box-shadow: 0 14px 30px rgba(15, 23, 42, 0.16);
          cursor: pointer;
        }
        .tmar-toast-title {
          font-size: 12px;
          font-weight: 700;
          color: #991b1b;
        }
        .tmar-toast-body {
          margin-top: 4px;
          font-size: 12px;
          color: #334155;
          word-break: break-word;
        }
        .tmar-detail {
          position: absolute;
          inset: 0;
          display: flex;
          flex-direction: column;
          min-height: 0;
          background: rgba(255, 255, 255, 0.98);
          backdrop-filter: blur(6px);
          padding: 14px;
          overflow: auto;
        }
        .tmar-pre {
          white-space: pre-wrap;
          word-break: break-word;
          font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
          font-size: 11px;
          line-height: 1.5;
          margin: 0;
          padding: 10px;
          border-radius: 12px;
          background: #f8fafc;
          border: 1px solid rgba(148, 163, 184, 0.18);
          max-height: 220px;
          overflow: auto;
        }
        .tmar-inline-meta {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }
        .tmar-pill {
          padding: 4px 8px;
          border-radius: 999px;
          background: #e2e8f0;
          color: #334155;
          font-size: 11px;
        }
        .tmar-divider {
          height: 1px;
          background: rgba(148, 163, 184, 0.18);
          margin: 6px 0;
        }
        .tmar-mini-list {
          display: grid;
          gap: 8px;
        }
        .tmar-mini-item {
          display: grid;
          gap: 4px;
          padding: 10px;
          border-radius: 12px;
          border: 1px solid rgba(148, 163, 184, 0.18);
          background: #ffffff;
        }
        .tmar-template-row {
          display: grid;
          grid-template-columns: 20px minmax(0, 1fr);
          gap: 10px;
          align-items: start;
        }
        .tmar-checkbox {
          margin-top: 4px;
        }
        .tmar-banner {
          margin-top: 10px;
          padding: 10px 12px;
          border-radius: 14px;
          background: #fff7ed;
          color: #9a3412;
          border: 1px solid rgba(234, 88, 12, 0.14);
          font-size: 12px;
        }
        @media (max-width: 720px) {
          .tmar-shell {
            right: 10px;
            left: 10px;
            bottom: 10px;
          }
          .tmar-panel {
            width: 100%;
            right: 0;
            bottom: 64px;
            height: min(78vh, 860px);
          }
          .tmar-toolbar {
            grid-template-columns: 1fr;
          }
          .tmar-grid-2,
          .tmar-stats {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
          .tmar-footer {
            flex-direction: column;
          }
        }
      </style>
      <div class="tmar-shell">
        ${renderToastStack()}
        <button class="tmar-entry ${getEntryStatusClass(stats)}" data-action="toggle-panel" type="button">
          <div>
            <div class="tmar-entry-title">API Recorder</div>
            <div class="tmar-entry-meta">
              <span>总 ${stats.total || 0}</span>
              <span>F ${stats.fail || 0}</span>
              <span>? ${stats.unknown || 0}</span>
            </div>
          </div>
        </button>
        ${
          state.panelOpen
            ? `
          <section class="tmar-panel">
            <header class="tmar-header">
              <div class="tmar-header-top">
                <div class="tmar-brand">API Recorder <span class="tmar-subtle">v${APP_VERSION}</span></div>
                <div class="tmar-header-actions">
                  <button class="tmar-chip ${state.capturePaused ? 'active' : ''}" data-action="toggle-capture" type="button">
                    ${state.capturePaused ? '继续采集' : '暂停采集'}
                  </button>
                  <button class="tmar-chip" data-action="close-panel" type="button">收起</button>
                </div>
              </div>
              <div class="tmar-session">
                <div class="tmar-session-meta">
                  <div>会话: ${escapeHtml(state.currentSession ? state.currentSession.name : '初始化中')}</div>
                  <div>环境: ${escapeHtml(location.hostname || 'unknown')}</div>
                  <div>状态: ${state.capturePaused ? '已暂停' : '采集中'}${replayBlockedReason ? ` / 回放受限` : ''}</div>
                </div>
                <div class="tmar-stats">
                  ${renderStatCard('成功', stats.success || 0)}
                  ${renderStatCard('失败', stats.fail || 0)}
                  ${renderStatCard('未知', stats.unknown || 0)}
                  ${renderStatCard('总数', stats.total || 0)}
                </div>
                ${replayBlockedReason ? `<div class="tmar-banner">${escapeHtml(replayBlockedReason)}</div>` : ''}
              </div>
            </header>
            <nav class="tmar-tabs">
              ${renderTab('current', '当前会话')}
              ${renderTab('success', '成功记录')}
              ${renderTab('fails', '失败记录')}
              ${renderTab('replay', '回放中心')}
              ${renderTab('report', '报告')}
            </nav>
            <div class="tmar-toolbar">
              <input class="tmar-input" data-bind="search" value="${escapeHtmlAttr(state.filters.search)}" placeholder="搜索路径、原因、规则" />
              <select class="tmar-select" data-bind="status">
                ${renderSelectOption('all', '全部状态', state.filters.status)}
                ${renderSelectOption('success', 'success', state.filters.status)}
                ${renderSelectOption('fail', 'fail', state.filters.status)}
                ${renderSelectOption('unknown', 'unknown', state.filters.status)}
              </select>
              <select class="tmar-select" data-bind="method">
                ${renderSelectOption('all', '全部方法', state.filters.method)}
                ${renderSelectOption('GET', 'GET', state.filters.method)}
                ${renderSelectOption('POST', 'POST', state.filters.method)}
                ${renderSelectOption('PUT', 'PUT', state.filters.method)}
                ${renderSelectOption('PATCH', 'PATCH', state.filters.method)}
                ${renderSelectOption('DELETE', 'DELETE', state.filters.method)}
              </select>
            </div>
            <div class="tmar-body">
              ${renderActiveTab()}
              ${renderDetailDrawer()}
            </div>
            <footer class="tmar-footer">
              <div class="tmar-footer-actions">
                <button class="tmar-button" data-action="finish-session" type="button">结束会话</button>
                <button class="tmar-button" data-action="check-variables" type="button">检查变量</button>
              </div>
              <div class="tmar-footer-actions">
                <button class="tmar-button" data-action="export-json" type="button">导出 JSON</button>
                <button class="tmar-button primary" data-action="export-html" type="button">导出 HTML</button>
              </div>
            </footer>
          </section>
        `
            : ''
        }
      </div>
    `;
  }

  function renderTab(value, label) {
    return `<button class="tmar-tab ${state.currentTab === value ? 'active' : ''}" data-action="switch-tab" data-value="${value}" type="button">${label}</button>`;
  }

  function renderStatCard(label, value) {
    return `
      <div class="tmar-stat">
        <div class="tmar-stat-value">${value}</div>
        <div class="tmar-stat-label">${label}</div>
      </div>
    `;
  }

  function renderSelectOption(value, label, selectedValue) {
    return `<option value="${value}" ${selectedValue === value ? 'selected' : ''}>${label}</option>`;
  }

  function renderToastStack() {
    if (state.toasts.length === 0) {
      return '';
    }
    return `
      <div class="tmar-toast-stack">
        ${state.toasts
          .map(
            (toast) => `
          <button class="tmar-toast" data-action="${toast.recordId ? 'open-toast-record' : 'toggle-panel'}" data-value="${toast.recordId || ''}" type="button">
            <div class="tmar-toast-title">${escapeHtml(toast.title)}${toast.count > 1 ? ` x${toast.count}` : ''}</div>
            <div class="tmar-toast-body">${escapeHtml(toast.body)}</div>
          </button>
        `
          )
          .join('')}
      </div>
    `;
  }

  function renderActiveTab() {
    switch (state.currentTab) {
      case 'current':
        return renderCurrentTab();
      case 'success':
        return renderSuccessTab();
      case 'fails':
        return renderFailTab();
      case 'replay':
        return renderReplayTab();
      case 'report':
        return renderReportTab();
      default:
        return renderCurrentTab();
    }
  }

  function renderCurrentTab() {
    const recentFailures = state.sessionRecords.filter((record) => record.classification === 'fail').slice(0, 5);
    const recentSuccesses = state.sessionRecords.filter((record) => record.classification === 'success').slice(0, 5);
    const previousSessions = state.recentSessions.filter(
      (session) => !state.currentSession || session.id !== state.currentSession.id
    );

    return `
      <div class="tmar-stack">
        <div class="tmar-card">
          <div class="tmar-grid-2">
            <div class="tmar-kv">
              <strong>开始时间</strong>
              <span>${formatDateTime(state.currentSession && state.currentSession.startedAt)}</span>
            </div>
            <div class="tmar-kv">
              <strong>最近活动</strong>
              <span>${formatDateTime(state.currentSession && state.currentSession.lastActivityAt)}</span>
            </div>
          </div>
        </div>
        <div class="tmar-card">
          <div class="tmar-kv">
            <strong>最近失败</strong>
          </div>
          ${
            recentFailures.length > 0
              ? `
            <div class="tmar-mini-list">
              ${recentFailures
                .map((record) => renderMiniRecord(record, 'view-record'))
                .join('')}
            </div>
          `
              : '<div class="tmar-empty">当前会话还没有失败记录</div>'
          }
        </div>
        <div class="tmar-card">
          <div class="tmar-kv">
            <strong>最近成功</strong>
          </div>
          ${
            recentSuccesses.length > 0
              ? `
            <div class="tmar-mini-list">
              ${recentSuccesses
                .map((record) => renderMiniRecord(record, 'save-template'))
                .join('')}
            </div>
          `
              : '<div class="tmar-empty">当前会话还没有成功记录</div>'
          }
        </div>
        <div class="tmar-card">
          <div class="tmar-kv">
            <strong>最近会话</strong>
          </div>
          ${
            previousSessions.length > 0
              ? `
            <div class="tmar-mini-list">
              ${previousSessions
                .slice(0, 4)
                .map(
                  (session) => `
                <div class="tmar-mini-item">
                  <div class="tmar-path">${escapeHtml(session.name)}</div>
                  <div class="tmar-subtle">${formatDateTime(session.startedAt)} · 总 ${session.stats ? session.stats.total || 0 : 0} / 失败 ${session.stats ? session.stats.fail || 0 : 0}</div>
                </div>
              `
                )
                .join('')}
            </div>
          `
              : '<div class="tmar-empty">暂无历史会话</div>'
          }
        </div>
      </div>
    `;
  }

  function renderMiniRecord(record, action) {
    return `
      <button class="tmar-mini-item" data-action="${action}" data-value="${record.id}" type="button">
        <div class="tmar-inline-meta">
          ${renderStatusTag(record.classification)}
          <span class="tmar-pill">${escapeHtml(record.method)}</span>
        </div>
        <div class="tmar-path">${escapeHtml(record.pathname)}</div>
        <div class="tmar-subtle">${escapeHtml(record.reason)} · ${formatDateTime(record.capturedAt)}</div>
      </button>
    `;
  }

  function renderSuccessTab() {
    const records = getVisibleRecords().filter((record) => record.classification === 'success');
    return renderRecordList(records, { allowTemplate: true, allowReplay: true });
  }

  function renderFailTab() {
    const records = getVisibleRecords().filter((record) => record.classification === 'fail');
    return renderRecordList(records, { allowTemplate: false, allowReplay: false, allowCopy: true, allowPin: true });
  }

  function renderRecordList(records, options) {
    if (records.length === 0) {
      return '<div class="tmar-empty">没有符合条件的记录</div>';
    }

    return `
      <div class="tmar-stack">
        ${records
          .slice(0, state.config.ui.maxListItems)
          .map((record) => renderRecordCard(record, options))
          .join('')}
      </div>
    `;
  }

  function renderRecordCard(record, options) {
    const templateExists = state.templates.some((template) => template.matchKey === record.matchKey);
    const replayDisabled = Boolean(getReplayBlockedReason());
    return `
      <article class="tmar-card">
        <div class="tmar-record-row">
          <div class="tmar-record-head">
            <div class="tmar-record-title">
              <div class="tmar-inline-meta">
                ${renderStatusTag(record.classification)}
                <span class="tmar-pill">${escapeHtml(record.method)}</span>
                <span class="tmar-pill">${escapeHtml(String(record.responseStatus || 0))}</span>
                ${record.ruleId ? `<span class="tmar-pill">${escapeHtml(record.ruleId)}</span>` : ''}
              </div>
              <div class="tmar-path">${escapeHtml(record.pathname)}</div>
              <div class="tmar-subtle">${escapeHtml(record.reason)} · ${formatDateTime(record.capturedAt)}</div>
            </div>
          </div>
          <div class="tmar-actions">
            <button class="tmar-button" data-action="view-record" data-value="${record.id}" type="button">详情</button>
            ${
              options.allowCopy
                ? `<button class="tmar-button" data-action="copy-summary" data-value="${record.id}" type="button">复制摘要</button>`
                : ''
            }
            ${
              options.allowPin
                ? `<button class="tmar-button ${record.reportPinned ? 'warn' : ''}" data-action="toggle-report-pin" data-value="${record.id}" type="button">${record.reportPinned ? '已关注' : '加入报告关注'}</button>`
                : ''
            }
            ${
              options.allowTemplate
                ? `<button class="tmar-button" data-action="save-template" data-value="${record.id}" type="button">${templateExists ? '更新模板' : '生成模板'}</button>`
                : ''
            }
            ${
              options.allowReplay
                ? `<button class="tmar-button primary" data-action="replay-record" data-value="${record.id}" type="button" ${replayDisabled ? 'disabled' : ''}>回放</button>`
                : ''
            }
          </div>
        </div>
      </article>
    `;
  }

  function renderReplayTab() {
    const templates = getVisibleTemplates();
    const recentReport = state.replayReports.find((report) => report.sessionId === (state.currentSession && state.currentSession.id));

    return `
      <div class="tmar-stack">
        <div class="tmar-card">
          <div class="tmar-actions">
            <button class="tmar-button" data-action="select-all-templates" type="button">全选/反选</button>
            <button class="tmar-button" data-action="check-variables" type="button">检查变量</button>
            <button class="tmar-button primary" data-action="replay-selected" type="button">批量回放</button>
          </div>
        </div>
        ${
          templates.length > 0
            ? templates.map((template) => renderTemplateCard(template)).join('')
            : '<div class="tmar-empty">还没有模板。先从成功记录里生成模板。</div>'
        }
        ${
          recentReport
            ? `
          <div class="tmar-card">
            <div class="tmar-kv">
              <strong>最近回放结果</strong>
            </div>
            <div class="tmar-mini-list">
              ${recentReport.items
                .map(
                  (item) => `
                <div class="tmar-mini-item">
                  <div class="tmar-inline-meta">
                    ${renderStatusTag(item.status)}
                    <span class="tmar-pill">${escapeHtml(item.method)}</span>
                  </div>
                  <div class="tmar-path">${escapeHtml(item.pathname)}</div>
                  <div class="tmar-subtle">${escapeHtml(item.reason)}</div>
                </div>
              `
                )
                .join('')}
            </div>
          </div>
        `
            : ''
        }
      </div>
    `;
  }

  function renderTemplateCard(template) {
    const variableCheck = getTemplateVariableStatus(template);
    const replayDisabled = Boolean(getReplayBlockedReason()) || (template.riskLevel === 'danger' && !state.config.replay.allowDangerous);
    return `
      <article class="tmar-card">
        <div class="tmar-template-row">
          <input class="tmar-checkbox" type="checkbox" ${state.selectedTemplateIds.has(template.id) ? 'checked' : ''} data-action="toggle-template" data-value="${template.id}" />
          <div class="tmar-record-row">
            <div class="tmar-record-head">
              <div class="tmar-record-title">
                <div class="tmar-inline-meta">
                  <span class="tmar-pill">${escapeHtml(template.method)}</span>
                  <span class="tmar-pill">${escapeHtml(template.riskLevel || 'warning')}</span>
                  ${renderStatusTag(variableCheck.ok ? 'success' : 'unknown', variableCheck.ok ? '变量齐全' : `缺少 ${variableCheck.missing.join(', ')}`)}
                </div>
                <div class="tmar-path">${escapeHtml(template.pathname)}</div>
                <div class="tmar-subtle">样本 ${template.sampleCount || 1} · ${formatDateTime(template.lastSuccessAt)}</div>
              </div>
            </div>
            <div class="tmar-actions">
              <button class="tmar-button primary" data-action="replay-template" data-value="${template.id}" type="button" ${replayDisabled ? 'disabled' : ''}>回放</button>
            </div>
          </div>
        </div>
      </article>
    `;
  }

  function renderReportTab() {
    const stats = state.currentSession && state.currentSession.stats
      ? state.currentSession.stats
      : { total: 0, success: 0, fail: 0, unknown: 0 };
    const failures = state.sessionRecords.filter((record) => record.classification === 'fail');
    const pinned = failures.filter((record) => record.reportPinned);
    const latestReplay = state.replayReports.find((report) => report.sessionId === (state.currentSession && state.currentSession.id));

    return `
      <div class="tmar-stack">
        <div class="tmar-card">
          <div class="tmar-grid-2">
            <div class="tmar-kv">
              <strong>会话</strong>
              <span>${escapeHtml(state.currentSession ? state.currentSession.name : '-')}</span>
            </div>
            <div class="tmar-kv">
              <strong>时间范围</strong>
              <span>${formatDateTime(state.currentSession && state.currentSession.startedAt)} - ${state.currentSession && state.currentSession.endedAt ? formatDateTime(state.currentSession.endedAt) : '进行中'}</span>
            </div>
          </div>
          <div class="tmar-divider"></div>
          <div class="tmar-inline-meta">
            <span class="tmar-pill">总 ${stats.total || 0}</span>
            <span class="tmar-pill">成功 ${stats.success || 0}</span>
            <span class="tmar-pill">失败 ${stats.fail || 0}</span>
            <span class="tmar-pill">未知 ${stats.unknown || 0}</span>
          </div>
        </div>
        <div class="tmar-card">
          <div class="tmar-kv">
            <strong>失败摘要</strong>
          </div>
          ${
            failures.length > 0
              ? `
            <div class="tmar-mini-list">
              ${(pinned.length > 0 ? pinned : failures)
                .slice(0, 8)
                .map(
                  (record) => `
                <div class="tmar-mini-item">
                  <div class="tmar-inline-meta">
                    ${renderStatusTag('fail')}
                    <span class="tmar-pill">${escapeHtml(record.method)}</span>
                    <span class="tmar-pill">${escapeHtml(String(record.responseStatus || 0))}</span>
                  </div>
                  <div class="tmar-path">${escapeHtml(record.pathname)}</div>
                  <div class="tmar-subtle">${escapeHtml(record.reason)}</div>
                </div>
              `
                )
                .join('')}
            </div>
          `
              : '<div class="tmar-empty">当前会话没有失败接口</div>'
          }
        </div>
        <div class="tmar-card">
          <div class="tmar-kv">
            <strong>回放摘要</strong>
          </div>
          ${
            latestReplay
              ? `
            <div class="tmar-inline-meta">
              <span class="tmar-pill">success ${latestReplay.summary.success || 0}</span>
              <span class="tmar-pill">fail ${latestReplay.summary.fail || 0}</span>
              <span class="tmar-pill">skipped ${latestReplay.summary.skipped || 0}</span>
            </div>
          `
              : '<div class="tmar-empty">当前会话还没有回放结果</div>'
          }
        </div>
      </div>
    `;
  }

  function renderDetailDrawer() {
    if (!state.detailRecordId) {
      return '';
    }
    const record = findRecordById(state.detailRecordId);
    if (!record) {
      return '';
    }
    const replayDisabled = Boolean(getReplayBlockedReason());
    return `
      <aside class="tmar-detail">
        <div class="tmar-actions" style="justify-content: space-between; margin-bottom: 10px;">
          <button class="tmar-button" data-action="close-detail" type="button">返回</button>
          <div class="tmar-inline-meta">
            ${renderStatusTag(record.classification)}
            <span class="tmar-pill">${escapeHtml(record.method)}</span>
          </div>
        </div>
        <div class="tmar-stack">
          <div class="tmar-card">
            <div class="tmar-path">${escapeHtml(record.pathname)}</div>
            <div class="tmar-subtle">${escapeHtml(record.reason)}</div>
            <div class="tmar-grid-2" style="margin-top: 10px;">
              <div class="tmar-kv">
                <strong>状态码</strong>
                <span>${escapeHtml(String(record.responseStatus || 0))}</span>
              </div>
              <div class="tmar-kv">
                <strong>耗时</strong>
                <span>${escapeHtml(String(record.duration || 0))} ms</span>
              </div>
            </div>
            <div class="tmar-grid-2" style="margin-top: 10px;">
              <div class="tmar-kv">
                <strong>规则</strong>
                <span>${escapeHtml(record.ruleId || '-')}</span>
              </div>
              <div class="tmar-kv">
                <strong>时间</strong>
                <span>${formatDateTime(record.capturedAt)}</span>
              </div>
            </div>
          </div>
          <div class="tmar-card">
            <div class="tmar-kv"><strong>请求头</strong></div>
            <pre class="tmar-pre">${escapeHtml(prettyJson(record.requestHeaders))}</pre>
          </div>
          <div class="tmar-card">
            <div class="tmar-kv"><strong>请求体</strong></div>
            <pre class="tmar-pre">${escapeHtml(prettyJson(record.requestBody))}</pre>
          </div>
          <div class="tmar-card">
            <div class="tmar-kv"><strong>响应头</strong></div>
            <pre class="tmar-pre">${escapeHtml(prettyJson(record.responseHeaders))}</pre>
          </div>
          <div class="tmar-card">
            <div class="tmar-kv"><strong>响应体</strong></div>
            <pre class="tmar-pre">${escapeHtml(prettyJson(record.responseBody))}</pre>
          </div>
          <div class="tmar-card">
            <div class="tmar-actions">
              <button class="tmar-button" data-action="copy-summary" data-value="${record.id}" type="button">复制摘要</button>
              ${
                record.classification === 'success'
                  ? `<button class="tmar-button" data-action="save-template" data-value="${record.id}" type="button">生成模板</button>`
                  : ''
              }
              ${
                record.classification === 'success'
                  ? `<button class="tmar-button primary" data-action="replay-record" data-value="${record.id}" type="button" ${replayDisabled ? 'disabled' : ''}>立即回放</button>`
                  : ''
              }
            </div>
          </div>
        </div>
      </aside>
    `;
  }

  function renderStatusTag(status, labelOverride) {
    const label = labelOverride || status;
    return `<span class="tmar-status ${status}">${escapeHtml(label)}</span>`;
  }

  function getVisibleRecords() {
    const search = state.filters.search.trim().toLowerCase();
    const status = state.filters.status;
    const method = state.filters.method;
    return state.sessionRecords.filter((record) => {
      if (status !== 'all' && record.classification !== status) {
        return false;
      }
      if (method !== 'all' && record.method !== method) {
        return false;
      }
      if (search) {
        const text = `${record.pathname} ${record.reason} ${record.ruleId || ''}`.toLowerCase();
        if (!text.includes(search)) {
          return false;
        }
      }
      return true;
    });
  }

  function getVisibleTemplates() {
    const search = state.filters.search.trim().toLowerCase();
    const method = state.filters.method;
    return state.templates.filter((template) => {
      if (method !== 'all' && template.method !== method) {
        return false;
      }
      if (search) {
        const text = `${template.pathname} ${template.matchKey}`.toLowerCase();
        if (!text.includes(search)) {
          return false;
        }
      }
      return true;
    });
  }

  function getTemplateVariableStatus(template) {
    const resolution = { ok: true, missing: [] };
    (template.variableRules || []).forEach((rule) => {
      let found = '';
      for (const extractor of rule.extractors || []) {
        found = resolveVariableFromExtractor(rule.name, extractor);
        if (found) {
          break;
        }
      }
      if (!found && rule.required !== false) {
        resolution.ok = false;
        resolution.missing.push(rule.name);
      }
    });
    return resolution;
  }

  function getReplayBlockedReason() {
    const blockedKeywords = state.config.replay && Array.isArray(state.config.replay.blockedHostKeywords)
      ? state.config.replay.blockedHostKeywords
      : [];
    const currentHost = String(location.hostname || '').toLowerCase();
    const hit = blockedKeywords.find((keyword) => currentHost.includes(String(keyword).toLowerCase()));
    return hit ? `当前域名包含 ${hit}，默认禁用回放` : '';
  }

  function getEntryStatusClass(stats) {
    if (!state.config.enabled) {
      return 'disabled';
    }
    if (state.capturePaused) {
      return 'paused';
    }
    if ((stats.fail || 0) > 0) {
      return 'warning';
    }
    return 'idle';
  }

  function upsertTemplateInState(template) {
    const index = state.templates.findIndex((item) => item.id === template.id);
    if (index >= 0) {
      state.templates.splice(index, 1, template);
    } else {
      state.templates.unshift(template);
    }
    state.templates = sortByDateDesc(state.templates, 'lastSuccessAt');
  }

  function findRecordById(recordId) {
    return state.sessionRecords.find((record) => record.id === recordId) || null;
  }

  async function exportJsonReport() {
    const report = buildExportReport();
    downloadTextFile(
      buildExportFilename('json'),
      JSON.stringify(report, null, 2),
      'application/json;charset=utf-8'
    );
    addToast({ title: 'JSON 报告已生成', body: buildExportFilename('json') });
    scheduleRender();
  }

  async function exportHtmlReport() {
    const report = buildExportReport();
    downloadTextFile(
      buildExportFilename('html'),
      buildHtmlReport(report),
      'text/html;charset=utf-8'
    );
    addToast({ title: 'HTML 报告已生成', body: buildExportFilename('html') });
    scheduleRender();
  }

  function buildExportReport() {
    const currentReplayReports = state.replayReports.filter(
      (report) => report.sessionId === (state.currentSession && state.currentSession.id)
    );
    return {
      generatedAt: Date.now(),
      app: {
        id: APP_ID,
        version: APP_VERSION,
      },
      session: state.currentSession,
      records: state.sessionRecords,
      templates: state.templates,
      replayReports: currentReplayReports,
      summary: Object.assign({}, state.currentSession ? state.currentSession.stats : {}),
    };
  }

  function buildHtmlReport(report) {
    const failures = (report.records || []).filter((record) => record.classification === 'fail');
    const latestReplay = (report.replayReports || [])[0];
    return `
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>API Recorder Report</title>
  <style>
    body {
      margin: 0;
      padding: 24px;
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      color: #0f172a;
      background: #f8fafc;
    }
    .wrap {
      max-width: 1100px;
      margin: 0 auto;
      display: grid;
      gap: 16px;
    }
    .card {
      border-radius: 18px;
      background: #ffffff;
      border: 1px solid rgba(148, 163, 184, 0.22);
      padding: 18px;
      box-shadow: 0 10px 30px rgba(148, 163, 184, 0.08);
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
    }
    .stat {
      padding: 14px;
      border-radius: 14px;
      background: #f8fafc;
    }
    .value {
      font-size: 22px;
      font-weight: 700;
    }
    .label {
      margin-top: 6px;
      color: #64748b;
      font-size: 12px;
      text-transform: uppercase;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      text-align: left;
      border-bottom: 1px solid rgba(148, 163, 184, 0.2);
      padding: 10px 8px;
      vertical-align: top;
      word-break: break-word;
    }
    .tag {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .fail { background: #fff1f2; color: #be123c; }
    .success { background: #ecfdf5; color: #047857; }
    .unknown { background: #fefce8; color: #a16207; }
    .skipped { background: #f1f5f9; color: #475569; }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="card">
      <h1>API Recorder Report</h1>
      <p>会话: ${escapeHtml(report.session ? report.session.name : '-')}</p>
      <p>页面: ${escapeHtml(report.session ? report.session.pageUrl : location.href)}</p>
      <p>生成时间: ${escapeHtml(formatDateTime(report.generatedAt))}</p>
    </section>
    <section class="card">
      <div class="stats">
        <div class="stat"><div class="value">${report.summary.total || 0}</div><div class="label">Total</div></div>
        <div class="stat"><div class="value">${report.summary.success || 0}</div><div class="label">Success</div></div>
        <div class="stat"><div class="value">${report.summary.fail || 0}</div><div class="label">Fail</div></div>
        <div class="stat"><div class="value">${report.summary.unknown || 0}</div><div class="label">Unknown</div></div>
      </div>
    </section>
    <section class="card">
      <h2>失败接口</h2>
      ${
        failures.length > 0
          ? `
        <table>
          <thead>
            <tr>
              <th>状态</th>
              <th>方法</th>
              <th>路径</th>
              <th>HTTP</th>
              <th>原因</th>
              <th>时间</th>
            </tr>
          </thead>
          <tbody>
            ${failures
              .map(
                (record) => `
              <tr>
                <td><span class="tag fail">fail</span></td>
                <td>${escapeHtml(record.method)}</td>
                <td>${escapeHtml(record.pathname)}</td>
                <td>${escapeHtml(String(record.responseStatus || 0))}</td>
                <td>${escapeHtml(record.reason)}</td>
                <td>${escapeHtml(formatDateTime(record.capturedAt))}</td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      `
          : '<p>当前会话没有失败接口。</p>'
      }
    </section>
    <section class="card">
      <h2>回放结果</h2>
      ${
        latestReplay
          ? `
        <table>
          <thead>
            <tr>
              <th>状态</th>
              <th>方法</th>
              <th>路径</th>
              <th>原因</th>
            </tr>
          </thead>
          <tbody>
            ${latestReplay.items
              .map(
                (item) => `
              <tr>
                <td><span class="tag ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></td>
                <td>${escapeHtml(item.method)}</td>
                <td>${escapeHtml(item.pathname)}</td>
                <td>${escapeHtml(item.reason)}</td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      `
          : '<p>当前会话还没有回放结果。</p>'
      }
    </section>
  </div>
</body>
</html>
    `;
  }

  async function loadConfig() {
    try {
      const rawValue = gmGetValue(CONFIG_STORAGE_KEY, '');
      if (!rawValue) {
        return {};
      }
      if (typeof rawValue === 'string') {
        return JSON.parse(rawValue);
      }
      return rawValue;
    } catch (error) {
      console.warn('[TM API Recorder] loadConfig failed', error);
      return {};
    }
  }

  async function openDatabase() {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAMES.sessions)) {
          const store = database.createObjectStore(STORE_NAMES.sessions, { keyPath: 'id' });
          store.createIndex('startedAt', 'startedAt', { unique: false });
        }
        if (!database.objectStoreNames.contains(STORE_NAMES.records)) {
          const store = database.createObjectStore(STORE_NAMES.records, { keyPath: 'id' });
          store.createIndex('sessionId', 'sessionId', { unique: false });
          store.createIndex('matchKey', 'matchKey', { unique: false });
          store.createIndex('classification', 'classification', { unique: false });
          store.createIndex('capturedAt', 'capturedAt', { unique: false });
        }
        if (!database.objectStoreNames.contains(STORE_NAMES.templates)) {
          const store = database.createObjectStore(STORE_NAMES.templates, { keyPath: 'id' });
          store.createIndex('matchKey', 'matchKey', { unique: false });
          store.createIndex('lastSuccessAt', 'lastSuccessAt', { unique: false });
        }
        if (!database.objectStoreNames.contains(STORE_NAMES.replayReports)) {
          const store = database.createObjectStore(STORE_NAMES.replayReports, { keyPath: 'id' });
          store.createIndex('sessionId', 'sessionId', { unique: false });
          store.createIndex('startedAt', 'startedAt', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
    });

    function withStore(storeName, mode, callback) {
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        const request = callback(store);
        transaction.oncomplete = () => resolve(request && request.result !== undefined ? request.result : undefined);
        transaction.onerror = () => reject(transaction.error || (request && request.error));
      });
    }

    return {
      put(storeName, value) {
        return withStore(storeName, 'readwrite', (store) => store.put(value));
      },
      get(storeName, key) {
        return withStore(storeName, 'readonly', (store) => store.get(key));
      },
      getAll(storeName) {
        return withStore(storeName, 'readonly', (store) => store.getAll());
      },
      getAllByIndex(storeName, indexName, value) {
        return withStore(storeName, 'readonly', (store) =>
          store.index(indexName).getAll(IDBKeyRange.only(value))
        );
      },
    };
  }

  function extractFetchRequestMeta(input, init) {
    return (async () => {
      let url = '';
      let method = 'GET';
      let headers = {};
      let body = null;

      if (typeof Request !== 'undefined' && input instanceof Request) {
        url = input.url;
        method = input.method || method;
        headers = normalizeHeaders(input.headers);
        try {
          const clonedRequest = input.clone();
          body = await readRequestBody(clonedRequest);
        } catch (error) {
          body = null;
        }
      } else {
        url = String(input || '');
      }

      if (init) {
        if (init.method) {
          method = String(init.method).toUpperCase();
        }
        if (init.headers) {
          headers = Object.assign({}, headers, normalizeHeaders(init.headers));
        }
        if (init.body !== undefined) {
          body = init.body;
        }
      }

      return {
        method: method,
        url: url,
        headers: headers,
        body: body,
        contentType: headers['content-type'] || '',
      };
    })();
  }

  async function extractFetchResponseMeta(response) {
    const headers = normalizeHeaders(response.headers);
    const contentType = headers['content-type'] || '';
    return {
      status: Number(response.status) || 0,
      statusText: response.statusText || '',
      headers: headers,
      body: await readResponseBody(response, contentType),
      contentType: contentType,
      url: response.url || '',
    };
  }

  function extractXhrResponseBody(xhr) {
    try {
      if (xhr.responseType === 'json') {
        return xhr.response;
      }
      if (xhr.responseType === '' || xhr.responseType === 'text') {
        return xhr.responseText;
      }
      return `[${xhr.responseType || 'binary'} response omitted]`;
    } catch (error) {
      return null;
    }
  }

  function getXhrContentType(xhr) {
    try {
      return xhr.getResponseHeader('content-type') || '';
    } catch (error) {
      return '';
    }
  }

  async function readRequestBody(request) {
    try {
      const contentType = request.headers.get('content-type') || '';
      if (contentType.includes('application/json') || contentType.includes('text/') || !contentType) {
        return await request.text();
      }
      if (contentType.includes('application/x-www-form-urlencoded')) {
        return await request.text();
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  async function readResponseBody(response, contentType) {
    try {
      if (contentType.includes('application/json') || contentType.includes('text/') || !contentType) {
        return await response.text();
      }
      return `[${contentType || 'binary'} response omitted]`;
    } catch (error) {
      return null;
    }
  }

  function normalizeBody(body, contentType, maxChars) {
    if (body === null || body === undefined || body === '') {
      return {
        kind: 'empty',
        value: null,
        rawValue: null,
        rawText: '',
        textSnippet: '',
      };
    }

    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const entries = {};
      body.forEach((value, key) => {
        entries[key] = typeof value === 'string' ? value : `[blob:${value.name || 'file'}]`;
      });
      return {
        kind: 'form-data',
        value: truncateDeep(entries, maxChars),
        rawValue: entries,
        rawText: JSON.stringify(entries),
        textSnippet: truncateText(JSON.stringify(entries), maxChars),
      };
    }

    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      const values = {};
      body.forEach((value, key) => {
        values[key] = value;
      });
      return {
        kind: 'urlencoded',
        value: values,
        rawValue: values,
        rawText: body.toString(),
        textSnippet: truncateText(body.toString(), maxChars),
      };
    }

    if (typeof body === 'string') {
      const trimmed = body.trim();
      const parsedJson = tryParseJson(trimmed);
      if (contentType.includes('application/x-www-form-urlencoded')) {
        const params = new URLSearchParams(body);
        const values = {};
        params.forEach((value, key) => {
          values[key] = value;
        });
        return {
          kind: 'urlencoded',
          value: values,
          rawValue: values,
          rawText: body,
          textSnippet: truncateText(body, maxChars),
        };
      }
      if (parsedJson.ok) {
        return {
          kind: 'json',
          value: truncateDeep(parsedJson.value, maxChars),
          rawValue: parsedJson.value,
          rawText: trimmed,
          textSnippet: truncateText(trimmed, maxChars),
        };
      }
      return {
        kind: 'text',
        value: truncateText(body, maxChars),
        rawValue: body,
        rawText: body,
        textSnippet: truncateText(body, maxChars),
      };
    }

    if (typeof body === 'object') {
      return {
        kind: 'json',
        value: truncateDeep(body, maxChars),
        rawValue: body,
        rawText: JSON.stringify(body),
        textSnippet: truncateText(JSON.stringify(body), maxChars),
      };
    }

    return {
      kind: 'text',
      value: truncateText(String(body), maxChars),
      rawValue: String(body),
      rawText: String(body),
      textSnippet: truncateText(String(body), maxChars),
    };
  }

  function normalizeHeaders(headers) {
    const output = {};
    if (!headers) {
      return output;
    }
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
      headers.forEach((value, key) => {
        output[key.toLowerCase()] = String(value);
      });
      return output;
    }
    if (Array.isArray(headers)) {
      headers.forEach((pair) => {
        if (Array.isArray(pair) && pair.length >= 2) {
          output[String(pair[0]).toLowerCase()] = String(pair[1]);
        }
      });
      return output;
    }
    Object.keys(headers).forEach((key) => {
      output[String(key).toLowerCase()] = String(headers[key]);
    });
    return output;
  }

  function parseRawResponseHeaders(raw) {
    const headers = {};
    if (!raw) {
      return headers;
    }
    raw.trim().split(/[\r\n]+/).forEach((line) => {
      const index = line.indexOf(':');
      if (index > -1) {
        const key = line.slice(0, index).trim().toLowerCase();
        const value = line.slice(index + 1).trim();
        headers[key] = value;
      }
    });
    return headers;
  }

  function parseUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      const query = {};
      url.searchParams.forEach((value, key) => {
        if (Object.prototype.hasOwnProperty.call(query, key)) {
          if (!Array.isArray(query[key])) {
            query[key] = [query[key]];
          }
          query[key].push(value);
        } else {
          query[key] = value;
        }
      });
      return {
        fullUrl: url.toString(),
        pathname: url.pathname,
        query: query,
      };
    } catch (error) {
      return {
        fullUrl: String(rawUrl || ''),
        pathname: String(rawUrl || ''),
        query: {},
      };
    }
  }

  function parseCookies() {
    const output = {};
    document.cookie.split(';').forEach((entry) => {
      const trimmed = entry.trim();
      if (!trimmed) {
        return;
      }
      const separator = trimmed.indexOf('=');
      if (separator < 0) {
        output[trimmed] = '';
        return;
      }
      const key = trimmed.slice(0, separator);
      const value = trimmed.slice(separator + 1);
      output[key] = value;
    });
    return output;
  }

  function sanitizeHeaders(headers) {
    const output = {};
    Object.keys(headers || {}).forEach((key) => {
      output[key] = shouldMaskKey(key) ? maskValue(headers[key]) : headers[key];
    });
    return output;
  }

  function sanitizeDeep(value, keyName) {
    if (value === null || value === undefined) {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeDeep(item, keyName));
    }
    if (typeof value === 'object') {
      const output = {};
      Object.keys(value).forEach((key) => {
        if (shouldMaskKey(key)) {
          output[key] = maskValue(value[key]);
        } else {
          output[key] = sanitizeDeep(value[key], key);
        }
      });
      return output;
    }
    if (shouldMaskKey(keyName || '')) {
      return maskValue(value);
    }
    return value;
  }

  function shouldMaskKey(key) {
    return SENSITIVE_KEYS.has(String(key || '').toLowerCase());
  }

  function maskValue(value) {
    const text = String(value == null ? '' : value);
    if (text.length <= 8) {
      return '****';
    }
    return `${text.slice(0, 2)}****${text.slice(-2)}`;
  }

  function truncateText(text, maxChars) {
    if (!text || text.length <= maxChars) {
      return text;
    }
    return `${text.slice(0, maxChars)} ...[truncated ${text.length - maxChars} chars]`;
  }

  function truncateDeep(value, maxChars) {
    if (value === null || value === undefined) {
      return value;
    }
    try {
      const text = JSON.stringify(value);
      if (text.length <= maxChars) {
        return value;
      }
      if (typeof value === 'string') {
        return truncateText(value, maxChars);
      }
      return truncateText(text, maxChars);
    } catch (error) {
      return String(value);
    }
  }

  function tryParseJson(text) {
    if (!text) {
      return { ok: false, value: null };
    }
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (error) {
      return { ok: false, value: null };
    }
  }

  function getByPath(target, path) {
    if (!target || typeof target !== 'object' || !path) {
      return undefined;
    }
    return String(path)
      .split('.')
      .reduce((accumulator, segment) => {
        if (accumulator && typeof accumulator === 'object' && segment in accumulator) {
          return accumulator[segment];
        }
        return undefined;
      }, target);
  }

  function setByPath(target, path, value) {
    if (!target || typeof target !== 'object' || !path) {
      return;
    }
    const segments = String(path).split('.');
    let current = target;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];
      if (!current[segment] || typeof current[segment] !== 'object') {
        current[segment] = {};
      }
      current = current[segment];
    }
    current[segments[segments.length - 1]] = value;
  }

  function replacePlaceholdersInObject(target, values) {
    if (target === null || target === undefined) {
      return target;
    }
    if (typeof target === 'string') {
      return target.replace(/\{\{([^}]+)\}\}/g, (_, name) => values[name] || '');
    }
    if (Array.isArray(target)) {
      return target.map((item) => replacePlaceholdersInObject(item, values));
    }
    if (typeof target === 'object') {
      Object.keys(target).forEach((key) => {
        target[key] = replacePlaceholdersInObject(target[key], values);
      });
    }
    return target;
  }

  function buildUrlFromTemplate(pathname, query) {
    const url = new URL(pathname, location.origin);
    Object.keys(query || {}).forEach((key) => {
      const value = query[key];
      if (Array.isArray(value)) {
        value.forEach((entry) => url.searchParams.append(key, entry));
      } else if (value !== null && value !== undefined && value !== '') {
        url.searchParams.set(key, value);
      }
    });
    return url.toString();
  }

  function flattenObjectToStringRecord(value) {
    const output = {};
    Object.keys(value || {}).forEach((key) => {
      output[key] = String(value[key]);
    });
    return output;
  }

  function inferRiskLevel(method) {
    switch (String(method || '').toUpperCase()) {
      case 'GET':
      case 'HEAD':
      case 'OPTIONS':
        return 'safe';
      case 'DELETE':
        return 'danger';
      default:
        return 'warning';
    }
  }

  function isNumberInRanges(value, ranges) {
    return ranges.some((range) => {
      if (!Array.isArray(range) || range.length < 2) {
        return false;
      }
      return value >= Number(range[0]) && value <= Number(range[1]);
    });
  }

  function waitForDomReady() {
    if (document.readyState === 'interactive' || document.readyState === 'complete') {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
    });
  }

  function createEventBus() {
    const listeners = new Map();
    return {
      on(eventName, handler) {
        if (!listeners.has(eventName)) {
          listeners.set(eventName, new Set());
        }
        listeners.get(eventName).add(handler);
        return () => listeners.get(eventName).delete(handler);
      },
      emit(eventName, payload) {
        const handlers = listeners.get(eventName);
        if (!handlers) {
          return;
        }
        handlers.forEach((handler) => {
          try {
            handler(payload);
          } catch (error) {
            console.error('[TM API Recorder] event handler failed', eventName, error);
          }
        });
      },
    };
  }

  function mergeConfig(base, override) {
    if (!override || typeof override !== 'object') {
      return base;
    }
    Object.keys(override).forEach((key) => {
      if (Array.isArray(override[key])) {
        base[key] = override[key];
      } else if (override[key] && typeof override[key] === 'object') {
        base[key] = mergeConfig(base[key] ? cloneData(base[key]) : {}, override[key]);
      } else {
        base[key] = override[key];
      }
    });
    return base;
  }

  function cloneDefaultConfig() {
    return cloneData(DEFAULT_CONFIG);
  }

  function cloneData(value) {
    if (typeof structuredClone === 'function') {
      try {
        return structuredClone(value);
      } catch (error) {
        return JSON.parse(JSON.stringify(value));
      }
    }
    return JSON.parse(JSON.stringify(value));
  }

  function stripRuntimeFields(record) {
    const copy = Object.assign({}, record);
    delete copy._runtime;
    return copy;
  }

  function serializeError(error) {
    if (!error) {
      return null;
    }
    return {
      name: error.name || 'Error',
      message: error.message || String(error),
    };
  }

  function generateId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function buildSessionName() {
    const pagePath = location.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
    const suffix = pagePath || 'root';
    const time = new Date();
    const timePart = `${padNumber(time.getHours())}:${padNumber(time.getMinutes())}`;
    return `${suffix} ${timePart}`;
  }

  function sortByDateDesc(items, key) {
    return (items || []).slice().sort((left, right) => Number(right[key] || 0) - Number(left[key] || 0));
  }

  function padNumber(value) {
    return String(value).padStart(2, '0');
  }

  function formatDateTime(timestamp) {
    if (!timestamp) {
      return '-';
    }
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())} ${padNumber(date.getHours())}:${padNumber(date.getMinutes())}:${padNumber(date.getSeconds())}`;
  }

  function prettyJson(value) {
    if (value === null || value === undefined) {
      return 'null';
    }
    if (typeof value === 'string') {
      return value;
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch (error) {
      return String(value);
    }
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeHtmlAttr(value) {
    return escapeHtml(value);
  }

  function gmGetValue(key, defaultValue) {
    if (typeof GM_getValue === 'function') {
      return GM_getValue(key, defaultValue);
    }
    try {
      const stored = window.localStorage.getItem(key);
      return stored == null ? defaultValue : stored;
    } catch (error) {
      return defaultValue;
    }
  }

  function gmSetValue(key, value) {
    if (typeof GM_setValue === 'function') {
      return GM_setValue(key, value);
    }
    try {
      window.localStorage.setItem(key, value);
    } catch (error) {
      return undefined;
    }
    return undefined;
  }

  function buildExportFilename(extension) {
    const sessionId = state.currentSession ? state.currentSession.id : 'session';
    const timestamp = new Date();
    const stamp = `${timestamp.getFullYear()}${padNumber(timestamp.getMonth() + 1)}${padNumber(timestamp.getDate())}_${padNumber(timestamp.getHours())}${padNumber(timestamp.getMinutes())}${padNumber(timestamp.getSeconds())}`;
    return `api-recorder-${sessionId}-${stamp}.${extension}`;
  }

  function downloadTextFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.documentElement.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (error) {
      return fallbackCopyText(text);
    }
    return fallbackCopyText(text);
  }

  function fallbackCopyText(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    let success = false;
    try {
      success = document.execCommand('copy');
    } catch (error) {
      success = false;
    }
    textarea.remove();
    return success;
  }

  bus.on('record:saved', () => {
    if (state.panelOpen) {
      scheduleRender();
    }
  });

  bus.on('toast:show', () => {
    scheduleRender();
  });

  window.__TM_API_RECORDER__ = {
    version: APP_VERSION,
    getConfig() {
      return cloneData(state.config);
    },
    async setConfig(nextConfig) {
      state.config = mergeConfig(cloneDefaultConfig(), nextConfig || {});
      gmSetValue(CONFIG_STORAGE_KEY, JSON.stringify(state.config));
      scheduleRender();
    },
    getState() {
      return {
        currentSession: state.currentSession,
        records: state.sessionRecords,
        templates: state.templates,
        replayReports: state.replayReports,
      };
    },
  };
})();
