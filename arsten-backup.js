// Arsten backups ("undo files") before mass actions in the Connect panels (Стомана, Монолитен бетон).
// Approved by the owner 16.11.2026: "Backup to JSON, and an automatic undo file before every mass action".
//  - Before a mass action the panel builds a snapshot of exactly the records the action will change or delete, as they
//    are now: {tool, action, project, by, at, library, records: [{def, link, props}]}; props null = the record did not exist.
//  - The snapshot goes as JSON to the project folder _AM_Docs/Backups/<YYYY-MM-DD>/<tool>-<action>-<HHMMSSmmm>.json
//    (folders created when missing; Core 2.0 files/fs/initiate -> PUT -> files/fs/commit, as shared/arsten-photos.js).
//  - Upload failed: the same JSON is downloaded in the browser. save() says what happened (saved: "uploaded" |
//    "downloaded" | "none"); the panel decides whether the action goes on (destructive ones ask again without upload).
//  - checkEcho / recordsFrom({decode}): a snapshot is refused when the service returned a requested link in another form
//    (a restore would otherwise delete a record that existed).
//  - restorePlan(snapshot, current): the writes that put the records back (a restore UI comes later in Администрация).
// Browser: window.ArstenBackup; node: require("shared/arsten-backup.js"). No dependencies.
(function (root, factory) {
  const lib = factory();
  if (typeof module === "object" && module.exports) module.exports = lib;
  else root.ArstenBackup = lib;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // The project's tool folder is _AM_Docs (renamed from _ArstenDocs on 17.11.2026, one name for Arsten and Multiplan).
  // Lookups take _AM_Docs first and fall back to an old _ArstenDocs; only _AM_Docs is ever created.
  const DOCS = "_AM_Docs", DOCS_OLD = "_ArstenDocs";
  const pickFolder = (list, name, same) => {
    const eq = same || ((a, b) => a === b);
    const isF = (x) => !!x && String(x.type || "").toUpperCase() === "FOLDER";
    return (list || []).find((x) => isF(x) && eq(x.name, name)) || (name === DOCS ? (list || []).find((x) => isF(x) && eq(x.name, DOCS_OLD)) : undefined);
  };
  const ROOT_PATH = [DOCS, "Backups"];
  const VERSION = 1;
  const T = {
    bg: { ok: "Архив: ", failed: "Архивът не е качен в Connect – изтеглен е на компютъра", none: "Архивът НЕ е запазен (нито качен в Connect, нито изтеглен)",
      echo: "Архивът не може да се направи – нищо не е променено: услугата върна записа под друга връзка" },
    en: { ok: "Backup: ", failed: "The backup was not uploaded to Connect – it was downloaded to the computer", none: "The backup was NOT saved (neither uploaded to Connect nor downloaded)",
      echo: "The backup could not be made – nothing was changed: the service returned the record under another link" },
  };

  const pad = (n, w = 2) => String(n).padStart(w, "0");
  /** Local day and time of a Date: {day: "YYYY-MM-DD", time: "HHMMSS", ms: "mmm"}. */
  function stamp(d) {
    d = d instanceof Date ? d : new Date(d == null ? Date.now() : d);
    return { day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`, ms: pad(d.getMilliseconds(), 3) };
  }
  /** A safe file-name part: letters (any script), digits, "-" and "_"; everything else becomes "-". */
  const slug = (s) => String(s == null ? "" : s).trim().replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "x";
  /** {folder: ["_AM_Docs","Backups","2026-11-16"], name: "steel-fab-import-143005123.json", path: "_AM_Docs/Backups/2026-11-16/steel-fab-import-143005123.json"}
   *  (time with milliseconds, so two backups in the same second get different names) */
  function backupPath(tool, action, at) {
    const s = stamp(at);
    const folder = [...ROOT_PATH, s.day];
    const name = `${slug(tool)}-${slug(action)}-${s.time}${s.ms}.json`;
    return { folder, name, path: [...folder, name].join("/") };
  }

  const clone = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));
  /** Default link -> GUID decoding ("frn:entity:" removed, URL-decoded; same as ArstenLinks.guidOfLink). */
  function decodeLink(link) {
    const g = String(link || "").replace(/^frn:entity:/, "");
    try { return decodeURIComponent(g); } catch { return g; }
  }
  const keysOf = (m) => (m instanceof Map ? [...m.keys()] : m ? Object.keys(m) : []);
  const hasKey = (m, k) => (m instanceof Map ? m.has(k) : !!m && Object.prototype.hasOwnProperty.call(m, k));
  /**
   * Guard for a snapshot (M4): throws when a requested link is missing from a batch-get result while a returned key
   * decodes to the same GUID - the service echoed the link in another form, and recording it as props null would make a
   * restore DELETE a record that existed. links: the requested links; got: Map (or object) link -> props as returned;
   * decode: link -> GUID (ArstenLinks.guidOfLink; a panel without arsten-links.js passes its own or uses the default).
   * A returned key that was itself requested is never counted (both forms asked: each answers for itself).
   * The error has code "BACKUP_LINK_FORM" and lists the links in e.links.
   */
  function checkEcho(links, got, decode) {
    decode = decode || decodeLink;
    const byGuid = new Map();
    for (const k of keysOf(got)) byGuid.set(decode(k), k);
    const bad = [], asked = new Set(links || []);
    for (const l of asked) {
      if (hasKey(got, l)) continue;
      const other = byGuid.get(decode(l));
      if (other !== undefined && other !== l && !asked.has(other)) bad.push(l + " -> " + other);
    }
    if (bad.length) {
      const e = new Error("backup: the service returned " + bad.length + " link(s) in another form: " + bad.slice(0, 3).join(", "));
      e.code = "BACKUP_LINK_FORM"; e.links = bad;
      throw e;
    }
  }
  /** Records [{def, link, props}] from a list of {def, link} and a Map link -> props per def (as PsetClient.readMany /
   *  listAll return). A link missing from the map is recorded with props null: it did not exist before the action.
   *  opts.decode (link -> GUID) turns on checkEcho for every def (throws instead of recording a wrong null). */
  function recordsFrom(items, mapsByDef, opts) {
    const seen = new Set(), out = [];
    const mapOf = (def) => (mapsByDef instanceof Map ? mapsByDef.get(def) : mapsByDef && mapsByDef[def]);
    if (opts && opts.decode) {
      const per = new Map();
      for (const it of items || []) { if (!per.has(it.def)) per.set(it.def, []); per.get(it.def).push(it.link); }
      for (const [def, links] of per) checkEcho(links, mapOf(def), opts.decode);
    }
    for (const it of items || []) {
      const k = it.def + "|" + it.link;
      if (seen.has(k)) continue;
      seen.add(k);
      const m = mapOf(it.def);
      const props = m && (m instanceof Map ? (m.has(it.link) ? m.get(it.link) : null) : Object.prototype.hasOwnProperty.call(m, it.link) ? m[it.link] : null);
      out.push({ def: it.def, link: it.link, props: clone(props) });
    }
    return out;
  }
  /** The snapshot object (what is written to the JSON file). */
  function snapshot(o) {
    const at = o.at instanceof Date ? o.at : new Date(o.at == null ? Date.now() : o.at);
    return {
      type: "arsten-backup", version: VERSION,
      tool: String(o.tool || ""), action: String(o.action || ""),
      project: o.project ? { id: o.project.id || "", name: o.project.name || "" } : null,
      by: o.by || "", at: at.toISOString(),
      library: o.library ? { id: o.library.id || "", name: o.library.name || "" } : null,
      records: (o.records || []).map((r) => ({ def: r.def, link: r.link, props: clone(r.props) })),
    };
  }
  const toJson = (snap) => JSON.stringify(snap, null, 1);

  // ---------- restore (pure) ----------
  function same(a, b) {
    if (a === b) return true;
    if (a == null || b == null || typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && same(a[k], b[k]));
  }
  /** current: [{def, link, props}] or Map "def|link" -> props (props null / missing = the record does not exist now). */
  function currentLookup(current) {
    if (current instanceof Map) return (def, link) => { const v = current.get(def + "|" + link); return v == null ? null : v; };
    const m = new Map();
    for (const r of current || []) if (r && r.props != null) m.set(r.def + "|" + r.link, r.props);
    return (def, link) => (m.has(def + "|" + link) ? m.get(def + "|" + link) : null);
  }
  /**
   * The writes that put the records of a snapshot back:
   *  - the record did not exist before and exists now -> {op: "delete", def, link};
   *  - it existed and was changed or deleted since -> {op: "write", def, link, props} (a whole-record replace, so fields
   *    added later are cleared);
   *  - unchanged -> nothing.
   * Every op carries lib (the snapshot's library id).
   */
  function restorePlan(snap, current) {
    const cur = currentLookup(current);
    const lib = (snap && snap.library && snap.library.id) || "";
    const ops = [], seen = new Set();
    for (const r of (snap && snap.records) || []) {
      const k = r.def + "|" + r.link;
      if (seen.has(k)) continue;
      seen.add(k);
      const now = cur(r.def, r.link);
      if (r.props == null) { if (now != null) ops.push({ op: "delete", lib, def: r.def, link: r.link }); }
      else if (!same(r.props, now)) ops.push({ op: "write", lib, def: r.def, link: r.link, props: clone(r.props) });
    }
    return ops;
  }

  // ---------- network: timeout, retry, perf (review round 12, M1 / M2 / ?perf=1) ----------
  // The same rules as PsetClient.request in psetapi.js (this file must also work alone; change them together):
  //  - every call is aborted after TIMEOUT_MS (30 s; an upload's PUT: UPLOAD_TIMEOUT_MS, 120 s), the body read included,
  //    and fails with status 0, timeout: true, "Connect не отговаря (време за изчакване) - ...". Never retried (a write
  //    may have gone through); the panels' guards are released by their usual error paths;
  //  - a 429 / 503 is tried again, at most RETRY_TRIES tries in all, after Retry-After (capped at 8 s) or a growing pause
  //    from 500 ms with jitter: every GET, PUT, PATCH and DELETE (same body again: idempotent here). A POST (they all
  //    create something in Core: a folder, an upload, a commit, an object link) only on a 429 that carries Retry-After,
  //    which the service refused without doing it. The error that comes out carries noRetry: true (no second retry in a
  //    caller's mapLimit);
  //  - a 502 / 504 (gateway blip) the same way, but only for a GET (sweep 18.11.2026);
  //  - each try is counted as service "core" by window.ArstenPerf (shared/arsten-perf.js) when loaded and switched on.
  const TIMEOUT_MS = 30000, UPLOAD_TIMEOUT_MS = 120000, RETRY_TRIES = 3;
  const TIMEOUT_TEXT = "Connect не отговаря (време за изчакване)";
  const perfLib = () => {
    const g = typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : {};
    return g.ArstenPerf && typeof g.ArstenPerf.start === "function" ? g.ArstenPerf : null;
  };
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  function retryWait(retryAfter, attempt) {
    const ra = Number(retryAfter);
    return retryAfter != null && retryAfter !== "" && isFinite(ra) && ra >= 0 ? Math.min(ra * 1000, 8000)
      : Math.min(500 * 2 ** attempt, 8000) * (0.75 + Math.random() * 0.5);
  }
  // sweep 18.11.2026: a 502 / 504 from Trimble's gateway is tried again too, but only for a GET (a listing, a downloadurl,
  // a read: safe to repeat); a POST / PUT / PATCH / DELETE that got one may have gone through, so it is left as it was
  const gatewayBlip = (method, status) => (status === 502 || status === 504) && String(method).toUpperCase() === "GET";
  function mayRetry(method, status, retryAfter) {
    if (gatewayBlip(method, status)) return true;
    if (status !== 429 && status !== 503) return false;
    return String(method).toUpperCase() !== "POST" || (status === 429 && retryAfter != null);
  }
  const parseRetryAfter = (res) => {
    let ra = null;
    try { ra = res.headers && typeof res.headers.get === "function" ? res.headers.get("Retry-After") : null; } catch {}
    return ra != null && ra !== "" && isFinite(Number(ra)) ? Number(ra) : null;
  };
  /** fetch + body text within ms; on timeout the request is aborted and an error {status: 0, timeout: true} thrown. */
  async function fetchBody(f, url, init, ms, what, read) {
    const ac = typeof AbortController === "function" ? new AbortController() : null;
    let timer = null;
    const late = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        reject(Object.assign(new Error(`${TIMEOUT_TEXT} – ${what}`), { status: 0, timeout: true }));
        try { if (ac) ac.abort(); } catch {}
      }, ms);
    });
    try {
      return await Promise.race([(async () => {
        const res = await f(url, ac ? Object.assign({}, init, { signal: ac.signal }) : init);
        // read "blob" (sweep 18.11.2026): a photo download keeps its bytes; the timeout still covers the body
        if (read === "blob") return { res, text: "", blob: res.ok ? (typeof res.blob === "function" ? await res.blob() : typeof res.text === "function" ? await res.text() : null) : null };
        const text = typeof res.text === "function" ? await res.text()
          : typeof res.json === "function" ? JSON.stringify(await res.json()) : "";
        return { res, text };
      })(), late]);
    } finally { clearTimeout(timer); }
  }
  /** One call with timeout, 429 / 503 retry and perf. o: {path (for perf), what (for messages), ms?, tries?, sleep?,
   *  read?: "blob" (the body as a Blob in got.blob)}. Returns {res, text}; for a 429 / 503 left after the retries also
   *  {busy: true, retryAfter, tries}. Exported (sweep 18.11.2026) so Дейности's photo PUT / download use the same
   *  timeout instead of a bare fetch that can hang a site phone forever. */
  async function send(f, url, init, o) {
    const method = (init && init.method) || "GET";
    for (let tries = 1; ; tries++) {
      const p = perfLib(), h = p ? p.start("core", method, o.path) : null;
      let got;
      try { got = await fetchBody(f, url, init, o.ms || TIMEOUT_MS, o.what, o.read); }
      catch (e) { if (h) p.end(h, e && e.timeout ? "timeout" : 0); throw e; }
      if (h) p.end(h, got.res.status);
      const st = got.res.status;
      if (st !== 429 && st !== 503 && !gatewayBlip(method, st)) return got;
      const ra = parseRetryAfter(got.res);
      if (tries < (o.tries || RETRY_TRIES) && mayRetry(method, st, ra)) {
        if (p && p.retry) p.retry("core", method, o.path);
        await (o.sleep || pause)(retryWait(ra, tries - 1));
        continue;
      }
      return Object.assign(got, { busy: true, retryAfter: ra, tries });
    }
  }
  /** The error of a failed Core call: status, and for a 429 / 503 after the retries noRetry, retryAfter, tries. */
  function failure(message, got) {
    const e = new Error(message);
    e.status = got.res.status;
    if (got.busy) { e.noRetry = true; e.retryAfter = got.retryAfter; e.tries = got.tries; }
    return e;
  }

  // ---------- Core API (same calls as shared/arsten-photos.js) ----------
  /** fetchImpl, opts {timeoutMs, tries, sleep}: tests. */
  function coreClient(base, getToken, fetchImpl, opts) {
    const f = fetchImpl || ((...a) => fetch(...a));
    const o = opts || {};
    // extra (sweep 18.11.2026, as shared/arsten-photos.js): extra.headers are sent too; with extra.full the answer is
    // {full: true, data, status, headers}, so listFolder can follow the paging headers
    async function req(path, method = "GET", body, extra) {
      const what = `Core ${method} ${path.split("?")[0]}`;
      const x = extra || {};
      for (let attempt = 0; attempt < 3; attempt++) {
        const token = await getToken(attempt > 0);
        const got = await send(f, base + path, { method, headers: Object.assign({ Authorization: "Bearer " + token }, body !== undefined ? { "Content-Type": "application/json" } : {}, x.headers || {}),
          body: body !== undefined ? JSON.stringify(body) : undefined }, { path, what, ms: o.timeoutMs, tries: o.tries, sleep: o.sleep });
        const res = got.res;
        if (res.status === 401 && attempt < 2) continue;
        let data = null; try { data = got.text ? JSON.parse(got.text) : null; } catch { data = got.text; }
        if (!res.ok) throw failure(`${what}: ${res.status} ${(data && (data.message || data.errorcode)) || ""}`.trim(), got);
        return x.full ? { full: true, data, status: res.status, headers: res.headers || null } : data;
      }
    }
    return { req };
  }
  const itemsOf = (it) => (Array.isArray(it) ? it : (it && (it.items || it.data)) || []);
  // ---------- folder listings with paging (sweep 18.11.2026; the same rules as listFolder in shared/arsten-photos.js,
  // which this file cannot load - change them together) ----------
  // A day folder (_AM_Docs/Backups/<day>, Activities/Photos/<day>) on page 2 of its parent was not found by a one-page
  // listing: a duplicate folder or a 409 followed, the backup fell back to a download and activity photos failed.
  const PAGE_SIZES = [50, 100, 200, 250, 500, 1000, 2000, 5000];
  const MAX_PAGES = 100;
  const hdr = (h, k) => { try { return h && typeof h.get === "function" ? h.get(k) : null; } catch { return null; } };
  /** All items of a folder: {items, complete} (complete false = the listing may be cut off). */
  async function listFolder(core, folderId) {
    const path = `folders/${encodeURIComponent(folderId)}/items`;
    const page = async (p, headers) => {
      const r = await core.req(p, "GET", undefined, headers ? { full: true, headers } : { full: true });
      return r && r.full === true && "data" in r ? r : { data: r, status: 200, headers: null };   // a core that gives data only
    };
    let r = await page(path), items = itemsOf(r.data).slice();
    for (let n = 1; ; n++) {
      const d = r.data && !Array.isArray(r.data) ? r.data : {};
      const next = (d.links && d.links.next && (d.links.next.href || d.links.next)) || d.next || d.nextLink || null;
      const token = d.skipToken || d.nextToken || d.continuationToken || null;
      const cr = /^\s*items\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(hdr(r.headers, "Content-Range") || "");
      let nextPath = null, nextHeaders = null;
      if (typeof next === "string" && next) {
        const m = /\/tc\/api\/2\.[01]\/(.*)$/.exec(next);
        nextPath = /^https?:/i.test(next) ? (m ? m[1] : null) : next.replace(/^\//, "");
        if (!nextPath) return { items, complete: false };
      } else if (token) nextPath = `${path}?skipToken=${encodeURIComponent(token)}`;
      else if (cr) {
        const start = Number(cr[1]), end = Number(cr[2]), total = cr[3] === "*" ? NaN : Number(cr[3]);
        if (!(end + 1 < total)) return { items, complete: cr[3] !== "*" };
        nextPath = path; nextHeaders = { Range: `items=${end + 1}-${end + 1 + (end - start)}` };
      } else {
        const total = Number(d.total != null ? d.total : d.totalCount != null ? d.totalCount : NaN);
        const complete = r.status !== 206 && (isFinite(total) ? items.length >= total : !(n === 1 && PAGE_SIZES.includes(items.length)));
        return { items, complete };
      }
      if (n >= MAX_PAGES) return { items, complete: false };
      try { r = await page(nextPath, nextHeaders); } catch (e) { console.warn("folder listing: next page failed", e); return { items, complete: false }; }
      const more = itemsOf(r.data);
      if (!more.length) return { items, complete: false };
      items = items.concat(more);
    }
  }
  /** Folder id of a path under the project root, created when missing. cache: optional Map shared between calls.
   *  Every page of a listing is read (sweep 18.11.2026). A name missing from a listing that may be cut off is also
   *  looked up with GET folders/by_path before a folder is created (best effort: any error there just goes on). */
  async function ensureFolder(core, projectId, names, cache) {
    cache = cache || new Map();
    const memo = folderMemo(core, projectId);   // only written here: a stale remembered id must never get an upload
    let parent = cache.get("root:" + projectId);
    if (!parent) { const p = await core.req(`projects/${encodeURIComponent(projectId)}`); parent = p && p.rootId; if (!parent) throw new Error("project root folder not found"); cache.set("root:" + projectId, parent); memo.set("", parent); }
    const walked = [];   // the folder names walked so far (for by_path)
    const byPath = async (name) => {
      try {
        const f = await core.req(`folders/by_path?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent("/" + walked.concat([name]).join("/"))}`);
        return f && f.id && (!f.type || String(f.type).toUpperCase() === "FOLDER") ? f : null;
      } catch { return null; }
    };
    for (const name of names) {
      const key = parent + "/" + name;
      if (cache.has(key)) { parent = cache.get(key); walked.push(cache.get("name:" + key) || name); continue; }
      const pick = (list) => pickFolder(list, name);
      const l = await listFolder(core, parent);
      let f = pick(l.items);
      // sweep 18.11.2026: by path also after a complete listing - Connect may leave a folder the user can use out of the
      // listing of a parent closed to them (AM_TEMPLATE rights); creating it then made a 409 or a second folder
      if (!f) f = await byPath(name);
      if (!f) {
        try { f = await core.req("folders", "POST", { name, parentId: parent }); }
        catch (e) {   // e.g. 409: another user created the same folder just now - list once more (every page) and use it
          const again = await listFolder(core, parent);
          f = pick(again.items) || (await byPath(name));
          if (!f) throw e;
        }
      }
      const real = (f && f.name) || name;   // _ArstenDocs when the old folder was taken
      cache.set("name:" + key, real); walked.push(real);
      if (!f || !f.id) throw new Error("folder not created: " + name);
      cache.set(key, f.id); parent = f.id;
      memo.set(pathKey(names.slice(0, walked.length)), f.id);   // findFolder then needs no walk (e.g. after Дейности's first save)
    }
    return parent;
  }
  // ---------- folder ids remembered per project (sweep 18.11.2026, speed) ----------
  // Дейности and Статус walked project -> root -> _AM_Docs -> Activities / Client on every open, refresh and save (3-5
  // serial calls, ~1-2 s on a site phone, before anything could be shown). Folder ids under _AM_Docs essentially never
  // change, so a found id is kept in sessionStorage "arsten.folders.v1.<projectId>" ({"": rootId, "_AM_Docs": id,
  // "_AM_Docs/Activities": id}) for the browser tab. A caller that gets 404 / 403 from a remembered folder calls
  // forgetFolder and looks it up afresh once. Without sessionStorage (node, a blocked storage) the ids are kept per Core
  // client in memory, so two clients (two test projects) never share them.
  const FOLDER_KEY = "arsten.folders.v1.";
  const memFolders = typeof WeakMap === "function" ? new WeakMap() : null;
  const sess = () => { try { return typeof sessionStorage !== "undefined" && sessionStorage ? sessionStorage : null; } catch { return null; } };
  /** {get(path), set(path, id), forget(path)}: path "" is the project root; forget also drops every deeper path. */
  function folderMemo(core, projectId) {
    const key = FOLDER_KEY + String(projectId || "");
    const s = sess();
    let mem = null;
    if (!s && memFolders && core && typeof core === "object") {
      if (!memFolders.has(core)) memFolders.set(core, new Map());
      const all = memFolders.get(core);
      if (!all.has(key)) all.set(key, {});
      mem = all.get(key);
    }
    const read = () => { if (mem) return mem; try { const o = JSON.parse((s && s.getItem(key)) || "{}"); return o && typeof o === "object" ? o : {}; } catch { return {}; } };
    const write = (o) => { if (mem) return; try { if (s) s.setItem(key, JSON.stringify(o)); } catch {} };
    return {
      get: (p) => { const v = read()[p]; return typeof v === "string" && v ? v : null; },
      set: (p, id) => { if (!id) return; const o = read(); o[p] = String(id); write(o); },
      forget: (p) => { const o = read(); for (const k of Object.keys(o)) if (k === p || (p && k.startsWith(p + "/")) || !p) delete o[k]; write(o); },
    };
  }
  const pathKey = (names) => (names || []).join("/");
  /** Drop the remembered ids of this path (and deeper) – after a 404 / 403 from a remembered folder. */
  function forgetFolder(core, projectId, names) { folderMemo(core, projectId).forget(pathKey(names)); }
  /**
   * The id of a folder path under the project root WITHOUT creating it; null when it is not there. Remembered ids are
   * used first (opts.fresh: walk anyway). Every page of each listing is read; a name missing from a listing is also
   * looked up with GET folders/by_path (sweep 18.11.2026: Connect can leave a folder the user may read out of its
   * parent's listing when the parent itself is closed to them, e.g. 01.CLIENT under _AM_Docs/Client as AM_TEMPLATE
   * recommends). By_path answering 403 -> throws an error with status 403 and noAccess true ("no access", not "no
   * report"). A name missing from a listing that may be cut off, and not found by by_path either, THROWS (code
   * "FOLDER_LISTING_CUT"): the caller must never take it for "nothing there yet" (a save would then replace a list).
   */
  async function findFolder(core, projectId, names, opts) {
    const o = opts || {}, memo = folderMemo(core, projectId);
    names = names || [];
    let start = 0, parent = null;
    if (!o.fresh) {
      for (let i = names.length; i >= 0 && !parent; i--) { const id = memo.get(pathKey(names.slice(0, i))); if (id) { parent = id; start = i; } }
    }
    if (!parent) {
      const p = await core.req(`projects/${encodeURIComponent(projectId)}`);
      parent = p && p.rootId;
      if (!parent) return null;
      memo.set("", parent); start = 0;
    }
    const walked = names.slice(0, start);
    for (let i = start; i < names.length; i++) {
      const name = names[i];
      const l = await listFolder(core, parent);
      let f = pickFolder(l.items, name);
      if (!f) {
        try {
          const g = await core.req(`folders/by_path?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent("/" + walked.concat([name]).join("/"))}`);
          if (g && g.id && (!g.type || String(g.type).toUpperCase() === "FOLDER")) f = g;
        } catch (e) {
          if (e && e.status === 403) throw Object.assign(new Error(`no access to the folder ${walked.concat([name]).join("/")}`), { status: 403, noAccess: true, cause: e });
          if (!(e && e.status === 404)) console.warn("folder lookup by path failed", e);
        }
      }
      if (!f && !l.complete) throw Object.assign(new Error(`${name} not found in a listing that may be cut off`), { code: "FOLDER_LISTING_CUT" });
      if (!f || !f.id) return null;
      walked.push(f.name || name);
      parent = f.id;
      memo.set(pathKey(names.slice(0, i + 1)), parent);
    }
    return parent;
  }
  /** Upload a JSON text as a file into a folder; returns the file id. */
  async function uploadJson(core, folderId, name, text, opts) {
    opts = opts || {};
    const f = opts.fetch || ((...a) => fetch(...a));
    const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const body = typeof Blob !== "undefined" ? new Blob([text], { type: "application/json" }) : text;
    const init = await core.req("files/fs/initiate", "POST", { parentId: folderId, parentType: "FOLDER", name });
    if (!init || !init.uploadURL) throw new Error("upload: no upload URL");
    const put = (await send(f, init.uploadURL, { method: "PUT", body, headers: { "Content-Type": "application/json" } },
      { path: "upload", what: "upload PUT", ms: opts.timeoutMs || UPLOAD_TIMEOUT_MS, sleep: opts.sleep })).res;
    if (!put.ok) throw new Error(`upload PUT ${put.status}`);
    const done = await core.req("files/fs/commit", "POST", { uploadId: init.uploadId });
    // the commit answer (its versionId) tells Дейности which version is its own (sweep 18.11.2026)
    if (typeof opts.onCommit === "function") { try { opts.onCommit(done); } catch {} }
    let id = done && (done.id || done.fileId || (done.file && done.file.id) || (done.data && done.data.id));
    for (let i = 0; !id && i < 10; i++) {   // commit can finish asynchronously: look the file up in its folder
      await sleep(800);
      const x = (await listFolder(core, folderId)).items.find((y) => y.name === name);
      if (x) id = x.id;
    }
    if (!id) throw new Error("upload: file id not returned");
    return id;
  }
  /** Browser download of the JSON (the fallback when the upload fails). Returns true when started. */
  function download(name, text, doc) {
    doc = doc || (typeof document !== "undefined" ? document : null);
    if (!doc || typeof Blob === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) return false;
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = doc.createElement("a");
    a.href = url; a.download = name; a.style.display = "none";
    doc.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return true;
  }

  /**
   * Save a snapshot: upload to _AM_Docs/Backups/<day>/; on any upload error download it in the browser instead.
   * Never throws. The caller decides whether the action goes on (see saved).
   * opts: {core, projectId, snapshot, cache?, fetch?, sleep?, download?: (name, text) => bool}
   * Returns {saved: "uploaded" | "downloaded" | "none", uploaded, downloaded, path, name, fileId?, error?}.
   * "downloaded" only means the browser download was started (a sandboxed frame can still drop it silently), so a
   * destructive action should treat anything but "uploaded" as "no safe backup".
   */
  async function save(opts) {
    const snap = opts.snapshot;
    const loc = backupPath(snap.tool, snap.action, snap.at);
    const text = toJson(snap);
    try {
      if (!opts.core) throw new Error("no Core client");
      const folderId = await ensureFolder(opts.core, opts.projectId || (snap.project && snap.project.id), loc.folder, opts.cache);
      const fileId = await uploadJson(opts.core, folderId, loc.name, text, opts);
      return { saved: "uploaded", uploaded: true, downloaded: false, path: loc.path, name: loc.name, fileId };
    } catch (e) {
      let downloaded = false;
      try { downloaded = !!(opts.download || download)(loc.name, text); } catch (e2) { console.warn("backup download failed", e2); }
      return { saved: downloaded ? "downloaded" : "none", uploaded: false, downloaded, path: loc.path, name: loc.name, error: (e && e.message) || String(e) };
    }
  }
  /** Text for the panel: " · Архив: <path>" when uploaded, the download sentence when downloaded, "Архивът НЕ е
   *  запазен" when neither; "" without a backup result. */
  function note(res, lang) {
    if (!res) return "";
    return res.uploaded ? " · " + T[lang === "en" ? "en" : "bg"].ok + res.path : " · " + failedText(lang, res);
  }
  /** The warning when the upload failed: "downloaded" wording only when a download was started (res omitted: as before). */
  function failedText(lang, res) {
    const L = T[lang === "en" ? "en" : "bg"];
    return res && !res.uploaded && !res.downloaded ? L.none : L.failed;
  }
  /** Message of the panel when a snapshot cannot be built because of another link form (checkEcho). */
  const echoText = (lang) => T[lang === "en" ? "en" : "bg"].echo;

  return { ROOT_PATH, VERSION, stamp, slug, backupPath, decodeLink, checkEcho, echoText, recordsFrom, snapshot, toJson, restorePlan, coreClient, TIMEOUT_MS, UPLOAD_TIMEOUT_MS, TIMEOUT_TEXT, send, listFolder, ensureFolder, findFolder, forgetFolder, folderMemo, uploadJson, download, save, note, failedText };
});
