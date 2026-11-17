// Arsten site photos: photos attached to model objects, shared by the Arsten 3D-viewer panels (Pour status, Assembly status).
//
// Storage (decided 13.11.2026, see side-session-notes/photos-attachments-research.md):
//  - the image: a project file in _AM_Docs/Photos/<YYYY-MM-DD>/ (Core 2.0 files/fs/initiate -> PUT -> files/fs/commit),
//    resized on the device to max 2560 px (JPEG);
//  - a record per photo in the panel's own property-set library, definition "photo",
//    link frn:entity:ARSTENPHOTO-{projectId}-{fileId}: who/when/caption/objects -> lists by day without extra calls;
//  - Connect's NATIVE object link (Core 2.0 POST /objectlink, the "Add attachment" button), so the photo also shows in
//    Connect's own Attachments panel. If Connect refuses it, the photo still works through the record.
// Pure helpers are exported for node tests; mount() needs a browser.
(function (root, factory) {
  const lib = factory();
  if (typeof module === "object" && module.exports) module.exports = lib;
  else root.ArstenPhotos = lib;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEF_ID = "photo";
  const MAX_PX = 2560, JPEG_Q = 0.85;
  // The project's tool folder is _AM_Docs (renamed from _ArstenDocs on 17.11.2026, one name for Arsten and Multiplan).
  // Lookups take _AM_Docs first and fall back to an old _ArstenDocs; only _AM_Docs is ever created.
  const DOCS = "_AM_Docs", DOCS_OLD = "_ArstenDocs";
  const pickFolder = (list, name, same) => {
    const eq = same || ((a, b) => a === b);
    const isF = (x) => !!x && String(x.type || "").toUpperCase() === "FOLDER";
    return (list || []).find((x) => isF(x) && eq(x.name, name)) || (name === DOCS ? (list || []).find((x) => isF(x) && eq(x.name, DOCS_OLD)) : undefined);
  };
  const ROOT_PATH = [DOCS, "Photos"];

  // ---------- pure ----------
  const pad = (n) => String(n).padStart(2, "0");
  const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const isoLocal = (d) => `${dayOf(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  function definition() {
    const S = { type: "string" }, B = { type: "boolean" };
    const fields = [
      ["file_id", S, "File id / Файл"], ["file_name", S, "File name / Име"], ["day", { type: "string", format: "date" }, "Day / Ден"],
      ["taken", S, "Taken / Заснета"], ["uploaded", S, "Uploaded / Качена"], ["by", S, "By / От"], ["caption", S, "Caption / Описание"],
      ["labels", S, "Pours or marks / Тактове или марки"], ["objects", S, "Objects (JSON) / Обекти"], ["links", S, "Native links / Връзки"],
      ["size", S, "Size / Размер"], ["deleted", B, "Deleted / Изтрита"], ["purpose", S, "Purpose / Цел"]];
    const props = {}, labels = {}, order = {};
    fields.forEach(([k, s, l], i) => { props[k] = s; labels[k] = l; order[k] = String(i); });
    return { id: DEF_ID, name: "Site photo / Снимка", description: "Arsten site photos (photos attached to model objects).", schema: { props },
      i18n: { "en-US": { name: "Site photo / Снимка", props: labels }, "__prop-order__": { name: "__prop-order__", props: order } } };
  }
  const photoPrefix = (projectId) => `frn:entity:ARSTENPHOTO-${projectId}-`;
  const photoLink = (projectId, fileId) => photoPrefix(projectId) + fileId;

  /** File name: 2026-11-13_1405_TAKT-3_ab12.jpg (date-time it was taken, labels, short id). */
  function fileName(taken, labels, id) {
    const lab = [...new Set(labels || [])].slice(0, 3).join("+").replace(/[^\p{L}\p{N}+]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    return `${dayOf(taken)}_${pad(taken.getHours())}${pad(taken.getMinutes())}${lab ? "_" + lab : ""}_${id}.jpg`;
  }

  /** DateTimeOriginal (or DateTime) from a JPEG's EXIF, as a local Date; null when absent. */
  function exifDate(buf) {
    try {
      const v = new DataView(buf);
      if (v.getUint16(0) !== 0xFFD8) return null;
      let off = 2;
      while (off + 4 < v.byteLength) {
        const marker = v.getUint16(off), len = v.getUint16(off + 2);
        if (marker === 0xFFE1 && v.getUint32(off + 4) === 0x45786966) return readTiff(v, off + 10);
        if ((marker & 0xFF00) !== 0xFF00) return null;
        off += 2 + len;
      }
    } catch {}
    return null;
  }
  function readTiff(v, t) {
    const le = v.getUint16(t) === 0x4949;
    const u16 = (o) => v.getUint16(t + o, le), u32 = (o) => v.getUint32(t + o, le);
    const str = (o, n) => { let s = ""; for (let i = 0; i < n - 1; i++) s += String.fromCharCode(v.getUint8(t + o + i)); return s; };
    const scan = (ifd, want) => {
      const n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12, tag = u16(e);
        if (want.includes(tag)) return { tag, cnt: u32(e + 4), val: u32(e + 8) };
      }
      return null;
    };
    const ifd0 = u32(4);
    let s = null;
    const exifPtr = scan(ifd0, [0x8769]);
    if (exifPtr) { const d = scan(exifPtr.val, [0x9003]); if (d) s = str(d.val, d.cnt); }
    if (!s) { const d = scan(ifd0, [0x0132]); if (d) s = str(d.val, d.cnt); }
    const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s || "");
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
  }

  /** Photos grouped by day, newest day first, newest photo first. Deleted ones left out; filter on labels/caption. */
  function groupByDay(records, filter) {
    const f = String(filter || "").trim().toUpperCase();
    const list = records.filter((r) => !r.deleted && (!f || `${r.labels || ""} ${r.caption || ""}`.toUpperCase().includes(f)));
    const days = new Map();
    for (const r of list) { const d = r.day || String(r.taken || "").slice(0, 10); if (!days.has(d)) days.set(d, []); days.get(d).push(r); }
    return [...days].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([day, items]) => ({ day, items: items.sort((a, b) => (String(a.taken) < String(b.taken) ? 1 : -1)) }));
  }
  /** Records that show any of these objects (by GUID). */
  function forObjects(records, guids) {
    const want = new Set(guids);
    return records.filter((r) => !r.deleted && parseObjects(r.objects).some((o) => want.has(o.guid)));
  }
  function parseObjects(s) { try { const a = JSON.parse(s || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } }
  const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

  // ---------- upload queue (week 4, A9) ----------
  // Each chosen photo is one queue item {id, name, file, ctx: {objs, caption, labels, purpose}, state, bad, done}. The
  // item keeps what it was uploaded FOR (objects, caption, purpose), so "Опитай пак" sends it to the same pours even when
  // the selection has changed since. A failed item keeps its File and whatever already went through (fileId, links), so
  // a retry continues from the failed step: a photo whose file is in Connect but whose record failed is not uploaded twice.
  // The queue lives per project for the whole page session (sessionQueue): closing and opening the panel's section or a
  // remount keeps the failed photos; a page reload loses them (the browser cannot keep File objects).
  let itemSeq = 0;
  const SESSION = new Map();   // projectId -> queue array
  function sessionQueue(projectId) {
    const k = String(projectId || "");
    if (!SESSION.has(k)) SESSION.set(k, []);
    return SESSION.get(k);
  }
  const isPhotoFile = (f) => !!f && (/^image\//.test(f.type || "") || /\.(jpe?g|png|heic|webp)$/i.test(f.name || ""));
  /** Queue items for these files (non-images dropped); ctx is shared by the batch. */
  function queueItems(files, ctx, state) {
    return [...(files || [])].filter(isPhotoFile).map((file) => ({ id: ++itemSeq, name: file.name, file, ctx, state: state || "", bad: false, done: false }));
  }
  /** Items "Опитай пак" can send again: failed, not done, with the File or an already uploaded file id; or saved but
   *  with native object links still missing for some models (round 15, L10: only those are made again). */
  const canRetry = (q) => !!q && !q.busy && ((q.bad && !q.done && !!(q.file || q.fileId)) || (q.done && !!q.linkMissing && !!q.fileId));
  const retryable = (queue) => (queue || []).filter(canRetry);
  /** Hand the uploaded photos to onUploaded (acceptance), one call per purpose and set of objects. True only when every
   *  call went through: it neither threw nor returned false (round 15, L7: the panel's guarded handler returns false
   *  instead of throwing). No handler: true. */
  async function handOver(groups, onUploaded) {
    if (!onUploaded) return true;
    let ok = true;
    for (const u of groups || []) {
      try { if ((await onUploaded(u)) === false) ok = false; }
      catch (e) { ok = false; console.warn("photos: handing over failed", e); }
    }
    return ok;
  }
  /** What the queue shows: every failed item (they must not scroll away) plus the last n others, in queue order. */
  function queueView(queue, n = 6) {
    const list = queue || [], others = list.filter((q) => !q.bad);
    const keep = new Set([...list.filter((q) => q.bad || canRetry(q)), ...others.slice(-n)]);
    return list.filter((q) => keep.has(q));
  }
  /** Done items dropped (after a while they are only noise); failed ones stay. Mutates and returns the queue. */
  function queuePrune(queue, keepDone = 6) {
    const done = queue.filter((q) => q.done && !q.linkMissing), drop = new Set(done.slice(0, Math.max(0, done.length - keepDone)));
    for (let i = queue.length - 1; i >= 0; i--) if (drop.has(queue[i])) queue.splice(i, 1);
    return queue;
  }
  /**
   * Upload one queue item, continuing after its last successful step. d: {prepare(file), folderFor(day),
   * upload(folderId, name, blob, track), links(fileId, objs), write(link, rec), projectId, user, texts {up, orig, done, fail,
   * noNative}, newId(), onProgress()}. Returns the saved record (with link) or null when it failed (item.bad, state =
   * reason; the File is kept for a retry). On success the File and image are released.
   */
  async function processItem(q, d) {
    const t = d.texts || {}, objs = q.ctx.objs || [];
    const tick = () => { if (d.onProgress) d.onProgress(q); };
    q.bad = false; q.done = false; q.busy = true; q.state = `${t.up || "…"}…`; tick();
    try {
      if (!q.fileId) {
        const img = q.img || (q.img = await d.prepare(q.file));
        q.state = `${fmtSize(img.size)} (${t.orig || ""} ${fmtSize(img.originalSize)}) – ${t.up || ""}…`; tick();
        // round 15, M3: the file name and folder are fixed ONCE per queued photo (were built again on every attempt with
        // a new random id). q.up also carries what the upload got to (started, uploadId, put), so a retry after a commit
        // that timed out or finished late finds the file already in Connect instead of uploading a second copy.
        if (!q.up) {
          const day = dayOf(img.taken);
          q.up = { day, name: fileName(img.taken, q.ctx.labels, d.newId ? d.newId() : Math.random().toString(36).slice(2, 6)), folderId: null };
        }
        if (!q.up.folderId) q.up.folderId = await d.folderFor(q.up.day);
        q.meta = { file_name: q.up.name, day: q.up.day, taken: isoLocal(img.taken), size: `${img.w}x${img.h} ${fmtSize(img.size)}` };
        q.fileId = await d.upload(q.up.folderId, q.up.name, img.blob, q.up);
      }
      if (!q.linked || q.linkMissing) {
        // round 15, L10: links are made per model; the ones made stay in the record even when a later model fails, and a
        // retry makes only the models still missing
        const doneModels = new Set(q.linkedModels || []);
        const todo = objs.filter((o) => !doneModels.has(o.modelId));
        const have = q.links || [];
        try {
          const got = (await d.links(q.fileId, todo)) || [];
          q.links = have.concat(got); todo.forEach((o) => doneModels.add(o.modelId));
          q.linkErr = ""; q.linkMissing = false;
        } catch (e) {
          q.links = have.concat((e && Array.isArray(e.links) && e.links) || []);
          ((e && Array.isArray(e.models) && e.models) || []).forEach((m) => doneModels.add(m));
          q.linkErr = (e && e.message) || String(e); q.linkMissing = true;
        }
        q.linkedModels = [...doneModels];
        q.linked = true;
      }
      const rec = Object.assign({ file_id: q.fileId }, { file_name: q.meta.file_name, day: q.meta.day, taken: q.meta.taken }, {
        uploaded: isoLocal(new Date()), by: d.user || "", caption: q.ctx.caption || "", labels: (q.ctx.labels || []).join(", "),
        objects: JSON.stringify(objs.map((o) => ({ modelId: o.modelId, guid: o.guid, label: o.label || "" }))),
        links: (q.links || []).join(","), size: q.meta.size, deleted: false, purpose: q.ctx.purpose || "" });
      const link = photoLink(d.projectId, q.fileId);
      await d.write(link, rec);
      q.done = true; q.file = null; q.img = null;
      q.state = `${t.done || "ok"}${(q.links || []).length && !q.linkMissing ? "" : " · " + (t.noNative || "") + (q.linkErr ? ` (${q.linkErr})` : "")}`;
      return Object.assign({ link }, rec);
    } catch (e) {
      q.bad = true; q.state = `${t.fail || "error"}: ${(e && e.message) || e}`;
      return null;
    } finally { q.busy = false; tick(); }
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
  function mayRetry(method, status, retryAfter) {
    if (status !== 429 && status !== 503) return false;
    return String(method).toUpperCase() !== "POST" || (status === 429 && retryAfter != null);
  }
  const parseRetryAfter = (res) => {
    let ra = null;
    try { ra = res.headers && typeof res.headers.get === "function" ? res.headers.get("Retry-After") : null; } catch {}
    return ra != null && ra !== "" && isFinite(Number(ra)) ? Number(ra) : null;
  };
  /** fetch + body text within ms; on timeout the request is aborted and an error {status: 0, timeout: true} thrown. */
  async function fetchBody(f, url, init, ms, what) {
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
        const text = typeof res.text === "function" ? await res.text()
          : typeof res.json === "function" ? JSON.stringify(await res.json()) : "";
        return { res, text };
      })(), late]);
    } finally { clearTimeout(timer); }
  }
  /** One call with timeout, 429 / 503 retry and perf. o: {path (for perf), what (for messages), ms?, tries?, sleep?}.
   *  Returns {res, text}; for a 429 / 503 left after the retries also {busy: true, retryAfter, tries}. */
  async function send(f, url, init, o) {
    const method = (init && init.method) || "GET";
    for (let tries = 1; ; tries++) {
      const p = perfLib(), h = p ? p.start("core", method, o.path) : null;
      let got;
      try { got = await fetchBody(f, url, init, o.ms || TIMEOUT_MS, o.what); }
      catch (e) { if (h) p.end(h, e && e.timeout ? "timeout" : 0); throw e; }
      if (h) p.end(h, got.res.status);
      const st = got.res.status;
      if (st !== 429 && st !== 503) return got;
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

  // ---------- Core API (browser) ----------
  /** fetchImpl, opts {timeoutMs, tries, sleep}: tests. req(path, method, body, extra): extra.headers are sent too, and
   *  with extra.full the answer is {full: true, data, status, headers} (listFolder reads the paging headers). */
  function coreClient(base, getToken, fetchImpl, opts) {
    const f = fetchImpl || ((...a) => fetch(...a));
    const o = opts || {};
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

  // ---------- folder listings: paging, and "may be cut off" (round 17 L4) ----------
  // Core 2.0 GET folders/{id}/items is called without a Range header (a non-standard Range would need Connect's CORS to
  // allow it). The answer is checked: a v2-style answer ({items, links.next.href} / skipToken / nextToken) and a legacy
  // 206 with "Content-Range: items 0-99/250" are followed page by page. A listing without paging information whose
  // length is a usual page size (PAGE_SIZES), a 206 whose range cannot be read, a "total" larger than what came, or more
  // than MAX_PAGES pages counts as "possibly incomplete" (complete: false). Callers never conclude from a name missing in
  // such a listing that a file is not there: no photo is hidden as deleted, and a retry does not read it as "not
  // uploaded" (it then uploads under the SAME name, which Connect keeps as a new version of that file, not a copy).
  const PAGE_SIZES = [50, 100, 200, 250, 500, 1000, 2000, 5000];
  const MAX_PAGES = 100;
  const itemsOf = (d) => (Array.isArray(d) ? d : d && Array.isArray(d.items) ? d.items : d && Array.isArray(d.data) ? d.data : []);
  const hdr = (h, k) => { try { return h && typeof h.get === "function" ? h.get(k) : null; } catch { return null; } };
  /** All items of a folder: {items, complete}. */
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
  const isFile = (x) => !!x && String(x.type || "FILE").toUpperCase() !== "FOLDER";
  /** Per batch (round 17 L4): each folder is listed once and shared by every photo of the batch; a name not in it lists
   *  the folder once more (a commit may have finished since), then that answer stays. find -> {id, complete}. */
  function folderLister(core) {
    const jobs = new Map();   // folderId -> {p: Promise<{byName, complete}>, refreshed}
    const load = (folderId) => listFolder(core, folderId).then(({ items, complete }) => {
      const byName = new Map();
      for (const x of items) if (isFile(x) && x.name != null && !byName.has(x.name)) byName.set(x.name, x.id);
      return { byName, complete };
    });
    const get = (folderId, fresh) => {
      let j = jobs.get(folderId);
      if (!j || fresh) {
        j = { p: load(folderId), refreshed: !!fresh || !!(j && j.refreshed) };
        const mine = j;
        j.p.catch(() => { if (jobs.get(folderId) === mine) jobs.delete(folderId); });   // a failed listing is not kept
        jobs.set(folderId, j);
      }
      return j;
    };
    async function find(folderId, name) {
      let j = get(folderId), l = await j.p;
      if (!l.byName.has(name) && !j.refreshed) { j = get(folderId, true); l = await j.p; }
      return { id: l.byName.get(name) || null, complete: l.complete };
    }
    return { find, list: (folderId) => get(folderId).p };
  }


  /**
   * Which photo files still exist. A photo deleted directly in Connect (Data explorer / Attachments) leaves our record
   * behind; such photos are hidden. Reads one folder listing per day (_AM_Docs/Photos/<day>). Returns a Set of
   * existing file ids, or null when the folders cannot be read (then nothing is hidden).
   */
  async function existingIds(core, projectId, records, o) {
    const dayOfRec = (r) => r.day || String(r.taken || "").slice(0, 10);
    const live = records.filter((r) => !r.deleted);
    const days = [...new Set(live.map(dayOfRec).filter(Boolean))];
    if (!days.length) return new Set();
    const isFolder = (x) => !!x && String(x.type).toUpperCase() === "FOLDER";
    const children = (items, name) => { const l = items.filter((x) => isFolder(x) && x.name === name); return l.length || name !== DOCS ? l : items.filter((x) => isFolder(x) && x.name === DOCS_OLD); };
    try {
      const p = await core.req(`projects/${encodeURIComponent(projectId)}`);
      let folder = { id: p.rootId };
      for (const name of ROOT_PATH) {
        const l = await listFolder(core, folder.id);
        // both _AM_Docs and an old _ArstenDocs: photos may sit in either, so nothing is known to be deleted
        if (name === DOCS && l.items.some((x) => isFolder(x) && x.name === DOCS) && l.items.some((x) => isFolder(x) && x.name === DOCS_OLD)) return null;
        folder = children(l.items, name)[0];
        if (!folder) return l.complete ? new Set() : null;   // a listing that may be cut off: unknown, nothing is hidden
      }
      const top = await listFolder(core, folder.id), out = new Set(), unsure = new Set();
      // round 17 L4: the day folders are listed 4 at a time (were one after the other). A day whose listing may be cut
      // off, or whose folder is missing from a listing that may be cut off, keeps all its photos: "deleted" needs a
      // complete listing.
      await mapLimit(days, (o && o.limit) || 4, async (day) => {
        const fs = children(top.items, day);
        if (!fs.length) { if (!top.complete) unsure.add(day); return; }
        for (const f of fs) {   // every folder of that name (a second one may have been made by hand)
          const l = await listFolder(core, f.id);
          if (!l.complete) unsure.add(day);
          for (const x of l.items) if (!isFolder(x)) out.add(x.id);
        }
      });
      for (const r of live) if (r.file_id && unsure.has(dayOfRec(r))) out.add(r.file_id);
      return out;
    } catch (e) { console.warn("photo files could not be checked", e); return null; }
  }
  /** fn over items, at most limit at once; results in input order. */
  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
    return out;
  }

  // ---------- image ----------
  async function prepareImage(file) {
    const buf = await file.slice(0, 256 * 1024).arrayBuffer();   // EXIF sits at the start; no need to read the whole photo
    const taken = exifDate(buf) || (file.lastModified ? new Date(file.lastModified) : new Date());
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); }
    catch {
      try { bmp = await createImageBitmap(file); }
      catch { throw new Error(/\.hei[cf]$/i.test(file.name) || /hei[cf]/i.test(file.type) ? "HEIC не се поддържа на този компютър – изберете JPEG / HEIC not supported here, use JPEG" : "Файлът не може да се отвори като снимка / not a readable image"); }
    }
    const k = Math.min(1, MAX_PX / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) { if (bmp.close) bmp.close(); throw new Error("Няма памет за снимката – качете по-малко наведнъж / out of memory, upload fewer at once"); }
    ctx.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", JPEG_Q));
    c.width = 0; c.height = 0;   // give the canvas memory back at once (iOS has a total canvas limit)
    if (!blob) throw new Error("Снимката не можа да се компресира – опитайте пак / could not compress the photo");
    return { blob, taken, w, h, originalSize: file.size, size: blob.size, name: file.name };
  }


  /** Lightbox zoom: click the photo for full size (scrolls, centred on the click), click again to fit. */
  function wireZoom(view) {
    if (!view) return;
    view.onclick = (e) => {
      const img = view.querySelector("img");
      if (!img || !img.naturalWidth) return;
      if (view.classList.contains("zoom")) { view.classList.remove("zoom"); return; }
      const r = img.getBoundingClientRect();
      // where in the fitted picture was clicked (object-fit: contain leaves bars around it)
      const k = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
      const w = img.naturalWidth * k, h = img.naturalHeight * k;
      const fx = Math.min(1, Math.max(0, (e.clientX - r.left - (r.width - w) / 2) / w));
      const fy = Math.min(1, Math.max(0, (e.clientY - r.top - (r.height - h) / 2) / h));
      view.classList.add("zoom");
      view.scrollLeft = fx * img.naturalWidth - view.clientWidth / 2;
      view.scrollTop = fy * img.naturalHeight - view.clientHeight / 2;
    };
  }

  // ---------- UI ----------
  const CSS = `
  .ph-drop{border:1px dashed var(--line,#d9d5cc);padding:8px;text-align:center;font-size:12px;color:var(--muted,#6b6b6b);background:var(--panel,#fff)}
  .ph-drop.on{border-color:var(--accent,#E37424);background:#fff4e5}
  .ph-day{font-size:11px;font-weight:600;color:var(--muted,#6b6b6b);margin:8px 0 3px}
  .ph-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:4px}
  .ph-th{position:relative;aspect-ratio:1;background:#ece8df;cursor:pointer;overflow:hidden;border:0;padding:0}
  .ph-th.ph-pick{outline:3px solid var(--accent,#E37424);outline-offset:-3px}
  .ph-th.ph-pick::after{content:"✓";position:absolute;top:2px;right:4px;color:#fff;background:var(--accent,#E37424);font-size:11px;padding:0 3px}
  .ph-th img{width:100%;height:100%;object-fit:cover;display:block}
  .ph-th span{position:absolute;left:0;right:0;bottom:0;background:rgba(0,0,0,.55);color:#fff;font-size:9.5px;padding:1px 3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ph-q{font-size:11px;margin-top:4px}
  .ph-box{position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:50;display:flex;flex-direction:column;padding:8px;color:#fff}

  .ph-box .ph-view{flex:1;min-height:0;overflow:hidden;display:flex;cursor:zoom-in}
  .ph-box .ph-view img{flex:1;min-height:0;min-width:0;object-fit:contain;width:100%}
  .ph-box .ph-view.zoom{display:block;overflow:auto;cursor:zoom-out}
  .ph-box .ph-view.zoom img{width:auto;height:auto;max-width:none;flex:none}
  .ph-box a.ph-open{font-size:12px;padding:2px 8px;background:#fff;color:#1f1f1f;border:1px solid #fff;text-decoration:none}
  .ph-box .ph-meta{font-size:12px;padding:6px 0}
  .ph-box .ph-acts{display:flex;gap:6px;flex-wrap:wrap;justify-content:space-between;align-items:center}
  .ph-box .ph-acts .ph-r{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}
  .ph-box button{background:#fff;color:#1f1f1f;border-color:#fff}
  .ph-box button.ph-bad{background:#b3261e;color:#fff;border-color:#b3261e}`;

  const T = {
    bg: { title: "Снимки", add: "Добави снимки", camera: "Камера", drop: "Пуснете снимки тук или изберете файлове", caption: "Описание (по избор)",
      needSel: "Изберете обект(и) в модела, за да добавите снимки към тях.", to: "Към", sel: "За избраното", all: "Всички по дни", filter: "Филтър (такт / марка)",
      none: "Няма снимки.", noneSel: "Няма снимки за избраното.", up: "Качване", done: "качена", fail: "грешка", show: "Покажи в модела", del: "Изтрий",
      delAsk: "Да се изтрие ли снимката? Това не може да се отмени.", yes: "Да, изтрий", no: "Не", close: "Затвори", orig: "оригинал",
      gone: "{n} снимки са изтрити в Connect и са скрити.", markFor: "За приемане…", pick: "Избери", pickDone: "Отказ", picked: "Избрани", apply: "Приложи", choosePurpose: "Изберете за какво (кофраж / армировка).",
      native: "Връзка в Connect", openNew: "Отвори в нов прозорец", zoom: "Щракнете за увеличение", noNative: "без връзка в Connect (само в нашия списък)", loading: "Зареждане…",
      retry: "Опитай пак", retryAll: "Опитай пак всички ({n})", drop1: "Премахни", sendNow: "Изпрати за приемане сега", sendLater: "По-късно", sendAsk: "Снимките са добавени към заявка за приемане." },
    en: { title: "Photos", add: "Add photos", camera: "Camera", drop: "Drop photos here or choose files", caption: "Caption (optional)",
      needSel: "Select object(s) in the model to add photos to them.", to: "To", sel: "For the selection", all: "All by day", filter: "Filter (pour / mark)",
      none: "No photos.", noneSel: "No photos for the selection.", up: "Uploading", done: "uploaded", fail: "failed", show: "Show in model", del: "Delete",
      delAsk: "Delete this photo? This cannot be undone.", yes: "Yes, delete", no: "No", close: "Close", orig: "original",
      gone: "{n} photos were deleted in Connect and are hidden.", markFor: "For acceptance…", pick: "Select", pickDone: "Cancel", picked: "Selected", apply: "Apply", choosePurpose: "Choose what for (formwork / rebar).",
      native: "Linked in Connect", openNew: "Open in new window", zoom: "Click to zoom", noNative: "not linked in Connect (our list only)", loading: "Loading…",
      retry: "Try again", retryAll: "Try all again ({n})", drop1: "Remove", sendNow: "Send for acceptance now", sendLater: "Later", sendAsk: "The photos were added to an acceptance request." },
  };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- upload of one file, safe to retry (round 15, M3) ----------
  /** Id of the file called name in folderId (one folder listing), or null. */
  async function findInFolder(core, folderId, name) {
    const f = (await listFolder(core, folderId)).items.find((x) => isFile(x) && x.name === name);
    return f ? f.id : null;
  }
  const commitId = (done) => done && (done.id || done.fileId || (done.file && done.file.id) || (done.data && done.data.id)) || null;
  /**
   * Upload blob as folderId/name: initiate, PUT (put(url, blob) -> Response), commit; a commit that answers without an
   * id is looked up in the folder (o.lookTries x o.lookMs, default 10 x 800 ms: commit can finish asynchronously).
   * track (the queue item's q.up, kept between attempts) records how far it got: {started, uploadId, put}. On a retry
   * (track.started) the file is first looked for under the SAME name in the same folder - a commit that timed out or
   * finished after the lookup gave up has put it there - and, when the bytes were already sent, the same upload id is
   * committed again; only when neither finds the file is a new upload started. So a retry never adds a second copy.
   * o.find(folderId, name) -> {id, complete}: the batch's folderLister (one listing per batch, round 17 L4); default:
   * one listing of the folder.
   */
  async function uploadFile(core, put, folderId, name, blob, track, o) {
    const t = track || {}, opt = o || {};
    const tries = opt.lookTries != null ? opt.lookTries : 10, ms = opt.lookMs != null ? opt.lookMs : 800;
    const look = async () => {
      for (let i = 0; i < tries; i++) { await pause(ms); const id = await findInFolder(core, folderId, name); if (id) return id; }
      return null;
    };
    if (t.started) {
      const found = opt.find ? (await opt.find(folderId, name)).id : await findInFolder(core, folderId, name);
      if (found) return found;
      if (t.uploadId && t.put) {
        let id = null;
        try { id = commitId(await core.req("files/fs/commit", "POST", { uploadId: t.uploadId })) || (await look()); }
        catch (e) { id = await findInFolder(core, folderId, name); }
        if (id) return id;
      }
      // still not found: a new upload under the SAME name. If the listing may have been cut off (listFolder complete:
      // false) the file can still be there; Connect then keeps this upload as a new version of it, not a second file.
    }
    t.started = true; t.uploadId = null; t.put = false;
    const init = await core.req("files/fs/initiate", "POST", { parentId: folderId, parentType: "FOLDER", name });
    t.uploadId = (init && init.uploadId) || null;
    const res = await put(init.uploadURL, blob);
    if (!res || !res.ok) throw new Error(`upload PUT ${res ? res.status : "?"}`);
    t.put = true;
    const done = await core.req("files/fs/commit", "POST", { uploadId: init.uploadId });
    const id = commitId(done) || (await look());
    if (!id) throw new Error("upload: file id not returned");
    return id;
  }
  /** Native object links of a file, one model at a time (getModels() -> viewer models, for the version). Returns the link
   *  ids. A failure on a later model throws an error that carries what was made before it (round 15, L10): e.links (link
   *  ids) and e.models (model ids fully linked), so the caller keeps them and retries only the rest. */
  async function linkObjects(core, getModels, fileId, objs) {
    const out = [], doneModels = [];
    let models = [];
    try { models = (await getModels()) || []; } catch {}
    const byModel = new Map();
    for (const o of objs || []) { if (!byModel.has(o.modelId)) byModel.set(o.modelId, []); byModel.get(o.modelId).push(o.guid); }
    try {
      for (const [modelId, guids] of byModel) {
        const m = models.find((x) => x.id === modelId) || {};
        const data = guids.map((g) => ({ sourceId: g, type: "BIMOBJECT" }));
        const target = { id: fileId, type: "FILE" };
        // Plain model file: source = {file id, version}. With "modelId" Connect answers 400 "Object link modelId is not
        // enabled" (live 1028, 13.11.2026); the web app adds modelId only for another kind of model, so it is the fallback.
        let r;
        try { r = await core.req("objectlink", "POST", { source: { id: modelId, versionId: m.versionId || undefined, data }, target }); }
        catch (e) { if (e.status !== 400) throw e; r = await core.req("objectlink", "POST", { source: { id: modelId, versionId: m.versionId || undefined, modelId, data }, target }); }
        const id = r && (r.id || (Array.isArray(r) && r[0] && r[0].id));
        if (id) out.push(id);
        doneModels.push(modelId);
      }
    } catch (e) {
      const err = e && typeof e === "object" ? e : new Error(String(e));
      err.links = out.slice(); err.models = doneModels.slice();
      throw err;
    }
    return out;
  }

  /**
   * Mount the Photos section.
   * opts: el, api (Workspace API), getToken(refresh), coreBase, project {id}, user (display name), client (PsetClient), libId,
   *       canAdd, canDeleteAny, lang ("bg"|"en"), targets(): [{modelId, id, guid, label}] (current selection),
   *       onStatus(text, bad), purposes: [{id, bg, en}] (optional upload purposes besides "general"),
   *       onUploaded({purpose, fileIds, objects}) (optional; after each batch with a purpose, and when existing photos
   *       are marked for a purpose afterwards – from the photo viewer or with "Избери" on several photos),
   *       sendNow() (optional, A9; after photos for a purpose were uploaded, a button "Изпрати за приемане сега" calls it –
   *       the panel's own send function)
   */
  function mount(opts) {
    const L = () => T[opts.lang === "en" ? "en" : "bg"];
    // round 19 L5: day headings in the shared date format (BG DD.MM.YYYY), not the stored ISO day
    const dayText = (d, time) => {
      const g = typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : {};
      const I = g.ArstenI18n;
      if (I && typeof I.fmtDate === "function") { const x = I.fmtDate(d, opts.lang === "en" ? "en" : "bg", time ? { time: true } : undefined); if (x) return x; }
      const m = /^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d:\d\d))?/.exec(String(d || ""));
      return m ? `${m[3]}.${m[2]}.${m[1]}${time && m[4] ? " " + m[4] : ""}` : String(d || "");
    };
    const core = opts.core || coreClient(opts.coreBase, opts.getToken);
    const st = { records: [], view: "sel", filter: "", queue: sessionQueue(opts.project && opts.project.id), offerSend: false, urls: new Map(), folders: new Map(), loaded: false, open: null, confirm: false, picking: false, picked: new Set() };
    const say = (t, bad) => opts.onStatus && opts.onStatus(t, bad);
    if (!document.getElementById("ph-css")) { const s = document.createElement("style"); s.id = "ph-css"; s.textContent = CSS; document.head.appendChild(s); }

    async function load() {
      try { await opts.client.ensureDefinition(opts.libId, definition()); } catch (e) { if (e.status !== 403) throw e; }
      const m = await opts.client.listAll(opts.libId, DEF_ID, photoPrefix(opts.project.id));
      st.records = [...m].map(([link, p]) => Object.assign({ link }, p));
      st.loaded = true;
      render();
      // photos whose file was deleted in Connect itself are hidden (our record stays, marked "gone" only here)
      const exist = await existingIds(core, opts.project.id, st.records);
      if (exist) {
        let gone = 0;
        for (const r of st.records) if (!r.deleted && r.file_id && !exist.has(r.file_id)) { r.deleted = true; r.gone = true; gone++; }
        if (gone) { say(L().gone.replace("{n}", gone)); render(); }
      }
    }

    // folders _AM_Docs/Photos/<day>, created when missing
    const folderJobs = new Map();
    function folderFor(day) {   // memoised as a promise: parallel uploads of the same day share one lookup / create
      if (!folderJobs.has(day)) folderJobs.set(day, folderLookup(day).catch((e) => { folderJobs.delete(day); throw e; }));
      return folderJobs.get(day);
    }
    async function folderLookup(day) {
      if (st.folders.has(day)) return st.folders.get(day);
      let parent = st.rootId;
      if (!parent) { const p = await core.req(`projects/${encodeURIComponent(opts.project.id)}`); parent = st.rootId = p.rootId; }
      for (const name of [...ROOT_PATH, day]) {
        const key = parent + "/" + name;
        if (st.folders.has(key)) { parent = st.folders.get(key); continue; }
        const items = (await listFolder(core, parent)).items;   // every page (round 17 L4)
        let f = pickFolder(items, name);
        if (!f) f = await core.req("folders", "POST", { name, parentId: parent });
        st.folders.set(key, f.id); parent = f.id;
      }
      st.folders.set(day, parent);
      return parent;
    }

    const putBlob = (url, blob) => send((...a) => fetch(...a), url, { method: "PUT", body: blob, headers: { "Content-Type": "image/jpeg" } },
      { path: "upload", what: "upload PUT", ms: UPLOAD_TIMEOUT_MS }).then((x) => x.res);
    const uploadWith = (lister) => (folderId, name, blob, track) => uploadFile(core, putBlob, folderId, name, blob, track, { find: lister.find });

    const nativeLinks = (fileId, objs) => linkObjects(core, async () => (await opts.api.viewer.getModels()) || [], fileId, objs);

    const deps = (lister) => ({ prepare: prepareImage, folderFor, upload: uploadWith(lister), links: nativeLinks,
      write: (link, rec) => opts.client.write(opts.libId, DEF_ID, link, rec), projectId: opts.project.id, user: opts.user, texts: L(),
      onProgress: () => render() });
    /** Upload these queue items one by one; then each purpose's photos go to onUploaded (acceptance) per set of objects. */
    async function runItems(items) {
      const byKey = new Map();   // purpose + objects -> {purpose, objects, fileIds}
      const d = deps(folderLister(core));   // round 17 L4: each day folder is listed once for the whole batch, not per photo
      for (const q of items) {
        const linkOnly = q.done;   // a saved photo whose missing native links are made again (L10): not handed over again
        const rec = await processItem(q, d);
        if (!rec) continue;
        const at = st.records.findIndex((r) => r.file_id === rec.file_id);
        if (at < 0) st.records.push(rec); else if (linkOnly) Object.assign(st.records[at], rec);
        const p = q.ctx.purpose;
        if (!p || linkOnly) continue;
        const k = p + "|" + (q.ctx.objs || []).map((o) => o.guid).sort().join(",");
        if (!byKey.has(k)) byKey.set(k, { purpose: p, objects: q.ctx.objs, fileIds: [] });
        byKey.get(k).fileIds.push(rec.file_id);
      }
      queuePrune(st.queue);
      render();
      const handed = await handOver([...byKey.values()], opts.onUploaded);
      // A9: photos for acceptance went in -> offer to send the request at once (the panel's own send function).
      // Round 15, L7: only when attaching them to the request(s) succeeded.
      if (byKey.size && opts.sendNow && handed) { st.offerSend = true; render(); }
    }
    async function addFiles(files) {
      const objs = opts.targets();
      if (!objs.length) return say(L().needSel, true);
      const caption = ((opts.el.querySelector(".ph-cap") || {}).value || "").trim();
      const labels = [...new Set(objs.map((o) => o.label).filter(Boolean))];
      const purpose = ((opts.el.querySelector(".ph-purpose") || {}).value || "");
      const mine = queueItems(files, { objs, caption, labels, purpose }, L().up + "…");
      st.queue.push(...mine);
      st.caption = "";
      st.offerSend = false;
      render();
      await runItems(mine);
    }
    async function retry(id) {
      const items = retryable(st.queue).filter((q) => id == null || q.id === id);
      if (items.length) await runItems(items);
    }
    function dropItem(id) {
      const i = st.queue.findIndex((q) => q.id === id && (q.bad || q.linkMissing) && !q.busy);
      if (i >= 0) st.queue.splice(i, 1);
      render();
    }

    async function urlOf(r) {
      if (st.urls.has(r.file_id)) return st.urls.get(r.file_id);
      const p = core.req(`files/fs/${encodeURIComponent(r.file_id)}/downloadurl`).then((d) => (d && (d.url || d.downloadUrl || d.href)) || "")
        .catch((e) => { st.urls.delete(r.file_id); throw e; });
      st.urls.set(r.file_id, p);
      return p;
    }

    async function showInModel(r) {
      const objs = parseObjects(r.objects);
      const byModel = new Map();
      for (const o of objs) { if (!byModel.has(o.modelId)) byModel.set(o.modelId, []); byModel.get(o.modelId).push(o.guid); }
      const sel = [];
      for (const [modelId, guids] of byModel) {
        try { const ids = ((await opts.api.viewer.convertToObjectRuntimeIds(modelId, guids)) || []).filter((x) => x != null); if (ids.length) sel.push({ modelId, objectRuntimeIds: ids }); } catch {}
      }
      if (!sel.length) return say(opts.lang === "en" ? "The photo's objects are not in the loaded models." : "Обектите на снимката не са в заредените модели.", true);
      await opts.api.viewer.setSelection({ modelObjectIds: sel }, "set");
      try { await opts.api.viewer.setCamera({ modelObjectIds: sel }, { animationTime: 400 }); } catch {}
    }

    async function remove(r) {
      for (const id of String(r.links || "").split(",").filter(Boolean)) { try { await core.req(`objectlink/${encodeURIComponent(id)}`, "DELETE"); } catch {} }
      try { await core.req(`files/${encodeURIComponent(r.file_id)}`, "DELETE"); } catch (e) { if (e.status !== 404) throw e; }
      const rec = Object.assign({}, r, { deleted: true, links: "" }); delete rec.link;   // full record (see ArstenAcceptance.full)
      await opts.client.write(opts.libId, DEF_ID, r.link, rec);
      r.deleted = true;
      st.open = null; st.confirm = false;
      render();
    }
    /** Existing photos -> a purpose (e.g. acceptance). Each photo keeps its own objects, so it joins its own pour's request. */
    async function mark(recs, purpose) {
      if (!purpose || !recs.length) return;
      for (const r of recs) {
        const rec = Object.assign({}, r, { purpose }); delete rec.link;
        await opts.client.write(opts.libId, DEF_ID, r.link, rec);
        r.purpose = purpose;
      }
      if (opts.onUploaded) {
        const byKey = new Map();   // one call per set of objects, so photos of different pours stay apart
        for (const r of recs) {
          const objs = parseObjects(r.objects).map((o) => ({ modelId: o.modelId, guid: o.guid, label: o.label || r.labels || "" }));
          const k = objs.map((o) => o.guid).sort().join(",");
          if (!byKey.has(k)) byKey.set(k, { objects: objs, fileIds: [] });
          byKey.get(k).fileIds.push(r.file_id);
        }
        for (const g of byKey.values()) await opts.onUploaded({ purpose, fileIds: g.fileIds, objects: g.objects });
      }
      st.picking = false; st.picked.clear();
      render();
    }
    const markSelect = (cls) => `<select class="${cls}"><option value="">${esc(L().markFor)}</option>${(opts.purposes || []).map((p) => `<option value="${esc(p.id)}">${esc(opts.lang === "en" ? p.en : p.bg)}</option>`).join("")}</select>`;
    const canDelete = (r) => opts.canDeleteAny || (opts.canAdd && r.by && r.by === opts.user);

    function thumbs(items) {
      return `<div class="ph-grid">${items.map((r) => `<button class="ph-th${st.picked.has(r.file_id) ? " ph-pick" : ""}" data-ph="${esc(r.file_id)}" title="${esc(r.caption || r.labels)}"><img alt="" data-src="${esc(r.file_id)}"><span>${esc((r.taken || "").slice(11, 16))} ${esc(r.labels)}</span></button>`).join("")}</div>`;
    }

    function render() {
      const l = L(), objs = opts.targets();
      const guids = objs.map((o) => o.guid);
      let body;
      if (!st.loaded) body = `<div class="sub">${l.loading}</div>`;
      else if (st.view === "sel") {
        const list = forObjects(st.records, guids);
        body = !guids.length ? `<div class="sub">${l.needSel}</div>` : list.length ? groupByDay(list).map((g) => `<div class="ph-day">${esc(dayText(g.day))}</div>${thumbs(g.items)}`).join("") : `<div class="sub">${l.noneSel}</div>`;
      } else {
        const groups = groupByDay(st.records, st.filter);
        body = groups.length ? groups.map((g) => `<div class="ph-day">${esc(dayText(g.day))} · ${g.items.length}</div>${thumbs(g.items)}`).join("") : `<div class="sub">${l.none}</div>`;
      }
      const labels = [...new Set(objs.map((o) => o.label).filter(Boolean))];
      opts.el.innerHTML = `
        ${opts.canAdd ? `<div class="ph-drop">${objs.length ? `<div>${l.to}: <b>${esc(labels.join(", ") || objs.length)}</b> (${objs.length})</div>` : `<div>${l.needSel}</div>`}
          <div>${l.drop}</div>
          ${(opts.purposes || []).length ? `<div class="bar" style="justify-content:center"><select class="ph-purpose"><option value="">${opts.lang === "en" ? "General" : "Обща"}</option>${opts.purposes.map((p) => `<option value="${esc(p.id)}"${st.purpose === p.id ? " selected" : ""}>${esc(opts.lang === "en" ? p.en : p.bg)}</option>`).join("")}</select></div>` : ""}
          <div class="bar" style="justify-content:center"><input type="text" class="ph-cap" placeholder="${esc(l.caption)}" value="${esc(st.caption || "")}" style="flex:1;min-width:120px">
            <label class="small" style="border:1px solid var(--line,#d9d5cc);padding:2px 7px;cursor:pointer">${l.add}<input type="file" class="ph-file" accept="image/*" multiple hidden></label>
            <label class="small" style="border:1px solid var(--line,#d9d5cc);padding:2px 7px;cursor:pointer">${l.camera}<input type="file" class="ph-cam" accept="image/*" capture="environment" hidden></label></div>
          ${queueHtml()}</div>` : ""}
        <div class="bar"><button class="small ${st.view === "sel" ? "" : "secondary"}" data-phv="sel">${l.sel}</button><button class="small ${st.view === "all" ? "" : "secondary"}" data-phv="all">${l.all}</button>
          ${st.view === "all" ? `<input type="text" class="ph-filter" placeholder="${esc(l.filter)}" value="${esc(st.filter)}" style="flex:1;min-width:90px">` : ""}
          ${opts.canAdd && (opts.purposes || []).length ? `<button class="small ${st.picking ? "" : "secondary"}" data-phpick="1">${st.picking ? l.pickDone : l.pick}</button>` : ""}</div>
        ${st.picking ? `<div class="bar"><span class="sub">${l.picked}: ${st.picked.size}</span>${markSelect("ph-markmany")}<button class="small" data-phapply="1"${st.picked.size ? "" : " disabled"}>${l.apply}</button></div>` : ""}
        <div class="ph-list">${body}</div>
        ${st.open ? box(st.open) : ""}`;
      wire();
      opts.el.querySelectorAll("img[data-src]").forEach((img) => { const r = st.records.find((x) => x.file_id === img.dataset.src); if (r) urlOf(r).then((u) => { if (!u) return; img.src = u; const a = img.closest(".ph-box") && opts.el.querySelector(".ph-open"); if (a) { a.href = u; a.style.opacity = ""; a.style.pointerEvents = ""; } }).catch(() => {}); });
      wireZoom(opts.el.querySelector(".ph-view"));
    }
    function queueHtml() {
      const l = L(), again = retryable(st.queue);
      const rows = queueView(st.queue).map((q) => `<div class="${q.bad ? "bad" : "sub"}">${esc(q.name)}: ${esc(q.state)}${canRetry(q)
        ? ` <button class="small" data-phretry="${q.id}">${l.retry}</button> <button class="small secondary" data-phdrop="${q.id}">${l.drop1}</button>` : ""}</div>`).join("");
      const many = again.length > 1 ? `<div class="bar" style="justify-content:center"><button class="small" data-phretry="all">${l.retryAll.replace("{n}", again.length)}</button></div>` : "";
      const offer = st.offerSend && opts.sendNow ? `<div class="bar" style="justify-content:center"><span class="sub">${l.sendAsk}</span><button class="small" data-phsend="1">${l.sendNow}</button><button class="small secondary" data-phsend="0">${l.sendLater}</button></div>` : "";
      return (rows || many ? `<div class="ph-q">${rows}${many}</div>` : "") + offer;
    }
    function box(r) {
      const l = L();
      return `<div class="ph-box"><div class="ph-view" title="${esc(L().zoom)}"><img alt="" data-src="${esc(r.file_id)}"></div>
        <div class="ph-meta"><b>${esc(r.labels)}</b>${r.purpose ? ` · ${esc(((opts.purposes || []).find((p) => p.id === r.purpose) || {})[opts.lang === "en" ? "en" : "bg"] || r.purpose)}` : ""}${r.caption ? " – " + esc(r.caption) : ""}<br>${esc(dayText(r.taken, true))} · ${esc(r.by)} · ${esc(r.size)} · ${r.links ? l.native : l.noNative}</div>
        <div class="ph-acts">${st.confirm ? `<span>${l.delAsk}</span><button class="small ph-bad" data-pha="yes">${l.yes}</button><button class="small" data-pha="no">${l.no}</button>`
          : `${canDelete(r) ? `<button class="small ph-bad" data-pha="del">${l.del}</button>` : ""}<span class="ph-r">${opts.canAdd && (opts.purposes || []).length ? markSelect("ph-markone") : ""}<a class="ph-open" target="_blank" rel="noopener" style="opacity:.5;pointer-events:none">${l.openNew}</a><button class="small" data-pha="show">${l.show}</button><button class="small" data-pha="close">${l.close}</button></span>`}</div></div>`;
    }
    function wire() {
      const el = opts.el, g = (fn) => () => Promise.resolve().then(fn).catch((e) => say(e.message, true));
      const pick = (inp) => { if (inp) inp.onchange = (e) => { const f = [...e.target.files]; e.target.value = ""; g(() => addFiles(f))(); }; };
      pick(el.querySelector(".ph-file")); pick(el.querySelector(".ph-cam"));
      const cap = el.querySelector(".ph-cap");
      if (cap) cap.oninput = () => { st.caption = cap.value; };
      const pu = el.querySelector(".ph-purpose");
      if (pu) pu.onchange = () => { st.purpose = pu.value; };
      const drop = el.querySelector(".ph-drop");
      if (drop) {
        drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("on"); };
        drop.ondragleave = () => drop.classList.remove("on");
        drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("on"); const f = [...(e.dataTransfer.files || [])]; g(() => addFiles(f))(); };
      }
      el.querySelectorAll("[data-phretry]").forEach((b) => { b.onclick = g(() => retry(b.dataset.phretry === "all" ? null : +b.dataset.phretry)); });
      el.querySelectorAll("[data-phdrop]").forEach((b) => { b.onclick = () => dropItem(+b.dataset.phdrop); });
      el.querySelectorAll("[data-phsend]").forEach((b) => { b.onclick = g(async () => {
        st.offerSend = false; render();
        if (b.dataset.phsend === "1") await opts.sendNow();
      }); });
      el.querySelectorAll("[data-phv]").forEach((b) => { b.onclick = () => { st.view = b.dataset.phv; render(); }; });
      const fl = el.querySelector(".ph-filter");
      if (fl) fl.oninput = () => { st.filter = fl.value; const pos = fl.selectionStart; render(); const n = opts.el.querySelector(".ph-filter"); if (n) { n.focus(); n.setSelectionRange(pos, pos); } };
      el.querySelectorAll("[data-ph]").forEach((b) => { b.onclick = () => {
        if (st.picking) { const id = b.dataset.ph; if (st.picked.has(id)) st.picked.delete(id); else st.picked.add(id); render(); return; }
        st.open = st.records.find((x) => x.file_id === b.dataset.ph); st.confirm = false; render(); }; });
      const pk = el.querySelector("[data-phpick]");
      if (pk) pk.onclick = () => { st.picking = !st.picking; st.picked.clear(); render(); };
      const ap = el.querySelector("[data-phapply]");
      if (ap) ap.onclick = g(async () => {
        const purpose = (el.querySelector(".ph-markmany") || {}).value;
        if (!purpose) return say(L().choosePurpose, true);
        await mark(st.records.filter((r) => st.picked.has(r.file_id)), purpose);
      });
      const one = el.querySelector(".ph-markone");
      if (one) one.onchange = g(async () => { if (one.value && st.open) await mark([st.open], one.value); });
      el.querySelectorAll("[data-pha]").forEach((b) => {
        b.onclick = g(async () => {
          const a = b.dataset.pha, r = st.open;
          if (a === "close") { st.open = null; render(); }
          else if (a === "show") { await showInModel(r); }
          else if (a === "del") { st.confirm = true; render(); }
          else if (a === "no") { st.confirm = false; render(); }
          else if (a === "yes") await remove(r);
        });
      });
    }

    load().catch((e) => { st.loaded = true; render(); say(e.message, true); });
    render();
    return { render, reload: load, state: st, retry };
  }

  return { DEF_ID, sessionQueue, queueItems, retryable, canRetry, handOver, uploadFile, linkObjects, findInFolder, listFolder, folderLister, mapLimit, PAGE_SIZES, queueView, queuePrune, processItem, wireZoom, existingIds, definition, photoPrefix, photoLink, fileName, exifDate, groupByDay, forObjects, parseObjects, fmtSize, coreClient, TIMEOUT_MS, UPLOAD_TIMEOUT_MS, TIMEOUT_TEXT, prepareImage, mount };
});
