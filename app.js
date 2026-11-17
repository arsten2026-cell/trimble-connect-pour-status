// Pour status: Trimble Connect 3D-viewer extension for site progress on Tekla pour objects. Each pour object gets a
// status record (4 steps with date, by, note, history) stored in Trimble Connect's Property Set service on the link
// frn:entity:{IFC GUID}, in the project library "CIP/Монолитно", so it also shows in Connect's property panel
// and survives new IFC versions as long as Tekla keeps the pour object GUIDs.

// Pure helpers for the panel (no DOM), exported for node tests (test/ui.test.js).
(function (g) {
  "use strict";
  const ymd = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "")); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; };
  /** Whole days from date (YYYY-MM-DD) back to today (YYYY-MM-DD); negative = future; null if not a date. */
  function daysBack(date, today) {
    const a = ymd(date), b = ymd(today);
    return a == null || b == null ? null : Math.round((b - a) / 86400000);
  }
  /** Grey hint under a date box (week 1, A6): only when the date is more than 7 days back, or in the future. */
  function dateHint(date, today, lang) {
    const d = daysBack(date, today);
    if (d == null) return "";
    const bg = lang !== "en";
    if (d < 0) return bg ? "датата е в бъдещето" : "the date is in the future";
    if (d > 7) return bg ? `преди ${d} дни – проверете датата` : `${d} days ago – check the date`;
    return "";
  }
  /** Value shown in a step box: what the user typed (draft) wins over the saved/prefilled value (week 1, F6). */
  const boxValue = (saved, draft) => (draft != null ? draft : saved);
  /** Drafts typed for selection `draftGuids` stay only when the new selection still contains all of it ("one more
   *  piece" picked); any other selection drops them, so a note typed for pour A is never written to pour B (M2). */
  function keepDrafts(draftGuids, selGuids) {
    const d = [...(draftGuids || [])];
    if (!d.length) return false;
    const s = new Set(selGuids || []);
    return d.every((g) => s.has(g));
  }
  // ---------- remembered view settings (week 3, A7) ----------
  /** On/off setting from storage ("1"/"0"); anything else, no storage or a throwing storage (private mode, blocked
   *  site data) gives the default. */
  function readPref(store, key, def) {
    try {
      const s = typeof store === "function" ? store() : store;
      const v = s ? s.getItem(key) : null;
      return v === "1" ? true : v === "0" ? false : def;
    } catch { return def; }
  }
  /** Save an on/off setting; false when it could not be saved (the panel then just keeps it for this session). */
  function writePref(store, key, on) {
    try {
      const s = typeof store === "function" ? store() : store;
      if (!s) return false;
      s.setItem(key, on ? "1" : "0");
      return true;
    } catch { return false; }
  }
  /** Objects by colour for the model: one entry per stage that has objects, so the panel makes one setObjectState
   *  call per colour, not one per object. stages = PourStatus.STAGES (index 0 = not started). */
  function colourGroups(objects, stageOf, stages, seeThrough, seeThroughOpacity) {
    const buckets = stages.map(() => []);
    for (const o of objects || []) { const k = stages.indexOf(stageOf(o)); buckets[k < 0 ? 0 : k].push(o); }
    return buckets.map((objs, k) => ({ stage: stages[k], colour: stages[k].colour, opacity: k === 0 && seeThrough ? seeThroughOpacity : 1, objs }))
      .filter((g) => g.objs.length);
  }

  // ---------- rebar acceptance before "Излят" (week 3, A3) ----------
  /** Pours (labels) whose rebar is not accepted, by reason, from ArstenAcceptance.rebarNotApproved.
   *  Acc = the ArstenAcceptance module (none: no check, null); acc = its records, or null when they did not load
   *  (unknown: the user must confirm too). Returns null when nothing needs a warning. */
  function rebarCheck(Acc, acc, pours) {
    if (!Acc) return null;
    const list = [...new Set((pours || []).filter(Boolean))];
    if (!list.length) return null;
    if (!acc) return { unknown: true, open: [], rejected: [], none: [], pours: list };
    const out = { unknown: false, open: [], rejected: [], none: [], pours: [] };
    for (const p of Acc.rebarNotApproved(acc, list)) {
      const r = Acc.latestCovering(acc, p, "rebar");
      out[!r ? "none" : r.status === "rejected" ? "rejected" : "open"].push(p);
      out.pours.push(p);
    }
    return out.pours.length ? out : null;
  }
  /** One line for the "Излят" card: "Армировка: чака приемане за TAKT 3, TAKT 4 · отхвърлена за TAKT 5". */
  function rebarWarnText(chk, lang) {
    if (!chk) return "";
    const bg = lang !== "en";
    if (chk.unknown) return bg ? `Армировка: приемането не е заредено – проверете за ${chk.pours.join(", ")}` : `Rebar: acceptance not loaded – check ${chk.pours.join(", ")}`;
    const parts = [];
    if (chk.open.length) parts.push((bg ? "чака приемане за " : "awaiting acceptance for ") + chk.open.join(", "));
    if (chk.rejected.length) parts.push((bg ? "отхвърлена за " : "rejected for ") + chk.rejected.join(", "));
    if (chk.none.length) parts.push((bg ? "няма заявка за приемане за " : "no acceptance request for ") + chk.none.join(", "));
    return (bg ? "Армировка: " : "Rebar: ") + parts.join(" · ");
  }

  // ---------- search in the pours list (week 3, A5) ----------
  /** Does a pour label match the search? Terms are separated by "," or ";" (or spaces between plain numbers):
   *  a number = a whole number in the label ("12" finds "TAKT 12", not "TAKT 120"); a term with a number = that pour
   *  ("takt 5" = "TAKT 05"); other text = contained in the label. Empty search: everything. */
  function matchPour(label, query) {
    const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().toUpperCase();
    const keyOf = (s) => { const m = /^(.*?)(\d+)$/.exec(norm(s)); return m ? (m[1].trim() + " " + parseInt(m[2], 10)).trim() : null; };
    const terms = [];
    for (const chunk of String(query == null ? "" : query).split(/[,;]+/)) {
      const c = chunk.trim();
      if (!c) continue;
      if (/^[\d\s]+$/.test(c)) terms.push(...c.split(/\s+/).filter(Boolean)); else terms.push(c);
    }
    if (!terms.length) return true;
    const L = norm(label), nums = (L.match(/\d+/g) || []).map((x) => parseInt(x, 10)), key = keyOf(L);
    return terms.some((t) => {
      if (/^\d+$/.test(t)) return nums.includes(parseInt(t, 10));
      const k = keyOf(t);
      if (k && /\d$/.test(norm(t))) return key === k;
      return L.includes(norm(t));
    });
  }

  // ---------- "Статус без обект" with one stage loaded (speed audit item 3) ----------
  /** Orphans (PourStatus.orphans) split into the rows to list and the rest. Listed: records that can be re-attached,
   *  i.e. their pour (or their match key) exists in the loaded models. Records of pours that are not loaded - another
   *  stage, or a pour deleted from the model - have nothing to re-attach to and are only counted (thousands of rows with
   *  one stage of a big project loaded). */
  function orphanRows(orph) {
    const shown = [], hidden = [];
    for (const x of orph || []) (x.candidates && x.candidates.length ? shown : hidden).push(x);
    return { shown, hidden };
  }

  // ---------- the loaded model set (review round 12, M6 / audit item 8) ----------
  /** Key of the loaded models: every model as "id@versionId", sorted, from getModels("loaded"). null when it cannot be
   *  compared safely: nothing loaded, not a list, or any model without an id or a versionId (then the panel reloads). */
  function modelSetKey(specs) {
    if (!Array.isArray(specs) || !specs.length) return null;
    const out = new Set();
    for (const m of specs) {
      if (!m || m.id == null || m.id === "" || m.versionId == null || m.versionId === "") return null;
      out.add(String(m.id) + "@" + String(m.versionId));
    }
    return [...out].sort().join("|");
  }
  /** The loaded models are the same as at the last finished load: both keys known and equal. */
  const sameModelSet = (a, b) => a != null && b != null && a === b;

  const U = { daysBack, dateHint, boxValue, keepDrafts, readPref, writePref, colourGroups, rebarCheck, rebarWarnText, matchPour, orphanRows, modelSetKey, sameModelSet };
  if (typeof module === "object" && module.exports) module.exports = U; else g.PourUi = U;
})(typeof window !== "undefined" ? window : globalThis);

(() => {
  "use strict";
  if (typeof document === "undefined") return;
  const C = window.PourLogic, S = window.PourStatus, A = window.PsetApi, U = window.PourUi, LK = window.ArstenLinks;
  const $ = (id) => document.getElementById(id);
  const PROXY = "IfcBuildingElementProxy";
  const BATCH = 200;
  const T = {
    title: ["Монолитен бетон", "Cast-in-place concrete"],
    selection: ["Избрано", "Selection"], steps: ["Етапи", "Steps"], view: ["Изглед", "View"], pours: ["Тактове", "Pours"],
    fromViewer: ["Вземи от модела", "Use viewer selection"], follow: ["Следи избора в модела", "Follow model selection"], csv: ["Експорт Excel", "Export Excel"], clear: ["Изчисти", "Clear"],
    colour: ["Оцвети по статус", "Colour by status"], seeThrough: ["Незапочнатите прозрачни", "Not started see-through"], hideRebar: ["Скрий армировката", "Hide rebar"], orphans: ["Статус без обект", "Status without object"],
    nothing: ["Нищо не е избрано. Изберете тактове в модела (с отметка „Следи избора в модела“ панелът ги взема сам) или изберете такт от таблицата.",
      "Nothing selected. Select pour objects in the model (with \"Follow model selection\" ticked the panel picks them up by itself) or pick a pour in the table."],
    markDone: ["Готово", "Mark done"], undo: ["Премахни", "Remove"], note: ["Бележка (по избор)", "Note (optional)"],
    save: ["Запиши", "Save"], without: ["Без", "Without"],
    withoutTip: ["Етапът не важи за обекта (без кофраж / без армировка). Брои се за изпълнен, без количество за фактуриране.",
      "The step does not apply to this object (no formwork / no rebar). Counts as covered, no quantity to invoice."], noteOnly: ["Само бележка", "Note only"],
    noteOnlyTip: ["Записва само бележката (датата и кой остават)", "Saves only the note (date and who stay)"],
    done: ["готови", "done"], select: ["Избери", "Select"], pour: ["Такт", "Pour"],
    colourHint: ["Цветовете показват етапа на всеки такт в модела.", "The colours show each pour's stage in the model."],
    search: ["Търси такт (номер или име)", "Find a pour (number or name)"], selectMatches: ["Избери в модела", "Select in the model"],
    pourConfirm: ["Потвърди – излей", "Confirm – poured"], noMatch: ["Няма такт с това търсене.", "No pour matches the search."],
  };
  // one language for all tools (A10): shared key "arsten.lang" (shared/arsten-i18n.js), the old key read once
  const I18N = window.ArstenI18n, OLD_LANG = ["arsten.pourStatus.lang"];
  let lang = I18N ? I18N.getLang(OLD_LANG) : "bg";
  const fmtDate = (d, o) => (I18N ? I18N.fmtDate(d, lang, o) : String(d || ""));
  const t = (k) => (T[k] ? T[k][lang === "bg" ? 0 : 1] : k);
  const L2 = (b, e) => (lang === "bg" ? b : e);
  // counted forms (round 19 L6): countWord(1, "запис", "записа", "record", "records") = "1 запис"
  const countWord = (n, one, many, en1, enN) => `${n} ${lang === "bg" ? (Math.abs(Number(n)) === 1 ? one : many) : (Math.abs(Number(n)) === 1 ? en1 : enN)}`;
  const stepName = (s) => (lang === "bg" ? s.bg : s.en);

  // Remembered per user (browser) settings (week 3, A7). Every storage access is wrapped (U.readPref / U.writePref).
  const store = () => { try { return window.localStorage; } catch { return null; } };
  const PREF = { follow: "arsten.pourStatus.follow", coloured: "arsten.pourStatus.coloured", seeThrough: "arsten.pourStatus.seeThrough", rebarHidden: "arsten.pourStatus.hideRebar" };
  const state = {
    api: null, client: null, project: null, user: "",
    lib: null, defId: S.DEF_ID, ready: false,
    follow: U.readPref(store, PREF.follow, true),   // follow model selection (default on)
    pours: [], loose: [], objects: [],      // pour groups; all pour objects [{modelId,id,guid,key,props,bbox,group}]
    byKey: new Map(),                        // "modelId:id" -> pour object
    records: new Map(),                      // guid -> status props
    sel: [],                                 // selected pour objects
    coloured: U.readPref(store, PREF.coloured, true),        // "Оцвети по статус": on by default, remembered (A7, owner 17.11)
    rebarHidden: U.readPref(store, PREF.rebarHidden, false),
    seeThrough: U.readPref(store, PREF.seeThrough, true),    // not started = see-through (default on)
    filter: "",                              // search in the pours list (A5)
    armPour: null,                           // selection key armed by the first tap on "Излят" without accepted rebar (A3)
    drafts: {},                              // stepId -> {date?, note?} typed but not saved yet (survives re-renders; week 1, F6)
    draftSel: [],                            // GUIDs of the selection the drafts were typed for (M2)
    confirmOrphan: null,                     // guid of the orphan whose inline "Прехвърли" confirm box is open (week 1, F7)
    legacy: [],                              // [{guid, kind}] records still under a raw-"$" link: move / stale / merge (F4)
    backupAsk: null,                         // {act, into?, text}: a destructive action waiting for "Продължи без архив" (M5)
  };
  const objKey = (o) => o.modelId + ":" + o.id;
  /** Office content (legacy "Премести" banner, load diagnostics, raw GUIDs, hidden-record counts) for the office side,
   *  site roles see the work (A8). Same rule as Стомана (round 11, M5): admin, the PM (the "stages" cap), designers. */
  const office = () => ArstenAccess.side(state.access) === "office";
  /** May save statuses, notes, photos and acceptance requests (round 11, M3): pset-api lets only the groups with Edit
   *  write (00_ADMIN, 02, 02.1). A Connect project ADMIN outside them gets the panel read-only, with one line why. */
  const canWrite = () => ArstenAccess.canWrite(state.access);
  const readOnlyText = () => (ArstenAccess.hasRole(state.access, "admin")
    ? L2("Само преглед: добавете се в 00_ADMIN, за да записвате.", "Read only: add yourself to 00_ADMIN to save.")
    : L2("Само преглед: нямате права за запис.", "Read only: you have no rights to save."));
  const noWriteText = () => L2("Нямате права да записвате в библиотеката " + S.LIB_NAME + ".", "You have no permission to write to the library " + S.LIB_NAME + ".");
  const selKey = (objs) => objs.map((o) => o.guid).sort().join("|");
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  // text may be a function: then it is built again in the new language after a language switch (round 19 L4)
  let statusAgain = null;
  function setStatus(text, bad) {
    statusAgain = typeof text === "function" ? { text, bad } : null;
    $("status").textContent = typeof text === "function" ? text() : text; $("status").className = "status" + (bad ? " bad" : "");
  }
  const relabelStatus = () => { if (statusAgain) setStatus(statusAgain.text, statusAgain.bad); if (window.ArstenDiag && ArstenDiag.relabel) ArstenDiag.relabel(); };
  // Result of a write, shown at the bottom of the panel near the finger (week 1, A2); the status line stays as well.
  // The element stays in the DOM (visually hidden when idle) so screen readers announce it; errors use role="alert".
  let toastTimer = null;
  function toast(text, bad) {
    const el = $("toast");
    if (!el || !text) return;
    el.setAttribute("role", bad ? "alert" : "status");
    el.textContent = text;
    el.className = "toast show " + (bad ? "bad" : "ok");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = "toast"; el.textContent = ""; }, bad ? 8000 : 4000);
  }
  // Bumped on every change of state.records (loadRecords, putRec): splits / merges / orphans are computed once per
  // change, not on every selection click (speed audit item 3; see derived()).
  let recVer = 0, derivedMemo = null;
  // Writes in flight: a model reload waits for them, so a reload's older read can't replace a fresh write (M4).
  let inflight = 0;
  async function writing(fn) { inflight++; try { return await fn(); } finally { inflight--; } }
  const reloadBusy = () => reloading || reloadTimer != null;
  function report(text, bad) { setStatus(text, bad); toast(text, bad); }
  // a server refusal (403) always reads as "no rights", whichever write it was (round 11, M3)
  const errText = (e) => (e && e.status === 403 ? noWriteText() : (e && (e.message || e.toString())) || String(e));
  async function guarded(fn) { try { await fn(); } catch (e) { const m = L2("Грешка: ", "Error: ") + errText(e); setStatus(m, true); toast(m, true); console.error(e); } }
  async function pool(items, n, fn) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const k = next++; await fn(items[k], k); } }));
  }

  // ---------- access token (extension permission) ----------
  let tokenWaiters = [], token = null;
  function onToken(tk) { token = tk; const w = tokenWaiters; tokenWaiters = []; w.forEach((f) => f(tk)); }
  // The waiter is registered before asking (the token event may come while requestPermission runs). When Connect
  // returns the token directly, or refuses, the waiter and its 60 s timer are dropped, so no unobserved promise is
  // rejected a minute later (review round 12, L6).
  async function getToken(refresh) {
    if (token && !refresh) return token;
    let timer = 0, done = null;
    const p = new Promise((resolve, reject) => {
      done = (tk) => { clearTimeout(timer); resolve(tk); };
      tokenWaiters.push(done);
      timer = setTimeout(() => { tokenWaiters = tokenWaiters.filter((f) => f !== done); reject(new Error(L2("Trimble Connect не даде ключ за достъп", "No access token from Trimble Connect"))); }, 60000);
    });
    const drop = () => { clearTimeout(timer); tokenWaiters = tokenWaiters.filter((f) => f !== done); p.catch(() => {}); };
    let r;
    try { r = await state.api.extension.requestPermission("accesstoken"); } catch (e) { drop(); throw e; }
    if (r === "denied") { drop(); throw new Error(L2("Достъпът до данните в Trimble Connect е отказан за това разширение.", "Access to Trimble Connect data was denied for this extension.")); }
    if (r && r !== "pending" && r !== "granted") { drop(); token = r; return r; }
    return p;
  }
  /** getModels("loaded"); [] when the call fails (the model set then counts as changed). */
  async function loadedModels() {
    try { return (await state.api.viewer.getModels("loaded")) || []; } catch { return []; }
  }

  // ---------- reading pour objects (same rules as Pour tags) ----------
  async function loadPours() {
    const api = state.api;
    setStatus(L2("Четене на тактовете…", "Reading pours…"));
    let modelObjs = await api.viewer.getObjects({ parameter: { class: PROXY } });
    if (!(modelObjs || []).some((m) => (m.objects || []).length)) modelObjs = await api.viewer.getObjects();
    const items = [];
    for (const m of modelObjs || []) {
      const ids = (m.objects || []).map((o) => o.id);
      for (let i = 0; i < ids.length; i += BATCH) {
        const props = (await api.viewer.getObjectProperties(m.modelId, ids.slice(i, i + BATCH))) || [];
        const found = [];
        for (const p of props) { const ps = C.readPourPset(p); if (ps) found.push({ modelId: m.modelId, id: p.id, props: ps }); }
        if (!found.length) continue;
        try {
          const boxes = (await api.viewer.getObjectBoundingBoxes(m.modelId, found.map((f) => f.id))) || [];
          const byId = new Map(boxes.map((b) => [b.id, b.boundingBox]));
          found.forEach((f) => { f.bbox = byId.get(f.id) || null; });
        } catch {}
        const guids = (await api.viewer.convertToObjectIds(m.modelId, found.map((f) => f.id))) || [];
        found.forEach((f, k) => { f.guid = guids[k] || null; });
        items.push(...found.filter((f) => f.guid));
      }
    }
    const { pours, unnumbered } = C.groupPours(items);
    pours.forEach((g, i) => { g.colour = C.colourFor(i); });
    state.pours = pours; state.loose = unnumbered;
    state.objects = items;
    state.byKey = new Map(items.map((o) => [objKey(o), o]));
    for (const g of [...pours, ...unnumbered]) for (const o of g.objects) {
      o.group = g;
      o.key = S.matchKey(g.numbered ? g.key : g.label, o.props[C.P.parts], o.bbox);
    }
    return items.length;
  }

  // ---------- library / definition / records ----------
  async function setup() {
    $("setupBox").hidden = true;
    const found = await state.client.findLibrary(state.project.id, S.LIB_NAMES);
    if (!found.lib && found.denied > 0) {
      console.warn("library not readable", S.LIB_NAME, JSON.stringify({ denied: found.denied }));   // round 19 M1: into the diagnostics
      // A library the user may not read exists: it may be ours, so never ask for a new one (a second CIP/Монолитно; F9).
      showSetup(`<b>${esc(L2("Библиотеката съществува, но нямате достъп до нея – обърнете се към администратора.",
        "The library exists, but you have no access to it – ask the project administrator."))}</b>
        <div class="sub">${esc(L2(`Библиотека: ${S.LIB_NAME}`, `Library: ${S.LIB_NAME}`))}</div>
        <button id="btnRecheck" class="small">${L2("Провери отново", "Check again")}</button>`);
      return false;
    }
    if (!found.lib) {
      showSetup(`<b>${lang === "bg" ? "Нужна е еднократна настройка от администратор на проекта." : "One-time setup by a project admin is needed."}</b>
        <ol><li>${lang === "bg" ? "Отворете" : "Open"} <b>Property Set Libraries</b> ${lang === "bg" ? "в менюто на проекта" : "in the project menu"}.</li>
        <li><b>New library</b> → ${lang === "bg" ? "име" : "name"} <b>${S.LIB_NAME}</b> → Save.</li>
        <li>${lang === "bg" ? "Върнете се тук и натиснете" : "Come back and click"} <b>${lang === "bg" ? "Провери отново" : "Check again"}</b>.</li></ol>
        ${found.others.length ? `<div class="sub">${lang === "bg" ? "Библиотеки в проекта" : "Libraries in this project"}: ${esc(found.others.join(", "))}</div>` : ""}
        <button id="btnRecheck" class="small">${lang === "bg" ? "Провери отново" : "Check again"}</button>`);
      return false;
    }
    state.lib = found.lib;
    try {
      const r = await state.client.ensureDefinition(found.lib.id, S.definition());
      if (r.created) setStatus(L2("Полетата за статус са създадени в библиотеката ", "Status fields created in the library ") + found.lib.name);
    } catch (e) {
      if (e.status === 403) {
        showSetup(lang === "bg"
          ? `Библиотеката <b>${S.LIB_NAME}</b> съществува, но полетата за статус още не са създадени. Администратор на проекта трябва да отвори този панел веднъж. <button id="btnRecheck" class="small">Провери отново</button>`
          : `The library <b>${S.LIB_NAME}</b> exists but its status fields are not created yet. A project admin has to open this panel once. <button id="btnRecheck" class="small">Check again</button>`);
        return false;
      }
      throw e;
    }
    return true;
  }
  function showSetup(html) {
    $("setupBox").innerHTML = html; $("setupBox").hidden = false; $("mainBox").hidden = true;
    const b = $("btnRecheck"); if (b) b.onclick = () => loadGuarded();
  }
  async function loadRecords() {
    // All records of the definition, including objects no longer in the model (needed for merges, splits where the
    // original is gone, and "Статус без обект"). Fallback: only the objects in the model.
    // "$" links (F4): records are written under the URL-encoded link (S.entityLink); the raw-"$" link of before v36
    // is read as well. The encoded record wins; raw ones are listed in state.legacy for "Премести" (shared/arsten-links.js).
    const links = state.objects.map((o) => S.entityLink(o.guid));
    const legacy = state.objects.filter((o) => LK.hasLegacy(o.guid)).map((o) => LK.legacyLink(o.guid));
    // Always also read the objects in the model directly, so a list call that fails or returns less loses nothing.
    // The three reads are independent: run them at the same time (speed audit item 7). A failed direct read fails the
    // load as before; a failed list falls back to the objects in the model as before.
    const listing = state.client.listAll(state.lib.id, state.defId, "frn:entity:").then((all) => ({ all }), (error) => ({ error }));
    const [enc, raw, lst] = await Promise.all([
      state.client.readMany(state.lib.id, state.defId, links),
      legacy.length ? state.client.readMany(state.lib.id, state.defId, legacy) : new Map(),
      listing,
    ]);
    let listed = [];
    if (lst.all) {
      listed = [...lst.all];
      state.listMode = "all";
      state.listCount = lst.all.size;
    } else {
      console.warn("Listing all statuses failed, reading only objects in the model:", lst.error);
      state.listMode = "model";
    }
    // "$" GUIDs listed but not in the model: read both link forms directly, never trust the form the list returned (M3).
    const known = new Set(state.objects.map((o) => o.guid));
    const extra = LK.listedToRead(listed, known);
    if (extra.length) {
      const [e2, r2] = await Promise.all([state.client.readMany(state.lib.id, state.defId, extra.map(LK.entLink)),
        state.client.readMany(state.lib.id, state.defId, extra.map(LK.legacyLink))]);
      for (const x of e2) enc.set(x[0], x[1]);
      for (const x of r2) raw.set(x[0], x[1]);
      extra.forEach((g) => known.add(g));
    }
    const r = LK.collect({ enc, raw, listed, known });
    state.records = r.records;
    state.legacy = r.legacy;
    recVer++;
  }
  /** Write one object's record under its encoded link (replace: delete + re-create, so fields can be cleared) and
   *  drop its raw-"$" copy, by the shared rule LK.putRecord: a partial write on "move"/"merge" starts from the shown
   *  (merged) record (M2); a replace over a raw copy first writes the full record encoded, then drops the raw copy, then
   *  replaces, so a failed step never brings the old raw record back (M1). */
  async function putRec(guid, props, replace) {
    const lg = state.legacy.find((x) => x.guid === guid);
    const c = state.client, lib = state.lib.id, def = state.defId;
    const r = await LK.putRecord({
      write: (l, p) => c.write(lib, def, l, p), replace: (l, p) => c.replace(lib, def, l, p), remove: (l) => c.remove(lib, def, l),
    }, guid, props, { replace, kind: lg ? lg.kind : null, shown: state.records.get(guid) });
    state.records.set(guid, r.body);
    recVer++;
    if (r.dropped) state.legacy = state.legacy.filter((x) => x.guid !== guid);
    return r.body;
  }
  // ---------- undo files before mass actions (shared/arsten-backup.js, owner 16.11.2026) ----------
  const backupCache = new Map();
  let backupCore = null;
  const coreFor = () => window.ARSTEN_PHOTOS_CORE || backupCore || (backupCore = ArstenBackup.coreClient(ArstenAccess.coreBase(state.project.location), getToken));
  /** The links a putRec on these GUIDs touches: the encoded one, plus the raw-"$" copy it deletes. */
  const linksOf = (guids) => guids.flatMap((g) => [S.entityLink(g)].concat(state.legacy.some((x) => x.guid === g) ? [LK.legacyLink(g)] : []));
  /** Snapshot of the records an action is about to change or delete (links, read fresh), uploaded to
   *  _AM_Docs/Backups/<day>/ before the action runs. Upload failed: the JSON is downloaded in the browser and the
   *  action goes on with a warning - except a destructive one (o.destructive: Премести, merge), which stops and asks
   *  "Продължи без архив" (state.backupAsk; o.ask = {act, into}) unless o.noBackupOk (that answer). A failed READ, a
   *  link returned in another form (M4) or a missing backup module (Low 14) stops the action: nothing changes without
   *  its undo file. Returns the text added to the result message, or null = stopped, waiting for the answer. */
  async function backupFirst(action, links, o) {
    o = o || {};
    if (!links.length) return "";
    if (!window.ArstenBackup) throw new Error(L2("Модулът за архив не е зареден – действието е спряно, нищо не е променено. Презаредете панела.",
      "The backup module is not loaded – the action was stopped, nothing was changed. Reload the panel."));
    const uniq = [...new Set(links)];
    let records;
    try {
      const now = await state.client.readMany(state.lib.id, state.defId, uniq);
      records = ArstenBackup.recordsFrom(uniq.map((link) => ({ def: state.defId, link })), new Map([[state.defId, now]]), { decode: LK.guidOfLink });
    } catch (e) { throw new Error(L2("Архивът не може да се направи – нищо не е променено: ", "The backup could not be made – nothing was changed: ") + errText(e)); }
    const snap = ArstenBackup.snapshot({ tool: "pour", action, project: state.project, by: state.user, library: state.lib, records });
    const res = await ArstenBackup.save({ core: coreFor(), projectId: state.project.id, snapshot: snap, cache: backupCache });
    if (!res.uploaded) {
      console.warn("backup not uploaded to Connect", res.saved, res.error);
      if (o.destructive && !o.noBackupOk) {
        state.backupAsk = Object.assign({ text: ArstenBackup.failedText(lang, res) }, o.ask);
        report(ArstenBackup.failedText(lang, res) + L2(" – нищо не е променено. Продължете без архив или откажете.", " – nothing was changed. Go on without a backup or cancel."), true);
        render();
        return null;
      }
      toast(ArstenBackup.failedText(lang, res), true);
    }
    // the path only for the office side; site roles see "Архивът е запазен" (A11)
    return office() || !I18N ? ArstenBackup.note(res, lang) : " · " + I18N.word("backupSaved", lang);
  }
  /** The inline "Продължи без архив" box of a destructive action whose backup was not uploaded (M5). */
  function backupAskBox() {
    const a = state.backupAsk;
    if (!a) return "";
    const what = a.act === "moveLegacy" ? L2("„Премести“", "\"Move\"") : L2("Обединяването", "The merge");
    return `<div class="warn" role="alert"><b>${esc(a.text)}</b>
      <div>${esc(L2(`${what} изтрива или презаписва записи. Без архив в Connect промяната не може да се върне.`, `${what} deletes or overwrites records. Without a backup in Connect it cannot be undone.`))}</div>
      <div class="bar"><button class="small" data-act="backupGo">${esc(L2("Продължи без архив", "Go on without a backup"))}</button>
      <button class="small secondary cancel" data-act="backupNo">${esc(L2("Откажи", "Cancel"))}</button></div></div>`;
  }
  const BIG = 10;   // a step write over more than this many objects gets an undo file first

  /** "Премести": every record still under a raw-"$" link goes to its URL-encoded link, then the raw one is deleted. Both
   *  are read fresh; an encoded record only gets the raw fields when the raw one is newer ("merge"); "stale" ones are
   *  only deleted (LK.movePatch, same rules as Стомана). */
  async function moveLegacy(noBackupOk) {
    const list = state.legacy.slice();
    if (!list.length || !state.lib) return;
    const bak = await backupFirst("move", list.flatMap((x) => [LK.legacyLink(x.guid), S.entityLink(x.guid)]), { destructive: true, noBackupOk, ask: { act: "moveLegacy" } });
    if (bak === null) return;
    let done = 0, failed = 0, first = "";
    setStatus(`${L2("Преместване", "Moving")}: 0/${list.length}…`);
    await pool(list, 6, async (x) => {
      try {
        const raw = await state.client.readOne(state.lib.id, state.defId, LK.legacyLink(x.guid));
        const rp = raw && raw.props;
        if (rp) {
          const enc = await state.client.readOne(state.lib.id, state.defId, S.entityLink(x.guid));
          const patch = LK.movePatch(LK.classify(enc && enc.props, rp), enc && enc.props, rp, 4000);   // kind from the two fresh reads (Low 7)
          if (patch) await state.client.writeIfUnchanged(state.lib.id, state.defId, S.entityLink(x.guid), patch, enc ? enc.v : undefined);
          await state.client.remove(state.lib.id, state.defId, LK.legacyLink(x.guid));
        }
        done++;
      } catch (e) { failed++; if (!first) first = errText(e); }
      setStatus(`${L2("Преместване", "Moving")}: ${done + failed}/${list.length}…`);
    });
    await loadRecords();
    report(`${L2("Преместени", "Moved")} ${countWord(done, "запис", "записа", "record", "records")}.`
      + (failed ? ` · ${failed} ${L2("грешки", "failed")} (${first})` : "")
      + L2(" В Tekla: Trimble Connect → Property sets → синхронизиране.", " In Tekla: Trimble Connect → Property sets → synchronize.") + bak, failed > 0);
    render();
    if (state.coloured) await applyColours();
  }
  function legacyBanner() {
    const n = state.legacy.length;
    if (!n || !office()) return "";   // an admin migration task: site roles never see it (A8)
    return `<div class="warn">${esc(n === 1 ? L2("1 запис (такт с „$“ в GUID) е в стар формат и не се вижда в панела на Connect и в Tekla.",
      "1 record (a pour object with \"$\" in the GUID) is in the old format and is not shown in Connect's panel or Tekla.") : L2(`${n} записа (тактове с „$“ в GUID) са в стар формат и не се виждат в панела на Connect и в Tekla.`,
      `${n} records (pour objects with "$" in the GUID) are in the old format and are not shown in Connect's panel or Tekla.`))}
      <div class="bar"><button class="small" data-act="moveLegacy"${canWrite() ? "" : " disabled"}>${esc(L2(`Премести (${n})`, `Move (${n})`))}</button>${canWrite() ? "" : `<span class="sub">${esc(readOnlyText())}</span>`}</div></div>`;
  }

  // ---------- selection ----------
  /** Take the viewer's selection into the panel. quiet: called by "follow model selection" (empty selection just clears). */
  async function selectionFromViewer(quiet) {
    const sel = (await state.api.viewer.getSelection()) || [];
    const picked = [];
    let n = 0;
    for (const m of sel) for (const id of m.objectRuntimeIds || []) { n++; const o = state.byKey.get(m.modelId + ":" + id); if (o) picked.push(o); }
    if (!n) {
      // A model reload empties the viewer selection: keep the panel's selection and drafts, the reload restores them (M3 d).
      if (quiet === true && reloadBusy()) return;
      if (quiet === true) { setSel([]); setStatus(""); return render(); }
      return setStatus(t("nothing"), true);
    }
    if (!picked.length) return setStatus(`${n} ${lang === "bg" ? "избрани обекта, но нито един не е такт." : "objects selected, none of them is a pour object."}`, true);
    setSel(picked);
    setStatus("");
    render();
  }
  /** Every selection change goes through here: drafts stay only for a superset of the selection they were typed for (M2). */
  function setSel(objs) {
    state.sel = objs.slice();
    if (state.armPour && state.armPour !== selKey(state.sel)) state.armPour = null;   // a confirm is for one selection only (A3)
    if (reloadTimer != null && !reloading) pendingKeep = state.sel.map((o) => o.guid);   // a reload is waiting: restore this one
    if (Object.keys(state.drafts).length && !U.keepDrafts(state.draftSel, state.sel.map((o) => o.guid))) { state.drafts = {}; state.draftSel = []; }
  }
  async function selectPour(g) { await selectObjects(g.objects); }
  async function selectObjects(objs) {
    setSel(objs);
    const byModel = new Map();
    for (const o of objs) { if (!byModel.has(o.modelId)) byModel.set(o.modelId, []); byModel.get(o.modelId).push(o.id); }
    const sel = { modelObjectIds: [...byModel].map(([modelId, objectRuntimeIds]) => ({ modelId, objectRuntimeIds })) };
    await state.api.viewer.setSelection(sel, "set");
    await state.api.viewer.setCamera(sel, { animationTime: 500 });
    render();
  }

  // Model quantities of a pour object (Tekla pour export): concrete m³, rebar kg, formwork m² (sides + bottom).
  function liveQty(o) {
    const p = o.props || {};
    const fw = (toNum(p[C.P.fwSides]) || 0) + (toNum(p[C.P.fwBottom]) || 0);
    return { volume: toNum(p[C.P.volume]), rebar: toNum(p[C.P.rebar]), formwork: fw || (toNum(p[C.P.fwSides]) == null && toNum(p[C.P.fwBottom]) == null ? null : 0) };
  }
  // pour name as shown (photos and acceptance requests are filed under it)
  const accPour = (o) => (o.group && o.group.label) || (o.props && o.props[C.P.number]) || "";
  const pourOf = (o) => (o.group && o.group.numbered ? o.group.key : (o.group && o.group.label) || "");
  const snapOf = (o) => ({ bbox: o.bbox || null, volume: liveQty(o).volume });

  // ---------- writing steps ----------
  // mode: "mark" (done / correct), "undo", or "note" (change only the note of objects that have the step).
  // Empty date or note boxes mean "keep what each object has" when the selection had different values (mixed).
  async function applyStep(stepId, mode) {
    const step = S.STEPS.find((s) => s.id === stepId);
    const dateBox = $("date_" + stepId), noteBox = $("note_" + stepId);
    const keepDate = !dateBox.value, keepNote = !noteBox.value.trim() && noteBox.dataset.mixed === "1";
    const note = noteBox.value.trim();
    const objs = state.sel.slice();
    if (!objs.length) return;
    // max = today on the box, but a typed date can still pass it (A6)
    if (!keepDate && (mode === "mark" || mode === "na") && (U.daysBack(dateBox.value, S.today()) || 0) < 0) {
      return report(L2("Датата е в бъдещето – изберете днешна или по-ранна дата.", "The date is in the future – pick today or an earlier date."), true);
    }
    const has =(o) => (state.records.get(o.guid) || {})[stepId];
    // Partly done selection: "Готово" marks only the objects that do not have the step yet (the others keep theirs).
    const partly = objs.some(has) && !objs.every(has);
    const targets = mode === "mark" || mode === "na" ? (partly ? objs.filter((o) => !has(o)) : objs) : objs.filter(has);
    if (!targets.length) return report(lang === "bg" ? "Няма обекти с този етап." : "No objects with this step.", true);
    if (mode === "note" && keepNote) return report(lang === "bg" ? "Напишете бележка." : "Type a note.", true);
    // "Излят" over pours whose rebar is not accepted: the first tap only arms the button ("Потвърди – излей"), the
    // second writes (A3; no window.confirm, Connect's frame can block it). Site reality wins, but the choice is conscious.
    const rebar = stepId === "poured" && mode === "mark" ? U.rebarCheck(window.ArstenAcceptance, state.acc, targets.filter((o) => !has(o)).map(accPour)) : null;
    if (rebar && state.armPour !== selKey(objs)) {
      state.armPour = selKey(objs);
      render();
      return report(U.rebarWarnText(rebar, lang) + L2(" – натиснете „Потвърди – излей“, за да запишете.", " – press \"Confirm – poured\" to save."), true);
    }
    const confirmed = !!rebar;
    state.armPour = null;
    const bak = targets.length > BIG ? await backupFirst(`${stepId}-${mode}`, linksOf(targets.map((o) => o.guid))) : "";
    let done = 0, failed = 0, firstErr = "";
    setStatus(`${stepName(step)}: 0/${targets.length}…`);
    await pool(targets, 6, async (o) => {
      const cur = state.records.get(o.guid) || null;
      const old = cur || {};
      const next = mode === "undo" ? S.undoStep(cur, stepId, { by: state.user })
        : mode === "note" ? S.setNote(cur, stepId, { note, by: state.user })
        : (mode === "na" ? S.markNa : S.markStep)(cur, stepId, {
          date: keepDate ? (old[stepId] && old[`${stepId}_date`]) || S.today() : dateBox.value,
          note: keepNote ? old[`${stepId}_note`] || "" : note,
          by: state.user, pour: pourOf(o), key: o.key, qty: liveQty(o)[S.STEP_QTY[stepId]], snap: snapOf(o) });
      try {
        await putRec(o.guid, next, mode === "undo" || S.clearsField(cur, next));
        done++;
      } catch (e) {
        failed++;
        if (e.status === 403) throw new Error(noWriteText());
        console.error(e);
        if (!firstErr) firstErr = e.message || String(e);
      }
      setStatus(`${stepName(step)}: ${done}/${targets.length}…`);
    });
    const verb = mode === "undo" ? L2("премахнато", "removed") : mode === "na" ? L2("отбелязано „без“", "marked without") : mode === "note" ? L2("бележка записана", "note saved") : L2("записано", "saved");
    let warn = "";
    if (stepId === "poured" && mode === "mark" && done && window.ArstenAcceptance) {
      const not = ArstenAcceptance.rebarNotApproved(state.acc || [], targets.map(accPour));
      if (not.length) warn = " · " + L2(`Внимание: армировката не е приета за ${not.join(", ")}`, `Warning: rebar not accepted for ${not.join(", ")}`);
    }
    if (done && !failed) delete state.drafts[stepId];   // saved: the boxes show the saved values again
    report(`${stepName(step)}: ${verb} ${done}` + (failed ? ` · ${failed} ${lang === "bg" ? "грешки" : "failed"} (${firstErr})` : "") + warn + bak, failed > 0 || (!!warn && !confirmed));
    render();
    if (state.coloured) await applyColours();
  }

  // ---------- site photos (shared/arsten-photos.js) ----------
  // Same library as the statuses (definition "photo"). This panel is for admins and the general contractor only,
  // so everyone here may add photos; admins may delete anyone's, the others their own.
  function mountPhotos() {
    if (state.photos || !window.ArstenPhotos || !state.lib) return;
    // The photo module saves each photo record with client.write; wrap it to report the result near the finger (A2).
    // A new photo's record has no purpose-only change: re-marking existing photos (only `purpose` changes, uploaded long
    // ago) gets no toast of its own (the acceptance request reports it). Several uploads give one toast with the count.
    const client = Object.create(state.client);
    let upN = 0, upTimer = null;
    client.write = (...a) => writing(async () => {
      let r;
      try { r = await state.client.write.apply(state.client, a); }
      catch (e) { toast(L2("Снимката не е записана: ", "Photo not saved: ") + errText(e), true); throw e; }
      const rec = a[3] || {};
      if (rec.deleted) toast(L2("Снимката е изтрита", "Photo deleted"));
      else if (Date.now() - (Date.parse(rec.uploaded || "") || 0) < 120000) {
        upN++;
        clearTimeout(upTimer);
        upTimer = setTimeout(() => { upN = 0; }, 5000);
        toast(upN > 1 ? L2(`Качени снимки: ${upN} ✓`, `Photos uploaded: ${upN} ✓`) : L2("Снимката е качена ✓", "Photo uploaded ✓"));
      }
      return r;
    });
    // Upload steps that fail (start / commit of the file) show a red toast; the photo module marks the row "грешка".
    const baseCore = window.ARSTEN_PHOTOS_CORE || ArstenPhotos.coreClient(ArstenAccess.coreBase(state.project.location), getToken);
    const core = { req: async (path, ...rest) => {
      try { return await baseCore.req(path, ...rest); }
      catch (e) { if (/^files\/fs\/(initiate|commit)$/.test(path)) toast(L2("Снимката не е качена: ", "Photo upload failed: ") + errText(e), true); throw e; }
    } };
    const opts = {
      el: $("photosBox"), api: state.api, getToken, project: state.project, user: state.user, client, libId: state.lib.id,
      coreBase: ArstenAccess.coreBase(state.project.location), core,
      // read-only admins (M3): no upload, no delete; admins with write access may delete anyone's photo
      canAdd: canWrite(), canDeleteAny: canWrite() && ArstenAccess.hasRole(state.access, "admin"), lang,
      targets: () => state.sel.filter((o) => o.guid).map((o) => ({ modelId: o.modelId, id: o.id, guid: o.guid, label: accPour(o) })),
      onStatus: (text, bad) => { setStatus(text, bad); if (bad) toast(text, true); },
      purposes: window.ArstenAcceptance ? [{ id: "formwork", bg: "За приемане – Кофраж", en: "For acceptance – Formwork" }, { id: "rebar", bg: "За приемане – Армировка", en: "For acceptance – Rebar" }, { id: "both", bg: "За приемане – Кофраж и армировка", en: "For acceptance – Formwork and rebar" }] : [],
      // round 15, L7: true only when the photos were attached to the request(s); guarded shows the error and returns
      // nothing, so the photo module offers "Изпрати за приемане сега" only after a success
      onUploaded: async (u) => { let ok = false; await guarded(async () => { await writing(() => acceptancePhotos(u)); ok = true; }); return ok; },
      // A9: "Изпрати за приемане сега" right after photos for acceptance are uploaded – the same send as the button below
      sendNow: canWrite() && window.ArstenAcceptance ? () => guarded(() => writing(sendAcceptance)) : null,
    };
    state.photos = opts;
    opts.ui = ArstenPhotos.mount(opts);
  }

  // ---------- acceptance by the structural designer (shared/arsten-acceptance.js) ----------
  async function loadAcceptance() {
    if (!window.ArstenAcceptance || !state.lib) return;
    const A = ArstenAcceptance, lib = state.lib.id;
    for (const d of [A.definition(), A.decisionDefinition()]) { try { await state.client.ensureDefinition(lib, d); } catch (e) { if (e.status !== 403) throw e; } }
    const m = await state.client.listAll(lib, A.DEF_ID, A.prefix(state.project.id));
    let dec = new Map();
    try { dec = await state.client.listAll(lib, A.DEC_ID, A.prefix(state.project.id)); } catch (e) { if (e.status !== 404) throw e; }
    // the status shown comes ONLY from the decisions (written by the 4.1 group), never from the request itself
    state.acc = A.merge([...m].map(([link, p]) => Object.assign({ link }, p)), dec);
  }
  /** Change one request on its FRESH server copy and save it whole (replace, so cleared fields are cleared).
   *  change(fresh | null) returns the full record to save, or null to leave it. Returns the saved record or null. */
  async function saveAcc(link, change) {
    const A = ArstenAcceptance, lib = state.lib.id;
    // the request and its decision read at the same time (review round 12, L8); no decision definition yet (404) = none
    const [got, dec] = await Promise.all([
      state.client.readMany(lib, A.DEF_ID, [link]),
      state.client.readMany(lib, A.DEC_ID, [link]).catch((e) => { if (e.status !== 404) throw e; return new Map(); }),
    ]);
    const fresh = got.has(link) ? A.merge([Object.assign({ link }, got.get(link))], dec)[0] : null;
    const next = change(fresh);
    if (!next) return null;
    const rec = A.reqProps(next);   // the contractor writes the REQUEST only; decisions are the 4.1 group's
    await state.client.replace(lib, A.DEF_ID, link, rec);
    const saved = A.merge([Object.assign({ link }, rec)], dec)[0];
    const i = (state.acc || []).findIndex((r) => r.link === link);
    if (i >= 0) state.acc[i] = saved; else (state.acc = state.acc || []).push(saved);
    return saved;
  }
  let accBusy = false;
  async function acceptancePhotos(u) {
    // fresh list first, so photos join a request someone else opened meanwhile instead of creating a second one
    try { await loadAcceptance(); } catch (e) { throw new Error(L2("Заявките за приемане не можаха да се заредят: ", "Acceptance requests could not be loaded: ") + ((e && e.message) || e)); }
    const { writes } = ArstenAcceptance.attachPhotos(state.acc || [], { projectId: state.project.id, step: u.purpose, objects: u.objects, photoIds: u.fileIds,
      by: state.user, newId: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6) });
    for (const w of writes) await saveAcc(w.link, () => w.props);
    report(L2(`Заявка за приемане: ${writes.length} (изпратете с „Изпрати за приемане“)`, `Acceptance requests: ${writes.length} (send with "Send for acceptance")`));
    render();
  }
  async function sendAcceptance() {
    if (!canWrite()) return report(readOnlyText(), true);   // round 11, M3
    if (accBusy) return;
    accBusy = true;
    try { await sendAcceptanceNow(); } finally { accBusy = false; render(); }
  }
  async function sendAcceptanceNow() {
    await loadAcceptance();   // fresh: someone may have decided or sent meanwhile
    const list = ArstenAcceptance.toSend(state.acc || []);
    if (!list.length) { render(); return report(L2("Няма неизпратени заявки.", "Nothing left to send.")); }
    const data = await ArstenAccess.loadProjectAccess({ projectId: state.project.id, location: state.project.location, getToken });
    const g = (data.groups || []).find((x) => ArstenAccess.groupKey(x.name) === ArstenAccess.groupKey(ArstenAcceptance.APPROVER_GROUP));
    if (!g) return report(L2("Няма група „4.1-STRUCTURAL DESIGNER“ в проекта.", "No group 4.1-STRUCTURAL DESIGNER in the project."), true);
    const core = window.ARSTEN_PHOTOS_CORE || ArstenPhotos.coreClient(ArstenAccess.coreBase(state.project.location), getToken);
    const body = ArstenAcceptance.todoBody(list, { projectId: state.project.id, groupId: g.id, lang });
    const todo = await core.req("todos", "POST", body);
    const todoId = (todo && (todo.id || todo.todoId)) || "";
    // 4 requests at a time (review round 12, L8: 20 requests were ~12 s); each still re-reads its own fresh copy, and
    // the first failure stops the rest as the loop did
    await A.mapLimit(list, 4, (r) => saveAcc(r.link, (fresh) => (fresh && fresh.status === "open" && !fresh.sent ? ArstenAcceptance.markSent(fresh, todoId, state.user) : null)));
    report(L2(`Изпратено за приемане: ${list.length} (една задача в Connect)`, `Sent for acceptance: ${list.length} (one Connect ToDo)`));
    render();
  }
  function renderAcceptance() {
    const box = $("accBox");
    if (!box) return;
    if (!window.ArstenAcceptance) { box.innerHTML = ""; return; }
    if (!state.acc) { box.innerHTML = state.accError ? `<div class="sub bad">${esc(L2("Заявките за приемане не се заредиха: ", "Acceptance requests did not load: ") + state.accError)}</div>` : ""; return; }
    const A = ArstenAcceptance, pend = A.toSend(state.acc);
    const pours = [...new Set(state.sel.map(accPour))];
    const row = (pour, step) => {
      const r = A.latest(state.acc, pour, step);
      if (!r) return "";
      const s = A.STATUS[r.status] || A.STATUS.open;
      return `<div class="sub"><span class="sw" style="background:${s.colour}"></span>${esc(pour)} · ${esc(A.STEPS[step][lang])}: <b>${esc(s[lang])}</b>${r.status === "open" && !r.sent ? L2(" (не е изпратена към проектанта)", " (not sent to the designer yet)") : ""}${r.decided_by ? ` – ${esc(r.decided_by)} ${esc(fmtDate(r.decided, { time: true }))}` : ""}${r.comment ? `<br>„${esc(r.comment)}“` : ""}</div>`;
    };
    box.innerHTML = pours.map((p) => row(p, "formwork") + row(p, "rebar") + row(p, "both")).join("")
      + (pend.length ? `<div class="bar"><button class="small" id="btnSendAcc"${accBusy || !canWrite() ? " disabled" : ""}>${L2(`Изпрати за приемане (${pend.length})`, `Send for acceptance (${pend.length})`)}</button></div>` : "");
    const b = $("btnSendAcc");
    if (b) b.onclick = () => guarded(() => writing(sendAcceptance));
  }

  // ---------- rebar visibility ----------
  // Rebar as Tekla exports it to IFC. Hidden/shown with the viewer's own visibility ("Reset model" shows it again).
  const REBAR_CLASSES = ["IfcReinforcingBar", "IfcReinforcingMesh", "IfcTendon"];
  // Not via Connect's native class filter: live it returned nothing for these classes (1028 exports, 2026-11-13), so the
  // tick box did nothing. Read every object's class instead; done once per loaded model set (reset on model change).
  // A model whose version and object count are the same as when its rebar was found is not read again after a reload
  // (review round 12, L8 / audit item 14: a 10k-bar model was ~7-8 s per reload). No version known: read as before.
  const rebarCache = new Map();   // modelId -> {ver, n: objects in the model, ids: rebar runtime ids}
  async function rebarIds() {
    if (state.rebarIds) return state.rebarIds;
    const api = state.api, byModel = new Map(), next = new Map();
    const versions = new Map();
    for (const m of await loadedModels()) if (m && m.versionId) { if (m.id != null) versions.set(m.id, m.versionId); versions.set(m.versionId, m.versionId); }
    const re = new RegExp(`^(${REBAR_CLASSES.join("|")})$`, "i");
    for (const m of (await api.viewer.getObjects()) || []) {
      const ids = (m.objects || []).map((o) => o.id), ver = versions.get(m.modelId);
      const c = ver ? rebarCache.get(m.modelId) : null;
      let found;
      if (c && c.ver === ver && c.n === ids.length) found = c.ids;
      else {
        found = [];
        for (let i = 0; i < ids.length; i += BATCH) {
          setStatus(L2(`Търся армировката… ${i} от ${ids.length}`, `Finding rebar… ${i} of ${ids.length}`));
          const props = (await api.viewer.getObjectProperties(m.modelId, ids.slice(i, i + BATCH))) || [];
          found.push(...props.filter((p) => re.test(String(p.class || ""))).map((p) => p.id));
        }
      }
      if (ver) next.set(m.modelId, { ver, n: ids.length, ids: found });
      if (!byModel.has(m.modelId)) byModel.set(m.modelId, []);
      byModel.get(m.modelId).push(...found);
    }
    rebarCache.clear();
    for (const [k, v] of next) rebarCache.set(k, v);   // only the models loaded now
    state.rebarIds = [...byModel].filter(([, ids]) => ids.length).map(([modelId, ids]) => ({ modelId, objectRuntimeIds: [...new Set(ids)] }));
    return state.rebarIds;
  }
  async function setRebarVisible(visible) {
    const ids = await rebarIds();
    if (!ids.length) return 0;
    await state.api.viewer.setObjectState({ modelObjectIds: ids }, { visible });
    return ids.reduce((t, m) => t + m.objectRuntimeIds.length, 0);
  }

  // ---------- colours ----------
  const STAGES = S.STAGES;   // not started, formwork, rebar first (formwork pending), rebar, poured, stripped
  const NOT_STARTED_OPACITY = S.SEE_THROUGH != null ? S.SEE_THROUGH : 0.3;   // status.js (master) since week 3
  const selector = (objs) => {
    const byModel = new Map();
    for (const o of objs) { if (!byModel.has(o.modelId)) byModel.set(o.modelId, []); byModel.get(o.modelId).push(o.id); }
    return { modelObjectIds: [...byModel].map(([modelId, objectRuntimeIds]) => ({ modelId, objectRuntimeIds })) };
  };
  // One run at a time; a call during a run repaints once more afterwards (records or the selection changed meanwhile).
  let colourRun = null, colourAgain = false;
  function applyColours() {
    if (colourRun) { colourAgain = true; return colourRun; }
    colourRun = (async () => {
      try { do { colourAgain = false; await paintColours(); } while (colourAgain); } finally { colourRun = null; }
    })();
    return colourRun;
  }
  async function paintColours() {
    const api = state.api;
    if (!api || !state.objects.length) return;
    if (!state.coloured) return api.viewer.setObjectState(selector(state.objects), { color: "reset", opacity: 1 });
    // One setObjectState call per colour group (A7). Not started: see-through slate, so what is underneath stays
    // visible; started stages: solid colour, full opacity. Opacity is 0..1 in Connect (verified in Pour tags).
    for (const g of U.colourGroups(state.objects, (o) => S.stageOf(state.records.get(o.guid)), STAGES, state.seeThrough, NOT_STARTED_OPACITY)) {
      await api.viewer.setObjectState(selector(g.objs), { color: g.colour, opacity: g.opacity });
    }
  }
  // Selection changed in the model: Connect can drop object colours (e.g. after isolate / show all), so paint again,
  // debounced (one paint after a burst of selection events).
  let colourTimer = null;
  function colourSoon() {
    if (!state.coloured || !state.ready) return;
    clearTimeout(colourTimer);
    colourTimer = setTimeout(() => guarded(applyColours), 400);
  }

  // ---------- Excel export (for invoicing) ----------
  // ExcelJS is loaded only when the button is pressed (about 1 MB).
  const EXCELJS = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";
  const EXCELJS_SRI = "sha384-Pqp51FUN2/qzfxZxBCtF0stpc9ONI6MYZpVqmo8m20SoaQCzf+arZvACkLkirlPz";
  let excelLoad = null;
  function loadExcelJs() {
    if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
    return excelLoad || (excelLoad = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = EXCELJS; s.integrity = EXCELJS_SRI; s.crossOrigin = "anonymous";
      s.onload = () => resolve(window.ExcelJS);
      s.onerror = () => { excelLoad = null; reject(new Error(L2("Библиотеката за Excel не се зареди (", "Could not load the Excel library (") + EXCELJS + ")")); };
      document.head.appendChild(s);
    }));
  }
  const toNum = (v) => { const n = typeof v === "number" ? v : parseFloat(String(v == null ? "" : v).replace(",", ".")); return isFinite(n) ? n : null; };
  const toDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || "")); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; };
  const round = (v, d) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

  /**
   * Workbook with three sheets: by month (each step counted in the month of its date, per pour type, with the
   * quantity it earns: formwork/stripping m², rebar kg, concrete m³), by pour, and one row per pour object.
   * Real numbers and dates, filters, and totals that follow the filter (SUBTOTAL), so a month can be filtered and
   * its totals read off for the invoice.
   */
  async function exportExcel() {
    if (!state.ready) return;
    const bg = lang === "bg", L = (b, e) => (bg ? b : e);
    setStatus(L("Подготвям Excel…", "Preparing Excel…"));
    const ExcelJS = await loadExcelJs();
    const objs = state.objects.map((o) => {
      const p = o.props || {};
      const fw = (toNum(p[C.P.fwSides]) || 0) + (toNum(p[C.P.fwBottom]) || 0);
      return {
        pour: o.group ? o.group.label : p[C.P.number] || "", type: String(p[C.P.type] || ""), parts: String(p[C.P.parts] || ""), guid: o.guid,
        volume: round(toNum(p[C.P.volume]), 3), rebar: round(toNum(p[C.P.rebar]), 1), formwork: fw ? round(fw, 2) : null,
      };
    }).sort((a, b) => C.naturalCompare(a.pour, b.pour) || C.naturalCompare(a.type, b.type) || C.naturalCompare(a.parts, b.parts));
    const data = S.invoiceData(objs, state.records);

    const UNIT = { formwork: "m²", rebar: "kg", poured: "m³", stripped: "m²" };
    const FMT = { m3: "#,##0.00", m2: "#,##0.00", kg: "#,##0", n: "0", date: bg ? "dd.mm.yyyy" : "yyyy-mm-dd", pct: "0%" };
    const fmtOf = (u) => (u === "kg" ? FMT.kg : FMT.m2);
    const INK = "FF1F1F1F", LINE = "FFD9D5CC", ACC = "FFE37424", SOFT = "FFF7F5F0", MUTED = "FF6B6B6B";
    const font = { name: "Ubuntu", size: 10 };
    const project = (state.project && state.project.name) || "";
    const wb = new ExcelJS.Workbook();
    wb.creator = "Arsten / Multiplan – Pour status"; wb.created = new Date();
    wb.calcProperties.fullCalcOnLoad = true;

    function addSheet(name, note, cols, rows, freezeCols) {
      const ws = wb.addWorksheet(name, { views: [{ state: "frozen", xSplit: freezeCols || 0, ySplit: 3 }] });
      ws.getCell(1, 1).value = `${project} · ${L("Статус тактове", "Pour status")} · ${name} · ${S.today()}`;
      ws.getCell(1, 1).font = Object.assign({}, font, { size: 12, bold: true });
      ws.getCell(2, 1).value = note;
      ws.getCell(2, 1).font = Object.assign({}, font, { size: 9, italic: true, color: { argb: MUTED } });
      const hr = ws.getRow(3);
      hr.height = 32;
      cols.forEach((c, i) => {
        const cell = hr.getCell(i + 1);
        cell.value = c.h;
        cell.font = Object.assign({}, font, { bold: true, color: { argb: "FFFFFFFF" } });
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: INK } };
        cell.alignment = { vertical: "middle", wrapText: true, horizontal: c.fmt && c.fmt !== FMT.date ? "right" : "left" };
        ws.getColumn(i + 1).width = c.w || 12;
      });
      rows.forEach((r, k) => {
        const row = ws.getRow(4 + k);
        r.forEach((v, i) => {
          const cell = row.getCell(i + 1);
          cell.value = v == null || v === "" ? null : v;
          cell.font = font;
          if (cols[i].fmt) cell.numFmt = cols[i].fmt;
          cell.border = { bottom: { style: "hair", color: { argb: LINE } } };
        });
      });
      const last = 3 + rows.length;
      if (rows.length) ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: last, column: cols.length } };
      if (cols.some((c) => c.sum)) {
        const tr = ws.getRow(last + 1);
        cols.forEach((c, i) => {
          const cell = tr.getCell(i + 1);
          if (i === 0) cell.value = L("Общо (видимите редове)", "Total (visible rows)");
          if (c.sum && rows.length) {
            const col = ws.getColumn(i + 1).letter;
            cell.value = { formula: `SUBTOTAL(109,${col}4:${col}${last})`, result: round(rows.reduce((s, r) => s + (typeof r[i] === "number" ? r[i] : 0), 0), 3) };
            cell.numFmt = c.fmt;
          }
          cell.font = Object.assign({}, font, { bold: true });
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: SOFT } };
          cell.border = { top: { style: "medium", color: { argb: ACC } } };
        });
      }
      return ws;
    }

    const qtyNote = L("Количества от модела (Tekla): кофраж = страни + дъно (m²), армировка (kg), бетон (m³). Етапи „без“ не се броят и не се фактурират. Всеки етап е с количеството, записано при отбелязването му. ",
      "Quantities from the model (Tekla): formwork = sides + bottom (m²), rebar (kg), concrete (m³). Steps marked \"without\" are not counted or invoiced. Each step uses the quantity saved when it was marked. ");
    const stepCols = () => S.STEPS.flatMap((st) => [
      { h: `${stepName(st)}, ${L("бр.", "pcs")}`, w: 10, fmt: FMT.n, sum: true },
      { h: `${stepName(st)}, ${UNIT[st.id]}`, w: 13, fmt: fmtOf(UNIT[st.id]), sum: true }]);
    const stepVals = (s) => S.STEPS.flatMap((st) => [s[st.id].n || null, s[st.id].n ? round(s[st.id].qty, 2) : null]);

    // 1) By month: what each step earned in the month of its date.
    addSheet(L("По месеци", "By month"),
      qtyNote + L("Всеки етап се отчита в месеца на датата си. Филтрирайте „Месец“ – редът „Общо“ сумира само видимите редове.",
        "Each step counts in the month of its date. Filter \"Month\": the Total row sums only the visible rows."),
      [{ h: L("Месец", "Month"), w: 11 }, { h: L("Тип", "Type"), w: 30 }, ...stepCols()],
      data.months.map((m) => [m.month || L("без дата", "no date"), m.type, ...stepVals(m)]), 2);
    // 2) By pour: progress and the quantities done so far.
    addSheet(L("По тактове", "By pour"), qtyNote,
      [{ h: L("Такт", "Pour"), w: 12 }, { h: L("Тип", "Type"), w: 30 }, { h: L("Обекти", "Objects"), w: 8, fmt: FMT.n, sum: true },
        { h: L("Бетон общо, m³", "Concrete total, m³"), w: 12, fmt: FMT.m3, sum: true }, { h: L("Армировка общо, kg", "Rebar total, kg"), w: 12, fmt: FMT.kg, sum: true },
        { h: L("Кофраж общо, m²", "Formwork total, m²"), w: 12, fmt: FMT.m2, sum: true }, ...stepCols(),
        { h: L("Излят, % обем", "Poured, % volume"), w: 10, fmt: FMT.pct }, { h: L("Последно излят", "Last poured"), w: 12, fmt: FMT.date },
        { h: L("Без (бр.)", "Without (pcs)"), w: 28 }],
      data.pours.map((p) => [p.pour, p.types.join(", "), p.total, round(p.qty.volume, 3), round(p.qty.rebar, 1), round(p.qty.formwork, 2), ...stepVals(p.steps),
        p.qty.volume ? p.steps.poured.qty / p.qty.volume : null, toDate(p.lastPoured),
        S.STEPS.filter((st) => p.steps[st.id].na).map((st) => `${stepName(st)} ${p.steps[st.id].na}`).join(", ") || null]), 1);
    // 3) One row per pour object.
    {
      const cols = [{ h: L("Такт", "Pour"), w: 12 }, { h: L("Тип", "Type"), w: 28 }, { h: L("Елементи", "Parts"), w: 36 },
        { h: L("Бетон, m³", "Concrete, m³"), w: 10, fmt: FMT.m3, sum: true }, { h: L("Армировка, kg", "Rebar, kg"), w: 11, fmt: FMT.kg, sum: true },
        { h: L("Кофраж, m²", "Formwork, m²"), w: 10, fmt: FMT.m2, sum: true }, { h: L("Етап", "Stage"), w: 16 }];
      for (const st of S.STEPS) cols.push({ h: `${stepName(st)} – ${L("дата", "date")}`, w: 12, fmt: FMT.date }, { h: L("От", "By"), w: 16 }, { h: L("Бележка", "Note"), w: 20 });
      cols.push({ h: L("Записано ≠ модел", "Saved ≠ model"), w: 30 }, { h: "IFC GUID", w: 24 }, { h: L("История", "History"), w: 60 });
      const rows = objs.map((o) => {
        const rec = state.records.get(o.guid) || {};
        const r = [o.pour, o.type, o.parts, o.volume, o.rebar, o.formwork, stepName(S.stageOf(rec))];
        for (const st of S.STEPS) r.push(S.isNa(rec, st.id) ? L("без", "without") : rec[st.id] ? toDate(rec[`${st.id}_date`]) : null, rec[st.id] ? rec[`${st.id}_by`] : null, rec[st.id] ? rec[`${st.id}_note`] : null);
        // Frozen (invoiced) quantity that no longer matches the model, e.g. after a pour break.
        const diff = S.STEPS.filter((st) => {
          const fz = parseFloat(rec[`${st.id}_qty`]), live = o[S.STEP_QTY[st.id]];
          return rec[st.id] && !rec[`${st.id}_na`] && isFinite(fz) && fz > 0 && live != null && Math.abs(fz - live) > Math.max(0.01 * fz, 0.01);
        }).map((st) => `${stepName(st)}: ${round(parseFloat(rec[`${st.id}_qty`]), 2)} → ${round(o[S.STEP_QTY[st.id]], 2)}`).join("; ");
        r.push(diff || null, o.guid, rec.log ? String(rec.log).replace(/\r?\n/g, " | ") : null);
        return r;
      });
      addSheet(L("Детайли", "Details"), qtyNote + L("Един ред на обект от такт.", "One row per pour object."), cols, rows, 1);
    }

    const buf = await wb.xlsx.writeBuffer();
    const name = `pour-status_${String(project || "project").replace(/[\\/:*?"<>|]+/g, "_").trim()}_${S.today()}.xlsx`;
    const url = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setStatus(`${L("Изтеглен", "Downloaded")} ${name} (${objs.length} ${L("обекта", "objects")})`);
  }

  // ---------- rendering ----------
  function render() {
    $("title").textContent = t("title");
    $("hSel").textContent = t("selection"); $("hSteps").textContent = t("steps"); $("hView").textContent = t("view");
    $("btnCsv").textContent = t("csv");
    $("hSummary").textContent = t("pours"); $("hOrphans").textContent = t("orphans"); $("hSplits").textContent = L2("Разделени тактове", "Split pours"); $("hMerges").textContent = L2("Обединени отново", "Merged back");
    $("btnFromViewer").textContent = t("fromViewer"); $("btnSelClear").textContent = t("clear");
    $("hPhotos").textContent = L2("Снимки", "Photos");
    if (state.photos) { state.photos.lang = lang; state.photos.ui.render(); }
    renderAcceptance();
    $("lblFollow").textContent = t("follow"); $("chkFollow").checked = state.follow; $("btnFromViewer").hidden = state.follow;
    $("lblColour").textContent = t("colour"); $("chkColour").checked = !!state.coloured;
    $("colourHint").textContent = t("colourHint");
    $("viewBox").classList.toggle("on", !!state.coloured);
    $("lblHideRebar").textContent = t("hideRebar"); $("chkHideRebar").checked = !!state.rebarHidden;
    $("lblSeeThrough").textContent = t("seeThrough"); $("chkSeeThrough").checked = state.seeThrough;
    $("pourSearch").placeholder = t("search"); $("pourSearch").setAttribute("aria-label", t("search"));
    $("btnPickMatches").textContent = t("selectMatches");
    if (!state.ready) return;
    $("legacyBox").innerHTML = backupAskBox() + legacyBanner();   // "Продължи без архив" (M5); raw-"$" records waiting for "Премести" (F4)
    // selection
    const sel = state.sel;
    if (!sel.length) $("selText").innerHTML = `<span class="sub">${esc(t("nothing"))}</span>`;
    else {
      const byPour = new Map();
      for (const o of sel) { const k = o.group ? o.group.label : "?"; byPour.set(k, (byPour.get(k) || 0) + 1); }
      $("selText").innerHTML = `<b>${sel.length}</b> ${lang === "bg" ? "обекта" : "pour objects"} · ` +
        esc([...byPour].sort((a, b) => C.naturalCompare(a[0], b[0])).map(([k, n]) => (n > 1 ? `${k} (${n})` : k)).join(", "));
    }
    // steps
    const guids = sel.map((o) => o.guid);
    const today = S.today();
    const act = document.activeElement;
    const focus = act && /^(date|note)_/.test(act.id || "") && $("steps").contains(act)
      ? { id: act.id, start: act.type === "text" ? act.selectionStart : null, end: act.type === "text" ? act.selectionEnd : null } : null;
    const w = canWrite();
    $("steps").innerHTML = (w ? "" : `<div class="sub bad" role="note">${esc(readOnlyText())}</div>`) + S.STEPS.map((s, i) => {
      const st = S.stepState(state.records, guids, s.id);
      const v = S.stepValues(state.records, guids, s.id);
      const label = (!sel.length ? "" : st.state === "all" ? `✓ ${st.done}/${st.total}` : st.state === "mixed" ? `${st.done}/${st.total} ${t("done")}` : `0/${st.total}`)
        + (st.na ? ` · ${t("without").toLowerCase()} ${st.na === st.total ? "" : st.na}`.trimEnd() : "");
      // Prefill with what is saved, so a correction or a note does not reset the date. Different values: empty = keep each one's.
      // Partly done: the boxes are for the objects not done yet (today, empty note); select the done ones to correct them.
      const partly = st.state === "mixed";
      const dateVal = partly ? S.today() : v.mixedDate ? "" : v.date || S.today();
      if (partly) { v.mixedNote = false; v.note = ""; }
      const notePh = v.mixedNote ?L2("различни бележки – празно = без промяна", "different notes – empty = keep") : t("note");
      // typed but not saved yet wins over the prefill (F6)
      const dr = state.drafts[s.id] || {};
      const dateShown = U.boxValue(dateVal, dr.date), noteShown = U.boxValue(v.note || "", dr.note);
      // "Излят": rebar acceptance of the pours this button would mark, shown BEFORE writing (A3)
      const rb = s.id === "poured" && sel.length ? U.rebarCheck(window.ArstenAcceptance, state.acc, sel.filter((o) => !(state.records.get(o.guid) || {}).poured).map(accPour)) : null;
      const armed = !!rb && state.armPour === selKey(sel);
      const markLabel = armed ? t("pourConfirm") : partly ? `${t("markDone")} (${st.total - st.done})` : st.done ? t("save") : t("markDone");
      return `<div class="step" style="--c:${s.colour}">
        <div class="hd"><span class="nm">${i + 1}. ${esc(stepName(s))}</span><span class="st ${st.state}">${label}</span></div>
        ${st.dates.length ? `<div class="dates">${esc(st.dates.map((d) => fmtDate(d)).join(", "))}</div>` : ""}
        <div class="row"><input type="date" id="date_${s.id}" max="${today}" value="${esc(dateShown)}" title="${v.mixedDate ? esc(L2("различни дати – празно = без промяна", "different dates – empty = keep")) : ""}"><input type="text" id="note_${s.id}" data-mixed="${v.mixedNote ? 1 : 0}" value="${esc(noteShown)}" placeholder="${esc(notePh)}"></div>
        <div class="hint" id="hint_${s.id}">${dr.date != null ? esc(U.dateHint(dr.date, today, lang)) : ""}</div>
        ${rb ? `<div class="accwarn${armed ? " armed" : ""}" role="${armed ? "alert" : "note"}">${esc(U.rebarWarnText(rb, lang))}${armed ? `<div>${esc(L2("Натиснете „Потвърди – излей“, за да запишете въпреки това, или „Откажи“.", "Press \"Confirm – poured\" to save anyway, or \"Cancel\"."))}</div>` : ""}</div>` : ""}
        <div class="row"><button class="small${armed ? " armed" : ""}" data-act="mark" data-step="${s.id}" ${sel.length && w ? "" : "disabled"}>${esc(markLabel)}</button>${armed ? `<button class="small secondary" data-act="pourCancel">${esc(L2("Откажи", "Cancel"))}</button>` : ""}<button
          class="small secondary" data-act="na" data-step="${s.id}" ${sel.length && w ? "" : "disabled"} title="${esc(t("withoutTip"))}" ${s.na ? "" : "hidden"}>${esc(t("without"))}</button><button
          class="small secondary" data-act="note" data-step="${s.id}" ${st.done && w ? "" : "disabled"} title="${esc(t("noteOnlyTip"))}">${esc(t("noteOnly"))}</button><button
          class="small secondary undo" data-act="undo" data-step="${s.id}" ${st.done && w ? "" : "disabled"}>${esc(t("undo"))}</button></div></div>`;
    }).join("");
    if (focus && $(focus.id)) {   // the re-render replaced the box the user was typing in: keep the cursor there
      const el = $(focus.id);
      el.focus();
      try { if (focus.start != null) el.setSelectionRange(focus.start, focus.end); } catch {}
    }
    // legend
    const counts = new Map(U.colourGroups(state.objects, (o) => S.stageOf(state.records.get(o.guid)), STAGES, false, 1).map((g) => [g.stage.id, g.objs.length]));
    $("legend").innerHTML = STAGES.map((s, k) => `<span><span class="sw" style="background:${s.colour}${k === 0 && state.seeThrough ? `;opacity:${Math.min(1, NOT_STARTED_OPACITY + 0.25)}` : ""}"></span>${esc(stepName(s))} <b class="cnt">${counts.get(s.id) || 0}</b>${k === 0 && state.seeThrough ? ` <span class="sub">(${lang === "bg" ? "прозрачно" : "see-through"})</span>` : ""}</span>`).join("");
    // summary
    const short = lang === "bg" ? ["Кофр.", "Арм.", "Излят", "Декофр."] : ["Form.", "Rebar", "Poured", "Stripped"];
    $("sumHead").innerHTML = `<tr><th>${esc(t("pour"))}</th>${short.map((h) => `<th class="n">${h}</th>`).join("")}<th></th></tr>`;
    renderSummary();
    // pours split by Tekla after formwork/rebar
    const dv = derived();
    const sp = dv.sp;
    state.splits = sp;
    $("splitBox").hidden = !sp.length;
    if (sp.length) {
      $("splitText").textContent = L2("Тези тактове са разделени в Tekla след като кофражът/армировката им са отбелязани. Новите части могат да наследят статуса.",
        "These pours were split in Tekla after their formwork/rebar was marked. The new pieces can take over the status.");
      const f3 = (v) => (v == null ? "?" : (Math.round(v * 100) / 100).toLocaleString(lang === "bg" ? "bg-BG" : "en-GB"));
      $("splitRows").innerHTML = sp.map((x, i) => {
        const what = x.steps.map((id) => `${stepName(S.STEPS.find((s) => s.id === id))}${x.record[id + "_na"] ? " (" + t("without").toLowerCase() + ")" : ""} ${fmtDate(x.record[id + "_date"] || "")}`).join(", ");
        const vol = x.snapVol == null ? `<span class="sub">${L2("няма записан обем – проверете частите", "no saved volume – check the pieces")}</span>`
          : `${L2("обем", "volume")} ${f3(x.snapVol)} m³ ${x.volOk ? "= " : "≠ "}${f3(x.sumVol)} ${x.volOk ? "✓" : "⚠"}`;
        const row = (o, k, ticked, tag) => `<label class="chk"><input type="checkbox" data-split="${i}" data-k="${k}" ${ticked ? "checked" : ""}> ${esc(o.pour || "?")} · ${f3(o.volume)} m³${tag ? ` <span class="sub">${tag}</span>` : ""}</label>`;
        const kids = [...x.children.map((o, k) => row(o, k, true, x.exact ? "" : L2("(проверете)", "(check)"))),
          ...x.partial.map((o, k) => row(o, x.children.length + k, false, x.exact ? L2("(частично извън)", "(partly outside)") : L2("(вероятно съседен)", "(probably a neighbour)")))].join("<br>");
        return `<tr><td><span class="name">${esc(x.record.pour || "?")}</span> <span class="sub">${x.present ? "" : L2("(вече го няма)", "(gone)")}</span>
          <div class="sub">${esc(what)} · ${vol}</div><div style="margin:4px 0">${kids}</div>
          <button class="small" data-act="splitApply" data-i="${i}"${w ? "" : " disabled"}>${L2("Прехвърли", "Pass on")}</button>
          <button class="small secondary" data-act="splitShow" data-i="${i}">${L2("Покажи", "Show")}</button>
          ${x.present ? `<button class="small secondary" data-act="splitSkip" data-i="${i}"${w ? "" : " disabled"}>${L2("Не", "No")}</button>` : ""}</td></tr>`;
      }).join("");
    }
    // pour break removed again: pieces merged back into one object
    const mg = dv.mg;
    state.merges = mg;
    $("mergeBox").hidden = !mg.length;
    if (mg.length) {
      $("mergeRows").innerHTML = mg.map((x, i) => {
        const o = state.objects.find((v) => v.guid === x.into);
        return `<tr><td><span class="name">${esc(o ? pourOf(o) : "?")}</span>
          <div class="sub">${L2(`Разделянето е премахнато: ${x.gone.length + 1} части отново са един обект. Статусът остава; количествата се обединяват.`,
            `The pour break was removed: ${x.gone.length + 1} pieces are one object again. The status stays; quantities are combined.`)}</div>
          <button class="small" data-act="mergeApply" data-i="${i}"${w ? "" : " disabled"}>${L2("Потвърди", "Confirm")}</button>
          <button class="small secondary" data-act="mergeShow" data-i="${i}">${L2("Покажи", "Show")}</button></td></tr>`;
      }).join("");
    }
    // orphans: only records whose pour is in the loaded models are listed (one stage loaded = the other stages' records
    // are not "without object"); the others are counted for admins (speed audit item 3)
    const orph = dv.orph, hiddenOrph = dv.hiddenOrph;
    const hiddenNote = office() && hiddenOrph === 1 ? L2("1 запис на такт, който не е в заредените модели (друг етап или изтрит такт), не е в списъка.",
      "1 record of a pour that is not in the loaded models (another stage or a deleted pour) is not listed.")
      : office() && hiddenOrph ? L2(`${hiddenOrph} записа на тактове, които не са в заредените модели (други етапи или изтрити тактове), не са в списъка.`,
      `${hiddenOrph} records of pours that are not in the loaded models (other stages or deleted pours) are not listed.`) : "";
    $("orphanBox").hidden = !orph.length && !hiddenNote;
    if (!orph.length && hiddenNote) { $("orphanText").textContent = hiddenNote; $("orphanRows").innerHTML = ""; state.orphans = orph; }
    if (orph.length) {
      $("orphanText").textContent = (orph.length === 1 ? L2("1 запис със статус сочи към обект, който вече го няма в модела (вероятно Tekla е пресъздала такта). Свържете го ръчно към новия обект.",
          "1 status record points to an object that is no longer in the model (Tekla probably rebuilt the pour). Re-attach it to the new object.")
        : lang === "bg"
        ? `${orph.length} записа със статус сочат към обекти, които вече ги няма в модела (вероятно Tekla е пресъздала такта). Свържете ги ръчно към новия обект.`
        : `${orph.length} status records point to objects that are no longer in the model (Tekla probably rebuilt the pour). Re-attach them to the new object.`) + (hiddenNote ? " " + hiddenNote : "");
      // "Прехвърли" opens an inline Запиши / Откажи box (no window.confirm: Connect's frame can block it; F7)
      $("orphanRows").innerHTML = orph.map((x, i) => `<tr><td><span class="name">${esc(x.record.pour || "?")}</span>
          <div class="sub">${esc(x.record.stage || "")}${office() ? ` · ${esc(x.guid)}` : ""}</div>
          ${state.confirmOrphan === x.guid ? `<div class="confirm" role="group"><div>${esc(L2(`Да се копира статусът (${x.record.stage}) към ${x.candidates.length} обект(а) от ${x.record.pour}?`,
            `Copy the status (${x.record.stage}) to ${x.candidates.length} object(s) of ${x.record.pour}?`))}</div>
            <div class="bar"><button class="small" data-act="reattachYes" data-i="${i}"${state.reattachBusy ? " disabled" : ""}>${L2("Запиши", "Save")}</button><button class="small secondary cancel" data-act="reattachNo" data-i="${i}"${state.reattachBusy ? " disabled" : ""}>${L2("Откажи", "Cancel")}</button></div></div>` : ""}</td>
        <td>${x.candidates.length ? `<button class="small" data-act="reattach" data-i="${i}" ${state.confirmOrphan === x.guid || !w ? "disabled" : ""}${office() ? ` title="${esc(x.candidates.map((c) => c.guid).join(", "))}"` : ""}>${lang === "bg" ? "Прехвърли" : "Re-attach"} → ${x.candidates.length} ${x.exact ? "" : "?"}</button>` : `<span class="sub">${lang === "bg" ? "няма съвпадение" : "no match"}</span>`}</td></tr>`).join("");
      state.orphans = orph;
    }
  }

  /** Splits, merges and orphans of the loaded objects against all records: computed once per records change (recVer)
   *  or object reload, reused by every render (speed audit item 3: a selection click recomputed them each time). */
  function derived() {
    const m = derivedMemo;
    if (m && m.ver === recVer && m.records === state.records && m.objects === state.objects) return m;
    const splitObjs = state.objects.map((o) => Object.assign({ guid: o.guid, pour: pourOf(o), parts: (o.props || {})[C.P.parts] || "", bbox: o.bbox, key: o.key, obj: o }, { volume: liveQty(o).volume }));
    const sp = S.splits(state.records, splitObjs);
    const mg = S.merges(state.records, splitObjs);
    const present = new Set(state.objects.map((o) => o.guid));
    const mergedGone = new Set(mg.flatMap((x) => x.gone.map((g) => g.guid)));
    const splitFrom = new Set([...mergedGone, ...sp.filter((x) => !x.present).map((x) => x.guid), ...[...state.records.values()].map((r) => r.split_from).filter(Boolean)]);
    const all = S.orphans(new Map([...state.records].filter(([g]) => !splitFrom.has(g))), present, state.objects.map((o) => ({ guid: o.guid, key: o.key, pour: o.group && (o.group.numbered ? o.group.key : o.group.label), obj: o })));
    const rows = U.orphanRows(all);
    derivedMemo = { ver: recVer, records: state.records, objects: state.objects, sp, mg, orph: rows.shown, hiddenOrph: rows.hidden.length };
    return derivedMemo;
  }

  /** Pours table, filtered by the search box (A5). Indexes stay those of state.pours ("Избери" per row). */
  function renderSummary() {
    const sum = S.summary(state.pours, state.records, (o) => o.guid);
    const shown = sum.map((r, i) => ({ r, i })).filter((x) => U.matchPour(x.r.label, state.filter));
    state.matches = shown.map((x) => x.i);
    $("btnPickMatches").disabled = !state.filter.trim() || !shown.length;
    $("btnPickMatches").textContent = t("selectMatches") + (state.filter.trim() && shown.length ? ` (${shown.length})` : "");
    $("sumRows").innerHTML = shown.length ? shown.map(({ r, i }) => `<tr><td><span class="name">${esc(r.label)}</span> <span class="sub">${r.total}</span></td>${S.STEPS.map((s) => {
        const n = r.steps[s.id];
        return `<td class="n ${n === 0 ? "zero" : n === r.total ? "full" : "part"}">${n}/${r.total}</td>`;
      }).join("")}<td><button class="small secondary" data-act="pickPour" data-i="${i}">${esc(t("select"))}</button></td></tr>`).join("")
      : `<tr><td colspan="6" class="empty">${esc(sum.length ? t("noMatch") : L2("Няма тактове.", "No pours."))}</td></tr>`;
  }
  /** "Избери в модела": every pour object of the pours the search finds. */
  async function selectMatches() {
    const objs = (state.matches || []).flatMap((i) => (state.pours[i] ? state.pours[i].objects : []));
    if (!objs.length) return report(t("noMatch"), true);
    await selectObjects(objs);
    setStatus(`${L2("Избрани", "Selected")} ${countWord(state.matches.length, "такт", "такта", "pour", "pours")} (${countWord(objs.length, "обект", "обекта", "object", "objects")})`);
  }

  // Pass formwork/rebar of a split pour on to its ticked new pieces; the parent's saved outline becomes the current one.
  const splitPieces = (i) => {
    const x = state.splits[i];
    const all = [...x.children, ...x.partial];
    return [...document.querySelectorAll(`input[data-split="${i}"]`)].filter((c) => c.checked).map((c) => all[+c.dataset.k]);
  };
  async function splitApply(i) {
    const x = state.splits[i], pieces = splitPieces(i);
    if (!pieces.length) return report(L2("Не са избрани части.", "No pieces ticked."), true);
    const bak = await backupFirst("split", linksOf([...pieces.map((pc) => pc.guid), x.guid]));
    let done = 0;
    await pool(pieces, 6, async (pc) => {
      const props = S.inherit(x.record, x.guid, { by: state.user, pour: pc.pour, key: pc.key, snap: snapOf(pc.obj) });
      await putRec(pc.guid, props); done++;
    });
    await splitClose(x, done);
    report(`${x.record.pour}: ${L2("статусът е прехвърлен на", "status passed on to")} ${done} ${L2("нови части", "new pieces")}` + bak);
    render();
    if (state.coloured) await applyColours();
  }
  async function splitClose(x, pieces) {
    const cur = state.objects.find((o) => o.guid === x.guid);
    const next = S.splitDone(x.record, cur ? { by: state.user, snap: snapOf(cur), key: cur.key, pour: pourOf(cur), pieces } : { by: state.user, pieces });
    await putRec(x.guid, next);
  }
  async function splitSkip(i) {
    const x = state.splits[i];
    await splitClose(x, 0);
    report(`${x.record.pour || ""}: ${L2("отбелязано – без прехвърляне", "marked – nothing passed on")}`);
    render();
  }
  async function splitShow(i) {
    const x = state.splits[i];
    const cur = state.objects.find((o) => o.guid === x.guid);
    await selectObjects([...(cur ? [cur] : []), ...[...x.children, ...x.partial].map((o) => o.obj)]);
  }

  // Pour break removed: write the merged object's record (combined frozen quantities, current outline) and mark the
  // gone pieces' records as merged into it (they leave "Статус без обект").
  async function mergeApply(i, noBackupOk) {
    const x = state.merges[i];
    if (!x) return;
    const o = state.objects.find((v) => v.guid === x.into);
    const next = S.mergeBack(state.records.get(x.into), x.gone, { by: state.user, snap: o ? snapOf(o) : null, key: o && o.key, pour: o ? pourOf(o) : null });
    const bak = await backupFirst("merge", linksOf([x.into, ...x.gone.map((g) => g.guid)]), { destructive: true, noBackupOk, ask: { act: "mergeApply", into: x.into } });
    if (bak === null) return;
    await putRec(x.into, next);
    for (const g of x.gone) {
      const r = S.mergedInto(g.record, x.into, { by: state.user });
      await putRec(g.guid, r);
    }
    report(`${o ? pourOf(o) : ""}: ${L2("обединяването е записано", "merge saved")}` + bak);
    render();
  }
  async function mergeShow(i) {
    const o = state.objects.find((v) => v.guid === state.merges[i].into);
    if (o) await selectObjects([o]);
  }



  // ---------- write protection (admins): who may write statuses in the library ----------
  async function loadProtection() {
    if (!ArstenAccess.hasRole(state.access, "admin") || !state.lib) { $("protectBox").hidden = true; return; }
    $("protectBox").hidden = false;
    // One read of the project's users and groups for both blocks below (it was read twice per load; speed audit item 8).
    // Started together with the policy read; each block still reports its own error.
    const accessData = ArstenAccess.loadProjectAccess({ projectId: state.project.id, location: state.project.location, getToken });
    accessData.catch(() => {});   // handled below; no "unhandled rejection" while the policy is read
    try {
      const policy = await state.client.getPolicy(state.lib.id);
      const d = ArstenAccess.describePolicy(policy);
      state.policy = policy;
      const names = new Map(((await accessData).groups || []).map((g) => [g.id, g.name]));
      const lv = { edit: L2("запис", "edit"), read: L2("само четене", "read only"), none: L2("без достъп", "no access") };
      const lines = [`${L2("Всички членове", "All members")}: ${lv[d.defaultAccess]}`]
        .concat(d.groups.map((g) => `${names.get(g.id) || L2("група", "group") + " " + g.id}: ${lv[g.access]}`))
        .concat([d.adminsWrite || d.everyoneWrites ? "" : L2("ADMIN: записва само ако е в група със запис.", "ADMIN: can write only through a group with edit access.")]).filter(Boolean);
      $("protectText").innerHTML = lines.map((x) => `<div>${esc(x)}</div>`).join("") + `<div class="sub" style="margin-top:4px">${esc(L2("Промяна: Property Set Libraries → CIP/Монолитно → иконата с човек (Library access control) → Save → Publish.", "Change it in Property Set Libraries → CIP/Монолитно → person icon (Library access control) → Save → Publish."))}</div>`;
    } catch (e) {
      $("protectText").textContent = L2("Правата на библиотеката не могат да се прочетат: ", "Cannot read the library rights: ") + errText(e);
    }
    // Who resolves to which role (names only), so the groups can be checked.
    try {
      const data = await accessData;
      const RN = { admin: "ADMIN", gc: "GENERAL CONTRACTOR", client: "CLIENT", subcontractor: "SUBCONTRACTORS", designer: "DESIGNERS", viewer: "VIEWERS", none: L2("без достъп", "no access") };
      const list = ArstenAccess.classifyMembers(data).sort((x, y) => ArstenAccess.ROLE_ORDER.indexOf(x.role) - ArstenAccess.ROLE_ORDER.indexOf(y.role) || x.name.localeCompare(y.name));
      $("rolesList").innerHTML = list.map((m) => `<div>${esc(m.name)} · <b>${esc(RN[m.role] || m.role)}</b>${ArstenAccess.allows("execution", m) ? "" : ` <span class="sub">(${L2("без достъп до панела", "no panel access")})</span>`}</div>`).join("");
      state.roleList = list;
    } catch (e) {
      $("rolesList").textContent = L2("Ролите не могат да се прочетат: ", "Cannot read the roles: ") + errText(e);
    }
  }

  // Re-attach an orphaned status: copy it to the candidate object(s) (the old record stays, for history).
  // Called from the inline confirm box (reattachYes).
  // The box stays open with its buttons disabled until the writes are done, so it can't be saved twice (Low 4).
  async function reattach(x) {
    if (!x || state.reattachBusy) { if (!x) { state.confirmOrphan = null; render(); } return; }
    state.reattachBusy = true;
    render();
    let bak = "";
    try {
      bak = await backupFirst("reattach", linksOf(x.candidates.map((c) => c.guid)));
      for (const c of x.candidates) {
        const props = Object.assign({}, x.record, { key: c.key });
        props.log = (props.log ? props.log + "\n" : "") + `${S.today()} re-attached from ${x.guid} by ${state.user}`;
        await putRec(c.guid, props);
      }
    } finally { state.reattachBusy = false; state.confirmOrphan = null; }
    report(`${x.record.pour || ""}: ${L2("статусът е прехвърлен на", "status re-attached to")} ${x.candidates.length} ${L2("обекта", "objects")}` + bak);
    render();
    if (state.coloured) await applyColours();
  }

  // ---------- wiring ----------
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    const WRITES = ["mark", "undo", "note", "na", "reattachYes", "splitApply", "splitSkip", "mergeApply", "moveLegacy", "backupGo"];
    if ((WRITES.includes(act) || act === "reattach") && !canWrite()) return report(readOnlyText(), true);   // M3: never offer a refused write
    if (WRITES.includes(act) && reloading) return report(L2("Моделът се презарежда – опитайте след малко.", "The model is reloading – try again in a moment."), true);
    guarded(() => writing(async () => {
      if (act === "mark" || act === "undo" || act === "note" || act === "na") await applyStep(b.dataset.step, act);
      else if (act === "pourCancel") { state.armPour = null; setStatus(L2("Отказано – нищо не е записано.", "Cancelled – nothing was saved.")); render(); }
      else if (act === "pickPour") await selectPour(state.pours[+b.dataset.i]);
      else if (act === "reattach") { state.confirmOrphan = state.orphans[+b.dataset.i].guid; render(); }
      else if (act === "reattachNo") { state.confirmOrphan = null; render(); }
      else if (act === "reattachYes") {
        const x = state.orphans[+b.dataset.i];
        b.disabled = true;
        await reattach(x && x.guid === state.confirmOrphan ? x : null);
      }
      else if (act === "splitApply") await splitApply(+b.dataset.i);
      else if (act === "splitSkip") await splitSkip(+b.dataset.i);
      else if (act === "splitShow") await splitShow(+b.dataset.i);
      else if (act === "mergeApply") { state.backupAsk = null; await mergeApply(+b.dataset.i); }
      else if (act === "mergeShow") await mergeShow(+b.dataset.i);
      else if (act === "moveLegacy") { state.backupAsk = null; await moveLegacy(); }
      else if (act === "backupNo") { state.backupAsk = null; setStatus(L2("Отказано – нищо не е променено.", "Cancelled – nothing was changed.")); render(); }
      else if (act === "backupGo") {   // the second, explicit confirmation of a destructive action without an uploaded backup (M5)
        const a = state.backupAsk;
        state.backupAsk = null;
        render();
        if (a && a.act === "moveLegacy") await moveLegacy(true);
        else if (a && a.act === "mergeApply") {
          const k = (state.merges || []).findIndex((m) => m.into === a.into);
          if (k < 0) report(L2("Обединяването вече не е в списъка – нищо не е променено.", "The merge is no longer listed – nothing was changed."), true);
          else await mergeApply(k, true);
        }
      }
    }));
  });
  $("btnFromViewer").onclick = () => guarded(selectionFromViewer);
  $("btnCsv").onclick = () => guarded(exportExcel);
  $("chkFollow").onchange = (e) => {
    state.follow = e.target.checked;
    U.writePref(store, PREF.follow, state.follow);
    render();
    if (state.follow && state.ready) guarded(() => selectionFromViewer(true));
  };
  // "Follow model selection": re-read the selection shortly after it changes in the viewer (debounced: one
  // click can fire several events).
  let followTimer = null;
  function onViewerSelection() {
    if (!state.follow || !state.ready || !state.api) return;
    if (reloading) {   // objects are being re-read: note only that the user picked something (an empty selection is the reload's own)
      state.api.viewer.getSelection().then((sel) => { if ((sel || []).some((m) => (m.objectRuntimeIds || []).length)) selDuringReload = true; }).catch(() => {});
      return;
    }
    clearTimeout(followTimer);
    followTimer = setTimeout(() => guarded(() => selectionFromViewer(true)), 200);
  }
  $("btnSelClear").onclick = () => { setSel([]); state.drafts = {}; state.draftSel = []; render(); };
  // Keep what the user types in the step cards (re-renders on every selection change would wipe it; F6) and refresh the
  // date hint (A6). Delegated, because the cards are re-rendered.
  $("steps").addEventListener("input", (e) => {
    const m = /^(date|note)_(\w+)$/.exec(e.target.id || "");
    if (!m) return;
    if (!Object.keys(state.drafts).length) state.draftSel = state.sel.map((o) => o.guid);   // drafts belong to this selection
    const d = state.drafts[m[2]] || (state.drafts[m[2]] = {});
    d[m[1]] = e.target.value;
    if (m[1] === "date") { const h = $("hint_" + m[2]); if (h) h.textContent = U.dateHint(e.target.value, S.today(), lang); }
  });
  $("chkSeeThrough").onchange = (e) => guarded(async () => {
    state.seeThrough = e.target.checked;
    U.writePref(store, PREF.seeThrough, state.seeThrough);
    render();
    if (state.coloured) await applyColours();
  });
  $("chkHideRebar").onchange = (e) => guarded(async () => {
    state.rebarHidden = e.target.checked;
    U.writePref(store, PREF.rebarHidden, state.rebarHidden);
    const n = await setRebarVisible(!state.rebarHidden);
    setStatus(n ? `${state.rebarHidden ? L2("Скрита армировка", "Rebar hidden") : L2("Показана армировка", "Rebar shown")}: ${n}`
      : L2("Няма армировка в заредените модели.", "No rebar in the loaded models."));
  });
  $("chkColour").onchange = (e) => guarded(async () => {
    state.coloured = e.target.checked;
    U.writePref(store, PREF.coloured, state.coloured);   // turned off stays off next time (A7)
    render();
    await applyColours();
  });
  // Search in the pours list (A5): filters while typing; Enter = select the matches in the model.
  $("pourSearch").addEventListener("input", (e) => { state.filter = e.target.value; if (state.ready) renderSummary(); });
  $("pourSearch").addEventListener("keydown", (e) => { if (e.key === "Enter" && state.ready && state.filter.trim()) { e.preventDefault(); guarded(selectMatches); } });
  $("btnPickMatches").onclick = () => guarded(selectMatches);
  $("selLang").value = lang;
  $("selLang").onchange = (e) => { lang = I18N ? I18N.setLang(e.target.value) : e.target.value; render(); relabelStatus(); if (!state.ready && state.client) loadGuarded(); };

  // Audit item 8 (review round 12, M6): the loaded model set {id@versionId} of the last start2 that finished. A model
  // event that leaves it unchanged (Connect fires them for streaming and visibility too) re-reads no objects and no
  // records: runReload only paints the colours again. A missing versionId never compares equal (U.modelSetKey).
  let lastModelsKey = null;
  async function start2() {
    lastModelsKey = null;
    const modelsKey = U.modelSetKey(await loadedModels());
    const n = state.objects.length || (await loadPours());
    if (!n) return setStatus(L2("Няма заредени тактове. Отворете модела с тактовете (меню Модели) или изберете етап.", "No pours loaded. Open the model with the pours (Models menu) or pick a stage.")
      + (office() ? L2(" (Нужен е Tekla IFC от Arsten_PourExport, property set Pour/Такт.)", " (Needs a Tekla IFC exported with Arsten_PourExport, property set Pour/Такт.)") : ""), true);
    if (!(await setup())) { setStatus(""); return; }
    await loadRecords();
    state.ready = true;
    $("mainBox").hidden = false;
    render();
    if (state.coloured) await applyColours();   // on by default: colour as soon as models and records are loaded (A7)
    const inModel = state.objects.filter((o) => state.records.has(o.guid)).length, outside = state.records.size - inModel;
    loadProtection();
    if (state.rebarHidden) { state.rebarIds = null; await setRebarVisible(false); }   // keep "hide rebar" after a model reload
    try { await loadAcceptance(); state.accError = ""; } catch (e) { console.error(e); state.accError = (e && e.message) || String(e); }
    mountPhotos();
    // One human sentence for site roles; record counts outside the model and the list fallback only for admins (A8).
    const pl = (k, one, many, en1, enN) => (lang === "bg" ? (I18N ? I18N.plural(k, one, many) : many) : (k === 1 ? en1 : enN));
    setStatus(() => `${state.pours.length} ${pl(state.pours.length, "такт", "такта", "pour", "pours")}, ${n} ${pl(n, "обект", "обекта", "pour object", "pour objects")} · ${inModel} ${lang === "bg" ? "със статус" : "with status"}`
      + (office() && outside ? ` (+${outside} ${lang === "bg" ? "извън модела" : "outside the model"})` : "")
      + (office() && state.listMode === "model" ? L2(" · списъкът на всички записи не се зареди – само обектите в модела", " · listing all records failed – only objects in the model") : ""));
    render();
    lastModelsKey = modelsKey;
  }
  async function start(api, client) {
    state.api = api;
    // Access first (shared/arsten-access.js): ADMIN or GENERAL CONTRACTOR group. Nothing is read before.
    if (window.ArstenDiag) ArstenDiag.set({ panel: "Монолитен бетон (pour-status)", lang: () => lang });   // round 19 M1: before the access check, so a denied screen's diagnostics name the panel
    const demoRole = window.ARSTEN_DEMO ? (/[?&]role=(\w+)/.exec(location.search) || [])[1] || "admin" : "";
    // demo: an admin / GC with write access; ?nowrite = a Connect project admin outside 00_ADMIN (round 11, M3)
    state.access = window.ARSTEN_DEMO ? { allowed: true, role: demoRole, roles: [demoRole],
      caps: /[?&]nowrite\b/.test(location.search) ? [] : demoRole === "admin" ? ["stages", "write"] : ["write"] } : await ArstenAccess.check({ api, getToken, app: "execution" });
    if (I18N) { lang = await I18N.pickLang(api, state.access, OLD_LANG); $("selLang").value = lang; }   // stored choice, else the Connect user's language
    if (!state.access.allowed) { state.denied = true; state.api = null; ArstenAccess.renderDenied(document.body, lang, state.access); return; }
    state.project = (await api.project.getProject()) || {};
    try { const u = await api.user.getUser(); state.user = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || ""; } catch {}
    state.client = client || new A.PsetClient({ region: state.project.location || "europe", getToken });
    if (window.ArstenDiag) ArstenDiag.set({ panel: "Монолитен бетон (pour-status)", projectId: state.project.id, redact: [state.user], lang: () => lang });   // A23
    render();
    await loadGuarded();
  }
  window.PourStatusApp = { start, state, onEvent: (e, d) => onEvent(e, d) };

  function onEvent(event, data) {
    if (event === "extension.accessToken") onToken(data);
    if (state.denied) return;
    if (event === "viewer.onSelectionChanged") { onViewerSelection(); colourSoon(); }
    if (event === "viewer.onModelStateChanged" && state.api) scheduleReload();   // the reload re-applies the colours (start2)
    if (event === "viewer.onModelReset") {
      // Connect's "Reset model" cleared colours and visibility: show that in the panel, for this session only (the
      // remembered setting stays, so the next opening colours again).
      state.coloured = false; state.rebarHidden = false;
      if (state.ready) render();
    }
  }
  // Model loaded / streamed in / stage switched: Connect fires several events in a row. Wait until it is quiet for 3 s
  // (as viewer-assembly-status does), then reload once and keep the selection by GUID; typed drafts stay (F6).
  // Never two reloads at once: an event during a reload queues one more run (M3 a). The selection to restore is captured
  // once and kept until a run restores it (M3 a). A selection the user makes during the reload wins (M3 b). The viewer
  // selection is set again after the restore (M3 c). Writes in flight postpone the reload (M4).
  let reloadTimer = null, reloading = false, rerun = false, pendingKeep = null, selDuringReload = false;
  function scheduleReload(ms) {
    if (pendingKeep == null && !reloading) pendingKeep = state.sel.map((o) => o.guid);
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(runReload, ms == null ? 3000 : ms);
  }
  /** The first load, "Провери отново" and the language switch run start2 under the same guard as a reload (review 10
   *  L1): never two start2 at once, so a reload can't overlap the first load (double read and colour pass) or be
   *  overwritten by it finishing later. A model event during it only queues one reload afterwards. */
  async function loadGuarded() {
    if (reloading) { rerun = true; return; }
    if (inflight > 0) { scheduleReload(1000); return; }
    reloading = true;
    try { await guarded(start2); }
    finally {
      reloading = false;
      if (rerun) { rerun = false; scheduleReload(0); }
    }
  }
  async function runReload() {
    reloadTimer = null;
    if (reloading) { rerun = true; return; }
    if (inflight > 0) { scheduleReload(1000); return; }
    reloading = true; selDuringReload = false;
    const keep = new Set(pendingKeep || state.sel.map((o) => o.guid));
    try {
      if (state.ready && lastModelsKey != null && U.sameModelSet(lastModelsKey, U.modelSetKey(await loadedModels()))) {
        // same models, same versions: nothing to re-read; the selection stays as it is
        pendingKeep = null;
        console.info("[Монолитен бетон] model event: the loaded models did not change – no reload");
        if (state.coloured) await guarded(applyColours);
        return;
      }
      await guarded(async () => {
        state.objects = []; state.sel = []; state.rebarIds = null;
        await start2();
        if (!state.ready) return;
        if (selDuringReload && state.follow) { await selectionFromViewer(true); pendingKeep = null; return; }
        const objs = state.objects.filter((o) => keep.has(o.guid));
        pendingKeep = null;
        if (!objs.length) { if (keep.size) { setSel([]); render(); } return; }
        state.sel = objs;   // same GUIDs as before: drafts stay
        render();
        const byModel = new Map();
        for (const o of objs) { if (!byModel.has(o.modelId)) byModel.set(o.modelId, []); byModel.get(o.modelId).push(o.id); }
        try { await state.api.viewer.setSelection({ modelObjectIds: [...byModel].map(([modelId, objectRuntimeIds]) => ({ modelId, objectRuntimeIds })) }, "set"); } catch (e) { console.warn("setSelection after reload failed", e); }
      });
    } finally {
      reloading = false;
      if (rerun) { rerun = false; scheduleReload(0); }
    }
  }
  if (window.parent === window) {
    if (/[?&]demo\b/.test(location.search)) { const s = document.createElement("script"); s.src = "demo.js?t=" + Date.now(); document.body.appendChild(s); }
    else setStatus(I18N ? I18N.word("notInside", lang) : "Not inside Trimble Connect.", true);
    return;
  }
  if (I18N) setStatus(I18N.word("connecting", lang));
  TrimbleConnectWorkspace.connect(window.parent, onEvent, 30000)
    .then((api) => start(api))
    .catch((e) => setStatus((I18N ? I18N.word("connectFail", lang) : "Could not connect to Trimble Connect") + ": " + errText(e), true));
})();
