// Arsten site photos: photos attached to model objects, shared by the Arsten 3D-viewer panels (Pour status, Assembly status).
//
// Storage (decided 13.11.2026, see side-session-notes/photos-attachments-research.md):
//  - the image: a project file in _AM_Docs/Photos/<YYYY-MM-DD>/ (Core 2.0 files/fs/initiate -> PUT -> files/fs/commit),
//    resized on the device to max 2560 px (JPEG), plus a ~320 px thumbnail <name>_t.jpg next to it (sweep 18.11.2026:
//    the grids load ~25 KB thumbnails, not the 1 MB photo; records without thumb_id fall back to the photo);
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
  const THUMB_PX = 320, THUMB_Q = 0.7;   // sweep 18.11.2026: ~20-30 KB per grid thumbnail
  const URL_POOL = 4;
  // Speed sweep 18.11.2026: "Всички по дни" drew every photo of the project (thousands of tiles, every day folder checked)
  // and rebuilt on every filter key. It now draws the newest ALL_DAYS days, "По-стари дни" adds ALL_DAYS more, only the
  // days drawn are checked, and the filter applies FILTER_MS after the last key.
  const ALL_DAYS = 7, FILTER_MS = 250;   // download URLs asked at once (as Дейности): 200 photos no longer fire 200 Core calls together
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
      ["size", S, "Size / Размер"], ["deleted", B, "Deleted / Изтрита"], ["purpose", S, "Purpose / Цел"], ["thumb_id", S, "Thumbnail / Миниатюра"]];
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

  /** Name of a photo's thumbnail: the photo's name with _t before .jpg (same day folder). */
  const thumbName = (name) => String(name || "").replace(/(\.jpe?g)?$/i, "_t.jpg");

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
  // remount keeps the failed photos. A page reload no longer loses them once prepared: see pendingStore (IndexedDB,
  // sweep 18.11.2026); a photo still waiting for preparation (seconds) is only in the unsent note.
  let itemSeq = 0;
  const SESSION = new Map();   // projectId -> queue array
  function sessionQueue(projectId) {
    const k = String(projectId || "");
    if (!SESSION.has(k)) SESSION.set(k, []);
    return SESSION.get(k);
  }
  // Speed sweep 18.11.2026: a batch went up strictly one photo after another (~9 calls each, mostly idle waits on site
  // latency). Now UPLOAD_POOL photos go up at once, and the next photo is decoded and resized while the one before is on
  // the network. Only ONE image is prepared at a time (oneAtATime around prepareImage): iOS has a total canvas memory
  // limit, and with the pool at 2 at most 2 prepared JPEGs are alive (a saved photo releases its image at once).
  const UPLOAD_POOL = 2;
  /** fn, but a call starts only when the one before has finished (results and errors as fn's). */
  function oneAtATime(fn) {
    let last = Promise.resolve();
    return (...a) => {
      const run = last.then(() => fn(...a));
      last = run.catch(() => {});
      return run;
    };
  }
  const isPhotoFile = (f) => !!f && (/^image\//.test(f.type || "") || /\.(jpe?g|png|heic|webp)$/i.test(f.name || ""));
  const newUid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  /** Queue items for these files (non-images dropped); ctx is shared by the batch. uid: the item's key on the device
   *  (pendingStore), unique across pages. */
  function queueItems(files, ctx, state) {
    return [...(files || [])].filter(isPhotoFile).map((file) => ({ id: ++itemSeq, uid: newUid(), name: file.name, file, ctx, state: state || "", bad: false, done: false }));
  }

  // ---------- photos kept on the device until they are saved (sweep 18.11.2026) ----------
  // The queue above lives in page memory: a phone reloading Connect's iframe on poor signal, or a closed tab, lost every
  // photo taken but not uploaded (the unsent note only said so). Now each photo, once prepared (the ~1 MB JPEG and its
  // thumbnail, not the original), is kept in IndexedDB "arsten-photos" / "pending" with what it was for (objects,
  // caption, purpose) and how far its upload got (q.up, fileId…), keyed by project + uid; it is deleted when its record
  // is saved or the user drops it. The next mount of that project offers "N снимки чакат качване – Изпрати / Отказ".
  // Every IndexedDB call is wrapped: no IndexedDB (private window, blocked storage) = the in-memory queue as before.
  const IDB_NAME = "arsten-photos", IDB_STORE = "pending";
  const IMG_KEYS = ["blob", "thumb", "taken", "w", "h", "size", "originalSize", "name"];
  // Security sweep 18.11.2026: site phones and tablets are shared. A kept photo now carries who prepared it (q.who: the
  // Connect user id or e-mail, never the display name) and is offered only to that user; another user of the device
  // only sees that photos of someone else wait here (they are never sent under the wrong name, which also handed over
  // the "own photo" delete right). Kept photos older than PENDING_MAX_AGE_MS are deleted on the next mount, so site
  // photos do not stay on a shared device for ever. A record from before this change (no who) is offered as before.
  const PENDING_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
  /** The kept records of a project split for the user `who`: {mine, others, old} (old: past maxAge, to delete). */
  function splitPending(list, who, now, maxAge) {
    const t = now == null ? Date.now() : now, age = maxAge || PENDING_MAX_AGE_MS, me = String(who || "").toLowerCase();
    const out = { mine: [], others: [], old: [] };
    for (const x of list || []) {
      if (!x) continue;
      if (!(t - Number(x.at) < age)) out.old.push(x);
      else if (!x.who || (me && String(x.who).toLowerCase() === me)) out.mine.push(x);
      else out.others.push(x);
    }
    return out;
  }
  /** What is kept of a queue item (the File itself is not: the prepared JPEG is). */
  function pendingRecord(projectId, q) {
    const pick = (o, keys) => { const x = {}; for (const k of keys) if (o && o[k] !== undefined) x[k] = o[k]; return x; };
    const ctx = q.ctx || {};
    return { key: String(projectId || "") + ":" + q.uid, pid: String(projectId || ""), uid: q.uid, name: q.name, at: q.keptAt || (q.keptAt = Date.now()), who: q.who || "",
      ctx: { objs: (ctx.objs || []).map((o) => pick(o, ["modelId", "id", "guid", "label"])), caption: ctx.caption || "", labels: ctx.labels || [], purpose: ctx.purpose || "" },
      img: q.img ? pick(q.img, IMG_KEYS) : null, up: q.up ? Object.assign({}, q.up) : null, upThumb: q.upThumb ? Object.assign({}, q.upThumb) : null,
      fileId: q.fileId || null, thumbId: q.thumbId || null, thumbTried: !!q.thumbTried, meta: q.meta || null };
  }
  /** A queue item again from a kept record: failed state, so "Опитай пак" / runItems sends it on from where it got to. */
  function fromPending(rec, state) {
    return { id: ++itemSeq, uid: rec.uid, name: rec.name, file: rec.img ? rec.img.blob : null, img: rec.img || null, ctx: rec.ctx || { objs: [] },
      up: rec.up || undefined, upThumb: rec.upThumb || undefined, fileId: rec.fileId || undefined, thumbId: rec.thumbId || undefined,
      thumbTried: !!rec.thumbTried, meta: rec.meta || undefined, who: rec.who || undefined, keptAt: rec.at || undefined, state: state || "", bad: true, done: false, restored: true };
  }
  /** {put(projectId, q), del(projectId, uid), all(projectId)}: never throws (a failure is a console.warn and no-op).
   *  idb: an IndexedDB factory (tests pass a fake); default the browser's. */
  function pendingStore(idb) {
    let factory = idb;
    if (factory === undefined) { try { factory = typeof indexedDB !== "undefined" ? indexedDB : null; } catch { factory = null; } }
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      if (!factory) return rej(new Error("no IndexedDB"));
      const r = factory.open(IDB_NAME, 1);
      r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: "key" }); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error || new Error("IndexedDB open failed"));
    }).catch((e) => { dbp = null; throw e; }));
    const run = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const tx = db.transaction(IDB_STORE, mode), r = fn(tx.objectStore(IDB_STORE));
        tx.oncomplete = () => res(r && r.result);
        tx.onerror = () => rej(tx.error || new Error("IndexedDB failed"));
        tx.onabort = () => rej(tx.error || new Error("IndexedDB aborted"));
      });
    };
    const safe = (p, dflt) => p.catch((e) => { if (factory) console.warn("photos: device store", e); return dflt; });
    return {
      available: () => !!factory,
      put: (projectId, q) => (q && q.uid && (q.img || q.fileId) ? safe(run("readwrite", (s) => s.put(pendingRecord(projectId, q))), null) : Promise.resolve(null)),
      del: (projectId, uid) => (uid ? safe(run("readwrite", (s) => s.delete(String(projectId || "") + ":" + uid)), null) : Promise.resolve(null)),
      all: (projectId) => safe(run("readonly", (s) => s.getAll()).then((l) => (l || []).filter((x) => x && x.pid === String(projectId || ""))), []),
    };
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
  // ---------- photos not sent when the page went away (sweep 18.11.2026) ----------
  // The queue lives in page memory only. Closing Connect's side panel, switching tools or the phone killing the app
  // during a slow upload lost every photo not saved yet, with no trace on the next open. Now a small note per project
  // ({count, labels, at}; no photos, no names) is kept in localStorage "arsten.photos.unsent.v1.<projectId>" while
  // photos wait, upload or failed, written on every queue change and on pagehide / visibilitychange; the next mount in a
  // NEW page shows it once ("3 снимки не бяха изпратени последния път (Такт 5) – изберете ги отново"). Дейности can use
  // the same note (noteUnsent / takeUnsent / unsentText) for photos uploaded for an entry that was not saved.
  const UNSENT_KEY = "arsten.photos.unsent.v1.";
  const local = () => { try { return typeof localStorage !== "undefined" && localStorage ? localStorage : null; } catch { return null; } };
  /** The unfinished items of a queue (waiting, uploading or failed; not the saved ones) plus files waiting for a selection. */
  function unsentOf(queue, pending) {
    const list = (queue || []).filter((q) => q && !q.done);
    const labels = [...new Set(list.flatMap((q) => (q.ctx && q.ctx.labels) || []))].slice(0, 6);
    return { count: list.length + ((pending && pending.length) || 0), labels };
  }
  /** Keep (count > 0) or clear (count 0) the note of a project. storage: tests. */
  function noteUnsent(projectId, info, storage) {
    const s = storage || local();
    if (!s) return;
    const key = UNSENT_KEY + String(projectId || "");
    try {
      if (info && info.count > 0) s.setItem(key, JSON.stringify({ count: info.count, labels: (info.labels || []).slice(0, 6), at: info.at || new Date().toISOString() }));
      else s.removeItem(key);
    } catch {}
  }
  /** The note left by an earlier page (and cleared, so it is shown once), or null. */
  function takeUnsent(projectId, storage) {
    const s = storage || local();
    if (!s) return null;
    const key = UNSENT_KEY + String(projectId || "");
    try {
      const o = JSON.parse(s.getItem(key) || "null");
      s.removeItem(key);
      return o && o.count > 0 ? o : null;
    } catch { return null; }
  }
  /** "3 снимки не бяха изпратени последния път (Такт 5) – изберете ги отново." */
  function unsentText(note, lang) {
    const l = T[lang === "en" ? "en" : "bg"];
    const w = note.labels && note.labels.length ? ` (${note.labels.join(", ")})` : "";
    return (note.count === 1 ? l.unsent1 : l.unsentN).replace("{n}", note.count).replace("{w}", w);
  }
  /** "4 снимки за Т-12, Т-13 чакат качване (от предишно отваряне)." for the kept records (sweep 18.11.2026: the line did
   *  not say which pours, so "Изпрати" was a guess). l: the texts (T.bg / T.en) or a language. At most 4 pours, then "…". */
  function keptText(list, l) {
    const t = typeof l === "string" || !l ? T[l === "en" ? "en" : "bg"] : l, n = (list || []).length;
    const labels = [...new Set((list || []).flatMap((x) => (x && x.ctx && x.ctx.labels) || []).map(String).filter(Boolean))];
    const p = labels.length ? t.keptFor + labels.slice(0, 4).join(", ") + (labels.length > 4 ? ", …" : "") : "";
    return (n === 1 ? t.kept1 : t.keptN).replace("{n}", n).replace("{p}", p);
  }
  // one set of page listeners for every mounted pane: projectId -> () => {count, labels, running}
  const WATCH = new Map();
  let watching = false;
  function watchPage() {
    if (watching || typeof window === "undefined" || !window.addEventListener) return;
    watching = true;
    const flush = () => { for (const [pid, get] of WATCH) { try { noteUnsent(pid, get()); } catch {} } };
    window.addEventListener("pagehide", flush);
    if (typeof document !== "undefined" && document.addEventListener) document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
    window.addEventListener("beforeunload", (e) => {
      flush();
      // the browser's own "leave the page?" prompt while photos are on their way (where the browser shows one)
      if ([...WATCH.values()].some((get) => { try { return get().running; } catch { return false; } })) { e.preventDefault(); e.returnValue = ""; return ""; }
    });
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
        if (!q.keptOnDevice && d.keep) { q.keptOnDevice = true; d.keep(q); }   // kept until saved (pendingStore)
        if (!q.up.folderId) q.up.folderId = await d.folderFor(q.up.day);
        q.meta = { file_name: q.up.name, day: q.up.day, taken: isoLocal(img.taken), size: `${img.w}x${img.h} ${fmtSize(img.size)}` };
        try { q.fileId = await d.upload(q.up.folderId, q.up.name, img.blob, q.up); }
        catch (e) {
          // sweep 18.11.2026: the day folder (a remembered id) was deleted or moved in Connect: initiate answers 404 / 403
          // before anything went up -> forget it, look the folder up once more and upload there
          if (!(e && (e.status === 404 || e.status === 403) && !q.up.uploadId && d.forgetFolder)) throw e;
          d.forgetFolder(q.up.day);
          q.up.folderId = await d.folderFor(q.up.day);
          q.up.started = false;
          q.fileId = await d.upload(q.up.folderId, q.up.name, img.blob, q.up);
        }
      }
      // sweep 18.11.2026: the thumbnail next to the photo. Best effort: a photo whose thumbnail fails is still saved (the
      // grid then shows the photo itself); tried once per queued photo, kept across a retry of a later step.
      // Speed sweep 18.11.2026: the thumbnail upload (3 calls) and the native object links (getModels + a POST per
      // model) do not depend on each other: they run side by side, then the record is written (was strictly in a row).
      const thumbStep = async () => {
        if (!(q.fileId && !q.thumbId && !q.thumbTried && q.img && q.img.thumb && q.up)) return;
        q.thumbTried = true;
        try { q.thumbId = await d.upload(q.up.folderId, thumbName(q.up.name), q.img.thumb, q.upThumb || (q.upThumb = {})); }
        catch (e) { console.warn("photos: thumbnail not uploaded", e); }
      };
      const linkStep = async () => {
        if (q.linked && !q.linkMissing) return;
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
          q.linkErr = d.errText ? d.errText(e) : (e && e.message) || String(e); q.linkMissing = true;
        }
        q.linkedModels = [...doneModels];
        q.linked = true;
      };
      await Promise.all([thumbStep(), linkStep()]);
      const rec = Object.assign({ file_id: q.fileId }, { file_name: q.meta.file_name, day: q.meta.day, taken: q.meta.taken }, {
        uploaded: isoLocal(new Date()), by: d.user || "", caption: q.ctx.caption || "", labels: (q.ctx.labels || []).join(", "),
        objects: JSON.stringify(objs.map((o) => ({ modelId: o.modelId, guid: o.guid, label: o.label || "" }))),
        links: (q.links || []).join(","), size: q.meta.size, deleted: false, purpose: q.ctx.purpose || "" });
      if (q.thumbId) rec.thumb_id = q.thumbId;
      const link = photoLink(d.projectId, q.fileId);
      try { await d.write(link, rec); }
      catch (e) {
        // a library whose "photo" definition has no thumb_id yet (the user may not extend it): save without it
        if (!rec.thumb_id || !(e && (e.status === 400 || e.status === 422))) throw e;
        delete rec.thumb_id;
        await d.write(link, rec);
      }
      q.done = true; q.file = null; q.img = null;
      if (d.drop) d.drop(q);   // saved: no longer kept on the device
      q.state = `${t.done || "ok"}${(q.links || []).length && !q.linkMissing ? "" : " · " + (t.noNative || "") + (q.linkErr ? ` (${q.linkErr})` : "")}`;
      return Object.assign({ link }, rec);
    } catch (e) {
      // sweep 18.11.2026: in plain words (d.errText: ArstenI18n.friendly), the raw text to the console
      q.bad = true; q.state = `${t.fail || "error"}: ${d.errText ? d.errText(e) : (e && e.message) || e}`;
      if (d.keep && (q.img || q.fileId)) d.keep(q);   // how far it got, for a send after a reload
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


  // ---------- which photo files still exist (sweep 18.11.2026: scoped, remembered, positive proof) ----------
  // Was: on every open Монолитен бетон and Авторски надзор listed root -> _AM_Docs -> Photos and then EVERY <day>
  // folder that had a photo, ever (~205 Core listings for 200 days, in each iframe), and a hidden _AM_Docs (the
  // designer's rights per AM_TEMPLATE) made every photo "deleted". Now:
  //  - callers pass only the records on screen (mount checks the days of the grid it draws, lazily);
  //  - a day's complete listing is remembered for the tab in sessionStorage "arsten.photos.exist.v1.<projectId>" for
  //    EXIST_TTL_MS. A remembered listing only ever PROVES a file exists: a file id not in it lists that day afresh
  //    before anything is hidden (a colleague's new photo is never hidden for being newer than the listing);
  //  - a folder missing from a listing is looked up with folders/by_path (as ArstenBackup.findFolder); _AM_Docs or
  //    Photos still not found -> null (unknown, nothing hidden), with one console.warn for "Копирай диагностика";
  //  - "deleted" needs positive proof: the day folder was found and its listing is complete.
  const EXIST_KEY = "arsten.photos.exist.v1.", EXIST_TTL_MS = 10 * 60 * 1000;
  const memExist = typeof WeakMap === "function" ? new WeakMap() : new Map();   // without sessionStorage (node, blocked storage): per Core client
  const sessStore = () => { try { return typeof sessionStorage !== "undefined" && sessionStorage ? sessionStorage : null; } catch { return null; } };
  function existMemo(core, projectId, now) {
    const key = EXIST_KEY + String(projectId || ""), s = sessStore();
    let mem = null;
    if (!s) { if (!memExist.has(core)) memExist.set(core, {}); mem = memExist.get(core); }
    const read = () => { if (mem) return mem[key] || {}; try { const o = JSON.parse((s && s.getItem(key)) || "{}"); return o && typeof o === "object" ? o : {}; } catch { return {}; } };
    const write = (o) => {
      const t = now();
      for (const d of Object.keys(o.days || {})) if (!(t - o.days[d].at < EXIST_TTL_MS)) delete o.days[d];   // expired ones out
      if (mem) { mem[key] = o; return; }
      try { if (s) s.setItem(key, JSON.stringify(o)); } catch {}   // full storage: just not remembered
    };
    return {
      photos: () => read().photos || null,
      setPhotos: (id) => { const o = read(); o.photos = id; write(o); },
      day: (d) => { const x = (read().days || {})[d]; return x && now() - x.at < EXIST_TTL_MS ? x : null; },
      setDay: (d, x) => { const o = read(); o.days = o.days || {}; o.days[d] = { at: now(), ids: x.ids }; o.dirs = o.dirs || {}; o.dirs[d] = x.folders; write(o); },
      // the day folder ids outlive the listing's TTL (folders do not move; a 404 / 403 from one forgets everything)
      dirs: (d) => { const x = (read().dirs || {})[d]; return Array.isArray(x) && x.length ? x : null; },
      forget: () => { if (mem) delete mem[key]; else try { if (s) s.removeItem(key); } catch {} },
    };
  }
  /** GET folders/by_path: the folder, or null (missing, no access or any error: never "deleted"). */
  async function folderByPath(core, projectId, names) {
    try {
      const f = await core.req(`folders/by_path?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent("/" + names.join("/"))}`);
      return f && f.id && (!f.type || String(f.type).toUpperCase() === "FOLDER") ? f : null;
    } catch (e) { if (!(e && e.status === 404)) console.warn("photos: folder lookup by path failed", names.join("/"), e); return null; }
  }
  /**
   * The id of a folder path under the project root (e.g. _AM_Docs/Photos/<day>), created when missing. cache: a Map
   * kept by the caller ("root", "<parent>/<name>" -> id). Sweep 18.11.2026: the same rules as ArstenBackup.ensureFolder
   * (CHANGE TOGETHER; this file must work without arsten-backup.js): a name missing from the parent's listing is looked
   * up by path before it is created (Connect can leave a usable folder out of a listing), and a failed create (409: a
   * colleague's phone created the same <day> just now) lists the parent again (every page) and uses the folder found -
   * was: every queued photo of that person failed with "changed by another user".
   */
  async function ensureFolderPath(core, projectId, names, cache) {
    cache = cache || new Map();
    let parent = cache.get("root");
    if (!parent) { const p = await core.req(`projects/${encodeURIComponent(projectId)}`); parent = p && p.rootId; if (!parent) throw new Error("project root folder not found"); cache.set("root", parent); }
    const walked = [];
    for (const name of names) {
      const key = parent + "/" + name;
      if (cache.has(key)) { parent = cache.get(key); walked.push(cache.get("name:" + key) || name); continue; }
      const items = (await listFolder(core, parent)).items;   // every page (round 17 L4)
      let f = pickFolder(items, name) || (await folderByPath(core, projectId, walked.concat([name])));
      if (!f) {
        try { f = await core.req("folders", "POST", { name, parentId: parent }); }
        catch (e) {
          f = pickFolder((await listFolder(core, parent)).items, name) || (await folderByPath(core, projectId, walked.concat([name])));
          if (!f) throw e;
        }
      }
      if (!f || !f.id) throw new Error("folder not created: " + name);
      walked.push(f.name || name);   // _ArstenDocs when the old folder was taken
      cache.set("name:" + key, f.name || name);
      cache.set(key, f.id); parent = f.id;
    }
    return parent;
  }
  /**
   * Which photo files still exist. A photo deleted directly in Connect (Data explorer / Attachments) leaves our record
   * behind; such photos are hidden. Pass only the records that are shown. Returns a Set of the existing file ids among
   * them, or null when the folders cannot be read (then nothing is hidden). A file id is left out of the Set ONLY when
   * its day folder was found and listed completely just now. o: {limit, now (clock, tests)}
   */
  async function existingIds(core, projectId, records, o) {
    o = o || {};
    const now = o.now || (() => Date.now());
    const dayOfRec = (r) => r.day || String(r.taken || "").slice(0, 10);
    const live = (records || []).filter((r) => !r.deleted && r.file_id);
    if (!live.length) return new Set();
    const memo = existMemo(core, projectId, now);
    const out = new Set(), need = new Map();   // day -> file ids not proven by a remembered listing
    for (const r of live) {
      const d = dayOfRec(r), x = d && memo.day(d);
      if (x && x.ids.includes(r.file_id)) out.add(r.file_id);
      else if (!d) out.add(r.file_id);   // no day: cannot be checked, kept
      else { if (!need.has(d)) need.set(d, []); need.get(d).push(r.file_id); }
    }
    if (!need.size) return out;   // everything shown is proven: no Core call at all
    const isFolder = (x) => !!x && String(x.type).toUpperCase() === "FOLDER";
    const children = (items, name) => { const l = items.filter((x) => isFolder(x) && x.name === name); return l.length || name !== DOCS ? l : items.filter((x) => isFolder(x) && x.name === DOCS_OLD); };
    try {
      // the Photos folder: remembered for the tab, else walked (with by_path for a level missing from a listing)
      let photos = memo.photos();
      if (!photos) {
        const p = await core.req(`projects/${encodeURIComponent(projectId)}`);
        const root = await listFolder(core, p.rootId);
        // both _AM_Docs and an old _ArstenDocs: photos may sit in either, so nothing is known to be deleted
        if (root.items.some((x) => isFolder(x) && x.name === DOCS) && root.items.some((x) => isFolder(x) && x.name === DOCS_OLD)) return null;
        let docs = children(root.items, DOCS)[0] || null, f = null;
        if (docs) f = children((await listFolder(core, docs.id)).items, "Photos")[0] || null;
        if (!f) f = (await folderByPath(core, projectId, [DOCS, "Photos"])) || (await folderByPath(core, projectId, [DOCS_OLD, "Photos"]));
        if (!f) { console.warn("photos: _AM_Docs/Photos not found (hidden or missing) – deleted photos are not hidden"); return null; }
        photos = f.id;
        memo.setPhotos(photos);
      }
      let top = null;   // the Photos listing, read once and only when a day folder id is not known
      const topList = async () => (top = top || listFolder(core, photos).catch((e) => { memo.forget(); throw e; }));   // a remembered id gone: looked up afresh next time
      const unsure = new Set();
      // round 17 L4: the day folders are listed 4 at a time
      await mapLimit([...need.keys()], o.limit || 4, async (day) => {
        const known = memo.dirs(day);
        let fs = known ? known.map((id) => ({ id })) : null;
        if (!fs) {
          const t = await topList();
          fs = children(t.items, day);
          if (!fs.length) { const g = await folderByPath(core, projectId, [DOCS, "Photos", day]); if (g) fs = [g]; }
          if (!fs.length) { unsure.add(day); return; }   // not found: no proof that anything was deleted
        }
        const ids = [];
        let complete = true;
        for (const f of fs) {   // every folder of that name (a second one may have been made by hand)
          let l;
          try { l = await listFolder(core, f.id); }
          catch (e) { if (known && e && (e.status === 404 || e.status === 403)) { memo.forget(); } unsure.add(day); return; }
          if (!l.complete) complete = false;
          for (const x of l.items) if (!isFolder(x)) ids.push(x.id);
        }
        for (const id of ids) out.add(id);
        if (complete) memo.setDay(day, { ids, folders: fs.map((f) => f.id) });
        else unsure.add(day);
      });
      for (const [day, list] of need) if (unsure.has(day)) for (const id of list) out.add(id);
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
    // sweep 18.11.2026: a ~320 px thumbnail for the grids, drawn from the resized canvas (no second decode)
    let thumb = null;
    try {
      const kt = Math.min(1, THUMB_PX / Math.max(w, h));
      const t = document.createElement("canvas"); t.width = Math.max(1, Math.round(w * kt)); t.height = Math.max(1, Math.round(h * kt));
      const tc = t.getContext("2d");
      if (tc) { tc.drawImage(c, 0, 0, t.width, t.height); thumb = await new Promise((res) => t.toBlob(res, "image/jpeg", THUMB_Q)); }
      t.width = 0; t.height = 0;
    } catch (e) { thumb = null; }
    c.width = 0; c.height = 0;   // give the canvas memory back at once (iOS has a total canvas limit)
    if (!blob) throw new Error("Снимката не можа да се компресира – опитайте пак / could not compress the photo");
    return { blob, thumb, taken, w, h, originalSize: file.size, size: blob.size, name: file.name };
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
  .ph-btns{gap:6px}
  .ph-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;border:1px solid var(--line,#d9d5cc);background:var(--panel,#fff);color:inherit;padding:3px 10px;font-size:12px;cursor:pointer;user-select:none;white-space:nowrap}
  .ph-btn.ph-main{background:var(--ink,#1f1f1f);border-color:var(--ink,#1f1f1f);color:#fff}
  .ph-btn:focus-visible{outline:2px solid var(--accent,#E37424);outline-offset:1px}
  .ph-btn.ph-off{opacity:.45;cursor:not-allowed}
  .ph-plabel{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:center}
  .ph-first{font-weight:600;margin:6px 0;color:var(--warn,#8a5a00)}
  @media (pointer:coarse){.ph-btn{min-height:40px;padding:8px 14px;font-size:14px;flex:1}.ph-purpose{min-height:40px;font-size:16px}.ph-droptext{display:none}.ph-q button{min-height:36px}}
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
    bg: { title: "Снимки", add: "Избери снимки", camera: "📷 Снимай", drop: "Пуснете снимки тук", caption: "Описание (по избор)",
      needSel: "Изберете обект(и) в модела, за да добавите снимки към тях.", to: "Към", sel: "За избраното", all: "Всички по дни", filter: "Филтър (такт / марка)",
      none: "Няма снимки.", noneSel: "Няма снимки за избраното.", up: "Качване", done: "качена", fail: "грешка", show: "Покажи в модела", del: "Изтрий",
      delAsk: "Да се изтрие ли снимката? Това не може да се отмени.", yes: "Да, изтрий", no: "Не", close: "Затвори", orig: "оригинал",
      gone: "{n} снимки са изтрити в Connect и са скрити.", purposeFor: "Снимката е за:", purposeGeneral: "Дневник (обща)", markFor: "За приемане…", pick: "Избери", pickDone: "Отказ", picked: "Избрани", apply: "Приложи", choosePurpose: "Изберете за какво (кофраж / армировка).",
      native: "Връзка в Connect", openNew: "Отвори в нов прозорец", zoom: "Щракнете за увеличение", noNative: "без връзка в Connect (само в нашия списък)", loading: "Зареждане…",
      kept1: "1 снимка{p} чака качване (от предишно отваряне).", keptN: "{n} снимки{p} чакат качване (от предишно отваряне).", keptFor: " за ", keptSend: "Изпрати", keptDrop: "Изтрий от телефона",
      keptDrop1: "Потвърди: изтрий 1 снимка", keptDropN: "Потвърди: изтрий {n} снимки", keptKeep: "Откажи",
      retry: "Опитай пак", retryAll: "Опитай пак всички ({n})", drop1: "Премахни", sendNow: "Изпрати за приемане сега", sendLater: "По-късно", sendAsk: "Снимките са добавени към заявка за приемане.",
      selFirst: "Първо изберете такт в модела – после снимайте.", pending1: "Изберете такт, за да качите 1 снимка.", pendingN: "Изберете такт, за да качите {n} снимки.",
      unsent1: "1 снимка не беше изпратена последния път{w} – изберете я отново.", unsentN: "{n} снимки не бяха изпратени последния път{w} – изберете ги отново.",
      deleting: "Изтриване…", saving: "Записване…", deleted: "Снимката е изтрита ✓", marked: "Отбелязано за приемане ✓",
      others1: "1 снимка на друг потребител чака на това устройство (не се изпраща от вас).", othersN: "{n} снимки на друг потребител чакат на това устройство (не се изпращат от вас).",
      older: "По-стари дни", },
    en: { title: "Photos", add: "Choose photos", camera: "📷 Take photo", drop: "Drop photos here", caption: "Caption (optional)",
      needSel: "Select object(s) in the model to add photos to them.", to: "To", sel: "For the selection", all: "All by day", filter: "Filter (pour / mark)",
      none: "No photos.", noneSel: "No photos for the selection.", up: "Uploading", done: "uploaded", fail: "failed", show: "Show in model", del: "Delete",
      delAsk: "Delete this photo? This cannot be undone.", yes: "Yes, delete", no: "No", close: "Close", orig: "original",
      gone: "{n} photos were deleted in Connect and are hidden.", purposeFor: "Photo is for:", purposeGeneral: "Site log (general)", markFor: "For acceptance…", pick: "Select", pickDone: "Cancel", picked: "Selected", apply: "Apply", choosePurpose: "Choose what for (formwork / rebar).",
      native: "Linked in Connect", openNew: "Open in new window", zoom: "Click to zoom", noNative: "not linked in Connect (our list only)", loading: "Loading…",
      kept1: "1 photo{p} is waiting to upload (from an earlier visit).", keptN: "{n} photos{p} are waiting to upload (from an earlier visit).", keptFor: " for ", keptSend: "Send", keptDrop: "Delete from this device",
      keptDrop1: "Confirm: delete 1 photo", keptDropN: "Confirm: delete {n} photos", keptKeep: "Cancel",
      retry: "Try again", retryAll: "Try all again ({n})", drop1: "Remove", sendNow: "Send for acceptance now", sendLater: "Later", sendAsk: "The photos were added to an acceptance request.",
      selFirst: "Select a pour in the model first, then take the photo.", pending1: "Select a pour to upload 1 photo.", pendingN: "Select a pour to upload {n} photos.",
      unsent1: "1 photo was not sent last time{w} – please choose it again.", unsentN: "{n} photos were not sent last time{w} – please choose them again.",
      deleting: "Deleting…", saving: "Saving…", deleted: "Photo deleted ✓", marked: "Marked for acceptance ✓",
      others1: "1 photo of another user is waiting on this device (not sent by you).", othersN: "{n} photos of another user are waiting on this device (not sent by you).",
      older: "Older days", },
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

  // ---------- thumbnail URLs: a pool, only for images in view (sweep 18.11.2026) ----------
  /**
   * Fills <img data-src="fileId"> elements with download URLs, at most `limit` URL requests at once. want(img) queues an
   * image (an image no longer in the page - a newer render replaced it - is skipped). getUrl(id) -> Promise<url>;
   * onUrl(img, url) sets it. Returns {want, size()}.
   */
  function urlLoader(getUrl, onUrl, limit) {
    const pending = [];
    let active = 0;
    const gone = (img) => img.isConnected === false;
    function pump() {
      while (active < (limit || URL_POOL) && pending.length) {
        const img = pending.shift();
        if (gone(img)) continue;
        const id = img.dataset && img.dataset.src;
        if (!id) continue;
        active++;
        Promise.resolve().then(() => getUrl(id)).then((u) => { if (u && !gone(img) && img.dataset.src === id) onUrl(img, u); }, () => {})
          .finally(() => { active--; pump(); });
      }
    }
    return { want: (img) => { if (!pending.includes(img)) pending.push(img); pump(); }, size: () => pending.length + active };
  }

  /** The upload purpose in the select above "📷 Снимай" (sweep 18.11.2026): "За приемане – Кофраж" reads as
   *  "Приемане – кофраж" / "Acceptance – formwork", next to the label "Снимката е за:" and "Дневник (обща)". */
  function purposeText(p, lang) {
    const en = lang === "en", t = String((en ? p.en : p.bg) || p.id || "");
    const m = /^(?:За приемане|For acceptance)\s*[–-]\s*(.+)$/.exec(t);
    return m ? (en ? "Acceptance – " : "Приемане – ") + m[1].charAt(0).toLowerCase() + m[1].slice(1) : t;
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
    const st = { records: [], view: "sel", filter: "", queue: sessionQueue(opts.project && opts.project.id), offerSend: false, urls: new Map(), urlDone: new Map(), folders: new Map(), loaded: false, open: null, confirm: false, picking: false, picked: new Set(), lastKey: null, lastQ: null, lastHead: null, pendingFiles: [], busy: "", allDays: ALL_DAYS, filterText: "" };
    const say = (t, bad) => opts.onStatus && opts.onStatus(t, bad);
    // sweep 18.11.2026: errors in plain words (ArstenI18n.friendly when loaded); the raw text goes to the console
    const errText = (e) => {
      const g = typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : {};
      const I = g.ArstenI18n;
      // opts.refresh: "button" in a panel with an Обнови button (else the text says to reopen the panel)
      return I && typeof I.friendly === "function" ? I.friendly(e, opts.lang === "en" ? "en" : "bg", { refresh: opts.refresh }) : (e && e.message) || String(e);
    };
    const pid = opts.project && opts.project.id;
    // photos not sent when an earlier page went away: shown once, only in a NEW page (this page's queue is still here)
    // photos kept on the device by an earlier page (pendingStore, sweep 18.11.2026): offered "Изпрати / Отказ"; the note
    // "N снимки не бяха изпратени – изберете ги отново" only when none were kept (nothing to send then)
    const store = opts.store !== undefined ? opts.store : pendingStore();
    st.restored = []; st.othersKept = 0;
    // who prepared a kept photo (security sweep 18.11.2026): the Connect user id / e-mail (opts.userId, else asked from
    // the Workspace API); the display name only when neither is known
    const whoP = Promise.resolve().then(async () => {
      if (opts.userId) return String(opts.userId);
      try { const u = opts.api && opts.api.user && (await opts.api.user.getUser()); if (u && (u.id || u.email)) return String(u.id || u.email); } catch {}
      return String(opts.user || "");
    }).then((w) => (st.who = w));
    if (!st.queue.some((q) => !q.done)) {
      const was = takeUnsent(pid);
      Promise.all([store.all(pid), whoP]).then(([list, who]) => {
        const have = new Set(st.queue.map((q) => q.uid));
        const s = splitPending(list.filter((x) => !have.has(x.uid)), who, opts.now ? opts.now() : Date.now());
        s.old.forEach((x) => store.del(pid, x.uid));   // past the age limit: off the device
        st.restored = s.mine; st.othersKept = s.others.length;
        if (st.restored.length || st.othersKept) { st.lastQ = null; st.lastKey = null; render(); }   // once per mount: a full redraw
        if (!st.restored.length && was) say(unsentText(was, opts.lang), true);
      }).catch((e) => console.warn("photos: kept photos not read", e));
    }
    /** "Изпрати" on the kept photos: they join the queue and go up; "Изтрий от телефона" (its second tap): deleted from
     *  the device. Sweep 18.11.2026: the button said "Отказ" ("not now" in Bulgarian) and deleted every kept photo at
     *  the first tap, with nothing to undo - now it says what it does and only arms itself first (st.keptArm), as
     *  Монолитен бетон's "Премахни". */
    async function restoreChoice(send) {
      st.keptArm = false;
      const list = st.restored.splice(0);
      if (!send) { await Promise.all(list.map((x) => store.del(pid, x.uid))); st.lastQ = null; render(); return; }
      const items = list.map((x) => fromPending(x, L().up + "…"));
      st.queue.push(...items);
      render();
      await runItems(items);
    }
    const unsentNow = () => Object.assign(unsentOf(st.queue, st.pendingFiles), { running: st.queue.some((q) => !q.done && !q.bad) });
    let lastNote = "";
    const keepNote = () => { const u = unsentNow(), k = u.count + "|" + u.labels.join(); if (k !== lastNote) { lastNote = k; noteUnsent(pid, u); } };
    WATCH.set(String(pid || ""), unsentNow);
    watchPage();
    if (!document.getElementById("ph-css")) { const s = document.createElement("style"); s.id = "ph-css"; s.textContent = CSS; document.head.appendChild(s); }

    async function load() {
      try { await opts.client.ensureDefinition(opts.libId, definition()); } catch (e) { if (e.status !== 403) throw e; }
      const m = await opts.client.listAll(opts.libId, DEF_ID, photoPrefix(opts.project.id));
      st.records = [...m].map(([link, p]) => Object.assign({ link }, p));
      st.loaded = true;
      render();   // render checks the days it shows for photos deleted in Connect (checkShown)
    }
    // Photos whose file was deleted in Connect itself are hidden (our record stays, marked "gone" only here). Sweep
    // 18.11.2026: only the days of the photos on screen, when the grid for them is drawn, each day once per mount; was
    // every day the project ever had, on every open, before anything else (see existingIds).
    const checkedDays = new Set();
    const recDay = (r) => r.day || String(r.taken || "").slice(0, 10);
    function checkShown(shown) {
      const days = new Set();
      for (const r of shown) if (!r.deleted && r.file_id && !checkedDays.has(recDay(r))) days.add(recDay(r));
      if (!days.size) return;
      days.forEach((d) => checkedDays.add(d));
      // every live photo of those days (other objects' too): the same day listings cover them
      const recs = st.records.filter((r) => !r.deleted && r.file_id && days.has(recDay(r)));
      existingIds(core, opts.project.id, recs).then((exist) => {
        if (!exist) return;
        let gone = 0;
        for (const r of recs) if (!r.deleted && !exist.has(r.file_id)) { r.deleted = true; r.gone = true; gone++; }
        if (gone) { say(L().gone.replace("{n}", gone)); render(); }
      }, (e) => { days.forEach((d) => checkedDays.delete(d)); console.warn("photos: deleted check failed", e); });
    }

    // folders _AM_Docs/Photos/<day>, created when missing
    const folderJobs = new Map();
    function folderFor(day) {   // memoised as a promise: parallel uploads of the same day share one lookup / create
      if (!folderJobs.has(day)) folderJobs.set(day, folderLookup(day).catch((e) => { folderJobs.delete(day); throw e; }));
      return folderJobs.get(day);
    }
    /** A folder id that answered 404 / 403 (deleted or moved in Connect): every remembered id is dropped, so the next
     *  folderFor walks the path afresh (sweep 18.11.2026: a dead id got every later upload of the panel's life). */
    function forgetFolders() { st.folders.clear(); folderJobs.clear(); }
    async function folderLookup(day) {
      if (st.folders.has(day)) return st.folders.get(day);
      const id = await ensureFolderPath(core, opts.project.id, [...ROOT_PATH, day], st.folders);
      st.folders.set(day, id);
      return id;
    }

    const putBlob = (url, blob) => send((...a) => fetch(...a), url, { method: "PUT", body: blob, headers: { "Content-Type": "image/jpeg" } },
      { path: "upload", what: "upload PUT", ms: UPLOAD_TIMEOUT_MS }).then((x) => x.res);
    const uploadWith = (lister) => (folderId, name, blob, track) => uploadFile(core, putBlob, folderId, name, blob, track, { find: lister.find });

    const nativeLinks = (fileId, objs) => linkObjects(core, async () => (await opts.api.viewer.getModels()) || [], fileId, objs);

    const deps = (lister) => ({ prepare: prepareImage, folderFor, forgetFolder: forgetFolders, upload: uploadWith(lister), links: nativeLinks, errText,
      keep: (q) => { whoP.then((w) => { if (!q.who) q.who = w; return store.put(pid, q); }); }, drop: (q) => { store.del(pid, q.uid); },
      write: (link, rec) => opts.client.write(opts.libId, DEF_ID, link, rec), projectId: opts.project.id, user: opts.user, texts: L(),
      onProgress: () => render() });
    /** Upload these queue items (UPLOAD_POOL at once); then each purpose's photos go to onUploaded (acceptance) per set
     *  of objects. */
    async function runItems(items) {
      const d = deps(folderLister(core));   // round 17 L4: each day folder is listed once for the whole batch, not per photo
      d.prepare = oneAtATime(d.prepare);
      const linkOnly = items.map((q) => q.done);   // saved photos whose missing native links are made again (L10): not handed over again
      const recs = await mapLimit(items, UPLOAD_POOL, async (q, i) => {
        const rec = await processItem(q, d);
        if (rec) {
          const at = st.records.findIndex((r) => r.file_id === rec.file_id);
          if (at < 0) st.records.push(rec); else if (linkOnly[i]) Object.assign(st.records[at], rec);
        }
        return rec;
      });
      // built in input order from the results (the pool finishes them in any order)
      const byKey = new Map();   // purpose + objects -> {purpose, objects, fileIds}
      items.forEach((q, i) => {
        const rec = recs[i], p = q.ctx.purpose;
        if (!rec || !p || linkOnly[i]) return;
        const k = p + "|" + (q.ctx.objs || []).map((o) => o.guid).sort().join(",");
        if (!byKey.has(k)) byKey.set(k, { purpose: p, objects: q.ctx.objs, fileIds: [] });
        byKey.get(k).fileIds.push(rec.file_id);
      });
      queuePrune(st.queue);
      render();
      const handed = await handOver([...byKey.values()], opts.onUploaded);
      // A9: photos for acceptance went in -> offer to send the request at once (the panel's own send function).
      // Round 15, L7: only when attaching them to the request(s) succeeded.
      if (byKey.size && opts.sendNow && handed) { st.offerSend = true; render(); }
    }
    /** "Изберете такт, за да качите 1 снимка." for the photos waiting for a selection. */
    const pendingText = () => { const n = st.pendingFiles.length; return n === 1 ? L().pending1 : L().pendingN.replace("{n}", n); };
    async function addFiles(files) {
      const objs = opts.targets();
      if (!objs.length) {
        // sweep 18.11.2026: a photo taken (or dropped) with nothing selected was thrown away. It now waits here and goes
        // up on the next selection (render), so a picture already taken is never lost.
        const add = [...(files || [])].filter(isPhotoFile);
        if (!add.length) return;
        st.pendingFiles.push(...add);
        render();
        return say(pendingText(), true);
      }
      const caption = ((opts.el.querySelector(".ph-cap") || {}).value || "").trim();
      const labels = [...new Set(objs.map((o) => o.label).filter(Boolean))];
      const purpose = ((opts.el.querySelector(".ph-purpose") || {}).value || "");
      const mine = queueItems(files, { objs, caption, labels, purpose }, L().up + "…");
      st.queue.push(...mine);
      st.caption = "";
      const capEl = opts.el.querySelector(".ph-cap");
      if (capEl) capEl.value = "";   // the pane is not always rebuilt now (sweep 18.11.2026)
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
      if (i >= 0) store.del(pid, st.queue.splice(i, 1)[0].uid);   // dropped: not kept on the device either
      render();
    }

    /** Download URL of a file (photo or thumbnail), asked once; st.urlDone keeps the answers so a re-render sets src at once. */
    async function urlOfId(id) {
      if (st.urls.has(id)) return st.urls.get(id);
      const p = core.req(`files/fs/${encodeURIComponent(id)}/downloadurl`).then((d) => { const u = (d && (d.url || d.downloadUrl || d.href)) || ""; if (u) st.urlDone.set(id, u); return u; })
        .catch((e) => { st.urls.delete(id); throw e; });
      st.urls.set(id, p);
      return p;
    }
    const loader = urlLoader(urlOfId, (img, u) => {
      img.src = u;
      const a = img.closest && img.closest(".ph-box") && opts.el.querySelector(".ph-open");
      if (a) { a.href = u; a.style.opacity = ""; a.style.pointerEvents = ""; }
    }, URL_POOL);
    // only images in view ask for a URL (a grid of 200 photos: the ~20 on screen first, the rest when scrolled to)
    const io = typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); loader.want(e.target); } }, { rootMargin: "300px" }) : null;
    // an image that does not load (a signed URL expired in a panel left open): ask for a fresh URL; only a failure
    // within RETRY_MS of a fresh URL makes a thumbnail fall back to the photo itself, and only such a failure of the
    // photo says "снимката не се зарежда". Sweep 18.11.2026: was a Set for the whole mount - the second expiry of a
    // tile later in the day switched it to the 2560 px photo (a site phone then loaded full photos for every tile) and
    // the third left it blank with no word. Now the same rule as Дейности imgFailed (viewer-activities/app.js).
    const RETRY_MS = 10 * 60 * 1000;
    const freshAt = new Map();   // file id -> time of the last fresh URL asked after a failure
    const nowMs = () => (opts.now ? opts.now() : Date.now());
    if (opts.el.addEventListener) opts.el.addEventListener("error", (e) => {
      const img = e.target;
      if (!img || img.tagName !== "IMG" || !img.dataset || !img.dataset.src) return;
      const id = img.dataset.src, last = freshAt.get(id), t = nowMs();
      st.urls.delete(id); st.urlDone.delete(id);
      if (last == null || t - last > RETRY_MS) freshAt.set(id, t);   // expired link: ask again
      else if (img.dataset.full && img.dataset.full !== id) img.dataset.src = img.dataset.full;   // the thumbnail itself is bad
      else { const w = opts.lang === "en" ? "the photo does not load" : "снимката не се зарежда"; img.alt = w; img.title = w; return; }
      img.removeAttribute("src");
      loader.want(img);
    }, true);

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

    // sweep 18.11.2026: delete / mark run several calls (seconds on mobile data): st.busy disables their buttons and
    // shows "Изтриване…" / "Записване…", so the box does not look frozen and a second tap does not start a second run
    async function busyWith(kind, fn) {
      if (st.busy) return false;
      st.busy = kind; render();
      try { await fn(); return true; }
      finally { st.busy = ""; render(); }
    }
    async function remove(r) {
      const ok = await busyWith("del", async () => {
        for (const id of String(r.links || "").split(",").filter(Boolean)) { try { await core.req(`objectlink/${encodeURIComponent(id)}`, "DELETE"); } catch {} }
        try { await core.req(`files/${encodeURIComponent(r.file_id)}`, "DELETE"); } catch (e) { if (e.status !== 404) throw e; }
        if (r.thumb_id) { try { await core.req(`files/${encodeURIComponent(r.thumb_id)}`, "DELETE"); } catch {} }
        const rec = Object.assign({}, r, { deleted: true, links: "" }); delete rec.link;   // full record (see ArstenAcceptance.full)
        await opts.client.write(opts.libId, DEF_ID, r.link, rec);
        r.deleted = true;
        st.open = null; st.confirm = false;
      });
      if (ok) say(L().deleted);
    }
    /** Existing photos -> a purpose (e.g. acceptance). Each photo keeps its own objects, so it joins its own pour's request. */
    async function mark(recs, purpose) {
      if (!purpose || !recs.length) return;
      const ok = await busyWith("mark", async () => {
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
      });
      if (ok) say(L().marked);
    }
    const markSelect = (cls) => `<select class="${cls}"><option value="">${esc(L().markFor)}</option>${(opts.purposes || []).map((p) => `<option value="${esc(p.id)}">${esc(opts.lang === "en" ? p.en : p.bg)}</option>`).join("")}</select>`;
    const canDelete = (r) => opts.canDeleteAny || (opts.canAdd && r.by && r.by === opts.user);

    /** An <img> for a file: src at once when its URL is known, else data-src for the loader. data-full: the photo (a
     *  thumbnail that fails falls back to it). */
    const imgTag = (id, full, lazy) => {
      const u = st.urlDone.get(id);
      return `<img alt=""${lazy ? ' loading="lazy" decoding="async"' : ""} data-src="${esc(id)}" data-full="${esc(full)}"${u ? ` src="${esc(u)}"` : ""}>`;
    };
    function thumbs(items) {
      // sweep 18.11.2026: the grid shows the ~25 KB thumbnail (thumb_id); an older photo without one shows the photo
      return `<div class="ph-grid">${items.map((r) => `<button class="ph-th${st.picked.has(r.file_id) ? " ph-pick" : ""}" data-ph="${esc(r.file_id)}" title="${esc(r.caption || r.labels)}">${imgTag(r.thumb_id || r.file_id, r.file_id, true)}<span>${esc((r.taken || "").slice(11, 16))} ${esc(r.labels)}</span></button>`).join("")}</div>`;
    }
    /** What the photo pane shows, apart from the upload queue and the selection header (both updated in place). */
    function paneKey(guids) {
      const recs = st.records.map((r) => `${r.file_id}${r.deleted ? "!" : ""}${r.purpose ? "@" + r.purpose : ""}${r.thumb_id ? "+" : ""}`).join(",");
      return JSON.stringify([opts.lang, !!opts.canAdd, st.loaded, st.view, st.view === "all" ? [st.filter, st.allDays] : guids, recs,
        st.open ? st.open.file_id + (st.open.deleted ? "!" : "") + (st.open.purpose || "") : "", st.confirm, st.picking, [...st.picked], st.offerSend, st.busy]);
    }
    function headHtml(objs) {
      const l = L(), labels = [...new Set(objs.map((o) => o.label).filter(Boolean))];
      return objs.length ? `<div>${l.to}: <b>${esc(labels.join(", ") || objs.length)}</b> (${objs.length})</div>` : `<div>${l.needSel}</div>`;
    }
    /** The cheap part of a render: the selection header and the upload queue, replaced only when their text changed. */
    function renderSmall(objs) {
      keepNote();
      const head = opts.el.querySelector(".ph-head"), h = headHtml(objs);
      if (head && h !== st.lastHead) { head.innerHTML = h; st.lastHead = h; }
      const w = opts.el.querySelector(".ph-qwrap"), q = queueHtml();
      if (w && q !== st.lastQ) { w.innerHTML = q; st.lastQ = q; wire(); }
    }

    // Sweep 18.11.2026: Монолитен бетон calls render() on every model selection, upload progress tick and filter key.
    // The pane is rebuilt only when what it shows changed (paneKey: language, view, filter or selected objects,
    // records, open photo, picking); otherwise only the header and the queue rows are updated in place, so the
    // thumbnails are not thrown away and decoded again on every tap in the model.
    function render() {
      const l = L(), objs = opts.targets();
      const guids = objs.map((o) => o.guid);
      // photos taken while nothing was selected go up now that something is (sweep 18.11.2026)
      if (st.pendingFiles.length && objs.length) {
        const files = st.pendingFiles.splice(0);
        Promise.resolve().then(() => addFiles(files)).catch((e) => say(errText(e), true));
      }
      keepNote();
      const key = paneKey(guids);
      if (key === st.lastKey && opts.el.__phKey === key && opts.el.querySelector(".ph-list")) { renderSmall(objs); return; }
      st.lastKey = key;
      let body;
      if (!st.loaded) body = `<div class="sub">${l.loading}</div>`;
      else if (st.view === "sel") {
        const list = forObjects(st.records, guids);
        body = !guids.length ? `<div class="sub">${l.needSel}</div>` : list.length ? groupByDay(list).map((g) => `<div class="ph-day">${esc(dayText(g.day))}</div>${thumbs(g.items)}`).join("") : `<div class="sub">${l.noneSel}</div>`;
        checkShown(list);
      } else {
        const groups = groupByDay(st.records, st.filter), shown = groups.slice(0, st.allDays);
        checkShown(shown.flatMap((g) => g.items));   // only the days drawn
        body = shown.length ? shown.map((g) => `<div class="ph-day">${esc(dayText(g.day))} · ${g.items.length}</div>${thumbs(g.items)}`).join("")
          + (groups.length > shown.length ? `<div class="bar" style="justify-content:center"><button class="small secondary" data-phmore="1">${esc(l.older)} (${groups.length - shown.length})</button></div>` : "")
          : `<div class="sub">${l.none}</div>`;
      }
      const head = headHtml(objs), q = queueHtml();
      st.lastHead = head; st.lastQ = q;
      // sweep 18.11.2026: nothing selected -> the camera / choose buttons are off and say why (the camera used to open,
      // and the photo was thrown away afterwards)
      const off = !objs.length, offCls = off ? " ph-off" : "", offAttr = off ? ' tabindex="-1" aria-disabled="true"' : ' tabindex="0"';
      // sweep 18.11.2026: "📷 Снимай" (primary) and "Избери снимки" are real 40 px buttons on a phone (were ~20 px labels)
      opts.el.innerHTML = `
        ${opts.canAdd ? `<div class="ph-drop"><div class="ph-head">${head}</div>
          <div class="ph-droptext">${l.drop}</div>
          ${(opts.purposes || []).length ? `<div class="bar" style="justify-content:center"><label class="ph-plabel">${esc(l.purposeFor)} <select class="ph-purpose"><option value="">${esc(l.purposeGeneral)}</option>${opts.purposes.map((p) => `<option value="${esc(p.id)}"${st.purpose === p.id ? " selected" : ""}>${esc(purposeText(p, opts.lang))}</option>`).join("")}</select></label></div>` : ""}
          <div class="bar" style="justify-content:center"><input type="text" class="ph-cap" placeholder="${esc(l.caption)}" value="${esc(st.caption || "")}" style="flex:1;min-width:120px"></div>
          ${off ? `<div class="ph-first" role="note">${esc(l.selFirst)}</div>` : ""}
          <div class="bar ph-btns" style="justify-content:center">
            <label class="ph-btn ph-main${offCls}" role="button"${offAttr}>${l.camera}<input type="file" class="ph-cam" accept="image/*" capture="environment" hidden${off ? " disabled" : ""}></label>
            <label class="ph-btn${offCls}" role="button"${offAttr}>${l.add}<input type="file" class="ph-file" accept="image/*" multiple hidden${off ? " disabled" : ""}></label></div>
          <div class="ph-qwrap">${q}</div></div>` : ""}
        <div class="bar"><button class="small ${st.view === "sel" ? "" : "secondary"}" data-phv="sel">${l.sel}</button><button class="small ${st.view === "all" ? "" : "secondary"}" data-phv="all">${l.all}</button>
          ${st.view === "all" ? `<input type="text" class="ph-filter" placeholder="${esc(l.filter)}" value="${esc(st.filterText)}" style="flex:1;min-width:90px">` : ""}
          ${opts.canAdd && (opts.purposes || []).length ? `<button class="small ${st.picking ? "" : "secondary"}" data-phpick="1">${st.picking ? l.pickDone : l.pick}</button>` : ""}</div>
        ${st.picking ? `<div class="bar"><span class="sub">${l.picked}: ${st.picked.size}</span>${markSelect("ph-markmany")}<button class="small" data-phapply="1"${st.picked.size && !st.busy ? "" : " disabled"}>${st.busy === "mark" ? l.saving : l.apply}</button></div>` : ""}
        <div class="ph-list">${body}</div>
        ${st.open ? box(st.open) : ""}`;
      opts.el.__phKey = key;
      wire();
      if (io) io.disconnect();
      opts.el.querySelectorAll("img[data-src]").forEach((img) => {
        const inBox = !!(img.closest && img.closest(".ph-box"));
        if (img.getAttribute("src")) {   // URL known: only the photo viewer's "open in new window" link still needs it
          if (inBox) { const a = opts.el.querySelector(".ph-open"); if (a) { a.href = img.getAttribute("src"); a.style.opacity = ""; a.style.pointerEvents = ""; } }
          return;
        }
        if (io && !inBox) io.observe(img); else loader.want(img);
      });
      wireZoom(opts.el.querySelector(".ph-view"));
    }
    function queueHtml() {
      const l = L(), again = retryable(st.queue);
      const kept = (st.restored || []).length;
      const wait = (st.othersKept ? `<div class="sub">${esc((st.othersKept === 1 ? l.others1 : l.othersN).replace("{n}", st.othersKept))}</div>` : "")
        + (kept ? `<div class="bad">${esc(keptText(st.restored, l))} ${st.keptArm
          ? `<button class="small ph-bad" data-phrestore="0">${esc((kept === 1 ? l.keptDrop1 : l.keptDropN).replace("{n}", kept))}</button> <button class="small secondary" data-phrestore="keep">${esc(l.keptKeep)}</button>`
          : `<button class="small" data-phrestore="1">${esc(l.keptSend)}</button> <button class="small secondary" data-phrestore="arm">${esc(l.keptDrop)}</button>`}</div>` : "")
        + (st.pendingFiles.length ? `<div class="bad">${esc(pendingText())} <button class="small secondary" data-phpend="1">${l.drop1}</button></div>` : "");
      const rows = queueView(st.queue).map((q) => `<div class="${q.bad ? "bad" : "sub"}">${esc(q.name)}: ${esc(q.state)}${canRetry(q)
        ? ` <button class="small" data-phretry="${q.id}">${l.retry}</button> <button class="small secondary" data-phdrop="${q.id}">${l.drop1}</button>` : ""}</div>`).join("");
      const many = again.length > 1 ? `<div class="bar" style="justify-content:center"><button class="small" data-phretry="all">${l.retryAll.replace("{n}", again.length)}</button></div>` : "";
      const offer = st.offerSend && opts.sendNow ? `<div class="bar" style="justify-content:center"><span class="sub">${l.sendAsk}</span><button class="small" data-phsend="1">${l.sendNow}</button><button class="small secondary" data-phsend="0">${l.sendLater}</button></div>` : "";
      return wait + (rows || many ? `<div class="ph-q">${rows}${many}</div>` : "") + offer;
    }
    function box(r) {
      const l = L();
      return `<div class="ph-box"><div class="ph-view" title="${esc(L().zoom)}">${imgTag(r.file_id, r.file_id, false)}</div>
        <div class="ph-meta"><b>${esc(r.labels)}</b>${r.purpose ? ` · ${esc(((opts.purposes || []).find((p) => p.id === r.purpose) || {})[opts.lang === "en" ? "en" : "bg"] || r.purpose)}` : ""}${r.caption ? " – " + esc(r.caption) : ""}<br>${esc(dayText(r.taken, true))} · ${esc(r.by)} · ${esc(r.size)} · ${r.links ? l.native : l.noNative}</div>
        <div class="ph-acts">${st.busy ? `<span class="sub" role="status">${st.busy === "del" ? l.deleting : l.saving}</span>` : st.confirm ? `<span>${l.delAsk}</span><button class="small ph-bad" data-pha="yes">${l.yes}</button><button class="small" data-pha="no">${l.no}</button>`
          : `${canDelete(r) ? `<button class="small ph-bad" data-pha="del">${l.del}</button>` : ""}<span class="ph-r">${opts.canAdd && (opts.purposes || []).length ? markSelect("ph-markone") : ""}<a class="ph-open" target="_blank" rel="noopener" style="opacity:.5;pointer-events:none">${l.openNew}</a><button class="small" data-pha="show">${l.show}</button><button class="small" data-pha="close">${l.close}</button></span>`}</div></div>`;
    }
    function wire() {
      const el = opts.el, g = (fn) => () => Promise.resolve().then(fn).catch((e) => say(errText(e), true));
      const pick = (inp) => { if (inp) inp.onchange = (e) => { const f = [...e.target.files]; e.target.value = ""; g(() => addFiles(f))(); }; };
      pick(el.querySelector(".ph-file")); pick(el.querySelector(".ph-cam"));
      el.querySelectorAll(".ph-btn").forEach((b) => { b.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); const i = b.querySelector("input"); if (i) i.click(); } }; });
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
      el.querySelectorAll("[data-phpend]").forEach((b) => { b.onclick = () => { st.pendingFiles.length = 0; st.lastQ = null; render(); }; });
      el.querySelectorAll("[data-phrestore]").forEach((b) => { b.onclick = g(() => {
        const v = b.dataset.phrestore;
        // "Изтрий от телефона" only arms itself; "Потвърди: изтрий N снимки" deletes; "Откажи" keeps them
        if (v === "arm" || v === "keep") { st.keptArm = v === "arm"; st.lastQ = null; render(); return; }
        return restoreChoice(v === "1");
      }); });
      el.querySelectorAll("[data-phsend]").forEach((b) => { b.onclick = g(async () => {
        st.offerSend = false; render();
        if (b.dataset.phsend === "1") await opts.sendNow();
      }); });
      el.querySelectorAll("[data-phv]").forEach((b) => { b.onclick = () => { st.view = b.dataset.phv; st.allDays = ALL_DAYS; render(); }; });
      el.querySelectorAll("[data-phmore]").forEach((b) => { b.onclick = () => { st.allDays += ALL_DAYS; render(); }; });
      const fl = el.querySelector(".ph-filter");
      // the typed text is kept at once (a rebuild meanwhile shows it); the grid follows FILTER_MS after the last key
      if (fl) fl.oninput = () => {
        st.filterText = fl.value;
        clearTimeout(st.filterTimer);
        st.filterTimer = setTimeout(() => {
          if (st.filter === st.filterText) return;
          const cur = opts.el.querySelector(".ph-filter"), had = !!cur && typeof document !== "undefined" && document.activeElement === cur;
          const pos = cur && cur.selectionStart;
          st.filter = st.filterText; st.allDays = ALL_DAYS; render();
          const n = opts.el.querySelector(".ph-filter");
          if (n && had) { n.focus(); try { n.setSelectionRange(pos, pos); } catch {} }
        }, opts.filterMs != null ? opts.filterMs : FILTER_MS);
      };
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

    load().catch((e) => { st.loaded = true; render(); say(errText(e), true); });
    render();
    return { render, reload: load, state: st, retry };
  }

  return { DEF_ID, THUMB_PX, URL_POOL, UPLOAD_POOL, ALL_DAYS, PENDING_MAX_AGE_MS, oneAtATime, thumbName, urlLoader, sessionQueue, unsentOf, noteUnsent, takeUnsent, unsentText, keptText, queueItems, retryable, canRetry, handOver, uploadFile, linkObjects, findInFolder, listFolder, folderLister, mapLimit, PAGE_SIZES, queueView, queuePrune, processItem, wireZoom, existingIds, ensureFolderPath, purposeText, pendingStore, pendingRecord, fromPending, splitPending, definition, photoPrefix, photoLink, fileName, exifDate, groupByDay, forObjects, parseObjects, fmtSize, coreClient, TIMEOUT_MS, UPLOAD_TIMEOUT_MS, TIMEOUT_TEXT, prepareImage, mount };
});
