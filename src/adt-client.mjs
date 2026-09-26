/**
 * ADT client.
 *
 * Talks to the REST API of the ABAP Development Tools. This layer knows no
 * rules; it only handles what ADT requires over HTTP: basic auth, session
 * cookies, CSRF tokens and an optional stateful session for locks.
 *
 * Deliberate restriction: every request outside /sap/bc/adt is refused, as a
 * second line of defence behind the policy engine.
 */

import { config, baseUrl } from './config.mjs';

export class AdtError extends Error {
  constructor(message, { status = 0, url = '', body = '' } = {}) {
    super(message);
    this.name = 'AdtError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export class AdtClient {
  constructor(options = {}) {
    this.host = options.host ?? config.sap.host;
    this.port = options.port ?? config.sap.port;
    this.protocol = options.protocol ?? config.sap.protocol;
    this.client = options.client ?? config.sap.client;
    this.user = options.user ?? config.sap.user;
    this.password = options.password ?? config.sap.password;
    this.language = options.language ?? config.sap.language;
    this.timeoutMs = options.timeoutMs ?? config.http.timeoutMs;

    /** Cookie jar: name -> value. ADT needs the session across all calls. */
    this.cookies = new Map();
    this.csrfToken = null;
    /** Request counters for diagnostics. */
    this.stats = { requests: 0, failures: 0 };
  }

  get base() {
    return `${this.protocol}://${this.host}:${this.port}`;
  }

  get authHeader() {
    return `Basic ${Buffer.from(`${this.user}:${this.password}`, 'binary').toString('base64')}`;
  }

  // -- Cookies ---------------------------------------------------------------
  storeCookies(response) {
    const raw = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [];
    for (const entry of raw) {
      const [pair] = entry.split(';');
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
  }

  get cookieHeader() {
    if (!this.cookies.size) return null;
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  // -- Path guard ------------------------------------------------------------
  /** Builds the full URL and refuses anything outside /sap/bc/adt. */
  buildUrl(pathOrUrl, query = {}) {
    let p = String(pathOrUrl);
    if (p.startsWith('http://') || p.startsWith('https://')) {
      const u = new URL(p);
      if (`${u.protocol}//${u.host}` !== this.base) {
        throw new AdtError(`Refused foreign host: ${u.host}`, { url: p });
      }
      p = u.pathname + u.search;
    }
    if (!p.startsWith('/')) p = `/${p}`;

    const url = new URL(this.base + p);
    // URL normalization prevents bypasses via ../
    if (!url.pathname.startsWith(config.http.basePath)) {
      throw new AdtError(
        `Refused request outside ${config.http.basePath}: ${url.pathname}`,
        { url: url.pathname },
      );
    }
    if (this.client && !url.searchParams.has('sap-client')) {
      url.searchParams.set('sap-client', this.client);
    }
    if (this.language && !url.searchParams.has('sap-language')) {
      url.searchParams.set('sap-language', this.language);
    }
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    return url;
  }

  // -- Core ------------------------------------------------------------------
  /**
   * Sends a request to ADT.
   * Returns { status, headers, text, url }; throws on HTTP >= 400.
   */
  async request(method, pathOrUrl, {
    query = {},
    headers = {},
    body = null,
    accept = 'application/xml',
    contentType = null,
    stateful = false,
    csrf = false,
    expectStatus = null,
  } = {}) {
    const url = this.buildUrl(pathOrUrl, query);

    const finalHeaders = {
      Authorization: this.authHeader,
      Accept: accept,
      'User-Agent': 'sap-mcp-server/0.3',
      ...headers,
    };
    if (contentType) finalHeaders['Content-Type'] = contentType;
    if (stateful) finalHeaders['X-sap-adt-sessiontype'] = 'stateful';
    const cookie = this.cookieHeader;
    if (cookie) finalHeaders.Cookie = cookie;

    if (csrf === 'fetch') {
      finalHeaders['X-CSRF-Token'] = 'Fetch';
    } else if (csrf && this.csrfToken) {
      finalHeaders['X-CSRF-Token'] = this.csrfToken;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    this.stats.requests++;

    let response;
    try {
      response = await fetch(url, {
        method,
        headers: finalHeaders,
        body,
        signal: controller.signal,
        redirect: 'manual',
      });
    } catch (err) {
      this.stats.failures++;
      const reason = err.name === 'AbortError'
        ? `timeout after ${this.timeoutMs} ms`
        : err.message;
      throw new AdtError(`Connection to ${this.base} failed: ${reason}`, { url: url.pathname });
    } finally {
      clearTimeout(timer);
    }

    this.storeCookies(response);
    const token = response.headers.get('x-csrf-token');
    if (token && token.toLowerCase() !== 'required') this.csrfToken = token;

    const text = await response.text();

    if (expectStatus ? response.status !== expectStatus : !response.ok) {
      this.stats.failures++;
      throw new AdtError(
        `${method} ${url.pathname} → HTTP ${response.status} ${response.statusText}`,
        { status: response.status, url: url.pathname, body: text.slice(0, 1500) },
      );
    }

    return { status: response.status, headers: response.headers, text, url: url.toString() };
  }

  get(pathOrUrl, options = {}) { return this.request('GET', pathOrUrl, options); }
  post(pathOrUrl, options = {}) { return this.request('POST', pathOrUrl, { csrf: true, ...options }); }
  put(pathOrUrl, options = {}) { return this.request('PUT', pathOrUrl, { csrf: true, ...options }); }

  // -- Login -----------------------------------------------------------------
  /**
   * Fetches the session cookie and CSRF token via the discovery endpoint.
   * Must run before any write operation.
   */
  async connect() {
    const res = await this.get('/sap/bc/adt/discovery', {
      accept: 'application/atomsvc+xml',
      csrf: 'fetch',
    });
    const collections = [...res.text.matchAll(/<app:collection[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    return {
      ok: true,
      csrfToken: Boolean(this.csrfToken),
      cookies: [...this.cookies.keys()],
      collections: collections.length,
      sampleCollections: collections.slice(0, 8),
    };
  }

  // -- Read operations -------------------------------------------------------
  /** Repository quick search, e.g. query "Z*". */
  async searchObjects(query, { maxResults = 20 } = {}) {
    const res = await this.get('/sap/bc/adt/repository/informationsystem/search', {
      query: { operation: 'quickSearch', query, maxResults },
    });
    const objects = [...res.text.matchAll(/<adtcore:objectReference\b[^>]*\/?>/g)].map((m) => {
      const tag = m[0];
      const attr = (name) => {
        const hit = new RegExp(`${name}="([^"]*)"`).exec(tag);
        return hit ? hit[1] : null;
      };
      return {
        name: attr('adtcore:name'),
        type: attr('adtcore:type'),
        packageName: attr('adtcore:packageName'),
        description: attr('adtcore:description'),
        uri: attr('adtcore:uri'),
      };
    });
    return objects;
  }

  /** Source code of an object via its ADT URI. */
  async getSource(uri) {
    const path = uri.endsWith('/source/main') ? uri : `${uri}/source/main`;
    const res = await this.get(path, { accept: 'text/plain' });
    return res.text;
  }

  /** Raw GET for diagnostics. */
  async raw(path, { accept = 'application/xml' } = {}) {
    const res = await this.get(path, { accept });
    return { status: res.status, body: res.text };
  }

  // -- Write operations ------------------------------------------------------
  // This layer does not enforce rules; it executes what the policy engine has
  // allowed. The split is deliberate: the client knows the protocol, the
  // policy knows the rules.

  /**
   * Locks an object for modification. ADT requires a stateful session for
   * this, kept alive through this client's session cookie.
   * @returns {{handle: string, transport: string}}
   */
  async lock(uri) {
    const res = await this.request('POST', uri, {
      query: { _action: 'LOCK', accessMode: 'MODIFY' },
      accept: 'application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.Result',
      stateful: true,
      csrf: true,
    });
    const handle = /<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/.exec(res.text)?.[1] ?? null;
    if (!handle) throw new AdtError('Lock returned without a handle.', { url: uri, body: res.text.slice(0, 400) });
    return { handle, transport: /<CORRNR>([^<]*)<\/CORRNR>/.exec(res.text)?.[1] ?? '' };
  }

  /** Releases a lock. Always call this in a finally block. */
  async unlock(uri, handle) {
    await this.request('POST', uri, {
      query: { _action: 'UNLOCK', lockHandle: handle },
      accept: '*/*',
      stateful: true,
      csrf: true,
    });
  }

  /** Writes the source code of an object. Requires a held lock. */
  async setSource(uri, source, { lockHandle, corrNr = null } = {}) {
    if (!lockHandle) throw new AdtError('setSource called without a lock handle.', { url: uri });
    const sourcePath = uri.endsWith('/source/main') ? uri : `${uri}/source/main`;
    const query = { lockHandle };
    if (corrNr) query.corrNr = corrNr;
    const res = await this.request('PUT', sourcePath, {
      query,
      body: source,
      contentType: 'text/plain; charset=utf-8',
      accept: '*/*',
      stateful: true,
      csrf: true,
    });
    return res.status;
  }

  /** Activates an object and returns the activation messages. */
  async activate(name, uri) {
    const body = '<?xml version="1.0" encoding="UTF-8"?>'
      + '<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">'
      + `<adtcore:objectReference adtcore:uri="${uri}" adtcore:name="${name.toUpperCase()}"/>`
      + '</adtcore:objectReferences>';
    const res = await this.request('POST', '/sap/bc/adt/activation', {
      query: { method: 'activate', preauditRequests: 'false' },
      body,
      contentType: 'application/xml',
      accept: 'application/xml',
      csrf: true,
    });
    const messages = [...res.text.matchAll(/<msg\b[^>]*>([\s\S]*?)<\/msg>/g)]
      .map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    const failed = /severity="(E|A)"/.test(res.text) || (/<chkl:messages/.test(res.text) && messages.length > 0);
    return { status: res.status, messages, failed: failed && messages.length > 0 };
  }

  /**
   * Creates a workbench transport request.
   * @returns {string} the request number
   */
  async createTransportRequest({ packageName, description }) {
    const body = '<?xml version="1.0" encoding="UTF-8"?>'
      + '<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>'
      + '<OPERATION>I</OPERATION>'
      + `<DEVCLASS>${packageName}</DEVCLASS>`
      + `<REQUEST_TEXT>${description}</REQUEST_TEXT>`
      + '</DATA></asx:values></asx:abap>';
    const res = await this.request('POST', '/sap/bc/adt/cts/transports', {
      body,
      contentType: 'application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.CreateCorrectionRequest',
      accept: 'text/plain',
      csrf: true,
    });
    const number = (/([A-Z0-9]{3}K9\d{5})/.exec(res.text) ?? [])[1] ?? res.text.trim();
    if (!number) throw new AdtError('Transport request returned without a number.', { body: res.text.slice(0, 300) });
    return number;
  }

  /** Creates an ABAP class. */
  async createClass({ name, description, packageName, corrNr = null }) {
    const body = '<?xml version="1.0" encoding="UTF-8"?>'
      + '<class:abapClass xmlns:class="http://www.sap.com/adt/oo/classes"'
      + ' xmlns:adtcore="http://www.sap.com/adt/core"'
      + ` adtcore:name="${name.toUpperCase()}" adtcore:type="CLAS/OC"`
      + ` adtcore:description="${description}" adtcore:masterLanguage="${this.language}"`
      + ' class:final="true" class:visibility="public">'
      + `<adtcore:packageRef adtcore:name="${packageName.toUpperCase()}"/>`
      + '</class:abapClass>';
    const query = {};
    if (corrNr) query.corrNr = corrNr;
    const res = await this.request('POST', '/sap/bc/adt/oo/classes', {
      query,
      body,
      contentType: 'application/vnd.sap.adt.oo.classes.v2+xml',
      accept: 'application/vnd.sap.adt.oo.classes.v2+xml',
      csrf: true,
    });
    return { status: res.status, uri: `/sap/bc/adt/oo/classes/${name.toLowerCase()}` };
  }
}
