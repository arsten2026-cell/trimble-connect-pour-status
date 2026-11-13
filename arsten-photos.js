// Arsten site photos: photos attached to model objects, shared by the Arsten 3D-viewer panels (Pour status, Assembly status).
//
// Storage (decided 13.11.2026, see side-session-notes/photos-attachments-research.md):
//  - the image: a project file in _ArstenDocs/Photos/<YYYY-MM-DD>/ (Core 2.0 files/fs/initiate -> PUT -> files/fs/commit),
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
  const ROOT_PATH = ["_ArstenDocs", "Photos"];

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

  // ---------- Core API (browser) ----------
  function coreClient(base, getToken) {
    async function req(path, method = "GET", body) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const token = await getToken(attempt > 0);
        const res = await fetch(base + path, { method, headers: Object.assign({ Authorization: "Bearer " + token }, body !== undefined ? { "Content-Type": "application/json" } : {}),
          body: body !== undefined ? JSON.stringify(body) : undefined });
        if (res.status === 401 && attempt < 2) continue;
        const text = await res.text();
        let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        if (!res.ok) { const e = new Error(`Core ${method} ${path.split("?")[0]}: ${res.status} ${(data && (data.message || data.errorcode)) || ""}`.trim()); e.status = res.status; throw e; }
        return data;
      }
    }
    return { req };
  }

  // ---------- image ----------
  async function prepareImage(file) {
    const buf = await file.arrayBuffer();
    const taken = exifDate(buf) || (file.lastModified ? new Date(file.lastModified) : new Date());
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { bmp = await createImageBitmap(file); }
    const k = Math.min(1, MAX_PX / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", JPEG_Q));
    return { blob, taken, w, h, originalSize: file.size, size: blob.size, name: file.name };
  }

  // ---------- UI ----------
  const CSS = `
  .ph-drop{border:1px dashed var(--line,#d9d5cc);padding:8px;text-align:center;font-size:12px;color:var(--muted,#6b6b6b);background:var(--panel,#fff)}
  .ph-drop.on{border-color:var(--accent,#E37424);background:#fff4e5}
  .ph-day{font-size:11px;font-weight:600;color:var(--muted,#6b6b6b);margin:8px 0 3px}
  .ph-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:4px}
  .ph-th{position:relative;aspect-ratio:1;background:#ece8df;cursor:pointer;overflow:hidden;border:0;padding:0}
  .ph-th img{width:100%;height:100%;object-fit:cover;display:block}
  .ph-th span{position:absolute;left:0;right:0;bottom:0;background:rgba(0,0,0,.55);color:#fff;font-size:9.5px;padding:1px 3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ph-q{font-size:11px;margin-top:4px}
  .ph-box{position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:50;display:flex;flex-direction:column;padding:8px;color:#fff}
  .ph-box img{flex:1;min-height:0;object-fit:contain;width:100%}
  .ph-box .ph-meta{font-size:12px;padding:6px 0}
  .ph-box .ph-acts{display:flex;gap:6px;flex-wrap:wrap}
  .ph-box button{background:#fff;color:#1f1f1f;border-color:#fff}
  .ph-box button.ph-bad{background:#b3261e;color:#fff;border-color:#b3261e}`;

  const T = {
    bg: { title: "Снимки", add: "Добави снимки", camera: "Камера", drop: "Пуснете снимки тук или изберете файлове", caption: "Описание (по избор)",
      needSel: "Изберете обект(и) в модела, за да добавите снимки към тях.", to: "Към", sel: "За избраното", all: "Всички по дни", filter: "Филтър (такт / марка)",
      none: "Няма снимки.", noneSel: "Няма снимки за избраното.", up: "Качване", done: "качена", fail: "грешка", show: "Покажи в модела", del: "Изтрий",
      delAsk: "Да се изтрие ли снимката? Това не може да се отмени.", yes: "Да, изтрий", no: "Не", close: "Затвори", orig: "оригинал",
      native: "Връзка в Connect", noNative: "без връзка в Connect (само в нашия списък)", loading: "Зареждане…" },
    en: { title: "Photos", add: "Add photos", camera: "Camera", drop: "Drop photos here or choose files", caption: "Caption (optional)",
      needSel: "Select object(s) in the model to add photos to them.", to: "To", sel: "For the selection", all: "All by day", filter: "Filter (pour / mark)",
      none: "No photos.", noneSel: "No photos for the selection.", up: "Uploading", done: "uploaded", fail: "failed", show: "Show in model", del: "Delete",
      delAsk: "Delete this photo? This cannot be undone.", yes: "Yes, delete", no: "No", close: "Close", orig: "original",
      native: "Linked in Connect", noNative: "not linked in Connect (our list only)", loading: "Loading…" },
  };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /**
   * Mount the Photos section.
   * opts: el, api (Workspace API), getToken(refresh), coreBase, project {id}, user (display name), client (PsetClient), libId,
   *       canAdd, canDeleteAny, lang ("bg"|"en"), targets(): [{modelId, id, guid, label}] (current selection),
   *       onStatus(text, bad), purposes: [{id, bg, en}] (optional upload purposes besides "general"),
   *       onUploaded({purpose, fileIds, objects}) (optional; after each batch with a purpose)
   */
  function mount(opts) {
    const L = () => T[opts.lang === "en" ? "en" : "bg"];
    const core = opts.core || coreClient(opts.coreBase, opts.getToken);
    const st = { records: [], view: "sel", filter: "", queue: [], urls: new Map(), folders: new Map(), loaded: false, open: null, confirm: false };
    const say = (t, bad) => opts.onStatus && opts.onStatus(t, bad);
    if (!document.getElementById("ph-css")) { const s = document.createElement("style"); s.id = "ph-css"; s.textContent = CSS; document.head.appendChild(s); }

    async function load() {
      try { await opts.client.ensureDefinition(opts.libId, definition()); } catch (e) { if (e.status !== 403) throw e; }
      const m = await opts.client.listAll(opts.libId, DEF_ID, photoPrefix(opts.project.id));
      st.records = [...m].map(([link, p]) => Object.assign({ link }, p));
      st.loaded = true;
      render();
    }

    // folders _ArstenDocs/Photos/<day>, created when missing
    async function folderFor(day) {
      if (st.folders.has(day)) return st.folders.get(day);
      let parent = st.rootId;
      if (!parent) { const p = await core.req(`projects/${encodeURIComponent(opts.project.id)}`); parent = st.rootId = p.rootId; }
      for (const name of [...ROOT_PATH, day]) {
        const key = parent + "/" + name;
        if (st.folders.has(key)) { parent = st.folders.get(key); continue; }
        const items = (await core.req(`folders/${encodeURIComponent(parent)}/items`)) || [];
        let f = (Array.isArray(items) ? items : items.items || []).find((x) => String(x.type).toUpperCase() === "FOLDER" && x.name === name);
        if (!f) f = await core.req("folders", "POST", { name, parentId: parent });
        st.folders.set(key, f.id); parent = f.id;
      }
      st.folders.set(day, parent);
      return parent;
    }

    async function uploadFile(folderId, name, blob) {
      const init = await core.req("files/fs/initiate", "POST", { parentId: folderId, parentType: "FOLDER", name });
      const put = await fetch(init.uploadURL, { method: "PUT", body: blob, headers: { "Content-Type": "image/jpeg" } });
      if (!put.ok) throw new Error(`upload PUT ${put.status}`);
      const done = await core.req("files/fs/commit", "POST", { uploadId: init.uploadId });
      let id = done && (done.id || done.fileId || (done.file && done.file.id) || (done.data && done.data.id));
      for (let i = 0; !id && i < 10; i++) {   // commit can finish asynchronously: look the file up in its folder
        await new Promise((r) => setTimeout(r, 800));
        const items = (await core.req(`folders/${encodeURIComponent(folderId)}/items`)) || [];
        const f = (Array.isArray(items) ? items : items.items || []).find((x) => x.name === name);
        if (f) id = f.id;
      }
      if (!id) throw new Error("upload: file id not returned");
      return id;
    }

    async function nativeLinks(fileId, objs) {
      const out = [];
      let models = [];
      try { models = (await opts.api.viewer.getModels()) || []; } catch {}
      const byModel = new Map();
      for (const o of objs) { if (!byModel.has(o.modelId)) byModel.set(o.modelId, []); byModel.get(o.modelId).push(o.guid); }
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
      }
      return out;
    }

    async function addFiles(files) {
      const objs = opts.targets();
      if (!objs.length) return say(L().needSel, true);
      const caption = ((opts.el.querySelector(".ph-cap") || {}).value || "").trim();
      const labels = [...new Set(objs.map((o) => o.label).filter(Boolean))];
      const purpose = ((opts.el.querySelector(".ph-purpose") || {}).value || "");
      const uploaded = [];
      const list = [...files].filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|heic|webp)$/i.test(f.name));
      for (const f of list) st.queue.push({ name: f.name, state: L().up + "…", file: f });
      render();
      for (const q of st.queue.filter((x) => x.file)) {
        const file = q.file; q.file = null;
        try {
          const img = await prepareImage(file);
          q.state = `${fmtSize(img.size)} (${L().orig} ${fmtSize(img.originalSize)}) – ${L().up}…`; render();
          const day = dayOf(img.taken);
          const name = fileName(img.taken, labels, Math.random().toString(36).slice(2, 6));
          const folderId = await folderFor(day);
          const fileId = await uploadFile(folderId, name, img.blob);
          let links = [], linkErr = "";
          try { links = await nativeLinks(fileId, objs); } catch (e) { linkErr = e.message; }
          const rec = { file_id: fileId, file_name: name, day, taken: isoLocal(img.taken), uploaded: isoLocal(new Date()), by: opts.user || "",
            caption, labels: labels.join(", "), objects: JSON.stringify(objs.map((o) => ({ modelId: o.modelId, guid: o.guid, label: o.label || "" }))),
            links: links.join(","), size: `${img.w}x${img.h} ${fmtSize(img.size)}`, deleted: false, purpose };
          const link = photoLink(opts.project.id, fileId);
          await opts.client.write(opts.libId, DEF_ID, link, rec);
          st.records.push(Object.assign({ link }, rec));
          uploaded.push(fileId);
          q.state = `${L().done}${links.length ? "" : " · " + L().noNative + (linkErr ? ` (${linkErr})` : "")}`;
        } catch (e) { q.state = `${L().fail}: ${e.message}`; q.bad = true; }
        render();
      }
      if (purpose && uploaded.length && opts.onUploaded) await opts.onUploaded({ purpose, fileIds: uploaded, objects: objs });
    }

    async function urlOf(r) {
      if (st.urls.has(r.file_id)) return st.urls.get(r.file_id);
      const p = core.req(`files/fs/${encodeURIComponent(r.file_id)}/downloadurl`).then((d) => (d && (d.url || d.downloadUrl || d.href)) || "");
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
      await opts.client.write(opts.libId, DEF_ID, r.link, { deleted: true, links: "" });
      r.deleted = true;
      st.open = null; st.confirm = false;
      render();
    }
    const canDelete = (r) => opts.canDeleteAny || (opts.canAdd && r.by && r.by === opts.user);

    function thumbs(items) {
      return `<div class="ph-grid">${items.map((r) => `<button class="ph-th" data-ph="${esc(r.file_id)}" title="${esc(r.caption || r.labels)}"><img alt="" data-src="${esc(r.file_id)}"><span>${esc((r.taken || "").slice(11, 16))} ${esc(r.labels)}</span></button>`).join("")}</div>`;
    }

    function render() {
      const l = L(), objs = opts.targets();
      const guids = objs.map((o) => o.guid);
      let body;
      if (!st.loaded) body = `<div class="sub">${l.loading}</div>`;
      else if (st.view === "sel") {
        const list = forObjects(st.records, guids);
        body = !guids.length ? `<div class="sub">${l.needSel}</div>` : list.length ? groupByDay(list).map((g) => `<div class="ph-day">${esc(g.day)}</div>${thumbs(g.items)}`).join("") : `<div class="sub">${l.noneSel}</div>`;
      } else {
        const groups = groupByDay(st.records, st.filter);
        body = groups.length ? groups.map((g) => `<div class="ph-day">${esc(g.day)} · ${g.items.length}</div>${thumbs(g.items)}`).join("") : `<div class="sub">${l.none}</div>`;
      }
      const labels = [...new Set(objs.map((o) => o.label).filter(Boolean))];
      opts.el.innerHTML = `
        ${opts.canAdd ? `<div class="ph-drop">${objs.length ? `<div>${l.to}: <b>${esc(labels.join(", ") || objs.length)}</b> (${objs.length})</div>` : `<div>${l.needSel}</div>`}
          <div>${l.drop}</div>
          ${(opts.purposes || []).length ? `<div class="bar" style="justify-content:center"><select class="ph-purpose"><option value="">${opts.lang === "en" ? "General" : "Обща"}</option>${opts.purposes.map((p) => `<option value="${esc(p.id)}"${st.purpose === p.id ? " selected" : ""}>${esc(opts.lang === "en" ? p.en : p.bg)}</option>`).join("")}</select></div>` : ""}
          <div class="bar" style="justify-content:center"><input type="text" class="ph-cap" placeholder="${esc(l.caption)}" style="flex:1;min-width:120px">
            <label class="small" style="border:1px solid var(--line,#d9d5cc);padding:2px 7px;cursor:pointer">${l.add}<input type="file" class="ph-file" accept="image/*" multiple hidden></label>
            <label class="small" style="border:1px solid var(--line,#d9d5cc);padding:2px 7px;cursor:pointer">${l.camera}<input type="file" class="ph-cam" accept="image/*" capture="environment" hidden></label></div>
          ${st.queue.length ? `<div class="ph-q">${st.queue.slice(-6).map((q) => `<div class="${q.bad ? "bad" : "sub"}">${esc(q.name)}: ${esc(q.state)}</div>`).join("")}</div>` : ""}</div>` : ""}
        <div class="bar"><button class="small ${st.view === "sel" ? "" : "secondary"}" data-phv="sel">${l.sel}</button><button class="small ${st.view === "all" ? "" : "secondary"}" data-phv="all">${l.all}</button>
          ${st.view === "all" ? `<input type="text" class="ph-filter" placeholder="${esc(l.filter)}" value="${esc(st.filter)}" style="flex:1;min-width:90px">` : ""}</div>
        <div class="ph-list">${body}</div>
        ${st.open ? box(st.open) : ""}`;
      wire();
      opts.el.querySelectorAll("img[data-src]").forEach((img) => { const r = st.records.find((x) => x.file_id === img.dataset.src); if (r) urlOf(r).then((u) => { if (u) img.src = u; }).catch(() => {}); });
    }
    function box(r) {
      const l = L();
      return `<div class="ph-box"><img alt="" data-src="${esc(r.file_id)}">
        <div class="ph-meta"><b>${esc(r.labels)}</b>${r.purpose ? ` · ${esc(((opts.purposes || []).find((p) => p.id === r.purpose) || {})[opts.lang === "en" ? "en" : "bg"] || r.purpose)}` : ""}${r.caption ? " – " + esc(r.caption) : ""}<br>${esc(r.taken.replace("T", " ").slice(0, 16))} · ${esc(r.by)} · ${esc(r.size)} · ${r.links ? l.native : l.noNative}</div>
        <div class="ph-acts">${st.confirm ? `<span>${l.delAsk}</span><button class="small ph-bad" data-pha="yes">${l.yes}</button><button class="small" data-pha="no">${l.no}</button>`
          : `<button class="small" data-pha="show">${l.show}</button>${canDelete(r) ? `<button class="small ph-bad" data-pha="del">${l.del}</button>` : ""}<button class="small" data-pha="close">${l.close}</button>`}</div></div>`;
    }
    function wire() {
      const el = opts.el, g = (fn) => () => Promise.resolve().then(fn).catch((e) => say(e.message, true));
      const pick = (inp) => { if (inp) inp.onchange = (e) => { const f = [...e.target.files]; e.target.value = ""; g(() => addFiles(f))(); }; };
      pick(el.querySelector(".ph-file")); pick(el.querySelector(".ph-cam"));
      const pu = el.querySelector(".ph-purpose");
      if (pu) pu.onchange = () => { st.purpose = pu.value; };
      const drop = el.querySelector(".ph-drop");
      if (drop) {
        drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("on"); };
        drop.ondragleave = () => drop.classList.remove("on");
        drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("on"); const f = [...(e.dataTransfer.files || [])]; g(() => addFiles(f))(); };
      }
      el.querySelectorAll("[data-phv]").forEach((b) => { b.onclick = () => { st.view = b.dataset.phv; render(); }; });
      const fl = el.querySelector(".ph-filter");
      if (fl) fl.oninput = () => { st.filter = fl.value; const pos = fl.selectionStart; render(); const n = opts.el.querySelector(".ph-filter"); if (n) { n.focus(); n.setSelectionRange(pos, pos); } };
      el.querySelectorAll("[data-ph]").forEach((b) => { b.onclick = () => { st.open = st.records.find((x) => x.file_id === b.dataset.ph); st.confirm = false; render(); }; });
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
    return { render, reload: load, state: st };
  }

  return { DEF_ID, definition, photoPrefix, photoLink, fileName, exifDate, groupByDay, forObjects, parseObjects, fmtSize, coreClient, prepareImage, mount };
});
