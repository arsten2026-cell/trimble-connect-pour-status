// Minimal client for Trimble Connect's Property Set service (pset-api) and Organizer (org-api), following what
// Connect web itself does (its webcomponents bundle, 2026-11):
//  - project libraries are listed as links "frn:lib:{libId}" on Organizer node
//    forests/project:{projectId}:data / trees/ProjectContext / nodes/PSetLibs
//  - definitions: GET/POST/PATCH libs/{lib}/defs[/{def}]
//  - values ("psets") on a model object: link frn:entity:{IFC GUID}; PATCH psets/{link}/{lib}/{def} {props}
//  - many at once: POST batch-get {psets:[{link, libId, defId}]}
(function (root) {
  "use strict";
  const REGIONS = {
    europe: "eu-west-1", eu: "eu-west-1", uk: "eu-west-2", northamerica: "us-east-1", us: "us-east-1",
    asia: "ap-southeast-1", australia: "ap-southeast-2",
  };
  const hostFor = (svc, region) => (region === "master" ? `https://${svc}-api.connect.trimble.com/v1/` : `https://${svc}-api.${region}.connect.trimble.com/v1/`);

  const psetPath = (link, libId, defId) => `psets/${encodeURIComponent(link)}/${encodeURIComponent(libId)}/${encodeURIComponent(defId)}`;
  /** Drop empty values: the service has no "empty" for typed fields; leaving a field out means "no value". */
  const clean = (props) => Object.fromEntries(Object.entries(props || {}).filter(([, v]) => v !== null && v !== undefined && v !== ""));

  /** i18n of a definition after adding fields: what is already in Connect (edited by hand) wins - names, labels and
   *  the order of existing fields; only the labels of new fields are added, and "__prop-order__" puts them at the end. */
  function mergeI18n(cur, want, missing) {
    if (!cur) return want;
    const out = Object.assign({}, cur);
    for (const [loc, w] of Object.entries(want || {})) {
      const c = cur[loc];
      if (!c) { out[loc] = w; continue; }
      const props = Object.assign({}, c.props || {});
      if (loc === "__prop-order__") {
        let next = Math.max(-1, ...Object.values(props).map(Number).filter((n) => Number.isFinite(n))) + 1;
        const add = missing.filter((k) => !(k in props)).sort((a, b) => Number((w.props || {})[a]) - Number((w.props || {})[b]));
        for (const k of add) props[k] = String(next++);
      } else for (const k of missing) if (!(k in props) && w.props && k in w.props) props[k] = w.props[k];
      out[loc] = Object.assign({}, w, c, { props });
    }
    return out;
  }
  /** PATCH body that adds only the missing fields to an existing definition (M12): existing field types, name,
   *  description and i18n stay as they are in Connect. */
  function extendBody(cur, def, missing) {
    const props = Object.assign({}, cur.schema.props);
    for (const k of missing) props[k] = def.schema.props[k];
    return {
      name: cur.name || def.name,
      description: cur.description != null ? cur.description : def.description,
      schema: Object.assign({}, cur.schema, { props }),
      i18n: mergeI18n(cur.i18n, def.i18n, missing),
      v: cur.v,
    };
  }

  class ApiError extends Error {
    constructor(status, message, body, retryAfter) { super(message); this.status = status; this.body = body; if (retryAfter != null) this.retryAfter = retryAfter; }
  }

  // ---------- session cache (speed audit items 5 and 6) ----------
  // Which library of the project has our name, and "definition X of library Y has all the fields the code needs", are
  // asked on every load, reload and stage switch by every panel. They are kept for CACHE_MS in sessionStorage: all
  // panels are served from one origin, so one panel's lookup serves the others in the same browser tab. Only positive
  // answers are kept (a library found, a definition complete); a 403 or 404 on that library or definition drops them,
  // and callers can pass {fresh: true} to skip the cache. No sessionStorage (blocked, Node): a per-page Map instead.
  const CACHE_MS = 10 * 60000;
  const CACHE_PREFIX = "arsten.pset.v1.";
  const memCache = new Map();
  let now = () => Date.now();
  const storage = () => { try { return typeof sessionStorage !== "undefined" && sessionStorage ? sessionStorage : null; } catch { return null; } };
  /** The cached value, or null; entry: the whole entry {at, val} instead (at = when it was first stored). */
  function cacheRead(key, entry) {
    const st = storage();
    let c = null;
    if (st) { try { c = JSON.parse(st.getItem(key) || "null"); } catch { c = null; } }
    if (!c) c = memCache.get(key) || null;   // no storage, or it refused the write (private mode, quota)
    if (!c || typeof c.at !== "number") return null;
    const age = now() - c.at;
    if (age < -60000 || age > CACHE_MS) { cacheDrop((k) => k === key); return null; }
    return entry ? c : c.val;
  }
  /** at: keep this entry time (an update that must not extend the 10 minutes); default now. */
  function cacheWrite(key, val, at) {
    const st = storage(), c = { at: typeof at === "number" ? at : now(), val };
    if (st) { try { st.setItem(key, JSON.stringify(c)); return; } catch {} }
    memCache.set(key, c);
  }
  /** Drop every cache entry whose key passes test(key, value). */
  function cacheDrop(test) {
    const st = storage();
    if (st) {
      try {
        for (let i = st.length - 1; i >= 0; i--) {
          const k = st.key(i);
          if (!k || !k.startsWith(CACHE_PREFIX)) continue;
          let v = null;
          try { v = (JSON.parse(st.getItem(k) || "null") || {}).val; } catch {}
          if (test(k, v)) st.removeItem(k);
        }
      } catch {}
    }
    for (const [k, c] of memCache) if (test(k, c && c.val)) memCache.delete(k);
  }
  const CHECK_MS = 60000;   // findLibrary: a cached library is checked by name at most once a minute (round 12 L5)
  const MISS_MS = 2 * 60000;   // findLibrary: "not found" / "no read right" is kept this long (round 17 L1)
  const READ_POOL = 4;      // readMany: batch-get chunks at once (round 12 M3)
  const libJobs = new Map();   // findLibrary lookups running in this page, by cache key (shared by concurrent callers)
  const normName = (x) => String(x || "").replace(/\s+/g, "").toLowerCase();
  const libKey = (region, projectId, names) => `${CACHE_PREFIX}lib.${region}.${projectId}.${names.map(normName).join("|")}`;
  const defKey = (region, libId, def) => `${CACHE_PREFIX}def.${region}.${libId}.${def.id}.${Object.keys((def.schema && def.schema.props) || {}).sort().join(",")}`;
  /** Forget what is cached about one library (its lookup and all its definitions); with defId only that definition. */
  function forgetLibrary(libId, defId) {
    if (libId == null) return;
    const id = String(libId);
    cacheDrop((k, v) => {
      const m = /^arsten\.pset\.v1\.def\.[^.]+\.(.*)$/.exec(k);
      if (m) return m[1].startsWith(id + ".") && (defId == null || m[1].startsWith(id + "." + defId + "."));
      return defId == null && k.startsWith(CACHE_PREFIX + "lib.") && !!(v && v.lib && String(v.lib.id) === id);
    });
  }
  /** A failed call that says the library (or one definition) is gone or closed to this user: drop the cache for it.
   *  A 404 of a pset itself (GET / DELETE psets/...) is normal ("no status yet") and keeps the cache. */
  function noteFailure(method, path, body, status) {
    if (status !== 403 && status !== 404) return;
    const dec = (x) => { try { return decodeURIComponent(x); } catch { return x; } };
    let m = /^libs\/([^/?]+)(?:\/defs\/([^/?]+))?/.exec(path);
    if (m) {
      if (status === 403 || !m[2]) return forgetLibrary(dec(m[1]));
      return forgetLibrary(dec(m[1]), dec(m[2]));   // a definition (or its psets) missing: the library itself is fine
    }
    m = /^psets\/[^/]+\/([^/?]+)\/([^/?]+)/.exec(path);
    if (m) {
      if (status === 403) return forgetLibrary(dec(m[1]));
      if (method === "PATCH") return forgetLibrary(dec(m[1]), dec(m[2]));
      return;
    }
    if (path === "batch-get" && body && Array.isArray(body.psets)) for (const id of new Set(body.psets.map((p) => p && p.libId))) forgetLibrary(id);
  }

  // ---------- network: timeout, retry, perf (review round 12, M1 / M2 / ?perf=1) ----------
  // The same rules are copied into the Core clients of arsten-access.js, arsten-photos.js and arsten-backup.js (each of
  // those files must also work alone); change them together.
  //  - Timeout (M1): every call is aborted after TIMEOUT_MS (30 s; an upload's PUT UPLOAD_TIMEOUT_MS, 120 s), the body
  //    read included, and fails with ApiError status 0, timeout: true, "Connect не отговаря (време за изчакване) - ...".
  //    The panels' guards (reloading / inflight / publishing) are released by their usual error paths. A timeout is never
  //    retried: a write may have gone through.
  //  - Retry (M2): a 429 or 503 is tried again, at most RETRY_TRIES tries in all, after Retry-After (capped at 8 s) or a
  //    growing pause from 500 ms with jitter. Retried: every GET, PUT, PATCH and DELETE (PUT / PATCH send the same body
  //    again, which is idempotent for these services; a DELETE answered 404 the second time is handled by the callers)
  //    and the read-only POST batch-get. A POST that CREATES something (a definition, a folder, an upload, an object link)
  //    is retried only on a 429 that carries Retry-After: the service refused it without doing it. A 503 or a bare 429
  //    on such a POST may have been processed, so it is not retried. The error that comes out carries noRetry: true, so
  //    mapLimit does not retry it once more.
  //  - Perf: each try is counted by window.ArstenPerf (shared/arsten-perf.js) when it is loaded and switched on.
  const TIMEOUT_MS = 30000, UPLOAD_TIMEOUT_MS = 120000, RETRY_TRIES = 3;
  const TIMEOUT_TEXT = "Connect не отговаря (време за изчакване)";
  const perfLib = () => {
    const p = (root && root.ArstenPerf) || (typeof globalThis !== "undefined" && globalThis.ArstenPerf) || null;
    return p && typeof p.start === "function" ? p : null;
  };
  const perfStart = (svc, method, path) => { const p = perfLib(); return p ? p.start(svc, method, path) : null; };
  const perfEnd = (h, status) => { const p = h && perfLib(); if (p) p.end(h, status); };
  const perfRetry = (svc, method, path) => { const p = perfLib(); if (p && p.retry) p.retry(svc, method, path); };
  /** Pause before retry number attempt + 1: Retry-After (seconds) when given, else baseMs * 2^attempt with +-25 % jitter. */
  function retryWait(retryAfter, attempt, o) {
    const base = (o && o.baseMs) || 500, max = (o && o.maxMs) || 8000;
    const ra = Number(retryAfter);
    return retryAfter != null && retryAfter !== "" && isFinite(ra) && ra >= 0 ? Math.min(ra * 1000, max)
      : Math.min(base * 2 ** attempt, max) * (0.75 + Math.random() * 0.5);
  }
  /** May a call answered `status` be tried again (see the rule above)? readPost: this POST only reads. */
  function mayRetry(method, status, retryAfter, readPost) {
    if (status !== 429 && status !== 503) return false;
    if (String(method).toUpperCase() !== "POST" || readPost) return true;
    return status === 429 && retryAfter != null;
  }
  const parseRetryAfter = (res) => {
    let ra = null;
    try { ra = res.headers && typeof res.headers.get === "function" ? res.headers.get("Retry-After") : null; } catch {}
    return ra != null && ra !== "" && isFinite(Number(ra)) ? Number(ra) : null;
  };
  /** fetch + read the body as text within ms; on timeout the request is aborted and ApiError(0, timeout) thrown. */
  async function fetchText(f, url, init, ms, what) {
    const ac = typeof AbortController === "function" ? new AbortController() : null;
    let timer = null;
    const late = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        const e = new ApiError(0, `${TIMEOUT_TEXT} – ${what}`, null);
        e.timeout = true;
        reject(e);   // first, so the abort's own error never wins the race
        try { if (ac) ac.abort(); } catch {}
      }, ms);
    });
    try {
      return await Promise.race([(async () => {
        const res = await f(url, ac ? Object.assign({}, init, { signal: ac.signal }) : init);
        const text = typeof res.text === "function" ? await res.text()
          : typeof res.json === "function" ? JSON.stringify(await res.json()) : "";
        return { res, text };
      })(), late]);
    } finally { clearTimeout(timer); }
  }

  /**
   * fn(item, index) over items, at most `limit` running at once; resolves to the results in input order. A call that
   * fails with 429 (too many requests) or 503 is tried again after a growing pause (Retry-After when the service sends
   * it); any other error - or the last retry - rejects, and no new calls are started after it.
   * opts: {retries = 3, baseMs = 500, maxMs = 8000, sleep}.
   */
  async function mapLimit(items, limit, fn, opts) {
    const o = Object.assign({ retries: 3, baseMs: 500, maxMs: 8000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }, opts || {});
    const list = Array.from(items || []);
    const out = new Array(list.length);
    let next = 0, failed = false;
    const once = async (item, k) => {
      for (let attempt = 0; ; attempt++) {
        try { return await fn(item, k); }
        catch (e) {
          // e.noRetry: PsetClient.request (or a Core client) already retried it, or the retry rule forbids it (a POST
          // create): not retried again here, so a call is never tried 3 x 3 times
          if (!(e && (e.status === 429 || e.status === 503)) || e.noRetry || attempt >= o.retries || failed) throw e;
          await o.sleep(retryWait(e.retryAfter, attempt, o));
        }
      }
    };
    const worker = async () => {
      while (!failed && next < list.length) {
        const k = next++;
        try { out[k] = await once(list[k], k); } catch (e) { failed = true; throw e; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, Math.floor(limit) || 1), list.length) }, worker));
    return out;
  }

  class PsetClient {
    /** @param opts {region: "eu-west-1" | project location, getToken: async (refresh) => token,
     *  timeoutMs? (30 s), tries? (3, for 429 / 503), sleep?, fetch? (tests)} */
    constructor(opts) {
      const r = String(opts.region || "eu-west-1").toLowerCase().replace(/[\s_-]/g, "");
      this.region = /^[a-z]{2}(west|east|southeast)\d$/.test(r) ? opts.region : REGIONS[r] || "eu-west-1";
      this.getToken = opts.getToken;
      this.timeoutMs = opts.timeoutMs || TIMEOUT_MS;
      this.tries = opts.tries || RETRY_TRIES;
      this.sleep = opts.sleep || ((ms) => new Promise((res) => setTimeout(res, ms)));
      this.fetch = opts.fetch || ((...a) => fetch(...a));
    }
    /** One call with the token (a 401 refreshes it once), the timeout and the 429 / 503 retry rule above. */
    async request(svc, path, method = "GET", body) {
      const what = `${svc}-api ${method} ${path.split("?")[0]}`;
      const readPost = svc === "pset" && path === "batch-get";
      for (let auth = 0, tries = 0; ;) {
        const token = await this.getToken(auth > 0);
        const h = perfStart(svc, method, path);
        let got;
        try {
          got = await fetchText(this.fetch, hostFor(svc, this.region) + path, {
            method,
            headers: Object.assign({ Authorization: "Bearer " + token }, body !== undefined ? { "Content-Type": "application/json" } : {}),
            body: body !== undefined ? JSON.stringify(body) : undefined,
          }, this.timeoutMs, what);
        } catch (e) { perfEnd(h, e && e.timeout ? "timeout" : 0); throw e; }
        const res = got.res;
        perfEnd(h, res.status);
        if (res.status === 401 && auth === 0) { auth++; continue; }   // token expired: ask Connect for a fresh one
        let data = null;
        try { data = got.text ? JSON.parse(got.text) : null; } catch { data = got.text; }
        if (!res.ok) {
          if (svc === "pset") noteFailure(method, path, body, res.status);
          const ra = parseRetryAfter(res);
          tries++;
          const busy = res.status === 429 || res.status === 503;
          if (busy && tries < this.tries && mayRetry(method, res.status, ra, readPost)) {
            perfRetry(svc, method, path);
            await this.sleep(retryWait(ra, tries - 1));
            continue;
          }
          const err = new ApiError(res.status, `${what}: ${res.status} ${(data && (data.message || data.errorcode || data.code)) || ""}`.trim(), data, ra);
          if (busy) { err.noRetry = true; err.tries = tries; }
          throw err;
        }
        return data;
      }
    }

    /** Library ids registered for the project (what Connect's "Property Set Libraries" page lists). */
    async projectLibraryIds(projectId) {
      try {
        const node = await this.request("org", `forests/${encodeURIComponent(`project:${projectId}:data`)}/trees/ProjectContext/nodes/PSetLibs`);
        return ((node && node.links) || []).map((l) => {
          const m = /^frn:lib:(.+)$/.exec(l);
          return m ? decodeURIComponent(m[1]) : null;
        }).filter(Boolean);
      } catch (e) {
        if (e.status === 404) return [];
        throw e;
      }
    }
    getLibrary(libId) { return this.request("pset", `libs/${encodeURIComponent(libId)}`); }

    /** Find the project library with one of these names (first match in list order wins; case and spaces ignored).
     *  Returns {lib, others, denied} (others: names seen, for messages). A library found is kept in the session cache
     *  for 10 minutes (opts.fresh: look it up again). "Not found" (also when the only match may not be read: denied > 0)
     *  is kept for MISS_MS = 2 minutes in the same cache (round 17 L1: a project without STEEL paid the full lookup on
     *  every Статус load); opts.fresh bypasses it, and a library found later replaces it. Round 18 L5: that miss is shared by
     *  every panel in the browser tab (sessionStorage) and survives a reload, so a library created or opened to the user
     *  less than 2 minutes ago still reads as missing / denied; a write that must see it (Статус publishing) passes
     *  {fresh: true}. A cached library is checked with one
     *  GET libs/{id} before it is used (review 10 L2): renamed (its name no longer one of `names`), deleted (404) or
     *  closed (403) drops it and the full lookup runs - so nobody reads or writes a renamed library for 10 minutes.
     *  Round 12 L5: that check runs at most once a minute per library and browser tab (CHECK_MS; the time is kept in the
     *  shared cache entry), and calls made while one lookup runs in this page share it. Any 403 / 404 on the library in
     *  use still drops the entry at once (noteFailure). */
    findLibrary(projectId, names, opts) {
      const list = Array.isArray(names) ? names : [names];
      if (opts && opts.fresh) return this.findLibraryNow(projectId, list, opts);
      const key = libKey(this.region, projectId, list);
      let job = libJobs.get(key);
      if (!job) {
        job = this.findLibraryNow(projectId, list, opts);
        libJobs.set(key, job);
        const done = () => { if (libJobs.get(key) === job) libJobs.delete(key); };
        job.then(done, done);
      }
      return job;
    }
    async findLibraryNow(projectId, list, opts) {
      const want = list.map(normName);
      const key = libKey(this.region, projectId, list);
      if (!(opts && opts.fresh)) {
        const e = cacheRead(key, true), c = e && e.val;
        if (c && c.miss && !c.lib) {
          const age = now() - e.at;
          if (age >= 0 && age < MISS_MS) return { lib: null, others: c.others || [], denied: c.denied || 0, cached: true };
        }
        if (c && c.lib && c.lib.id != null) {
          const age = now() - (typeof c.checkedAt === "number" ? c.checkedAt : e.at);
          if (age >= 0 && age < CHECK_MS) return { lib: c.lib, others: c.others || [], denied: c.denied || 0, cached: true };
          let cur = null;
          try { cur = await this.getLibrary(c.lib.id); }
          catch (err) { if (err.status !== 403 && err.status !== 404) throw err; }
          const rank = cur ? want.indexOf(normName(cur.name)) : -1;
          // still a match of the same rank: answer from the cache (a better-ranked library could only appear by a new
          // name in the project, which the full lookup after 10 minutes or opts.fresh finds)
          if (rank >= 0) {
            const lib = Object.assign({}, c.lib, cur);
            cacheWrite(key, Object.assign({}, c, { lib, checkedAt: now() }), e.at);   // keeps the 10 minutes of the entry
            return { lib, others: c.others || [], denied: c.denied || 0, cached: true };
          }
          forgetLibrary(c.lib.id);
        }
      }
      const ids = await this.projectLibraryIds(projectId);
      const others = [], hits = [];
      let denied = 0;   // libraries of the project this user may not read: "no access", never "missing" (week 1, F9)
      // the libraries are read 4 at a time (were one after the other); results are taken in list order, as before
      const got = await mapLimit(ids, 4, async (id) => {
        try { return { lib: await this.getLibrary(id) }; }
        catch (e) { if (e.status === 403) return { denied: true }; if (e.status === 404) return {}; throw e; }
      });
      for (const g of got) {
        if (g.denied) { denied++; continue; }
        const lib = g.lib;
        const rank = lib ? want.indexOf(normName(lib.name)) : -1;
        if (rank >= 0) hits.push({ rank, lib });
        else if (lib) others.push(lib.name);
      }
      hits.sort((a, b) => a.rank - b.rank);
      const out = { lib: hits.length ? hits[0].lib : null, others, denied };
      if (out.lib && out.lib.id != null) cacheWrite(key, Object.assign({ checkedAt: now() }, out));
      else cacheWrite(key, Object.assign({ miss: true }, out));   // round 17 L1: kept MISS_MS (fresh bypasses it)
      return out;
    }

    /** Make sure the status definition exists in the library and has all fields (creates or extends it). A definition
     *  found complete (or just created / extended) is remembered for 10 minutes per library, definition and field list
     *  (session cache; opts.fresh: check again) and then answered without a call: {def, created: false, cached: true}. */
    async ensureDefinition(libId, def, opts) {
      const key = defKey(this.region, libId, def);
      if (!(opts && opts.fresh)) {
        const c = cacheRead(key);
        if (c && c.def) return { def: c.def, created: false, cached: true };
      }
      const r = await this.ensureDefinitionNow(libId, def);
      if (r && r.def) cacheWrite(key, { def: r.def });
      return r;
    }
    /** ensureDefinition without the cache: always reads the definition (one GET, plus POST / PATCH when needed). */
    async ensureDefinitionNow(libId, def) {
      let cur = null;
      try { cur = await this.request("pset", `libs/${encodeURIComponent(libId)}/defs/${encodeURIComponent(def.id)}`); }
      catch (e) { if (e.status !== 404) throw e; }
      if (!cur) return { def: await this.request("pset", `libs/${encodeURIComponent(libId)}/defs`, "POST", def), created: true };
      const have = Object.keys((cur.schema && cur.schema.props) || {});
      const missing = Object.keys(def.schema.props).filter((p) => !have.includes(p));
      if (!missing.length) return { def: cur, created: false };
      const upd = await this.request("pset", `libs/${encodeURIComponent(libId)}/defs/${encodeURIComponent(def.id)}`, "PATCH",
        extendBody(Object.assign({}, cur, { schema: Object.assign({ props: {} }, cur.schema) }), def, missing));
      return { def: upd, created: false, extended: missing };
    }

    /** Read the status of many objects. Returns Map link -> props. */
    async readMany(libId, defId, links) {
      // round 12 M3: the 100-link chunks are read READ_POOL at a time (were one after the other); the map is filled in
      // chunk order afterwards, so it is the same as before (also when a link is in two chunks: the later one wins)
      const chunks = [];
      for (let i = 0; i < links.length; i += 100) chunks.push(links.slice(i, i + 100));
      const all = await mapLimit(chunks, READ_POOL, (chunk) =>
        this.request("pset", "batch-get", "POST", { psets: chunk.map((link) => ({ link, libId, defId })) }));
      const out = new Map();
      for (const res of all) {
        const got = (res && res.responses && res.responses.psets) || [];
        for (const p of got) if (p && p.link && !p.deleted) out.set(p.link, p.props || {});
      }
      return out;
    }

    /**
     * Every pset of a definition (also of objects no longer in the model), as the official JS SDK's
     * listPSetsByDefinition: GET libs/{lib}/defs/{def}/psets?top=&skiptoken=&link=, paged by `next`.
     * Returns Map link -> props (deleted psets skipped). Two items of the same object can come back with the same link
     * text (a "$" GUID stored raw and URL-encoded): the second one is kept under the other form of the link instead of
     * overwriting the first (callers decode links to GUIDs and re-read such objects in both forms).
     */
    async listAll(libId, defId, linkPrefix) {
      const out = new Map();
      const q = (tok) => ["top=500", linkPrefix ? "link=" + encodeURIComponent(linkPrefix) : "", tok ? "skiptoken=" + encodeURIComponent(tok) : ""].filter(Boolean).join("&");
      let path = `libs/${encodeURIComponent(libId)}/defs/${encodeURIComponent(defId)}/psets?${q()}`;
      for (let page = 0; path && page < 200; page++) {
        const res = await this.request("pset", path);
        for (const p of (res && res.items) || []) if (p && p.link && !p.deleted) addListed(out, p.link, p.props || {});
        const next = res && res.next;
        if (!next) break;
        if (/^https?:/.test(next)) {   // absolute link: keep only the part after the service root
          const m = /\/v1\/(.+)$/.exec(next);
          path = m ? m[1] : null;
        } else if (/^[?&]?skiptoken=/i.test(next) || !/[/?]/.test(next)) {
          path = `libs/${encodeURIComponent(libId)}/defs/${encodeURIComponent(defId)}/psets?${q(next.replace(/^[?&]?skiptoken=/i, ""))}`;
        } else path = next.replace(/^\//, "").replace(/^v1\//, "");
      }
      return out;
    }

    /** Library access policy (needs pset:GetLibraryPolicy / org:UpdateLibraryPolicy; project admins). */
    getPolicy(libId) { return this.request("pset", `libs/${encodeURIComponent(libId)}/policy`); }
    putPolicy(libId, policy) { return this.request("pset", `libs/${encodeURIComponent(libId)}/policy`, "PUT", policy); }

    /** Write (create or update) the status of one object. PATCH merges: fields left out keep their value. */
    write(libId, defId, link, props) {
      return this.request("pset", psetPath(link, libId, defId), "PATCH", { props: clean(props) });
    }

    /** One pset with its version: {props, v}; props is null when the pset was deleted (v still returned, so a new
     *  write can go on top of it); null when it never existed. */
    async readOne(libId, defId, link) {
      const path = psetPath(link, libId, defId);
      let p = null;
      try { p = await this.request("pset", path); } catch (e) { if (e.status !== 404) throw e; }
      if (p && !p.deleted) return { props: p.props || {}, v: p.v };
      try { const d = await this.request("pset", path + "?deleted"); if (d) return { props: null, v: d.v }; } catch (e) { if (e.status !== 404) throw e; }
      return p ? { props: null, v: p.v } : null;
    }

    /** Merge-write (PATCH) carrying the version read with readOne, so a write made by someone else in between
     *  is refused (412/409) instead of overwritten. v undefined: plain create / merge. */
    writeIfUnchanged(libId, defId, link, props, v) {
      const body = { props: clean(props) };
      if (v !== undefined && v !== null) body.v = v;
      return this.request("pset", psetPath(link, libId, defId), "PATCH", body);
    }

    /** Delete one pset; no error when it does not exist (404) or is already deleted (410). */
    async remove(libId, defId, link) {
      try { await this.request("pset", psetPath(link, libId, defId), "DELETE"); } catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
    }

    /** Replace the whole status of one object, so fields can be cleared (pset-api rejects "" and null for typed
     *  fields, and PATCH cannot remove a field). Same as Connect web: delete, then re-create; if the deleted pset
     *  still blocks (412), re-create on top of its version. */
    async replace(libId, defId, link, props) {
      const path = psetPath(link, libId, defId);
      try { await this.request("pset", path, "DELETE"); } catch (e) { if (e.status !== 404) throw e; }
      const body = { props: clean(props) };
      try { return await this.request("pset", path, "PATCH", body); }
      catch (e) {
        if (e.status !== 412 && e.status !== 409) throw e;
        const del = await this.request("pset", path + "?deleted");
        return this.request("pset", path, "PATCH", Object.assign(body, { v: del && del.v }));
      }
    }
  }

  /** listAll's map insert: never overwrite a link already listed (see listAll). */
  function addListed(out, link, props) {
    if (!out.has(link)) return out.set(link, props);
    const m = /^frn:entity:(.*)$/.exec(link);
    if (m) {
      let g = m[1];
      try { g = decodeURIComponent(g); } catch {}
      const enc = "frn:entity:" + encodeURIComponent(g), raw = "frn:entity:" + g;
      const alt = link === enc ? raw : enc;
      if (alt !== link && !out.has(alt)) return out.set(alt, props);
    }
    console.warn("pset listed twice under the same link; the first one is kept", link);
    return out;
  }

  const lib = { PsetClient, ApiError, hostFor, clean, extendBody, mergeI18n, addListed, mapLimit, forgetLibrary, CACHE_MS, CHECK_MS, MISS_MS, READ_POOL,
    TIMEOUT_MS, UPLOAD_TIMEOUT_MS, TIMEOUT_TEXT, RETRY_TRIES, fetchText, mayRetry, retryWait,
    /** Empty the session cache (for this browser tab: all panels). */
    clearCache: () => cacheDrop(() => true),
    _setNow: (fn) => { now = fn || (() => Date.now()); } };
  if (typeof module === "object" && module.exports) module.exports = lib;
  else root.PsetApi = lib;
})(typeof self !== "undefined" ? self : this);
